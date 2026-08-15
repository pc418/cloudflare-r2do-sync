import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ApiError, AuthError, TransportError } from "../src/api";
import { SyncScheduler, isRetryable } from "../src/queue";
import type { SyncPassOptions, SyncResult } from "../src/sync";

const committed = (head: string): SyncResult => ({
  status: "committed",
  head,
  uploaded: 0,
  skipped: [],
  pushedChanges: [],
  pulledChanges: [],
  pulled: 0,
  merged: 0,
  conflicts: [],
  conflictDetails: [],
});

class FakeEngine {
  calls = 0;
  results: Array<SyncResult | Error> = [];
  inFlight = 0;
  maxConcurrent = 0;
  release: (() => void) | null = null;

  async sync(): Promise<SyncResult> {
    this.calls++;
    this.inFlight++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    if (this.release) await new Promise<void>((r) => (this.release = r));
    this.inFlight--;
    const next = this.results.shift();
    if (next instanceof Error) throw next;
    return next ?? committed("01X");
  }
}

let engine: FakeEngine;
let scheduler: SyncScheduler;

beforeEach(() => {
  vi.useFakeTimers();
  engine = new FakeEngine();
  scheduler = new SyncScheduler({
    engine: engine as never,
    debounceMs: 2000,
    retryDelaysMs: [1000, 4000],
  });
});

afterEach(() => {
  scheduler.stop();
  vi.useRealTimers();
});

describe("SyncScheduler debounce", () => {
  it("coalesces rapid changes into one push", async () => {
    scheduler.notifyChange();
    scheduler.notifyChange();
    scheduler.notifyChange();
    expect(engine.calls).toBe(0);

    await vi.advanceTimersByTimeAsync(2000);
    expect(engine.calls).toBe(1);
  });

  it("extends the window while edits keep arriving", async () => {
    scheduler.notifyChange();
    await vi.advanceTimersByTimeAsync(1500);
    scheduler.notifyChange();
    await vi.advanceTimersByTimeAsync(1500);
    expect(engine.calls).toBe(0);

    await vi.advanceTimersByTimeAsync(500);
    expect(engine.calls).toBe(1);
  });

  it("stop() cancels a pending push", async () => {
    scheduler.notifyChange();
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(engine.calls).toBe(0);
  });

  it("syncNow bypasses the debounce", async () => {
    const done = scheduler.syncNow().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    await done;
    expect(engine.calls).toBe(1);
  });

  it("syncNow cancels the pending debounced pass", async () => {
    scheduler.notifyChange();

    await scheduler.syncNow();
    await vi.advanceTimersByTimeAsync(2000);

    expect(engine.calls).toBe(1);
  });
});

