import { describe, it, expect } from "vitest";
import { carryLineCounts, countLines, lineDelta } from "../src/lines";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("countLines", () => {
  it("counts a file with and without a trailing newline the same", () => {
    expect(countLines(bytes("a\nb\nc"))).toBe(3);
    expect(countLines(bytes("a\nb\nc\n"))).toBe(3);
  });

  it("treats an empty file as zero lines, not one", () => {
    expect(countLines(bytes(""))).toBe(0);
  });

  it("counts a single line without any newline", () => {
    expect(countLines(bytes("just one"))).toBe(1);
  });

  it("counts blank lines, which are still lines a user typed", () => {
    expect(countLines(bytes("a\n\n\nb"))).toBe(4);
  });

  it("returns null for binary content rather than a meaningless number", () => {
    expect(countLines(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toBeNull();
  });

  it("still counts a text file whose only NUL is past the sniff window", () => {
    // Sniffing a prefix is a heuristic on purpose: reading 90MB to look for one NUL would
    // cost more than the count is worth.
    const tail = new Uint8Array(9000);
    tail.fill(0x61);
    tail[8_999] = 0;
    expect(countLines(tail)).toBe(1);
  });

  it("handles multi-byte characters without miscounting lines", () => {
    expect(countLines(bytes("\u65e5\u8a18\n\u4eca\u65e5\n"))).toBe(2);
  });
});

describe("lineDelta", () => {
  it("reports the net change for an edited file", () => {
    expect(lineDelta("a.md", { "a.md": 10 }, { "a.md": 45 })).toBe(35);
    expect(lineDelta("a.md", { "a.md": 45 }, { "a.md": 10 })).toBe(-35);
  });

  it("reports zero when an edit replaced as many lines as it removed", () => {
    // The honest limit of a cached count: the file count is what shows this pass did work.
    expect(lineDelta("a.md", { "a.md": 10 }, { "a.md": 10 })).toBe(0);
  });

  it("attributes every line of a new file, and every line of a deleted one", () => {
    expect(lineDelta("new.md", {}, { "new.md": 12 })).toBe(12);
    expect(lineDelta("gone.md", { "gone.md": 7 }, {})).toBe(-7);
  });

  it("returns null when neither side knows the path, so it is never reported as zero", () => {
    expect(lineDelta("bin.png", {}, {})).toBeNull();
    expect(lineDelta("bin.png", undefined, undefined)).toBeNull();
  });
});

describe("carryLineCounts", () => {
  const files = { "a.md": 1, "carried.md": 1, "bin.png": 1 };

  it("prefers a fresh count and keeps a cached one for a path not scanned this pass", () => {
    const out = carryLineCounts(files, { "a.md": 1, "carried.md": 40 }, { "a.md": 9 });
    expect(out).toEqual({ "a.md": 9, "carried.md": 40 });
  });

  it("drops paths that left the snapshot, so the cache cannot grow forever", () => {
    const out = carryLineCounts({ "a.md": 1 }, { "a.md": 3, "deleted.md": 99 }, {});
    expect(out).toEqual({ "a.md": 3 });
  });

  it("omits a binary path instead of storing zero for it", () => {
    expect("bin.png" in carryLineCounts(files, {}, { "a.md": 2 })).toBe(false);
  });

  it("does not inherit Object.prototype, since __proto__ is a legal vault path", () => {
    expect(Object.getPrototypeOf(carryLineCounts({}, {}, {}))).toBeNull();
  });
});
