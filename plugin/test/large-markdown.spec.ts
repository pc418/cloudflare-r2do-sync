import { describe, expect, it } from "vitest";
import {
  LARGE_MARKDOWN_BYTES,
  describeProblems,
  describeRenamed,
  exceedsLargeMarkdown,
  isMarkdownPath,
  makeMaintainable,
  renameLargeMarkdown,
  textTargetPath,
  type RenameFs,
} from "../src/large-markdown";
import type { ScopeRules } from "../src/paths";

// PIN (owner, 2026-09-25, docs/260925-fix-LARGE_MARKDOWN_PLUGIN_WORKER.md): Markdown STRICTLY
// larger than 1,572,864 bytes is renamed to .txt; .md/.markdown in any case; no other format
// is touched; collisions are refused, never overwritten, numbered or deduplicated.

const OVER = LARGE_MARKDOWN_BYTES + 1;

/** Bytes that identify themselves, so a move can be told from a rewrite. */
function bytesOf(size: number, tag: string): Uint8Array {
  const bytes = new Uint8Array(size).fill(0x61);
  bytes.set(new TextEncoder().encode(tag), 0);
  return bytes;
}

interface MemoryFs extends RenameFs {
  files: Map<string, Uint8Array>;
  folders: Set<string>;
  renames: [string, string][];
  /** Replaces a file's reported size, for the unreadable-stat cases. */
  sizeOverride: Map<string, unknown>;
  renameError: Map<string, Error>;
}

/** A case-SENSITIVE filesystem, so a case-fold clash is only visible through the listing. */
function memoryFs(files: Record<string, Uint8Array>, folders: string[] = []): MemoryFs {
  const fs: MemoryFs = {
    files: new Map(Object.entries(files)),
    folders: new Set(folders),
    renames: [],
    sizeOverride: new Map(),
    renameError: new Map(),
    stat: async (path) => {
      if (fs.folders.has(path)) return { type: "folder", size: 0 };
      const bytes = fs.files.get(path);
      if (bytes === undefined) return null;
      return {
        type: "file",
        size: fs.sizeOverride.has(path) ? fs.sizeOverride.get(path) : bytes.byteLength,
      };
    },
    list: async (folder) => {
      const prefix = folder === "" ? "" : `${folder}/`;
      const direct = (p: string) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/");
      return {
        files: [...fs.files.keys()].filter(direct),
        folders: [...fs.folders].filter(direct),
      };
    },
    rename: async (from, to) => {
      const error = fs.renameError.get(from);
      if (error !== undefined) throw error;
      if (fs.files.has(to) || fs.folders.has(to)) throw new Error("Destination file already exists!");
      const bytes = fs.files.get(from);
      if (bytes === undefined) throw new Error(`no such file ${from}`);
      fs.files.delete(from);
      fs.files.set(to, bytes);
      fs.renames.push([from, to]);
    },
  };
  return fs;
}

const RULES: ScopeRules = { excludes: [".trash/**"], onlyPaths: [], syncConfigDir: false };

describe("which paths are Markdown", () => {
  it.each(["a.md", "a.MD", "dir/a.Md", "a.markdown", "a.MarkDown", "a.txt.md", "a b/c d.md"])(
    "treats %s as Markdown",
    (path) => expect(isMarkdownPath(path)).toBe(true)
  );

  it.each(["a.txt", "a.pdf", "a.mdx", "a.md.txt", "amd", "dir/.md", ".markdown", "a.md/b", "a."])(
    "does not treat %s as Markdown",
    (path) => expect(isMarkdownPath(path)).toBe(false)
  );

  it.each([
    ["a.md", "a.txt"],
    ["dir/Note.MD", "dir/Note.txt"],
    ["x.markdown", "x.txt"],
    ["a.md.md", "a.md.txt"],
    ["v1.2 notes.md", "v1.2 notes.txt"],
  ])("renames only the final extension: %s → %s", (from, to) => {
    expect(textTargetPath(from)).toBe(to);
  });

  it("refuses to compute a target for anything else", () => {
    expect(() => textTargetPath("a.txt")).toThrow(/not a Markdown path/);
  });
});

describe("the size threshold", () => {
  it("is 1.5 MiB exactly, and strictly greater", () => {
    expect(LARGE_MARKDOWN_BYTES).toBe(1_572_864);
    expect(exceedsLargeMarkdown(LARGE_MARKDOWN_BYTES)).toBe(false);
    expect(exceedsLargeMarkdown(OVER)).toBe(true);
    expect(exceedsLargeMarkdown(0)).toBe(false);
  });

  it.each([NaN, Infinity, -Infinity, -1, "2000000", undefined, null])(
    "fails loud on an unreadable size (%s) rather than guessing",
    (size) => {
      expect(() => exceedsLargeMarkdown(size)).toThrow(/unreadable/);
    }
  );
});