describe("SyncScheduler concurrency", () => {
  it("never runs two pushes at once", async () => {
    engine.release = () => {};
    const first = scheduler.syncNow();
    await vi.advanceTimersByTimeAsync(0);
    const second = scheduler.syncNow();
    await vi.advanceTimersByTimeAsync(0);

    engine.release?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([first, second]);

    expect(engine.maxConcurrent).toBe(1);
  });

  it("runs one more pass for edits that land during an in-flight push", async () => {
    engine.release = () => {};
    const running = scheduler.syncNow();
    await vi.advanceTimersByTimeAsync(0);

    scheduler.notifyChange();
    engine.release?.();
    await running;
    await vi.advanceTimersByTimeAsync(2000);

    expect(engine.calls).toBe(2);
  });

  it("queues an exclusive vault operation behind the active pass", async () => {
    engine.release = () => {};
    let operationRan = false;
    const running = scheduler.syncNow();
    await vi.advanceTimersByTimeAsync(0);

    const operation = scheduler.runExclusive(async () => {
      // The public sync promise's continuation and this callback are neighbouring
      // microtasks; the actual invariant is that the engine has left the lane first.
      expect(engine.inFlight).toBe(0);
      operationRan = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(operationRan).toBe(false);

    engine.release?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([running, operation]);
    expect(operationRan).toBe(true);
  });

  it("queues a sync requested during an exclusive vault operation behind it", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    const operation = scheduler.runExclusive(async () => {
      order.push("resolution-start");
      await gate;
      order.push("resolution-end");
    });
    await vi.advanceTimersByTimeAsync(0);

    const running = scheduler.syncNow().then(() => order.push("sync"));
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.calls).toBe(0);

    release();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([operation, running]);
    expect(engine.calls).toBe(1);
    expect(order).toEqual(["resolution-start", "resolution-end", "sync"]);
  });

  it("starts an exclusive operation without reporting a wait when the lane is free", async () => {
    const seen: string[] = [];

    await scheduler.runExclusive(async () => seen.push("ran"), {
      onQueued: () => seen.push("queued"),
      onStart: () => seen.push("start"),
    });

    // No `queued`: nothing was ahead of it. A caller that showed "waiting" here would be
    // describing a wait that did not happen.
    expect(seen).toEqual(["start", "ran"]);
  });

  it("reports the wait synchronously, and the start only once the pass releases", async () => {
    engine.release = () => {};
    const seen: string[] = [];
    const running = scheduler.syncNow();
    await vi.advanceTimersByTimeAsync(0);

    const operation = scheduler.runExclusive(async () => seen.push("ran"), {
      onQueued: () => seen.push("queued"),
      onStart: () => seen.push("start"),
    });
    // Synchronous: the click that caused the wait and the label describing it are one tick.
    expect(seen).toEqual(["queued"]);

    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["queued"]);

    engine.release?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([running, operation]);
    expect(seen).toEqual(["queued", "start", "ran"]);
  });

  it("keeps a queued operation waiting across the running pass's retry backoff", async () => {
    engine.results = [new ApiError("unavailable", 503)];
    const seen: string[] = [];
    const running = scheduler.syncNow();
    await vi.advanceTimersByTimeAsync(0);

    const operation = scheduler.runExclusive(async () => {}, {
      onQueued: () => seen.push("queued"),
      onStart: () => seen.push("start"),
    });
    // Backoff belongs to the entry that is retrying, so the waiter stays a waiter through it
    // rather than being told it started and then stalling.
    await vi.advanceTimersByTimeAsync(999);
    expect(seen).toEqual(["queued"]);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([running, operation]);
    expect(seen).toEqual(["queued", "start"]);
  });

  it("never starts an operation that was still waiting when the scheduler stopped", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = scheduler.runExclusive(() => gate);
    await vi.advanceTimersByTimeAsync(0);
    const seen: string[] = [];
    const queued = scheduler.runExclusive(async () => seen.push("ran"), {
      onStart: () => seen.push("start"),
    });

    scheduler.stop();
    release();
    await expect(first).resolves.toBeUndefined();
    await expect(queued).rejects.toThrow(/scheduler stopped/);
    // Not merely un-run: a caller that saw `onStart` would report work that never touched
    // the vault as having begun.
    expect(seen).toEqual([]);
  });

  it("propagates an exclusive operation failure and keeps the lane usable", async () => {
    const failed = scheduler.runExclusive(async () => {
      throw new Error("resolution failed");
    });

    await expect(failed).rejects.toThrow(/resolution failed/);
    await expect(scheduler.syncNow()).resolves.toEqual(expect.objectContaining({ head: "01X" }));
    expect(engine.calls).toBe(1);
  });
});

describe("SyncScheduler forced passes", () => {
  it("hands the forced direction to the engine, and nothing extra to ordinary passes", async () => {
    const seen: Array<SyncPassOptions | undefined> = [];
    const recorder = {
      async sync(opts?: SyncPassOptions): Promise<SyncResult> {
        seen.push(opts);
        return committed("01X");
      },
    };
    const s = new SyncScheduler({ engine: recorder, retryDelaysMs: [] });

    await s.syncNow({ keepLocal: true });
    await s.syncNow();

    expect(seen).toEqual([{ keepLocal: true }, {}]);
  });

  it("refuses to fold a forced pass into an ordinary one already in flight", async () => {
    engine.release = () => {};
    const running = scheduler.syncNow();
    await vi.advanceTimersByTimeAsync(0);

    // Returning the in-flight pass's result would report a force that never ran.
    await expect(scheduler.syncNow({ keepLocal: true })).rejects.toThrow(/already running/);

    engine.release?.();
    await running;
    expect(engine.calls).toBe(1);
  });
});

