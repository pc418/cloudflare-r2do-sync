import { describe, expect, it } from "vitest";
import { DEFAULT_LANES, MAX_LANES, clampLanes, mapPool } from "../src/pool";

/** A task that resolves when `release()` is called, so a test can control interleaving. */
function gate<T>(): { promise: Promise<T>; release: (value: T) => void } {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("mapPool", () => {
  it("returns results in input order regardless of completion order", async () => {
    const out = await mapPool([30, 10, 20, 0], 4, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:10", "2:20", "3:0"]);
  });

  it("runs at most `lanes` tasks at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    expect(peak).toBe(3);
  });

  it("actually overlaps work rather than serialising it", async () => {
    // Without concurrency all three gates would have to be opened in order; here every
    // task must be running before any of them is released.
    const gates = [gate<number>(), gate<number>(), gate<number>()];
    const started: number[] = [];
    const run = mapPool([0, 1, 2], 3, async (i) => {
      started.push(i);
      return gates[i].promise;
    });
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    gates[2].release(2);
    gates[0].release(0);
    gates[1].release(1);
    expect(await run).toEqual([0, 1, 2]);
  });

  it("an empty input does no work and needs no lanes", async () => {
    let calls = 0;
    expect(await mapPool([], 4, async () => calls++)).toEqual([]);
    expect(calls).toBe(0);
  });

  it("never starts more workers than there are items", async () => {
    let peak = 0;
    let inFlight = 0;
    await mapPool([1, 2], 16, async () => {
      peak = Math.max(peak, ++inFlight);
      await Promise.resolve();
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("propagates the first failure and stops feeding new work", async () => {
    const seen: number[] = [];
    const items = Array.from({ length: 12 }, (_, i) => i);

    await expect(
      mapPool(items, 2, async (i) => {
        seen.push(i);
        await new Promise((r) => setTimeout(r, 1));
        if (i === 1) throw new Error("boom on 1");
        return i;
      })
    ).rejects.toThrow("boom on 1");

    // Whatever was already in flight may finish, but the pool must not keep pulling the
    // remaining items: a failed sync pass should stop touching the vault, not run to the end.
    expect(seen.length).toBeLessThan(items.length);
  });

  it("waits for in-flight tasks to settle before rejecting", async () => {
    // A write that lands after the caller has already handled the error is exactly the kind
    // of ghost effect this pool exists to prevent.
    let settled = false;
    const slow = mapPool([0, 1], 2, async (i) => {
      if (i === 0) throw new Error("fast failure");
      await new Promise((r) => setTimeout(r, 5));
      settled = true;
    });
    await expect(slow).rejects.toThrow("fast failure");
    expect(settled).toBe(true);
  });

  it("reports the first error even when several tasks fail", async () => {
    await expect(
      mapPool([0, 1, 2], 1, async (i) => {
        throw new Error(`fail ${i}`);
      })
    ).rejects.toThrow("fail 0");
  });

  it("refuses a nonsensical lane count instead of guessing one", async () => {
    for (const lanes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(mapPool([1], lanes, async (x) => x)).rejects.toThrow(/lanes/i);
    }
  });
});

describe("clampLanes", () => {
  it("keeps sensible values and pins the rest into range", () => {
    expect(clampLanes(1)).toBe(1);
    expect(clampLanes(8)).toBe(8);
    expect(clampLanes(0)).toBe(1);
    expect(clampLanes(999)).toBe(MAX_LANES);
    expect(clampLanes(4.7)).toBe(4);
  });

  it("falls back to the default only for values that are not numbers at all", () => {
    expect(clampLanes(Number.NaN)).toBe(DEFAULT_LANES);
    expect(clampLanes(undefined)).toBe(DEFAULT_LANES);
  });
});
