import { describe, expect, it, beforeEach } from "vitest";
import { ConflictReportModal } from "../src/main";
import { App, Notice, type FakeElement } from "./obsidian-fake";
import type { ConflictInfo } from "../src/sync";
import type { ConflictChoice } from "../src/conflict-resolve";

const NL = String.fromCharCode(10);

// Vitest aliases "obsidian" to the fake at runtime; tsc still sees the real types. Bridge here.
function contentOf(modal: ConflictReportModal): FakeElement {
  return (modal as unknown as { contentEl: FakeElement }).contentEl;
}

function conflict(over: Partial<ConflictInfo> = {}): ConflictInfo {
  return {
    path: "note.md",
    copy: "note.conflict-phone-260807-1200.md",
    kept: "ours",
    ours: { mtime: 1_754_000_200_000, size: 12 },
    theirs: { mtime: 1_754_000_100_000, size: 30 },
    ...over,
  };
}

interface Harness {
  modal: ConflictReportModal;
  resolved: Array<{ path: string; choice: ConflictChoice }>;
  texts: () => string[];
  el: FakeElement;
}

function open(
  conflicts: ConflictInfo[],
  files: Record<string, string | null> = {
    "note.md": ["a", "mine"].join(NL),
    "note.conflict-phone-260807-1200.md": ["a", "theirs"].join(NL),
  },
  resolveError: string | null = null
): Harness {
  const resolved: Array<{ path: string; choice: ConflictChoice }> = [];
  const modal = new ConflictReportModal(new App() as never, conflicts, {
    readText: async (path) => files[path] ?? null,
    resolve: async (info, choice) => {
      if (resolveError !== null) throw new Error(resolveError);
      resolved.push({ path: info.path, choice });
    },
  });
  modal.open();
  const el = contentOf(modal);
  return { modal, resolved, el, texts: () => el.texts() };
}

/** The diff is drawn from an awaited read, so let those microtasks run. */
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

beforeEach(() => {
  Notice.shown.length = 0;
});

