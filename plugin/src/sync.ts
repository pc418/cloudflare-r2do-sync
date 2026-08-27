import { ApiError, MissingBlobError, StaleHeadError } from "./api";
import { manifestAad, type VaultCrypto } from "./crypto";
import { sha256Hex } from "./hash";
import {
  conflictPath,
  conflictWinner,
  decodeText,
  isMergeableText,
  mergeText,
  planFile,
  type ConflictMode,
  type FilePlan,
} from "./merge";
import {
  applyLineDeltas,
  carryLineCounts,
  countLines,
  lineDelta,
  netLines,
  type LineCounts,
} from "./lines";
import {
  alwaysSkip,
  DEFAULT_CONFIG_DIR,
  isConfigPath,
  makeExcluder,
  numberedPath,
  pathError,
  pruneCandidates,
  restoreCopyPath,
  selfDirs,
} from "./paths";
import { DEFAULT_LANES, clampLanes, mapPool } from "./pool";
import { createUlidFactory } from "./ulid";
import { isSyncMode, type SyncMode } from "./sync-policy";
import {
  blobKey,
  isEmptyManifest,
  type FileEntry,
  type HistoryEntry,
  previousOf,
  type HistoryPage,
  type Manifest,
  type ManifestV3,
  type StateStore,
  type SyncState,
  type VaultAdapter,
  type VaultFile,
  parseFileEntries,
  isEncryptedManifest,
} from "./types";
import {
  countGroups,
  groupHistory,
  type HistoryGranularity,
  type SnapshotGroup,
} from "./history-groups";

export interface SyncApiLike {
  getHead(): Promise<string | null>;
  /**
   * The snapshot chain in one request, or null when this server has no such route.
   *
   * Null is a real answer, not an error: the route is newer than the oldest Workers this
   * plugin talks to, and a client that cannot fall back would break those vaults outright.
   */
  getHistory(limit: number, opts?: { before?: string }): Promise<HistoryPage | null>;
  getManifest(id: string): Promise<Manifest>;
  getBlob(hash: string): Promise<Uint8Array>;
  checkBlobs(hashes: string[]): Promise<string[]>;
  putBlob(hash: string, bytes: Uint8Array): Promise<void>;
  commit(
    manifest: Manifest,
    expectedHead: string | null,
    opts?: { reroot?: boolean }
  ): Promise<string>;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

/** One unmergeable pair and how it ended, with the facts a human needs to judge it. */
export interface ConflictInfo {
  /** The canonical vault path both sides fought over. */
  path: string;
  /** Where the losing version was parked, or null when the mode discarded it. */
  copy: string | null;
  /** Which side's content holds the canonical path now. */
  kept: "ours" | "theirs";
  ours: { mtime: number; size: number };
  theirs: { mtime: number; size: number };
  /**
   * True when `copy` names an entry that exists only in the snapshot. Push-only mode never
   * writes to the vault, so its parked versions are published rather than saved to disk, and
   * a review window that offered to "keep" one would be pointing at a file that is not there.
   * Absent on entries written before this existed, which were all real files.
   */
  snapshotOnly?: boolean;
}

/**
 * One file a pass moved, and how many lines it gained or lost. `lines` is null when the change
 * cannot be attributed — binary content, or a path with no cached baseline — and never zero as
 * a stand-in for "unknown". See `lines.ts` for why the figure is net rather than +N/-M.
 */
export interface PassChange {
  path: string;
  action: "add" | "update" | "delete" | "merge";
  lines: number | null;
}

interface ResultBase {
  uploaded: number;
  skipped: SkippedFile[];
  /** What the published snapshot changed, against the snapshot it parented onto. */
  pushedChanges: PassChange[];
  /** What landed on disk here because another device had moved. */
  pulledChanges: PassChange[];
  /** Files written or deleted locally because the remote changed them. */
  pulled: number;
  /** Files where both sides changed and diff3 resolved it cleanly. */
  merged: number;
  /** Conflict copies written, by path. Non-empty means a human should look. */
  conflicts: string[];
  /** Every unmergeable pair this pass hit, parked or overwritten, in plan order. */
  conflictDetails: ConflictInfo[];
  /**
   * The snapshot this device is on when the pass ends, whatever the pass did — null before
   * anything has ever been committed.
   *
   * On every status, which is the point: `committed` and `pulled` carry a `head` of their own
   * describing what the pass *produced*, and an `unchanged` pass has nothing to produce, so
   * without this there is no way to say which snapshot "up to date" is up to date *with*.
   * A halt or an unanswered question carries it too, because a pass that stopped after
   * absorbing a remote really is on that snapshot (`#persistAbsorbed`).
   *
   * Read from `#state` at the moment the result is built rather than threaded through each
   * return, so it cannot drift from what was actually saved.
   */
  currentHead: string | null;
}

/** What the user chose when a pass would destroy an unusual share of the vault. */
export type MassChangeDecision = "apply-remote" | "keep-local" | "cancel";

export interface MassChangeSummary {
  /** Local files the plan would delete. */
  deletes: string[];
  /** Local files whose contents the plan would replace with the remote's. */
  overwrites: string[];
  localFileCount: number;
  /** Destructive share of the vault, rounded, and the threshold it met or exceeded. */
  percent: number;
  threshold: number;
}

/**
 * Why a pass could not confirm that the head the server is serving grew out of the snapshot
 * this device last absorbed.
 *
 * None of these is proof of an attack, and the difference between them is the whole point of
 * reporting them separately — a device that has simply been away longer than history retention
 * looks, from here, exactly like a server that replaced its history.
 */
export type ContinuityReason =
  /**
   * The chain ends at a snapshot with no parent that is not one of ours. Another device ran
   * "Rebuild remote history", which orphans everything earlier by design — or something
   * replaced the vault's history wholesale.
   */
  | "replaced"
  /** An ancestor is no longer stored. Ordinary once a device is past the retention window. */
  | "truncated"
  /** The chain was longer than this check walks. Says nothing either way. */
  | "limit"
  /**
   * The walk started from an envelope this device authenticated and reached one it cannot:
   * an older manifest version, or one encrypted under a key we no longer hold. From there
   * the parent links are the server's word rather than evidence, so the walk stops instead
   * of finishing a proof it can no longer make. Ordinary on a vault whose history predates
   * an encryption migration.
   */
  | "unauthenticated";

/** What a pass found when it could not place its own last snapshot in the remote's history. */
export interface ContinuitySummary {
  /** The head the server is serving now. */
  head: string;
  /** The snapshot this device last absorbed — what the walk was looking for. */
  lastHead: string;
  reason: ContinuityReason;
  /** Snapshots walked back from `head`, including it, before the walk gave up. */
  walked: number;
  /**
   * Local files this pass had already written or removed before the question arose, by
   * applying an *earlier* head whose ancestry it did verify and then losing the head race.
   * Usually zero. Never a number the message may round down to "nothing was changed".
   */
  alreadyApplied: number;
}

/** Whether to merge a remote whose ancestry could not be verified, or leave it alone. */
export type ContinuityDecision = "continue" | "stop";

export type SyncResult =
  | ({ status: "committed"; head: string } & ResultBase)
  | ({ status: "pulled"; head: string } & ResultBase)
  | ({ status: "unchanged" } & ResultBase)
  | ({ status: "needs-decision"; summary: MassChangeSummary } & ResultBase)
  | ({ status: "needs-continuity"; continuity: ContinuitySummary } & ResultBase)
  | ({ status: "halted"; reason: string } & ResultBase);

export interface PreviewAction {
  path: string;
  action: "write" | "delete" | "merge" | "add" | "update";
}

/** What a sync would do right now. Produced without writing or uploading anything. */
export interface SyncPreview {
  head: string | null;
  /** Changes that would land on disk. */
  pull: PreviewAction[];
  /** Changes that would land in the next snapshot. */
  push: PreviewAction[];
  skipped: SkippedFile[];
  /** Non-null when the plan would trip the mass-change guard. */
  guard: MassChangeSummary | null;
  /** Set when the remote cannot be read at all; the lists are then empty. */
  halted?: string;
  /**
   * Set when this preview could not confirm that the remote head descends from the snapshot
   * this device last absorbed. The plan below is still what a sync would do; this is the
   * caveat that a sync would stop to ask about first.
   */
  continuity?: ContinuitySummary;
}

/** How far `restoreFile` steps past an occupied destination before it gives up loudly. */
const MAX_RESTORE_COPIES = 50;

/**
 * The error that stops a restore whose approval has gone stale. Its own function so the two
 * call sites cannot drift, and so a test can pin that nothing was written.
 */
function restoreRaceError(path: string): Error {
  return new Error(
    `"${path}" changed while the restore was being confirmed — nothing was written. ` +
      `Look at the file and restore again.`
  );
}

/** What restoring a file from a snapshot would meet at its original path. */
export interface RestoreInspection {
  /** The snapshot's own record of the file. */
  entry: FileEntry;
  /**
   * sha256 of what was at the path when this ran, or null for nothing. Pass it back as
   * `restoreFile`'s `expectedHash` so the write is bound to the version the user was shown.
   */
  currentHash: string | null;
  /** What is at the original path right now, compared by content hash. */
  current: "absent" | "identical" | "differs";
  /**
   * True when the bytes at the path are not the ones this device last synced — an edit made
   * since the last pass, or a file never synced at all. Those exist nowhere else.
   *
   * False means only that they *match this device's last synced state*. It is **not** proof
   * that any retained snapshot still references them: this device can have been offline past
   * the retention window, the chain can have been rerooted, or the manifest that held them can
   * have been collected. Never turn a false here into a promise that replacing them is
   * recoverable.
   */
  unsyncedEdits: boolean;
  /** A copy destination beside the original, named for the snapshot's date. */
  suggestion: string;
}

/**
 * Where a restore's bytes ended up.
 *
 * `identical` wrote nothing because the content was already there. `written` found the
 * destination free. `replaced` overwrote differing content, which only an explicit
 * `overwrite` can produce. `copied` stepped past occupied content to a numbered sibling —
 * `path` is where it landed, `requested` is where the caller asked.
 */
export interface RestoreOutcome {
  kind: "identical" | "written" | "replaced" | "copied";
  path: string;
  requested: string;
}

/** One file a snapshot changed, against its parent snapshot. */
export interface SnapshotChange {
  path: string;
  kind: "added" | "removed" | "modified";
  /** Byte size change: positive for growth, negative for shrinkage. */
  bytes: number;
  /**
   * Net line change, or null when it cannot be attributed — binary content, or a snapshot
   * committed before entries carried `lines`. Net, so a five-for-five rewrite reports zero.
   */
  lines: number | null;
}

/**
 * What one snapshot changed against its parent.
 *
 * `linesAdded`/`linesRemoved` split the per-file net deltas by sign, which is the honest way
 * to show a "+N −N" for a whole snapshot: a file that gained lines and one that lost them do
 * not cancel out, even though neither file's own figure is a true insert/delete count.
 */
export interface SnapshotChanges {
  /** Every changed path, most recently edited first. Empty for a snapshot that changed nothing. */
  files: SnapshotChange[];
  added: number;
  removed: number;
  modified: number;
  /** Net byte change across the snapshot. Meaningful for history predating `lines`. */
  bytes: number;
  linesAdded: number;
  linesRemoved: number;
  /** Changed files whose line delta could not be attributed; excluded from the two sums. */
  linesUnknown: number;
  /** True when this snapshot has no parent, so everything it holds counts as added. */
  initial: boolean;
  /**
   * How many commits this diff covers. Absent means one — the ordinary snapshot-against-its
   * -parent case. Present and greater than one means the commits in between have been
   * collected, so this is a true diff over a wider interval, and must be shown as one: the
   * intermediate states are gone, not unchanged.
   */
  spans?: number;
}

/**
 * Why a snapshot's changes could not be computed. Reported instead of an empty diff, because
 * "nothing changed" and "we cannot tell" are different facts and only one of them is reassuring.
 */
export type ChangesUnknown =
  /** This snapshot's own path map cannot be decrypted with this device's key. */
  | "unreadable"
  /** The parent's cannot, so there is nothing to compare against. */
  | "parent-unreadable"
  /** The parent is gone (retention), unfetchable, or the walk refused to follow the link. */
  | "parent-missing";

/** One entry in the snapshot chain, as shown in the history browser. */
export interface SnapshotInfo {
  id: string;
  parent: string | null;
  device: string;
  createdAt: string;
  /** Null when this device's key cannot open the snapshot. */
  fileCount: number | null;
  readable: boolean;
  /**
   * What this snapshot changed against its parent. Absent unless the caller asked for diffs;
   * `{ unknown }` when they were asked for but could not be computed.
   */
  changes?: SnapshotChanges | { unknown: ChangesUnknown };
  /**
   * Present when this row stands for a calendar bucket rather than one sync. `id`, `parent` and
   * `changes` still describe real snapshots — the bucket's newest, and its diff against the
   * older bucket's newest — so everything that browses or restores from a row works unchanged.
   */
  group?: SnapshotGroup;
}

/**
 * One row a listing intends to build: which snapshot, and what its diff is measured against.
 *
 * Lifting these out of `HistoryEntry` is what lets a flat listing and a grouped one share every
 * expensive step. A sync row compares against the chain's next link; a bucket row compares
 * against the older bucket's pick. Downstream, neither case is special.
 */
interface HistoryRow {
  /** The snapshot fetched, shown and browsed. */
  id: string;
  /** Its own parent as the index reports it, cross-checked against the manifest. */
  parent: string | null;
  /** When the server took delivery of it. What a date range is measured against on a sync row. */
  at: number;
  /** What the diff is taken against. Null means nothing older exists: an initial diff. */
  compareTo: string | null;
  /** Syncs the diff covers, collected commits included. One for an ordinary snapshot-vs-parent. */
  spans: number;
  /** Label material for a bucket row. Absent on a sync row. */
  group?: SnapshotGroup;
}

/** What a history listing could not do, said out loud rather than served as a shorter list. */
export type HistoryFallback =
  /** The server could not answer the chain, so these are walked rows and cannot be grouped. */
  | "no-index"
  /**
   * The same, with a date range asked for. Kept separate because it is the more serious of the
   * two: the walk reaches back `limit` snapshots from the head and no further, so a range older
   * than that has nothing to find and an empty list would be a false answer, not a true one.
   */
  | "no-range"
  /** The server does not understand the paging cursor, so the listing stops at one page. */
  | "no-cursor";

/** How far back a listing reaches, and in what unit. */
export interface HistoryOptions {
  changes?: boolean;
  /** Rows per sync, per day or per week. Defaults to per sync. */
  granularity?: HistoryGranularity;
  /** Hide anything uploaded before this instant. Paging continues until the range is covered. */
  from?: number;
  /** Hide anything uploaded at or after this instant. */
  to?: number;
}

export interface HistoryListing {
  rows: SnapshotInfo[];
  /** What the rows actually are — not what was asked for, when a fallback intervened. */
  granularity: HistoryGranularity;
  /**
   * Older snapshots exist past the last row shown. Without this, a list cut by a limit or a page
   * cap reads as the end of the vault's history, which is the same lie as an empty listing.
   */
  more: boolean;
  fallback?: HistoryFallback;
}

/** Index rows one chain request asks for when a listing may need to page. Mirrors the server cap. */
const CHAIN_PAGE = 500;

/**
 * Chain requests one listing will make. Forty week-buckets on a vault committing a dozen times
 * a day is well inside this; the bound exists so a chain that never satisfies the stop condition
 * cannot spin, not because anyone should reach it.
 */
const MAX_HISTORY_PAGES = 8;

/**
 * The rows a date range leaves visible.
 *
 * Applied to the *plan*, never to the chain feeding it. Filtering entries before they are
 * grouped would build buckets out of a discontiguous set and diff snapshots that nothing sits
 * between; filtering afterwards leaves every row diffed against its true neighbour, which for
 * the oldest row in range is deliberately a snapshot outside it — that is what makes "what
 * changed on the first day you asked about" answerable at all.
 */
function isRanged(opts: HistoryOptions): boolean {
  return opts.from !== undefined || opts.to !== undefined;
}

function inWindow(at: number, opts: HistoryOptions): boolean {
  // A timestamp nothing could parse is never silently treated as inside the range.
  if (!Number.isFinite(at)) return false;
  if (opts.from !== undefined && at < opts.from) return false;
  return opts.to === undefined || at < opts.to;
}

function inRange(plan: readonly HistoryRow[], opts: HistoryOptions): HistoryRow[] {
  if (!isRanged(opts)) return [...plan];
  // A bucket is placed by the calendar unit it names, a sync by its own upload time.
  return plan.filter((row) => inWindow(row.group?.start ?? row.at, opts));
}

/**
 * A cached history row's identity: the snapshot, and what it was compared against.
 *
 * The second half is what makes the cache safe once retention can thin the chain. A row's
 * diff describes an interval, and collecting the snapshot at the far end of that interval
 * moves it — so a row keyed by id alone would keep answering for an interval that no longer
 * exists. Grouping needs no third component: a bucket row's interval *is* that pair, so a day
 * row and a sync row that share a key are describing the same two snapshots and may share the
 * fetch. The bucket label is attached at assembly rather than cached, precisely so they can.
 */
function rowKey(entry: { id: string; compareTo: string | null }): string {
  return `${entry.id}\u0000${entry.compareTo ?? ""}`;
}

/**
 * What changed between a parent snapshot's path map and its child's. A null parent means the
 * child is the vault's first snapshot, so every file it holds is an addition.
 *
 * Both maps are already in memory when the history walk decrypts them, so this costs nothing
 * beyond the comparison. Identity is `h`, the *plaintext* hash, which encrypted snapshots
 * carry too — so a re-encryption or a key migration correctly reports no content change.
 */
export function diffSnapshots(
  parent: Record<string, FileEntry> | null,
  child: Record<string, FileEntry>
): SnapshotChanges {
  const files: SnapshotChange[] = [];
  let bytes = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  let linesUnknown = 0;

  /**
   * The line delta for one change, or null when it cannot be attributed.
   *
   * Attribution follows the *kind* of change, not `netLines`, whose `undefined` means "absent
   * on this side". In a `modified` change both entries exist, so a missing `lines` means binary
   * content or a snapshot written before the field existed — not a file that had zero lines.
   * Reading it as zero would report the first edit of an old seven-line note as `+10`.
   */
  const lineDelta = (
    kind: SnapshotChange["kind"],
    before: FileEntry | undefined,
    after: FileEntry | undefined
  ): number | null => {
    if (kind === "added") return after?.lines ?? null;
    if (kind === "removed") return before?.lines === undefined ? null : -before.lines;
    if (before?.lines === undefined || after?.lines === undefined) return null;
    return after.lines - before.lines;
  };

  const record = (
    path: string,
    kind: SnapshotChange["kind"],
    before: FileEntry | undefined,
    after: FileEntry | undefined
  ): void => {
    const delta = lineDelta(kind, before, after);
    const change: SnapshotChange = {
      path,
      kind,
      bytes: (after?.size ?? 0) - (before?.size ?? 0),
      lines: delta,
    };
    bytes += change.bytes;
    if (delta === null) linesUnknown++;
    else if (delta >= 0) linesAdded += delta;
    else linesRemoved -= delta;
    files.push(change);
  };

  const before = parent ?? pathMap<FileEntry>();
  for (const [path, entry] of Object.entries(child)) {
    const old = before[path];
    if (old === undefined) record(path, "added", undefined, entry);
    else if (old.h !== entry.h) record(path, "modified", old, entry);
  }
  for (const [path, entry] of Object.entries(before)) {
    if (child[path] === undefined) record(path, "removed", entry, undefined);
  }

  // Most recently edited first, matching how a snapshot's own file list is ranked. A removed
  // file is ranked by when it was last edited, which is the only date it has. Ties break on
  // path so two devices render an identical list.
  const mtimeOf = (c: SnapshotChange): number =>
    (c.kind === "removed" ? before[c.path]?.mtime : child[c.path]?.mtime) ?? 0;
  files.sort((a, b) => mtimeOf(b) - mtimeOf(a) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    files,
    added: files.filter((c) => c.kind === "added").length,
    removed: files.filter((c) => c.kind === "removed").length,
    modified: files.filter((c) => c.kind === "modified").length,
    bytes,
    linesAdded,
    linesRemoved,
    linesUnknown,
    initial: parent === null,
  };
}

/** Historic name, kept so callers that only care about the shape keep compiling. */
export type PushResult = SyncResult;

export interface SyncStatus {
  phase: "idle" | "syncing" | "error" | "halted";
  message?: string;
  lastSyncAt?: number;
}

export interface SyncEngineOptions {
  vault: VaultAdapter;
  api: SyncApiLike;
  store: StateStore;
  deviceName: string;
  excludes?: string[];
  /** Empty means whole vault; otherwise a path must match at least one allow glob. */
  onlyPaths?: string[];
  /** Direction policy. Unknown runtime values fail instead of silently becoming two-way. */
  mode?: SyncMode;
  /** Allows ordinary configuration-directory files; hard credential/workspace skips still win. */
  syncConfigDir?: boolean;
  /**
   * This vault's configuration directory (`Vault.configDir`). Defaults to `.obsidian`, which is
   * only Obsidian's default — a vault that renamed it keeps its credentials somewhere else, and
   * assuming the literal would upload them.
   */
  configDir?: string;
  maxBlobBytes?: number;
  now?: () => number;
  ulid?: () => string;
  /** When set, contents and the path map are encrypted before they leave the device. */
  crypto?: VaultCrypto | null;
  /**
   * Share of the vault (0–100) a pull may destroy before asking. The check is strict:
   * it fires only above this share. 100 disables it; 0 asks about any destructive change.
   */
  protectPercent?: number;
  /** Asked before a destructive pull is applied. Absent means "cancel" — never guess. */
  decideMassChange?: (summary: MassChangeSummary) => Promise<MassChangeDecision>;
  /**
   * Asked when the remote head cannot be shown to descend from the one this device last
   * absorbed. Absent means "stop": an unattended pass must not answer a question about
   * whether the server's history is the one it was syncing with yesterday.
   */
  decideContinuity?: (summary: ContinuitySummary) => Promise<ContinuityDecision>;
  /** What happens to unmergeable pairs. Default "keep-both"; see `ConflictMode`. */
  conflictMode?: ConflictMode;
  onProgress?: (p: { phase: "pull" | "upload"; done: number; total: number }) => void;
  /** Files processed concurrently per phase. See `pool.ts`; 1 restores serial behaviour. */
  lanes?: number;
}

const DEFAULT_MAX_BLOB_BYTES = 100 * 1024 * 1024;

const DEFAULT_PROTECT_PERCENT = 50;

/** How many times a commit may lose the head race before we stop and tell the user. */
const MAX_COMMIT_ATTEMPTS = 3;

/**
 * How many times a pass may rescan because the vault changed under it. A rescan re-reads and
 * re-encrypts every file, so this is deliberately small: a file being written continuously
 * would otherwise loop forever at full cost.
 */
const MAX_RESCAN_ATTEMPTS = 3;

/**
 * How far back a pass will walk the remote chain to find the snapshot it last absorbed.
 *
 * A backstop, not a policy: the honest walk is already bounded by retention, because an
 * ancestor older than the server keeps is simply gone and ends the walk as `truncated`. Every
 * step past the first is one manifest fetch — and a manifest restates the vault's whole path
 * map — so the cost is proportional to how many commits this device missed. The first step is
 * free: the head manifest the pass is about to merge is already in hand.
 */
const MAX_DESCENT_STEPS = 250;

/**
 * The vault changed while a pass was publishing it. Recoverable by rescanning — the snapshot is
 * stale, not wrong — so it is a distinct type rather than a bare Error the pass would die on.
 */
export class FileChangedError extends Error {
  constructor(
    readonly path: string,
    message: string
  ) {
    super(message);
  }
}

interface Snapshot {
  files: Record<string, FileEntry>;
  skipped: SkippedFile[];
  /** Lines per scanned text file, for the net figures in a sync message. */
  lines: LineCounts;
  /** Every on-disk path, including excluded/skipped ones, for collision-safe planning. */
  occupiedPaths: string[];
  /** All discovered files, including excluded/skipped paths. Device-local, never on the wire. */
  inventory: Record<string, VaultFile>;
}

interface SnapshotBuildOptions {
  dirtyPaths: string[];
  baseFiles: Record<string, FileEntry>;
  baseLines: LineCounts;
  baseInventory: Record<string, VaultFile>;
}

interface RemoteCollisionResolution {
  files: Record<string, FileEntry>;
  conflicts: string[];
  conflictDetails: ConflictInfo[];
  /** Existing local spellings that a case-variant remote entry must not remove. */
  protectedLocalPaths: string[];
}

interface MergeOutcome {
  pulled: number;
  merged: number;
  /** Same list as `ResultBase.pulledChanges`; accumulated here as the plan is applied. */
  pulledChanges: PassChange[];
  conflicts: string[];
  conflictDetails: ConflictInfo[];
}

export interface EncryptionMigrationResult {
  head: string;
  uploaded: number;
  files: number;
}

/**
 * Bounds on `SyncEngine.isEffectivelyEmpty`. Both exist so the check stays cheap on a vault
 * that is obviously not empty: neither is a statement about what a user may keep, only about
 * when to stop looking and answer "not empty".
 */
export const EMPTY_VAULT_MAX_FILES = 20;
export const EMPTY_VAULT_MAX_BYTES = 4096;

/**
 * Whether these bytes carry nothing a person wrote: no bytes at all, or text that is entirely
 * whitespace.
 *
 * Binary content is never blank, however small. A lone replacement character is how a failed
 * UTF-8 decode shows up, and guessing that such a file is "empty enough not to publish" would
 * quietly drop somebody's file — so anything that does not decode cleanly counts as content.
 */
export function isBlankContent(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return true;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  return text.trim() === "";
}

export interface SyncPassOptions {
  /** Internal scheduler flag: startup/resume/manual/periodic passes are correctness audits. */
  fullScan?: boolean;
  /**
   * Force this device's snapshot over the remote: absorb the remote head only as the CAS
   * parent, apply nothing from it, and do not consult the mass-change guard — the operator
   * has already answered the question the guard exists to ask. Local files are never
   * written or removed. Refused in `pull-only` mode, which never commits at all.
   */
  keepLocal?: boolean;
  /**
   * Publish this pass as a new ROOT snapshot, discarding every earlier one.
   *
   * The commit's parent is null rather than the current head, so the whole existing chain is
   * orphaned and the server's next GC deletes it along with every blob only it referenced.
   * That is the only way to make content stop existing remotely — an ordinary commit, forced
   * or not, layers onto the chain and leaves the old snapshots restorable.
   *
   * Implies `keepLocal`: the point is to publish this device's state, not to reconcile.
   * Unscanned remote paths are still carried, because dropping them would delete other
   * devices' files rather than their history.
   */
  reroot?: {
    /**
     * The head the operator was shown before agreeing. If it is no longer the head, the pass
     * REFUSES rather than rerooting over a snapshot nobody reviewed: an ordinary CAS retry
     * absorbs a racing commit and merges it, but a reroot would discard that device's work
     * *and* the history that made it recoverable.
     */
    previewedHead: string | null;
  };
  /**
   * The head a forced push was previewed against. Same reasoning as `reroot.previewedHead`,
   * for the same reason: the typed confirmation names how many remote files this pass leaves
   * out, and a snapshot published since was never in that count. Absent means "not previewed"
   * — an ordinary `keepLocal` pass, which merges nothing but also promised nothing.
   */
  previewedHead?: string | null;
  /**
   * Run this ONE pass as if the direction were `pull-only`: absorb the remote, write nothing
   * back, commit nothing.
   *
   * This exists for the first pass of a device whose vault holds nothing worth publishing — a
   * fresh install that has just been handed a setup link. Such a device cannot damage the
   * remote (a first sync has no base, so `planFile` has no deletion to reach), but it *can*
   * publish the blank note the app created on its way in, and the ordinary first-sync gate
   * promises "everything here is published", which is the wrong thing to tell someone whose
   * device is empty.
   *
   * Only ever a downgrade, and only from `two-way`: an operator who chose `push-only` chose it,
   * and refused rather than silently reversed. Rejected with `keepLocal`/`reroot`, which are
   * publishes by definition.
   */
  pullOnly?: boolean;
}

/** What `forcePull` would do, so it can be shown before it is done. */
export interface ForcePullSummary {
  /** The remote snapshot that will become this vault's contents. */
  head: string;
  /** Files that will be written from that snapshot. */
  write: number;
  /** Local paths that will be removed, because the snapshot has no such file. */
  remove: string[];
  /** Local paths whose unpublished changes will be parked as `.conflict-…` copies first. */
  park: string[];
}

export interface ForcePullResult {
  head: string;
  written: number;
  removed: number;
  /** The conflict-copy paths created for unpublished local divergence. */
  parked: string[];
}

/** What a forced push would publish. `head` is the snapshot it will replace. */
export interface ForcePushSummary {
  head: string | null;
  /** Files this device will publish. */
  files: number;
  /** Remote paths that will disappear from the new snapshot. */
  drop: string[];
  /** Remote paths this device does not scan, carried into the new snapshot unchanged. */
  carried: number;
}

/** What "Rebuild remote history" would do, so the confirmation can state it before it runs. */
export interface RerootSummary extends ForcePushSummary {
  /**
   * Snapshots that stop being reachable, counted up to the history limit asked for. The
   * server deletes them on its next collection, not at the click — the confirmation says so,
   * because "purged" and "unreachable" are not the same promise.
   */
  discarded: number;
  /** True when the chain was longer than the count walked, so `discarded` is a floor. */
  discardedIsFloor: boolean;
}

interface ForcePullPlan extends ForcePullSummary {
  manifest: Manifest;
  /** Listed before anything is parked, so a fresh conflict copy is never treated as stale. */
  localFiles: VaultFile[];
}

/** One path's resolution, decided before anything is written so the plan can be vetted. */
interface PlannedAction {
  path: string;
  plan: FilePlan;
  base: FileEntry | undefined;
  ours: FileEntry | undefined;
  theirs: FileEntry | undefined;
}

/** A divergence a human has to settle. Never thrown out of `sync()`. */
class HaltError extends Error {}

/**
 * Bidirectional sync. Each pass pulls whatever the remote gained, three-way-merges it into
 * the vault, then commits the result as a fresh whole-vault snapshot.
 *
 * The invariant that shapes everything: a manifest is a *snapshot*, so committing without
 * first absorbing the remote's files would delete them. Divergence is therefore always
 * resolved before a commit, never after — and when it cannot be resolved automatically,
 * both sides are kept on disk (one under a `.conflict-…` name) rather than either being
 * dropped. Only a mode mismatch that makes the remote unreadable (wrong or missing master
 * key) still halts.
 */
export class SyncEngine {
  readonly #vault: VaultAdapter;
  readonly #api: SyncApiLike;
  readonly #store: StateStore;
  readonly #deviceName: string;
  readonly #isExcluded: (path: string) => boolean;
  readonly #isIncluded: (path: string) => boolean;
  readonly #hasOnlyPaths: boolean;
  readonly #mode: SyncMode;
  readonly #syncConfigDir: boolean;
  readonly #configDir: string;
  readonly #maxBlobBytes: number;
  readonly #now: () => number;
  readonly #ulid: () => string;
  readonly #crypto: VaultCrypto | null;
  readonly #protectPercent: number;
  readonly #conflictMode: ConflictMode;
  readonly #decideMassChange: ((s: MassChangeSummary) => Promise<MassChangeDecision>) | null;
  readonly #decideContinuity: ((s: ContinuitySummary) => Promise<ContinuityDecision>) | null;
  readonly #onProgress: SyncEngineOptions["onProgress"];
  readonly #lanes: number;
  /**
   * History rows already built this session, keyed by manifest id *and* the snapshot they
   * were compared against.
   *
   * A manifest id is permanent and used once, and a snapshot's own parent link never moves,
   * so a row diffed against its true parent could never change and this needed no
   * invalidation. Generational retention breaks exactly that assumption and no more: when the
   * snapshot a row was compared against is itself collected, the server names a further one,
   * and the diff is then over a different interval. Putting that snapshot in the key retires
   * the stale row without a sweep — a row whose comparison still stands keeps its key and its
   * value. Holds finished rows, never path maps, so forty entries cost kilobytes rather than
   * the megabytes they were derived from.
   */
  readonly #historyRows = new Map<string, SnapshotInfo>();

