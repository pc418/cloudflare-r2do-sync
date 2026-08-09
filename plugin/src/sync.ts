import { MissingBlobError, StaleHeadError } from "./api";
import type { VaultCrypto } from "./crypto";
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
import { alwaysSkip, DEFAULT_CONFIG_DIR, isConfigPath, makeExcluder, pathError } from "./paths";
import { DEFAULT_LANES, clampLanes, mapPool } from "./pool";
import { createUlidFactory } from "./ulid";
import { isSyncMode, type SyncMode } from "./sync-policy";
import {
  blobKey,
  isEmptyManifest,
  type FileEntry,
  type Manifest,
  type StateStore,
  type SyncState,
  type VaultAdapter,
  type VaultFile,
} from "./types";

export interface SyncApiLike {
  getHead(): Promise<string | null>;
  getManifest(id: string): Promise<Manifest>;
  getBlob(hash: string): Promise<Uint8Array>;
  checkBlobs(hashes: string[]): Promise<string[]>;
  putBlob(hash: string, bytes: Uint8Array): Promise<void>;
  commit(manifest: Manifest, expectedHead: string | null): Promise<string>;
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

export type SyncResult =
  | ({ status: "committed"; head: string } & ResultBase)
  | ({ status: "pulled"; head: string } & ResultBase)
  | ({ status: "unchanged" } & ResultBase)
  | ({ status: "needs-decision"; summary: MassChangeSummary } & ResultBase)
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
}

/** One entry in the snapshot chain, as shown in the history browser. */
export interface SnapshotInfo {
  id: string;
  parent: string | null;
  device: string;
  createdAt: string;
  /** Null when this device's key cannot open the snapshot. */
  fileCount: number | null;
  readable: boolean;
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

export interface SyncPassOptions {
  /**
   * Force this device's snapshot over the remote: absorb the remote head only as the CAS
   * parent, apply nothing from it, and do not consult the mass-change guard — the operator
   * has already answered the question the guard exists to ask. Local files are never
   * written or removed. Refused in `pull-only` mode, which never commits at all.
   */
  keepLocal?: boolean;
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
  readonly #onProgress: SyncEngineOptions["onProgress"];
  readonly #lanes: number;

  #state: SyncState | null = null;
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
    this.#onProgress = opts.onProgress;
    this.#lanes = clampLanes(opts.lanes ?? DEFAULT_LANES);
  }

  /** Clears a halt after the operator has fixed the key mismatch that caused it. */
  reset(): void {
    if (this.status.phase === "halted" || this.status.phase === "error") {
      this.status = { phase: "idle" };
    }
  }

  async sync(opts: SyncPassOptions = {}): Promise<SyncResult> {
    const keepLocal = opts.keepLocal === true;
    if (keepLocal && this.#mode === "pull-only") {
      throw new Error(
        'sync direction is "pull-only", so this device never commits — it cannot push its ' +
          "files over the remote. Change the direction first."
      );
    }
    if (this.status.phase === "halted") {
      return this.#result({ status: "halted", reason: this.status.message ?? "sync halted" });
    }
    // A pass must not interleave with a restore, a migration or a forced pull: those rewrite
    // the vault, and a pass that began halfway through one would plan against a snapshot that
    // is half old and half new. The scheduler already serialises passes against each other.
    if (this.status.phase === "syncing") throw new Error("sync is already running");
    this.status = { phase: "syncing" };
    try {
      return await this.#sync(keepLocal);
    } catch (e) {
      if (e instanceof HaltError) return this.#halt(e.message);
      if (this.status.phase === "syncing") {
        this.status = { phase: "error", message: e instanceof Error ? e.message : String(e) };
      }
      throw e;
    }
  }

