// Recovering a same-line conflict with the buttons in the review window.
//
// `conflict-resolve.spec.ts` proves the PLAN for every choice and both layouts. This proves the
// part that actually touches the vault: `resolveConflict()` re-reads the disk, applies the ops
// through `ObsidianVault`, and drops the entry from the outstanding list. A plan that is right
// and an apply that fails looks identical to the user — the button does nothing and the
// conflict is still listed.
//
// Same-line specifically, because that is the pair no merge can settle: both sides changed the
// same line, so the pass keeps both and the only way out is one of these four buttons.
import { beforeEach, describe, expect, it } from "vitest";
import LogSyncPlugin, { DEFAULT_SETTINGS, type Settings } from "../src/main";
import {
  type FakeElement,
  LifecycleApp,
  Modal,
  Notice,
  requestUrlMock,
} from "./obsidian-fake";
import type { ConflictInfo } from "../src/sync";
import { VaultCrypto } from "../src/crypto";

const KEY = "A".repeat(43) + "=";
const SALT = "c2FsdHNhbHRzYWx0c2FsdA==";

const PATH = "notes/shared.md";
const COPY = "notes/shared.conflict-other-2026-08-14-1200.md";

/** Both sides changed the same line, which is what makes the pair unmergeable. */
const MINE = "# Title\nthe line as I wrote it\ntrailing\n";
const THEIRS = "# Title\nthe line as they wrote it\ntrailing\n";

/** An in-memory vault the real `ObsidianVault` adapter calls can work against. */
function installVault(app: LifecycleApp, files: Map<string, string>): void {
  const enc = new TextEncoder();
  app.vault.adapter = {
    list: async (folder: string) => {
      const prefix = folder === "" ? "" : `${folder}/`;
      const under = [...files.keys()].filter((p) => p.startsWith(prefix));
      const rest = under.map((p) => p.slice(prefix.length));
      return {
        files: rest.filter((r) => !r.includes("/")).map((r) => `${prefix}${r}`),
        folders: [...new Set(rest.filter((r) => r.includes("/")).map((r) => `${prefix}${r.split("/")[0]}`))],
      };
    },
    stat: async (path: string) => {
      if (files.has(path)) return { type: "file", size: enc.encode(files.get(path)!).byteLength, mtime: 1 };
      const isFolder = [...files.keys()].some((p) => p.startsWith(`${path}/`));
      return isFolder ? { type: "folder", size: 0, mtime: 1 } : null;
    },
    readBinary: async (path: string) => enc.encode(files.get(path) ?? "").buffer,
    writeBinary: async (path: string, data: ArrayBuffer) => {
      if (failWrites) throw new Error("disk full");
      files.set(path, new TextDecoder().decode(new Uint8Array(data)));
    },
    mkdir: async () => {},
    trashSystem: async () => false,
    trashLocal: async (path: string) => {
      files.delete(path);
    },
  } as never;
}

// No cast: the shape is the point. `kept` names the side holding the canonical path, and
// reading it as "which side is ours" is exactly the mistake that inverts every button.
function conflict(over: Partial<ConflictInfo> = {}): ConflictInfo {
  return {
    path: PATH,
    copy: COPY,
    kept: "ours",
    ours: { mtime: 2_000, size: MINE.length },
    theirs: { mtime: 1_000, size: THEIRS.length },
    ...over,
  };
}

const SERVER = "https://x.example.workers.dev";

async function makePlugin(
  files: Map<string, string>,
  conflicts: ConflictInfo[],
  settings: Partial<Settings> = {},
  extra: Record<string, unknown> = {}
): Promise<LogSyncPlugin> {
  const app = new LifecycleApp();
  installVault(app, files);
  const plugin = new LogSyncPlugin(app as never, { id: "cloudflare-rdo-sync" } as never);
  (plugin as unknown as { persisted: unknown }).persisted = {
    settings: { ...DEFAULT_SETTINGS, serverUrl: SERVER, accessToken: "t", ...settings },
    lastConflicts: conflicts,
    ...extra,
  };
  await plugin.onload();
  return plugin;
}

/** Every choice button on screen; "Close" is not one, and must stay usable throughout. */
function choices(body: FakeElement) {
  return body.log.rows.flatMap((r) => r.buttons).filter((b) => b.text !== "Close");
}

