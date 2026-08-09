import { describe, it, expect } from "vitest";
import {
  conflictPath,
  conflictWinner,
  decodeText,
  isMergeableText,
  mergeText,
  planFile,
} from "../src/merge";
import type { FileEntry } from "../src/types";

const entry = (h: string, mtime = 1_754_000_000_000): FileEntry => ({ h, size: h.length, mtime });

describe("mergeText — clean merges", () => {
  it("returns either side when both made the same edit", () => {
    expect(mergeText("a\n", "b\n", "b\n")).toEqual({ clean: true, text: "b\n" });
  });

  it("takes theirs when we did not touch the file", () => {
    expect(mergeText("a\n", "a\n", "a\nb\n")).toEqual({ clean: true, text: "a\nb\n" });
  });

  it("takes ours when they did not touch the file", () => {
    expect(mergeText("a\n", "a\nb\n", "a\n")).toEqual({ clean: true, text: "a\nb\n" });
  });

  it("merges edits in disjoint regions", () => {
    const base = "one\ntwo\nthree\n";
    const ours = "ONE\ntwo\nthree\n";
    const theirs = "one\ntwo\nTHREE\n";
    expect(mergeText(base, ours, theirs)).toEqual({ clean: true, text: "ONE\ntwo\nTHREE\n" });
  });

  it("merges an append on one side with an edit on the other — the daily-log case", () => {
    const base = "# 2026-08-03\n\n- 09:00 standup\n";
    const ours = "# 2026-08-03\n\n- 09:00 standup\n- 14:00 shipped merge\n";
    const theirs = "# 2026-08-03\n\n- 09:00 standup meeting\n";
    expect(mergeText(base, ours, theirs)).toEqual({
      clean: true,
      text: "# 2026-08-03\n\n- 09:00 standup meeting\n- 14:00 shipped merge\n",
    });
  });

  it("keeps a deletion made on one side only", () => {
    const base = "a\nb\nc\n";
    expect(mergeText(base, "a\nc\n", "a\nb\nc\nd\n")).toEqual({ clean: true, text: "a\nc\nd\n" });
  });

  it("preserves a missing trailing newline exactly", () => {
    expect(mergeText("a\nb", "a\nb", "a\nB")).toEqual({ clean: true, text: "a\nB" });
  });

  it("merges insertions at separate points in a long file", () => {
    const base = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const ours = base.replace("line 10", "line 10\nours insert");
    const theirs = base.replace("line 150", "line 150\ntheirs insert");
    const merged = mergeText(base, ours, theirs);
    expect(merged.clean).toBe(true);
    if (merged.clean) {
      expect(merged.text).toContain("ours insert");
      expect(merged.text).toContain("theirs insert");
      expect(merged.text.split("\n")).toHaveLength(202);
    }
  });
});

describe("mergeText — both sides inserted at the same spot (union)", () => {
  it("keeps both appends to the same log, in text (= date) order", () => {
    const base = "# log\n";
    const ours = "# log\n- 14:00 ours\n";
    const theirs = "# log\n- 09:00 theirs\n";
    expect(mergeText(base, ours, theirs)).toEqual({
      clean: true,
      text: "# log\n- 09:00 theirs\n- 14:00 ours\n",
    });
  });

  it("converges: both devices compute identical bytes from opposite perspectives", () => {
    const base = "# log\n";
    const a = "# log\n- from device A\n";
    const b = "# log\n- from device B\n";
    const fromA = mergeText(base, a, b);
    const fromB = mergeText(base, b, a);
    expect(fromA.clean && fromB.clean).toBe(true);
    if (fromA.clean && fromB.clean) expect(fromA.text).toBe(fromB.text);
  });

  it("keeps both insertions under the same heading mid-file", () => {
    const base = "## todo\n\n## done\n";
    const ours = "## todo\n- task a\n\n## done\n";
    const theirs = "## todo\n- task b\n\n## done\n";
    expect(mergeText(base, ours, theirs)).toEqual({
      clean: true,
      text: "## todo\n- task a\n- task b\n\n## done\n",
    });
  });

  it("unions two independently created files (no base) without repeating shared template lines", () => {
    const ours = "# 2026-08-03\n\n- 09:00 ours\n";
    const theirs = "# 2026-08-03\n\n- 10:00 theirs\n";
    expect(mergeText("", ours, theirs)).toEqual({
      clean: true,
      text: "# 2026-08-03\n\n- 09:00 ours\n- 10:00 theirs\n",
    });
  });

  it("does not duplicate an insertion contained in the other side's", () => {
    const base = "# log\n";
    const short = "# log\n- shared entry\n";
    const long = "# log\n- earlier entry\n- shared entry\n- later entry\n";
    expect(mergeText(base, short, long)).toEqual({ clean: true, text: long });
    expect(mergeText(base, long, short)).toEqual({ clean: true, text: long });
  });
});

describe("mergeText — conflicts", () => {
  it("reports a conflict when both sides changed the same line differently", () => {
    expect(mergeText("a\n", "ours\n", "theirs\n")).toEqual({ clean: false });
  });

  it("reports a conflict when one side edits what the other deleted", () => {
    const base = "a\nb\nc\n";
    expect(mergeText(base, "a\nc\n", "a\nB\nc\n")).toEqual({ clean: false });
  });

  it("reports a conflict when both sides rewrote the same region, even if one also added lines", () => {
    const base = "a\nb\n";
    // Both replaced line b (ours with B, theirs with new+B). Base content was touched on
    // both sides, so this is not a pure-insertion union.
    expect(mergeText(base, "a\nB\n", "a\nnew\nB\n")).toEqual({ clean: false });
  });

  it("never emits conflict markers into the merged text", () => {
    const merged = mergeText("a\n", "ours\n", "theirs\n");
    expect(merged.clean).toBe(false);
    expect(JSON.stringify(merged)).not.toContain("<<<<");
  });

  it("refuses to merge files too large to diff instead of guessing", () => {
    // Edits at both ends defeat prefix/suffix trimming, so the diff would need a
    // 3000x3000 table. Disjoint regions — this would merge cleanly if we allowed it.
    const lines = Array.from({ length: 3000 }, (_, i) => `l${i}`);
    const base = lines.join("\n");
    const ours = [...lines];
    ours[0] = "ours first";
    ours[2999] = "ours last";
    const theirs = [...lines];
    theirs[1500] = "theirs middle";
    expect(mergeText(base, ours.join("\n"), theirs.join("\n"))).toEqual({ clean: false });
  });
});