describe("conflict view", () => {
  it("names both sides with their times and sizes", () => {
    const { texts } = open([conflict()]);
    const joined = texts().join(" | ");
    expect(joined).toContain("note.md");
    expect(joined).toContain("This device");
    expect(joined).toContain("Other device");
    expect(joined).toContain("note.conflict-phone-260807-1200.md");
  });

  // Which file holds which version is not obvious, and it is not even constant: an attachment
  // that lost the path to a newer remote copy keeps THIS device's version in the .conflict-…
  // file. A user about to delete one of the two deserves to be told which is which.
  it("says which file holds each version", () => {
    const said = open([conflict()]).texts().join(" | ");
    expect(said).toContain("This device's version is in: note.md");
    expect(said).toContain(
      "The other device's version is in: note.conflict-phone-260807-1200.md"
    );
  });

  it("swaps the two when the other device won the canonical path", () => {
    const said = open([conflict({ kept: "theirs" })]).texts().join(" | ");
    expect(said).toContain("This device's version is in: note.conflict-phone-260807-1200.md");
    expect(said).toContain("The other device's version is in: note.md");
  });

  // The canonical path holds THEIRS here, so a diff drawn by position labels every line with
  // the wrong device — and the buttons beside it offer to delete the wrong file.
  it("draws the difference by side, not by position", async () => {
    const { el } = open([conflict({ kept: "theirs" })]);
    await settle();

    // "note.md" holds theirs in this layout, so its line must be the added one.
    expect(el.byClass("r2do-diff-theirs").map((r) => r.text)).toEqual(["+ mine"]);
    expect(el.byClass("r2do-diff-ours").map((r) => r.text)).toEqual(["- theirs"]);
  });

  it("marks the newer side as LATEST, on whichever side it happens to be", () => {
    const mineNewer = open([conflict()]).texts().find((t) => t.includes("This device"))!;
    expect(mineNewer).toContain("LATEST");

    const theirsNewer = open([
      conflict({ ours: { mtime: 1, size: 1 }, theirs: { mtime: 9, size: 1 } }),
    ])
      .texts()
      .find((t) => t.includes("Other device"))!;
    expect(theirsNewer).toContain("LATEST");
  });

  it("offers the newer side first, as the default button", () => {
    const { el } = open([conflict()]);
    const buttons = el.log.rows.flatMap((r) => r.buttons);
    const labels = buttons.map((b) => b.text);
    expect(labels.slice(0, 4)).toEqual([
      "This device",
      "Other device",
      "Both files",
      "Combine into one",
    ]);
    expect(buttons[0].cta).toBe(true);
    expect(buttons[1].cta).toBe(false);
  });

  it("puts the other device first when it holds the newer edit", () => {
    const { el } = open([conflict({ ours: { mtime: 1, size: 1 }, theirs: { mtime: 9, size: 1 } })]);
    const buttons = el.log.rows.flatMap((r) => r.buttons);
    expect(buttons.map((b) => b.text).slice(0, 2)).toEqual(["Other device", "This device"]);
    expect(buttons[0].cta).toBe(true);
  });

  it("draws the difference between the two versions", async () => {
    const { el } = open([conflict()]);
    await settle();

    const rows = el.byClass("r2do-diff-ours").map((r) => r.text);
    const added = el.byClass("r2do-diff-theirs").map((r) => r.text);
    expect(rows).toEqual(["- mine"]);
    expect(added).toEqual(["+ theirs"]);
    expect(el.byClass("r2do-diff-same").map((r) => r.text)).toContain("  a");
  });

  it("says so plainly when one side is not text instead of showing an empty diff", async () => {
    const { el, texts } = open([conflict()], {
      "note.md": null,
      "note.conflict-phone-260807-1200.md": "theirs",
    });
    await settle();

    expect(el.byClass("r2do-diff-ours")).toEqual([]);
    expect(texts().join(" ")).toContain("not text");
  });

  it.each([
    ["This device", "keep-mine"],
    ["Other device", "keep-theirs"],
    ["Both files", "keep-both"],
    ["Combine into one", "combine"],
  ] as const)("wires %s to the %s choice", async (label, choice) => {
    const h = open([conflict()]);
    const button = h.el.log.rows.flatMap((r) => r.buttons).find((b) => b.text === label)!;

    await button.click();

    expect(h.resolved).toEqual([{ path: "note.md", choice }]);
  });

  it("drops a resolved conflict from the list and reports when none are left", async () => {
    const h = open([conflict()]);
    await h.el.log.rows.flatMap((r) => r.buttons).find((b) => b.text === "Both files")!.click();
    await settle();

    expect(h.texts().join(" ")).toContain("All resolved");
    expect(Notice.shown.join(" ")).toContain("note.md resolved");
  });

  it("keeps the conflict listed when resolving it failed", async () => {
    const h = open([conflict()], undefined, "note.md is gone");
    await h.el.log.rows.flatMap((r) => r.buttons).find((b) => b.text === "This device")!.click();
    await settle();

    expect(Notice.shown.join(" ")).toContain("note.md is gone");
    expect(h.texts().join(" ")).toContain("note.md");
    expect(h.texts().join(" ")).not.toContain("All resolved");
  });

  it("offers nothing for a conflict whose loser an overwrite mode already discarded", async () => {
    const { el, texts } = open([conflict({ copy: null, kept: "theirs" })]);
    await settle();

    expect(el.log.rows.flatMap((r) => r.buttons).map((b) => b.text)).toEqual(["Close"]);
    expect(texts().join(" ")).toContain("nothing left to choose");
    expect(el.byClass("r2do-diff-ours")).toEqual([]);
  });

  // The window's own opening line used to promise "Both versions are on disk", which the row
  // underneath then contradicted for exactly these entries.
  it("does not promise both versions are on disk when one of them is not", () => {
    const said = open([conflict({ snapshotOnly: true })]).texts().join(" ");
    expect(said).not.toContain("Both versions are on disk");
    expect(said).toContain("Where both versions are on this device");
  });

  it("still says both are on disk when every entry has both", () => {
    expect(open([conflict()]).texts().join(" ")).toContain("Both versions");
  });

  // Push-only mode never writes local files, so the other version is in the snapshot and not
  // on this disk. Every button offered for it could only ever produce an error notice.
  it("offers nothing for a version that was published rather than parked here", async () => {
    const { el, texts } = open([conflict({ snapshotOnly: true })]);
    await settle();

    expect(el.log.rows.flatMap((r) => r.buttons).map((b) => b.text)).toEqual(["Close"]);
    expect(texts().join(" ")).toContain("Push-only");
  });

  // Several file operations run per resolution; a second click landing between them resolves
  // an already-resolved pair and reports a failure for work that had actually succeeded.
  it("ignores a second click while the first resolution is still running", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls: ConflictChoice[] = [];
    const modal = new ConflictReportModal(new App() as never, [conflict()], {
      readText: async () => "text",
      resolve: async (_info, choice) => {
        calls.push(choice);
        await gate;
      },
    });
    modal.open();
    const buttons = contentOf(modal).log.rows.flatMap((r) => r.buttons);

    const first = buttons.find((b) => b.text === "This device")!.click() as Promise<void>;
    buttons.find((b) => b.text === "Both files")!.click();
    release();
    await first;
    await settle();

    expect(calls).toEqual(["keep-mine"]);
  });

  it("still lists every conflict when opened without the resolution actions", () => {
    // The report-only path: no actions wired, so it must degrade to a description, not throw.
    const modal = new ConflictReportModal(new App() as never, [conflict()]);
    modal.open();
    const el = contentOf(modal);
    expect(el.texts().join(" ")).toContain("note.md");
    expect(el.log.rows.flatMap((r) => r.buttons).map((b) => b.text)).toEqual(["Close"]);
  });
});
