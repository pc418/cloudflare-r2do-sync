import type { SyncCheckpoint, SyncResult } from "./sync";
import { ApiError } from "./api";

/**
 * Durable recovery record for sync passes: where a pass that never finished stopped, and
 * whether automatic sync is paused because of it.
 *
 * Written to its own small file in this plugin's folder rather than `data.json`, so a marker
 * write never rewrites credentials or sync state, and so it survives a process the OS killed
 * mid-pass. It carries coarse phase names and timestamps only — never a path, URL, token,
 * key, note content, manifest map or raw error message.
 *
 * What it can and cannot tell apart: a pass killed before it settled leaves `active` set, and
 * the next load pauses automatic sync. A pass that settled and was followed by a crash (for
 * example while the app indexes the files it just wrote) leaves `lastCompleted` and no
 * `active`, so it is NOT attributed to sync and does not pause anything; the trace then shows
 * a `plugin-load` after `pass-complete` rather than an interrupted pass.
 */

export const DIAGNOSTIC_SCHEMA = "iphone-recovery-1";
export const DIAGNOSTIC_FILE = "sync-recovery.json";
export const TRACE_LIMIT = 24;

/** Every event the trace may hold. A closed set is what keeps the record free of user data. */
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
  /** Automatic sync is paused until explicitly resumed. Holds the pass that never finished. */
  paused: { since: number; interrupted: ActivePass } | null;
  lastCompleted: { startedAt: number; finishedAt: number; status: SyncResult["status"] } | null;
  /** `error` is a coarse kind (`http-<status>` or `error`), never the error's own message. */
  lastFailed: { startedAt: number; finishedAt: number; error: string } | null;
  trace: TraceEntry[];
}

/** The slice of Obsidian's `DataAdapter` this needs; all three exist since before 1.5. */
export interface DiagnosticStorage {
  stat(path: string): Promise<{ type: string } | null>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
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
  /** Automatic sync is paused (either just now, or still from an earlier load). */
  paused: boolean;
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
}

function freshRecord(pluginVersion: string, platform: string): DiagnosticRecord {
  return {
    schema: DIAGNOSTIC_SCHEMA,
    pluginVersion,
    platform,
    active: null,
    paused: null,
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
  #record: DiagnosticRecord;
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
    this.#now = opts.now ?? Date.now;
    this.#onFailure = opts.onFailure;
    this.#record = freshRecord(opts.pluginVersion, opts.platform);
  }

  get path(): string {
    return this.#path;
  }

  get paused(): boolean {
    return this.#record.paused !== null;
  }

  get failure(): DiagnosticFailure | null {
    return this.#failure;
  }

  /** Automatic sync must not start: paused after an interrupted pass, or logging is broken. */
  get blocksAutomatic(): boolean {
    return this.paused || this.#failure !== null;
  }

  /** A copy of the in-memory record, for the exported report. */
  snapshot(): DiagnosticRecord {
    return JSON.parse(JSON.stringify(this.#record)) as DiagnosticRecord;
  }

  /**
   * Reads the previous record. An absent file is normal. An active marker becomes a pause,
   * persisted before this returns so it survives the next restart too.
   */
  async load(): Promise<LoadOutcome> {
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
      this.#push("plugin-load");
      return { paused: this.paused, failure: this.#failure };
    }
    if (text !== null) {
      const parsed = parseRecord(text);
      if (parsed === null) {
        this.#fail("parse", new Error("recovery record is not readable"));
        this.#push("plugin-load");
        return { paused: this.paused, failure: this.#failure };
      }
      // Identity describes the build writing the record now, not the one that wrote it last.
      this.#record = { ...parsed, pluginVersion, platform };
    }
    this.#push("plugin-load");
    const interrupted = this.#record.active;
    if (interrupted !== null) {
      const at = this.#now();
      this.#record.active = null;
      this.#record.paused = { since: at, interrupted };
      this.#push("recovery-paused", at);
      try {
        await this.#write();
      } catch (e) {
        this.#fail("write", e);
      }
    }
    return { paused: this.paused, failure: this.#failure };
  }

  /** Persists the active marker. Throws, and the pass must not start, if that fails. */
  async beginPass(): Promise<PassToken> {
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
        // phantom active pass and pause the following launch again.
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
   * clear it. Never throws; a failed write leaves the marker on disk, which pauses the next
   * load — the conservative direction.
   */
  async finishPass(
    token: PassToken,
    outcome: { result: SyncResult } | { error: unknown }
  ): Promise<void> {
    if (this.#current !== token) return;
    this.#current = null;
    const at = this.#now();
    this.#record.active = null;
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
   * Clears the pause and any logging failure, if the cleared record can be persisted. Returns
   * whether it was: a resume that is not on disk would come back paused at the next load.
   */
  async resume(): Promise<boolean> {
    const previous = this.#record.paused;
    this.#record.paused = null;
    this.#push("resumed");
    try {
      await this.#write();
    } catch (e) {
      this.#record.paused = previous;
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
      await this.#storage.write(this.#path, `${JSON.stringify(this.#record, null, 2)}\n`);
    });
    this.#chain = write.catch(() => {});
    return write;
  }
}