  #state: SyncState | null = null;
  readonly #dirtyPaths = new Set<string>();
  #dirtyRequiresFullScan = false;
  /**
   * The direction *this pass* runs in, which is `#mode` except when a caller downgrades one
   * pass to `pull-only` (see `SyncPassOptions.pullOnly`). A field rather than a parameter
   * because the pass is already serialised against itself — `sync()` refuses to start while
   * `phase === "syncing"` — so there is never a second pass to read a value meant for this one.
   */
  #passMode: SyncMode = "two-way";
  status: SyncStatus = { phase: "idle" };

  constructor(opts: SyncEngineOptions) {
    this.#vault = opts.vault;
    this.#api = opts.api;
    this.#store = opts.store;
    this.#deviceName = opts.deviceName;
    this.#isExcluded = makeExcluder(opts.excludes ?? []);
    const onlyPaths = (opts.onlyPaths ?? []).filter((glob) => glob.trim() !== "");
    this.#isIncluded = makeExcluder(onlyPaths);
    this.#hasOnlyPaths = onlyPaths.length > 0;
    if (!isSyncMode(opts.mode ?? "two-way")) {
      throw new Error(`unknown sync mode ${String(opts.mode)}`);
    }
    this.#mode = opts.mode ?? "two-way";
    this.#passMode = this.#mode;
    if (opts.syncConfigDir !== undefined && typeof opts.syncConfigDir !== "boolean") {
      throw new Error("syncConfigDir must be a boolean");
    }
    this.#syncConfigDir = opts.syncConfigDir ?? false;
    // A blank or nested value would silently stop matching the directory it names, and the
    // paths it protects hold this device's credentials. Refuse it instead of guessing.
    if (opts.configDir !== undefined) {
      if (typeof opts.configDir !== "string" || opts.configDir.trim() === "") {
        throw new Error("configDir must be a non-empty string");
      }
      if (opts.configDir.includes("/")) {
        throw new Error(`configDir must be a single folder name, got ${opts.configDir}`);
      }
    }
    this.#configDir = opts.configDir ?? DEFAULT_CONFIG_DIR;
    this.#maxBlobBytes = opts.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
    this.#now = opts.now ?? Date.now;
    this.#ulid = opts.ulid ?? createUlidFactory(opts.now ?? Date.now);
    this.#crypto = opts.crypto ?? null;
    this.#protectPercent = opts.protectPercent ?? DEFAULT_PROTECT_PERCENT;
    this.#conflictMode = opts.conflictMode ?? "keep-both";
    this.#decideMassChange = opts.decideMassChange ?? null;
    this.#decideContinuity = opts.decideContinuity ?? null;
    this.#onProgress = opts.onProgress;
    this.#lanes = clampLanes(opts.lanes ?? DEFAULT_LANES);
  }

