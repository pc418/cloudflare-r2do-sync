import { afterEach, beforeEach, describe, expect, it } from "vitest";
import LogSyncPlugin, {
  continuityBody,
  DEFAULT_SETTINGS,
  type Settings,
} from "../src/main";
import { LEGACY_NOTICE_KEYS } from "../src/notify";
import { encodeSetupPayload } from "../src/setup-link";
import { LifecycleApp, Modal, Notice, Platform, requestUrlMock } from "./obsidian-fake";

/**
 * Drives the plugin object itself: `onload()`, the settings/persistence path, and the gates
 * around the destructive actions. Everything below `SyncEngine` already has specs; what had
 * none was the wiring — which ordering runs, what a load clears, which action asks before it
 * acts. Two review fixes landed in exactly that gap (consent reset on endpoint change, force
 * push routed through consent), so both are pinned here by tests that fail without them.
 *
 * Assertions stay on public settings, persisted data, opened modals and observable effects.
 * Private fields are deliberately never inspected: they are not the contract.
 */

// --- environment ------------------------------------------------------------------------

interface FakeTimer {
  id: number;
  fn: () => void;
  ms: number;
  kind: "interval" | "timeout";
  cleared: boolean;
}

let timers: FakeTimer[] = [];
let nextTimerId = 1;

function installGlobals(): void {
  timers = [];
  const make =
    (kind: FakeTimer["kind"]) =>
    (fn: () => void, ms: number): number => {
      const id = nextTimerId++;
      timers.push({ id, fn, ms, kind, cleared: false });
      return id;
    };
  const clear = (id: number): void => {
    const timer = timers.find((t) => t.id === id);
    if (timer !== undefined) timer.cleared = true;
  };
  const win = {
    setInterval: make("interval"),
    clearInterval: clear,
    setTimeout: make("timeout"),
    clearTimeout: clear,
  };
  Object.assign(globalThis, { window: win, document: { visibilityState: "visible" } });
}

const live = (kind: FakeTimer["kind"]) => timers.filter((t) => t.kind === kind && !t.cleared);

/** Lets fire-and-forget work (`void this.syncNow()`, staged persists) settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const CONFIGURED = {
  serverUrl: "https://vault.example.workers.dev",
  accessToken: "access-token",
  encryptionMode: "plaintext" as const,
};

interface PersistedData {
  settings?: Partial<Settings>;
  state?: unknown;
  stateServerUrl?: string;
  sharedSettings?: unknown;
  lastSuccessAt?: number;
}

function persisted(over: PersistedData = {}): PersistedData {
  return {
    settings: { ...CONFIGURED, firstSyncAcknowledged: true },
    state: { lastSyncedHead: "01HEAD", files: {}, keyId: null, lines: {} },
    stateServerUrl: CONFIGURED.serverUrl,
    sharedSettings: { updatedAt: 5, device: "other" },
    ...over,
  };
}

function makePlugin(data: PersistedData | null = null): {
  plugin: LogSyncPlugin;
  app: LifecycleApp;
} {
  const app = new LifecycleApp();
  const plugin = new LogSyncPlugin(app as never, {
    id: "cloudflare-rdo-sync",
    name: "R2DO Sync",
  } as never);
  (plugin as unknown as { persisted: unknown }).persisted = data;
  return { plugin, app };
}

/** What `saveData()` last wrote, which is the only record that survives a reload. */
function lastSave(plugin: LogSyncPlugin): PersistedData {
  const saves = (plugin as unknown as { saves: PersistedData[] }).saves;
  return saves[saves.length - 1];
}

/**
 * An ordinary load decides what to keep in memory and writes nothing; the next save is what
 * commits that decision. Flushing through the public method is how a test observes it
 * without reaching into private fields.
 */
async function flushToDisk(plugin: LogSyncPlugin): Promise<PersistedData> {
  await plugin.saveSettings();
  return lastSave(plugin);
}

/** A server that answers an empty vault, so a consented pass can run to completion. */
function okServer(): void {
  requestUrlMock.impl = async (req) => {
    const url = (req as { url: string }).url;
    if (url.endsWith("/api/head")) return { status: 200, text: '{"head":null}', json: { head: null } };
    if (url.endsWith("/api/settings")) {
      return { status: 404, text: "{}", json: { error: { code: "not_found", message: "none" } } };
    }
    if (url.endsWith("/api/commit")) {
      return { status: 200, text: "{}", json: { head: "01NEWHEAD" } };
    }
    return { status: 200, text: "{}", json: {} };
  };
}

function emptyVault(app: LifecycleApp): void {
  app.vault.adapter = {
    list: async () => ({ files: [], folders: [] }),
    stat: async () => null,
  } as never;
}

/**
 * A vault holding one real note. The first-sync gate now inspects the vault to decide WHICH
 * question to ask — a device with nothing of its own is offered a download rather than a
 * merge — so a test about the general gate has to have something to merge.
 */
function vaultWithANote(app: LifecycleApp): void {
  const bytes = new TextEncoder().encode("real content\n");
  const file = { path: "note.md", size: bytes.byteLength, mtime: 1 };
  app.vault.adapter = {
    list: async () => ({ files: [file.path], folders: [] }),
    stat: async () => ({ type: "file", size: file.size, mtime: file.mtime }),
    readBinary: async () => bytes.buffer,
  } as never;
}

function lastModal(): Modal & { opts?: Record<string, unknown> } {
  return Modal.shown[Modal.shown.length - 1] as Modal & { opts?: Record<string, unknown> };
}

/**
 * Waits for a confirmation window to actually open.
 *
 * A typed-phrase window sits behind a preview request, so a fixed flush count is a race: miss
 * it and the modal opens during the NEXT test, where that test's `answerConfirm` confirms the
 * wrong action. Seen doing exactly that.
 */
async function untilModal(): Promise<void> {
  for (let i = 0; i < 50 && Modal.shown.length === 0; i++) await flush();
  expect(lastModal()).toBeDefined();
}

/** Answers the confirm window the way a user would. */
function answerConfirm(accept: boolean): void {
  const modal = lastModal();
  const opts = modal.opts as
    | { onConfirm?: () => unknown; onCancel?: () => unknown }
    | undefined;
  if (accept) void opts?.onConfirm?.();
  else modal.close();
}

beforeEach(() => {
  installGlobals();
  Notice.shown.length = 0;
  Modal.shown.length = 0;
  requestUrlMock.impl = null;
  requestUrlMock.calls.length = 0;
});

afterEach(() => {
  Platform.isMobile = false;
});

// --- endpoint identity ---------------------------------------------------------------------

