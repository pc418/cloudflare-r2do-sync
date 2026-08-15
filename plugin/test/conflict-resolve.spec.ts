import { describe, it, expect } from "vitest";
import { diffLines, ELISION } from "../src/merge";
import {
  CONFLICT_CHOICES,
  choiceBlockedReason,
  combineText,
  conflictDiff,
  conflictSides,
  isResolvable,
  latestSide,
  missingSides,
  planResolution,
  planResolutionOnDisk,
  pruneResolved,
  unresolvableReason,
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

  // Push-only mode never writes to the vault, so its "parked" version is a manifest entry and
  // nothing else. Offering to keep it pointed every button at a file that is not there.
  it("is false for a version that was only ever published, never written here", () => {
    expect(isResolvable(info({ snapshotOnly: true }))).toBe(false);
    expect(unresolvableReason(info({ snapshotOnly: true }))).toContain("Push-only");
  });

  it("says nothing is wrong with a resolvable pair", () => {
    expect(unresolvableReason(info())).toBeNull();
  });
});

describe("conflictSides", () => {
  it("puts ours at the note and theirs in the copy, the ordinary layout", () => {
    expect(conflictSides(info())).toEqual({
      mine: "note.md",
      theirs: "note.conflict-phone-260807-1200.md",
    });
  });

  // An attachment that lost the path to a newer remote version is the exact mirror: THEIRS
  // holds the note's own name and OURS was parked beside it. Reading that layout backwards
  // made "keep this device" delete this device's only copy.
  it("mirrors the layout when theirs won the canonical path", () => {
    expect(conflictSides(info({ kept: "theirs" }))).toEqual({
      mine: "note.conflict-phone-260807-1200.md",
      theirs: "note.md",
    });
  });
});

describe("pruneResolved", () => {
  const copy = "note.conflict-phone-260807-1200.md";

  it("reports which side of the pair has left the vault", () => {
    const pair = info();
    // Both there.
    expect(missingSides(pair, new Set([pair.path, pair.copy!]))).toEqual([]);
    // The note deleted after the conflict was recorded — the case the review window used to
    // offer four buttons for, three of which could only fail.
    expect(missingSides(pair, new Set([pair.copy!]))).toEqual([pair.path]);
    expect(missingSides(pair, new Set([pair.path]))).toEqual([pair.copy!]);
  });

  it("blocks only the choices that need a file that is gone", () => {
    const pair = info();
    const onlyCopy = new Set([pair.copy!]);

    // Promoting the parked copy onto a deleted note is a restore, not a hazard.
    expect(choiceBlockedReason(pair, "keep-theirs", onlyCopy)).toBeNull();
    // Everything that needs the note itself says so, by name.
    for (const choice of ["keep-mine", "keep-both", "combine"] as const) {
      expect(choiceBlockedReason(pair, choice, onlyCopy)).toBe(`${pair.path} is no longer in the vault.`);
    }

    // With both present nothing is blocked...
    for (const choice of CONFLICT_CHOICES) {
      expect(choiceBlockedReason(pair, choice, new Set([pair.path, pair.copy!]))).toBeNull();
    }
    // ...and a pair with no copy at all is blocked for the older, different reason.
    expect(choiceBlockedReason(info({ copy: null }), "keep-mine", new Set())).toMatch(
      /nothing left to choose/
    );
  });

  it("keeps a pair whose copy is still on disk", () => {
    expect(pruneResolved([info()], new Set(["note.md", copy]))).toEqual([info()]);
  });

  // The outstanding list survives restarts, so it long outlives the files it names: resolved
  // on another device and the deletion pulled here, renamed, deleted by hand. Every one of
  // those used to leave a row whose every button failed with "it was already resolved".
  it("drops a pair whose copy has since left the vault", () => {
    expect(pruneResolved([info()], new Set(["note.md"]))).toEqual([]);
  });

  it("keeps a record that never had a copy to lose", () => {
    const overwritten = info({ copy: null });
    const published = info({ snapshotOnly: true });
    expect(pruneResolved([overwritten, published], new Set())).toEqual([overwritten, published]);
  });
});