  /** Clears a halt after the operator has fixed the key mismatch that caused it. */
  reset(): void {
    if (this.status.phase === "halted" || this.status.phase === "error") {
      this.status = { phase: "idle" };
    }
  }

  /** Records exact event paths. Folder events request a full scan because they cover a subtree. */
  markDirty(paths: readonly string[], opts: { fullScan?: boolean } = {}): void {
    for (const path of paths) {
      if (path !== "") this.#dirtyPaths.add(path);
    }
    if (opts.fullScan === true) this.#dirtyRequiresFullScan = true;
  }

  async sync(opts: SyncPassOptions = {}): Promise<SyncResult> {
    const reroot = opts.reroot ?? null;
    const previewedHead = opts.previewedHead;
    // Rerooting is a publish, so it carries the same refusal and the same non-merging shape
    // as a forced push: reconciling first would only be work the operator has overruled.
    const keepLocal = opts.keepLocal === true || reroot !== null;
    if (keepLocal && this.#mode === "pull-only") {
      throw new Error(
        'sync direction is "pull-only", so this device never commits — it cannot push its ' +
          "files over the remote. Change the direction first."
      );
    }
    if (opts.pullOnly === true && keepLocal) {
      throw new Error("pullOnly cannot be combined with a forced push or a reroot");
    }
    // A downgrade only, and only from two-way. Applying it to `push-only` would reverse a
    // direction the operator set on purpose, which is not this option's business.
    this.#passMode = opts.pullOnly === true && this.#mode === "two-way" ? "pull-only" : this.#mode;
    if (this.status.phase === "halted") {
      return this.#result({ status: "halted", reason: this.status.message ?? "sync halted" });
    }
    // A pass must not interleave with a restore, a migration or a forced pull: those rewrite
    // the vault, and a pass that began halfway through one would plan against a snapshot that
    // is half old and half new. The scheduler already serialises passes against each other.
    if (this.status.phase === "syncing") throw new Error("sync is already running");
    const capturedDirty = [...this.#dirtyPaths];
    for (const path of capturedDirty) this.#dirtyPaths.delete(path);
    const capturedFullScan = this.#dirtyRequiresFullScan;
    this.#dirtyRequiresFullScan = false;
    this.status = { phase: "syncing" };
    try {
      return await this.#sync(keepLocal, reroot, previewedHead, {
        fullScan: opts.fullScan === true || capturedFullScan,
        dirtyPaths: capturedDirty,
      });
    } catch (e) {
      for (const path of capturedDirty) this.#dirtyPaths.add(path);
      if (capturedFullScan) this.#dirtyRequiresFullScan = true;
      if (e instanceof HaltError) return this.#halt(e.message);
      if (this.status.phase === "syncing") {
        this.status = { phase: "error", message: e instanceof Error ? e.message : String(e) };
      }
      throw e;
    }
  }

