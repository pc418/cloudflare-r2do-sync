import type { Env } from "./index";
import { manifestHashes, type Manifest } from "./manifest";

export interface GcOptions {
  now?: number;
  /** Latest N manifests on the head chain always survive. */
  keepCount?: number;
  /** Manifests younger than this many days always survive. */
  keepDays?: number;
  /** Objects uploaded within this window are never deleted (in-flight commit safety). */
  minAgeMs?: number;
  /** Upper bound on how long this run may hold commits off. */
  leaseTtlMs?: number;
}

export interface GcReport {
  retainedManifests: number;
  deletedManifests: number;
  retainedBlobs: number;
  deletedBlobs: number;
  /** Why the run deleted nothing, or null when it ran to completion. */
  skipped: string | null;
}

const DAY = 24 * 60 * 60 * 1000;
/** Generous against a full sweep of this bucket, short enough that a killed run unblocks
 *  commits again long before the next daily trigger. */
const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;
/** Manifests walked between lease renewals. Small enough that a long chain cannot lapse. */
const LEASE_RENEW_EVERY = 25;

async function listAll(env: Env, prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.VAULT.list({ prefix, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
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
  const now = opts.now ?? Date.now();
  const keepCount = opts.keepCount ?? 50;
  const keepDays = opts.keepDays ?? 30;
  const minAgeMs = opts.minAgeMs ?? DAY;
  const ageCutoff = now - keepDays * DAY;

  const report: GcReport = {
    retainedManifests: 0,
    deletedManifests: 0,
    retainedBlobs: 0,
    deletedBlobs: 0,
    skipped: null,
  };

  const lock = env.VAULT_LOCK.getByName("default");
  const ttlMs = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  // Real time, not the caller's logical `now`: this bounds a live exclusion window.
  const lease = await lock.acquireGcLease({ nowMs: Date.now(), ttlMs });
  if (!lease.ok) {
    console.log(`gc: declined the lease (${lease.reason}); skipping this run`);
    report.skipped = lease.reason;
    return report;
  }

  /**
   * The exclusion has to hold for the WHOLE sweep, not just its first instant. A lease that
   * quietly expired mid-run stops holding commits off, so a snapshot can land and make the
   * live set computed below stale — deleting against it would then remove blobs the new head
   * references. Renewing before every step that could act on that set turns "the lease
   * lapsed" into a loud abort instead of silent data loss.
   */
  const holdLease = async (): Promise<void> => {
    if (!(await lock.renewGcLease(lease.leaseId, { nowMs: Date.now(), ttlMs }))) {
      throw new Error(
        "gc: lost the deletion lease mid-sweep (it expired, or another run took it); " +
          "aborting rather than deleting against a live set that may be stale"
      );
    }
  };

  try {
    const head = lease.head;
    if (head === null) {
      // Either an empty vault or a Durable Object that has lost its storage. Deleting on
      // "the authority knows of no head" would empty a populated bucket, so it never does.
      report.skipped = "no_head";
      return report;
    }
    await repairHeadMirror(env, head);

    // Walk the head chain; retain while within keepCount OR younger than keepDays.
    const retainedIds = new Set<string>();
    const liveHashes = new Set<string>();
    const visited = new Set<string>();
    let cursor: string | null = head;
    let depth = 0;
    while (cursor !== null) {
      // Manifest IDs are refused once used, so a cycle means history was corrupted before
      // that rule existed — or around it. Either way the live set below would be a
      // half-walk, and deleting against a half-walk destroys reachable data.
      if (visited.has(cursor)) {
        throw new Error(`manifest chain cycles at ${cursor}; refusing to run GC`);
      }
      visited.add(cursor);

      if (depth % LEASE_RENEW_EVERY === 0) await holdLease();
      const obj: R2ObjectBody | null = await env.VAULT.get(`manifests/${cursor}.json`);
      if (obj === null) {
        // A missing ancestor after retained snapshots is expected once an earlier GC trimmed
        // history. A missing *head* is different: there is no trustworthy live set, so any
        // deletion would be blind and can destroy the actual vault.
        if (depth === 0) throw new Error(`head manifest ${cursor} is missing; refusing to run GC`);
        console.log(`gc: chain broken at ${cursor}, stopping walk`);
        break;
      }
      // Age comes from when R2 accepted the object, never from `createdAt` — that is a
      // client-chosen string. A far-future one would make ancient snapshots permanently
      // "young" and stop history from ever being collected; a far-past one would expire
      // history early. The upload time is the server's own record and cannot be dictated.
      const uploadedAt = obj.uploaded.getTime();
      const m: Manifest = await obj.json();
      const young = uploadedAt >= ageCutoff;
      if (depth >= keepCount && !young) break; // older links are older still
      retainedIds.add(m.id);
      for (const h of manifestHashes(m)) liveHashes.add(h);
      cursor = m.parent;
      depth++;
    }
    report.retainedManifests = retainedIds.size;
    report.retainedBlobs = liveHashes.size;

    const uploadedBefore = (o: R2Object) => o.uploaded.getTime() < now - minAgeMs;

    // The walk is finished; the live set is fixed from here. Everything below deletes.
    await holdLease();
    const manifestObjects = await listAll(env, "manifests/");
    const deadManifests = manifestObjects.filter((o) => {
      const id = o.key.slice("manifests/".length).replace(/\.json$/, "");
      return !retainedIds.has(id) && uploadedBefore(o);
    });
    for (let i = 0; i < deadManifests.length; i += 100) {
      await holdLease();
      await env.VAULT.delete(deadManifests.slice(i, i + 100).map((o) => o.key));
    }
    report.deletedManifests = deadManifests.length;

    const blobObjects = await listAll(env, "blobs/");
    const deadBlobs = blobObjects.filter((o) => {
      const hash = o.key.slice("blobs/".length);
      return !liveHashes.has(hash) && uploadedBefore(o);
    });
    for (let i = 0; i < deadBlobs.length; i += 100) {
      await holdLease();
      await env.VAULT.delete(deadBlobs.slice(i, i + 100).map((o) => o.key));
    }
    report.deletedBlobs = deadBlobs.length;

    return report;
  } finally {
    // Ownership-checked: a sweep that lapsed must not clear a lease a later one now holds.
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
