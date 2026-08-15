import { afterEach, beforeEach, describe, expect, it } from "vitest";
import LogSyncPlugin, {
  continuityBody,
  DEFAULT_SETTINGS,
  type Settings,
} from "../src/main";
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

  it("registers the mobile resume handler only on mobile, and it respects the interval", async () => {
    Platform.isMobile = true;
    const { plugin } = makePlugin(
      persisted({
        settings: {
          ...CONFIGURED,
          firstSyncAcknowledged: true,
          syncOnStartup: true,
          intervalMinutes: 15,
        },
        lastSuccessAt: Date.now(),
      })
    );
    await plugin.onload();

    const domEvents = (plugin as unknown as { domEvents: { type: string; handler: () => void }[] })
      .domEvents;
    expect(domEvents.map((e) => e.type)).toEqual(["visibilitychange"]);

    // A resume moments after the last pass must not re-sync; the guard is time, not focus.
    domEvents[0].handler();
    await flush();
    expect(requestUrlMock.calls).toHaveLength(0);
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
      expect(text).toContain("01NEW");
      expect(text).toContain("01OURS");
      expect(text).toContain("Stopping leaves both sides exactly as they are");
    }
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
