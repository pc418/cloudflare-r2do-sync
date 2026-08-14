/**
 * Line accounting for sync messages.
 *
 * Counts are taken while a pass already holds a file's bytes, which is what makes "+35 lines"
 * free: the only other way to know how an edited note changed is to re-download its previous
 * version on every push.
 *
 * They land in two separate places, and the distinction matters:
 *
 * - The `LineCounts` map here is the **device-local cache** in `SyncState`, used to describe
 *   what a pass just did. It is not a manifest field and must never become one.
 * - `FileEntry.lines` is the **per-file count recorded in the snapshot itself** (see
 *   `types.ts`), so the history browser can diff two snapshots without downloading both
 *   versions of every file. Absent there means binary or a pre-field snapshot, never zero.
 *
 * Either way an edit reports its NET line change. Replacing five lines with five others reports
 * zero, and the file count is what shows the work. Reporting a true +5/-5 needs both versions
 * of the text, which neither of these holds.
 */

/** A NUL in the first few KB means "binary" here, the same cheap test git uses. */
const SNIFF_BYTES = 8192;

/** Byte values, spelled out so no source escape can be mangled into a literal control byte. */
const NUL = 0;
const LF = 10;

/**
 * Lines in `bytes`, or null when the content is binary and a line count would be meaningless.
 * A trailing newline adds no phantom final line, so a three-line note counts three whether or
 * not it ends in one.
 */
export function countLines(bytes: Uint8Array): number | null {
  const sniff = Math.min(bytes.byteLength, SNIFF_BYTES);
  for (let i = 0; i < sniff; i++) {
    if (bytes[i] === NUL) return null;
  }
  if (bytes.byteLength === 0) return 0;
  let lines = 0;
  for (let i = 0; i < bytes.byteLength; i++) {
    if (bytes[i] === LF) lines++;
  }
  if (bytes[bytes.byteLength - 1] !== LF) lines++;
  return lines;
}

/** Per-path line counts for one snapshot. Absent means "unknown or binary", never zero. */
export type LineCounts = Record<string, number>;

/**
 * Net line change for one path, or null when it cannot be attributed — a binary file, or one
 * with no cached baseline (a fresh device, or a path this device has never scanned).
 */
export function lineDelta(
  path: string,
  before: LineCounts | undefined,
  after: LineCounts | undefined
): number | null {
  return netLines(before?.[path], after?.[path]);
}

/**
 * Net change between two known counts. `undefined` means the path is absent from that side -
 * a file that arrived or vanished is fully attributable from whichever side knows it. Callers
 * holding bytes must not pass `undefined` for binary content: absent means gone, and a binary
 * file has no count to lose.
 */
export function netLines(old: number | undefined, now: number | undefined): number | null {
  if (old === undefined && now === undefined) return null;
  if (old === undefined) return now ?? null;
  if (now === undefined) return -old;
  return now - old;
}

/**
 * The cache a pass that never commits leaves behind: `delta = new - old`, so replaying the
 * deltas onto the old counts reconstructs the new ones without re-reading the vault. Used by
 * pull-only mode, which returns before the snapshot that would otherwise supply fresh counts.
 */
export function applyLineDeltas(
  cached: LineCounts | undefined,
  changes: ReadonlyArray<{ path: string; action: string; lines: number | null }>
): LineCounts {
  const out: LineCounts = Object.create(null) as LineCounts;
  for (const [path, value] of Object.entries(cached ?? {})) out[path] = value;
  for (const change of changes) {
    if (change.action === "delete") {
      delete out[change.path];
      continue;
    }
    // A null delta means the count is unknowable (binary, or no baseline). Dropping the entry
    // keeps "absent means unknown" true instead of freezing a stale number in place.
    if (change.lines === null) {
      delete out[change.path];
      continue;
    }
    out[change.path] = (out[change.path] ?? 0) + change.lines;
  }
  return out;
}

/**
 * The counts to persist for a committed snapshot: fresh counts win, cached ones survive for
 * carried paths this device never scanned, and nothing outside the snapshot is kept.
 */
export function carryLineCounts(
  files: Record<string, unknown>,
  cached: LineCounts | undefined,
  fresh: LineCounts
): LineCounts {
  const out: LineCounts = Object.create(null) as LineCounts;
  for (const path of Object.keys(files)) {
    const value = fresh[path] ?? cached?.[path];
    if (value !== undefined) out[path] = value;
  }
  return out;
}
