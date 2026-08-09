/**
 * Three-way merge for pulled snapshots.
 *
 * Two layers: `planFile` decides what to do with a path from its three content hashes
 * alone (no I/O), and `mergeText` does line-based diff3 when both sides edited the same
 * note. Neither ever invents content: a merge comes out clean, keeps both sides' lines
 * (when both inserted at the same spot), or is reported as a conflict and the caller
 * preserves both sides as separate files.
 */

import type { FileEntry } from "./types";

/** Newline, spelled so no source escape can be flattened into a literal control byte. */
const NL = String.fromCharCode(10);

export type TextMergeResult = { clean: true; text: string } | { clean: false };

/**
 * What happens to an unmergeable pair. "keep-both" parks the loser as a conflict copy;
 * the other modes OVERWRITE: the loser is discarded, not parked. The remote side always
 * stays recoverable from the snapshot chain, but a local edit that was never committed
 * does not — which is why choosing an overwrite mode requires a second confirmation.
 */
export type ConflictMode = "keep-both" | "newest" | "largest";

export const CONFLICT_MODES: readonly ConflictMode[] = ["keep-both", "newest", "largest"];

/**
 * Which side takes the canonical path when a conflict cannot be merged. Deterministic on
 * purpose: both devices must compute the same winner from the same pair or the vault
 * ping-pongs on every sync — which is also why the modes are symmetric properties of the
 * files (newest, largest), never "mine"/"theirs". Ties break on content hash: arbitrary,
 * but identical on every device.
 */
export function conflictWinner(
  mode: Exclude<ConflictMode, "keep-both">,
  ours: FileEntry,
  theirs: FileEntry
): "ours" | "theirs" {
  if (mode === "newest" && theirs.mtime !== ours.mtime) {
    return theirs.mtime > ours.mtime ? "theirs" : "ours";
  }
  if (mode === "largest" && theirs.size !== ours.size) {
    return theirs.size > ours.size ? "theirs" : "ours";
  }
  return theirs.h > ours.h ? "theirs" : "ours";
}

/** What to do with one path, given its base / local / remote entries. */
export type FilePlan = "none" | "keep-ours" | "take-theirs" | "delete-local" | "merge";

/**
 * The whole conflict policy, in one function.
 *
 * `base` is what this device last synced, `ours` what is on disk now, `theirs` what the
 * remote snapshot holds; `undefined` means the file is absent (deleted, or never existed).
 * Rule of thumb for the asymmetric cases: **content survives**. A file edited on one side
 * and deleted on the other stays, because a deletion is trivially redone by hand while
 * lost edits are gone for good.
 */
export function planFile(
  base: FileEntry | undefined,
  ours: FileEntry | undefined,
  theirs: FileEntry | undefined
): FilePlan {
  if (same(ours, theirs)) return "none"; // includes both-absent and both-same-content
  if (same(theirs, base)) return "keep-ours"; // only we moved: our edit, add, or delete
  if (same(ours, base)) {
    // Only they moved.
    return theirs === undefined ? "delete-local" : "take-theirs";
  }
  // Both moved, differently.
  if (theirs === undefined) return "keep-ours"; // we edited, they deleted
  if (ours === undefined) return "take-theirs"; // we deleted, they edited
  return "merge";
}

function same(a: FileEntry | undefined, b: FileEntry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.h === b.h;
}

const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "text"]);

/** Only note formats get merged; everything else is treated as opaque bytes. */
export function isMergeableText(path: string): boolean {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  if (dot <= slash + 1) return false; // no extension, or a dotfile like ".gitignore"
  return TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/** Strict UTF-8 decode; null means "treat these bytes as binary". */
export function decodeText(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return text.includes("\u0000") ? null : text;
}

/**
 * Where the losing side of a conflict is parked: `note.conflict-<device>-<yymmdd-HHmm>.md`.
 * The extension is preserved so Obsidian still opens the copy, and the timestamp is local
 * time because the only reader is a human deciding which copy to keep. A sequence above
 * one is added before the extension when that minute's base name is already occupied.
 */
export function conflictPath(path: string, device: string, at: number, sequence = 1): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const hasExt = dot > slash + 1;
  const stem = hasExt ? path.slice(0, dot) : path;
  const ext = hasExt ? path.slice(dot) : "";
  const safeDevice = device.replace(/[^A-Za-z0-9_-]/g, "-") || "device";
  const suffix = sequence > 1 ? `-${sequence}` : "";
  return `${stem}.conflict-${safeDevice}-${stamp(at)}${suffix}${ext}`;
}

