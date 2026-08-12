import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { runGc } from "../src/gc";
import type { Manifest } from "../src/manifest";
import { commit, makeManifest, makeManifestV2, mintToken, sha256hex, ulid } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

let token: string;

beforeEach(async () => {
  ({ token } = await mintToken("gc-tester"));
});

/** Seeded straight into the bucket: GC reads objects, and an upload needs no commit. */
async function seedBlob(content: string): Promise<string> {
  const h = await sha256hex(content);
  await env.VAULT.put(`blobs/${h}`, content);
  return h;
}

/**
 * Publishes a snapshot the way a device does. GC roots at the Durable Object now, so tests
 * have to establish the head through the authority rather than by writing the mirror.
 */
async function publish(m: Manifest, expectedHead: string | null, opts: { reroot?: boolean } = {}): Promise<string> {
  const res = await commit(token, m, expectedHead, opts);
  if (res.status !== 200) throw new Error(`commit failed: ${res.status} ${await res.text()}`);
  return m.id;
}

function manifest(id: string, parent: string | null, createdAt: number, files: Record<string, string>): Manifest {
  return {
    v: 1,
    id,
    parent,
    device: "gc-test",
    createdAt: new Date(createdAt).toISOString(),
    files: Object.fromEntries(Object.entries(files).map(([p, h]) => [p, { h, size: 1, mtime: createdAt }])),
  };
}

