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
import { type FakeElement, LifecycleApp, Modal, Notice } from "./obsidian-fake";
import type { ConflictInfo } from "../src/sync";

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

async function makePlugin(
  files: Map<string, string>,
  conflicts: ConflictInfo[],
  settings: Partial<Settings> = {}
): Promise<LogSyncPlugin> {
  const app = new LifecycleApp();
  installVault(app, files);
  const plugin = new LogSyncPlugin(app as never, { id: "cloudflare-rdo-sync" } as never);
  (plugin as unknown as { persisted: unknown }).persisted = {
    settings: { ...DEFAULT_SETTINGS, serverUrl: "https://x.example.workers.dev", accessToken: "t", ...settings },
    lastConflicts: conflicts,
  };
  await plugin.onload();
  return plugin;
}

function bodyOf(modal: Modal): FakeElement {
  return modal.contentEl as unknown as FakeElement;
}

/** Lets the window's fire-and-forget rendering settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let files: Map<string, string>;

beforeEach(() => {
  // `onload()` registers a status-bar refresh through `window`, which node does not have.
  Object.assign(globalThis, {
    window: { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} },
    document: { visibilityState: "visible" },
  });
  Notice.shown.length = 0;
  Modal.shown.length = 0;
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
      const buttons = body.log.rows.flatMap((r) => r.buttons).filter((b) => b.text !== "Close");
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

});
