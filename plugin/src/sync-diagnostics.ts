import type { SyncCheckpoint, SyncResult } from "./sync";
import { ApiError } from "./api";

/**
 * Durable recovery record for sync passes: where a pass that never finished stopped, how many
 * passes in a row did so, and whether automatic sync is waiting out a cooldown because of it.
 *
 * Written to its own small file in this plugin's folder rather than `data.json`, so a marker
 * write never rewrites credentials or sync state, and so it survives a process the OS killed
 * mid-pass. It carries coarse phase names and timestamps only — never a path, URL, token,
 * key, note content, manifest map or raw error message.
 *
 * What it can and cannot tell apart: a pass killed before it settled leaves `active` set, and
 * the next load counts it once into `streak`. One or two in a row is ordinary on a phone
 * (backgrounding, swipe-away), so automatic sync simply continues; the third starts a cooldown
 * (`cooldownMs`), which exists only to break a crash loop and always ends by itself. Any pass
 * that settles — completed or failed — resets the streak. A pass that settled and was followed
 * by a crash (for example while the app indexes the files it just wrote) leaves
 * `lastCompleted` and no `active`, so it is NOT attributed to sync and counts for nothing; the
 * trace then shows a `plugin-load` after `pass-complete` rather than an interrupted pass.
 */

export const DIAGNOSTIC_SCHEMA = "iphone-recovery-1";
export const DIAGNOSTIC_FILE = "sync-recovery.json";
export const UNREADABLE_FILE = "sync-recovery.unreadable.txt";
export const TRACE_LIMIT = 24;
const UNREADABLE_MAX_BYTES = 65_536;

/** Interruptions in a row that automatic sync absorbs without waiting. The next one waits. */
export const FREE_INTERRUPTIONS = 2;
const COOLDOWN_BASE_MS = 15 * 60_000;
export const COOLDOWN_MAX_MS = 4 * 60 * 60_000;

/**
 * How long automatic sync waits after `streak` consecutive interrupted passes: nothing up to
 * `FREE_INTERRUPTIONS`, then 15 minutes doubling per further interruption, capped at 4 hours.
 */
export function cooldownMs(streak: number): number {
  if (streak <= FREE_INTERRUPTIONS) return 0;
  const doublings = Math.min(streak - FREE_INTERRUPTIONS - 1, 4);
  return Math.min(COOLDOWN_BASE_MS * 2 ** doublings, COOLDOWN_MAX_MS);
}

/**
 * Every event the trace may hold. A closed set is what keeps the record free of user data.
 * Never extend it lightly: 1.1.6 rejects a record with an event it does not know, so a new
 * persisted event makes the record unreadable to a build the user may roll back to
 * (`test/fixtures/sync-diagnostics-1.1.6.ts`). New top-level fields are safe; it drops them.
 */
export const TRACE_EVENTS = [
  "plugin-load",
  "recovery-paused",
  "resumed",
  "pass-start",
  "head",
  "remote",
  "scan",
  "merge",
  "upload",
  "commit",
  "save",
  "pass-complete",
  "pass-failed",
  "unreadable-set-aside",
] as const;
export type TraceEvent = (typeof TRACE_EVENTS)[number];

const TRACE_EVENT_SET: ReadonlySet<string> = new Set(TRACE_EVENTS);

export interface TraceEntry {
  at: number;
  event: TraceEvent;
}

export interface ActivePass {
  startedAt: number;
  /** The last checkpoint this pass reached, and when. */
  phase: TraceEvent;
  phaseAt: number;
}

export interface DiagnosticRecord {
  schema: typeof DIAGNOSTIC_SCHEMA;
  pluginVersion: string;
  platform: string;
  /** Set from before a pass does any work until it settles. Left set by a killed process. */
  active: ActivePass | null;
  /**
   * The 1.1.4–1.1.6 durable pause. Never set by this build, and written as `null` because
   * 1.1.6 requires the key; a stored one is lifted on load (`streak` 1).
   */
  paused: { since: number; interrupted: ActivePass } | null;
  /** Passes in a row that started and never settled. Any settled pass resets it to 0. */
  streak: number;
  /** Automatic sync waits until `until`. Set once `streak` passes `FREE_INTERRUPTIONS`. */
  cooldown: { since: number; until: number } | null;
  /** The newest interrupted pass a load consumed, and when it was found. Evidence only. */
  lastInterrupted: { detectedAt: number; pass: ActivePass } | null;
  lastCompleted: { startedAt: number; finishedAt: number; status: SyncResult["status"] } | null;
  /** `error` is a coarse kind (`http-<status>` or `error`), never the error's own message. */
  lastFailed: { startedAt: number; finishedAt: number; error: string } | null;
  trace: TraceEntry[];
}

