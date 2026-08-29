/**
 * The search index: a plaintext mirror of the vault's text notes in the DO's SQLite.
 *
 * Phase 1's bounded scan fetches and decrypts blobs per question, which caps how much of a
 * real vault a single search can see (60 files / 2 MiB against ~820 blobs). This trades that
 * for one incremental catch-up per head move: diff the path map against what is indexed, fetch
 * only what changed, and answer every later query out of SQLite with no network at all.
 *
 * Two properties it must keep:
 *
 * - **Never load-bearing.** It is a cache of content that already exists in R2. `drop()`
 *   empties it and the next search rebuilds it; until then search falls back to the scan.
 *   Nothing is ever *only* here.
 * - **Bounded per call.** A first build over a large vault is hundreds of blob fetches, which
 *   is not a thing to attempt inside one request. Each catch-up does a chunk and records its
 *   progress, so an interrupted build resumes instead of restarting.
 *
 * It is a second, plaintext-shaped copy of note content on Cloudflare. That is a real cost,
 * and it is only acceptable because custody was already conceded when the master key became a
 * Worker secret — the same reasoning, applied once more, deliberately.
 */
import type { FileEntry } from "../../plugin/src/types";
import { isProbablyText, MAX_FILE_BYTES, type SearchHit, type SearchResult } from "./search";

/** All the index needs from the vault. Narrow on purpose: it reads bytes, nothing more. */
export type BlobReader = { read(entry: FileEntry): Promise<Uint8Array> };

/**
 * Notes read into one catch-up when nothing else is spending. Bounds the work, not the
 * eventual coverage — a large vault converges over a handful of questions.
 *
 * A caller that has already fetched blobs in the same invocation must pass what is left of
 * `BLOB_BUDGET` instead; see `search`, which scans and then catches up in one invocation.
 */
export const INDEX_CHUNK = 25;

export interface IndexStatus {
  /** The head the index fully describes, or null while it is still catching up. */
  head: string | null;
  rows: number;
  /** Notes still to read before the index matches the current head. */
  pending: number;
}

