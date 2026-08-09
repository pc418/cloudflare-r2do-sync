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
}

export interface GcReport {
  retainedManifests: number;
  deletedManifests: number;
  retainedBlobs: number;
  deletedBlobs: number;
}

const DAY = 24 * 60 * 60 * 1000;

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

export async function runGc(env: Env, opts: GcOptions = {}): Promise<GcReport> {
  const now = opts.now ?? Date.now();
  const keepCount = opts.keepCount ?? 50;
  const keepDays = opts.keepDays ?? 30;
  const minAgeMs = opts.minAgeMs ?? DAY;
  const ageCutoff = now - keepDays * DAY;

  const report: GcReport = { retainedManifests: 0, deletedManifests: 0, retainedBlobs: 0, deletedBlobs: 0 };

  const headObj = await env.VAULT.get("head.json");
  if (headObj === null) {
    console.log("gc: no head.json, skipping (empty vault or mirror missing)");
    return report;
  }
  const { head }: { head: string | null } = await headObj.json();
  if (head === null) return report;

  // Walk the head chain; retain while within keepCount OR younger than keepDays.
  const retainedIds = new Set<string>();
  const liveHashes = new Set<string>();
  let cursor: string | null = head;
  let depth = 0;
  while (cursor !== null) {
    const obj: R2ObjectBody | null = await env.VAULT.get(`manifests/${cursor}.json`);
    if (obj === null) {
      // A missing ancestor after retained snapshots is expected once an earlier GC trimmed
      // history. A missing *head* is different: there is no trustworthy live set, so any
      // deletion would be blind and can destroy the actual vault.
      if (depth === 0) throw new Error(`head manifest ${cursor} is missing; refusing to run GC`);
      console.log(`gc: chain broken at ${cursor}, stopping walk`);
      break;
    }
    const m: Manifest = await obj.json();
    const young = Date.parse(m.createdAt) >= ageCutoff;
    if (depth >= keepCount && !young) break; // older links are older still
    retainedIds.add(m.id);
    for (const h of manifestHashes(m)) liveHashes.add(h);
    cursor = m.parent;
    depth++;
  }
  report.retainedManifests = retainedIds.size;
  report.retainedBlobs = liveHashes.size;

  const uploadedBefore = (o: R2Object) => o.uploaded.getTime() < now - minAgeMs;

  const manifestObjects = await listAll(env, "manifests/");
  const deadManifests = manifestObjects.filter((o) => {
    const id = o.key.slice("manifests/".length).replace(/\.json$/, "");
    return !retainedIds.has(id) && uploadedBefore(o);
  });
  for (let i = 0; i < deadManifests.length; i += 100) {
    await env.VAULT.delete(deadManifests.slice(i, i + 100).map((o) => o.key));
  }
  report.deletedManifests = deadManifests.length;

  const blobObjects = await listAll(env, "blobs/");
  const deadBlobs = blobObjects.filter((o) => {
    const hash = o.key.slice("blobs/".length);
    return !liveHashes.has(hash) && uploadedBefore(o);
  });
  for (let i = 0; i < deadBlobs.length; i += 100) {
    await env.VAULT.delete(deadBlobs.slice(i, i + 100).map((o) => o.key));
  }
  report.deletedBlobs = deadBlobs.length;

  return report;
}