/** The slice of Obsidian's `DataAdapter` this needs; binary I/O preserves corrupt bytes. */
export interface DiagnosticStorage {
  stat(path: string): Promise<{ type: string } | null>;
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  write(path: string, data: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
}

type ReadOutcome = "ready" | "read" | "parse";

function unreadableCopy(raw: ArrayBuffer): ArrayBuffer {
  if (raw.byteLength <= UNREADABLE_MAX_BYTES) return raw;
  const marker = new TextEncoder().encode(
    `\n[truncated: original length ${raw.byteLength} bytes]\n`
  );
  const copy = new Uint8Array(UNREADABLE_MAX_BYTES + marker.byteLength);
  copy.set(new Uint8Array(raw, 0, UNREADABLE_MAX_BYTES));
  copy.set(marker, UNREADABLE_MAX_BYTES);
  return copy.buffer;
}

export type DiagnosticFailure = "read" | "parse" | "write";

/** The active marker could not be persisted, so the pass it guards must not start. */
export class DiagnosticWriteError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("recovery logging failed: the sync recovery record could not be written, so the pass did not start", options);
    this.name = "DiagnosticWriteError";
  }
}

export interface PassToken {
  readonly seq: number;
  readonly startedAt: number;
}

export interface LoadOutcome {
  /** Automatic sync is waiting out a cooldown (started just now, or still from an earlier load). */
  coolingDown: boolean;
  /** Set when the record exists but could not be read or understood, or the pause write failed. */
  failure: DiagnosticFailure | null;
}

export interface SyncDiagnosticsOptions {
  storage: DiagnosticStorage;
  path: string;
  pluginVersion: string;
  platform: string;
  now?: () => number;
  /** Called once per transition into a failed state, so the owner can say so. */
  onFailure?: (failure: DiagnosticFailure, error: unknown) => void;
  /** Called once a newly started cooldown is persisted: `streak` interruptions, `waitMs` wait. */
  onCooldown?: (streak: number, waitMs: number) => void;
}