export class SearchIndex {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        content TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS index_meta (k TEXT PRIMARY KEY, v TEXT);
    `);
  }

  #meta(key: string): string | null {
    const row = this.#sql.exec<{ v: string }>("SELECT v FROM index_meta WHERE k = ?", key).toArray()[0];
    return row?.v ?? null;
  }

  #setMeta(key: string, value: string | null): void {
    if (value === null) this.#sql.exec("DELETE FROM index_meta WHERE k = ?", key);
    else this.#sql.exec("INSERT OR REPLACE INTO index_meta (k, v) VALUES (?, ?)", key, value);
  }

  /** Forgets everything. The next search rebuilds; nothing is lost because nothing is only here. */
  drop(): void {
    this.#sql.exec("DELETE FROM notes");
    this.#sql.exec("DELETE FROM index_meta");
  }

  status(files?: Record<string, FileEntry>): IndexStatus {
    const rows = this.#sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM notes").toArray()[0]?.n ?? 0;
    const pending = files === undefined ? 0 : this.#outstanding(files).length;
    return { head: this.#meta("head"), rows, pending };
  }

  /** Paths whose indexed content is missing or stale for this snapshot. */
  #outstanding(files: Record<string, FileEntry>): string[] {
    const indexed = new Map(
      this.#sql.exec<{ path: string; hash: string }>("SELECT path, hash FROM notes").toArray().map((r) => [r.path, r.hash])
    );
    return Object.keys(files)
      .filter((path) => indexable(path, files[path]))
      .filter((path) => indexed.get(path) !== files[path].h)
      .sort((a, b) => files[b].mtime - files[a].mtime || a.localeCompare(b));
  }

  /**
   * Brings the index closer to `files`, doing at most `INDEX_CHUNK` reads.
   *
   * Returns whether the index now fully describes that snapshot. `head` is stamped only on
   * completion, so a half-built index never claims to be current — which is what lets `search`
   * decide honestly between using it and falling back.
   */
  async catchUp(
    view: BlobReader,
    key: string,
    files: Record<string, FileEntry>,
    opts: { budget?: number } = {}
  ): Promise<boolean> {
    const budget = Math.max(0, Math.min(opts.budget ?? INDEX_CHUNK, INDEX_CHUNK));
    // Paths that left the vault, or stopped being indexable, go first: it is cheap and keeps a
    // deleted note from answering a later search.
    const live = new Set(Object.keys(files).filter((p) => indexable(p, files[p])));
    for (const row of this.#sql.exec<{ path: string }>("SELECT path FROM notes").toArray()) {
      if (!live.has(row.path)) this.#sql.exec("DELETE FROM notes WHERE path = ?", row.path);
    }

    const outstanding = this.#outstanding(files);
    for (const path of outstanding.slice(0, budget)) {
      try {
        const text = new TextDecoder().decode(await view.read(files[path]));
        this.#sql.exec(
          "INSERT OR REPLACE INTO notes (path, hash, content) VALUES (?, ?, ?)",
          path,
          files[path].h,
          text
        );
      } catch {
        // One unreadable blob must not stall the whole build forever. Record the hash with
        // empty content so the path stops being outstanding; a later edit re-reads it.
        this.#sql.exec(
          "INSERT OR REPLACE INTO notes (path, hash, content) VALUES (?, ?, '')",
          path,
          files[path].h
        );
      }
    }

    const complete = outstanding.length <= budget;
    this.#setMeta("head", complete ? key : null);
    return complete;
  }

  /**
   * True when the index describes exactly this snapshot *under this policy*.
   *
   * The key is head **and** policy fingerprint, never the head alone: excluding a folder
   * changes which notes may be searched without moving the head, and an index keyed on the
   * head would go on answering with rows the owner has just put out of scope.
   */
  isCurrent(key: string): boolean {
    return this.#meta("head") === key;
  }

  /**
   * Answers a query out of SQLite. No network, no decryption, whole vault.
   *
   * `LIKE` rather than FTS5: it is a substring contract, which is what the tool promises and
   * what a token-based index would quietly change. The scan is in-process over content already
   * in memory-mapped storage, so it costs a fraction of one blob fetch.
   */
  query(query: string, opts: { folder?: string; glob?: RegExp | null; maxResults: number }): SearchResult {
    const rows = this.#sql
      .exec<{ path: string; content: string }>(
        "SELECT path, content FROM notes WHERE content LIKE ? ESCAPE '\\' ORDER BY path",
        `%${escapeLike(query)}%`
      )
      .toArray();

    const folder = opts.folder?.replace(/\/+$/, "");
    const needle = query.toLowerCase();
    const hits: SearchHit[] = [];
    let matchedFiles = 0;
    let more = false;

    for (const row of rows) {
      if (folder !== undefined && folder !== "" && !row.path.startsWith(`${folder}/`)) continue;
      if (opts.glob != null && !opts.glob.test(row.path)) continue;
      matchedFiles++;
      if (hits.length >= opts.maxResults) {
        more = true;
        continue;
      }
      const lines = row.content.split("\n");
      for (let i = 0; i < lines.length && hits.length < opts.maxResults; i++) {
        if (!lines[i].toLowerCase().includes(needle)) continue;
        hits.push({
          path: row.path,
          line: i + 1,
          text: lines[i],
          context: lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)),
        });
      }
    }

    const total = this.#sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM notes").toArray()[0]?.n ?? 0;
    return { hits, scanned: total, spent: 0, candidates: matchedFiles, more, source: "index" };
  }
}

/** Text, and small enough to be worth holding. Mirrors what the bounded scan would look at. */
function indexable(path: string, entry: FileEntry): boolean {
  return isProbablyText(path) && entry.size <= MAX_FILE_BYTES;
}

/** `%` and `_` are wildcards in LIKE; a query containing them must still mean itself. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
