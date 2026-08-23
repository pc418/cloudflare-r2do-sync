import type { HistoryEntry } from "./types";

/**
 * How the history window counts its rows: one per sync, or one per calendar bucket.
 *
 * A vault committing a dozen times a day buries its own past under `historyLimit` sync rows —
 * forty of them is about three days, against a server that retains ninety plus a weekly tier
 * forever. Grouping changes the unit to the one people actually ask in ("what did I do last
 * Tuesday"), and costs one boundary manifest per bucket instead of one per sync.
 */
export type HistoryGranularity = "sync" | "day" | "week";

export const HISTORY_GRANULARITIES: readonly HistoryGranularity[] = ["sync", "day", "week"];

export function isHistoryGranularity(v: unknown): v is HistoryGranularity {
  return typeof v === "string" && (HISTORY_GRANULARITIES as readonly string[]).includes(v);
}

/** What the window puts on a grouped row, beside the diff every row carries. */
export interface SnapshotGroup {
  granularity: "day" | "week";
  /** Local midnight the bucket starts at (Monday's, for a week). */
  start: number;
  /** Snapshots the bucket holds that the server still lists. Collected ones are not counted here. */
  syncs: number;
  /** Devices that committed in the bucket, newest first. Empty when none of the rows named one. */
  devices: string[];
}

/** One calendar bucket, resolved to the snapshot that stands for it and what it is diffed against. */
export interface HistoryGroup {
  /** The bucket's newest snapshot: the one shown, browsed and restored from. */
  pick: HistoryEntry;
  /**
   * The snapshot the bucket's diff is taken against — the older bucket's pick. Null means
   * nothing older exists, so the diff is an initial one.
   */
  compareTo: string | null;
  /** Syncs the boundary diff covers, collected commits included. Never zero. */
  spans: number;
  group: SnapshotGroup;
}

/** Syncs one listed entry stands for: itself, plus any commits collected behind it. */
function weight(entry: HistoryEntry): number {
  return 1 + (entry.pruned ?? 0);
}

/** Local midnight of the day a timestamp falls in. */
function dayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Local midnight of the Monday starting the ISO week a timestamp falls in. */
function weekStart(ms: number): number {
  const d = new Date(dayStart(ms));
  // getDay() is Sunday-based; ISO weeks start on Monday, so Sunday is six days into its week.
  const back = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
}

/**
 * Collapses a chain page into one row per calendar bucket.
 *
 * Walks **in chain order** and cuts a bucket when the bucket of `uploadedAt` changes, rather
 * than sorting rows by time. The chain is the only ordering that is true: a device with a
 * skewed clock can commit a snapshot whose timestamp sits outside its neighbours', and a time
 * sort would then place two snapshots side by side that are not ancestor and descendant, and
 * diff them as if they were. Cutting on the walk means a stray timestamp can at worst split a
 * bucket in two — visible, harmless, and not a false statement about what changed.
 *
 * `uploadedAt` rather than `createdAt` for two reasons: it is non-null on every row, where
 * `createdAt` is absent on rows indexed before that column existed; and it is the server-side
 * time generational retention buckets on, so a day here is the same day GC thins.
 *
 * **The trailing bucket is dropped unless the chain ended.** A bucket at the end of a page may
 * be missing older members that live on the next page, and diffing it would describe part of a
 * day as though it were all of it. `chainEnds` means *nothing older can be fetched* — not that
 * the oldest entry's parent is null, which never comes true on a vault that has been swept.
 * The caller accumulates entries across pages and re-groups the whole accumulation, so a
 * dropped bucket returns complete rather than being lost — the same discipline the sweep
 * applies to an open run of pruned snapshots at the chain's end.
 */
export function groupHistory(
  entries: readonly HistoryEntry[],
  granularity: "day" | "week",
  opts: { chainEnds: boolean }
): HistoryGroup[] {
  const startOf = granularity === "day" ? dayStart : weekStart;

  // Buckets as contiguous runs of the chain, newest first.
  const buckets: Array<{ start: number; rows: HistoryEntry[] }> = [];
  for (const entry of entries) {
    const start = startOf(entry.uploadedAt);
    const open = buckets[buckets.length - 1];
    if (open !== undefined && open.start === start) open.rows.push(entry);
    else buckets.push({ start, rows: [entry] });
  }

  // Whether the last bucket is whole. It is only when the page ran out of chain rather than out
  // of rows — otherwise its older members are on a page nobody has fetched yet.
  //
  // `chainEnds` is the caller's answer and the only one: it means nothing older can be fetched,
  // which is NOT the same as the oldest entry having a null parent. A vault that has ever been
  // swept keeps an oldest snapshot whose manifest still names the parent that was collected, so
  // a null-parent test here would drop the oldest bucket of every mature vault forever.
  const complete = entries.length > 0 && opts.chainEnds;
  const usable = complete ? buckets : buckets.slice(0, -1);

  return usable.map((bucket, i): HistoryGroup => {
    const older = buckets[i + 1];
    const devices: string[] = [];
    for (const row of bucket.rows) {
      if (row.device !== null && !devices.includes(row.device)) devices.push(row.device);
    }
    return {
      pick: bucket.rows[0],
      // The older bucket's own pick, so consecutive rows describe consecutive intervals with
      // no snapshot falling between them uncounted.
      compareTo: older === undefined ? null : older.rows[0].id,
      // Every sync from this bucket's pick down to (not including) the next bucket's pick,
      // which is exactly this bucket's rows — collected commits behind each one included.
      spans: bucket.rows.reduce((n, row) => n + weight(row), 0),
      group: { granularity, start: bucket.start, syncs: bucket.rows.length, devices },
    };
  });
}

/** How many whole buckets a page yields — what a grouped listing's limit is counted in. */
export function countGroups(
  entries: readonly HistoryEntry[],
  granularity: "day" | "week",
  opts: { chainEnds: boolean }
): number {
  return groupHistory(entries, granularity, opts).length;
}
