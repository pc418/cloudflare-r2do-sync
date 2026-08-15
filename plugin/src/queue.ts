import type { SyncPassOptions, SyncResult } from "./sync";
import { ApiError } from "./api";

export interface SchedulerOptions {
  engine: { sync(opts?: SyncPassOptions): Promise<SyncResult> };
  debounceMs?: number;
  retryDelaysMs?: number[];
  onResult?: (result: SyncResult) => void;
  onError?: (error: Error) => void;
}

/**
 * Progress for one exclusive operation, so a caller can say which of the two waits it is in.
 *
 * Deliberately hooks rather than a `busy` flag the caller polls: "was the lane occupied when I
 * clicked" is not the same question as "has my operation started", and only the second one can
 * end a wait. Both are optional, and neither carries wording — the scheduler has no business
 * knowing what a button says.
 */
export interface ExclusiveHooks {
  /** Work was already in the lane, so this operation has to wait. Called synchronously. */
  onQueued?: () => void;
  /** This operation now owns the lane and is about to run. */
  onStart?: () => void;
}

const DEFAULT_DEBOUNCE_MS = 2000;
const DEFAULT_RETRIES_MS = [1000, 4000, 15_000];

/** Whole-pass retries are reserved for failures that can plausibly heal without user action. */
export function isRetryable(error: unknown): error is ApiError {
  if (!(error instanceof ApiError)) return false;
  return (
    error.status === 0 ||
    error.status === 408 ||
    error.status === 429 ||
    (error.status >= 500 && error.status <= 599)
  );
}

/**
 * Coalesces vault events into one push at a time, with backoff for transient failures.
 * A halted engine is never retried — divergence needs a human, and hammering it would
 * only bury the notice.
 */
export class SyncScheduler {
  readonly #engine: { sync(opts?: SyncPassOptions): Promise<SyncResult> };
  readonly #debounceMs: number;
  readonly #retryDelaysMs: number[];
  readonly #onResult?: (result: SyncResult) => void;
  readonly #onError?: (error: Error) => void;

  #timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The one lane for every operation that must not overlap a sync pass. Keeping this separate
   * from `#running` preserves ordinary-pass coalescing: `#running` answers whether a sync has
   * already been requested, while this tail also covers short local vault mutations queued
   * before or after it.
   */
  #lane: Promise<void> = Promise.resolve();
  /** Entries enqueued and not yet settled. Non-zero means the next one has to wait. */
  #laneDepth = 0;
  #running: Promise<SyncResult> | null = null;
  #pending = false;
  #stopped = false;
  #cancelBackoff: (() => void) | null = null;

  lastError: Error | null = null;
  lastResult: SyncResult | null = null;

  constructor(opts: SchedulerOptions) {
    this.#engine = opts.engine;
    this.#debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRIES_MS;
    this.#onResult = opts.onResult;
    this.#onError = opts.onError;
  }

  /** A vault event arrived; push once the edits settle. */
  notifyChange(): void {
    if (this.#stopped) return;
    if (this.#running) {
      this.#pending = true;
      return;
    }
    this.#schedule();
  }

  #schedule(): void {
    if (this.#stopped) return;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.syncNow().catch(() => {
        // already reported via lastError/onError
      });
    }, this.#debounceMs);
  }

  async syncNow(opts: SyncPassOptions = {}): Promise<SyncResult> {
    // A manual pass supersedes a pass that was only waiting for the debounce window.
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#stopped) throw new Error("sync scheduler stopped");
    if (this.#running) {
      // An ordinary request is satisfied by the pass already in flight. A forced direction
      // is not: returning its result would report a force that never happened.
      if (opts.keepLocal === true || opts.reroot !== undefined) {
        throw new Error("a sync is already running — wait for it to finish, then force again");
      }
      return this.#running;
    }
    this.#running = this.#enqueue(() => this.#runWithRetry(opts));
    try {
      return await this.#running;
    } finally {
      // No identity check is needed: the early return above means nothing can install a
      // different `#running` while this one is outstanding.
      this.#running = null;
      if (this.#pending) {
        this.#pending = false;
        this.#schedule();
      }
    }
  }

  /**
   * Runs a local vault mutation in the same exclusive lane as sync passes.
   *
   * A conflict choice can therefore wait behind a pass instead of failing merely because the
   * click landed during one. A later pass also waits behind the mutation, closing the race an
   * `await currentPass` followed by an unguarded write would leave. Operation failures belong
   * to their caller and are not reported as sync failures; either way, the lane stays usable.
   *
   * The wait can be long — a pass plus its retry backoff — so `hooks` report which wait the
   * caller is in. Backoff is part of the running entry, so an operation queued behind a
   * retrying pass stays "queued" for all of it, which is the truth.
   */
  runExclusive<T>(operation: () => Promise<T>, hooks?: ExclusiveHooks): Promise<T> {
    return this.#enqueue(operation, hooks);
  }

  #enqueue<T>(operation: () => Promise<T>, hooks?: ExclusiveHooks): Promise<T> {
    if (this.#stopped) return Promise.reject(new Error("sync scheduler stopped"));
    // Before the increment, and synchronous, so a caller can paint "waiting" in the same tick
    // as the click that caused it.
    if (this.#laneDepth > 0) hooks?.onQueued?.();
    this.#laneDepth++;
    const queued = this.#lane.then(async () => {
      try {
        // Retirement lets an operation that already started drain, but work that was only
        // waiting must never mutate through a scheduler whose configuration is obsolete.
        if (this.#stopped) throw new Error("sync scheduler stopped");
        hooks?.onStart?.();
        return await operation();
      } finally {
        this.#laneDepth--;
      }
    });
    // The tail itself never rejects: one failed operation cannot poison every later one.
    this.#lane = queued.then(
      () => {},
      () => {}
    );
    return queued;
  }

  async #runWithRetry(opts: SyncPassOptions): Promise<SyncResult> {
    let attempt = 0;
    for (;;) {
      try {
        const result = await this.#engine.sync(opts);
        // A retired scheduler must never publish a result into its replacement's UI/state.
        if (this.#stopped) throw new Error("sync scheduler stopped");
        this.lastError = null;
        this.lastResult = result;
        this.#onResult?.(result);
        return result;
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        if (this.#stopped) throw new Error("sync scheduler stopped", { cause: e });
        this.lastError = error;
        this.#onError?.(error);
        if (!isRetryable(error) || attempt >= this.#retryDelaysMs.length || this.#stopped) {
          throw error;
        }
        const configuredDelay = this.#retryDelaysMs[attempt++];
        const delay = error.status === 429 ? (error.retryAfterMs ?? configuredDelay) : configuredDelay;
        await this.#waitForRetry(delay);
        if (this.#stopped) throw new Error("sync scheduler stopped", { cause: e });
      }
    }
  }

  async #waitForRetry(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      // `let`, rather than a `const` declared below `cancel`: nothing can reach `cancel` before
      // the timer exists, but a TDZ ReferenceError is not worth having to prove that again.
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cancel = (): void => {
        if (timer !== null) clearTimeout(timer);
        // Only retire the backoff this call installed; a newer one must survive.
        if (this.#cancelBackoff === cancel) this.#cancelBackoff = null;
        resolve();
      };
      timer = setTimeout(cancel, delayMs);
      this.#cancelBackoff = cancel;
    });
  }

  stop(): void {
    this.#stopped = true;
    this.#pending = false;
    this.#cancelBackoff?.();
    this.#cancelBackoff = null;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /** Retires this scheduler and waits until every already-started/queued lane entry settles. */
  async stopAndWait(): Promise<void> {
    this.stop();
    await this.#lane;
  }
}