function freshRecord(pluginVersion: string, platform: string): DiagnosticRecord {
  return {
    schema: DIAGNOSTIC_SCHEMA,
    pluginVersion,
    platform,
    active: null,
    paused: null,
    streak: 0,
    cooldown: null,
    lastInterrupted: null,
    lastCompleted: null,
    lastFailed: null,
    trace: [],
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parseActive(v: unknown): ActivePass | null | undefined {
  if (v === null) return null;
  if (!isObject(v)) return undefined;
  if (!isTime(v.startedAt) || !isTime(v.phaseAt)) return undefined;
  if (typeof v.phase !== "string" || !TRACE_EVENT_SET.has(v.phase)) return undefined;
  return { startedAt: v.startedAt, phase: v.phase as TraceEvent, phaseAt: v.phaseAt };
}

/**
 * Validates a stored record field by field and rebuilds it from known fields only. Returns
 * null for anything that is not this schema — the caller treats that as unreadable, never as
 * "no record", because an unreadable record may have been holding an active marker.
 */
export function parseRecord(text: string): DiagnosticRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.schema !== DIAGNOSTIC_SCHEMA) return null;
  const active = parseActive(raw.active);
  if (active === undefined) return null;
  let paused: DiagnosticRecord["paused"] = null;
  if (raw.paused !== null) {
    if (!isObject(raw.paused) || !isTime(raw.paused.since)) return null;
    const interrupted = parseActive(raw.paused.interrupted);
    if (!interrupted) return null;
    paused = { since: raw.paused.since, interrupted };
  }
  // Absent means a 1.1.4–1.1.6 record: its pause was one interruption, already consumed. A
  // present value that is not a count is unreadable, never mistaken for that older shape.
  let streak = paused === null ? 0 : 1;
  if ("streak" in raw) {
    if (typeof raw.streak !== "number" || !Number.isSafeInteger(raw.streak) || raw.streak < 0) {
      return null;
    }
    streak = raw.streak;
  }
  let cooldown: DiagnosticRecord["cooldown"] = null;
  if (raw.cooldown !== undefined && raw.cooldown !== null) {
    const c = raw.cooldown;
    if (!isObject(c) || !isTime(c.since) || !isTime(c.until)) return null;
    cooldown = { since: c.since, until: c.until };
  }
  let lastInterrupted: DiagnosticRecord["lastInterrupted"] = null;
  if (raw.lastInterrupted !== undefined && raw.lastInterrupted !== null) {
    const l = raw.lastInterrupted;
    if (!isObject(l) || !isTime(l.detectedAt)) return null;
    const pass = parseActive(l.pass);
    if (!pass) return null;
    lastInterrupted = { detectedAt: l.detectedAt, pass };
  }
  let lastCompleted: DiagnosticRecord["lastCompleted"] = null;
  if (raw.lastCompleted !== null) {
    const c = raw.lastCompleted;
    if (!isObject(c) || !isTime(c.startedAt) || !isTime(c.finishedAt) || typeof c.status !== "string") {
      return null;
    }
    lastCompleted = {
      startedAt: c.startedAt,
      finishedAt: c.finishedAt,
      status: c.status as SyncResult["status"],
    };
  }
  let lastFailed: DiagnosticRecord["lastFailed"] = null;
  if (raw.lastFailed !== null) {
    const f = raw.lastFailed;
    if (!isObject(f) || !isTime(f.startedAt) || !isTime(f.finishedAt) || typeof f.error !== "string") {
      return null;
    }
    lastFailed = { startedAt: f.startedAt, finishedAt: f.finishedAt, error: f.error };
  }
  if (!Array.isArray(raw.trace)) return null;
  const trace: TraceEntry[] = [];
  for (const entry of raw.trace) {
    if (!isObject(entry) || !isTime(entry.at)) return null;
    if (typeof entry.event !== "string" || !TRACE_EVENT_SET.has(entry.event)) return null;
    trace.push({ at: entry.at, event: entry.event as TraceEvent });
  }
  return {
    schema: DIAGNOSTIC_SCHEMA,
    pluginVersion: typeof raw.pluginVersion === "string" ? raw.pluginVersion : "unknown",
    platform: typeof raw.platform === "string" ? raw.platform : "unknown",
    active,
    paused,
    streak,
    cooldown,
    lastInterrupted,
    lastCompleted,
    lastFailed,
    trace: trace.slice(-TRACE_LIMIT),
  };
}

/** A coarse, message-free description of why a pass failed. */
export function errorKind(error: unknown): string {
  if (error instanceof ApiError) return `http-${error.status}`;
  if (error instanceof DiagnosticWriteError) return "recovery-log-write";
  return "error";
}

export class SyncDiagnostics {
  readonly #storage: DiagnosticStorage;
  readonly #path: string;
  readonly #now: () => number;
  readonly #onFailure: SyncDiagnosticsOptions["onFailure"];
  readonly #onCooldown: SyncDiagnosticsOptions["onCooldown"];
  #record: DiagnosticRecord;
  /** False after an unreadable load: no write may replace a record we have not examined. */
  #recordTrusted = false;
  #failure: DiagnosticFailure | null = null;
  /** Serialises writes. Each write serialises the record as it is when the write runs. */
  #chain: Promise<void> = Promise.resolve();
  #seq = 0;
  #current: PassToken | null = null;
  /** After unload nothing here writes again: a finishing old pass must not clear a marker. */
  #retired = false;

  constructor(opts: SyncDiagnosticsOptions) {
    this.#storage = opts.storage;
    this.#path = opts.path;
    // Looked up per call, not captured: the cooldown is checked against the clock as it reads now.
    this.#now = opts.now ?? (() => Date.now());
    this.#onFailure = opts.onFailure;
    this.#onCooldown = opts.onCooldown;
    this.#record = freshRecord(opts.pluginVersion, opts.platform);
  }

