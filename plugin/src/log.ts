import type { PassChange, SyncResult } from "./sync";
import { shortSnapshot } from "./notify";

/** Separator between the two directions on the compact line. */
const SEP = " \u00b7 ";
/** Newline, spelled without a source escape so no tool can flatten it into the file. */
const NL = String.fromCharCode(10);

/**
 * Rolling record of what sync actually did, kept because the plugin's worst failure mode is
 * silence: a pass that halted or errored while nobody was looking. The log is what turns
 * "it stopped working at some point" into a timestamped reason.
 */
export interface SyncLogEntry {
  at: number;
  status: SyncResult["status"] | "error";
  /** Head id, halt reason, error message — whatever explains this pass. */
  detail: string;
  uploaded: number;
  pulled: number;
  merged: number;
  conflicts: number;
  skipped: number;
}

/** Default bound, so `data.json` cannot grow without limit on a busy vault. */
export const MAX_LOG_ENTRIES = 50;

/** Range offered in settings. Zero would make the log useless, so one pass is the floor. */
export const LOG_ENTRIES_RANGE = { min: 1, max: 500 } as const;

export function appendLog(
  log: SyncLogEntry[] | undefined,
  entry: SyncLogEntry,
  limit = MAX_LOG_ENTRIES
): SyncLogEntry[] {
  const keep = Math.max(LOG_ENTRIES_RANGE.min, Math.min(LOG_ENTRIES_RANGE.max, Math.floor(limit)));
  return [entry, ...(log ?? [])].slice(0, keep);
}

export function entryFromResult(result: SyncResult, at: number): SyncLogEntry {
  return {
    at,
    status: result.status,
    detail: detailOf(result),
    uploaded: result.uploaded,
    pulled: result.pulled,
    merged: result.merged,
    // Every unmergeable pair counts, parked or overwritten — both need a human's eye.
    conflicts: result.conflictDetails.length,
    skipped: result.skipped.length,
  };
}

export function entryFromError(e: unknown, at: number): SyncLogEntry {
  return {
    at,
    status: "error",
    detail: e instanceof Error ? e.message : String(e),
    uploaded: 0,
    pulled: 0,
    merged: 0,
    conflicts: 0,
    skipped: 0,
  };
}

function detailOf(result: SyncResult): string {
  switch (result.status) {
    case "committed":
    case "pulled":
      return result.head;
    case "halted":
      return result.reason;
    case "needs-decision": {
      const { deletes, overwrites, percent, threshold } = result.summary;
      return (
        `would delete ${deletes.length} and overwrite ${overwrites.length} local file(s) — ` +
        `${percent}% of the vault, over the ${threshold}% limit`
      );
    }
    case "needs-continuity": {
      const { head, lastHead, reason, walked } = result.continuity;
      return (
        `remote head ${head} could not be traced back to ${lastHead} (${reason}, ` +
        `${walked} snapshot(s) walked)`
      );
    }
    case "unchanged":
      return "";
  }
}