describe("scope", () => {
  const maintainable = (rules: Partial<ScopeRules> = {}) =>
    makeMaintainable({ ...RULES, ...rules });

  it("accepts an ordinary visible note", () => {
    expect(maintainable()("notes/a.md")).toBe(true);
  });

  it.each([
    [".obsidian/plugins/cloudflare-rdo-sync/big.md", "this plugin's own folder"],
    [".obsidian/snippets/big.md", "a config code folder"],
    [".obsidian/big.md", "the default config folder"],
    [".trash/big.md", "an excluded, hidden folder"],
    ["notes/.hidden/big.md", "a hidden folder"],
    [".big.md", "a hidden file"],
    ["node_modules/pkg/README.md", "a junk folder"],
    ["__MACOSX/big.md", "an archive junk folder"],
  ])("skips %s (%s)", (path) => {
    expect(maintainable()(path)).toBe(false);
  });

  it("skips configuration directories even when configuration sync is on", () => {
    expect(maintainable({ syncConfigDir: true })(".obsidian/big.md")).toBe(false);
    // A renamed config folder need not start with a dot; it is still configuration.
    expect(maintainable({ syncConfigDir: true, configDir: "cfg" })("cfg/big.md")).toBe(false);
    expect(maintainable({ syncConfigDir: true, configDir: "cfg" })(".obsidian/big.md")).toBe(false);
  });

  it("honours excludes and the allow-list", () => {
    expect(maintainable({ excludes: ["archive/**"] })("archive/big.md")).toBe(false);
    expect(maintainable({ onlyPaths: ["notes/**"] })("other/big.md")).toBe(false);
    expect(maintainable({ onlyPaths: ["notes/**"] })("notes/big.md")).toBe(true);
  });
});

