import type { SyncPassOptions, SyncResult } from "./sync";

export interface SchedulerOptions {
  engine: { sync(opts?: SyncPassOptions): Promise<SyncResult> };
  debounceMs?: number;
  retryDelaysMs?: number[];
  onResult?: (result: SyncResult) => void;
  onError?: (error: Error) => void;
}

const DEFAULT_DEBOUNCE_MS = 2000;
const DEFAULT_RETRIES_MS = [1000, 4000, 15_000];

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
    this.#running = this.#runWithRetry(opts);
    try {
      return await this.#running;
    } finally {
      this.#running = null;
      if (this.#pending) {
        this.#pending = false;
        this.#schedule();
      }
    }
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
        if (attempt >= this.#retryDelaysMs.length || this.#stopped) throw error;
        await this.#waitForRetry(this.#retryDelaysMs[attempt++]);
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

  /** Retires this scheduler and waits until an already-running engine pass has settled. */
  async stopAndWait(): Promise<void> {
    this.stop();
    try {
      await this.#running;
    } catch {
      // Retirement deliberately rejects stopped work; the caller only needs it drained.
    }
  }
}
