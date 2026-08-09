import { describe, it, expect } from "vitest";
import { diffLines, ELISION } from "../src/merge";
import {
  combineText,
  conflictDiff,
  isResolvable,
  latestSide,
  planResolution,
  planResolutionOnDisk,
} from "../src/conflict-resolve";
import type { ConflictInfo } from "../src/sync";

const NL = String.fromCharCode(10);
const lines = (...l: string[]) => l.join(NL);

function info(over: Partial<ConflictInfo> = {}): ConflictInfo {
  return {
    path: "note.md",
    copy: "note.conflict-phone-260807-1200.md",
    kept: "ours",
    ours: { mtime: 2000, size: 10 },
    theirs: { mtime: 1000, size: 20 },
    ...over,
  };
}

describe("diffLines", () => {
  it("marks each side of a changed line and keeps the surrounding context once", () => {
    const out = diffLines(lines("a", "mine", "c"), lines("a", "theirs", "c"))!;
    expect(out.rows).toEqual([
      { kind: "same", text: "a" },
      { kind: "ours", text: "mine" },
      { kind: "theirs", text: "theirs" },
      { kind: "same", text: "c" },
    ]);
    expect(out.truncated).toBe(0);
  });

  it("reports an addition with no removed counterpart", () => {
    const out = diffLines(lines("a", "b"), lines("a", "new", "b"))!;
    expect(out.rows.filter((r) => r.kind === "theirs")).toEqual([{ kind: "theirs", text: "new" }]);
    expect(out.rows.filter((r) => r.kind === "ours")).toEqual([]);
  });

  it("shows nothing but context when the two versions are identical", () => {
    const out = diffLines(lines("a", "b"), lines("a", "b"))!;
    expect(out.rows.every((r) => r.kind === "same")).toBe(true);
  });

  it("elides a long identical stretch between two changes instead of dropping it silently", () => {
    const middle = Array.from({ length: 40 }, (_, i) => `m${i}`);
    const out = diffLines(
      lines("mine1", ...middle, "mine2"),
      lines("theirs1", ...middle, "theirs2")
    )!;
    expect(out.rows.some((r) => r.text === ELISION)).toBe(true);
    // The unchanged middle is not reproduced in full.
    expect(out.rows.filter((r) => r.kind === "same").length).toBeLessThan(middle.length);
  });

  it("truncates a huge diff and says how much it dropped", () => {
    const mine = Array.from({ length: 500 }, (_, i) => `a${i}`);
    const theirs = Array.from({ length: 500 }, (_, i) => `b${i}`);
    const out = diffLines(lines(...mine), lines(...theirs), { maxRows: 50 })!;
    expect(out.rows).toHaveLength(50);
    expect(out.truncated).toBeGreaterThan(0);
  });

  it("refuses a pair too large to diff rather than approximating one", () => {
    // The merge refuses the same pair; a guessed diff beside a "keep this side" button is a lie.
    const huge = (tag: string) => Array.from({ length: 2500 }, (_, i) => `${tag}${i}`).join(NL);
    expect(diffLines(huge("a"), huge("b"))).toBeNull();
    expect(conflictDiff(huge("a"), huge("b"))).toBeNull();
  });
});

describe("latestSide", () => {
  it("picks the newer edit", () => {
    expect(latestSide(info({ ours: { mtime: 5, size: 1 }, theirs: { mtime: 4, size: 1 } }))).toBe(
      "mine"
    );
    expect(latestSide(info({ ours: { mtime: 4, size: 1 }, theirs: { mtime: 5, size: 1 } }))).toBe(
      "theirs"
    );
  });

  it("breaks a tie towards the remote, the version this device has not seen", () => {
    expect(latestSide(info({ ours: { mtime: 7, size: 1 }, theirs: { mtime: 7, size: 2 } }))).toBe(
      "theirs"
    );
  });
});

describe("isResolvable", () => {
  it("is false once an overwrite mode discarded the loser", () => {
    expect(isResolvable(info())).toBe(true);
    expect(isResolvable(info({ copy: null }))).toBe(false);
  });
});

