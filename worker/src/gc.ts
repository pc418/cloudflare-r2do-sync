import type { Env } from "./index";
import { logPhase } from "./timing";

export interface GcOptions {
  now?: number;
  /** Latest N manifests on the head chain always survive. Defaults to `GC_KEEP_COUNT`. */
  keepCount?: number;
  /** Manifests younger than this many days always survive. Defaults to `GC_KEEP_DAYS`. */
  keepDays?: number;
  /** Past the dense window, one snapshot per day survives back to here. Defaults to
   *  `GC_DAILY_DAYS`; older generations keep one per week. */
  dailyDays?: number;
  /** Objects uploaded within this window are never deleted (in-flight commit safety). */
  minAgeMs?: number;
  /** Upper bound on how long this run may hold commits off. */
  leaseTtlMs?: number;
  /** Manifests the one-time reference-index migration may read in this run. */
  indexChunk?: number;
  /** Test seam: move the head after planning but before the fenced delete phase. */
  testHookBeforeLease?: () => Promise<void>;
}

export interface GcReport {
  retainedManifests: number;
  deletedManifests: number;
  /** Retained-age snapshots the generational rule dropped: thinning, not expiry. */
  thinnedManifests: number;
  /** Parent links redirected across the stretches this run thinned. */
  splicesApplied: number;
  retainedBlobs: number;
  deletedBlobs: number;
  /** Why the run deleted nothing, or null when it ran to completion. */
  skipped: string | null;
  /** The window this run actually applied. Reported so a sweep's log says what it kept by. */
  retention: GcRetention;
}

const DAY = 24 * 60 * 60 * 1000;
/** Generous against a full sweep of this bucket, short enough that a killed run unblocks
 *  commits again long before the next daily trigger. */
const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

/** How long history may be kept, in days. Ten years is already far past any real intent. */
const MAX_KEEP_DAYS = 3650;
/** Snapshots retained by count. Above this the retained union stops fitting a plan anyway. */
const MAX_KEEP_COUNT = 10_000;

export interface GcRetention {
  keepDays: number;
  keepCount: number;
  dailyDays: number;
}

/**
 * The retention window this deployment was configured with.
 *
 * Deliberately has no defaults: retention decides what a sweep deletes, so a missing or
 * malformed binding is a deployment fault, not a reason to silently apply a number nobody
 * chose. `scripts/deploy.mjs` validates the same values before upload, so reaching this
 * error means the Worker was deployed by some other path.
 */
export function gcRetention(
  env: Pick<Env, "GC_KEEP_DAYS" | "GC_KEEP_COUNT" | "GC_DAILY_DAYS">
): GcRetention {
  const keepDays = retentionValue(env.GC_KEEP_DAYS, "GC_KEEP_DAYS", MAX_KEEP_DAYS);
  const dailyDays = retentionValue(env.GC_DAILY_DAYS, "GC_DAILY_DAYS", MAX_KEEP_DAYS);
  // The daily tier begins where the dense window ends, so it cannot end before it starts.
  // Equal values are allowed and mean exactly one thing: no daily tier, weekly beyond the
  // dense window. That is a deployment someone may want; an inverted pair is a mistake.
  if (dailyDays < keepDays) {
    throw new Error(
      `GC_DAILY_DAYS (${dailyDays}) must be at least GC_KEEP_DAYS (${keepDays}); ` +
        `the daily tier covers the span between them`
    );
  }
  return {
    keepDays,
    keepCount: retentionValue(env.GC_KEEP_COUNT, "GC_KEEP_COUNT", MAX_KEEP_COUNT),
    dailyDays,
  };
}