describe("onload() endpoint identity", () => {
  it("keeps cached state and consent when the endpoint only differs by trailing slash", async () => {
    const { plugin } = makePlugin(persisted({ stateServerUrl: `${CONFIGURED.serverUrl}/` }));
    await plugin.onload();

    expect(plugin.settings.firstSyncAcknowledged).toBe(true);
    const saved = await flushToDisk(plugin);
    expect(saved.state).not.toBeNull();
    expect(saved.sharedSettings).not.toBeNull();
  });

  it("clears state, shared settings and consent when the persisted endpoint is a different vault", async () => {
    // A hand-edited data.json can repoint a device between loads. Dropping the cached head
    // without dropping the consent would leave the flag suppressing the gate, so the first
    // pass against a stranger's files happens unwarned.
    const { plugin } = makePlugin(persisted({ stateServerUrl: "https://other.example.dev" }));
    await plugin.onload();

    expect(plugin.settings.firstSyncAcknowledged).toBe(false);
    const saved = await flushToDisk(plugin);
    expect(saved.state).toBeNull();
    expect(saved.sharedSettings).toBeNull();
  });

  it("saveSettings() after an endpoint edit invalidates the same three things and persists it", async () => {
    const { plugin } = makePlugin(persisted());
    await plugin.onload();
    expect(plugin.settings.firstSyncAcknowledged).toBe(true);

    plugin.settings.serverUrl = "https://moved.example.workers.dev";
    await plugin.saveSettings();

    expect(plugin.settings.firstSyncAcknowledged).toBe(false);
    const saved = lastSave(plugin);
    expect(saved.state).toBeNull();
    expect(saved.sharedSettings).toBeNull();
    expect(saved.stateServerUrl).toBe("https://moved.example.workers.dev");
    expect(saved.settings?.firstSyncAcknowledged).toBe(false);
  });

  it("saveSettings() that does not touch the endpoint keeps the cached state", async () => {
    const { plugin } = makePlugin(persisted());
    await plugin.onload();

    plugin.settings.debounceSeconds = 9;
    await plugin.saveSettings();

    expect(plugin.settings.firstSyncAcknowledged).toBe(true);
    expect(lastSave(plugin).state).not.toBeNull();
  });
});

// --- first-sync consent ----------------------------------------------------------------------