describe("SyncScheduler retry", () => {
  it("classifies only transport, timeout, throttling, and server failures as retryable", () => {
    expect(isRetryable(new TransportError("offline"))).toBe(true);
    expect(isRetryable(new ApiError("timeout", 408))).toBe(true);
    expect(isRetryable(new ApiError("slow down", 429))).toBe(true);
    expect(isRetryable(new ApiError("unavailable", 503))).toBe(true);
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isRetryable(new ApiError("client", status))).toBe(false);
    }
    expect(isRetryable(new Error("local filesystem failure"))).toBe(false);
  });

  it("retries transient failures with backoff and reports success", async () => {
    engine.results = [new TransportError("network down"), { ...committed("01Y"), uploaded: 1 }];

    const done = scheduler.syncNow().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(engine.calls).toBe(2);
    expect(scheduler.lastError).toBeNull();
  });

  it("gives up after exhausting the backoff schedule and records the error", async () => {
    engine.results = [
      new TransportError("down"),
      new TransportError("down"),
      new TransportError("down"),
    ];

    const done = scheduler.syncNow().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(4000);
    await done;

    expect(engine.calls).toBe(3);
    expect(scheduler.lastError?.message).toMatch(/down/);
  });

  it("runs exactly one pass for a 401 and reports it once", async () => {
    const reported: Error[] = [];
    const once = new SyncScheduler({
      engine: engine as never,
      retryDelaysMs: [1, 2, 3],
      onError: (error) => reported.push(error),
    });
    engine.results = [new AuthError("wrong token")];

    await expect(once.syncNow()).rejects.toThrow(/wrong token/);
    await vi.advanceTimersByTimeAsync(10);

    expect(engine.calls).toBe(1);
    expect(reported).toHaveLength(1);
    once.stop();
  });

  it("honours a server-provided retry delay for 429", async () => {
    engine.results = [
      new ApiError("slow down", 429, "rate_limited", 2500),
      committed("01Y"),
    ];
    const done = scheduler.syncNow();
    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1499);
    expect(engine.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(engine.calls).toBe(2);
  });

  it("does not retry a halted engine — divergence needs a human, not a retry", async () => {
    engine.results = [{ ...committed("01X"), status: "halted", reason: "another device committed" }];

    await scheduler.syncNow();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(engine.calls).toBe(1);
  });

  it("stop() cancels a retry that is already waiting in backoff", async () => {
    engine.results = [new TransportError("network down"), committed("must-not-run")];

    const done = scheduler.syncNow().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await done).toEqual(expect.objectContaining({ message: expect.stringMatching(/stopped/) }));
    expect(engine.calls).toBe(1);
  });

  it("stopAndWait() drains an active engine before it resolves", async () => {
    engine.release = () => {};
    const running = scheduler.syncNow().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);

    let drained = false;
    const drain = scheduler.stopAndWait().then(() => (drained = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);

    engine.release?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.allSettled([running, drain]);
    expect(drained).toBe(true);
  });

  it("stopAndWait() drains a started exclusive operation and rejects work queued behind it", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const operation = scheduler.runExclusive(async () => {
      await gate;
    });
    await vi.advanceTimersByTimeAsync(0);
    const queued = scheduler.runExclusive(async () => {
      throw new Error("must not run");
    });

    let drained = false;
    const drain = scheduler.stopAndWait().then(() => (drained = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);

    release();
    await vi.advanceTimersByTimeAsync(0);
    await expect(operation).resolves.toBeUndefined();
    await expect(queued).rejects.toThrow(/scheduler stopped/);
    await drain;
    expect(drained).toBe(true);
  });
});