describe("renameLargeMarkdown", () => {
  it("renames only oversized Markdown, preserving the bytes exactly", async () => {
    const big = bytesOf(OVER, "big-note-bytes");
    const fs = memoryFs({
      "big.md": big,
      "edge.md": bytesOf(LARGE_MARKDOWN_BYTES, "edge"),
      "small.md": bytesOf(10, "small"),
      "big.pdf": bytesOf(OVER, "pdf"),
      "big.txt.bin": bytesOf(OVER, "bin"),
    });
    const renamed: [string, string][] = [];

    const out = await renameLargeMarkdown(fs.files.keys(), fs, {
      rules: RULES,
      onRenamed: (from, to) => renamed.push([from, to]),
    });

    expect(out.renamed).toEqual([{ from: "big.md", to: "big.txt" }]);
    expect(out.failed).toEqual([]);
    expect(renamed).toEqual([["big.md", "big.txt"]]);
    expect(fs.files.has("big.md")).toBe(false);
    // The same bytes, not merely the same length: a move, not a re-encode.
    expect(fs.files.get("big.txt")).toBe(big);
    expect([...fs.files.keys()].sort()).toEqual(
      ["big.pdf", "big.txt", "big.txt.bin", "edge.md", "small.md"].sort()
    );
  });

  it("handles extension case and .markdown", async () => {
    const fs = memoryFs({
      "A.MD": bytesOf(OVER, "a"),
      "b.Markdown": bytesOf(OVER, "b"),
    });
    const out = await renameLargeMarkdown(fs.files.keys(), fs, { rules: RULES });
    expect(out.renamed.map((r) => r.to).sort()).toEqual(["A.txt", "b.txt"]);
  });

  it("never touches out-of-scope candidates, even oversized ones", async () => {
    const fs = memoryFs({
      ".obsidian/plugins/cloudflare-rdo-sync/big.md": bytesOf(OVER, "self"),
      ".trash/big.md": bytesOf(OVER, "trash"),
      "archive/big.md": bytesOf(OVER, "archive"),
    });
    const out = await renameLargeMarkdown(fs.files.keys(), fs, {
      rules: { ...RULES, excludes: [".trash/**", "archive/**"] },
    });
    expect(out).toEqual({ renamed: [], failed: [], stopped: null, notAttempted: [] });
    expect(fs.renames).toEqual([]);
  });

  it("refuses a rename whose .txt name the sync would not carry", async () => {
    // An exclude on .txt would turn the rename into a silent deletion from the vault's sync.
    const fs = memoryFs({ "big.md": bytesOf(OVER, "x") });
    const out = await renameLargeMarkdown(["big.md"], fs, {
      rules: { ...RULES, excludes: ["**.txt"] },
    });
    expect(out.renamed).toEqual([]);
    expect(out.failed).toEqual([
      { path: "big.md", target: "big.txt", reason: expect.stringMatching(/outside what this device syncs/) },
    ]);
    expect(fs.files.has("big.md")).toBe(true);
  });

  it("fails loud on an unreadable size instead of renaming or skipping silently", async () => {
    const fs = memoryFs({ "big.md": bytesOf(OVER, "x"), "nan.md": bytesOf(OVER, "y") });
    fs.sizeOverride.set("nan.md", NaN);
    const out = await renameLargeMarkdown(fs.files.keys(), fs, { rules: RULES });
    expect(out.renamed).toEqual([{ from: "big.md", to: "big.txt" }]);
    expect(out.failed).toEqual([
      { path: "nan.md", target: "nan.txt", reason: expect.stringMatching(/unreadable/) },
    ]);
    expect(fs.files.has("nan.md")).toBe(true);
  });

  it.each([
    ["an existing file", { "n/big.txt": bytesOf(3, "old") }, [], /already exists there/],
    ["an existing folder", {}, ["n/big.txt"], /already exists there/],
    ["a case-fold twin", { "n/BIG.TXT": bytesOf(3, "old") }, [], /"n\/BIG\.TXT" already exists with different letter case/],
    ["a case-fold folder", {}, ["n/Big.txt"], /different letter case/],
  ])("refuses to rename over %s, and keeps both untouched", async (_label, extra, folders, reason) => {
    const big = bytesOf(OVER, "src");
    const fs = memoryFs({ "n/big.md": big, "n/other.md": bytesOf(OVER, "other"), ...extra }, [
      "n",
      ...folders,
    ]);
    const before = new Map(fs.files);

    const out = await renameLargeMarkdown(fs.files.keys(), fs, { rules: RULES });

    // The refusal is named, and the other file is still converted and reported.
    expect(out.failed).toEqual([{ path: "n/big.md", target: "n/big.txt", reason: expect.stringMatching(reason) }]);
    expect(out.renamed).toEqual([{ from: "n/other.md", to: "n/other.txt" }]);
    expect(fs.files.get("n/big.md")).toBe(big);
    for (const [path, bytes] of before) {
      if (path !== "n/other.md") expect(fs.files.get(path)).toBe(bytes);
    }
    // No numbered copies, no deletions.
    expect([...fs.files.keys()].filter((p) => /\(\d+\)/.test(p))).toEqual([]);
  });

  it("reports a rename the platform refused, and keeps earlier renames", async () => {
    const fs = memoryFs({ "a.md": bytesOf(OVER, "a"), "b.md": bytesOf(OVER, "b"), "c.md": bytesOf(OVER, "c") });
    fs.renameError.set("b.md", new Error("EACCES: permission denied"));
    const out = await renameLargeMarkdown(fs.files.keys(), fs, { rules: RULES });
    expect(out.renamed.map((r) => r.from)).toEqual(["a.md", "c.md"]);
    expect(out.failed).toEqual([{ path: "b.md", target: "b.txt", reason: "EACCES: permission denied" }]);
    // No rollback of the successful ones.
    expect(fs.files.has("a.txt")).toBe(true);
    expect(fs.files.has("c.txt")).toBe(true);
  });

  it("is idempotent: a second sweep finds nothing left to do", async () => {
    const fs = memoryFs({ "a.md": bytesOf(OVER, "a"), "b.md": bytesOf(OVER, "b") });
    const first = await renameLargeMarkdown(fs.files.keys(), fs, { rules: RULES });
    const second = await renameLargeMarkdown(fs.files.keys(), fs, { rules: RULES });
    expect(first.renamed).toHaveLength(2);
    expect(second).toEqual({ renamed: [], failed: [], stopped: null, notAttempted: [] });
  });

  it("skips a candidate that disappeared or became a folder since it was listed", async () => {
    const fs = memoryFs({}, ["gone.md"]);
    const out = await renameLargeMarkdown(["missing.md", "gone.md"], fs, { rules: RULES });
    expect(out).toEqual({ renamed: [], failed: [], stopped: null, notAttempted: [] });
  });

  it("stops between files when asked, and names what it did not reach", async () => {
    const fs = memoryFs({ "a.md": bytesOf(OVER, "a"), "b.md": bytesOf(OVER, "b"), "c.md": bytesOf(OVER, "c") });
    let checks = 0;
    const out = await renameLargeMarkdown(fs.files.keys(), fs, {
      rules: RULES,
      shouldStop: () => (++checks > 1 ? "the vault is being rewritten" : null),
    });
    expect(out.renamed).toEqual([{ from: "a.md", to: "a.txt" }]);
    expect(out.stopped).toBe("the vault is being rewritten");
    expect(out.notAttempted).toEqual(["b.md", "c.md"]);
    expect(fs.files.has("b.md")).toBe(true);
    expect(describeProblems(out)).toBe(
      "stopped with 2 files not checked: the vault is being rewritten"
    );
  });
});

describe("messages", () => {
  it("says how many, and that they are .txt now, naming a few", () => {
    expect(describeRenamed([{ from: "a.md", to: "a.txt" }])).toBe("1 Markdown file to .txt (a.md → a.txt)");
    const many = ["a", "b", "c", "d", "e"].map((n) => ({ from: `${n}.md`, to: `${n}.txt` }));
    expect(describeRenamed(many)).toBe(
      "5 Markdown files to .txt (a.md → a.txt, b.md → b.txt, c.md → c.txt, +2 more)"
    );
  });

  it("names every refusal by path and reason", () => {
    expect(
      describeProblems({
        renamed: [],
        failed: [
          { path: "x.md", target: "x.txt", reason: "a file or folder already exists there" },
          { path: "y.md", target: "y.txt", reason: "denied" },
        ],
        stopped: null,
        notAttempted: [],
      })
    ).toBe("x.md → x.txt: a file or folder already exists there; y.md → y.txt: denied");
  });
});