function stamp(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * Line-based diff3. Both sides' changes are applied when they touch different regions.
 * When both sides *inserted* at the same spot — two devices appending to the same daily
 * log — both insertions are kept (see `unionInsertions`): new lines cannot overwrite
 * anything, so keeping both loses nothing and spares the user re-entering either side.
 * Overlapping changes to *existing* lines that are not byte-identical are a conflict,
 * full stop. Conflict markers are never written into a note — Obsidian would render
 * them as content.
 */
export function mergeText(base: string, ours: string, theirs: string): TextMergeResult {
  if (ours === theirs) return { clean: true, text: ours };
  if (base === ours) return { clean: true, text: theirs };
  if (base === theirs) return { clean: true, text: ours };

  const b = base.split("\n");
  const o = ours.split("\n");
  const t = theirs.split("\n");

  const oursChanges = diffChanges(b, o);
  const theirsChanges = diffChanges(b, t);
  if (oursChanges === null || theirsChanges === null) return { clean: false };

  const hunks: Hunk[] = [
    ...oursChanges.map((c) => ({ ...c, side: 0 as const })),
    ...theirsChanges.map((c) => ({ ...c, side: 1 as const })),
  ];
  hunks.sort((x, y) => x.baseStart - y.baseStart || x.side - y.side);

  const out: string[] = [];
  let bi = 0;
  let oi = 0;
  let ti = 0;

  for (let k = 0; k < hunks.length; ) {
    const regionStart = hunks[k].baseStart;
    let regionEnd = regionStart + hunks[k].baseLen;
    let end = k + 1;
    while (end < hunks.length && overlaps(hunks, k, end, regionEnd)) {
      regionEnd = Math.max(regionEnd, hunks[end].baseStart + hunks[end].baseLen);
      end++;
    }

    // Lines before the region are identical in all three, so any side can supply them.
    for (let x = bi; x < regionStart; x++) out.push(b[x]);
    const stable = regionStart - bi;
    oi += stable;
    ti += stable;
    bi = regionStart;

    let deltaOurs = 0;
    let deltaTheirs = 0;
    let hasOurs = false;
    let hasTheirs = false;
    for (let x = k; x < end; x++) {
      const h = hunks[x];
      if (h.side === 0) {
        hasOurs = true;
        deltaOurs += h.otherLen - h.baseLen;
      } else {
        hasTheirs = true;
        deltaTheirs += h.otherLen - h.baseLen;
      }
    }

    const span = regionEnd - regionStart;
    const oursSlice = o.slice(oi, oi + span + deltaOurs);
    const theirsSlice = t.slice(ti, ti + span + deltaTheirs);

    if (hasOurs && hasTheirs && !sameLines(oursSlice, theirsSlice)) {
      // span === 0 means every hunk in the region is an insertion: nothing from the base
      // was touched, so keeping both sides' lines destroys nothing. Anything that rewrote
      // an existing line stays a conflict.
      if (span > 0) return { clean: false };
      for (const line of unionInsertions(oursSlice, theirsSlice)) out.push(line);
    } else {
      for (const line of hasOurs ? oursSlice : theirsSlice) out.push(line);
    }

    oi += span + deltaOurs;
    ti += span + deltaTheirs;
    bi = regionEnd;
    k = end;
  }

  for (let x = bi; x < b.length; x++) out.push(b[x]);
  return { clean: true, text: out.join("\n") };
}

/** One row of a unified diff, for showing a user what two versions disagree about. */
export interface DiffRow {
  kind: "same" | "ours" | "theirs";
  text: string;
}

/**
 * A unified line diff of two versions, for display only.
 *
 * Shares the merge's LCS, so what the UI shows and what the merge refused are computed from the
 * same view of the two files. Returns null on a pair too large to diff, exactly as the merge
 * does: an approximated diff shown next to a "keep this side" button would be a lie.
 *
 * `context` bounds how many identical lines survive around each change; `maxRows` truncates the
 * whole thing (`truncated` then says how many rows were dropped) so one enormous note cannot
 * hang the modal.
 */
export function diffLines(
  ours: string,
  theirs: string,
  opts: { context?: number; maxRows?: number } = {}
): { rows: DiffRow[]; truncated: number } | null {
  const context = opts.context ?? 3;
  const maxRows = opts.maxRows ?? 400;
  const o = ours.split(NL);
  const t = theirs.split(NL);
  const changes = diffChanges(o, t);
  if (changes === null) return null;

  const rows: DiffRow[] = [];
  let cursor = 0;
  for (const change of changes) {
    // Identical lines between changes: keep `context` on each side of the gap, and mark the
    // elision so a reader is never left thinking two distant hunks are adjacent.
    const gapStart = cursor;
    const gapEnd = change.baseStart;
    const lead = Math.max(gapStart, gapEnd - context);
    if (rows.length > 0) {
      for (let i = gapStart; i < Math.min(gapStart + context, lead); i++) {
        rows.push({ kind: "same", text: o[i] });
      }
      if (lead > gapStart + context) rows.push({ kind: "same", text: ELISION });
    }
    for (let i = lead; i < gapEnd; i++) rows.push({ kind: "same", text: o[i] });

    for (let i = change.baseStart; i < change.baseStart + change.baseLen; i++) {
      rows.push({ kind: "ours", text: o[i] });
    }
    for (let i = change.otherStart; i < change.otherStart + change.otherLen; i++) {
      rows.push({ kind: "theirs", text: t[i] });
    }
    cursor = change.baseStart + change.baseLen;
  }
  for (let i = cursor; i < Math.min(cursor + context, o.length); i++) {
    rows.push({ kind: "same", text: o[i] });
  }

  const truncated = Math.max(0, rows.length - maxRows);
  return { rows: truncated > 0 ? rows.slice(0, maxRows) : rows, truncated };
}

/** Stands in for identical lines the diff left out. */
export const ELISION = "...";

interface Change {
  baseStart: number;
  baseLen: number;
  otherStart: number;
  otherLen: number;
}

type Hunk = Change & { side: 0 | 1 };

/**
 * Whether hunk `end` belongs in the region already covering hunks `k..end-1`.
 *
 * Ranges that genuinely overlap are one region. Two *insertions* at the identical base
 * position also count: they are empty ranges, so a plain overlap test would let each
 * side pass through separately in an arbitrary order. Grouping them routes the pair
 * through `unionInsertions`, which keeps both in a deterministic order.
 */
function overlaps(hunks: Hunk[], k: number, end: number, regionEnd: number): boolean {
  const h = hunks[end];
  if (h.baseStart < regionEnd) return true;
  if (h.baseStart !== regionEnd || h.baseLen !== 0) return false;
  for (let x = k; x < end; x++) {
    if (hunks[x].baseLen === 0 && hunks[x].baseStart === h.baseStart) return true;
  }
  return false;
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/**
 * Both sides inserted different lines at the same base position; keep both.
 *
 * Lines the two insertions share at their start or end (a daily-note template header both
 * devices generated, a shared trailing blank line) appear once, not twice, and a block
 * fully contained in the other is not repeated. The distinct remainders are ordered by
 * text, NOT ours-first: both devices must produce byte-identical results from opposite
 * perspectives, or two racing merges would diverge and the next pull would union the two
 * orderings into duplicated lines. For dated log entries, text order is date order.
 */
function unionInsertions(ours: string[], theirs: string[]): string[] {
  let pre = 0;
  while (pre < ours.length && pre < theirs.length && ours[pre] === theirs[pre]) pre++;
  let suf = 0;
  while (
    suf < ours.length - pre &&
    suf < theirs.length - pre &&
    ours[ours.length - 1 - suf] === theirs[theirs.length - 1 - suf]
  ) {
    suf++;
  }
  const a = ours.slice(pre, ours.length - suf);
  const b = theirs.slice(pre, theirs.length - suf);
  const middle =
    a.length === 0
      ? b
      : b.length === 0
        ? a
        : containsRun(a, b)
          ? a
          : containsRun(b, a)
            ? b
            : a.join("\n") <= b.join("\n")
              ? [...a, ...b]
              : [...b, ...a];
  return [...ours.slice(0, pre), ...middle, ...ours.slice(ours.length - suf)];
}

/** Whether `needle` occurs in `haystack` as a contiguous run of lines. */
function containsRun(haystack: string[], needle: string[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Cap on the LCS table. Beyond this a merge is refused rather than approximated — an
 * unmergeable note becomes a conflict copy, which is recoverable; a bad merge is not.
 */
const MAX_DIFF_CELLS = 4_000_000;

/** Changed regions between `base` and `other`, or null if the pair is too big to diff. */
function diffChanges(base: string[], other: string[]): Change[] | null {
  let pre = 0;
  while (pre < base.length && pre < other.length && base[pre] === other[pre]) pre++;
  let suf = 0;
  while (
    suf < base.length - pre &&
    suf < other.length - pre &&
    base[base.length - 1 - suf] === other[other.length - 1 - suf]
  ) {
    suf++;
  }

  const a = base.slice(pre, base.length - suf);
  const c = other.slice(pre, other.length - suf);
  if (a.length === 0 && c.length === 0) return [];
  if (a.length === 0) return [{ baseStart: pre, baseLen: 0, otherStart: pre, otherLen: c.length }];
  if (c.length === 0) return [{ baseStart: pre, baseLen: a.length, otherStart: pre, otherLen: 0 }];
  if (a.length * c.length > MAX_DIFF_CELLS) return null;

  const n = a.length;
  const m = c.length;
  const width = m + 1;
  // lcs[i][j] = length of the longest common subsequence of a[i:] and c[j:].
  const lcs = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === c[j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const changes: Change[] = [];
  let i = 0;
  let j = 0;
  const matched = () => i < n && j < m && a[i] === c[j];
  while (i < n || j < m) {
    if (matched()) {
      i++;
      j++;
      continue;
    }
    const si = i;
    const sj = j;
    // Consume both sides until they line up again. A leftover tail on either side stays
    // part of THIS change: splitting it off would place a substitution's delete and
    // insert at different base offsets, and the overlap test would then miss them.
    while ((i < n || j < m) && !matched()) {
      if (i < n && j < m) {
        if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) i++;
        else j++;
      } else if (i < n) i++;
      else j++;
    }
    changes.push({ baseStart: pre + si, baseLen: i - si, otherStart: pre + sj, otherLen: j - sj });
  }
  return changes;
}