describe("planResolution", () => {
  const texts = { mine: lines("a", "mine"), theirs: lines("a", "theirs") };

  it("keeping mine deletes the parked copy and writes nothing", () => {
    expect(planResolution(info(), texts, "keep-mine")).toEqual({
      writes: [],
      removes: ["note.conflict-phone-260807-1200.md"],
    });
  });

  it("keeping theirs puts their text at the canonical path and deletes the copy", () => {
    expect(planResolution(info(), texts, "keep-theirs")).toEqual({
      writes: [{ path: "note.md", text: texts.theirs }],
      removes: ["note.conflict-phone-260807-1200.md"],
    });
  });

  it("keeping both is a no-op, which is what the pass already did", () => {
    expect(planResolution(info(), texts, "keep-both")).toEqual({ writes: [], removes: [] });
  });

  it("combining writes one marked file and deletes the copy", () => {
    const ops = planResolution(info(), texts, "combine");
    expect(ops.removes).toEqual(["note.conflict-phone-260807-1200.md"]);
    expect(ops.writes).toHaveLength(1);
    expect(ops.writes[0].path).toBe("note.md");
    expect(ops.writes[0].text).toContain("<<<<<<<");
  });

  it("refuses every choice when there is no second version left", () => {
    for (const choice of ["keep-mine", "keep-theirs", "combine"] as const) {
      expect(() => planResolution(info({ copy: null }), texts, choice)).toThrow(
        /no second version/
      );
    }
  });

  it("refuses to take a side it cannot read as text, instead of writing nothing", () => {
    expect(() => planResolution(info(), { mine: texts.mine, theirs: null }, "keep-theirs")).toThrow(
      /not text/
    );
  });

  it("refuses to combine a binary pair and names the alternatives", () => {
    expect(() => planResolution(info(), { mine: null, theirs: null }, "combine")).toThrow(
      /Keep one side, or keep both/
    );
  });
});

describe("combineText", () => {
  it("keeps agreed lines once and wraps only the disagreement", () => {
    const out = combineText(info(), lines("same1", "mine", "same2"), lines("same1", "theirs", "same2"))!;
    expect(out.split(NL)).toEqual([
      "same1",
      "<<<<<<< this device (newer)",
      "mine",
      "=======",
      "theirs",
      ">>>>>>> other device",
      "same2",
    ]);
  });

  it("labels whichever side is newer, so the highlighted default is visible in the file too", () => {
    const out = combineText(
      info({ ours: { mtime: 1, size: 1 }, theirs: { mtime: 9, size: 1 } }),
      lines("mine"),
      lines("theirs")
    )!;
    expect(out).toContain(">>>>>>> other device (newer)");
    expect(out).toContain("<<<<<<< this device" + NL);
  });

  it("never elides: every identical line survives in the combined file", () => {
    const middle = Array.from({ length: 40 }, (_, i) => `m${i}`);
    const out = combineText(info(), lines("mine", ...middle), lines("theirs", ...middle))!;
    expect(out).not.toContain(ELISION);
    for (const line of middle) expect(out.split(NL)).toContain(line);
  });

  it("wraps two separate disagreements separately rather than as one block", () => {
    const out = combineText(
      info(),
      lines("mine1", "shared", "mine2"),
      lines("theirs1", "shared", "theirs2")
    )!;
    expect(out.split(NL).filter((l) => l.startsWith("<<<<<<<"))).toHaveLength(2);
    expect(out.split(NL).filter((l) => l === "shared")).toHaveLength(1);
  });

  it("returns null for a pair too large to diff", () => {
    const huge = (tag: string) => Array.from({ length: 2500 }, (_, i) => `${tag}${i}`).join(NL);
    expect(combineText(info(), huge("a"), huge("b"))).toBeNull();
  });
});

describe("planResolutionOnDisk", () => {
  const texts = { mine: lines("a", "mine"), theirs: lines("a", "theirs") };
  const both = new Set(["note.md", "note.conflict-phone-260807-1200.md"]);

  it("plans normally when both sides are still where the pass left them", () => {
    const ops = planResolutionOnDisk(info(), "keep-theirs", { present: both, ...texts });
    expect(ops).toEqual({
      writes: [{ path: "note.md", text: texts.theirs }],
      removes: ["note.conflict-phone-260807-1200.md"],
    });
  });

  it("stops when the copy is gone, because it was already dealt with", () => {
    // Resolved by hand, renamed, or deleted. Re-applying a stale decision would undo that.
    expect(() =>
      planResolutionOnDisk(info(), "keep-mine", { present: new Set(["note.md"]), ...texts })
    ).toThrow(/is gone - it was already resolved/);
  });

  it("stops when the canonical file is gone rather than resurrecting it silently", () => {
    expect(() =>
      planResolutionOnDisk(info(), "keep-theirs", {
        present: new Set(["note.conflict-phone-260807-1200.md"]),
        mine: null,
        theirs: texts.theirs,
      })
    ).toThrow(/note\.md is gone/);
  });

  it("still allows keep-both when only the copy remains: it asks for no writes at all", () => {
    const ops = planResolutionOnDisk(info(), "keep-both", {
      present: new Set(["note.conflict-phone-260807-1200.md"]),
      mine: null,
      theirs: texts.theirs,
    });
    expect(ops).toEqual({ writes: [], removes: [] });
  });

  it("refuses a conflict an overwrite mode already settled", () => {
    expect(() =>
      planResolutionOnDisk(info({ copy: null }), "keep-mine", { present: both, ...texts })
    ).toThrow(/no second version/);
  });
});
