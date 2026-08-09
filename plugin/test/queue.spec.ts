import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SyncScheduler } from "../src/queue";
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
  it("retries transient failures with backoff and reports success", async () => {
    engine.results = [new Error("network down"), { ...committed("01Y"), uploaded: 1 }];

    const done = scheduler.syncNow().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(engine.calls).toBe(2);
    expect(scheduler.lastError).toBeNull();
  });

  it("gives up after exhausting the backoff schedule and records the error", async () => {
    engine.results = [new Error("down"), new Error("down"), new Error("down")];

    const done = scheduler.syncNow().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(4000);
    await done;

    expect(engine.calls).toBe(3);
    expect(scheduler.lastError?.message).toMatch(/down/);
  });

  it("does not retry a halted engine — divergence needs a human, not a retry", async () => {
    engine.results = [{ ...committed("01X"), status: "halted", reason: "another device committed" }];

    await scheduler.syncNow();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(engine.calls).toBe(1);
  });

  it("stop() cancels a retry that is already waiting in backoff", async () => {
    engine.results = [new Error("network down"), committed("must-not-run")];

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
});