function bodyOf(modal: Modal): FakeElement {
  return modal.contentEl as unknown as FakeElement;
}

/** Lets the window's fire-and-forget rendering settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Waits for a real signal instead of a fixed number of ticks.
 *
 * A fire-and-forget path whose length depends on WebCrypto takes a different number of ticks
 * under load than it does alone, which is a test that passes by itself and fails in the suite.
 * Bounded, and loud when it expires: a silent timeout would just move the flakiness.
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${what}`);
}

let files: Map<string, string>;
/** Makes the vault refuse writes, which is how a resolution fails at apply time. */
let failWrites = false;

beforeEach(() => {
  failWrites = false;
  // `onload()` registers a status-bar refresh through `window`, which node does not have.
  Object.assign(globalThis, {
    window: { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} },
    document: { visibilityState: "visible" },
  });
  Notice.shown.length = 0;
  Modal.shown.length = 0;
  requestUrlMock.impl = null;
  requestUrlMock.calls.length = 0;
  files = new Map([
    [PATH, MINE],
    [COPY, THEIRS],
  ]);
});

describe("recovering a same-line conflict", () => {
  it("keeps this device's version and clears the copy", async () => {
    const plugin = await makePlugin(files, [conflict()]);
    await plugin.resolveConflict(plugin.lastConflicts[0], "keep-mine");

    expect(files.get(PATH)).toBe(MINE);
    expect(files.has(COPY)).toBe(false);
    // Still listed afterwards would mean the button appeared to do nothing.
    expect(plugin.lastConflicts).toHaveLength(0);
  });

  it("promotes the other device's version onto the path", async () => {
    const plugin = await makePlugin(files, [conflict()]);
    await plugin.resolveConflict(plugin.lastConflicts[0], "keep-theirs");

    // The promote is a copy followed by a delete, not a move: a move would leave the
    // subsequent removal of the source with nothing to remove.
    expect(files.get(PATH)).toBe(THEIRS);
    expect(files.has(COPY)).toBe(false);
    expect(plugin.lastConflicts).toHaveLength(0);
  });

  it("promotes correctly when the OTHER side holds the canonical path", async () => {
    // The mirrored layout: theirs won the path and this device's version is the parked copy.
    // Position and ownership are different questions, and reading one for the other silently
    // resolves the conflict the wrong way round.
    files.set(PATH, THEIRS);
    files.set(COPY, MINE);
    const plugin = await makePlugin(files, [conflict({ kept: "theirs" })]);
    await plugin.resolveConflict(plugin.lastConflicts[0], "keep-mine");

    expect(files.get(PATH)).toBe(MINE);
    expect(files.has(COPY)).toBe(false);
  });

  it("combines the disagreement into one file, marked", async () => {
    const plugin = await makePlugin(files, [conflict()]);
    await plugin.resolveConflict(plugin.lastConflicts[0], "combine");

    const combined = files.get(PATH)!;
    // Both versions of the contested line survive; the agreed lines appear once.
    expect(combined).toContain("the line as I wrote it");
    expect(combined).toContain("the line as they wrote it");
    expect(combined.match(/# Title/g)).toHaveLength(1);
    expect(combined.match(/trailing/g)).toHaveLength(1);
    expect(files.has(COPY)).toBe(false);
  });

  it("keeping both changes nothing but still closes the entry", async () => {
    const plugin = await makePlugin(files, [conflict()]);
    await plugin.resolveConflict(plugin.lastConflicts[0], "keep-both");

    expect(files.get(PATH)).toBe(MINE);
    expect(files.get(COPY)).toBe(THEIRS);
    expect(plugin.lastConflicts).toHaveLength(0);
  });

  describe("when the note itself has been deleted since the conflict was recorded", () => {
    // The reported bug. `pruneResolved` only ever checked the COPY, and in the ordinary
    // layout the other side is the note's own path — so deleting the note left an entry that
    // was still listed, whose keep-mine / keep-both / combine buttons could only fail with
    // "is gone", and which could never clear. "File not found", permanently.

    it("still lets the parked version be restored onto the path", async () => {
      files.delete(PATH);
      const plugin = await makePlugin(files, [conflict()]);
      await plugin.resolveConflict(plugin.lastConflicts[0], "keep-theirs");

      // Promoting a parked copy onto a note that has since been deleted is a restore, not a
      // hazard — this is the choice that has to keep working.
      expect(files.get(PATH)).toBe(THEIRS);
      expect(files.has(COPY)).toBe(false);
      expect(plugin.lastConflicts).toHaveLength(0);
    });

    it("names the missing side and offers only what can still be done", async () => {
      files.delete(PATH);
      const plugin = await makePlugin(files, [conflict()]);
      await plugin.openConflictReview();
      await flush();

      const body = bodyOf(Modal.shown.at(-1)!);
      expect(body.texts().join(" ")).toContain(`No longer in the vault: ${PATH}`);

      // Only the choice that does not need the deleted note is live. The rest are visible but
      // disabled: a button whose only outcome is an error is worse than one that is plainly
      // unavailable.
      const buttons = choices(body);
      const live = buttons.filter((b) => !b.disabled).map((b) => b.text);
      expect(live).toEqual(["Other device"]);
      expect(buttons.filter((b) => b.disabled).map((b) => b.text).sort()).toEqual(
        ["Both files", "Combine into one", "This device"].sort()
      );
    });

    it("is not pruned away, because one side is still recoverable", async () => {
      files.delete(PATH);
      const plugin = await makePlugin(files, [conflict()]);
      await plugin.openConflictReview();
      await flush();
      // Dropping it would silently discard the only surviving copy of the other device's work.
      expect(plugin.lastConflicts).toHaveLength(1);
    });
  });

  it("stops rather than half-applying when the copy has already gone", async () => {
    files.delete(COPY);
    const plugin = await makePlugin(files, [conflict()]);

    await expect(plugin.resolveConflict(plugin.lastConflicts[0], "keep-theirs")).rejects.toThrow(
      /gone/
    );
    // The note is untouched: a resolution that cannot complete must not have started.
    expect(files.get(PATH)).toBe(MINE);
  });

  it("queues a choice behind an active sync pass, then applies it", async () => {
    let releaseHead = () => {};
    const headGate = new Promise<void>((resolve) => (releaseHead = resolve));
    requestUrlMock.impl = async (req) => {
      const url = (req as { url: string }).url;
      if (url.endsWith("/api/head")) {
        await headGate;
        return { status: 200, text: '{"head":null}', json: { head: null } };
      }
      throw new Error(`unexpected request: ${url}`);
    };
    const plugin = await makePlugin(files, [conflict()], {
      encryptionMode: "plaintext",
      firstSyncAcknowledged: true,
      syncMode: "pull-only",
      syncSettings: false,
      retryAttempts: 0,
    });

    const pass = plugin.syncNow();
    while (requestUrlMock.calls.length === 0) await Promise.resolve();

    let resolved = false;
    const resolution = plugin.resolveConflict(plugin.lastConflicts[0], "keep-theirs").then(() => {
      resolved = true;
    });
    await flush();

    expect(resolved).toBe(false);
    expect(files.get(PATH)).toBe(MINE);
    expect(files.get(COPY)).toBe(THEIRS);

    releaseHead();
    await Promise.all([pass, resolution]);
    expect(files.get(PATH)).toBe(THEIRS);
    expect(files.has(COPY)).toBe(false);
    expect(plugin.lastConflicts).toHaveLength(0);
  });
});

// Serialising the click was only half the fix. A window that looks identical before and after
// the press is how a button that is working gets reported as dead — which is the complaint
// this whole change came from.
describe("what the review window shows while a choice is waiting", () => {
  /** Holds `/api/head` open so a pass owns the lane for as long as the test wants. */
  async function passHoldingTheLane(): Promise<{ plugin: LogSyncPlugin; pass: Promise<unknown>; release: () => void }> {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    requestUrlMock.impl = async (req) => {
      const url = (req as { url: string }).url;
      if (!url.endsWith("/api/head")) throw new Error(`unexpected request: ${url}`);
      await gate;
      return { status: 200, text: '{"head":null}', json: { head: null } };
    };
    const plugin = await makePlugin(files, [conflict()], {
      encryptionMode: "plaintext",
      firstSyncAcknowledged: true,
      syncMode: "pull-only",
      syncSettings: false,
      retryAttempts: 0,
    });
    const pass = plugin.syncNow();
    while (requestUrlMock.calls.length === 0) await Promise.resolve();
    return { plugin, pass, release };
  }

  it("takes every choice out of service and says which wait it is in", async () => {
    const { plugin, pass, release } = await passHoldingTheLane();
    await plugin.openConflictReview();
    await flush();
    const body = bodyOf(Modal.shown.at(-1)!);
    const pressed = choices(body).find((b) => b.text === "This device")!;

    const click = pressed.click() as Promise<void>;

    // Synchronously, in the click's own tick — not after an await, which is a repaint the
    // user never sees.
    expect(pressed.text).toBe("Waiting for the current sync…");
    // All four, not just the pressed row: a resolution moves files the other rows describe.
    expect(choices(body).every((b) => b.disabled)).toBe(true);

    release();
    await Promise.all([pass, click]);
    expect(files.get(PATH)).toBe(MINE);
    expect(files.has(COPY)).toBe(false);
    expect(bodyOf(Modal.shown.at(-1)!).texts().join(" ")).toContain("All resolved");
  });

  it("says it is working, not waiting, when nothing holds the lane", async () => {
    const plugin = await makePlugin(files, [conflict()]);
    await plugin.openConflictReview();
    await flush();
    const body = bodyOf(Modal.shown.at(-1)!);
    const pressed = choices(body).find((b) => b.text === "This device")!;

    const click = pressed.click() as Promise<void>;

    // The distinction is the whole point of the two labels: claiming a wait that is not
    // happening is its own kind of lie about what the app is doing.
    expect(pressed.text).toBe("Resolving…");
    await click;
    expect(files.has(COPY)).toBe(false);
  });

  // A whole-vault rewrite is the one case where waiting is the wrong answer: it runs for as
  // long as it runs. Refusing is right — but it used to refuse by leaking the scheduler's own
  // "sync scheduler stopped", which names an internal object and tells the user nothing.
  it("refuses during an encryption migration, and says so in words", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    requestUrlMock.impl = async () => {
      await gate;
      throw new Error("network down");
    };
    const keyId = (await VaultCrypto.fromText(KEY)).keyId;
    const plugin = await makePlugin(
      files,
      [conflict()],
      {
        encryptionMode: "encrypted",
        masterKey: KEY,
        vaultSalt: SALT,
        masterKeyBackedUp: true,
        firstSyncAcknowledged: true,
        syncOnStartup: false,
        syncSettings: false,
        retryAttempts: 0,
      },
      {
        state: { lastSyncedHead: "01HEAD", files: {}, keyId, lines: {} },
        stateServerUrl: SERVER,
      }
    );

    plugin.requestEncryptionTarget("plaintext", "", "");
    // The gated request IS the migration being under way; anything sooner is a guess.
    await until(() => requestUrlMock.calls.length > 0, "the migration to reach the network");

    await expect(plugin.resolveConflict(plugin.lastConflicts[0], "keep-mine")).rejects.toThrow(
      /Encryption is being changed/
    );
    expect(files.get(COPY)).toBe(THEIRS);

    // The block outlives the migration itself: it is released only once a usable scheduler is
    // installed again, so the window between "migration failed" and "rebuilt" is covered too.
    release();
    await until(
      () => Notice.shown.some((m) => /Encryption migration failed/.test(m)),
      "the migration to fail and rebuild"
    );
    await flush();

    await plugin.resolveConflict(plugin.lastConflicts[0], "keep-mine");
    expect(files.has(COPY)).toBe(false);
  });

  it("puts the buttons back when the resolution fails", async () => {
    // The note is gone, so only "Other device" is offered — and the vault then refuses the
    // write, which is a failure the plan could not have predicted.
    files.delete(PATH);
    const plugin = await makePlugin(files, [conflict()]);
    await plugin.openConflictReview();
    await flush();
    const body = bodyOf(Modal.shown.at(-1)!);
    failWrites = true;

    await (choices(body).find((b) => b.text === "Other device")!.click() as Promise<void>);

    expect(Notice.shown.at(-1)!).toMatch(/could not resolve/);
    // Rebuilt from current state rather than blanket re-enabled: the window still has to
    // refuse the choices that cannot succeed.
    const after = choices(body);
    expect(after.some((b) => !b.disabled)).toBe(true);
    expect(after.every((b) => b.text !== "Resolving…")).toBe(true);
  });
});