describe("first-sync consent", () => {
  // retryAttempts 0: a pass that fails must settle now rather than sleeping on the real
  // clock through the scheduler's backoff.
  const unconsented = () =>
    makePlugin(
      persisted({
        settings: { ...CONFIGURED, firstSyncAcknowledged: false, retryAttempts: 0 },
        state: null,
      })
    );

  it("syncNow() reaches no network at all until the gate is answered", async () => {
    const { plugin, app } = unconsented();
    vaultWithANote(app);
    await plugin.onload();

    const pass = plugin.syncNow();
    await flush();
    // The window is up and nothing has been sent.
    expect(lastModal()).toBeDefined();
    expect(requestUrlMock.calls).toHaveLength(0);

    answerConfirm(false);
    await pass;

    expect(requestUrlMock.calls).toHaveLength(0);
    expect(plugin.settings.firstSyncAcknowledged).toBe(false);
    expect((await flushToDisk(plugin)).settings?.firstSyncAcknowledged).toBe(false);
  });

  it("dismissing the window is a refusal, not a hang", async () => {
    const { plugin, app } = unconsented();
    vaultWithANote(app);
    await plugin.onload();

    const pass = plugin.syncNow();
    await flush();
    lastModal().close(); // Obsidian runs onClose on dismissal

    await expect(pass).resolves.toBeUndefined();
    expect(plugin.settings.firstSyncAcknowledged).toBe(false);
  });

  it("accepting persists the acknowledgement and lets the pass proceed", async () => {
    const { plugin, app } = unconsented();
    await plugin.onload();
    emptyVault(app);
    okServer();

    const pass = plugin.syncNow();
    await flush();
    answerConfirm(true);
    await pass;

    expect(plugin.settings.firstSyncAcknowledged).toBe(true);
    expect(lastSave(plugin).settings?.firstSyncAcknowledged).toBe(true);
    // Consent is what unblocks the network, so the pass got as far as talking to the server.
    expect(requestUrlMock.calls.length).toBeGreaterThan(0);
  });

  it("asks a device with nothing of its own to download rather than to merge", async () => {
    const { plugin, app } = unconsented();
    await plugin.onload();
    emptyVault(app);
    okServer();

    const pass = plugin.syncNow();
    await flush();

    // A different question, because the general one describes a risk this case does not carry:
    // there is nothing here to lose and nothing of its own to publish. A dialog that warns
    // about both anyway is how people learn to click through dialogs.
    const opts = lastModal().opts as { title?: string; confirmText?: string; body?: string[] };
    expect(opts.title).toMatch(/download/i);
    expect(opts.confirmText).toMatch(/download/i);
    expect(opts.body?.[0]).toMatch(/nothing on this device is published/i);

    answerConfirm(true);
    await pass;
    expect(plugin.settings.firstSyncAcknowledged).toBe(true);
  });

  it("still asks a device that has notes of its own to weigh the merge", async () => {
    const { plugin, app } = unconsented();
    vaultWithANote(app);
    await plugin.onload();
    okServer();

    void plugin.syncNow();
    await flush();

    const opts = lastModal().opts as { title?: string; confirmText?: string };
    expect(opts.title).toMatch(/back up/i);
    expect(opts.confirmText).toMatch(/backup/i);
    answerConfirm(false);
  });

  it("a device that already has a synced head is never asked", async () => {
    const { plugin, app } = makePlugin(
      persisted({
        settings: { ...CONFIGURED, firstSyncAcknowledged: false, retryAttempts: 0 },
      })
    );
    await plugin.onload();
    emptyVault(app);
    okServer();

    await plugin.syncNow();

    expect(Modal.shown).toHaveLength(0);
    // Recorded rather than re-asked on every pass.
    expect(plugin.settings.firstSyncAcknowledged).toBe(true);
  });

  it("forcePush() asks before previewing, and a refusal previews nothing", async () => {
    const { plugin } = unconsented();
    await plugin.onload();

    const push = plugin.forcePush();
    await flush();
    expect(lastModal()).toBeDefined();
    expect(requestUrlMock.calls).toHaveLength(0);

    answerConfirm(false);
    await push;

    // No preview, no typed-phrase window, nothing published.
    expect(Modal.shown).toHaveLength(1);
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("rebuildHistory() asks too — it is the one action that deletes remote content", async () => {
    const { plugin } = unconsented();
    await plugin.onload();

    const rebuild = plugin.rebuildHistory();
    await flush();
    expect(lastModal()).toBeDefined();
    expect(requestUrlMock.calls).toHaveLength(0);

    answerConfirm(false);
    await rebuild;

    expect(Modal.shown).toHaveLength(1);
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("forcePull() asks before it overwrites this device, not after", async () => {
    // The pull writes the remote over local files and only then publishes. Reaching the gate
    // through that trailing publish would accept the backup warning after the loss it warns
    // about, so this action owns the gate itself.
    const { plugin } = unconsented();
    await plugin.onload();

    const pull = plugin.forcePull();
    await flush();
    expect(lastModal()).toBeDefined();
    expect(requestUrlMock.calls).toHaveLength(0);

    answerConfirm(false);
    await pull;

    expect(Modal.shown).toHaveLength(1);
    expect(requestUrlMock.calls).toHaveLength(0);
  });
});

// --- setup application -----------------------------------------------------------------------

describe("applySetup()", () => {
  const payload = {
    v: 2 as const,
    url: "https://joined.example.workers.dev",
    token: "joined-token",
    name: "phone",
    mode: "encrypted" as const,
    key: "A".repeat(43) + "=",
    vaultSalt: "c2FsdHNhbHRzYWx0c2FsdA==",
  };

  it("adopts the new identity, clears the old vault's state, and gates the first pass", async () => {
    const { plugin } = makePlugin(persisted());
    await plugin.onload();
    requestUrlMock.impl = async () => ({ status: 200, text: "{}", json: { head: "01REMOTE" } });

    await plugin.applySetup(payload);
    await flush();

    expect(plugin.settings.serverUrl).toBe(payload.url);
    expect(plugin.settings.accessToken).toBe(payload.token);
    expect(plugin.settings.deviceName).toBe("phone");
    expect(plugin.settings.encryptionMode).toBe("encrypted");
    expect(plugin.settings.masterKey).toBe(payload.key);
    // Transit is not a backup, but the sending device already had one.
    expect(plugin.settings.masterKeyBackedUp).toBe(true);
    // A device pointed at a vault it has never synced owes the acknowledgement again.
    expect(plugin.settings.firstSyncAcknowledged).toBe(false);

    const saved = lastSave(plugin);
    expect(saved.state).toBeNull();
    expect(saved.sharedSettings).toBeNull();
    // It probed the new head rather than assuming the link works.
    expect(requestUrlMock.calls.length).toBeGreaterThan(0);
  });

  it("cancels the settings push its own save scheduled, so it adopts vault policy", async () => {
    // Otherwise a just-configured device publishes its defaults over the vault's settings.
    const { plugin } = makePlugin(persisted());
    await plugin.onload();
    requestUrlMock.impl = async () => ({ status: 200, text: "{}", json: { head: null } });

    await plugin.applySetup(payload);

    expect(live("timeout")).toHaveLength(0);
  });

  it("reports a failed connection test instead of looking configured and silent", async () => {
    const { plugin } = makePlugin(persisted());
    await plugin.onload();
    requestUrlMock.impl = async () => {
      throw new Error("network down");
    };

    await plugin.applySetup(payload);
    await flush();

    expect(Notice.shown.some((n) => /connection test failed/.test(n))).toBe(true);
  });
});

// --- protocol handler -------------------------------------------------------------------------

describe("setup protocol handler", () => {
  const handler = (plugin: LogSyncPlugin) =>
    (plugin as unknown as { protocolHandlers: Map<string, (p: Record<string, string>) => unknown> })
      .protocolHandlers;

  it("registers under the setup action and routes a valid payload to the apply window", async () => {
    const { plugin } = makePlugin(persisted());
    await plugin.onload();

    const handlers = handler(plugin);
    expect([...handlers.keys()]).toEqual(["r2do-sync-setup"]);

    Modal.shown.length = 0;
    handlers.get("r2do-sync-setup")!({
      d: encodeSetupPayload({
        v: 2,
        url: "https://joined.example.workers.dev",
        token: "joined-token",
        name: "phone",
        mode: "plaintext",
      }),
    });

    // A window the user confirms — never applied straight off a URL.
    expect(Modal.shown).toHaveLength(1);
    expect(plugin.settings.serverUrl).toBe(CONFIGURED.serverUrl);
  });

  it("rejects malformed input visibly rather than silently", async () => {
    const { plugin } = makePlugin(persisted());
    await plugin.onload();

    Notice.shown.length = 0;
    Modal.shown.length = 0;
    handler(plugin).get("r2do-sync-setup")!({ d: "not-a-payload" });

    expect(Modal.shown).toHaveLength(0);
    expect(Notice.shown.some((n) => /setup link rejected/.test(n))).toBe(true);
  });
});

// --- key backup gate ---------------------------------------------------------------------------

describe("master key backup gate", () => {
  const freshEncrypted = () =>
    makePlugin({
      settings: {
        serverUrl: CONFIGURED.serverUrl,
        accessToken: CONFIGURED.accessToken,
        encryptionMode: "encrypted",
        masterKey: "",
        masterKeyBackedUp: false,
      },
    });

  it("generates and persists key material, then blocks on exactly one backup window", async () => {
    const { plugin } = freshEncrypted();
    await plugin.onload();

    expect(plugin.settings.masterKey).not.toBe("");
    expect(plugin.settings.vaultSalt).not.toBe("");
    expect(plugin.settings.masterKeyBackedUp).toBe(false);
    // Persisted before the window opens: a key shown once and never stored is a lost vault.
    expect(lastSave(plugin).settings?.masterKey).toBe(plugin.settings.masterKey);
    expect(Modal.shown).toHaveLength(1);
  });

  it("stays blocked when the window is dismissed without acknowledgement", async () => {
    const { plugin } = freshEncrypted();
    await plugin.onload();
    lastModal().close();

    expect(plugin.settings.masterKeyBackedUp).toBe(false);
    await plugin.syncNow();
    // No engine was built, so the pass could not have talked to a server.
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("does not re-open the window on a second rebuild", async () => {
    const { plugin } = freshEncrypted();
    await plugin.onload();
    await plugin.saveSettings();

    expect(Modal.shown).toHaveLength(1);
  });
});

// --- registration and teardown --------------------------------------------------------------------

describe("registration and teardown", () => {
  it("registers the vault listeners, commands, settings tab and status refresh", async () => {
    const { plugin, app } = makePlugin(persisted());
    await plugin.onload();

    expect(app.vault.events.map((e) => e.name).sort()).toEqual([
      "create",
      "delete",
      "modify",
      "rename",
    ]);
    const commands = (plugin as unknown as { commands: { id: string }[] }).commands;
    expect(commands.map((c) => c.id)).toContain("sync-now");
    expect(commands.map((c) => c.id)).toContain("sync-setup-qr");
    // Renaming a command id silently drops the user's hotkey, so the id is part of the contract.
    expect((plugin as unknown as { settingTabs: unknown[] }).settingTabs).toHaveLength(1);
    expect(live("interval").length).toBeGreaterThan(0);
  });

  it("defers the startup pass to layout-ready rather than running it during onload()", async () => {
    const { plugin, app } = makePlugin(
      persisted({ settings: { ...CONFIGURED, firstSyncAcknowledged: true, syncOnStartup: true } })
    );
    await plugin.onload();

    expect(app.workspace.layoutReady).toHaveLength(1);
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("onunload() leaves no live timer behind", async () => {
    const { plugin } = makePlugin(
      persisted({ settings: { ...CONFIGURED, firstSyncAcknowledged: true, intervalMinutes: 5 } })
    );
    await plugin.onload();
    expect(live("interval").length).toBeGreaterThan(0);

    plugin.onunload();

    // Obsidian clears whatever went through `registerInterval` itself, so what has to be
    // proven here is that nothing survives that the platform is NOT holding for us.
    const registered = new Set((plugin as unknown as { intervals: number[] }).intervals);
    expect(live("interval").filter((t) => !registered.has(t.id))).toHaveLength(0);
    expect(live("timeout")).toHaveLength(0);
  });

  const resumeHandler = (plugin: LogSyncPlugin): (() => void) => {
    const domEvents = (plugin as unknown as { domEvents: { type: string; handler: () => void }[] })
      .domEvents;
    expect(domEvents.map((e) => e.type)).toEqual(["visibilitychange"]);
    return domEvents[0].handler;
  };

  const onResume = async (over: Partial<Settings>, lastPassAt: number) => {
    Platform.isMobile = true;
    const { plugin, app } = makePlugin(
      persisted({
        settings: { ...CONFIGURED, firstSyncAcknowledged: true, syncOnStartup: true, ...over },
        lastSuccessAt: lastPassAt,
      })
    );
    emptyVault(app);
    okServer();
    await plugin.onload();
    requestUrlMock.calls.length = 0;
    resumeHandler(plugin)();
    await flush();
    await flush();
    return requestUrlMock.calls.length;
  };

  it("registers the mobile resume handler only on mobile, and it respects its own gap", async () => {
    // A resume moments after the last pass must not re-sync; the guard is time, not focus.
    expect(await onResume({ resumeSyncMinutes: 15 }, Date.now())).toBe(0);
  });

  it("syncs on resume once the gap has passed", async () => {
    expect(await onResume({ resumeSyncMinutes: 15 }, Date.now() - 20 * 60_000)).toBeGreaterThan(0);
  });

  it("never syncs on resume when the gap is zero, however long it has been", async () => {
    // 0 is the off switch, and it has to beat every other reason to sync — a device that has
    // been away for a week is exactly when a resume sync would otherwise be most certain.
    expect(await onResume({ resumeSyncMinutes: 0 }, Date.now() - 7 * 24 * 60 * 60_000)).toBe(0);
  });

  it("does not take its gap from the sync interval any more", async () => {
    // The reported complaint: a 3-minute interval used to mean every screen unlock more than
    // 3 minutes after the last pass started a sync. The two are independent now.
    const calls = await onResume(
      { intervalMinutes: 3, resumeSyncMinutes: 60 },
      Date.now() - 10 * 60_000
    );
    expect(calls).toBe(0);
  });

  it("still obeys sync on startup, because resuming IS startup on a phone", async () => {
    expect(
      await onResume({ syncOnStartup: false, resumeSyncMinutes: 1 }, Date.now() - 60 * 60_000)
    ).toBe(0);
  });

  it("registers no resume handler on desktop", async () => {
    const { plugin } = makePlugin(persisted());
    await plugin.onload();
    expect((plugin as unknown as { domEvents: unknown[] }).domEvents).toHaveLength(0);
  });

  it("an unconfigured device loads without building an engine or reaching the network", async () => {
    const { plugin } = makePlugin(null);
    await plugin.onload();

    expect(plugin.settings.serverUrl).toBe(DEFAULT_SETTINGS.serverUrl);
    expect(requestUrlMock.calls).toHaveLength(0);
    await plugin.syncNow();
    expect(Notice.shown.some((n) => /server URL and access token/.test(n))).toBe(true);
  });
});

// --- head-descent verification ----------------------------------------------------------

/**
 * A server serving a head whose history does not contain this device's own snapshot. The
 * engine's own spec covers what the walk concludes; what is wired here is who gets asked.
 */
function unrelatedHistoryServer(): void {
  requestUrlMock.impl = async (req) => {
    const url = (req as { url: string }).url;
    if (url.endsWith("/api/head")) {
      return { status: 200, text: '{"head":"01UNRELATED"}', json: { head: "01UNRELATED" } };
    }
    if (url.includes("/api/manifests/")) {
      const manifest = {
        v: 1,
        id: "01UNRELATED",
        parent: null,
        device: "somewhere-else",
        createdAt: "2026-08-13T00:00:00Z",
        files: {},
      };
      return { status: 200, text: JSON.stringify(manifest), json: manifest };
    }
    if (url.endsWith("/api/settings")) {
      return { status: 404, text: "{}", json: { error: { code: "not_found", message: "none" } } };
    }
    return { status: 200, text: "{}", json: {} };
  };
}

describe("continuity gate", () => {
  const configured = () =>
    makePlugin(
      persisted({
        settings: {
          ...CONFIGURED,
          firstSyncAcknowledged: true,
          retryAttempts: 0,
          intervalMinutes: 5,
        },
      })
    );

  it("a timer pass answers nothing, changes nothing, and says so", async () => {
    const { plugin, app } = configured();
    emptyVault(app);
    unrelatedHistoryServer();
    await plugin.onload();
    Notice.shown.length = 0;
    Modal.shown.length = 0;

    const timer = live("interval").find((t) => t.ms === 5 * 60_000);
    expect(timer).toBeDefined();
    timer!.fn();
    await flush();
    await flush();

    // Nobody is at the keyboard, so nothing may be asked and nothing may be published.
    expect(Modal.shown).toHaveLength(0);
    expect(requestUrlMock.calls.some((c) => (c as { url: string }).url.endsWith("/api/commit"))).toBe(
      false
    );
    expect(Notice.shown.some((n) => /could not trace the remote's current snapshot/.test(n))).toBe(
      true
    );
  });

  it("a sync the user started raises the window instead", async () => {
    const { plugin, app } = configured();
    emptyVault(app);
    unrelatedHistoryServer();
    await plugin.onload();
    Modal.shown.length = 0;

    const pass = plugin.syncNow();
    await flush();

    const modal = lastModal();
    expect(modal).toBeDefined();
    expect(modal.contentEl.log.headings).toContain("Cannot confirm the remote's history");
    // Dismissal is not an answer; the pass settles as "stopped" rather than hanging.
    modal.close();
    await pass;

    expect(requestUrlMock.calls.some((c) => (c as { url: string }).url.endsWith("/api/commit"))).toBe(
      false
    );
  });

  it("names the ordinary cause of each reason instead of only the alarming one", () => {
    const summary = { head: "01NEW", lastHead: "01OURS", walked: 3, alreadyApplied: 0 } as const;
    const replaced = continuityBody({ ...summary, reason: "replaced" }).join(" ");
    const truncated = continuityBody({ ...summary, reason: "truncated" }).join(" ");
    const limit = continuityBody({ ...summary, reason: "limit" }).join(" ");

    expect(replaced).toContain("Rebuild remote history");
    expect(truncated).toContain("away longer than the server keeps history");
    expect(limit).toContain("3 snapshots back");
    const unauthenticated = continuityBody({ ...summary, reason: "unauthenticated" }).join(" ");
    expect(unauthenticated).toContain("past an encryption change");
    // Every one of them names both heads and says what stopping costs, which is nothing.
    for (const text of [replaced, truncated, limit, unauthenticated]) {
      // Lower-cased, like every id on screen: `shortSnapshot` owns the rendering so no two
      // surfaces can disagree about how one looks.
      expect(text).toContain("01new");
      expect(text).toContain("01ours");
      expect(text).toContain("Stopping leaves both sides exactly as they are");
    }
  });

  it("abbreviates both heads, like every other id on screen", () => {
    // This window used to spell them in full while the notice beside it showed seven
    // characters, so the reader's first job was working out whether they were the same
    // snapshot. Realistic ULIDs here, since a short fixture id cannot show the difference.
    const head = "01K2QWERTYABCDEFGHJKMNPQRS";
    const lastHead = "01K2QWERTYABCDEFGHJZZZZZZ";
    const text = continuityBody({
      head,
      lastHead,
      reason: "replaced",
      walked: 1,
      alreadyApplied: 0,
    }).join(" ");

    expect(text).toContain("kmnpqrs");
    expect(text).toContain("zzzzzz");
    expect(text).not.toContain(head);
    expect(text).not.toContain(lastHead);
  });

  it("does not promise nothing changed when this pass already applied a verified snapshot", () => {
    // The one case where "stopping changes nothing" is a lie: an earlier turn of the same
    // pass merged a head whose ancestry it confirmed, then lost the head race.
    const text = continuityBody({
      head: "01NEW",
      lastHead: "01OURS",
      reason: "replaced",
      walked: 1,
      alreadyApplied: 2,
    }).join(" ");

    expect(text).not.toContain("Stopping leaves both sides exactly as they are");
    expect(text).toContain("Stopping publishes nothing");
    expect(text).toContain("does not undo the 2 file(s)");
  });
});

// --- notice policy, end to end -------------------------------------------------------------
//
// The unit tests in notify.spec.ts pin the decision. These pin the WIRING: every self-raised
// notice actually asks the policy, rather than most of them asking and one call site that
// nobody moved still calling `new Notice` directly. That is the failure a green unit suite
// cannot see, and it is the failure that makes "silent" a false promise.

describe("the silent level", () => {
  const withSettings = (over: Partial<Settings>) =>
    makePlugin(
      persisted({
        settings: { ...CONFIGURED, firstSyncAcknowledged: true, retryAttempts: 0, ...over },
      })
    );

  it("raises the ordinary pass notice at the default level", async () => {
    // The control: without this, a suite where nothing ever notices would pass just as well.
    const { plugin, app } = withSettings({ noticeLevel: "all" });
    emptyVault(app);
    okServer();
    await plugin.onload();
    Notice.shown.length = 0;

    await plugin.syncNow();
    await flush();

    expect(Notice.shown.some((n) => /R2DO Sync/.test(n))).toBe(true);
  });

  it("says nothing at all for a pass the user started, with the manual override off", async () => {
    const { plugin, app } = withSettings({
      noticeLevel: "silent",
      notifyOnStart: false,
      alwaysReportManualSync: false,
    });
    emptyVault(app);
    okServer();
    await plugin.onload();
    Notice.shown.length = 0;

    await plugin.syncNow();
    await flush();

    expect(Notice.shown).toEqual([]);
  });

  it("still opens with \"syncing…\" if that switch is left on, and says nothing else", async () => {
    // The deliberate seam: the opener answers a tap, which the level never governs. Pinned so
    // nobody folds it into the ladder as a tidy-up — and pinned as "only that", so folding it
    // in the other direction (leaking the summary back) fails too.
    const { plugin, app } = withSettings({
      noticeLevel: "silent",
      notifyOnStart: true,
      alwaysReportManualSync: false,
    });
    emptyVault(app);
    okServer();
    await plugin.onload();
    Notice.shown.length = 0;

    await plugin.syncNow();
    await flush();

    expect(Notice.shown).toEqual(["Cloudflare R2DO Sync syncing…"]);
  });

  it("says nothing when a pass fails, and still records the failure", async () => {
    // The load-bearing claim of the whole feature: silence removes the interruption, not the
    // evidence. If this ever regresses to swallowing the error too, silent mode becomes a way
    // to make a broken sync look like a working one.
    const { plugin, app } = withSettings({
      noticeLevel: "silent",
      notifyOnStart: false,
      alwaysReportManualSync: false,
    });
    emptyVault(app);
    requestUrlMock.impl = async () => {
      throw new Error("network down");
    };
    await plugin.onload();
    Notice.shown.length = 0;

    await plugin.syncNow();
    await flush();

    expect(Notice.shown).toEqual([]);
    const saved = lastSave(plugin) as PersistedData & {
      log?: { status: string; detail: string }[];
      lastFailureAt?: number;
    };
    expect(saved.log?.[0]?.status).toBe("error");
    expect(saved.log?.[0]?.detail).toContain("network down");
    expect(saved.lastFailureAt).toBeGreaterThan(0);
  });

  it("still shows a failure at the problems level, where the pass summary is gone", async () => {
    // The rung's whole purpose: everything routine goes quiet, everything needing a human
    // stays loud. A level that took the failure with the chatter would be silence with extra
    // steps.
    const { plugin, app } = withSettings({ noticeLevel: "problems" });
    emptyVault(app);
    requestUrlMock.impl = async () => {
      throw new Error("network down");
    };
    await plugin.onload();
    Notice.shown.length = 0;

    await plugin.syncNow();
    await flush();

    expect(Notice.shown.some((n) => /network down/.test(n))).toBe(true);
  });

  it("drops the routine summary at the problems level but keeps the pass running", async () => {
    // `syncSettings: false` because the shared-settings fetch is unmocked here and its failure
    // is itself a `problems` notice — a real one, but not the thing under test.
    const { plugin, app } = withSettings({
      noticeLevel: "problems",
      notifyOnStart: false,
      alwaysReportManualSync: false,
      syncSettings: false,
    });
    emptyVault(app);
    okServer();
    await plugin.onload();
    Notice.shown.length = 0;

    await plugin.syncNow();
    await flush();

    expect(Notice.shown).toEqual([]);
    const saved = lastSave(plugin) as PersistedData & { lastSuccessAt?: number };
    expect(saved.lastSuccessAt).toBeGreaterThan(0);
  });

  it("reports a pass the user started anyway, because the ladder is about the timer", async () => {
    // The default, and the whole point of the override: every rung of the ladder is reasoning
    // about sync running on its own. Someone who just tapped "Sync now" is watching the screen
    // waiting for an answer, and a control that replies with nothing reads as broken.
    const { plugin, app } = withSettings({ noticeLevel: "silent", notifyOnStart: false });
    emptyVault(app);
    okServer();
    await plugin.onload();
    Notice.shown.length = 0;

    await plugin.syncNow();
    await flush();

    // Both ends: the opener when the tap lands, and the summary when the work is done.
    expect(Notice.shown[0]).toBe("Cloudflare R2DO Sync syncing…");
    expect(Notice.shown.length).toBeGreaterThan(1);
  });

  it("leaves the timer silent while the override is on", async () => {
    // The seam that makes the override safe to default on. If a background pass leaked through
    // it, Silent would mean nothing at all and the ladder would be decoration.
    const { plugin, app } = withSettings({ noticeLevel: "silent", syncOnStartup: true });
    emptyVault(app);
    okServer();
    await plugin.onload();
    Notice.shown.length = 0;

    layoutReady(app);
    await flush();

    expect(requestUrlMock.calls.length).toBeGreaterThan(0);
    expect(Notice.shown).toEqual([]);
  });

  it("speaks when a hand-started pass fails at Silent", async () => {
    // The failure is the one thing a person who tapped sync most needs back. The stored level
    // still owns the timer's failures, which the test above pins.
    const { plugin, app } = withSettings({ noticeLevel: "silent" });
    emptyVault(app);
    requestUrlMock.impl = async () => {
      throw new Error("network down");
    };
    await plugin.onload();
    Notice.shown.length = 0;

    await plugin.syncNow();
    await flush();

    expect(Notice.shown.some((n) => /network down/.test(n))).toBe(true);
  });

  it("leaves a background settings-push failure at the stored level, mid-manual-sync", async () => {
    // `#interactive` describes the MOMENT, not the notice. The shared-settings push is a
    // two-second debounce timer with no pass behind it, and it lands inside a manual sync
    // easily — change a setting, tap Sync now. Promoting it there would put an unrelated
    // failure on a silenced device's screen, which is the "sync nobody asked for" case the
    // ladder exists for. What the manual pass itself says is still promoted; the test above
    // pins that half, and this one pins that the two do not travel together.
    const { plugin, app } = makePlugin(
      persisted({
        settings: {
          ...CONFIGURED,
          firstSyncAcknowledged: true,
          retryAttempts: 0,
          noticeLevel: "silent",
          syncSettings: true,
        },
        // No revision yet, so the push goes straight to the PUT below rather than dying on a
        // fixture that never had one — the failure has to be the one this test names.
        sharedSettings: null,
      })
    );
    emptyVault(app);

    let puts = 0;
    let fireSettingsPush: (() => void) | null = null;
    requestUrlMock.impl = async (req) => {
      const { url, method } = req as { url: string; method?: string };
      if (url.endsWith("/api/settings")) {
        if (method === "PUT") {
          puts++;
          throw new Error("settings publish refused");
        }
        return { status: 404, text: "{}", json: { error: { code: "not_found", message: "none" } } };
      }
      // Mid-pass, so `#interactive` is above zero exactly as it is in a real overlap.
      if (url.endsWith("/api/head")) {
        fireSettingsPush?.();
        fireSettingsPush = null;
        return { status: 200, text: '{"head":null}', json: { head: null } };
      }
      if (url.endsWith("/api/commit")) return { status: 200, text: "{}", json: { head: "01NEWHEAD" } };
      return { status: 200, text: "{}", json: {} };
    };
    await plugin.onload();

    // Move a shared value, so the debounce is actually scheduled rather than skipped as a
    // fingerprint no-op.
    plugin.settings.protectPercent = 41;
    await plugin.saveSettings();
    const pending = live("timeout").at(-1);
    expect(pending).toBeDefined();
    fireSettingsPush = () => pending?.fn();
    Notice.shown.length = 0;

    await plugin.syncNow();
    await flush();

    // The push really was attempted and really did fail — without this the assertion below
    // would pass just as well on a test that never reached the notice at all.
    expect(puts).toBeGreaterThan(0);
    // The pass the user started still speaks. That is the override doing its job.
    expect(Notice.shown.length).toBeGreaterThan(0);
    // The unrelated background failure does not.
    expect(Notice.shown.filter((n) => /could not publish settings/.test(n))).toEqual([]);
  });

  it("puts the snapshot in the notice when the switch is on, on any pass", async () => {
    // End to end, because this is the one part of the feature a user reads directly: the id in
    // the toast has to be the id the vault is actually on, not a value from the fixture.
    const { plugin, app } = withSettings({
      noticeLevel: "all",
      showHeadInNotice: true,
      // The shared-settings document is not what this test is about, and the fixture has no
      // revision for it.
      syncSettings: false,
    });
    vaultWithANote(app);
    // A server that can actually take a commit: `okServer` answers `{}` to the blob check,
    // and a pass that cannot upload never reaches a snapshot id to print.
    let head: string | null = null;
    requestUrlMock.impl = async (req) => {
      const { url } = req as { url: string };
      if (url.endsWith("/api/head")) {
        return { status: 200, text: "{}", json: { head } };
      }
      if (url.endsWith("/api/blobs/check")) {
        return { status: 200, text: "{}", json: { missing: [] } };
      }
      if (url.endsWith("/api/commit")) {
        head = "01NEWHEAD";
        return { status: 200, text: "{}", json: { head } };
      }
      return { status: 200, text: "{}", json: {} };
    };
    await plugin.onload();
    Notice.shown.length = 0;

    await plugin.syncNow();
    await flush();

    // "01NEWHEAD" abbreviated from the random end and lower-cased, which is what
    // `shortSnapshot` does for every id on screen.
    expect(Notice.shown.some((n) => /head at newhead/.test(n))).toBe(true);

    // The second pass commits nothing, and still says which snapshot it is up to date with —
    // the case the verbose list cannot cover, since there is no new snapshot to name.
    Notice.shown.length = 0;
    await plugin.syncNow();
    await flush();
    expect(Notice.shown.some((n) => /up to date/.test(n) && /head at newhead/.test(n))).toBe(true);
  });

  it("puts the snapshot on a pass that STOPPED, which is where it is asked hardest", async () => {
    // The summary never runs for a halt — "up to date" above a notice saying nothing was done
    // would be a false statement — so without this the switch quietly meant "every pass that
    // FINISHED". A halted device is exactly the one whose owner needs to know which version it
    // is sitting on.
    //
    // A real halt, not a stubbed result: the persisted state carries a snapshot taken with no
    // key, and the settings now say encrypted, which is the re-key halt in `sync.ts`.
    const { plugin, app } = makePlugin(
      persisted({
        settings: {
          ...CONFIGURED,
          firstSyncAcknowledged: true,
          retryAttempts: 0,
          noticeLevel: "all",
          showHeadInNotice: true,
          syncSettings: false,
        },
        // Taken under a key; the settings above are plaintext. That is the re-key halt in
        // `sync.ts`, and it needs no crypto to stage.
        state: { lastSyncedHead: "01HEAD", files: {}, keyId: "K1", lines: {} },
      })
    );
    emptyVault(app);
    okServer();
    await plugin.onload();
    Notice.shown.length = 0;

    await plugin.syncNow();
    await flush();

    const halt = Notice.shown.find((n) => /halted:/.test(n));
    expect(halt).toBeDefined();
    // The head the device is actually on, from `persisted()`'s state — abbreviated and
    // lower-cased like every other id on screen.
    expect(halt).toMatch(/head at 01head/);
    // And on exactly one notice. The same snapshot named twice in one pass reads as two.
    expect(Notice.shown.filter((n) => /head at |head: nothing committed/.test(n))).toHaveLength(1);
  });

  it("announces a force push while it runs, whatever the notice level says", async () => {
    // It is the slowest action on the page — a whole vault re-read and uploaded — and it is the
    // direct answer to a typed confirmation, which the levels never govern. A window that
    // closes onto nothing reads as an action that did not take.
    const { plugin, app } = withSettings({
      noticeLevel: "silent",
      alwaysReportManualSync: false,
      syncSettings: false,
    });
    vaultWithANote(app);
    okServer();
    await plugin.onload();
    Notice.shown.length = 0;

    const push = plugin.forcePush();
    // The typed-phrase window opens behind a preview request, so wait for it rather than
    // guessing at a flush count — an unanswered modal would otherwise open inside the NEXT
    // test and be answered there.
    await untilModal();
    answerConfirm(true);
    await push;
    await flush();

    expect(Notice.shown.some((n) => /publishing this device over the remote/i.test(n))).toBe(true);
  });

  it("announces a history rebuild while it runs, for the same reason", async () => {
    const { plugin, app } = withSettings({
      noticeLevel: "silent",
      alwaysReportManualSync: false,
      syncSettings: false,
    });
    vaultWithANote(app);
    // Rebuild refuses outright on a remote with no snapshot, so this one needs a head and the
    // manifest behind it before it will reach its typed-phrase window at all.
    const manifest = {
      v: 1,
      id: "01HEAD",
      parent: null,
      device: "other",
      createdAt: "2026-08-20T00:00:00.000Z",
      files: {},
    };
    requestUrlMock.impl = async (req) => {
      const { url } = req as { url: string };
      if (url.endsWith("/api/head")) return { status: 200, text: "{}", json: { head: "01HEAD" } };
      // No indexed history route, so the summary falls back to the manifest walk below —
      // which is the path an older Worker takes anyway.
      if (url.includes("/api/history")) {
        return { status: 404, text: "{}", json: { error: { code: "not_found", message: "none" } } };
      }
      if (url.includes("/api/manifests/")) {
        return { status: 200, text: "{}", json: manifest };
      }
      if (url.endsWith("/api/blobs/check")) return { status: 200, text: "{}", json: { missing: [] } };
      if (url.endsWith("/api/settings")) {
        return { status: 404, text: "{}", json: { error: { code: "not_found", message: "none" } } };
      }
      if (url.endsWith("/api/commit")) return { status: 200, text: "{}", json: { head: "01NEWHEAD" } };
      return { status: 200, text: "{}", json: {} };
    };
    await plugin.onload();
    Notice.shown.length = 0;

    const rebuild = plugin.rebuildHistory();
    await untilModal();
    answerConfirm(true);
    await rebuild;
    await flush();

    expect(Notice.shown.some((n) => /rebuilding the remote's history/i.test(n))).toBe(true);
  });

  it("still answers a click that cannot start a sync at all", async () => {
    // Not a status notice: it is the direct reply to a tap, and a control that answers nothing
    // reads as broken. Silence covers what the plugin says on its own initiative.
    const { plugin } = makePlugin(
      persisted({
        settings: { serverUrl: "", accessToken: "", noticeLevel: "silent", notifyOnStart: false },
      })
    );
    await plugin.onload();
    Notice.shown.length = 0;

    await plugin.syncNow();
    await flush();

    expect(Notice.shown.some((n) => /server URL and access token/.test(n))).toBe(true);
  });
});

// --- migrating off the five per-category booleans -------------------------------------------

describe("loading a data.json written before the notice level existed", () => {
  const loadWith = async (settings: Record<string, unknown>) => {
    const { plugin } = makePlugin(
      persisted({ settings: { ...CONFIGURED, ...settings } as Partial<Settings> })
    );
    await plugin.onload();
    return plugin;
  };

  it("carries the shipped defaults onto the loudest level", async () => {
    const plugin = await loadWith({
      notifyOnSync: true,
      notifyOnlyChanged: false,
      notifyOnChanges: true,
      notifyOnConflicts: true,
      notifyOnProblems: true,
    });
    expect(plugin.settings.noticeLevel).toBe("all");
    expect(plugin.settings.notifyOnStart).toBe(true);
  });

  it("keeps a device that had switched everything off silent, opener included", async () => {
    // The upgrade someone would notice most: they asked for quiet, and a release that handed
    // it back a "syncing…" popup would read as the setting having been ignored.
    const plugin = await loadWith({
      notifyOnSync: false,
      notifyOnChanges: false,
      notifyOnConflicts: false,
      notifyOnProblems: false,
    });
    expect(plugin.settings.noticeLevel).toBe("silent");
    expect(plugin.settings.notifyOnStart).toBe(false);
  });

  it("reads the old changes-only narrowing as the activity level", async () => {
    const plugin = await loadWith({ notifyOnSync: true, notifyOnlyChanged: true });
    expect(plugin.settings.noticeLevel).toBe("activity");
  });

  it("deletes the old keys instead of carrying them forward forever", async () => {
    const plugin = await loadWith({ notifyOnSync: false, notifyOnChanges: false });
    await plugin.saveSettings();
    const saved = lastSave(plugin) as PersistedData;
    const settings = saved.settings as unknown as Record<string, unknown>;
    for (const key of LEGACY_NOTICE_KEYS) expect(settings, key).not.toHaveProperty(key);
    expect(settings.noticeLevel).toBe("problems");
  });

  it("lets a level already chosen win over stale keys beside it", async () => {
    // A device that migrated on an earlier load can still be holding the old keys if its
    // data.json was written by an older build. Re-deriving from them every load would undo
    // the user's choice silently, once per restart.
    const plugin = await loadWith({ noticeLevel: "all", notifyOnSync: false });
    expect(plugin.settings.noticeLevel).toBe("all");
  });
});

// --- mobile status bar ----------------------------------------------------------------------

/**
 * Just enough of Obsidian's mobile DOM for `domMobileChrome` to bind to: an app container, the
 * hidden status bar, and a nav bar with a height. Built here rather than in `obsidian-fake`
 * because none of it is Obsidian's plugin API — it is the app's own layout, which is precisely
 * what makes the override worth pinning.
 */
function installMobileDom(): {
  bodyClasses: Set<string>;
  statusBarProps: Map<string, string>;
  observers: number;
  disconnects: number;
} {
  const bodyClasses = new Set<string>();
  const statusBarProps = new Map<string, string>();
  const counts = { observers: 0, disconnects: 0 };
  const statusBar = {
    style: {
      setProperty: (k: string, v: string) => statusBarProps.set(k, v),
      removeProperty: (k: string) => statusBarProps.delete(k),
    },
  };
  const navbar = { style: {} };
  const doc = {
    visibilityState: "visible",
    body: {
      classList: {
        toggle: (name: string, on: boolean) => {
          if (on) bodyClasses.add(name);
          else bodyClasses.delete(name);
        },
      },
    },
    querySelector: (selector: string) => {
      if (selector === ".app-container") return {};
      if (selector === ".app-container .status-bar") return statusBar;
      if (selector === ".mobile-navbar") return navbar;
      return null;
    },
  };
  class FakeMutationObserver {
    constructor() {
      counts.observers += 1;
    }
    observe(): void {}
    disconnect(): void {
      counts.disconnects += 1;
    }
  }
  Object.assign(globalThis, {
    document: doc,
    MutationObserver: FakeMutationObserver,
  });
  Object.assign(globalThis.window, {
    getComputedStyle: () => ({ getPropertyValue: () => "48px" }),
  });
  return {
    bodyClasses,
    statusBarProps,
    get observers() {
      return counts.observers;
    },
    get disconnects() {
      return counts.disconnects;
    },
  };
}

/** Runs the work the plugin deferred to layout-ready, as Obsidian would. */
function layoutReady(app: LifecycleApp): void {
  for (const cb of app.workspace.layoutReady) cb();
}

describe("mobile status bar override", () => {
  const onMobile = (over: Partial<Settings>) => {
    Platform.isMobile = true;
    return makePlugin(
      persisted({ settings: { ...CONFIGURED, firstSyncAcknowledged: true, ...over } })
    );
  };

  it("shows the bar on a mobile device that asked for it", async () => {
    const dom = installMobileDom();
    const { plugin, app } = onMobile({ mobileStatusBar: true });
    emptyVault(app);
    okServer();
    await plugin.onload();
    // The fake records layout-ready work rather than running it, which is the point: this
    // must NOT have run during `onload`, when Obsidian's chrome is not in the DOM yet.
    expect(dom.bodyClasses.size).toBe(0);
    layoutReady(app);
    await flush();

    expect(dom.bodyClasses.has("r2do-mobile-status-bar")).toBe(true);
    expect(dom.statusBarProps.get("--r2do-mobile-navbar-height")).toBe("48px");
  });

  it("leaves Obsidian's layout alone unless the setting asks", async () => {
    const dom = installMobileDom();
    const { plugin, app } = onMobile({ mobileStatusBar: false });
    emptyVault(app);
    okServer();
    await plugin.onload();
    layoutReady(app);
    await flush();

    expect(dom.bodyClasses.size).toBe(0);
    expect(dom.observers).toBe(0);
  });

  it("puts the layout back when the plugin unloads", async () => {
    // A disabled plugin that leaves the status bar forced open has not stopped working, it has
    // broken the app — and the user's only clue is a plugin they have already turned off.
    const dom = installMobileDom();
    const { plugin, app } = onMobile({ mobileStatusBar: true });
    emptyVault(app);
    okServer();
    await plugin.onload();
    layoutReady(app);
    await flush();
    expect(dom.bodyClasses.has("r2do-mobile-status-bar")).toBe(true);

    plugin.onunload();

    expect(dom.bodyClasses.has("r2do-mobile-status-bar")).toBe(false);
    expect(dom.statusBarProps.has("--r2do-mobile-navbar-height")).toBe(false);
    expect(dom.disconnects).toBe(1);
  });

  it("reports a layout it cannot find instead of failing to load", async () => {
    installMobileDom();
    // An Obsidian version that moved the status bar: the plugin must still work.
    Object.assign(globalThis, {
      document: { visibilityState: "visible", querySelector: () => null },
    });
    // At the silent level, which is the state that makes this message load-bearing: the whole
    // reason silencing notices is offered is that the status bar carries the state instead.
    // The opener is off too, so a leak through the policy cannot hide behind it.
    const { plugin, app } = onMobile({
      mobileStatusBar: true,
      noticeLevel: "silent",
      notifyOnStart: false,
    });
    emptyVault(app);
    okServer();
    Notice.shown.length = 0;
    await plugin.onload();
    layoutReady(app);
    await flush();

    expect(plugin.applyMobileStatusBar()).toMatch(/app container was not found/);
    // Said on screen at startup, not only into the console — and deliberately NOT routed
    // through the notice policy. Someone who silenced notices did it because the status bar
    // was carrying the state; if the bar could not be shown, that trade has stopped holding
    // and a console line nobody opens is how a device ends up with neither.
    expect(Notice.shown.some((n) => /app container was not found/.test(n))).toBe(true);
  });

  it("does nothing on desktop, where the bar is already visible", async () => {
    const dom = installMobileDom();
    Platform.isMobile = false;
    const { plugin, app } = makePlugin(
      persisted({ settings: { ...CONFIGURED, firstSyncAcknowledged: true, mobileStatusBar: true } })
    );
    emptyVault(app);
    okServer();
    await plugin.onload();
    layoutReady(app);
    await flush();
    expect(dom.bodyClasses.size).toBe(0);

    // Called directly, because `onload` never reaches it on desktop — this pins the guard
    // inside the method rather than only the one at the call site. The settings row is mobile
    // only, but a stale `mobileStatusBar: true` carried over from a phone by shared settings
    // or a copied `data.json` would otherwise override the desktop layout for no reason.
    expect(plugin.applyMobileStatusBar()).toBeNull();
    expect(dom.bodyClasses.size).toBe(0);
  });
});

// --- the notice name ------------------------------------------------------------------------

describe("notice name", () => {
  const failingServer = (): void => {
    requestUrlMock.impl = async () => {
      throw new Error("network down");
    };
  };

  const noticeAfterFailedSync = async (over: Partial<Settings>): Promise<string> => {
    const { plugin, app } = makePlugin(
      persisted({
        settings: {
          ...CONFIGURED,
          firstSyncAcknowledged: true,
          retryAttempts: 0,
          // Off, or the shared-settings check fails first with the same message and this
          // asserts against the wrong notice.
          syncSettings: false,
          ...over,
        },
      })
    );
    emptyVault(app);
    failingServer();
    await plugin.onload();
    Notice.shown.length = 0;
    await plugin.syncNow();
    await flush();
    const shown = Notice.shown.find((n) => /network down/.test(n));
    expect(shown, "no failure notice was raised at all").toBeDefined();
    return shown!;
  };

  it("labels notices with the configured name", async () => {
    expect(await noticeAfterFailedSync({})).toBe("Cloudflare R2DO Sync error: network down");
  });

  it("uses a name the user typed", async () => {
    expect(await noticeAfterFailedSync({ noticePrefix: "Vault" })).toBe(
      "Vault error: network down"
    );
  });

  it("drops the label when the toggle is off, leaving a sentence rather than a hole", async () => {
    // Every message is written to read correctly with and without the label in front of it.
    // A message that only parsed with the prefix attached would read as truncated here.
    expect(await noticeAfterFailedSync({ showNoticePrefix: false })).toBe("error: network down");
  });

  it("keeps the typed name while the label is switched off", async () => {
    // The two are separate settings precisely so this round-trips.
    expect(
      await noticeAfterFailedSync({ noticePrefix: "Vault", showNoticePrefix: false })
    ).toBe("error: network down");
  });

  it("treats a blank name as no name, without a leading space", async () => {
    expect(await noticeAfterFailedSync({ noticePrefix: "   " })).toBe("error: network down");
  });

  // The pass summary is the one message built with a leading newline, so that the detail sits
  // on its own line BELOW the name. Every test above asserts a single-line message, which is
  // exactly why this shape got its own bug: with the label off the newline had nothing left to
  // sit below and rendered as a blank first line.
  const summaryAfterOkSync = async (over: Partial<Settings>): Promise<string> => {
    const { plugin, app } = makePlugin(
      persisted({
        settings: {
          ...CONFIGURED,
          firstSyncAcknowledged: true,
          retryAttempts: 0,
          syncSettings: false,
          // `all`, not the shipped `activity`: what is under test is the label's shape on a
          // summary, and "up to date" is the shortest summary that exercises the leading
          // newline. At `activity` an idle pass correctly says nothing and there is no shape
          // left to assert on.
          noticeLevel: "all",
          notifyOnStart: false,
          ...over,
        },
      })
    );
    emptyVault(app);
    okServer();
    await plugin.onload();
    Notice.shown.length = 0;
    await plugin.syncNow();
    await flush();
    const shown = Notice.shown.find((n) => /up to date/.test(n));
    expect(shown, "no pass summary was raised at all").toBeDefined();
    return shown!;
  };

  it("puts the summary on its own line under the name", async () => {
    expect(await summaryAfterOkSync({})).toBe("Cloudflare R2DO Sync\nup to date");
  });

  it("starts the summary with the text, not a blank line, when the label is off", async () => {
    // The newline exists only to get below the name. Without a name it is a hole where the
    // label used to be — turning the label off should give back the row it occupied.
    const summary = await summaryAfterOkSync({ showNoticePrefix: false });
    expect(summary).toBe("up to date");
    expect(summary.startsWith("\n")).toBe(false);
  });

  it("does the same for a blank name", async () => {
    expect(await summaryAfterOkSync({ noticePrefix: "" })).toBe("up to date");
  });
});
