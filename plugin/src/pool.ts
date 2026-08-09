/**
 * Bounded-concurrency mapping, the one primitive the sync engine uses to overlap work.
 *
 * Sync is dominated by per-file round trips — read, hash, encrypt, upload, download — and
 * doing them one at a time makes a first sync of a large vault take minutes of mostly idle
 * waiting. Overlapping them is worth real time, but only if it cannot change *what* sync
 * does, so this pool is deliberately strict:
 *
 * - **Results come back in input order**, so callers can fold per-item outcomes
 *   deterministically. Sync's conflict list and manifest path order must not depend on
 *   which download happened to finish first.
 * - **The first error wins, and every in-flight task is awaited before it is thrown.** A
 *   rejected pass must not leave a straggler still writing into the vault after the caller
 *   has already reported failure and moved on.
 * - **A nonsensical lane count throws** rather than silently becoming 1 — a config bug that
 *   quietly halves throughput is the kind of thing nobody ever notices.
 */

export const DEFAULT_LANES = 4;

/**
 * Above this, more lanes mostly buy queueing and memory: every lane can hold a whole file's
 * plaintext *and* ciphertext, and Obsidian's request layer is the real bottleneck.
 */
export const MAX_LANES = 16;

/** Sanitises a lane count from settings, where a stored value can be anything. */
export function clampLanes(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LANES;
  return Math.min(MAX_LANES, Math.max(1, Math.floor(n)));
}

export async function mapPool<T, R>(
  items: readonly T[],
  lanes: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(lanes) || lanes < 1) {
    throw new Error(`lanes must be a positive integer, got ${String(lanes)}`);
  }

  const results = new Array<R>(items.length);
  // A list rather than a nullable local: assignments made inside the worker closure are
  // invisible to control-flow narrowing, which would type the post-await check as dead.
  const failures: Array<{ error: unknown }> = [];
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      // Stop feeding new work the moment anything fails: a doomed pass should touch as
      // little as possible, not run the remaining files to completion first.
      if (failures.length > 0) return;
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failures.push({ error });
        return;
      }
    }
  }

  // Workers never reject, so this settles only once nothing is still in flight.
  await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, () => worker()));

  const first = failures[0];
  if (first !== undefined) throw first.error;
  return results;
}
