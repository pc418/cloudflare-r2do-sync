import { describe, expect, it, beforeEach } from "vitest";
import {
  HistoryModal,
  RestoreDestinationModal,
  SnapshotModal,
  describeChanges,
  describeRestore,
  type HistoryDeps,
} from "../src/main";
import { App, Modal, Notice, Setting, type FakeElement } from "./obsidian-fake";
import type { RestoreInspection, RestoreOutcome, SnapshotInfo } from "../src/sync";
import type { FileEntry } from "../src/types";

// Vitest aliases "obsidian" to the fake at runtime; tsc still sees the real types. Bridge here.
function contentOf(modal: object): FakeElement {
  return (modal as { contentEl: FakeElement }).contentEl;
}

function rowsOf(modal: object): Setting[] {
  return contentOf(modal).log.rows;
}

/** The fake records whether a window is still up; the real `Modal` type does not expose it. */
function isOpen(modal: object): boolean {
  return (modal as { opened: boolean }).opened;
}

/** Let the modals' awaited loads finish before anything is asserted about what they drew. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function entry(over: Partial<FileEntry> = {}): FileEntry {
  return { h: "a".repeat(64), size: 100, mtime: 1_754_000_000_000, ...over };
}

function snapshot(over: Partial<SnapshotInfo> = {}): SnapshotInfo {
  return {
    id: "01SNAP",
    parent: "01PARENT",
    device: "laptop",
    createdAt: "2026-08-05T10:00:00.000Z",
    fileCount: 3,
    readable: true,
    ...over,
  };
}

interface Calls {
  restore: Array<{ path: string; opts: { destination?: string; overwrite?: boolean } | undefined }>;
  restoreAll: string[];
  syncs: number;
}

function deps(
  over: Partial<HistoryDeps> = {},
  calls: Calls = { restore: [], restoreAll: [], syncs: 0 }
): HistoryDeps & { calls: Calls } {
  return {
    calls,
    historyLimit: 40,
    listHistory: async () => [],
    snapshotFiles: async () => ({}),
    inspectRestore: async () => ({
      entry: entry(),
      currentHash: null,
      current: "absent",
      unsyncedEdits: false,
      suggestion: "Note (restored 2026-08-05).md",
    }),
    restoreFile: async (_id, path, opts): Promise<RestoreOutcome> => {
      calls.restore.push({ path, opts });
      return { kind: "written", path, requested: path };
    },
    restoreAll: async (id) => {
      calls.restoreAll.push(id);
      return { written: 2, removed: 1 };
    },
    syncNow: async () => {
      calls.syncs++;
    },
    ...over,
  };
}

beforeEach(() => {
  Notice.shown.length = 0;
  Modal.shown.length = 0;
});

describe("the history window", () => {
  it("asks for diffs, and lists what each snapshot changed", async () => {
    const asked: Array<{ limit: number; changes: boolean }> = [];
    const modal = new HistoryModal(
      new App() as never,
      deps({
        historyLimit: 12,
        listHistory: async (limit, opts) => {
          asked.push({ limit, changes: opts?.changes === true });
          return [
            snapshot({
              changes: {
                files: [
                  { path: "b.md", kind: "added", bytes: 10, lines: 3 },
                  { path: "a.md", kind: "modified", bytes: 20, lines: 5 },
                  { path: "c.md", kind: "removed", bytes: -4, lines: -1 },
                ],
                added: 1,
                modified: 1,
                removed: 1,
                bytes: 26,
                linesAdded: 8,
                linesRemoved: 1,
                linesUnknown: 0,
                initial: false,
              },
            }),
          ];
        },
      })
    );
    modal.open();
    await settle();

    expect(asked).toEqual([{ limit: 12, changes: true }]);
    const texts = contentOf(modal).texts();
    // The changed paths are on the page without opening anything.
    expect(texts).toContain("added · b.md · +3 lines");
    expect(texts).toContain("changed · a.md · +5 lines");
    expect(texts).toContain("removed · c.md · -1 line");
    expect(rowsOf(modal)[0].rendered.desc).toContain("1 added, 1 changed, 1 removed");
    expect(rowsOf(modal)[0].rendered.desc).toContain("+8 -1 lines");
  });

  it("caps the preview and says how many it is holding back", async () => {
    const files = Array.from({ length: 9 }, (_, i) => ({
      path: `n${i}.md`,
      kind: "modified" as const,
      bytes: 1,
      lines: 1,
    }));
    const modal = new HistoryModal(
      new App() as never,
      deps({
        listHistory: async () => [
          snapshot({
            changes: {
              files,
              added: 0,
              modified: 9,
              removed: 0,
              bytes: 9,
              linesAdded: 9,
              linesRemoved: 0,
              linesUnknown: 0,
              initial: false,
            },
          }),
        ],
      })
    );
    modal.open();
    await settle();

    const texts = contentOf(modal).texts();
    expect(texts.filter((t) => t.startsWith("changed · n"))).toHaveLength(5);
    expect(texts).toContain("…and 4 more — Browse to see them all.");
  });

  it("says changes are unknown rather than drawing an empty list", async () => {
    const modal = new HistoryModal(
      new App() as never,
      deps({
        listHistory: async () => [
          snapshot({ changes: { unknown: "parent-missing" } }),
          snapshot({ id: "01OLD", changes: { unknown: "parent-unreadable" } }),
        ],
      })
    );
    modal.open();
    await settle();

    expect(rowsOf(modal)[0].rendered.desc).toContain("no longer retained");
    expect(rowsOf(modal)[1].rendered.desc).toContain("cannot be read with this device's key");
    // Crucially, neither claims nothing changed.
    expect(contentOf(modal).texts().join(" ")).not.toContain("no file changes");
  });

  it("opens the snapshot window with the diff it already has", async () => {
    const snap = snapshot({
      changes: {
        files: [{ path: "a.md", kind: "modified", bytes: 5, lines: 2 }],
        added: 0,
        modified: 1,
        removed: 0,
        bytes: 5,
        linesAdded: 2,
        linesRemoved: 0,
        linesUnknown: 0,
        initial: false,
      },
    });
    const modal = new HistoryModal(
      new App() as never,
      deps({
        listHistory: async () => [snap],
        snapshotFiles: async () => ({ "a.md": entry() }),
      })
    );
    modal.open();
    await settle();

    rowsOf(modal)[0].buttons[0].click();
    await settle();

    const opened = Modal.shown.at(-1)!;
    expect(opened).toBeInstanceOf(SnapshotModal);
    expect(contentOf(opened).texts()).toContain("Changed in this snapshot (1)");
  });
});

describe("describeChanges", () => {
  const base = {
    files: [],
    added: 0,
    modified: 0,
    removed: 0,
    bytes: 0,
    linesAdded: 0,
    linesRemoved: 0,
    linesUnknown: 0,
    initial: false,
  };

  it("distinguishes 'nothing changed' from 'we cannot tell'", () => {
    expect(describeChanges({ ...base })).toBe("no file changes");
    expect(describeChanges({ unknown: "unreadable" })).toMatch(/unknown/);
  });

  it("falls back to bytes when no changed file carries a line count", () => {
    const out = describeChanges({
      ...base,
      files: [{ path: "a.png", kind: "added", bytes: 2048, lines: null }],
      added: 1,
      bytes: 2048,
      linesUnknown: 1,
    });
    expect(out).toContain("2.0 KB larger");
    expect(out).not.toContain("lines");
  });

  it("counts what it can and says how much it could not", () => {
    const out = describeChanges({
      ...base,
      files: [
        { path: "a.md", kind: "modified", bytes: 5, lines: 4 },
        { path: "b.png", kind: "added", bytes: 90, lines: null },
      ],
      added: 1,
      modified: 1,
      bytes: 95,
      linesAdded: 4,
      linesUnknown: 1,
    });
    expect(out).toContain("+4 -0 lines (1 not counted)");
  });

  it("marks the vault's first snapshot", () => {
    expect(describeChanges({ ...base, files: [], added: 0, initial: true })).toBe("no file changes");
    expect(
      describeChanges({
        ...base,
        files: [{ path: "a.md", kind: "added", bytes: 3, lines: 1 }],
        added: 1,
        linesAdded: 1,
        bytes: 3,
        initial: true,
      })
    ).toContain("first snapshot");
  });
});

describe("the snapshot window", () => {
  const files: Record<string, FileEntry> = {
    "old.md": entry({ mtime: 1_754_000_000_000, h: "1".repeat(64) }),
    "newest.md": entry({ mtime: 1_754_000_900_000, h: "2".repeat(64) }),
    "middle.md": entry({ mtime: 1_754_000_500_000, h: "3".repeat(64) }),
  };

  async function open(over: Partial<HistoryDeps> = {}, calls?: Calls) {
    const d = deps({ snapshotFiles: async () => files, ...over }, calls);
    const modal = new SnapshotModal(new App() as never, d, snapshot());
    modal.open();
    await settle();
    return { modal, d };
  }

  it("ranks files by edit date, newest first, not alphabetically", async () => {
    const { modal } = await open();

    const names = rowsOf(modal)
      .map((r) => r.rendered.name)
      .filter((n) => n.endsWith(".md"));
    expect(names).toEqual(["newest.md", "middle.md", "old.md"]);
    expect(rowsOf(modal).find((r) => r.rendered.name === "newest.md")?.rendered.desc).toContain(
      "edited"
    );
  });

  it("keeps the filter working over the ranked list", async () => {
    const { modal } = await open();
    const filter = rowsOf(modal).find((r) => r.rendered.name === "Filter")!;
    // The render log accumulates across re-renders, so only rows drawn after the keystroke
    // describe the filtered list.
    const before = rowsOf(modal).length;

    filter.texts[0].change("dd");

    const names = rowsOf(modal)
      .slice(before)
      .map((r) => r.rendered.name)
      .filter((n) => n.endsWith(".md"));
    expect(names).toEqual(["middle.md"]);
  });

  it("writes straight away when nothing is at the path", async () => {
    const { modal, d } = await open({
      inspectRestore: async () => ({
        entry: entry(),
        currentHash: null,
        current: "absent",
        unsyncedEdits: false,
        suggestion: "x",
      }),
    });

    await rowsOf(modal).find((r) => r.rendered.name === "newest.md")!.buttons[0].click();
    await settle();

    // Bound to "nothing was there", so a file created in the meantime is not clobbered.
    expect(d.calls.restore).toEqual([
      { path: "newest.md", opts: { expectedHash: null } },
    ]);
    // No question asked: there was nothing there to protect.
    expect(Modal.shown.filter((m) => m instanceof RestoreDestinationModal)).toHaveLength(0);
  });

  it("skips with a notice when the live file is already identical", async () => {
    const { modal, d } = await open({
      inspectRestore: async () => ({
        entry: entry(),
        currentHash: entry().h,
        current: "identical",
        unsyncedEdits: false,
        suggestion: "x",
      }),
    });

    await rowsOf(modal).find((r) => r.rendered.name === "old.md")!.buttons[0].click();
    await settle();

    expect(d.calls.restore).toEqual([]);
    expect(Notice.shown.at(-1)).toContain("already identical");
  });

  it("asks where to put it when the live file differs", async () => {
    const { modal, d } = await open({
      inspectRestore: async () => ({
        entry: entry(),
        currentHash: "f".repeat(64),
        current: "differs",
        unsyncedEdits: true,
        suggestion: "old (restored 2026-08-05).md",
      }),
    });

    await rowsOf(modal).find((r) => r.rendered.name === "old.md")!.buttons[0].click();
    await settle();

    expect(d.calls.restore).toEqual([]);
    const asked = Modal.shown.at(-1)!;
    expect(asked).toBeInstanceOf(RestoreDestinationModal);
    expect(contentOf(asked).texts().join(" ")).toContain("never synced");
  });

  it("warns that a whole-vault restore overwrites unsynced edits", async () => {
    const { modal } = await open();

    rowsOf(modal).find((r) => r.rendered.name.startsWith("Restore the whole vault"))!.buttons[0].click();
    await settle();

    const confirm = contentOf(Modal.shown.at(-1)!).texts().join(" ");
    expect(confirm).toContain("never left this device");
    // The old copy claimed nothing is lost permanently, which was only true for synced files.
    expect(confirm).not.toContain("Nothing is lost permanently");
  });
});

describe("the restore destination window", () => {
  function open(inspection: Partial<RestoreInspection> = {}) {
    const choices: Array<{ destination?: string; overwrite?: boolean }> = [];
    const modal = new RestoreDestinationModal(new App() as never, {
      path: "Note.md",
      inspection: {
        entry: entry(),
        currentHash: "f".repeat(64),
        current: "differs",
        unsyncedEdits: false,
        suggestion: "Note (restored 2026-08-05).md",
        ...inspection,
      },
      onRestore: (c) => {
        choices.push(c);
      },
    });
    modal.open();
    return { modal, choices };
  }

  it("defaults to a copy, with the suggested name filled in", () => {
    const { modal, choices } = open();
    const row = rowsOf(modal).find((r) => r.rendered.name.startsWith("Save the restored copy"))!;
    expect(row.texts[0].getValue()).toBe("Note (restored 2026-08-05).md");

    const buttons = rowsOf(modal).at(-1)!.buttons;
    expect(buttons[0].text).toBe("Save a copy");
    expect(buttons[0].cta).toBe(true);
    buttons[0].click();

    expect(choices).toEqual([{ destination: "Note (restored 2026-08-05).md" }]);
  });

  it("uses an edited destination", () => {
    const { modal, choices } = open();
    rowsOf(modal)
      .find((r) => r.rendered.name.startsWith("Save the restored copy"))!
      .texts[0].change("  archive/Note.md  ");
    rowsOf(modal).at(-1)!.buttons[0].click();

    expect(choices).toEqual([{ destination: "archive/Note.md" }]);
  });

  it("refuses an empty destination instead of writing somewhere unexpected", () => {
    const { modal, choices } = open();
    rowsOf(modal)
      .find((r) => r.rendered.name.startsWith("Save the restored copy"))!
      .texts[0].change("   ");
    rowsOf(modal).at(-1)!.buttons[0].click();

    expect(choices).toEqual([]);
    expect(Notice.shown.at(-1)).toContain("path");
  });

  it("offers the overwrite as a second, explicit choice", () => {
    const { modal, choices } = open();
    const buttons = rowsOf(modal).at(-1)!.buttons;
    expect(buttons[1].text).toBe("Replace current file");
    buttons[1].click();

    // The overwrite names the version the dialog described, so a stale approval cannot be
    // spent on bytes nobody looked at.
    expect(choices).toEqual([{ overwrite: true, expectedHash: "f".repeat(64) }]);
  });

  it("says an unsynced version exists nowhere else", () => {
    expect(contentOf(open({ unsyncedEdits: true }).modal).texts().join(" ")).toContain(
      "exists nowhere else"
    );
  });

  it("never promises a synced version is still recoverable", () => {
    const text = contentOf(open({ unsyncedEdits: false }).modal).texts().join(" ");
    // Matching this device's last synced state does not prove a retained snapshot still holds
    // those bytes: the device may have been offline past the retention window, or the chain
    // rerooted. A false safety claim is what motivates an irreversible overwrite.
    expect(text).toContain("matches what this device last synced");
    expect(text).toContain("may still be permanent");
    expect(text).not.toContain("loses nothing permanently");
    expect(text).not.toContain("already published");
  });

  it("cancels without restoring anything", () => {
    const { modal, choices } = open();
    rowsOf(modal).at(-1)!.buttons[2].click();

    expect(choices).toEqual([]);
    expect(isOpen(modal)).toBe(false);
  });
});

describe("describeRestore", () => {
  it("names where a copy actually landed, since it is not where the user asked", () => {
    expect(describeRestore({ kind: "copied", path: "a (2).md", requested: "a.md" })).toContain(
      "saved as a (2).md"
    );
  });

  it("does not claim to have written anything when nothing was written", () => {
    const out = describeRestore({ kind: "identical", path: "a.md", requested: "a.md" });
    expect(out).toContain("nothing was written");
    expect(out).not.toMatch(/^Restored/);
  });
});