  get path(): string {
    return this.#path;
  }

  /**
   * Automatic sync is waiting out a cooldown after repeated interruptions. Read against the
   * clock each time, and expiry is irreversible: the first check that finds the deadline passed
   * — or the clock reading before the cooldown began, which can only be a correction — retires
   * the cooldown in memory, and the next write persists that, so no later clock step revives
   * it. A stored deadline past `since` + the 4-hour cap is never honoured.
   *
   * Limitation: with no monotonic clock across reloads, a backward step *during* a live
   * cooldown that still lands after `since` lengthens that one cooldown by the step — bounded
   * by the cap plus the step.
   */
  get coolingDown(): boolean {
    return this.cooldownRemainingMs > 0;
  }

  /** How long automatic sync still waits; 0 once the cooldown has ended (see `coolingDown`). */
  get cooldownRemainingMs(): number {
    const cooldown = this.#record.cooldown;
    if (cooldown === null) return 0;
    const now = this.#now();
    const deadline = Math.min(cooldown.until, cooldown.since + COOLDOWN_MAX_MS);
    if (now >= cooldown.since && now < deadline) return deadline - now;
    this.#record.cooldown = null;
    // Persisted at once: left only in memory, a reload under a clock set back into the old
    // window would read the cooldown back from disk. Like a checkpoint, a failed write is a
    // logging failure and never reaches the caller; memory stays cleared. Never written over
    // a record not yet read safely, nor after retirement.
    if (this.#recordTrusted && !this.#retired) {
      this.#write().catch((e: unknown) => this.#fail("write", e));
    }
    return 0;
  }

  get failure(): DiagnosticFailure | null {
    return this.#failure;
  }

  /** Automatic sync must not start: cooling down after repeated interruptions, or logging is broken. */
  get blocksAutomatic(): boolean {
    return this.coolingDown || this.#failure !== null;
  }

