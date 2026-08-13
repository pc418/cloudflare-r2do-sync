export type PerfPhase = "auth_rpc" | "r2_check" | "r2_list" | "commit" | "gc_plan" | "gc_delete";

/** Workers Logs applies deployment-level head sampling; code always emits structured data. */
export function logPhase(
  phase: PerfPhase,
  startedAt: number,
  details: Record<string, string | number | boolean> = {}
): void {
  console.log(
    JSON.stringify({
      event: "perf_phase",
      phase,
      durationMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100),
      ...details,
    })
  );
}
