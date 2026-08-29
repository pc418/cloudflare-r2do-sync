/**
 * Phase-1 search: a bounded scan.
 *
 * The vault is ~19 MiB across ~820 blobs, so fetching and decrypting everything to answer one
 * question is off the table. This filters candidate paths first, then reads blobs newest-first
 * until it runs out of budget, and **says so** when the budget cut it short — a listing that
 * silently truncates reads as "there is nothing else", which is the one answer a search must
 * never give by accident.
 */
import { globToRegExp } from "../../plugin/src/paths";
import type { FileEntry } from "../../plugin/src/types";
import type { VaultView } from "./vault";

/**
 * The Free plan allows **50 external subrequests per invocation**, and every blob is a `fetch`
 * to the sync Worker. Exceeding it does not degrade, it throws mid-operation.
 */
export const SUBREQUEST_LIMIT = 50;

/** Settings, head and manifest are spent before a single blob is read. */
export const REQUEST_OVERHEAD = 3;

/**
 * What one invocation may spend on blobs, all together.
 *
 * "All together" is the whole point: a search that misses the index scans *and then* advances
 * the index in the same invocation, so two separately-reasonable budgets add up to one that
 * blows the limit. The scan takes from this, the catch-up gets what is left.
 */
export const BLOB_BUDGET = SUBREQUEST_LIMIT - REQUEST_OVERHEAD - 5;

/** Blobs one scan may fetch, when it is the only thing spending. */
export const MAX_SCAN_FILES = 25;
/** Plaintext bytes one search may scan, whichever limit binds first. */
export const MAX_SCAN_BYTES = 2 * 1024 * 1024;
/** Files large enough that they are almost certainly not prose worth grepping. */
export const MAX_FILE_BYTES = 512 * 1024;

export interface SearchHit {
  path: string;
  line: number;
  text: string;
  /** Up to two lines either side, for orientation without a second `read` call. */
  context: string[];
}

export interface SearchResult {
  hits: SearchHit[];
  /** Notes actually looked at: read over the network for a scan, held in SQLite for an index. */
  scanned: number;
  /** Notes eligible to be looked at. For an index that is the whole indexed vault. */
  candidates: number;
  /** True when the budget or the result cap stopped it before the vault ran out. */
  more: boolean;
  /**
   * Which path answered. The two have genuinely different coverage — a scan sees a budget's
   * worth, an index sees everything it holds — so a result that could not say which one it
   * came from could not honestly describe its own completeness.
   */
  source: "scan" | "index";
}

/** Text-ish extensions. A binary blob would only waste budget and produce noise. */
const TEXT_RE = /\.(md|markdown|txt|canvas|json|ya?ml|csv|ts|js|py|sh|html?|css|toml|ini|org|rst)$/i;

export function isProbablyText(path: string): boolean {
  return TEXT_RE.test(path);
}

export function candidatePaths(
  files: Record<string, FileEntry>,
  opts: { folder?: string; glob?: string } = {}
): string[] {
  const folder = opts.folder?.replace(/\/+$/, "");
  const glob = opts.glob === undefined ? null : globToRegExp(opts.glob);
  return Object.keys(files)
    .filter((path) => {
      if (!isProbablyText(path)) return false;
      if (files[path].size > MAX_FILE_BYTES) return false;
      if (folder !== undefined && folder !== "" && !path.startsWith(`${folder}/`)) return false;
      if (glob !== null && !glob.test(path)) return false;
      return true;
    })
    // Newest first: with a budget that can bind, the order decides which half of the vault
    // gets looked at, and recent notes are what a question is usually about.
    .sort((a, b) => files[b].mtime - files[a].mtime || a.localeCompare(b));
}

export async function search(
  view: VaultView,
  files: Record<string, FileEntry>,
  query: string,
  opts: { folder?: string; glob?: string; maxResults?: number; budget?: number } = {}
): Promise<SearchResult> {
  const maxResults = Math.max(1, Math.min(opts.maxResults ?? 20, 100));
  const fileBudget = Math.min(opts.budget ?? MAX_SCAN_FILES, MAX_SCAN_FILES);
  const needle = query.toLowerCase();
  if (needle === "") throw new Error("search needs a non-empty query");

  const candidates = candidatePaths(files, opts);
  const hits: SearchHit[] = [];
  let scanned = 0;
  let bytes = 0;
  let more = false;

  for (const path of candidates) {
    if (scanned >= fileBudget || bytes >= MAX_SCAN_BYTES) {
      more = true;
      break;
    }
    if (hits.length >= maxResults) {
      more = true;
      break;
    }
    const entry = files[path];
    let text: string;
    try {
      text = new TextDecoder().decode(await view.read(entry));
    } catch {
      // One unreadable blob is not a failed search. Skipping it silently would be a lie, but
      // it costs the caller nothing to learn the scan was incomplete.
      more = true;
      continue;
    }
    scanned++;
    bytes += entry.size;

    const lines = text.split("\n");
    for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
      if (!lines[i].toLowerCase().includes(needle)) continue;
      hits.push({
        path,
        line: i + 1,
        text: lines[i],
        context: lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)),
      });
    }
  }

  return { hits, scanned, candidates: candidates.length, more, source: "scan" };
}