describe("runGc", () => {
  it("no committed head → no-op with zero counts", async () => {
    const report = await runGc(env, { now: Date.now(), minAgeMs: 0 });
    expect(report.skipped).toBe("no_head");
    expect(report.deletedManifests).toBe(0);
    expect(report.deletedBlobs).toBe(0);
  });

  // What "Rebuild remote history" actually buys: the new root is the whole chain, so every
  // earlier snapshot is off-chain and the blobs only they referenced stop being live. This is
  // also why the UI must say the purge completes at the next GC run, not at the click.
  it("collects the chain a reroot orphaned, keeping blobs the new root still names", async () => {
    const now = Date.now() + 10 * DAY;
    const shared = await seedBlob("still in the vault");
    const secret = await seedBlob("the thing being purged");
    const old1 = manifest(ulid(now - 5 * DAY), null, now - 5 * DAY, { "a.md": shared, "s.md": secret });
    const old2 = manifest(ulid(now - 4 * DAY), old1.id, now - 4 * DAY, { "a.md": shared, "s.md": secret });
    const root = manifest(ulid(now - 3 * DAY), null, now - 3 * DAY, { "a.md": shared });
    await publish(old1, null);
    await publish(old2, old1.id);
    await publish(root, old2.id, { reroot: true });

    const report = await runGc(env, { now, minAgeMs: 0 });

    expect(report.retainedManifests).toBe(1);
    expect(report.deletedManifests).toBe(2);
    expect(await env.VAULT.head(`manifests/${old1.id}.json`)).toBeNull();
    expect(await env.VAULT.head(`manifests/${old2.id}.json`)).toBeNull();
    expect(await env.VAULT.head(`manifests/${root.id}.json`)).not.toBeNull();
    // The purged content is gone; content the new root still names survives.
    expect(await env.VAULT.head(`blobs/${secret}`)).toBeNull();
    expect(await env.VAULT.head(`blobs/${shared}`)).not.toBeNull();
  });

  it("missing head manifest aborts without deleting anything", async () => {
    const now = Date.now() + 2 * DAY;
    const orphan = await seedBlob("must survive a broken head");
    const live = await seedBlob("head content");
    const m = manifest(ulid(now - DAY), null, now - DAY, { "a.md": live });
    await publish(m, null);
    await env.VAULT.delete(`manifests/${m.id}.json`);

    await expect(runGc(env, { now, minAgeMs: 0 })).rejects.toThrow(`head manifest ${m.id} is missing`);
    expect(await env.VAULT.head(`blobs/${orphan}`)).not.toBeNull();
  });

  /**
   * The regression this rule exists for. A commit advances durable DO state and *then*
   * mirrors the head to R2; that last write can fail on its own. Rooting the walk at the
   * mirror made the real head garbage — GC would delete the current snapshot and every blob
   * only it referenced, while the Durable Object still served that id as the head.
   */
  it("roots at the Durable Object, so a mirror left one snapshot behind deletes nothing live", async () => {
    const now = Date.now() + 40 * DAY;
    const oldT = now - 100 * DAY;
    const first = await seedBlob("first snapshot content");
    const latest = await seedBlob("content only the newest snapshot names");

    const m1 = manifest(ulid(oldT), null, oldT, { "a.md": first });
    const m2 = manifest(ulid(oldT + 1000), m1.id, oldT + 1000, { "a.md": first, "b.md": latest });
    await publish(m1, null);
    await publish(m2, m1.id);
    // Exactly what a failed mirror write leaves behind.
    await env.VAULT.put("head.json", JSON.stringify({ head: m1.id }));

    const report = await runGc(env, { now, keepCount: 1, keepDays: 30, minAgeMs: 0 });

    expect(report.retainedManifests).toBe(1);
    expect(await env.VAULT.head(`manifests/${m2.id}.json`)).not.toBeNull();
    expect(await env.VAULT.head(`blobs/${latest}`)).not.toBeNull();
    // ...and the stale mirror is repaired on the way past, so recovery tooling agrees again.
    const mirror = await env.VAULT.get("head.json");
    expect(await mirror!.json()).toEqual({ head: m2.id });
  });

  it("keeps the retained chain and its blobs, deletes expired manifests and orphaned blobs", async () => {
    // Retention age comes from R2's upload time, not the manifest's own `createdAt`, so the
    // logical clock has to run past `keepDays` for anything to count as expired.
    const now = Date.now() + 100 * DAY;
    const oldT = now - 100 * DAY;
    const newT = now - 1 * DAY;

    const liveBlob = await seedBlob("still referenced");
    const oldOnlyBlob = await seedBlob("only in expired manifest");
    const orphanBlob = await seedBlob("referenced by nothing");

    // chain: mOld (expired, beyond keepCount) <- m1 <- m2 (head)
    const mOld = manifest(ulid(oldT), null, oldT, { "old.md": oldOnlyBlob });
    const m1 = manifest(ulid(newT - 1000), mOld.id, newT - 1000, { "a.md": liveBlob });
    const m2 = manifest(ulid(newT), m1.id, newT, { "a.md": liveBlob });
    await publish(mOld, null);
    await publish(m1, mOld.id);
    await publish(m2, m1.id);

    const report = await runGc(env, { now, keepCount: 2, keepDays: 30, minAgeMs: 0 });

    expect(report.retainedManifests).toBe(2);
    expect(report.deletedManifests).toBe(1);
    expect(await env.VAULT.head(`manifests/${m2.id}.json`)).not.toBeNull();
    expect(await env.VAULT.head(`manifests/${m1.id}.json`)).not.toBeNull();
    expect(await env.VAULT.head(`manifests/${mOld.id}.json`)).toBeNull();

    expect(await env.VAULT.head(`blobs/${liveBlob}`)).not.toBeNull();
    expect(await env.VAULT.head(`blobs/${oldOnlyBlob}`)).toBeNull();
    expect(await env.VAULT.head(`blobs/${orphanBlob}`)).toBeNull();
    expect(report.deletedBlobs).toBe(2);
  });

  it("keeps old manifests when they are within keepCount (latest N always survive)", async () => {
    const now = Date.now() + 2 * DAY;
    const oldT = now - 100 * DAY;

    const blob = await seedBlob("ancient but retained");
    const m1 = manifest(ulid(oldT - 1000), null, oldT - 1000, { "a.md": blob });
    const m2 = manifest(ulid(oldT), m1.id, oldT, { "a.md": blob });
    await publish(m1, null);
    await publish(m2, m1.id);

    const report = await runGc(env, { now, keepCount: 50, keepDays: 30, minAgeMs: 0 });
    expect(report.retainedManifests).toBe(2);
    expect(report.deletedManifests).toBe(0);
    expect(await env.VAULT.head(`blobs/${blob}`)).not.toBeNull();
  });

  it("traces liveness through encrypted manifests (blobs[] is the only readable reference)", async () => {
    // Past keepDays in logical time, so the older snapshot expires on its upload age.
    const now = Date.now() + 100 * DAY;
    const newT = now - 1 * DAY;
    const oldT = now - 100 * DAY;

    const live = await seedBlob("live ciphertext");
    const dropped = await seedBlob("ciphertext only in the expired snapshot");

    const old = makeManifestV2({
      id: ulid(oldT),
      blobs: [dropped],
      createdAt: new Date(oldT).toISOString(),
    });
    const head = makeManifestV2({
      id: ulid(newT),
      parent: old.id,
      blobs: [live],
      createdAt: new Date(newT).toISOString(),
    });
    await publish(old, null);
    await publish(head, old.id);

    const report = await runGc(env, { now, keepCount: 1, keepDays: 30, minAgeMs: 0 });

    expect(report.retainedBlobs).toBe(1);
    expect(await env.VAULT.head(`blobs/${live}`)).not.toBeNull();
    expect(await env.VAULT.head(`blobs/${dropped}`)).toBeNull();
  });

  it("minAge guard: recently uploaded objects are never deleted even if unreferenced", async () => {
    const now = Date.now() + 2 * DAY;
    const orphan = await seedBlob("fresh orphan"); // uploaded "now" in real time

    const blob = await seedBlob("live");
    const m = manifest(ulid(now - 1000), null, now - 1000, { "a.md": blob });
    await publish(m, null);

    // minAge of 30 days: everything in the bucket is younger than that in real time
    const report = await runGc(env, { now, keepCount: 50, keepDays: 30, minAgeMs: 30 * DAY });
    expect(report.deletedBlobs).toBe(0);
    expect(await env.VAULT.head(`blobs/${orphan}`)).not.toBeNull();
  });

  it("reports a clean run rather than a skip", async () => {
    const blob = await seedBlob("anything");
    const m = makeManifest({ files: { "a.md": { h: blob } } });
    await publish(m, null);
    const report = await runGc(env, { now: Date.now(), minAgeMs: 0 });
    expect(report.skipped).toBeNull();
  });
});
