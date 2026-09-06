import { describe, expect, it, beforeEach } from "vitest";
import { ConflictReportModal } from "../src/main";
import { App, Modal, Notice, type FakeElement } from "./obsidian-fake";
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

/** One per conflict, so a distinct pair per entry rather than two rows over one file. */
function pair(name: string): ConflictInfo {
  return conflict({ path: `${name}.md`, copy: `${name}.conflict.md` });
}

interface BatchHarness {
  resolved: Array<{ path: string; choice: ConflictChoice }>;
  el: FakeElement;
  texts: () => string[];
}

/**
 * The batch row needs what the single-choice harness does not: which files are on disk (that
 * is what makes a choice blocked), a per-conflict failure, and a resolution that can be held
 * open mid-batch.
 */
function openBatch(
  conflicts: ConflictInfo[],
  opts: {
    present?: ReadonlySet<string>;
    fails?: (info: ConflictInfo) => string | null;
    gate?: Promise<void>;
  } = {}
): BatchHarness {
  const resolved: Array<{ path: string; choice: ConflictChoice }> = [];
  const modal = new ConflictReportModal(
    new App() as never,
    conflicts,
    {
      readText: async () => null,
      resolve: async (info, choice) => {
        if (opts.gate !== undefined) await opts.gate;
        const failure = opts.fails?.(info) ?? null;
        if (failure !== null) throw new Error(failure);
        resolved.push({ path: info.path, choice });
      },
    },
    opts.present ?? new Set()
  );
  modal.open();
  const el = contentOf(modal);
  return { resolved, el, texts: () => el.texts() };
}

function rowNamed(el: FakeElement, name: string) {
  return el.log.rows.filter((r) => r.rendered.name === name);
}

function batchButton(el: FakeElement, text: string) {
  return rowNamed(el, "Resolve all").flatMap((r) => r.buttons).find((b) => b.text === text)!;
}

function bodyOf(modal: Modal): FakeElement {
  return modal.contentEl as unknown as FakeElement;
}

/** The diff is drawn from an awaited read, so let those microtasks run. */
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

beforeEach(() => {
  Notice.shown.length = 0;
  Modal.shown.length = 0;
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

  // A row whose buttons move between entries is a row where a click aimed at one choice lands
  // on another — and the four here delete files.
  it("keeps the buttons in the same position whichever side is newer", () => {
    const fixed = ["This device", "Other device", "Both files", "Combine into one"];
    for (const c of [
      conflict(),
      conflict({ ours: { mtime: 1, size: 1 }, theirs: { mtime: 9, size: 1 } }),
    ]) {
      const { el } = open([c]);
      expect(rowNamed(el, "Keep")[0].buttons.map((b) => b.text)).toEqual(fixed);
    }
  });

  it("highlights the newer side in place", () => {
    const mine = rowNamed(open([conflict()]).el, "Keep")[0].buttons;
    expect(mine[0].classes).toContain("r2do-newer");
    expect(mine[1].classes).not.toContain("r2do-newer");

    const theirs = rowNamed(
      open([conflict({ ours: { mtime: 1, size: 1 }, theirs: { mtime: 9, size: 1 } })]).el,
      "Keep"
    )[0].buttons;
    expect(theirs[1].classes).toContain("r2do-newer");
    expect(theirs[0].classes).not.toContain("r2do-newer");
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

  it("offers batch resolution only when there is more than one conflict", () => {
    expect(rowNamed(openBatch([pair("a")]).el, "Resolve all")).toEqual([]);

    const many = openBatch([pair("a"), pair("b")]).el;
    expect(rowNamed(many, "Resolve all")[0].buttons.map((b) => b.text)).toEqual([
      "All this device",
      "All other device",
      "All keep both",
    ]);
  });

  // Deleting one side of every conflict at once is exactly the press that has to be asked
  // about, and the dialog names the files rather than counting them.
  it("resolves every conflict with this device's version in one click", async () => {
    const h = openBatch([pair("a"), pair("b")]);
    await batchButton(h.el, "All this device").click();

    const asked = bodyOf(Modal.shown.at(-1)!);
    expect(asked.texts().join(" ")).toContain("a.md");
    expect(asked.texts().join(" ")).toContain("b.md");
    expect(h.resolved).toEqual([]);

    const buttons = asked.log.rows.at(-1)!.buttons;
    expect(buttons.map((b) => b.text)).toEqual(["Resolve all", "Cancel"]);
    await buttons[0].click();
    await settle();

    expect(h.resolved).toEqual([
      { path: "a.md", choice: "keep-mine" },
      { path: "b.md", choice: "keep-mine" },
    ]);
    expect(h.texts().join(" ")).toContain("All resolved");
  });

  it("skips conflicts a batch choice cannot resolve and says so", async () => {
    // "b.md" is gone, which is the side "keep this device" needs for that pair.
    const h = openBatch([pair("a"), pair("b")], {
      present: new Set(["a.md", "a.conflict.md", "b.conflict.md"]),
    });
    await batchButton(h.el, "All this device").click();
    await bodyOf(Modal.shown.at(-1)!).log.rows.at(-1)!.buttons[0].click();
    await settle();

    expect(h.resolved).toEqual([{ path: "a.md", choice: "keep-mine" }]);
    expect(Notice.shown.join(" ")).toContain("1 skipped");
    expect(h.texts().join(" ")).toContain("b.md");
  });

  // One gone file must not be the reason the rest of the list stays outstanding.
  it("keeps a conflict listed when its batch resolution fails and continues with the rest", async () => {
    const h = openBatch([pair("a"), pair("b")], {
      fails: (info) => (info.path === "a.md" ? "a.md is gone" : null),
    });
    await batchButton(h.el, "All keep both").click();
    await settle();

    expect(h.resolved).toEqual([{ path: "b.md", choice: "keep-both" }]);
    const said = h.texts().join(" ");
    expect(said).toContain("a.md");
    expect(said).not.toContain("b.md");
    expect(Notice.shown.join(" ")).toContain("1 failed");
    expect(Notice.shown.join(" ")).toContain("a.md is gone");
  });

  it("ignores clicks while a batch is running", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = openBatch([pair("a"), pair("b")], { gate });

    const running = batchButton(h.el, "All keep both").click() as Promise<void>;
    const asked = Modal.shown.length;
    await batchButton(h.el, "All this device").click();
    // Not even the confirmation: a second batch queued behind the first would resolve pairs
    // the first one has already taken off the list.
    expect(Modal.shown.length).toBe(asked);

    release();
    await running;
    await settle();
    expect(h.resolved.map((r) => r.choice)).toEqual(["keep-both", "keep-both"]);
  });

  // Keeping both writes nothing away, so there is nothing to confirm.
  it("asks nothing before keeping both everywhere, and clears the list", async () => {
    const h = openBatch([pair("a"), pair("b")]);
    const before = Modal.shown.length;
    await batchButton(h.el, "All keep both").click();
    await settle();

    expect(Modal.shown.length).toBe(before);
    expect(h.resolved.map((r) => r.path)).toEqual(["a.md", "b.md"]);
    expect(h.texts().join(" ")).toContain("All resolved");
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