  #result(extra: Partial<SyncResult> & { status: SyncResult["status"] }): SyncResult {
    return {
      // Every `#state` assignment in a pass is followed by `#store.save`, so this is the head
      // the device will still be on after a reload — not an in-flight value.
      currentHead: this.#state?.lastSyncedHead ?? null,
      uploaded: 0,
      skipped: [],
      pushedChanges: [],
      pulledChanges: [],
      pulled: 0,
      merged: 0,
      conflicts: [],
      conflictDetails: [],
      ...extra,
    } as SyncResult;
  }

  #halt(reason: string, rest: Partial<ResultBase> = {}): SyncResult {
    this.status = { phase: "halted", message: reason };
    return this.#result({ status: "halted", reason, ...rest });
  }

  async #sync(
    forceKeepLocal = false,
    reroot: { previewedHead: string | null } | null = null,
    previewedHead?: string | null,
    requestedScan: { fullScan: boolean; dirtyPaths: string[] } = {
      fullScan: true,
      dirtyPaths: [],
    }
  ): Promise<SyncResult> {
    const loaded = this.#state ?? (await this.#store.load()) ?? {
      lastSyncedHead: null,
      files: pathMap<FileEntry>(),
    };
    const state: SyncState = { ...loaded, files: copyPathMap(loaded.files) };
    this.#state = state;

    // A changed master key (or encryption being switched on/off) invalidates every cached
    // ciphertext hash. Rebuilding from scratch re-encrypts and re-uploads everything, which
    // is exactly what re-keying means; reusing the cache would publish a snapshot whose
    // blobs are encrypted under a key its own keyId disclaims.
    const keyId = this.#crypto?.keyId ?? null;
    const hasPriorSnapshot = state.lastSyncedHead !== null || Object.keys(state.files).length > 0;
    const keyChanged = hasPriorSnapshot && (state.keyId ?? null) !== keyId;
    if (keyChanged) {
      return this.#halt(
        "the configured encryption mode or master key differs from the last synced snapshot; use the explicit migration action"
      );
    }

    // `baseFiles` is the logical snapshot this pass has absorbed. It advances after each
    // successful pull even though persisted state cannot advance until our CAS succeeds.
    // That makes a stale-head retry compare R2 against R1, not against the older persisted
    // base that preceded both remotes.
    let baseFiles = state.files;
    let baseHead = state.lastSyncedHead;
    /** Where this pass started, so an early return knows whether it absorbed anything. */
    const originalHead = state.lastSyncedHead;
    /**
     * The blobs the base snapshot already put on the server, so a pass can ask about the
     * ones it is *adding* rather than about its whole vault. Deliberately not derived from
     * `baseFiles`: case-collision resolution can place a local entry in that map, and a
     * local entry is exactly the case where the blob may not be uploaded yet.
     */
    let baseBlobs = new Set(Object.values(state.files).map(blobKey));
    /** Line counts for the snapshot this pass starts from; the baseline for every net figure. */
    const baseLines = state.lines;
    let incrementalScan =
      !requestedScan.fullScan &&
      requestedScan.dirtyPaths.length > 0 &&
      state.inventory !== undefined;
    const buildSnapshot = (): Promise<Snapshot> =>
      this.#buildSnapshot(
        incrementalScan
          ? {
              dirtyPaths: requestedScan.dirtyPaths,
              baseFiles: state.files,
              baseLines: state.lines ?? pathMap<number>(),
              baseInventory: state.inventory!,
            }
          : undefined
      );

    const outcome: MergeOutcome = { pulled: 0, merged: 0, pulledChanges: [], conflicts: [], conflictDetails: [] };

    // Two independent reasons to go round again, so two independent budgets: losing the head
    // race says another device is busy, a rescan says this vault is. Sharing one counter made
    // the "another device keeps committing" message lie about which happened.
    let casAttempt = 1;
    let rescans = 0;

    for (;;) {
      const serverHead = await this.#api.getHead();

      // A reroot is pinned to the snapshot the operator was shown. Every other pass treats a
      // moved head as something to merge and retry; this one cannot, because what it does to
      // the snapshot it did not review is delete it and every earlier version with it.
      if (reroot !== null && serverHead !== reroot.previewedHead) {
        throw new Error(
          `another device published ${serverHead ?? "an empty vault"} since this rebuild was ` +
            "previewed, so nothing was changed. Preview it again to see what rebuilding " +
            "would now discard."
        );
      }
      // A forced push is pinned the same way. Only on the FIRST attempt: a CAS retry is this
      // pass losing a race it should re-read, not the operator's preview going stale.
      if (previewedHead !== undefined && casAttempt === 1 && serverHead !== previewedHead) {
        throw new Error(
          `another device published ${serverHead ?? "an empty vault"} since this push was ` +
            "previewed, so nothing was published. Preview it again to see what it would now " +
            "leave out."
        );
      }

      let remoteFiles: Record<string, FileEntry> | null = null;
      let normalizedRemoteCollision = false;
      let remoteSkipped: SkippedFile[] = [];
      let pushOnlyConflictFiles = pathMap<FileEntry>();
      const pushAttemptOutcome: MergeOutcome = {
        pulled: 0,
        merged: 0,
        pulledChanges: [],
        conflicts: [],
        conflictDetails: [],
      };

      if (serverHead !== null && serverHead !== baseHead) {
        // A pass that touches the remote is a full audit from here on, and that has to include
        // the snapshot the plan is built from — not just the one that gets published. An
        // event journal describes edits, not the whole vault, so its `skipped` list covers
        // only journaled paths; planning against it would leave a locally oversized or
        // invalid file out of `untouchable` and let the remote copy overwrite it. Applying
        // the remote then touches paths the journal never mentioned either.
        incrementalScan = false;
        const remote = await this.#api.getManifest(serverHead);
        const mismatch = this.#modeError(remote, serverHead);
        if (mismatch !== null) return this.#halt(mismatch, outcome);

        // Deliberately before the descent check below, not after it: decrypting a v3 head is
        // also what authenticates its envelope, `parent` included, so the check reads a link
        // this device has verified rather than one the server merely asserted.
        remoteFiles = await this.#remoteFiles(remote);

        // "The head moved" is the ordinary case, and it is also what a served rollback looks
        // like. The difference is whether the snapshot this device already absorbed is an
        // ancestor of the one being offered. Forced pushes and reroots skip the check: they
        // were previewed against a named head and deliberately do not merge what they find.
        if (baseHead !== null && !forceKeepLocal && reroot === null && previewedHead === undefined) {
          const gap = await this.#verifyDescent(remote, baseHead, outcome.pulled);
          if (gap !== null) {
            const decision = this.#decideContinuity
              ? await this.#decideContinuity(gap)
              : "stop";
            if (decision !== "continue") {
              // Not a halt, for the same reason the mass-change guard is not one: the question
              // should re-raise itself on the next pass rather than wait for an explicit reset.
              await this.#persistAbsorbed(originalHead, baseHead, baseFiles, baseLines, keyId, outcome);
              this.status = { phase: "idle" };
              return this.#result({ status: "needs-continuity", continuity: gap, ...outcome });
            }
          }
        }

        // Captured before collision resolution can mix local entries in: these, and only
        // these, are the blobs the manifest we are about to parent onto references.
        const remoteBlobs = new Set(Object.values(remoteFiles).map(blobKey));

        const local = await buildSnapshot();
        remoteSkipped = local.skipped;
        const collisionResolution = this.#resolveRemoteCaseCollisions(
          remoteFiles,
          remote.device,
          local.occupiedPaths,
          local.files
        );
        remoteFiles = collisionResolution.files;
        normalizedRemoteCollision = collisionResolution.conflicts.length > 0;
        if (forceKeepLocal) {
          // Forced push. The remote head is absorbed as the CAS parent and as the source of
          // carried unscanned paths — nothing else. Planning it would only produce actions
          // the operator has explicitly overruled, and the guard would ask a question they
          // have already answered.
        } else if (this.#mode === "push-only") {
          const planned = this.#planPushOnly(
            baseFiles,
            local.files,
            remoteFiles,
            remote.device,
            untouchable(local.skipped),
            local.occupiedPaths
          );
          pushOnlyConflictFiles = planned.files;
          pushAttemptOutcome.conflicts.push(
            ...collisionResolution.conflicts,
            ...planned.outcome.conflicts
          );
          // Nothing in this branch touched the vault, so neither parked version is a file
          // here. Saying so is what keeps the review window from offering to keep one.
          pushAttemptOutcome.conflictDetails.push(
            ...[...collisionResolution.conflictDetails, ...planned.outcome.conflictDetails].map(
              (info): ConflictInfo => ({ ...info, snapshotOnly: true })
            )
          );
        } else {
          const plan = this.#planRemote(
            baseFiles,
            local.files,
            remoteFiles,
            untouchable(local.skipped)
          );

          const guard = massChangeSummary(plan, local.files, this.#protectPercent);
          let keepLocal = false;
          if (guard !== null) {
            const decision = this.#decideMassChange
              ? await this.#decideMassChange(guard)
              : "cancel";
            if (decision === "cancel") {
              // Deliberately not a halt: halts are sticky and need an explicit reset, but a
              // pending decision should re-raise itself on the next pass so the user can
              // answer it whenever they next sync.
              await this.#persistAbsorbed(originalHead, baseHead, baseFiles, baseLines, keyId, outcome);
              this.status = { phase: "idle" };
              return this.#result({
                status: "needs-decision",
                summary: guard,
                skipped: local.skipped,
                ...outcome,
              });
            }
            // "keep-local" skips the whole apply step; our scan then commits over the remote.
            // Nothing is lost server-side — the snapshot we are overwriting stays in the
            // manifest chain and can be restored.
            keepLocal = decision === "keep-local";
          }

          if (!keepLocal) {
            const applied = await this.#executePlan(plan, remote.device);
            outcome.pulled += applied.pulled;
            outcome.merged += applied.merged;
            outcome.pulledChanges.push(...applied.pulledChanges);
            outcome.conflicts.push(...applied.conflicts);
            outcome.conflictDetails.push(...applied.conflictDetails);
            outcome.conflicts.push(...collisionResolution.conflicts);
            outcome.conflictDetails.push(...collisionResolution.conflictDetails);
          }
        }

        // Whether the operator applied the remote or explicitly chose keep-local, R1 is
        // now the base of the decision embodied on disk. A subsequent CAS loss must merge
        // against R1 before attempting to parent onto R2.
        baseFiles = remoteFiles;
        baseHead = serverHead;
        baseBlobs = remoteBlobs;
      }

      if (this.#passMode === "pull-only") {
        if (remoteFiles !== null) {
          this.#state = {
            lastSyncedHead: baseHead,
            files: baseFiles,
            keyId,
            lines: carryLineCounts(baseFiles, applyLineDeltas(baseLines, outcome.pulledChanges), {}),
          };
          await this.#store.save(this.#state);
          this.status = { phase: "idle", lastSyncAt: this.#now() };
          return this.#result({
            status: "pulled",
            head: baseHead!,
            skipped: remoteSkipped,
            ...outcome,
          });
        }
        this.status = { phase: "idle", lastSyncAt: this.#now() };
        return this.#result({ status: "unchanged", ...outcome });
      }

      // What our commit will be layered on: the snapshot we are about to parent onto.
      const { files, skipped, lines: freshLines, inventory } = await buildSnapshot();
      const carried = this.#carry(baseFiles, untouchable(skipped));

      // Excludes govern discovery, so a prior remote-only entry remains part of the
      // logical snapshot. On a key change, however, its old ciphertext cannot be placed in
      // a manifest claiming the new key. Refuse the publish unless a newly-readable remote
      // already supplied entries under the configured key.
      const keyMigrationPending = keyChanged && remoteFiles === null;
      if (keyMigrationPending && Object.keys(carried).length > 0) {
        return this.#halt(
          "cannot change the vault key while the current snapshot contains excluded or otherwise unscanned files; they cannot be re-encrypted safely on this device",
          { skipped, ...outcome }
        );
      }

      const finalFiles = mergePathMaps(mergePathMaps(carried, files), pushOnlyConflictFiles);

      // A reroot commits even when nothing changed: discarding history IS the change, and
      // "your files already match" is not an answer to "stop storing the old versions".
      if (reroot === null && remoteFiles === null && !keyMigrationPending && sameFiles(finalFiles, baseFiles)) {
        this.#state = {
          lastSyncedHead: baseHead,
          files: finalFiles,
          keyId,
          lines: carryLineCounts(finalFiles, baseLines, freshLines),
          inventory,
        };
        await this.#store.save(this.#state);
        this.status = { phase: "idle", lastSyncAt: this.#now() };
        return this.#result({
          status: "unchanged",
          skipped,
          ...mergeOutcomes(outcome, pushAttemptOutcome),
        });
      }

      if (
        reroot === null &&
        remoteFiles !== null &&
        !normalizedRemoteCollision &&
        !keyMigrationPending &&
        sameFiles(finalFiles, baseFiles)
      ) {
        // Everything the remote had, we now have, and we added nothing — no commit needed.
        this.#state = {
          lastSyncedHead: baseHead,
          files: finalFiles,
          keyId,
          lines: carryLineCounts(finalFiles, baseLines, freshLines),
          inventory,
        };
        await this.#store.save(this.#state);
        this.status = { phase: "idle", lastSyncAt: this.#now() };
        return this.#result({
          status: "pulled",
          head: baseHead!,
          skipped,
          ...mergeOutcomes(outcome, pushAttemptOutcome),
        });
      }

      const hashes = [...new Set(Object.values(finalFiles).map(blobKey))];
      // Ask only about the blobs this commit ADDS, which is the same rule the Durable
      // Object applies when it verifies the commit (`newHashes = manifest − parent`).
      // Anything the parent already references is on the server: the parent is the head, so
      // GC retains its blobs — and a reference inherited from the parent is not something
      // this pass could repair anyway, since a carried remote-only path has no local bytes
      // to re-upload. Commit still checks, and still fails loud, either way. A reroot
      // parents onto nothing and an empty remote has nothing, so both ask about everything.
      const onParent = reroot === null && serverHead !== null ? baseBlobs : new Set<string>();
      const missing = await this.#api.checkBlobs(hashes.filter((h) => !onParent.has(h)));
      // One pass over the snapshot instead of a scan per upload: at a few thousand files
      // the old find-per-hash was the slowest part of a first sync, not the network.
      // Only freshly scanned paths can be re-read. A carried remote-only entry may share
      // the same blob, so index the local map rather than accidentally choosing that path.
      const pathByBlob = indexByBlob(files);
      let done = 0;
      let uploaded = missing.length;

      let head: string;
      try {
        await mapPool(missing, this.#lanes, async (hash) => {
          await this.#uploadHash(hash, pathByBlob, files);
          this.#onProgress?.({ phase: "upload", done: ++done, total: missing.length });
        });

        // A reroot's parent is null while its CAS token is still the head this pass saw. If
        // that race is lost, the retry above refuses outright rather than rerooting over the
        // winner: for this one pass a stale head is not something to merge and try again.
        const manifest = await this.#buildManifest(reroot !== null ? null : serverHead, finalFiles, hashes);
        try {
          head = await this.#api.commit(manifest, serverHead, { reroot: reroot !== null });
        } catch (e) {
          if (!(e instanceof MissingBlobError)) throw e;
          // Blob vanished between check and commit (GC race). Re-upload exactly once.
          await mapPool(e.hashes, this.#lanes, async (hash) => {
            await this.#uploadHash(hash, pathByBlob, files);
            uploaded++;
          });
          head = await this.#api.commit(manifest, serverHead, { reroot: reroot !== null });
        }
      } catch (e) {
        if (e instanceof FileChangedError) {
          // The vault moved while we were publishing it. Rescanning is the whole fix: the next
          // turn of this loop rebuilds the snapshot from what the files have become. Failing
          // here instead would leave an ordinary edit-while-syncing looking like an error.
          if (rescans >= MAX_RESCAN_ATTEMPTS) {
            throw new Error(
              `"${e.path}" kept changing while sync was reading it (${rescans + 1} attempts). ` +
                "Nothing was published. Try again once the file settles.",
              { cause: e }
            );
          }
          rescans++;
          continue;
        }
        if (!(e instanceof StaleHeadError)) throw e;
        // Someone committed while we were building. Go round again and merge their work
        // in too; the vault on disk already holds everything we resolved this pass.
        if (casAttempt >= MAX_COMMIT_ATTEMPTS) {
          return this.#halt(
            `gave up after ${casAttempt} attempts: another device keeps committing (remote head ${e.head ?? "null"}). Try again when it settles.`,
            { skipped, ...outcome }
          );
        }
        casAttempt++;
        continue;
      }

      this.#state = {
        lastSyncedHead: head,
        files: finalFiles,
        keyId,
        lines: carryLineCounts(finalFiles, baseLines, freshLines),
        inventory,
      };
      await this.#store.save(this.#state);
      this.status = { phase: "idle", lastSyncAt: this.#now() };
      return this.#result({
        status: "committed",
        head,
        uploaded,
        skipped,
        pushedChanges: pushedChangesOf(baseFiles, finalFiles, baseLines, freshLines),
        ...mergeOutcomes(outcome, pushAttemptOutcome),
      });
    }
  }

  /**
   * Atomically transforms the current remote snapshot from this engine's crypto mode to
   * `targetCrypto`. Ordinary sync never relaxes mode/key checks: a migration is an explicit
   * operation with two distinct cryptographic contexts and one CAS commit.
   *
   * Local files are read only for the convergence preflight. Every snapshot entry,
   * including excluded or remote-only paths, is downloaded and authenticated with the
   * source crypto, transformed with the target crypto, and committed as one child.
   */
  async migrateEncryption(targetCrypto: VaultCrypto | null): Promise<EncryptionMigrationResult> {
    if (this.status.phase === "syncing") throw new Error("sync is already running");
    this.status = { phase: "syncing" };
    try {
      const result = await this.#migrateEncryption(targetCrypto);
      this.status = { phase: "idle", lastSyncAt: this.#now() };
      return result;
    } catch (error) {
      this.status = {
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  async #migrateEncryption(targetCrypto: VaultCrypto | null): Promise<EncryptionMigrationResult> {
    const sourceKeyId = this.#crypto?.keyId ?? null;
    const targetKeyId = targetCrypto?.keyId ?? null;
    if (sourceKeyId === targetKeyId) {
      throw new Error("target encryption mode and key already match the current mode");
    }

    const loaded = this.#state ?? (await this.#store.load());
    if (loaded === null || loaded.lastSyncedHead === null) {
      throw new Error("sync under the current encryption mode first before migrating");
    }
    const state: SyncState = { ...loaded, files: copyPathMap(loaded.files) };
    this.#state = state;
    if ((state.keyId ?? null) !== sourceKeyId) {
      throw new Error("sync under the current encryption mode first before migrating");
    }

    const expectedHead = state.lastSyncedHead;
    if (expectedHead === null) {
      throw new Error("sync under the current encryption mode first before migrating");
    }
    const serverHead = await this.#api.getHead();
    if (serverHead !== expectedHead) {
      throw new Error("sync under the current encryption mode first before migrating");
    }
    const sourceManifest = await this.#api.getManifest(expectedHead);
    const mismatch = this.#modeError(sourceManifest, expectedHead);
    if (mismatch !== null) throw new Error(mismatch);
    const sourceFiles = await this.#remoteFiles(sourceManifest);

    // A migration never merges or chooses sides. The source-mode vault must first be a
    // faithful view of the head; excluded remote-only paths are carried into this check.
    const local = await this.#buildSnapshot();
    const converged = mergePathMaps(
      this.#carry(sourceFiles, untouchable(local.skipped)),
      local.files
    );
    if (!sameFiles(converged, sourceFiles)) {
      throw new Error("sync under the current encryption mode first before migrating");
    }

    const paths = Object.keys(sourceFiles).sort();
    const transformed = await mapPool(paths, this.#lanes, async (path) => ({
      path,
      entry: await this.#transformEntry(sourceFiles[path], targetCrypto),
    }));
    const targetFiles = pathMap<FileEntry>();
    for (const { path, entry } of transformed) targetFiles[path] = entry;

    const hashes = [...new Set(Object.values(targetFiles).map(blobKey))];
    const missing = await this.#api.checkBlobs(hashes);
    const targetPathByBlob = indexByBlob(targetFiles);
    let uploaded = 0;
    const upload = async (hash: string) => {
      const path = targetPathByBlob.get(hash);
      if (path === undefined) throw new Error(`internal: no migration path holds blob ${hash}`);
      const plain = await this.#fetchWithCrypto(sourceFiles[path], this.#crypto);
      const stored = targetCrypto === null
        ? plain
        : await targetCrypto.encryptBlob(sourceFiles[path].h, plain);
      const actual = await sha256Hex(stored);
      if (actual !== hash) {
        throw new Error(`internal: migrated blob for "${path}" is ${actual}, expected ${hash}`);
      }
      await this.#api.putBlob(hash, stored);
      uploaded++;
    };
    await mapPool(missing, this.#lanes, upload);

    const manifest = await this.#buildManifestWithCrypto(
      targetCrypto,
      expectedHead,
      targetFiles,
      hashes
    );
    let head: string;
    try {
      try {
        head = await this.#api.commit(manifest, expectedHead);
      } catch (error) {
        if (!(error instanceof MissingBlobError)) throw error;
        await mapPool(error.hashes, this.#lanes, upload);
        head = await this.#api.commit(manifest, expectedHead);
      }
    } catch (error) {
      if (error instanceof StaleHeadError) {
        throw new Error(
          "remote head changed during encryption migration; sync under the old mode and retry",
          { cause: error }
        );
      }
      throw error;
    }

    // Re-encrypting changes ciphertext, never a line of anyone's text, so the cached counts
    // carry over. Dropping them would make the next pass report an unattributable vault.
    this.#state = {
      lastSyncedHead: head,
      files: targetFiles,
      keyId: targetKeyId,
      lines: carryLineCounts(targetFiles, this.#state?.lines, {}),
    };
    await this.#store.save(this.#state);
    return { head, uploaded, files: paths.length };
  }

  async #transformEntry(entry: FileEntry, targetCrypto: VaultCrypto | null): Promise<FileEntry> {
    const plain = await this.#fetchWithCrypto(entry, this.#crypto);
    // Re-encrypting changes the ciphertext, never a line of anyone's text, so the recorded
    // count carries over unchanged. Dropping it would blank the history diff for every file
    // a migration touched.
    const carried = entry.lines === undefined ? {} : { lines: entry.lines };
    if (targetCrypto === null) {
      return { h: entry.h, size: entry.size, mtime: entry.mtime, ...carried };
    }
    const cipher = await targetCrypto.encryptBlob(entry.h, plain);
    return {
      h: entry.h,
      size: entry.size,
      mtime: entry.mtime,
      ...carried,
      c: await sha256Hex(cipher),
    };
  }

  /**
   * Why the remote snapshot cannot be read at all, or null if it can. Encryption mismatches
   * are checked only for non-empty snapshots: an empty one carries no content to misread,
   * so a new encrypted device can adopt an empty plaintext head cleanly.
   */
  /**
   * Whether a halt reason means "this device holds the wrong master key" — the one sync
   * failure with a specific cure, so the UI can offer it. Deliberately a predicate over the
   * messages `#modeError` produces, kept next to them: `plugin/test/force-sync.spec.ts` pins
   * the pairing, so editing one of those strings without the other fails a test.
   */
  static isWrongKeyHalt(reason: string): boolean {
    return /different master key|no vault master key is set/.test(reason);
  }

  #modeError(remote: Manifest, head: string): string | null {
    if (isEmptyManifest(remote)) return null;

    // Every encrypted version, not just v2. Missing this for v3 turned a wrong-key or
    // no-key head into a generic AES failure deep in `#remoteFiles` instead of the sticky
    // halt that names the problem and points at the setup link — and an unrecognised failure
    // is retried automatically, forever.
    if (isEncryptedManifest(remote) && this.#crypto === null) {
      return `remote snapshot at ${head} is encrypted, but no vault master key is set on this device. Add the key in settings before syncing.`;
    }
    if (remote.v === 1 && this.#crypto !== null) {
      return `remote snapshot at ${head} is unencrypted, but this device has encryption enabled. Committing would mix modes; reset the remote or clear the master key first.`;
    }
    if (isEncryptedManifest(remote) && this.#crypto !== null && remote.keyId !== this.#crypto.keyId) {
      return `remote snapshot at ${head} was encrypted with a different master key (remote ${remote.keyId}, ours ${this.#crypto.keyId}). Sync would be unreadable; check the key before continuing.`;
    }
    return null;
  }

  async #remoteFiles(remote: Manifest): Promise<Record<string, FileEntry>> {
    if (remote.v === 1) return copyPathMap(remote.files);
    if (this.#crypto === null) throw new HaltError("remote is encrypted and no master key is set");
    // v2 authenticates only the ciphertext; v3 authenticates the header it arrived in, so a
    // spliced envelope fails here rather than being planned as ordinary remote edits.
    const files = copyPathMap(
      parseFileEntries(
        await this.#crypto.decryptJson(remote.enc, remote.v === 3 ? manifestAad(remote) : undefined)
      )
    );
    if (remote.v === 3) {
      // The outer list is what the server verifies at commit and what GC treats as live.
      // If it disagrees with what the entries actually reference, the two views of this
      // snapshot are not the same snapshot.
      const inner = new Set(Object.values(files).map(blobKey));
      const outer = new Set(remote.blobs);
      if (inner.size !== outer.size || [...inner].some((hash) => !outer.has(hash))) {
        throw new HaltError(
          `snapshot ${remote.id} lists ${outer.size} blob(s) but its entries reference ${inner.size}`
        );
      }
    }
    return files;
  }

  /**
   * Paths the remote tracks but this device does not scan — excluded by glob, or skipped as
   * oversized/invalid. They are copied into our snapshot untouched, because dropping them
   * would delete another device's files just for not matching our local settings.
   */
  #carry(
    parentFiles: Record<string, FileEntry>,
    skippedPaths: Set<string>
  ): Record<string, FileEntry> {
    const carried = pathMap<FileEntry>();
    for (const [path, entry] of Object.entries(parentFiles)) {
      if (
        this.#notScanned(path) ||
        skippedPaths.has(path) ||
        (this.#mode === "push-only" && isGeneratedConflictPath(path))
      ) {
        carried[path] = entry;
      }
    }
    return carried;
  }

  /**
   * A remote manifest can be produced on a case-sensitive filesystem but pulled onto a
   * case-insensitive one. Planning `Note.md` and `note.md` as separate writes would then
   * silently overwrite whichever lane finished first. Collapse each case-folded group
   * before planning: an existing local spelling wins, otherwise a tracked remote spelling
   * wins deterministically, and every loser gets a collision-safe conflict-copy path.
   */
  #resolveRemoteCaseCollisions(
    remote: Record<string, FileEntry>,
    remoteDevice: string,
    occupiedPaths: string[],
    localEntries: Record<string, FileEntry> | null = null
  ): RemoteCollisionResolution {
    const groups = new Map<string, string[]>();
    const remotePaths = Object.keys(remote).sort();
    for (const path of remotePaths) {
      const folded = foldPath(path);
      const group = groups.get(folded);
      if (group === undefined) groups.set(folded, [path]);
      else group.push(path);
    }

    const occupied = new Set([...occupiedPaths, ...remotePaths].map(foldPath));
    const files = pathMap<FileEntry>();
    const conflicts: string[] = [];
    const conflictDetails: ConflictInfo[] = [];
    const protectedLocalPaths: string[] = [];
    const localByFold = new Map<string, string[]>();
    for (const path of occupiedPaths) {
      const folded = foldPath(path);
      const group = localByFold.get(folded);
      if (group === undefined) localByFold.set(folded, [path]);
      else if (!group.includes(path)) group.push(path);
    }

    const park = (
      source: string,
      canonical: string,
      kept: "ours" | "theirs",
      oursEntry: FileEntry | undefined,
      theirsEntry: FileEntry
    ) => {
      let copy: string;
      for (let sequence = 1; ; sequence++) {
        const candidate = conflictPath(source, remoteDevice, this.#now(), sequence);
        const folded = foldPath(candidate);
        if (occupied.has(folded)) continue;
        occupied.add(folded);
        copy = candidate;
        break;
      }
      const sourceEntry = remote[source];
      files[copy] = sourceEntry;
      conflicts.push(copy);
      conflictDetails.push({
        path: canonical,
        copy,
        kept,
        ours: oursEntry === undefined ? { mtime: 0, size: 0 } : entryStats(oursEntry),
        theirs: entryStats(theirsEntry),
      });
    };

    for (const group of groups.values()) {
      group.sort();
      const localGroup = [...(localByFold.get(foldPath(group[0])) ?? [])].sort();
      const localVariants = localGroup.filter((path) => !group.includes(path));

      // If the vault already contains a different spelling, writing any remote member at
      // its original path is an overwrite on case-insensitive filesystems. The existing
      // local spelling stays canonical; every remote spelling is parked. When that local
      // path is tracked, include its current entry in the normalized snapshot so a remote
      // case-only rename is not mistaken for a deletion. Excluded/skipped paths are merely
      // protected on disk and remain outside the manifest.
      if (localVariants.length > 0) {
        const canonical =
          localVariants.find((path) => !this.#notScanned(path)) ?? localVariants[0];
        const canonicalEntry = localEntries?.[canonical];
        if (canonicalEntry !== undefined) files[canonical] = canonicalEntry;
        protectedLocalPaths.push(canonical);
        for (const source of group) {
          park(source, canonical, "ours", canonicalEntry, remote[source]);
        }
        continue;
      }

      // A device that does not track any spelling in this group must preserve the remote
      // snapshot byte-for-byte. Renaming excluded/config-disabled entries would turn a
      // local policy choice into an unrelated remote mutation.
      if (group.every((path) => this.#notScanned(path))) {
        for (const path of group) files[path] = remote[path];
        continue;
      }
      // Prefer a spelling this device actually tracks. Otherwise an exact allow-list such
      // as `note.md` could have its selected path renamed merely because an untracked
      // `Note.md` sorts first.
      const winner =
        group.find((path) => localGroup.includes(path)) ??
        group.find((path) => !this.#notScanned(path))!;
      const winnerEntry = remote[winner];
      files[winner] = winnerEntry;

      for (const loser of group.filter((path) => path !== winner)) {
        park(loser, winner, "theirs", remote[loser], winnerEntry);
      }
    }
    return { files, conflicts, conflictDetails, protectedLocalPaths };
  }

  /**
   * Decides every path's fate without acting on any of it. Splitting the decision from the
   * execution is what lets the mass-change guard veto a plan, and what lets `preview()`
   * report one without side effects.
   */
  #planRemote(
    base: Record<string, FileEntry>,
    ours: Record<string, FileEntry>,
    theirs: Record<string, FileEntry>,
    untouchablePaths: Set<string>
  ): PlannedAction[] {
    const paths = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
    const actions: PlannedAction[] = [];

    for (const path of [...paths].sort()) {
      if (this.#notScanned(path) || untouchablePaths.has(path)) continue;
      const plan = planFile(base[path], ours[path], theirs[path]);
      if (plan === "none") continue;
      actions.push({ path, plan, base: base[path], ours: ours[path], theirs: theirs[path] });
    }
    return actions;
  }

  /**
   * Computes the manifest-only reconciliation used by push-only mode. The vault is never
   * touched: a locally tracked path remains canonical, while a concurrently changed remote
   * value is parked as a deterministic conflict entry in the new snapshot. Untracked paths
   * are handled separately by `#carry` and remain exactly as the remote supplied them.
   */
  #planPushOnly(
    base: Record<string, FileEntry>,
    ours: Record<string, FileEntry>,
    theirs: Record<string, FileEntry>,
    remoteDevice: string,
    untouchablePaths: Set<string>,
    occupiedPaths: string[]
  ): { files: Record<string, FileEntry>; outcome: MergeOutcome } {
    const files = pathMap<FileEntry>();
    const outcome: MergeOutcome = {
      pulled: 0,
      merged: 0,
      pulledChanges: [],
      conflicts: [],
      conflictDetails: [],
    };
    const paths = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
    const occupied = new Set(
      [...occupiedPaths, ...Object.keys(base), ...Object.keys(theirs)].map(foldPath)
    );

    for (const path of [...paths].sort()) {
      if (this.#notScanned(path) || untouchablePaths.has(path)) continue;
      const before = base[path];
      const local = ours[path];
      const remote = theirs[path];

      // A path first created remotely is not evidence of a local deletion. Preserve it as
      // canonical; after this head is recorded a later local deletion can propagate.
      if (before === undefined && local === undefined && remote !== undefined) {
        files[path] = remote;
        continue;
      }
      if (sameEntry(remote, before) || sameEntry(local, remote) || remote === undefined) {
        continue;
      }

      let copy: string;
      for (let sequence = 1; ; sequence++) {
        const candidate = conflictPath(path, remoteDevice, this.#now(), sequence);
        const folded = foldPath(candidate);
        if (occupied.has(folded)) continue;
        occupied.add(folded);
        copy = candidate;
        break;
      }
      files[copy] = remote;
      outcome.conflicts.push(copy);
      outcome.conflictDetails.push({
        path,
        copy,
        kept: "ours",
        ours: local === undefined ? { mtime: 0, size: 0 } : entryStats(local),
        theirs: entryStats(remote),
      });
    }
    return { files, outcome };
  }

  /**
   * Brings the vault on disk up to date with the remote, merging where both sides moved.
   *
   * Actions run several at a time, but each returns its own outcome and they are folded in
   * plan order, so the conflict list a user sees is the same whatever order downloads
   * finish in. Conflict-copy names cannot collide across lanes either: a candidate name is
   * derived from its own source path, and every path is planned exactly once.
   */
  async #executePlan(plan: PlannedAction[], remoteDevice: string): Promise<MergeOutcome> {
    const todo = plan.filter((a) => a.plan !== "keep-ours");
    let done = 0;

    const each = await mapPool(todo, this.#lanes, async (action) => {
      const out: MergeOutcome = { pulled: 0, merged: 0, pulledChanges: [], conflicts: [], conflictDetails: [] };
      switch (action.plan) {
        case "delete-local":
          await this.#vault.remove(action.path);
          out.pulled++;
          out.pulledChanges.push(this.#localChange(action.path, "delete", null));
          break;
        case "take-theirs": {
          const bytes = await this.#fetch(action.theirs!);
          await this.#vault.write(action.path, bytes);
          out.pulled++;
          out.pulledChanges.push(
            this.#localChange(action.path, action.ours === undefined ? "add" : "update", bytes)
          );
          break;
        }
        case "merge":
          await this.#mergeOne(
            action.path,
            action.base,
            action.ours!,
            action.theirs!,
            remoteDevice,
            out
          );
          break;
      }
      this.#onProgress?.({ phase: "pull", done: ++done, total: todo.length });
      return out;
    });

    // A folder is only ever the parent of a file, so a pulled tree move deletes the files and
    // leaves the old skeleton standing. Sequential and after the pool: lanes racing on shared
    // ancestors is a TOCTOU generator, and deepest-first only converges when a parent is
    // checked after its child has gone. A throw above skips this; the next pass catches up.
    const deleted = todo.filter((a) => a.plan === "delete-local").map((a) => a.path);
    for (const dir of pruneCandidates(deleted, this.#configDir)) {
      await this.#vault.removeFolderIfEmpty(dir);
    }

    const total: MergeOutcome = { pulled: 0, merged: 0, pulledChanges: [], conflicts: [], conflictDetails: [] };
    for (const one of each) {
      total.pulled += one.pulled;
      total.merged += one.merged;
      total.pulledChanges.push(...one.pulledChanges);
      total.conflicts.push(...one.conflicts);
      total.conflictDetails.push(...one.conflictDetails);
    }
    return total;
  }

  /**
   * Reports what a sync would do right now. Reads the vault and the remote manifest, writes
   * nothing, uploads nothing, commits nothing and leaves the persisted state untouched.
   */
  async preview(): Promise<SyncPreview> {
    const loaded = this.#state ?? (await this.#store.load()) ?? {
      lastSyncedHead: null,
      files: pathMap<FileEntry>(),
    };
    const state: SyncState = { ...loaded, files: copyPathMap(loaded.files) };
    this.#state = state;
    const keyId = this.#crypto?.keyId ?? null;
    const hasPriorSnapshot = state.lastSyncedHead !== null || Object.keys(state.files).length > 0;
    const keyChanged = hasPriorSnapshot && (state.keyId ?? null) !== keyId;
    const serverHead = await this.#api.getHead();

    let remoteFiles: Record<string, FileEntry> | null = null;
    let remoteDevice: string | null = null;
    let continuity: ContinuitySummary | undefined;
    if (serverHead !== null && serverHead !== state.lastSyncedHead) {
      const remote = await this.#api.getManifest(serverHead);
      const mismatch = this.#modeError(remote, serverHead);
      if (mismatch !== null) {
        return { head: serverHead, pull: [], push: [], skipped: [], guard: null, halted: mismatch };
      }
      // Same ordering rule as the pass: decrypting the head is what authenticates its
      // envelope, so the walk below reads a verified parent link.
      remoteFiles = await this.#remoteFiles(remote);
      // Preview is read-only, so this reports rather than asks — but it must report, or the
      // window a cautious user opens *before* syncing is the one place that stays quiet.
      // Nothing has been applied by definition here, hence the zero.
      if (state.lastSyncedHead !== null) {
        continuity = (await this.#verifyDescent(remote, state.lastSyncedHead, 0)) ?? undefined;
      }
      remoteDevice = remote.device;
    }

    const keyMigrationPending = keyChanged && remoteFiles === null;
    const local = await this.#buildSnapshot();
    const remoteSnapshotFiles = copyPathMap(remoteFiles ?? state.files);
    if (remoteFiles !== null && remoteDevice !== null) {
      remoteFiles = this.#resolveRemoteCaseCollisions(
        remoteFiles,
        remoteDevice,
        local.occupiedPaths,
        local.files
      ).files;
    }

    if (
      keyMigrationPending &&
      Object.keys(this.#carry(state.files, untouchable(local.skipped))).length > 0
    ) {
      return {
        head: serverHead,
        pull: [],
        push: [],
        skipped: local.skipped,
        guard: null,
        halted:
          "cannot change the vault key while the current snapshot contains excluded or otherwise unscanned files; they cannot be re-encrypted safely on this device",
      };
    }

    if (this.#mode === "push-only") {
      const current = remoteFiles ?? state.files;
      const planned = this.#planPushOnly(
        state.files,
        local.files,
        current,
        remoteDevice ?? "remote",
        untouchable(local.skipped),
        local.occupiedPaths
      );
      const finalFiles = mergePathMaps(
        this.#carry(current, untouchable(local.skipped)),
        local.files,
        planned.files
      );
      return {
        head: serverHead,
        pull: [],
        push: diffSnapshot(remoteSnapshotFiles, finalFiles),
        skipped: local.skipped,
        guard: null,
        continuity,
      };
    }

    // With the remote unmoved, "theirs" is our last synced state: every local change then
    // shows up as keep-ours, which is exactly the push list.
    const plan = this.#planRemote(
      state.files,
      local.files,
      remoteFiles ?? state.files,
      untouchable(local.skipped)
    );

    const pull: PreviewAction[] = [];
    const push: PreviewAction[] = [];
    for (const a of plan) {
      switch (a.plan) {
        case "delete-local":
          pull.push({ path: a.path, action: "delete" });
          break;
        case "take-theirs":
          pull.push({ path: a.path, action: "write" });
          break;
        case "merge":
          pull.push({ path: a.path, action: "merge" });
          push.push({ path: a.path, action: "update" });
          break;
        case "keep-ours":
          if (a.ours === undefined) push.push({ path: a.path, action: "delete" });
          else if (a.theirs === undefined) push.push({ path: a.path, action: "add" });
          else push.push({ path: a.path, action: "update" });
          break;
      }
    }

    if (keyMigrationPending) {
      const alreadyPushed = new Set(push.map((a) => a.path));
      for (const path of Object.keys(local.files).sort()) {
        if (!alreadyPushed.has(path)) push.push({ path, action: "update" });
      }
    }

    return {
      head: serverHead,
      pull,
      push: this.#mode === "pull-only" ? [] : push,
      skipped: local.skipped,
      guard: massChangeSummary(plan, local.files, this.#protectPercent),
      continuity,
    };
  }

  /** True for paths this device does not put in its own snapshots. */
  #notScanned(path: string): boolean {
    return (
      alwaysSkip(path, this.#configDir) ||
      pathError(path) !== null ||
      (!this.#syncConfigDir && isConfigPath(path, this.#configDir)) ||
      this.#isExcluded(path) ||
      (this.#hasOnlyPaths && !this.#isIncluded(path))
    );
  }

  /**
   * Records what this pass has already absorbed, when it stops to ask something after an
   * earlier turn of the loop already applied a verified remote to disk.
   *
   * Without this, a pass that absorbed R1, lost the head race, and then stopped on R2 would
   * leave the vault holding R1's files while persisted state still named R0 — and the next
   * pass would read everything it had just pulled as new local work. Saving the absorbed base
   * is also what makes the question re-raise against the right snapshot. A no-op when nothing
   * was absorbed, which is the usual case.
   *
   * `inventory` is deliberately dropped: files were just written underneath the discovery
   * cache, so the next pass has to be a full scan.
   */
  async #persistAbsorbed(
    originalHead: string | null,
    baseHead: string | null,
    baseFiles: Record<string, FileEntry>,
    baseLines: LineCounts | undefined,
    keyId: string | null,
    outcome: MergeOutcome
  ): Promise<void> {
    if (baseHead === originalHead) return;
    this.#state = {
      lastSyncedHead: baseHead,
      files: baseFiles,
      keyId,
      lines: carryLineCounts(baseFiles, applyLineDeltas(baseLines, outcome.pulledChanges), {}),
    };
    await this.#store.save(this.#state);
  }

  /**
   * True when this manifest's envelope — `parent` included — is bound to its ciphertext by
   * AES-GCM AAD under *this device's* key. False when the format cannot prove it (v1, v2) or
   * the key cannot (a snapshot from before an encryption migration).
   *
   * A predicate, not a verification: the caller is responsible for having decrypted the
   * manifest, which is what actually performs the check.
   */
  #envelopeIsAuthenticated(m: Manifest): m is ManifestV3 {
    return m.v === 3 && this.#crypto !== null && m.keyId === this.#crypto.keyId;
  }

  /**
   * Confirms that `remote` grew out of the snapshot this device last absorbed, by walking its
   * parent links back until `lastHead` turns up. Returns null when it does — the ordinary "we
   * are behind" case — and otherwise says why it could not be found.
   *
   * This is the no-crypto half of rollback detection. `lastSyncedHead` is a local monotonic
   * checkpoint: a server that serves an older snapshot, or a different history altogether,
   * cannot make this device's own record of what it published go away.
   *
   * **What the walk trusts is the parent links, so it verifies every one it follows.** A v3
   * manifest binds its envelope — `parent` included — to its ciphertext under the vault key,
   * and `#remoteFiles` has already decrypted the head by the time this runs. Each ancestor is
   * decrypted here for the same reason. Without that, an id check alone is no defence: the
   * server can answer a request for an authenticated ancestor id with a forged v1 envelope
   * carrying that id and a `parent` pointing at `lastHead`, and the walk would report
   * continuity for a chain nobody signed.
   *
   * The walk therefore runs in one of two grades, decided by the head:
   *
   * - **Authenticated** (v3 under our key). Every link is verified. Reaching a manifest that
   *   cannot be — an older version, or a key from before a migration — ends the walk as
   *   `unauthenticated` rather than silently finishing the proof on the server's word.
   * - **Best effort** (v1 plaintext, or v2, which never bound its header). Nothing here can be
   *   verified, so nothing pretends to be: the check still catches accident — a restored
   *   bucket, a reset Durable Object, a mistaken reroot — but not a forging server, and it
   *   does not raise `unauthenticated` questions it has no evidence behind.
   *
   * A repeated id is corruption around the one-use rule rather than an ambiguity, so it throws
   * instead of asking anyone: the walk cannot terminate and no answer would be safe. So does a
   * v3 ancestor under our own key whose envelope fails to authenticate — that is tampering, not
   * a question for the user.
   */
  async #verifyDescent(
    remote: Manifest,
    lastHead: string,
    alreadyApplied: number
  ): Promise<ContinuitySummary | null> {
    const seen = new Set<string>([remote.id]);
    let parent = remote.parent;
    let walked = 1;
    // Non-null exactly when the head's own envelope is authenticated, which is what decides
    // the grade for the whole walk. Held as the key itself so every ancestor is verified with
    // the one the head was verified under.
    const verifier = this.#envelopeIsAuthenticated(remote) ? this.#crypto : null;
    const gap = (reason: ContinuityReason): ContinuitySummary => ({
      head: remote.id,
      lastHead,
      reason,
      walked,
      alreadyApplied,
    });

    for (;;) {
      if (parent === lastHead) return null;
      if (parent === null) return gap("replaced");
      if (seen.has(parent)) {
        throw new Error(
          `the remote snapshot chain loops back to ${parent}; refusing to sync against it`
        );
      }
      if (walked >= MAX_DESCENT_STEPS) return gap("limit");
      seen.add(parent);
      let ancestor: Manifest;
      try {
        ancestor = await this.#api.getManifest(parent);
      } catch (e) {
        // Only "that snapshot is gone" ends the walk. A transport or auth failure is this
        // pass failing, not evidence about the remote's history, and must not be dressed up
        // as one — the scheduler's retry policy exists for exactly that difference.
        if (!(e instanceof ApiError) || e.status !== 404) throw e;
        return gap("truncated");
      }
      if (verifier !== null) {
        if (!this.#envelopeIsAuthenticated(ancestor)) return gap("unauthenticated");
        // The decryption IS the check: AES-GCM authenticates the AAD, and `manifestAad`
        // covers `parent`. Throws on failure, which is the correct answer to a forgery.
        await verifier.decryptJson(ancestor.enc, manifestAad(ancestor));
      }
      parent = ancestor.parent;
      walked++;
    }
  }

  /**
   * Walks the snapshot chain back from the current head. Stops early at a missing ancestor
   * (garbage collection trims old manifests by design) and marks — rather than throws on —
   * a snapshot this device's key cannot open, so one unreadable entry does not hide the
   * readable history behind it.
   */
  async listHistory(limit: number, opts: HistoryOptions = {}): Promise<HistoryListing> {
    const granularity = opts.granularity ?? "sync";
    const wantChanges = opts.changes === true;

    const chain = await this.#collectChain(limit, granularity, opts);
    // Only a chain the server can vouch for end to end. A partial index would list fewer
    // snapshots than the walk finds, and quietly showing less history than exists is worse
    // than being slow — so anything short falls back rather than truncating what the user sees.
    if (chain === null) {
      const walked = await this.#listHistoryByWalk(limit, { changes: wantChanges });
      // The walk has no `uploadedAt` — only each manifest's own `createdAt`, a device clock —
      // and it reaches back `limit` snapshots from the head and no further. So a range is
      // filtered on what it does have, which keeps out-of-range rows off the screen, and is
      // reported as unavailable, because a range older than the walk's reach would otherwise
      // come back empty and read as "you have no history from then".
      const rows = isRanged(opts) ? walked.rows.filter((r) => inWindow(Date.parse(r.createdAt), opts)) : walked.rows;
      const listing: HistoryListing = { rows, granularity: "sync", more: walked.more };
      // Grouping the walk would save nothing: it fetches every manifest to learn each parent,
      // which is the entire cost. So the answer is flat rows and a note saying why, never a
      // shorter list that hides how it was built.
      if (isRanged(opts)) listing.fallback = "no-range";
      else if (granularity !== "sync") listing.fallback = "no-index";
      return listing;
    }

    const planned =
      granularity === "sync"
        ? this.#flatPlan(chain.entries)
        : this.#groupPlan(chain.entries, granularity, chain.chainEnds);
    const visible = inRange(planned, opts);
    const rows = await this.#listHistoryRows(visible.slice(0, limit), wantChanges);

    // A range that the walk got past is a finished question: snapshots older than its start
    // exist, but none of them belong in this list, and offering to fetch them would be noise.
    const oldest = chain.entries[chain.entries.length - 1];
    const settled =
      chain.chainEnds ||
      (opts.from !== undefined && oldest !== undefined && oldest.uploadedAt < opts.from);
    const listing: HistoryListing = {
      rows,
      granularity,
      // Either the limit cut the list, or the chain continues past what was collected.
      more: visible.length > limit || !settled,
    };
    if (chain.fallback !== undefined) listing.fallback = chain.fallback;
    return listing;
  }

  /** Every listed snapshot as its own row, diffed against the link the chain gives it. */
  #flatPlan(entries: readonly HistoryEntry[]): HistoryRow[] {
    return entries.map((entry) => ({
      id: entry.id,
      parent: entry.parent,
      at: entry.uploadedAt,
      compareTo: previousOf(entry),
      spans: (entry.pruned ?? 0) + 1,
    }));
  }

  /** One row per calendar bucket, each diffed against the older bucket's newest snapshot. */
  #groupPlan(
    entries: readonly HistoryEntry[],
    granularity: "day" | "week",
    chainEnds: boolean
  ): HistoryRow[] {
    return groupHistory(entries, granularity, { chainEnds }).map((g) => ({
      // The pick's own parent, never the older bucket's pick: the manifest authenticates
      // `parent`, the index is cross-checked against it, and the window browses this snapshot.
      id: g.pick.id,
      parent: g.pick.parent,
      at: g.pick.uploadedAt,
      compareTo: g.compareTo,
      spans: g.spans,
      group: g.group,
    }));
  }

  /**
   * The chain to build a listing from, paged until it reaches far enough back.
   *
   * Null when the server cannot vouch for a chain at all, which sends the caller to the walk.
   *
   * Paging exists because `historyLimit` counts *rows*, and a grouped row can hold a whole
   * day's commits — forty days on a busy vault is well past the server's 500-row page. Only a
   * grouped or ranged listing pages; a flat one asks for its limit and is done, exactly as it
   * was before.
   */
  async #collectChain(
    limit: number,
    granularity: HistoryGranularity,
    opts: HistoryOptions
  ): Promise<{ entries: HistoryEntry[]; chainEnds: boolean; fallback?: HistoryFallback } | null> {
    const pages = granularity === "sync" && !isRanged(opts) ? 1 : MAX_HISTORY_PAGES;
    const pageSize = pages === 1 ? limit : CHAIN_PAGE;

    const first = await this.#api.getHistory(pageSize);
    if (first === null || !first.complete) return null;
    // A complete, empty page is a vault with no snapshots — not a server that cannot answer.
    // Sending that to the walk would report a missing index for a chain that is simply empty.
    if (first.entries.length === 0) return { entries: [], chainEnds: true };

    const entries = [...first.entries];
    const seen = new Set(entries.map((e) => e.id));
    let fallback: HistoryFallback | undefined;
    // Nothing older is *fetchable*, which is not the same as the chain having a null parent:
    // the oldest snapshot a thinned vault retains still names the parent a sweep collected, so
    // `parent === null` never comes true on a mature vault. The only unambiguous signal is a
    // continuation that comes back empty and complete — deliberately not "a page shorter than
    // we asked for", which cannot tell the chain running out from the server's own page cap.
    let exhausted = false;

    for (let page = 1; page < pages; page++) {
      const tail = entries[entries.length - 1];
      const expected = previousOf(tail);
      if (expected === null) break;
      // One past the limit, because "is there more after this list" is answered by whether a
      // further row exists — so the walk stops once it has the rows plus that evidence.
      if (this.#chainCovers(entries, limit + 1, granularity, opts)) break;

      const next = await this.#api.getHistory(CHAIN_PAGE, { before: tail.id });
      if (next === null) break;
      if (next.entries.length === 0) {
        // Complete and empty is the cursor having been the last snapshot: the chain ends here.
        // Incomplete and empty is the index failing to resolve the cursor — a sweep can collect
        // one between two pages — which is a hole in the index, not the end of the vault's
        // history, and is handled exactly like a hole found part-way down a page.
        if (next.complete) {
          exhausted = true;
          break;
        }
        return this.#shortOfWhatItShows(entries, limit, granularity, opts);
      }
      if (next.entries[0].id !== expected) {
        // A Worker predating the cursor ignores the parameter and answers the head page again.
        // That is a server capability, not a corrupt chain, and must not be reported as one.
        if (next.entries[0].id === entries[0].id) {
          fallback = "no-cursor";
          break;
        }
        throw new Error(
          `history page after ${tail.id} starts at ${next.entries[0].id}, not ${expected}`
        );
      }
      for (const entry of next.entries) {
        // A manifest id is used once, ever. `parseHistoryPage` enforces that within a page;
        // across pages a repeat means the chain cycles, and a listing built over it would diff
        // a snapshot against itself and report that nothing changed.
        if (seen.has(entry.id)) throw new Error(`history repeats ${entry.id} across pages`);
        seen.add(entry.id);
        entries.push(entry);
      }
      if (!next.complete) return this.#shortOfWhatItShows(entries, limit, granularity, opts);
    }

    const oldest = entries[entries.length - 1];
    return { entries, chainEnds: previousOf(oldest) === null || exhausted, fallback };
  }

  /**
   * What to do about a hole in the index found part-way through paging.
   *
   * If everything the listing will show is already collected, the hole is past the end of it and
   * costs nothing — keep the rows. If it is not, the rule the *first* page follows applies:
   * showing fewer snapshots than exist is worse than being slow, so hand the whole question to
   * the walk rather than serve a knowingly short list under a complete-looking listing.
   */
  #shortOfWhatItShows(
    entries: readonly HistoryEntry[],
    limit: number,
    granularity: HistoryGranularity,
    opts: HistoryOptions
  ): { entries: HistoryEntry[]; chainEnds: boolean } | null {
    // `limit`, not `limit + 1`: the extra row the paging loop wants exists only to decide
    // whether to say "there is more", and `chainEnds: false` already says it.
    return this.#chainCovers(entries, limit, granularity, opts)
      ? { entries: [...entries], chainEnds: false }
      : null;
  }

  /** Whether the chain collected so far already yields at least `need` of the rows to be shown. */
  #chainCovers(
    entries: readonly HistoryEntry[],
    need: number,
    granularity: HistoryGranularity,
    opts: HistoryOptions
  ): boolean {
    const oldest = entries[entries.length - 1];
    const chainEnds = previousOf(oldest) === null;
    if (!isRanged(opts)) {
      return granularity === "sync"
        ? entries.length >= need
        : countGroups(entries, granularity, { chainEnds }) >= need;
    }

    // With a range, only rows *inside* it count. A `to` in the past filters out everything
    // fetched so far, so stopping on the raw row count would page once and then report the
    // range as empty while the snapshots it asked for sat one page further back.
    const planned =
      granularity === "sync"
        ? this.#flatPlan(entries)
        : this.#groupPlan(entries, granularity, chainEnds);
    if (inRange(planned, opts).length >= need) return true;
    // Nothing older than the range's start can matter, so the walk is finished once past it.
    return opts.from !== undefined && oldest.uploadedAt < opts.from;
  }

  /**
   * A listing built from the server's chain, which turns the walk inside out.
   *
   * The walk is sequential because a parent is unknowable until its child has been fetched and
   * decrypted. Given the chain up front, every manifest still needed can be fetched at once —
   * and rows already computed this session are not fetched at all. Reopening the window
   * normally costs one request plus the snapshots made since it was last open.
   */
  async #listHistoryRows(plan: readonly HistoryRow[], wantChanges: boolean): Promise<SnapshotInfo[]> {
    // A row built for a caller that did not want diffs has no `changes`, and handing it to one
    // that does would report "no change recorded" for a snapshot nobody diffed. `rerootSummary`
    // asks without diffs, so the two callers really do share this cache.
    const usable = (entry: HistoryRow): SnapshotInfo | undefined => {
      const row = this.#historyRows.get(rowKey(entry));
      if (row === undefined) return undefined;
      return !wantChanges || row.changes !== undefined ? row : undefined;
    };

    const needed = new Set<string>();
    for (const entry of plan) {
      if (usable(entry) !== undefined) continue;
      needed.add(entry.id);
      // One manifest past the last uncached row, and only to give it something to diff
      // against — the same single extra fetch the walk pays. Across collected history, or
      // across a bucket, that is the nearest snapshot still held rather than the literal parent.
      if (wantChanges && entry.compareTo !== null) needed.add(entry.compareTo);
    }

    const ids = [...needed];
    type Loaded =
      | { files: Record<string, FileEntry> | null; manifest: Manifest }
      // The 404 itself, not a marker: a head that is gone has to be re-thrown, and inventing
      // a fresh error there would lose the status the caller decides on.
      | { missing: ApiError };
    const fetched = new Map<string, Loaded>();
    const loaded = await mapPool(ids, this.#lanes, async (id): Promise<Loaded> => {
      let manifest: Manifest;
      try {
        manifest = await this.#api.getManifest(id);
      } catch (e) {
        // Same rule the walk applies: only a typed 404 is evidence about history. Anything
        // else is this request failing, and dressing it up as retention would turn a
        // retryable error into a false claim about the user's own snapshots.
        if (!(e instanceof ApiError) || e.status !== 404) throw e;
        return { missing: e };
      }
      try {
        return { files: await this.#remoteFiles(manifest), manifest };
      } catch {
        return { files: null, manifest };
      }
    });
    ids.forEach((id, i) => fetched.set(id, loaded[i]));

    // The bucket label is view-specific and free to compute, so it is attached here rather than
    // cached — which is what lets a day row and a sync row over the same pair share one fetch.
    const label = (row: SnapshotInfo, entry: HistoryRow): SnapshotInfo =>
      entry.group === undefined ? row : { ...row, group: entry.group };

    const out: SnapshotInfo[] = [];
    for (const entry of plan) {
      const cached = usable(entry);
      if (cached !== undefined) {
        out.push(label(cached, entry));
        continue;
      }
      const got = fetched.get(entry.id);
      if (got === undefined) break;
      if ("missing" in got) {
        // A 404 on the HEAD is not retention. It is a server whose own pointer names a
        // snapshot it no longer has, and returning [] for it would tell the user their vault
        // has no history at all. Only a missing ancestor is evidence that history was trimmed.
        if (out.length === 0) throw got.missing;
        break;
      }
      const manifest = got.manifest;
      // The index is a convenience, never an authority. `parent`, `device` and `createdAt` are
      // covered by `manifestAad` on a v3 envelope, so the fetched manifest is the version that
      // has been authenticated — and a listing that disagreed with it would have this diff a
      // snapshot against something that is not its parent, then cache the false answer.
      if (manifest.parent !== entry.parent) {
        throw new Error(
          `server listed ${entry.id} with parent ${entry.parent ?? "none"}, but the snapshot ` +
            `itself names ${manifest.parent ?? "none"}`
        );
      }
      const info: SnapshotInfo = {
        id: entry.id,
        parent: manifest.parent,
        device: manifest.device,
        createdAt: manifest.createdAt,
        fileCount: got.files === null ? null : Object.keys(got.files).length,
        readable: got.files !== null,
      };
      if (wantChanges) info.changes = this.#changesFor(entry, got.files, fetched);
      // Keyed by the snapshot this row was compared against, so it stays valid for exactly as
      // long as that comparison does — permanently for a true parent, and until the next tier
      // transition for one reached across collected history or across a bucket boundary.
      this.#historyRows.set(rowKey(entry), info);
      out.push(label(info, entry));
    }
    return out;
  }

  /**
   * The diff to show for one listed snapshot.
   *
   * Normally that is against the manifest's own parent link, the one the envelope
   * authenticates. Where the commits in between have been collected, it is against the
   * nearest snapshot the server still holds — a real diff between two snapshots this device
   * decrypted itself, over a wider interval, carrying `spans` so it is shown as one. That is
   * a different thing from an unknown diff: nothing here is being guessed, and rendering it
   * as `parent-missing` would hide a change the user can still see both ends of.
   *
   * A grouped row reaches the same shape by a different route: its interval is a calendar
   * bucket rather than a collected stretch, and the snapshots inside it still exist. `spans`
   * says how many syncs the diff covers either way, which is the only thing the reader needs.
   */
  #changesFor(
    entry: HistoryRow,
    files: Record<string, FileEntry> | null,
    fetched: ReadonlyMap<
      string,
      { files: Record<string, FileEntry> | null } | { missing: ApiError }
    >
  ): SnapshotChanges | { unknown: ChangesUnknown } {
    if (files === null) return { unknown: "unreadable" };
    // The span is a fact about the interval, not about what it is being compared to, so the
    // vault's first bucket carries it too: a day that held four syncs held four syncs whether
    // or not there was a snapshot before it.
    const span = (changes: SnapshotChanges): SnapshotChanges =>
      entry.spans <= 1 ? changes : { ...changes, spans: entry.spans };
    if (entry.compareTo === null) return span(diffSnapshots(null, files));
    const parent = fetched.get(entry.compareTo);
    if (parent === undefined || "missing" in parent) return { unknown: "parent-missing" };
    if (parent.files === null) return { unknown: "parent-unreadable" };
    return span(diffSnapshots(parent.files, files));
  }

  async #listHistoryByWalk(
    limit: number,
    opts: { changes?: boolean } = {}
  ): Promise<{ rows: SnapshotInfo[]; more: boolean }> {
    const wantChanges = opts.changes === true;
    const out: SnapshotInfo[] = [];
    const seen = new Set<string>();
    let id = await this.#api.getHead();

    // The snapshot listed last, held back until its parent's path map is in hand — which is
    // the next turn of this same walk, so a diff costs no fetch of its own.
    let pending: { info: SnapshotInfo; files: Record<string, FileEntry> | null } | null = null;
    const settle = (
      parent: { files: Record<string, FileEntry> } | { unknown: ChangesUnknown } | "initial"
    ): void => {
      if (pending === null) return;
      const { info, files } = pending;
      pending = null;
      if (!wantChanges) return;
      if (files === null) info.changes = { unknown: "unreadable" };
      else if (parent === "initial") info.changes = diffSnapshots(null, files);
      else if ("unknown" in parent) info.changes = parent;
      else info.changes = diffSnapshots(parent.files, files);
    };

    // Whether the chain carries on past the last row listed. Only a walk cut by the limit says
    // yes: a walk that ran out of chain, hit a collected ancestor, or found the chain corrupt
    // has nothing further to offer, and claiming otherwise would send the user back for it.
    let more = false;

    for (;;) {
      // Past the limit the walk continues for exactly one more manifest, and only to give the
      // last listed snapshot something to diff against. Without diffs it stops at the limit.
      const parentOnly = out.length >= limit;
      if (parentOnly && !wantChanges) {
        more = id !== null;
        break;
      }
      if (id === null) {
        settle("initial");
        break;
      }
      // The server refuses to reuse a manifest id, so a repeat means history was corrupted
      // around that rule. Stopping shows the readable prefix rather than listing the same
      // snapshots over and over until the limit is reached.
      if (seen.has(id)) {
        settle({ unknown: "parent-missing" });
        break;
      }
      seen.add(id);
      let manifest: Manifest;
      try {
        manifest = await this.#api.getManifest(id);
      } catch (e) {
        // Only "that snapshot is gone" is evidence about the vault's history. A 401, 429, 5xx,
        // transport or parse failure is this request failing, and dressing it up as retention
        // turns an actionable error into a false fact about the user's own history. Same rule
        // the descent walk applies.
        if (!(e instanceof ApiError) || e.status !== 404) throw e;
        // A *head* that 404s is not retention either: it is a server whose own pointer names a
        // snapshot it no longer has. Reporting an empty list would claim the vault is new.
        if (out.length === 0) throw e;
        settle({ unknown: "parent-missing" });
        break;
      }
      let files: Record<string, FileEntry> | null;
      try {
        files = await this.#remoteFiles(manifest);
      } catch {
        files = null;
      }
      settle(files === null ? { unknown: "parent-unreadable" } : { files });
      if (parentOnly) {
        // This manifest was fetched only to diff the last listed row against; it is itself a
        // snapshot the listing did not show, so there is demonstrably more history.
        more = true;
        break;
      }

      const info: SnapshotInfo = {
        id: manifest.id,
        parent: manifest.parent,
        device: manifest.device,
        createdAt: manifest.createdAt,
        fileCount: files === null ? null : Object.keys(files).length,
        readable: files !== null,
      };
      out.push(info);
      pending = { info, files };
      id = manifest.parent;
    }
    return { rows: out, more };
  }

  /** The path → entry map a snapshot recorded, decrypting the path map when needed. */
  async snapshotFiles(id: string): Promise<Record<string, FileEntry>> {
    return await this.#remoteFiles(await this.#api.getManifest(id));
  }

  /**
   * What restoring one file would run into, so the caller can ask before anything is written.
   *
   * Reads the vault; writes nothing. The comparison is by content hash, never `size+mtime`:
   * a file edited back and forth to the same bytes is genuinely identical, and one edited to
   * the same size is not.
   */
  async inspectRestore(id: string, path: string): Promise<RestoreInspection> {
    this.#assertRestorableSource(path);
    const manifest = await this.#api.getManifest(id);
    const entry = (await this.#remoteFiles(manifest))[path];
    if (entry === undefined) throw new Error(`"${path}" is not in snapshot ${id}`);

    const local = await this.#localHash(path);
    const state = this.#state ?? (await this.#store.load());
    return {
      entry,
      currentHash: local,
      current: local === null ? "absent" : local === entry.h ? "identical" : "differs",
      unsyncedEdits: local !== null && local !== state?.files[path]?.h,
      suggestion: this.#restoreSuggestion(path, manifest.createdAt),
    };
  }

  /**
   * Writes one file from a snapshot back into the vault.
   *
   * Restoring never destroys unseen work by accident. Content already at the destination is
   * compared by hash first: identical means nothing is written at all, and differing content
   * is preserved by writing a numbered sibling instead — unless the caller passes `overwrite`,
   * which is the explicit "replace what is there" the UI asks about separately.
   */
  async restoreFile(
    id: string,
    path: string,
    opts: { destination?: string; overwrite?: boolean; expectedHash?: string | null } = {}
  ): Promise<RestoreOutcome> {
    const requested = opts.destination ?? path;
    this.#assertRestorableSource(path);
    this.#assertRestorableDestination(requested);
    // An overwrite is approval for destroying one specific version. Without naming it, the
    // approval is unbounded and applies to whatever happens to be there when the click lands.
    if (opts.overwrite === true && opts.expectedHash === undefined) {
      throw new Error(
        `refusing to overwrite "${requested}": an overwrite must name the version it replaces`
      );
    }

    const entry = (await this.snapshotFiles(id))[path];
    if (entry === undefined) throw new Error(`"${path}" is not in snapshot ${id}`);

    const observed = await this.#localHash(requested);
    if (opts.expectedHash !== undefined && observed !== opts.expectedHash) {
      throw restoreRaceError(requested);
    }
    if (observed === entry.h) return { kind: "identical", path: requested, requested };

    let target = requested;
    // What the destination held when the decision was taken, re-checked below. Null for a
    // numbered copy, which is chosen precisely because nothing is there.
    let approved = observed;
    let kind: RestoreOutcome["kind"];
    if (observed === null) {
      kind = "written";
    } else if (opts.overwrite === true) {
      kind = "replaced";
    } else {
      const spot = await this.#freeRestorePath(requested, entry.h);
      if (spot.identical) return { kind: "identical", path: spot.path, requested };
      target = spot.path;
      approved = null;
      kind = "copied";
    }

    // Fetched and verified before the vault is touched at all, which also puts the download's
    // latency *before* the final check rather than between it and the write.
    const bytes = await this.#fetch(entry);

    // Everything above describes a moment that has now passed: a confirmation can sit open
    // while the note is edited by the user, another plugin or a sync, and a free path can be
    // taken while the blob downloads. A stale approval is not approval for bytes nobody saw.
    const current = await this.#localHash(target);
    if (current !== approved) {
      if (current === entry.h) return { kind: "identical", path: target, requested };
      throw restoreRaceError(target);
    }
    await this.#vault.write(target, bytes);
    return { kind, path: target, requested };
  }

  /**
   * The first destination from `requested` that is either empty or already holds `hash`.
   *
   * Finding the content already sitting at `Note (2).md` matters: it is what a second click on
   * the same Restore button hits, and answering it with `Note (3).md` would litter the vault
   * with identical copies.
   */
  async #freeRestorePath(
    requested: string,
    hash: string
  ): Promise<{ path: string; identical: boolean }> {
    for (let n = 2; n <= MAX_RESTORE_COPIES; n++) {
      const candidate = numberedPath(requested, n);
      // The destination rule, deliberately not the sync policy. Filtering these by what the
      // device *syncs* skipped every candidate beside an unsynced destination — so a restore
      // onto an occupied config path reported all copies taken while `(2)` sat free.
      if (this.restoreDestinationBlock(candidate) !== null) continue;
      const existing = await this.#localHash(candidate);
      if (existing === null) return { path: candidate, identical: false };
      if (existing === hash) return { path: candidate, identical: true };
    }
    throw new Error(
      `refusing to restore "${requested}": ${MAX_RESTORE_COPIES} numbered copies beside it are ` +
        `already taken by different content`
    );
  }

  /**
   * Where to offer to put a restored copy.
   *
   * Beside the original, except when that would land somewhere nothing may be written — the
   * copy path of a file inside this plugin's folder is still inside this plugin's folder, so
   * the offer has to leave it. The vault root is the one place known to be open.
   */
  #restoreSuggestion(path: string, createdAt: string): string {
    const beside = restoreCopyPath(path, createdAt);
    if (this.restoreDestinationBlock(beside) === null) return beside;
    const name = beside.slice(beside.lastIndexOf("/") + 1);
    return this.restoreDestinationBlock(name) === null ? name : `restored-${name}`;
  }

  /**
   * Whether this device would sync a path, which a restore no longer asks before writing.
   *
   * It still has to be *said*: a file restored onto a path this device does not scan is never
   * published, and stays behind if the vault is reinstalled elsewhere. Reporting "Restored" and
   * leaving the user to assume it is now safe would be the ambiguous success this codebase
   * refuses — so the window appends the caveat rather than the engine refusing the write.
   */
  syncsPath(path: string): boolean {
    return !this.#notScanned(path);
  }

  /** sha256 of what is at `path` right now, or null when nothing is. */
  async #localHash(path: string): Promise<string | null> {
    if ((await this.#vault.stat(path)) === null) return null;
    return await sha256Hex(await this.#vault.read(path));
  }

  /**
   * Rejects a snapshot path that could not be a vault path at all.
   *
   * Deliberately says nothing about what this device *syncs*. A manual restore is not a sync:
   * the remote holds the bytes, the user asked for them by name, and the sync policy exists to
   * decide what gets published automatically, not to decide what its owner may read back. A
   * config file carried through snapshots by another device is exactly the thing someone opens
   * history to recover, and refusing it left the only copy visible but unreachable.
   */
  #assertRestorableSource(path: string): void {
    const bad = pathError(path);
    if (bad !== null) throw new Error(`"${path}" is not a valid vault path: ${bad}`);
  }

  /**
   * Rejects a destination a write cannot honestly land on.
   *
   * The destination is the only thing a restore can harm, and the user chooses it, so this is
   * as narrow as it can be: a path the vault could not hold, and this plugin's own folder.
   *
   * That folder is not a policy carve-out. It stores this device's access token and master key,
   * and the running plugin rewrites `data.json` from memory on its next save — so a restore
   * there either reports success over bytes that are about to be discarded, or swaps this
   * device's identity underneath the session that is writing it. Both are the ambiguous
   * success this codebase refuses to produce.
   */
  #assertRestorableDestination(path: string): void {
    const blocked = this.restoreDestinationBlock(path);
    if (blocked !== null) throw new Error(`refusing to restore into "${path}": ${blocked}`);
  }

  /**
   * Why a destination is closed to a restore, or null when it is open.
   *
   * Public because the window has to know *before* it offers an in-place restore: a snapshot
   * can hold a file whose own path is closed, and with no local copy the browser would otherwise
   * write straight to it and surface a throw with no way to redirect. The source stays
   * recoverable — that is the whole point — so the UI asks for another destination instead.
   *
   * Case-folded, like destination collision detection: the default macOS and Windows vaults are
   * case-insensitive, so `.obsidian/plugins/CLOUDFLARE-RDO-SYNC/data.json` is the live
   * credential file under another spelling, and a case-sensitive guard would wave it through.
   */
  restoreDestinationBlock(path: string): string | null {
    // Validity lives here rather than beside the throw, so that everything choosing a
    // destination asks one question. Numbering used to inherit this check through the sync
    // policy, and dropping that left `numberedPath` free to push a long path past the 1,024-byte
    // limit and hand the adapter something no later sync would accept.
    const bad = pathError(path);
    if (bad !== null) return `it is not a valid vault path: ${bad}`;
    const folded = foldPath(path);
    for (const dir of selfDirs(this.#configDir)) {
      const self = foldPath(dir);
      if (folded === self || folded.startsWith(`${self}/`)) {
        return (
          "that is this plugin's own folder, which holds this device's credentials and is " +
          "rewritten from memory while the plugin runs"
        );
      }
    }
    return null;
  }

  /**
   * Makes the vault match a snapshot: every recorded file is written and anything this
   * device syncs but the snapshot lacks is removed. Paths we do not scan are untouched on
   * both sides. Nothing is committed — the next sync publishes the restored state, and the
   * snapshot being replaced stays in the chain.
   */
  async restoreAll(id: string): Promise<{ written: number; removed: number }> {
    return await this.#exclusive(async () =>
      this.#materialise(await this.#api.getManifest(id), await this.#vault.list())
    );
  }

  /**
   * Claims the engine for one operation that rewrites the vault, so no pass can start in the
   * middle of it. Mirrors `migrateEncryption`'s handling: the status is what `sync()` checks.
   */
  async #exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (this.status.phase === "syncing") throw new Error("sync is already running");
    this.status = { phase: "syncing" };
    try {
      const result = await run();
      this.status = { phase: "idle", lastSyncAt: this.#now() };
      return result;
    } catch (error) {
      this.status = {
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  /**
   * Writes a manifest's files over the vault and removes what it does not have.
   *
   * `localFiles` is passed in rather than listed here so a caller can capture the listing
   * *before* it creates files of its own: `forcePull` parks conflict copies first, and a
   * copy that appeared after the listing must not then be removed as stale.
   */
  async #materialise(
    manifest: Manifest,
    localFiles: VaultFile[]
  ): Promise<{ written: number; removed: number }> {
    const rawFiles = await this.#remoteFiles(manifest);
    const collisionResolution = this.#resolveRemoteCaseCollisions(
      rawFiles,
      manifest.device,
      localFiles.map((file) => file.path)
    );
    const files = collisionResolution.files;
    const wanted = Object.entries(files).filter(([path]) => !this.#notScanned(path));

    // Do not begin a restore that cannot be fully downloaded and authenticated. Filesystem
    // writes can still fail, but remote/network/key failures leave the vault untouched —
    // which is also why the pool waits for every in-flight fetch before reporting failure.
    const fetched = await mapPool(wanted, this.#lanes, async ([path, entry]) => ({
      path,
      bytes: await this.#fetch(entry),
    }));

    await mapPool(fetched, this.#lanes, ({ path, bytes }) => this.#vault.write(path, bytes));
    const stale = localFiles.filter(
      (file) =>
        !this.#notScanned(file.path) &&
        !collisionResolution.protectedLocalPaths.includes(file.path) &&
        !Object.hasOwn(files, file.path)
    );
    await mapPool(stale, this.#lanes, (file) => this.#vault.remove(file.path));
    // Same reason and same shape as `#executePlan`: sequential, deepest-first, after the pool.
    for (const dir of pruneCandidates(stale.map((file) => file.path), this.#configDir)) {
      await this.#vault.removeFolderIfEmpty(dir);
    }

    return { written: fetched.length, removed: stale.length };
  }

  /**
   * Makes the remote head authoritative for this device in one explicit step: every file it
   * records is written and everything else this device syncs is removed. Nothing is
   * committed — the next ordinary pass publishes the result, and the snapshot being replaced
   * remains in the chain.
   *
   * Divergence this device never published is parked as a `.conflict-…` copy first, which is
   * the same promise the merge makes. A file still identical to the last synced snapshot is
   * *not* copied: by construction it holds no authored work, exactly the reasoning that lets
   * the merge's `take-theirs` overwrite silently.
   */
  async forcePull(previewedHead?: string): Promise<ForcePullResult> {
    return await this.#exclusive(async () => {
      const plan = await this.#forcePullPlan(previewedHead);
      // Sequential, not pooled: each candidate name is checked against the vault as it
      // stands, so a copy written by the previous iteration is already occupying its path.
      const parked: string[] = [];
      for (const path of plan.park) {
        const copy = await this.#availableConflictPath(path, this.#deviceName);
        await this.#vault.write(copy, await this.#vault.read(path));
        parked.push(copy);
      }
      const { written, removed } = await this.#materialise(plan.manifest, plan.localFiles);
      return { head: plan.head, written, removed, parked };
    });
  }

  /** What `forcePull` would do, computed the same way and touching nothing. */
  async forcePullSummary(): Promise<ForcePullSummary> {
    const { head, write, remove, park } = await this.#forcePullPlan();
    return { head, write, remove, park };
  }

  async #forcePullPlan(previewedHead?: string): Promise<ForcePullPlan> {
    if (this.#mode === "push-only") {
      throw new Error(
        'sync direction is "push-only", so this device never writes local files — it cannot ' +
          "pull the remote over them. Change the direction first."
      );
    }
    const head = await this.#api.getHead();
    if (head === null) {
      throw new Error("the remote vault has no snapshot yet, so there is nothing to pull");
    }
    // The typed confirmation named a snapshot and counted its files. Writing a different one
    // over this vault would be a destructive action nobody agreed to.
    if (previewedHead !== undefined && head !== previewedHead) {
      throw new Error(
        `another device published ${head} since this pull was previewed, so nothing was ` +
          "changed. Preview it again to see what it would now write over this vault."
      );
    }
    const manifest = await this.#api.getManifest(head);
    const mismatch = this.#modeError(manifest, head);
    if (mismatch !== null) throw new Error(mismatch);

    const localFiles = await this.#vault.list();
    const local = await this.#buildSnapshot();
    const remote = this.#resolveRemoteCaseCollisions(
      await this.#remoteFiles(manifest),
      manifest.device,
      local.occupiedPaths,
      local.files
    );
    const base = (this.#state ?? (await this.#store.load()))?.files ?? pathMap<FileEntry>();

    const park = Object.keys(local.files)
      .filter((path) => {
        const ours = local.files[path];
        // Identical content is not divergence, whatever the two mtimes say.
        if (sameEntry(ours, remote.files[path])) return false;
        return !sameEntry(ours, base[path]);
      })
      .sort();

    return {
      manifest,
      localFiles,
      head,
      write: Object.keys(remote.files).filter((path) => !this.#notScanned(path)).length,
      remove: localFiles
        .map((file) => file.path)
        .filter(
          (path) =>
            !this.#notScanned(path) &&
            !remote.protectedLocalPaths.includes(path) &&
            !Object.hasOwn(remote.files, path)
        )
        .sort(),
      park,
    };
  }

  /**
   * What a forced push (`sync({ keepLocal: true })`) would publish. Reported before the
   * commit because it is the one pass that deliberately discards remote work.
   */
  async forcePushSummary(): Promise<ForcePushSummary> {
    if (this.#mode === "pull-only") {
      throw new Error(
        'sync direction is "pull-only", so this device never commits — it cannot push its ' +
          "files over the remote. Change the direction first."
      );
    }
    const head = await this.#api.getHead();
    const local = await this.#buildSnapshot();
    const summary: ForcePushSummary = {
      head,
      files: Object.keys(local.files).length,
      drop: [],
      carried: 0,
    };
    if (head === null) return summary;

    const manifest = await this.#api.getManifest(head);
    const mismatch = this.#modeError(manifest, head);
    if (mismatch !== null) throw new Error(mismatch);
    const remote = await this.#remoteFiles(manifest);
    const carried = this.#carry(remote, untouchable(local.skipped));
    summary.carried = Object.keys(carried).length;
    summary.drop = Object.keys(remote)
      .filter((path) => !Object.hasOwn(carried, path) && !Object.hasOwn(local.files, path))
      .sort();
    return summary;
  }

  /**
   * What a reroot would publish, and how much history it would orphan.
   *
   * Deliberately built from `forcePushSummary`: a reroot publishes exactly what a forced push
   * would, and differs only in what happens to everything *behind* it. Two summaries that
   * could disagree about the files would be two chances to describe the wrong action.
   */
  async rerootSummary(historyLimit: number): Promise<RerootSummary> {
    const push = await this.forcePushSummary();
    const chain = await this.listHistory(historyLimit);
    return {
      ...push,
      discarded: chain.rows.length,
      // A count cut by the limit is a floor, and so is one cut by a chain the listing could not
      // follow to its end — both understate what a reroot abandons.
      discardedIsFloor: chain.rows.length >= historyLimit || chain.more,
    };
  }

  async #mergeOne(
    path: string,
    base: FileEntry | undefined,
    ours: FileEntry,
    theirs: FileEntry,
    remoteDevice: string,
    out: MergeOutcome
  ): Promise<void> {
    const theirsBytes = await this.#fetch(theirs);

    if (isMergeableText(path)) {
      const oursText = decodeText(await this.#vault.read(path));
      const theirsText = decodeText(theirsBytes);
      const baseText = await this.#baseText(base);
      if (oursText !== null && theirsText !== null && baseText !== null) {
        const merged = mergeText(baseText, oursText, theirsText);
        if (merged.clean) {
          const mergedBytes = new TextEncoder().encode(merged.text);
          await this.#vault.write(path, mergedBytes);
          out.merged++;
          out.pulled++;
          out.pulledChanges.push(this.#localChange(path, "merge", mergedBytes));
          return;
        }
      }
    }

    // No automatic resolution from here on.
    const sides = {
      ours: { mtime: ours.mtime, size: ours.size },
      theirs: { mtime: theirs.mtime, size: theirs.size },
    };

    if (this.#conflictMode !== "keep-both") {
      // Overwrite mode: the loser is DISCARDED by explicit, twice-confirmed user choice.
      // Theirs stays recoverable from the snapshot chain; a local edit that was never
      // committed does not — the settings UI says so before this mode can be enabled.
      const kept = conflictWinner(this.#conflictMode, ours, theirs);
      if (kept === "theirs") {
        await this.#vault.write(path, theirsBytes);
        out.pulled++;
        out.pulledChanges.push(this.#localChange(path, "update", theirsBytes));
      }
      out.conflictDetails.push({ path, copy: null, kept, ...sides });
      return;
    }

    // Both versions survive; the user picks.
    if (!isMergeableText(path) && theirs.mtime > ours.mtime) {
      // Attachments get last-writer-wins, with the loser parked beside it.
      const loser = await this.#availableConflictPath(path, this.#deviceName);
      const oursBytes = await this.#vault.read(path);
      await this.#vault.write(loser, oursBytes);
      await this.#vault.write(path, theirsBytes);
      out.conflicts.push(loser);
      out.conflictDetails.push({ path, copy: loser, kept: "theirs", ...sides });
      out.pulledChanges.push(
        this.#localChange(path, "update", theirsBytes),
        this.#localChange(loser, "add", oursBytes)
      );
    } else {
      const copy = await this.#availableConflictPath(path, remoteDevice);
      await this.#vault.write(copy, theirsBytes);
      out.conflicts.push(copy);
      out.conflictDetails.push({ path, copy, kept: "ours", ...sides });
      // The copy is a file that appeared here because of the remote, so it belongs on the
      // pulled side. A two-way pass also publishes it, and reporting both is not double
      // counting: it did land locally and it did go out.
      out.pulledChanges.push(this.#localChange(copy, "add", theirsBytes));
    }
    out.pulled++;
  }

  /**
   * One local change, with its net line count taken from the bytes just written against the
   * count cached for the previous snapshot. `bytes === null` means the file is gone, which is
   * NOT the same as binary content: a deletion removes every line it had, while binary content
   * has no count on either side and stays unattributed.
   */
  #localChange(path: string, action: PassChange["action"], bytes: Uint8Array | null): PassChange {
    const before = this.#state?.lines?.[path];
    if (bytes === null) {
      return { path, action, lines: before === undefined ? null : -before };
    }
    const after = countLines(bytes);
    return { path, action, lines: after === null ? null : netLines(before, after) };
  }

  async #availableConflictPath(path: string, device: string): Promise<string> {
    const occupied = new Set((await this.#vault.list()).map((file) => foldPath(file.path)));
    for (let sequence = 1; ; sequence++) {
      const candidate = conflictPath(path, device, this.#now(), sequence);
      if (!occupied.has(foldPath(candidate))) return candidate;
    }
  }

  /**
   * The common ancestor's text. The two ways of not having one are NOT the same case:
   *
   * - `undefined` entry — the file never existed before, both devices created it. An empty
   *   base is *correct*: everything on both sides is an insertion, and diff3's union rule
   *   keeps both (the "both devices started today's daily note" case).
   * - The entry exists but the blob is gone (GC) or does not decode — the file has real
   *   shared history we cannot see. Pretending the base was empty would make two evolved
   *   copies look like independent insertions and union them into duplicated content, so
   *   this returns null and the caller falls back to a conflict copy, which is recoverable.
   */
  async #baseText(base: FileEntry | undefined): Promise<string | null> {
    if (base === undefined) return "";
    try {
      return decodeText(await this.#fetch(base));
    } catch {
      return null;
    }
  }

  /** Downloads one file's bytes, decrypting and verifying against the manifest's hash. */
  async #fetch(entry: FileEntry): Promise<Uint8Array> {
    return this.#fetchWithCrypto(entry, this.#crypto);
  }

  async #fetchWithCrypto(
    entry: FileEntry,
    crypto: VaultCrypto | null
  ): Promise<Uint8Array> {
    const stored = await this.#api.getBlob(blobKey(entry));
    if (crypto !== null) {
      // The key is derived from the expected plaintext hash, so a substituted blob fails
      // the GCM tag rather than decrypting to something else.
      return await crypto.decryptBlob(entry.h, stored);
    }
    const actual = await sha256Hex(stored);
    if (actual !== entry.h) {
      throw new Error(`blob ${entry.h} came back with hash ${actual} — refusing to write it`);
    }
    return stored;
  }

  async #buildManifest(
    parent: string | null,
    files: Record<string, FileEntry>,
    blobs: string[]
  ): Promise<Manifest> {
    return this.#buildManifestWithCrypto(this.#crypto, parent, files, blobs);
  }

  async #buildManifestWithCrypto(
    crypto: VaultCrypto | null,
    parent: string | null,
    files: Record<string, FileEntry>,
    blobs: string[]
  ): Promise<Manifest> {
    const common = {
      id: this.#ulid(),
      parent,
      device: this.#deviceName,
      createdAt: new Date(this.#now()).toISOString(),
    };
    if (crypto === null) return { v: 1, ...common, files };
    // The envelope has to exist before the ciphertext can authenticate it.
    const envelope = { v: 3 as const, ...common, keyId: crypto.keyId, blobs };
    return { ...envelope, enc: await crypto.encryptJson(files, manifestAad(envelope)) };
  }

  async #uploadHash(
    hash: string,
    pathByBlob: Map<string, string>,
    files: Record<string, FileEntry>
  ): Promise<void> {
    const path = pathByBlob.get(hash);
    if (path === undefined) {
      throw new Error(`cannot re-upload missing remote-only blob ${hash}: no scanned vault path holds it`);
    }
    const entry = files[path];
    const bytes = await this.#vault.read(path);
    // Both of these mean the same thing: the file is no longer what the snapshot describes.
    // Neither is fatal — the caller rescans and publishes what the file has become.
    if (bytes.byteLength > this.#maxBlobBytes) {
      throw new FileChangedError(
        path,
        `file "${path}" grew to ${bytes.byteLength} bytes during sync, exceeding ${this.#maxBlobBytes} byte limit`
      );
    }
    const actual = await sha256Hex(bytes);
    if (actual !== entry.h) {
      throw new FileChangedError(
        path,
        `file "${path}" changed on disk mid-sync (${actual} != ${entry.h})`
      );
    }
    if (this.#crypto === null) {
      await this.#api.putBlob(hash, bytes);
      return;
    }
    const cipher = await this.#crypto.encryptBlob(actual, bytes);
    const cipherHash = await sha256Hex(cipher);
    if (cipherHash !== hash) {
      throw new Error(`internal: ciphertext hash for "${path}" is ${cipherHash}, expected ${hash}`);
    }
    await this.#api.putBlob(hash, cipher);
  }

  /**
   * Whether this vault holds nothing worth publishing.
   *
   * True for a vault with no syncable files at all, and for one whose every syncable file is
   * empty or nothing but whitespace — which is what a fresh install looks like after the app
   * has created its blank first note. Excluded, out-of-scope, hard-skipped and invalid paths
   * are not counted, because none of them would be published either way.
   *
   * Deliberately cheap and deliberately conservative. It reads no file the listing has already
   * settled, it never hashes or encrypts anything, and every uncertainty resolves to "not
   * empty": treating a vault with real notes as empty would skip publishing them.
   */
  async isEffectivelyEmpty(): Promise<boolean> {
    const candidates: VaultFile[] = [];
    for (const file of await this.#vault.list()) {
      if (alwaysSkip(file.path, this.#configDir)) continue;
      // Invalid paths are reported and never published, so they say nothing about emptiness.
      if (pathError(file.path) !== null) continue;
      if (
        (!this.#syncConfigDir && isConfigPath(file.path, this.#configDir)) ||
        this.#isExcluded(file.path) ||
        (this.#hasOnlyPaths && !this.#isIncluded(file.path))
      ) {
        continue;
      }
      // Settled by the listing: a file this large is content, whatever its bytes are. A
      // non-finite Android stat is not evidence either way, so it falls through and is read.
      if (Number.isFinite(file.size) && file.size > EMPTY_VAULT_MAX_BYTES) return false;
      candidates.push(file);
      // Past this many files it is not the brand-new device this exists for, and reading them
      // all to prove they are blank would cost more than the question is worth.
      if (candidates.length > EMPTY_VAULT_MAX_FILES) return false;
    }
    for (const file of candidates) {
      if (!isBlankContent(await this.#vault.read(file.path))) return false;
    }
    return true;
  }

  async #buildSnapshot(options?: SnapshotBuildOptions): Promise<Snapshot> {
    const files =
      options === undefined ? pathMap<FileEntry>() : copyPathMap(options.baseFiles);
    const lines: LineCounts =
      options === undefined ? pathMap<number>() : copyPathMap(options.baseLines);
    const inventory =
      options === undefined ? pathMap<VaultFile>() : copyPathMap(options.baseInventory);
    const skipped: SkippedFile[] = [];
    const scan: VaultFileToRead[] = [];
    let listed: VaultFile[];
    if (options === undefined) {
      listed = await this.#vault.list();
      for (const file of listed) inventory[file.path] = file;
    } else {
      const stats = await mapPool(options.dirtyPaths, this.#lanes, (path) =>
        this.#vault.stat(path)
      );
      listed = [];
      for (let i = 0; i < options.dirtyPaths.length; i++) {
        const path = options.dirtyPaths[i];
        delete inventory[path];
        delete files[path];
        delete lines[path];
        const file = stats[i];
        if (file !== null) {
          inventory[path] = file;
          listed.push(file);
        }
      }
    }
    // Sorted, not insertion-ordered: an incremental scan re-appends the paths it restated, and
    // collision planning groups case-folded spellings in this order. Snapshot and conflict
    // order must not depend on which files happened to be journaled.
    const occupiedPaths = Object.keys(inventory).sort((a, b) => a.localeCompare(b));

    for (const file of [...listed].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
      // Silent skips: excludes are the user's choice and junk/self-excludes are not
      // actionable, so neither belongs in the reported `skipped` list.
      if (alwaysSkip(file.path, this.#configDir)) continue;
      const invalid = pathError(file.path);
      if (invalid !== null) {
        skipped.push({ path: file.path, reason: invalid });
        continue;
      }
      if (
        (!this.#syncConfigDir && isConfigPath(file.path, this.#configDir)) ||
        this.#isExcluded(file.path) ||
        (this.#hasOnlyPaths && !this.#isIncluded(file.path))
      ) {
        continue;
      }
      // A non-finite Android stat is not evidence of size. Read it and use the actual byte
      // length; only a trustworthy over-limit stat can avoid the I/O up front.
      if (Number.isFinite(file.size) && file.size > this.#maxBlobBytes) {
        skipped.push({ path: file.path, reason: `exceeds ${this.#maxBlobBytes} byte limit` });
        continue;
      }
      scan.push(file);
    }

    // Read, hash and encrypt several files at once — on a cold vault this is the single
    // longest phase. Results are folded back in scan order so the snapshot's path order
    // (and therefore the encrypted path map) does not depend on disk timing.
    const built = await mapPool<VaultFileToRead, BuiltSnapshotItem>(scan, this.#lanes, async (file) => {
      const bytes = await this.#vault.read(file.path);
      if (bytes.byteLength > this.#maxBlobBytes) {
        return {
          kind: "skipped",
          skipped: { path: file.path, reason: `exceeds ${this.#maxBlobBytes} byte limit` },
        };
      }
      const h = await sha256Hex(bytes);
      // Counted here because this is the one place the bytes exist. Only the number is kept,
      // so the memory bound stays "lanes worth of file", not "the whole vault".
      const count = countLines(bytes);
      const common = {
        h,
        size: bytes.byteLength,
        mtime: Number.isFinite(file.mtime) ? file.mtime : 0,
        // Absent rather than zero for binary content: the history diff reads a missing count
        // as "cannot attribute", and a zero would report a confident, wrong "-40 lines".
        ...(count === null ? {} : { lines: count }),
      };
      if (this.#crypto === null) {
        return { kind: "file", path: file.path, entry: common, lines: count };
      }
      const cached = this.#state?.files[file.path];
      if (
        (this.#state?.keyId ?? null) === this.#crypto.keyId &&
        cached?.h === h &&
        cached.c !== undefined
      ) {
        return {
          kind: "file",
          path: file.path,
          entry: { ...common, c: cached.c },
          lines: count,
        };
      }
      const cipher = await this.#crypto.encryptBlob(h, bytes);
      const c = await sha256Hex(cipher);
      return {
        kind: "file",
        path: file.path,
        entry: { ...common, c },
        lines: count,
      };
    });

    for (const item of built) {
      if (item.kind === "skipped") {
        skipped.push(item.skipped);
        continue;
      }
      files[item.path] = item.entry;
      if (item.lines !== null) lines[item.path] = item.lines;
    }
    return { files, skipped, lines, occupiedPaths, inventory };
  }
}

type VaultFileToRead = { path: string; size: number; mtime: number };

type BuiltSnapshotItem =
  | { kind: "file"; path: string; entry: FileEntry; lines: number | null }
  | { kind: "skipped"; skipped: SkippedFile };

/** First path holding each blob, so an upload never rescans the whole snapshot to find one. */
function indexByBlob(files: Record<string, FileEntry>): Map<string, string> {
  const index = new Map<string, string>();
  for (const [path, entry] of Object.entries(files)) {
    const key = blobKey(entry);
    if (!index.has(key)) index.set(key, path);
  }
  return index;
}

/** Locale-independent case folding used only for destination collision detection. */
function foldPath(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/** Conflict copies created only in a push-only manifest are intentionally absent on disk. */
function isGeneratedConflictPath(path: string): boolean {
  return /(?:^|\/)[^/]+\.conflict-.+-\d{6}-\d{4}(?:-\d+)?(?:\.[^/]*)?$/.test(path);
}


function untouchable(skipped: SkippedFile[]): Set<string> {
  return new Set(skipped.map((s) => s.path));
}

/**
 * Whether a plan removes enough of the vault to be worth a human's attention.
 *
 * **Deletions decide it.** `take-theirs` only ever fires when our copy still equals the
 * base (see `planFile`), so an overwrite by construction replaces a file we had not
 * touched — it cannot destroy authored work, and the previous content is still in the
 * snapshot chain. Deletions are the case that actually makes content vanish, and a wipe is
 * what this guard exists to catch. Overwrites are still listed for context when the guard
 * does fire, because a bad remote usually mixes both.
 *
 * The test is **strictly greater than** the threshold: at the default 50 a plan must delete
 * more than half the vault to stop. At or below, it merges automatically — anything
 * unmergeable is still kept as a conflict copy by the merge itself, so nothing is lost by
 * not asking. Strictness is what keeps small vaults quiet: two files losing one is exactly
 * 50%, not more than it.
 */
function massChangeSummary(
  plan: PlannedAction[],
  ours: Record<string, FileEntry>,
  threshold: number
): MassChangeSummary | null {
  if (threshold >= 100) return null;

  const deletes = plan.filter((a) => a.plan === "delete-local").map((a) => a.path);
  const localFileCount = Object.keys(ours).length;
  if (deletes.length === 0 || localFileCount === 0) return null;

  const percent = (deletes.length * 100) / localFileCount;
  if (percent <= threshold) return null;

  const overwrites = plan
    .filter((a) => a.plan === "take-theirs" && a.ours !== undefined)
    .map((a) => a.path);
  return { deletes, overwrites, localFileCount, percent: Math.round(percent), threshold };
}

function sameFiles(a: Record<string, FileEntry>, b: Record<string, FileEntry>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every(
    (k) => Object.hasOwn(b, k) && b[k].h === a[k].h && b[k].c === a[k].c
  );
}

function sameEntry(a: FileEntry | undefined, b: FileEntry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.h === b.h;
}

function entryStats(entry: FileEntry): { mtime: number; size: number } {
  return { mtime: entry.mtime, size: entry.size };
}

function mergeOutcomes(a: MergeOutcome, b: MergeOutcome): MergeOutcome {
  return {
    pulled: a.pulled + b.pulled,
    merged: a.merged + b.merged,
    pulledChanges: [...a.pulledChanges, ...b.pulledChanges],
    conflicts: [...a.conflicts, ...b.conflicts],
    conflictDetails: [...a.conflictDetails, ...b.conflictDetails],
  };
}

/**
 * What a commit changed on the remote, with net line counts. The action names come from the same
 * snapshot diff the preview uses, so what a pass reports and what a preview promised cannot
 * drift apart.
 */
function pushedChangesOf(
  before: Record<string, FileEntry>,
  after: Record<string, FileEntry>,
  beforeLines: LineCounts | undefined,
  afterLines: LineCounts
): PassChange[] {
  return diffSnapshot(before, after).map((action) => ({
    path: action.path,
    action:
      action.action === "add" || action.action === "delete" || action.action === "merge"
        ? action.action
        : "update",
    lines: lineDelta(action.path, beforeLines, afterLines),
  }));
}

function diffSnapshot(
  before: Record<string, FileEntry>,
  after: Record<string, FileEntry>
): PreviewAction[] {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  const actions: PreviewAction[] = [];
  for (const path of [...paths].sort()) {
    if (sameEntry(before[path], after[path])) continue;
    actions.push({
      path,
      action: before[path] === undefined ? "add" : after[path] === undefined ? "delete" : "update",
    });
  }
  return actions;
}

/** A path map must not inherit Object.prototype: `__proto__` is a valid vault filename. */
function pathMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function copyPathMap<T>(source: Record<string, T>): Record<string, T> {
  const out = pathMap<T>();
  for (const [path, value] of Object.entries(source)) out[path] = value;
  return out;
}

function mergePathMaps<T>(...sources: Array<Record<string, T>>): Record<string, T> {
  const out = pathMap<T>();
  for (const source of sources) {
    for (const [path, value] of Object.entries(source)) out[path] = value;
  }
  return out;
}
