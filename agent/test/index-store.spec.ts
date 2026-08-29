import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { FileEntry } from "../../plugin/src/types";
import { SearchIndex, INDEX_CHUNK, type BlobReader } from "../src/index-store";
import type { AgentState } from "../src/agent-state";

/** Runs `body` against a real Durable Object's SQLite, which is the point of these tests. */
async function withIndex<T>(body: (index: SearchIndex, sql: SqlStorage) => Promise<T> | T): Promise<T> {
  const id = `idx-${Math.random().toString(36).slice(2)}`;
  return runInDurableObject(env.AGENT.getByName(id), (instance: AgentState, state) => {
    const index = new SearchIndex(state.storage.sql);
    return body(index, state.storage.sql);
  });
}

const entry = (hash: string, opts: { size?: number; mtime?: number } = {}): FileEntry => ({
  h: hash,
  size: opts.size ?? 100,
  mtime: opts.mtime ?? 1_754_000_000_000,
  lines: 3,
});

/** Serves note text by hash, and counts what was actually fetched. */
function reader(contents: Record<string, string>): BlobReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    read: async (e: FileEntry) => {
      reads.push(e.h);
      const text = contents[e.h];
      if (text === undefined) throw new Error(`no blob ${e.h}`);
      return new TextEncoder().encode(text);
    },
  };
}