  /** A copy of the in-memory record, for the exported report. */
  snapshot(): DiagnosticRecord {
    return JSON.parse(JSON.stringify(this.#record)) as DiagnosticRecord;
  }

  /**
   * Reads the previous record. An absent file is normal. An active marker is counted into the
   * streak exactly once, persisted before this returns: automatic sync may only start on a
   * counted interruption, and a reload without a new pass finds nothing left to count.
   */
  async load(): Promise<LoadOutcome> {
    if ((await this.#readStored()) !== "ready") {
      this.#push("plugin-load");
      return { coolingDown: this.coolingDown, failure: this.#failure };
    }
    this.#push("plugin-load");
    await this.#consumeInterrupted();
    return { coolingDown: this.coolingDown, failure: this.#failure };
  }

  /** Reads a trustworthy base before any write. A failed read/parse leaves the disk untouched. */
  async #readStored(): Promise<ReadOutcome> {
    const { pluginVersion, platform } = this.#record;
    let text: string | null = null;
    try {
      const stat = await this.#storage.stat(this.#path);
      if (stat !== null) {
        if (stat.type !== "file") throw new Error("recovery record path is not a file");
        text = await this.#storage.read(this.#path);
      }
    } catch (e) {
      this.#fail("read", e);
      return "read";
    }
    if (text !== null) {
      const parsed = parseRecord(text);
      if (parsed === null) {
        this.#fail("parse", new Error("recovery record is not readable"));
        return "parse";
      }
      // Identity describes the build writing the record now, not the one that wrote it last.
      this.#record = { ...parsed, pluginVersion, platform };
    } else {
      this.#record = freshRecord(pluginVersion, platform);
    }
    this.#recordTrusted = true;
    return "ready";
  }

  /**
   * Consumes an old active marker into the streak, and lifts a 1.1.4–1.1.6 pause (already
   * counted as one by `parseRecord`). Up to `FREE_INTERRUPTIONS` in a row, automatic sync just
   * continues — `streak` and `lastInterrupted` are the evidence; there is deliberately no trace
   * event for it (see `TRACE_EVENTS`). Past it, a cooldown starts from now. Persisted in one
   * write, or not at all.
   */
  async #consumeInterrupted(): Promise<boolean> {
    const interrupted = this.#record.active;
    const legacy = this.#record.paused;
    if (interrupted === null && legacy === null) return true;
    const at = this.#now();
    let waitMs = 0;
    if (legacy !== null) {
      this.#record.paused = null;
      this.#record.lastInterrupted = { detectedAt: legacy.since, pass: legacy.interrupted };
    }
    if (interrupted !== null) {
      this.#record.active = null;
      this.#record.streak += 1;
      this.#record.lastInterrupted = { detectedAt: at, pass: interrupted };
      waitMs = cooldownMs(this.#record.streak);
      this.#record.cooldown = waitMs > 0 ? { since: at, until: at + waitMs } : null;
    }
    if (waitMs > 0) this.#push("recovery-paused", at);
    try {
      await this.#write();
    } catch (e) {
      // The disk may still hold the active marker. Re-read it before any later write; it is
      // counted once that write succeeds — never twice, and never without being persisted.
      this.#recordTrusted = false;
      this.#fail("write", e);
      return false;
    }
    if (waitMs > 0) this.#onCooldown?.(this.#record.streak, waitMs);
    return true;
  }

  /** Retry a failed load before Resume or manual Sync now can write anything. */
  async #recoverUnread(): Promise<ReadOutcome | "write"> {
    if (this.#recordTrusted) return "ready";
    const read = await this.#readStored();
    if (read !== "ready") return read;
    this.#push("plugin-load");
    if (!(await this.#consumeInterrupted())) return "write";
    // A discovered cooldown still blocks automation, but the unread-record failure is resolved.
    if (this.coolingDown) this.#failure = null;
    return "ready";
  }

  /** Persists the active marker. Throws, and the pass must not start, if that fails. */
  async beginPass(): Promise<PassToken> {
    const recovered = await this.#recoverUnread();
    if (recovered === "read") {
      throw new Error("recovery logging failed: the recovery record could not be read, so the pass did not start");
    }
    if (recovered === "parse") {
      throw new Error(
        "recovery logging failed: the recovery record is unreadable. Use Resume automatic sync in the Troubleshooting settings to set it aside, then sync again"
      );
    }
    if (recovered === "write") throw new DiagnosticWriteError();
    const token: PassToken = { seq: ++this.#seq, startedAt: this.#now() };
    this.#record.active = { startedAt: token.startedAt, phase: "pass-start", phaseAt: token.startedAt };
    this.#current = token;
    this.#push("pass-start", token.startedAt);
    try {
      await this.#write();
    } catch (e) {
      this.#fail("write", e);
      if (this.#current === token) {
        this.#current = null;
        // No engine work started. A later successful resume must not persist a
        // phantom active pass for the following launch to count as an interruption.
        this.#record.active = null;
      }
      throw new DiagnosticWriteError({ cause: e });
    }
    return token;
  }

  /** Records a coarse phase of the running pass. Never throws: a trace gap must not fail a pass. */
  async checkpoint(token: PassToken, phase: SyncCheckpoint | "save"): Promise<void> {
    if (this.#current !== token || this.#record.active === null) return;
    const at = this.#now();
    this.#record.active = { ...this.#record.active, phase, phaseAt: at };
    this.#push(phase, at);
    try {
      await this.#write();
    } catch (e) {
      this.#fail("write", e);
    }
  }

  /**
   * Records how a pass settled and clears its marker. Only the pass that set the marker can
   * clear it. A settled pass — completed or failed: a sync error is not a killed process —
   * also resets the streak and ends any cooldown, in the same write. Never throws; a failed
   * write leaves the marker on disk, which the next load counts as an interruption — the
   * conservative direction.
   */
  async finishPass(
    token: PassToken,
    outcome: { result: SyncResult } | { error: unknown }
  ): Promise<void> {
    if (this.#current !== token) return;
    this.#current = null;
    const at = this.#now();
    this.#record.active = null;
    this.#record.streak = 0;
    this.#record.cooldown = null;
    if ("result" in outcome) {
      this.#record.lastCompleted = {
        startedAt: token.startedAt,
        finishedAt: at,
        status: outcome.result.status,
      };
      this.#push("pass-complete", at);
    } else {
      this.#record.lastFailed = {
        startedAt: token.startedAt,
        finishedAt: at,
        error: errorKind(outcome.error),
      };
      this.#push("pass-failed", at);
    }
    try {
      await this.#write();
    } catch (e) {
      this.#fail("write", e);
    }
  }

  /**
   * Resets the streak, ends any cooldown and clears any logging failure, if the cleared record
   * can be persisted. Returns whether it was: a resume that is not on disk would come back
   * waiting at the next load. Never required — a cooldown ends by itself — only an override.
   */
  async resume(): Promise<boolean> {
    const unread = !this.#recordTrusted;
    const recovered = await this.#recoverUnread();
    if (recovered === "parse") return await this.#setAsideUnreadable();
    if (recovered !== "ready") return false;
    // The failed read hid a real cooldown. Show it first; another deliberate Resume may end
    // it, but this one must not silently undo the recovered evidence.
    if (unread && this.coolingDown) return false;
    return await this.#resumeTrusted();
  }

  /** An explicit Resume may replace a corrupt record only after its bytes are set aside. */
  async #setAsideUnreadable(): Promise<boolean> {
    let raw: ArrayBuffer;
    try {
      raw = await this.#storage.readBinary(this.#path);
    } catch (e) {
      this.#failure = null; // the binary read is a new failed recovery attempt
      this.#fail("read", e);
      return false;
    }

    // The file could have been repaired between the text and binary reads. Reconcile a valid
    // record instead of discarding it on the strength of an earlier parse failure.
    let parsed: DiagnosticRecord | null = null;
    try {
      parsed = parseRecord(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    } catch {
      // Invalid UTF-8 is itself unreadable; its original bytes still go to the sidecar.
    }
    if (parsed !== null) {
      const { pluginVersion, platform } = this.#record;
      this.#record = { ...parsed, pluginVersion, platform };
      this.#recordTrusted = true;
      this.#push("plugin-load");
      if (!(await this.#consumeInterrupted())) return false;
      if (this.coolingDown) {
        this.#failure = null;
        return false;
      }
      return await this.#resumeTrusted();
    }

    try {
      const dir = this.#path.slice(0, this.#path.lastIndexOf("/") + 1);
      await this.#storage.writeBinary(`${dir}${UNREADABLE_FILE}`, unreadableCopy(raw));
    } catch (e) {
      this.#failure = null; // report this failed preservation attempt, not only the old parse
      this.#fail("write", e);
      return false;
    }

    const { pluginVersion, platform } = this.#record;
    this.#record = freshRecord(pluginVersion, platform);
    this.#recordTrusted = true;
    this.#push("unreadable-set-aside");
    try {
      await this.#write();
    } catch (e) {
      this.#recordTrusted = false;
      this.#failure = null;
      this.#fail("write", e);
      return false;
    }
    this.#failure = null;
    return true;
  }

  async #resumeTrusted(): Promise<boolean> {
    const { paused, streak, cooldown } = this.#record;
    this.#record.paused = null;
    this.#record.streak = 0;
    this.#record.cooldown = null;
    this.#push("resumed");
    try {
      await this.#write();
    } catch (e) {
      Object.assign(this.#record, { paused, streak, cooldown });
      this.#failure = null; // re-arm the transition so the failure is reported again
      this.#fail("write", e);
      return false;
    }
    this.#failure = null;
    return true;
  }

  /** Stops every later write from this instance; the record on disk stays as it is. */
  retire(): void {
    this.#retired = true;
  }

  #push(event: TraceEvent, at = this.#now()): void {
    const trace = [...this.#record.trace, { at, event }];
    this.#record.trace = trace.slice(-TRACE_LIMIT);
  }

  #fail(failure: DiagnosticFailure, error: unknown): void {
    const transition = this.#failure === null;
    this.#failure = failure;
    if (transition) this.#onFailure?.(failure, error);
  }

  #write(): Promise<void> {
    const write = this.#chain.then(async () => {
      if (this.#retired) throw new Error("recovery logging retired with the plugin");
      if (!this.#recordTrusted) throw new Error("recovery record has not been read safely");
      await this.#storage.write(this.#path, `${JSON.stringify(this.#record, null, 2)}\n`);
    });
    this.#chain = write.catch(() => {});
    return write;
  }
}