  #result(extra: Partial<SyncResult> & { status: SyncResult["status"] }): SyncResult {
    return {
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

  async #sync(forceKeepLocal = false): Promise<SyncResult> {
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
    /** Line counts for the snapshot this pass starts from; the baseline for every net figure. */
    const baseLines = state.lines;

    const outcome: MergeOutcome = { pulled: 0, merged: 0, pulledChanges: [], conflicts: [], conflictDetails: [] };

    // Two independent reasons to go round again, so two independent budgets: losing the head
    // race says another device is busy, a rescan says this vault is. Sharing one counter made
    // the "another device keeps committing" message lie about which happened.
    let casAttempt = 1;
    let rescans = 0;

    for (;;) {
      const serverHead = await this.#api.getHead();
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
        const remote = await this.#api.getManifest(serverHead);
        const mismatch = this.#modeError(remote, serverHead);
        if (mismatch !== null) return this.#halt(mismatch, outcome);
        remoteFiles = await this.#remoteFiles(remote);

        const local = await this.#buildSnapshot();
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
          pushAttemptOutcome.conflictDetails.push(
            ...collisionResolution.conflictDetails,
            ...planned.outcome.conflictDetails
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
      }

      if (this.#mode === "pull-only") {
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
      const { files, skipped, lines: freshLines } = await this.#buildSnapshot();
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

      if (remoteFiles === null && !keyMigrationPending && sameFiles(finalFiles, baseFiles)) {
        this.status = { phase: "idle", lastSyncAt: this.#now() };
        return this.#result({
          status: "unchanged",
          skipped,
          ...mergeOutcomes(outcome, pushAttemptOutcome),
        });
      }

      if (
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
      const missing = await this.#api.checkBlobs(hashes);
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

        const manifest = await this.#buildManifest(serverHead, finalFiles, hashes);
        try {
          head = await this.#api.commit(manifest, serverHead);
        } catch (e) {
          if (!(e instanceof MissingBlobError)) throw e;
          // Blob vanished between check and commit (GC race). Re-upload exactly once.
          await mapPool(e.hashes, this.#lanes, async (hash) => {
            await this.#uploadHash(hash, pathByBlob, files);
            uploaded++;
          });
          head = await this.#api.commit(manifest, serverHead);
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
    if (targetCrypto === null) return { h: entry.h, size: entry.size, mtime: entry.mtime };
    const cipher = await targetCrypto.encryptBlob(entry.h, plain);
    return {
      h: entry.h,
      size: entry.size,
      mtime: entry.mtime,
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

    if (remote.v === 2 && this.#crypto === null) {
      return `remote snapshot at ${head} is encrypted, but no vault master key is set on this device. Add the key in settings before syncing.`;
    }
    if (remote.v === 1 && this.#crypto !== null) {
      return `remote snapshot at ${head} is unencrypted, but this device has encryption enabled. Committing would mix modes; reset the remote or clear the master key first.`;
    }
    if (remote.v === 2 && this.#crypto !== null && remote.keyId !== this.#crypto.keyId) {
      return `remote snapshot at ${head} was encrypted with a different master key (remote ${remote.keyId}, ours ${this.#crypto.keyId}). Sync would be unreadable; check the key before continuing.`;
    }
    return null;
  }

  async #remoteFiles(remote: Manifest): Promise<Record<string, FileEntry>> {
    if (remote.v === 1) return copyPathMap(remote.files);
    if (this.#crypto === null) throw new HaltError("remote is encrypted and no master key is set");
    return copyPathMap(await this.#crypto.decryptJson<Record<string, FileEntry>>(remote.enc));
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
    if (serverHead !== null && serverHead !== state.lastSyncedHead) {
      const remote = await this.#api.getManifest(serverHead);
      const mismatch = this.#modeError(remote, serverHead);
      if (mismatch !== null) {
        return { head: serverHead, pull: [], push: [], skipped: [], guard: null, halted: mismatch };
      }
      remoteFiles = await this.#remoteFiles(remote);
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
   * Walks the snapshot chain back from the current head. Stops early at a missing ancestor
   * (garbage collection trims old manifests by design) and marks — rather than throws on —
   * a snapshot this device's key cannot open, so one unreadable entry does not hide the
   * readable history behind it.
   */
  async listHistory(limit: number): Promise<SnapshotInfo[]> {
    const out: SnapshotInfo[] = [];
    let id = await this.#api.getHead();

    while (id !== null && out.length < limit) {
      let manifest: Manifest;
      try {
        manifest = await this.#api.getManifest(id);
      } catch {
        break;
      }
      let fileCount: number | null = null;
      let readable = true;
      try {
        fileCount = Object.keys(await this.#remoteFiles(manifest)).length;
      } catch {
        readable = false;
      }
      out.push({
        id: manifest.id,
        parent: manifest.parent,
        device: manifest.device,
        createdAt: manifest.createdAt,
        fileCount,
        readable,
      });
      id = manifest.parent;
    }
    return out;
  }

  /** The path → entry map a snapshot recorded, decrypting the path map when needed. */
  async snapshotFiles(id: string): Promise<Record<string, FileEntry>> {
    return await this.#remoteFiles(await this.#api.getManifest(id));
  }

  /** Writes one file back to its original path as it was in the given snapshot. */
  async restoreFile(id: string, path: string): Promise<void> {
    if (this.#notScanned(path)) {
      throw new Error(`"${path}" is not synced by this device — refusing to restore it`);
    }
    const entry = (await this.snapshotFiles(id))[path];
    if (entry === undefined) throw new Error(`"${path}" is not in snapshot ${id}`);
    await this.#vault.write(path, await this.#fetch(entry));
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
  async forcePull(): Promise<ForcePullResult> {
    return await this.#exclusive(async () => {
      const plan = await this.#forcePullPlan();
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

  async #forcePullPlan(): Promise<ForcePullPlan> {
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
    return {
      v: 2,
      ...common,
      keyId: crypto.keyId,
      blobs,
      enc: await crypto.encryptJson(files),
    };
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

  async #buildSnapshot(): Promise<Snapshot> {
    const files = pathMap<FileEntry>();
    const lines: LineCounts = pathMap<number>();
    const skipped: SkippedFile[] = [];
    const scan: VaultFileToRead[] = [];
    const listed = await this.#vault.list();
    const occupiedPaths = listed.map((file) => file.path);

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
      const common = {
        h,
        size: bytes.byteLength,
        mtime: Number.isFinite(file.mtime) ? file.mtime : 0,
      };
      // Counted here because this is the one place the bytes exist. Only the number is kept,
      // so the memory bound stays "lanes worth of file", not "the whole vault".
      const count = countLines(bytes);
      if (this.#crypto === null) {
        return { kind: "file", path: file.path, entry: common, lines: count };
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
    return { files, skipped, lines, occupiedPaths };
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