/** One human-readable line describing a finished pass. */
export function summarise(result: SyncResult): string {
  const parts: string[] = [];
  if (result.uploaded > 0) parts.push(`${result.uploaded} uploaded`);
  if (result.pulled > 0) parts.push(`${result.pulled} pulled`);
  if (result.merged > 0) parts.push(`${result.merged} merged`);
  if (result.conflicts.length > 0) parts.push(plural(result.conflicts.length, "conflict"));
  const overwritten = result.conflictDetails.filter((c) => c.copy === null).length;
  if (overwritten > 0) parts.push(`${overwritten} conflict${overwritten === 1 ? "" : "s"} auto-resolved`);
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped`);
  return parts.length > 0 ? parts.join(", ") : "up to date";
}

/** Names listed per direction before the rest are summed. A first sync has hundreds. */
const MAX_NAMES = 10;

const SYMBOL: Record<PassChange["action"], string> = {
  add: "+",
  update: "~",
  delete: "-",
  merge: "><",
};

/**
 * What a pass moved, in one compact line - or, when `verbose`, a line per changed file with
 * its net line change and the snapshot it produced.
 *
 * The snapshot line is abbreviated like every other on-screen id; `formatLogNote` below is the
 * one place that keeps all 26, because it is a file rather than a screen.
 */
export function describePass(result: SyncResult, opts: { verbose: boolean }): string {
  const groups: Array<{ arrow: string; changes: PassChange[] }> = [
    { arrow: "^", changes: result.pushedChanges },
    { arrow: "v", changes: result.pulledChanges },
  ].filter((g) => g.changes.length > 0);

  if (groups.length === 0) return "up to date";

  const extras: string[] = [];
  if (result.conflictDetails.length > 0) {
    extras.push(plural(result.conflictDetails.length, "conflict"));
  }
  if (result.skipped.length > 0) extras.push(`${result.skipped.length} skipped`);

  if (!opts.verbose) {
    return [...groups.map((g) => `${g.arrow} ${headline(g.changes)}`), ...extras].join(SEP);
  }

  const lines: string[] = [];
  for (const group of groups) {
    lines.push(`${group.arrow} ${headline(group.changes)}`);
    for (const change of group.changes.slice(0, MAX_NAMES)) {
      const delta = change.lines === null ? "" : ` (${signed(change.lines)})`;
      lines.push(`  ${SYMBOL[change.action]} ${change.path}${delta}`);
    }
    const rest = group.changes.length - MAX_NAMES;
    if (rest > 0) lines.push(`  ... ${rest} more`);
  }
  lines.push(...extras);
  if (result.status === "committed") {
    lines.push(`snapshot ${shortSnapshot(result.head)}`);
  }
  return lines.join(NL);
}

/**
 * "+2/-1 files, +120/-45 lines" — a clause with nothing to say is dropped entirely.
 *
 * Two independent pairs, because they answer different questions. The file pair counts files
 * that came into or went out of existence, so an edit shows nothing there: a note you changed
 * is not a file you gained. The line pair is about content, so an edit shows up there and only
 * there. That is why an ordinary editing pass reads `+12/-3 lines` with no file clause at all,
 * rather than a meaningless `+0/-0 files` in front of it.
 *
 * Within a pair both halves always print, `-0` included: a fixed shape is what makes the
 * numbers comparable at a glance, and it is the *pair* that is dropped when it is silent.
 */
function headline(changes: PassChange[]): string {
  const parts: string[] = [];

  const added = changes.filter((c) => c.action === "add").length;
  const deleted = changes.filter((c) => c.action === "delete").length;
  if (added > 0 || deleted > 0) parts.push(`${pair(added, deleted)} files`);

  const counted = changes.filter((c) => c.lines !== null);
  if (counted.length > 0) {
    // Split by the sign of each file's net delta rather than netting the whole group: a file
    // that gained 40 lines and one that lost 40 are not "no change", and reporting them as
    // such is the thing this format exists to stop.
    const up = counted.reduce((sum, c) => sum + Math.max(0, c.lines ?? 0), 0);
    const down = counted.reduce((sum, c) => sum + Math.max(0, -(c.lines ?? 0)), 0);
    const unknown = changes.length - counted.length;
    const note = unknown > 0 ? ` (${unknown} not counted)` : "";
    parts.push(`${pair(up, down)} lines${note}`);
  }

  // Everything that moved was binary, or renamed with no content change: there is no pair to
  // print, but something did happen and saying nothing would be worse than saying how many.
  if (parts.length === 0) return plural(changes.length, "file");
  return parts.join(", ");
}

/**
 * A single file's own net delta, which is one number rather than a pair.
 *
 * Zero has its own branch: it is neither a gain nor a loss, and `-0` would report a shrinking
 * file. It is a real answer, not a missing one — five lines replaced by five others nets to
 * nothing, which is exactly what the settings copy promises this reads as.
 */
function signed(n: number): string {
  if (n === 0) return "0";
  return n > 0 ? `+${grouped(n)}` : `-${grouped(n)}`;
}

/** `+2/-1`. Both halves always, so the shape does not change with the numbers. */
function pair(up: number, down: number): string {
  return `+${grouped(up)}/-${grouped(down)}`;
}

/**
 * Thousands separators, because a first sync reports five-figure line counts and `+21430` is
 * read as a different number than `+21,430` at a glance. Grouped explicitly rather than through
 * `toLocaleString`, which would vary with the device's locale and make this untestable.
 */
function grouped(n: number): string {
  return Math.abs(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Coarse "N ago" for the status bar. Deliberately clamps future timestamps to "just now":
 * devices disagree about the clock, and negative ages read as a bug.
 */
export function relativeTime(then: number, now: number): string {
  const diff = now - then;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/** The exportable bug-report view of the log. */
export function formatLogNote(log: SyncLogEntry[], now: number): string {
  const header = [
    "# R2DO Sync — recent sync passes",
    "",
    `Exported ${new Date(now).toISOString()}. Newest first, ${log.length} pass(es) kept.`,
    "",
  ];
  if (log.length === 0) {
    return [...header, "No sync passes recorded yet."].join("\n");
  }
  return [
    ...header,
    "| Time | Status | Up | Pull | Merge | Conflict | Skip | Detail |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...log.map((e) =>
      [
        new Date(e.at).toISOString(),
        e.status,
        e.uploaded,
        e.pulled,
        e.merged,
        e.conflicts,
        e.skipped,
        cell(e.detail),
      ].join(" | ")
    ).map((row) => `| ${row} |`),
    "",
  ].join("\n");
}

/** A pipe in an error message would otherwise split the row into extra columns. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
