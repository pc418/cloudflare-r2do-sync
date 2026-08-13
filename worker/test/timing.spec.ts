import { describe, expect, it, vi } from "vitest";
import { logPhase } from "../src/timing";

describe("structured phase timings", () => {
  it("emits one machine-readable record without paths, hashes, or credentials", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logPhase("r2_list", performance.now() - 5, { strategy: "inventory", objects: 2500 });

    expect(log).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(log.mock.calls[0][0])) as Record<string, unknown>;
    expect(record).toMatchObject({
      event: "perf_phase",
      phase: "r2_list",
      strategy: "inventory",
      objects: 2500,
    });
    expect(record.durationMs).toEqual(expect.any(Number));
    expect(JSON.stringify(record)).not.toMatch(/token|hash|path/i);
  });
});