describe("search index", () => {
  it("builds from a snapshot and answers a query with no further reads", async () => {
    await withIndex(async (index) => {
      const files = { "a.md": entry("h1"), "Projects/b.md": entry("h2") };
      const blobs = reader({ h1: "alpha\nbeta gamma\n", h2: "# Project\n\ngamma delta\n" });

      expect(await index.catchUp(blobs, "HEAD1", files)).toBe(true);
      expect(index.isCurrent("HEAD1")).toBe(true);
      expect(blobs.reads.length).toBe(2);

      const result = index.query("gamma", { maxResults: 10 });
      expect(result.hits.map((h) => `${h.path}:${h.line}`).sort()).toEqual(["Projects/b.md:3", "a.md:2"]);
      // Answering came out of SQLite; nothing else was fetched.
      expect(blobs.reads.length).toBe(2);
    });
  });

  it("re-reads only what changed when the head moves", async () => {
    await withIndex(async (index) => {
      const blobs = reader({ h1: "one\n", h2: "two\n", h2b: "two, revised\n" });
      await index.catchUp(blobs, "HEAD1", { "a.md": entry("h1"), "b.md": entry("h2") });
      blobs.reads.length = 0;

      // Only b.md changed.
      expect(await index.catchUp(blobs, "HEAD2", { "a.md": entry("h1"), "b.md": entry("h2b") })).toBe(true);
      expect(blobs.reads).toEqual(["h2b"]);
      expect(index.query("revised", { maxResults: 10 }).hits[0].path).toBe("b.md");
      expect(index.query("two\n", { maxResults: 10 }).hits.length).toBe(0);
    });
  });

  it("drops a note that left the vault, so it stops answering searches", async () => {
    await withIndex(async (index) => {
      const blobs = reader({ h1: "keep me\n", h2: "delete me\n" });
      await index.catchUp(blobs, "HEAD1", { "a.md": entry("h1"), "gone.md": entry("h2") });
      expect(index.query("delete me", { maxResults: 10 }).hits.length).toBe(1);

      await index.catchUp(blobs, "HEAD2", { "a.md": entry("h1") });
      expect(index.query("delete me", { maxResults: 10 }).hits.length).toBe(0);
      expect(index.status().rows).toBe(1);
    });
  });

  // A first build over a real vault is hundreds of fetches. Doing it in one request is how a
  // Worker dies; the honest alternative is to converge and to never claim to be current early.
  it("bounds work per call and refuses to claim currency until it is complete", async () => {
    await withIndex(async (index) => {
      const files: Record<string, FileEntry> = {};
      const contents: Record<string, string> = {};
      for (let i = 0; i < INDEX_CHUNK + 5; i++) {
        files[`n${i}.md`] = entry(`h${i}`, { mtime: 1_754_000_000_000 + i });
        contents[`h${i}`] = `note ${i}\nneedle\n`;
      }
      const blobs = reader(contents);

      expect(await index.catchUp(blobs, "HEAD1", files)).toBe(false);
      expect(blobs.reads.length).toBe(INDEX_CHUNK);
      // Half-built, so it must not answer as though it described the head.
      expect(index.isCurrent("HEAD1")).toBe(false);
      expect(index.status().head).toBeNull();

      expect(await index.catchUp(blobs, "HEAD1", files)).toBe(true);
      expect(index.isCurrent("HEAD1")).toBe(true);
      expect(index.status().rows).toBe(INDEX_CHUNK + 5);
    });
  });

  it("survives an unreadable blob instead of stalling on it forever", async () => {
    await withIndex(async (index) => {
      const blobs = reader({ h1: "fine\n" });
      expect(await index.catchUp(blobs, "HEAD1", { "a.md": entry("h1"), "broken.md": entry("missing") })).toBe(true);
      expect(index.isCurrent("HEAD1")).toBe(true);
      expect(index.query("fine", { maxResults: 10 }).hits.length).toBe(1);
    });
  });

  it("treats a query's wildcards as literal text", async () => {
    await withIndex(async (index) => {
      const blobs = reader({ h1: "100% sure\n", h2: "nothing special\n" });
      await index.catchUp(blobs, "HEAD1", { "a.md": entry("h1"), "b.md": entry("h2") });
      // Unescaped, `%` in a LIKE pattern matches everything and both notes would come back.
      expect(index.query("100%", { maxResults: 10 }).hits.map((h) => h.path)).toEqual(["a.md"]);
      expect(index.query("_", { maxResults: 10 }).hits.length).toBe(0);
    });
  });

  it("filters by folder and glob", async () => {
    await withIndex(async (index) => {
      const blobs = reader({ h1: "shared word\n", h2: "shared word\n" });
      await index.catchUp(blobs, "HEAD1", { "Daily/a.md": entry("h1"), "Projects/b.md": entry("h2") });
      expect(index.query("shared", { folder: "Daily", maxResults: 10 }).hits.map((h) => h.path)).toEqual(["Daily/a.md"]);
      expect(index.query("shared", { glob: /^Projects\/.*$/, maxResults: 10 }).hits.map((h) => h.path)).toEqual([
        "Projects/b.md",
      ]);
    });
  });

  it("skips binary and oversized files, as the scan would", async () => {
    await withIndex(async (index) => {
      const blobs = reader({ h1: "text\n", h2: "binary\n", h3: "huge\n" });
      await index.catchUp(blobs, "HEAD1", {
        "a.md": entry("h1"),
        "image.png": entry("h2"),
        "big.md": entry("h3", { size: 10 * 1024 * 1024 }),
      });
      expect(index.status().rows).toBe(1);
      expect(blobs.reads).toEqual(["h1"]);
    });
  });

  it("is droppable, and rebuilds from the vault afterwards", async () => {
    await withIndex(async (index) => {
      const blobs = reader({ h1: "recoverable\n" });
      const files = { "a.md": entry("h1") };
      await index.catchUp(blobs, "HEAD1", files);
      expect(index.status().rows).toBe(1);

      index.drop();
      expect(index.status()).toMatchObject({ head: null, rows: 0 });
      expect(index.isCurrent("HEAD1")).toBe(false);

      // Nothing was lost: everything it held is still in the vault.
      await index.catchUp(blobs, "HEAD1", files);
      expect(index.query("recoverable", { maxResults: 10 }).hits.length).toBe(1);
    });
  });

  it("reports how many notes it still owes the current snapshot", async () => {
    await withIndex(async (index) => {
      const files = { "a.md": entry("h1"), "b.md": entry("h2") };
      const blobs = reader({ h1: "one\n", h2: "two\n" });
      expect(index.status(files).pending).toBe(2);
      await index.catchUp(blobs, "HEAD1", files);
      expect(index.status(files).pending).toBe(0);
    });
  });
});