describe("planResolution", () => {
  const texts = { mine: lines("a", "mine"), theirs: lines("a", "theirs") };

  it("keeping mine deletes the parked copy and touches nothing else", () => {
    expect(planResolution(info(), texts, "keep-mine")).toEqual({
      promotes: [],
      writes: [],
      removes: ["note.conflict-phone-260807-1200.md"],
    });
  });

  // A move, not a re-write of the text it happens to hold: that is what makes the same button
  // work on a PNG, which is exactly the kind of file that could not be merged in the first
  // place. "Keep the other version" of an attachment used to fail with "is not text".
  it("keeping theirs promotes the parked copy onto the path and deletes it", () => {
    expect(planResolution(info(), texts, "keep-theirs")).toEqual({
      promotes: [{ from: "note.conflict-phone-260807-1200.md", to: "note.md" }],
      writes: [],
      removes: ["note.conflict-phone-260807-1200.md"],
    });
  });

  it("plans a side by content, not by position, when theirs holds the canonical path", () => {
    const attachment = info({ kept: "theirs" });
    // Theirs already sits at the path, so keeping it only drops the copy...
    expect(planResolution(attachment, texts, "keep-theirs")).toEqual({
      promotes: [],
      writes: [],
      removes: ["note.conflict-phone-260807-1200.md"],
    });
    // ...and keeping ours restores it from the copy it was parked in.
    expect(planResolution(attachment, texts, "keep-mine")).toEqual({
      promotes: [{ from: "note.conflict-phone-260807-1200.md", to: "note.md" }],
      writes: [],
      removes: ["note.conflict-phone-260807-1200.md"],
    });
  });

  it("takes either side of a binary pair, which has no text to read", () => {
    const binary = { mine: null, theirs: null };
    expect(planResolution(info(), binary, "keep-theirs").promotes).toEqual([
      { from: "note.conflict-phone-260807-1200.md", to: "note.md" },
    ]);
    expect(planResolution(info(), binary, "keep-mine").removes).toEqual([
      "note.conflict-phone-260807-1200.md",
    ]);
  });

  it("keeping both is a no-op, which is what the pass already did", () => {
    expect(planResolution(info(), texts, "keep-both")).toEqual({
      promotes: [],
      writes: [],
      removes: [],
    });
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
        /nothing left to choose/
      );
    }
  });

  it("refuses every choice for a version that was published but never written here", () => {
    for (const choice of ["keep-mine", "keep-theirs", "combine"] as const) {
      expect(() => planResolution(info({ snapshotOnly: true }), texts, choice)).toThrow(
        /Push-only/
      );
    }
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
      promotes: [{ from: "note.conflict-phone-260807-1200.md", to: "note.md" }],
      writes: [],
      removes: ["note.conflict-phone-260807-1200.md"],
    });
  });

  it("stops when the copy is gone, because it was already dealt with", () => {
    // Resolved by hand, renamed, or deleted. Re-applying a stale decision would undo that.
    expect(() =>
      planResolutionOnDisk(info(), "keep-mine", { present: new Set(["note.md"]), ...texts })
    ).toThrow(/is gone - it was already resolved/);
  });

  it("stops when the side being kept is gone rather than resurrecting it silently", () => {
    expect(() =>
      planResolutionOnDisk(info(), "keep-mine", {
        present: new Set(["note.conflict-phone-260807-1200.md"]),
        mine: null,
        theirs: texts.theirs,
      })
    ).toThrow(/note\.md is gone/);
  });

  // Only the files a choice actually reads have to be there. Promoting the parked copy onto a
  // note that has since been deleted restores it, which is the point of the button.
  it("still promotes the copy when the note it lost to has been deleted", () => {
    const ops = planResolutionOnDisk(info(), "keep-theirs", {
      present: new Set(["note.conflict-phone-260807-1200.md"]),
      mine: null,
      theirs: texts.theirs,
    });
    expect(ops.promotes).toEqual([
      { from: "note.conflict-phone-260807-1200.md", to: "note.md" },
    ]);
  });

  it("refuses to combine when one side is missing, because it must read both", () => {
    expect(() =>
      planResolutionOnDisk(info(), "combine", {
        present: new Set(["note.conflict-phone-260807-1200.md"]),
        mine: null,
        theirs: texts.theirs,
      })
    ).toThrow(/note\.md is gone/);
  });

  // Doing nothing is only "keeping both" when there are both. Reporting success here dropped
  // the conflict from the outstanding list while one of the two versions was already gone.
  it("refuses keep-both when only one side is left, rather than reporting success", () => {
    expect(() =>
      planResolutionOnDisk(info(), "keep-both", {
        present: new Set(["note.conflict-phone-260807-1200.md"]),
        mine: null,
        theirs: texts.theirs,
      })
    ).toThrow(/note\.md is gone/);
  });

  it("asks for no operations at all when both sides really are there", () => {
    expect(planResolutionOnDisk(info(), "keep-both", { present: both, ...texts })).toEqual({
      promotes: [],
      writes: [],
      removes: [],
    });
  });

  it("refuses a conflict an overwrite mode already settled", () => {
    expect(() =>
      planResolutionOnDisk(info({ copy: null }), "keep-mine", { present: both, ...texts })
    ).toThrow(/nothing left to choose/);
  });

  it("refuses a conflict whose copy exists only in the snapshot", () => {
    expect(() =>
      planResolutionOnDisk(info({ snapshotOnly: true }), "keep-mine", { present: both, ...texts })
    ).toThrow(/Push-only/);
  });
});