describe("planFile — the three-way decision table", () => {
  const a = entry("aaa");
  const b = entry("bbb");
  const c = entry("ccc");

  it("does nothing when both sides agree", () => {
    expect(planFile(a, b, b)).toBe("none");
    expect(planFile(a, undefined, undefined)).toBe("none");
    expect(planFile(undefined, undefined, undefined)).toBe("none");
  });

  it("keeps ours when only we changed the file", () => {
    expect(planFile(a, b, a)).toBe("keep-ours");
    expect(planFile(a, undefined, a)).toBe("keep-ours"); // our delete stands
    expect(planFile(undefined, a, undefined)).toBe("keep-ours"); // our new file
  });

  it("takes theirs when only they changed the file", () => {
    expect(planFile(a, a, b)).toBe("take-theirs");
    expect(planFile(undefined, undefined, a)).toBe("take-theirs"); // their new file
  });

  it("deletes locally when they deleted a file we had not touched", () => {
    expect(planFile(a, a, undefined)).toBe("delete-local");
  });

  it("keeps our edit when they deleted the file — content survives", () => {
    expect(planFile(a, b, undefined)).toBe("keep-ours");
  });

  it("restores their edit when we deleted the file — content survives", () => {
    expect(planFile(a, undefined, b)).toBe("take-theirs");
  });

  it("merges when both sides changed the same file differently", () => {
    expect(planFile(a, b, c)).toBe("merge");
    expect(planFile(undefined, b, c)).toBe("merge"); // both added, no base
  });
});

describe("text detection", () => {
  it("treats notes as mergeable and attachments as not", () => {
    expect(isMergeableText("daily/2026-08-03.md")).toBe(true);
    expect(isMergeableText("a.MD")).toBe(true);
    expect(isMergeableText("notes.txt")).toBe(true);
    expect(isMergeableText("img.png")).toBe(false);
    expect(isMergeableText("board.canvas")).toBe(false);
    expect(isMergeableText("nodots")).toBe(false);
  });

  it("decodes utf-8 and refuses binary", () => {
    expect(decodeText(new TextEncoder().encode("héllo\n"))).toBe("héllo\n");
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
    expect(decodeText(new Uint8Array([0x61, 0x00, 0x62]))).toBeNull(); // NUL means binary
  });
});

describe("conflictPath", () => {
  const at = Date.UTC(2026, 7, 3, 14, 20);

  it("keeps the extension so the copy stays openable", () => {
    expect(conflictPath("daily/2026-08-03.md", "phone", at)).toMatch(
      /^daily\/2026-08-03\.conflict-phone-\d{6}-\d{4}\.md$/
    );
    expect(conflictPath("img.png", "phone", at)).toMatch(/^img\.conflict-phone-\d{6}-\d{4}\.png$/);
  });

  it("handles a file with no extension", () => {
    expect(conflictPath("LICENSE", "phone", at)).toMatch(/^LICENSE\.conflict-phone-\d{6}-\d{4}$/);
  });

  it("sanitizes the device name so it cannot escape the folder", () => {
    expect(conflictPath("a.md", "../evil name", at)).toMatch(
      /^a\.conflict----evil-name-\d{6}-\d{4}\.md$/
    );
  });

  it("is stable for the same input and distinct across minutes", () => {
    expect(conflictPath("a.md", "d", at)).toBe(conflictPath("a.md", "d", at));
    expect(conflictPath("a.md", "d", at)).not.toBe(conflictPath("a.md", "d", at + 60_000));
  });

  it("adds a collision sequence before the original extension", () => {
    expect(conflictPath("a.md", "phone", at, 2)).toMatch(
      /^a\.conflict-phone-\d{6}-\d{4}-2\.md$/
    );
  });
});

describe("conflictWinner", () => {
  const entry = (h: string, mtime: number, size: number) => ({ h, size, mtime });

  it("newest: later mtime takes the path, regardless of which side holds it", () => {
    expect(conflictWinner("newest", entry("a", 1000, 5), entry("b", 2000, 5))).toBe("theirs");
    expect(conflictWinner("newest", entry("a", 3000, 5), entry("b", 2000, 5))).toBe("ours");
  });

  it("largest: bigger file wins", () => {
    expect(conflictWinner("largest", entry("a", 1, 10), entry("b", 1, 99))).toBe("theirs");
    expect(conflictWinner("largest", entry("a", 1, 100), entry("b", 1, 99))).toBe("ours");
  });

  it("ties break on content hash, identically on every device", () => {
    const small = entry("aa", 1000, 5);
    const big = entry("bb", 1000, 5);
    // Device A holds `small` locally; device B holds `big`. Both must crown `bb`.
    expect(conflictWinner("newest", small, big)).toBe("theirs");
    expect(conflictWinner("newest", big, small)).toBe("ours");
    expect(conflictWinner("largest", small, big)).toBe("theirs");
    expect(conflictWinner("largest", big, small)).toBe("ours");
  });
});