function retentionValue(raw: unknown, name: string, max: number): number {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`${name} is not configured; redeploy with a retention value`);
  }
  // Plain decimal digits only, matching `scripts/worker-config.mjs`. `Number()` alone would
  // quietly accept "1e3" and "0x10", which is not a spelling anyone intends here.
  const trimmed = raw.trim();
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}, not ${JSON.stringify(raw)}`);
  }
  return value;
}

async function collectDead(
  env: Env,
  prefix: string,
  live: ReadonlySet<string>,
  uploadedBefore: (object: R2Object) => boolean,
  expectedEtags?: ReadonlyMap<string, string>
): Promise<Array<{ key: string; id: string }>> {
  const dead: Array<{ key: string; id: string }> = [];
  const seenExpected = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await env.VAULT.list({ prefix, cursor });
    for (const object of page.objects) {
      const id = object.key.slice(prefix.length).replace(prefix === "manifests/" ? /\.json$/ : /$^/, "");
      const expectedEtag = expectedEtags?.get(id);
      if (expectedEtag !== undefined) {
        seenExpected.add(id);
        if (object.etag !== expectedEtag) {
          throw new Error(
            `retained manifest ${id} changed in R2 after it was indexed; refusing GC`
          );
        }
      }
      if (!live.has(id) && uploadedBefore(object)) dead.push({ key: object.key, id });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  if (expectedEtags !== undefined) {
    for (const id of expectedEtags.keys()) {
      if (!seenExpected.has(id)) {
        throw new Error(`retained manifest ${id} is missing; refusing GC`);
      }
    }
  }
  return dead;
}

/**
 * Deletes snapshots and blobs no retained snapshot references.
 *
 * Two rules make that safe, and both are load-bearing:
 *
 * 1. **The Durable Object is the only root.** `head.json` is a disaster-recovery mirror
 *    written after the head advances, so it can legitimately sit one snapshot behind when
 *    that last write fails. Rooting a deletion walk there would let GC treat the real head
 *    as garbage and delete it along with every blob only it references. GC reads the head
 *    from the DO and fails closed if it cannot; it repairs a stale mirror on the way past.
 * 2. **Deletion is exclusive with commit.** A commit verifies its blobs exist and then
 *    writes; an aged orphan that a new snapshot re-references (content addressing means a
 *    "new" file can be an old blob) would otherwise pass that check and be deleted before
 *    the head protecting it lands. The lease makes the two phases mutually exclusive, so a
 *    successful commit can never name a blob this run removed.
 */
export async function runGc(env: Env, opts: GcOptions = {}): Promise<GcReport> {
  const gcStartedAt = performance.now();
  const now = opts.now ?? Date.now();
  // Read before anything else touches the vault: an unusable retention setting must stop the
  // run while it is still a no-op, not after it has planned a deletion against a guessed one.
  const configured = gcRetention(env);
  const keepCount = opts.keepCount ?? configured.keepCount;
  const keepDays = opts.keepDays ?? configured.keepDays;
  const dailyDays = opts.dailyDays ?? configured.dailyDays;
  const minAgeMs = opts.minAgeMs ?? DAY;
  const ageCutoff = now - keepDays * DAY;
  const dailyCutoff = now - dailyDays * DAY;

  const report: GcReport = {
    retainedManifests: 0,
    deletedManifests: 0,
    thinnedManifests: 0,
    splicesApplied: 0,
    retainedBlobs: 0,
    deletedBlobs: 0,
    skipped: null,
    retention: { keepDays, keepCount, dailyDays },
  };

  const lock = env.VAULT_LOCK.getByName("default");
  // A vault older than the reference index has to be translated into it before its retained
  // set can be derived. That walk is bounded per invocation, so a run may legitimately end
  // here having only advanced it — retaining everything is the safe half of GC.
  const progress = await lock.advanceGcIndex({ maxManifests: opts.indexChunk });
  if (!progress.done) {
    logPhase("gc_plan", gcStartedAt, { indexed: progress.indexed, indexComplete: false });
    console.log(
      `gc: reference index still building (${progress.indexed} manifest(s) this run, resuming at ${progress.cursor}); deleting nothing`
    );
    report.skipped = "index_backfilling";
    return report;
  }
  const plan = await lock.getGcPlan({ keepCount, ageCutoff, dailyCutoff });
  logPhase("gc_plan", gcStartedAt, {
    retainedManifests: plan.retainedIds.length,
    retainedBlobs: plan.liveHashes.length,
    thinnedManifests: plan.thinned,
    splices: plan.splices.length,
  });
  if (plan.head === null) {
    await opts.testHookBeforeLease?.();
    const lease = await lock.acquireGcLease({
      nowMs: Date.now(),
      ttlMs: opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
    });
    if (!lease.ok) {
      report.skipped = lease.reason;
      return report;
    }
    try {
      report.skipped = lease.head === null ? "no_head" : "head_moved";
      return report;
    } finally {
      await lock.releaseGcLease(lease.leaseId);
    }
  }
  if ((await env.VAULT.head(`manifests/${plan.head}.json`)) === null) {
    throw new Error(`head manifest ${plan.head} is missing; refusing to run GC`);
  }

  const retainedIds = new Set(plan.retainedIds);
  const liveHashes = new Set(plan.liveHashes);
  report.retainedManifests = retainedIds.size;
  report.retainedBlobs = liveHashes.size;
  report.thinnedManifests = plan.thinned;
  const uploadedBefore = (object: R2Object) => object.uploaded.getTime() < now - minAgeMs;

  // R2 scanning is deliberately outside the exclusion window. Only dead candidates are
  // retained, page by page; whole bucket listings are never accumulated in memory.
  const deadManifests = await collectDead(
    env,
    "manifests/",
    retainedIds,
    uploadedBefore,
    new Map(plan.retainedEtags.map(({ id, etag }) => [id, etag]))
  );
  const deadBlobs = await collectDead(env, "blobs/", liveHashes, uploadedBefore);
  await opts.testHookBeforeLease?.();

  const ttlMs = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const lease = await lock.acquireGcLease({ nowMs: Date.now(), ttlMs });
  if (!lease.ok) {
    console.log(`gc: declined the lease (${lease.reason}); skipping this run`);
    report.skipped = lease.reason;
    return report;
  }
  try {
    if (lease.head !== plan.head) {
      report.skipped = "head_moved";
      return report;
    }
    const holdLease = async (): Promise<void> => {
      if (!(await lock.renewGcLease(lease.leaseId, { nowMs: Date.now(), ttlMs }))) {
        throw new Error(
          "gc: lost the deletion lease mid-sweep (it expired, or another run took it); " +
            "aborting rather than deleting against a live set that may be stale"
        );
      }
    };

    await repairHeadMirror(env, plan.head);
    const deleteStartedAt = performance.now();
    // Verify ownership even when this particular run found no aged candidates. A lapsed
    // sweep must never report completion, because its plan was no longer fenced.
    await holdLease();
    // Before any deletion, so the index never has to point through a manifest that is
    // already gone. A run killed between the two leaves spliced links whose skipped
    // snapshots the next plan simply does not visit, and the next sweep collects.
    if (plan.splices.length > 0) {
      if (!(await lock.applyGcSplices(lease.leaseId, plan.head, plan.splices))) {
        throw new Error("gc: lost the deletion lease before redirecting the links it thinned");
      }
      report.splicesApplied = plan.splices.length;
    }
    for (let i = 0; i < deadManifests.length; i += 100) {
      await holdLease();
      await env.VAULT.delete(deadManifests.slice(i, i + 100).map((object) => object.key));
    }
    report.deletedManifests = deadManifests.length;
    for (let i = 0; i < deadBlobs.length; i += 100) {
      await holdLease();
      await env.VAULT.delete(deadBlobs.slice(i, i + 100).map((object) => object.key));
    }
    report.deletedBlobs = deadBlobs.length;
    await holdLease();
    if (
      !(await lock.pruneGcIndex(
        lease.leaseId,
        plan.head,
        deadManifests.map((object) => object.id)
      ))
    ) {
      throw new Error("gc: lost the deletion lease before pruning its reference index");
    }
    logPhase("gc_delete", deleteStartedAt, {
      deletedManifests: report.deletedManifests,
      deletedBlobs: report.deletedBlobs,
      splicesApplied: report.splicesApplied,
    });
    return report;
  } finally {
    await lock.releaseGcLease(lease.leaseId);
  }
}

/** Brings the recovery mirror back in line with the authority it shadows. */
async function repairHeadMirror(env: Env, head: string): Promise<void> {
  const obj = await env.VAULT.get("head.json");
  let mirrored: unknown = null;
  if (obj !== null) {
    // Annotation, not a type argument: `json<T>()` has no inference site, so an explicit
    // argument is an unchecked assertion while this is a checked one.
    const doc: { head?: unknown } = await obj.json();
    mirrored = doc.head;
  }
  if (mirrored === head) return;
  console.log(`gc: head mirror said ${JSON.stringify(mirrored)}, authority says ${head}; repairing`);
  await env.VAULT.put("head.json", JSON.stringify({ head }), {
    httpMetadata: { contentType: "application/json" },
  });
}
