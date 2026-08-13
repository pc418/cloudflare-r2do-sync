import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { runGc } from "../src/gc";
import type { Manifest } from "../src/manifest";
import {
  ADMIN,
  BASE,
  authed,
  commit,
  makeManifest,
  makeManifestV2,
  mintToken,
  sha256hex,
  ulid,
} from "./helpers";
import type { VaultLock } from "../src/vault-lock";

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
    await runInDurableObject(env.VAULT_LOCK.getByName("default"), (_instance: VaultLock, state) => {
      expect(
        state.storage.sql.exec<{ id: string }>("SELECT id FROM manifest_index ORDER BY id").toArray()
      ).toEqual([{ id: root.id }]);
      expect(
        state.storage.sql.exec<{ id: string }>("SELECT id FROM manifest_ids ORDER BY id").toArray()
      ).toHaveLength(3);
    });
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

  /**
   * Indexing a vault that predates the index means reading every manifest still on its chain
   * — on a real vault a hundred-odd objects and tens of megabytes. A request cannot pay for
   * that, and the commit path is a request, so the migration belongs to the scheduled sweep.
   */
  it("leaves pre-index history to the scheduled sweep instead of walking it inside a commit", async () => {
    const now = Date.now() + 10 * DAY;
    const kept = await seedBlob("still referenced");
    const dropped = await seedBlob("only in the older snapshot");
    const legacy1 = manifest(ulid(Date.now() - 2 * DAY), null, Date.now() - 2 * DAY, {
      "a.md": kept,
      "b.md": dropped,
    });
    const legacy2 = manifest(ulid(Date.now() - DAY), legacy1.id, Date.now() - DAY, { "a.md": kept });
    // History exactly as an older deployment left it: objects in R2, an authoritative head in
    // the Durable Object, and no reference index.
    await env.VAULT.put(`manifests/${legacy1.id}.json`, JSON.stringify(legacy1));
    await env.VAULT.put(`manifests/${legacy2.id}.json`, JSON.stringify(legacy2));
    await runInDurableObject(env.VAULT_LOCK.getByName("default"), (_instance: VaultLock, state) => {
      state.storage.sql.exec("INSERT INTO meta (key, value) VALUES ('head', ?)", legacy2.id);
    });

    const next = manifest(ulid(), legacy2.id, Date.now(), { "a.md": kept });
    await publish(next, legacy2.id);
    await runInDurableObject(env.VAULT_LOCK.getByName("default"), (_instance: VaultLock, state) => {
      expect(
        state.storage.sql
          .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'gc_index_backfilled'")
          .toArray()
      ).toEqual([]);
      expect(state.storage.sql.exec("SELECT id FROM manifest_index").toArray()).toEqual([]);
    });

    const report = await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 0 });

    expect(report.skipped).toBeNull();
    expect(report.retainedManifests).toBe(1);
    expect(report.deletedManifests).toBe(2);
    expect(report.deletedBlobs).toBe(1);
    expect(await env.VAULT.head(`blobs/${kept}`)).not.toBeNull();
    expect(await env.VAULT.head(`blobs/${dropped}`)).toBeNull();
    await runInDurableObject(env.VAULT_LOCK.getByName("default"), (_instance: VaultLock, state) => {
      expect(
        state.storage.sql
          .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'gc_index_backfilled'")
          .toArray()
      ).toEqual([{ value: "1" }]);
      expect(
        state.storage.sql.exec<{ id: string }>("SELECT id FROM manifest_index").toArray()
      ).toEqual([{ id: next.id }]);
      expect(
        state.storage.sql.exec<{ hash: string }>("SELECT hash FROM current_blob_refs").toArray()
      ).toEqual([{ hash: kept }]);
    });
  });

  /**
   * The migration cannot assume any one invocation can finish it: a request gets 10 ms of CPU
   * on the free plan, and a chain is one R2 GET and one JSON parse per link. Driven one link
   * at a time it must reach exactly the index a single pass would have built.
   */
  it("builds the same reference index one bounded step at a time", async () => {
    const now = Date.now() + 10 * DAY;
    const kept = await seedBlob("kept across the chain");
    const dropped = await seedBlob("dropped partway");
    const legacy1 = manifest(ulid(Date.now() - 3 * DAY), null, Date.now() - 3 * DAY, {
      "a.md": kept,
      "b.md": dropped,
    });
    const legacy2 = manifest(ulid(Date.now() - 2 * DAY), legacy1.id, Date.now() - 2 * DAY, {
      "a.md": kept,
    });
    const legacy3 = manifest(ulid(Date.now() - DAY), legacy2.id, Date.now() - DAY, { "a.md": kept });
    for (const m of [legacy1, legacy2, legacy3]) {
      await env.VAULT.put(`manifests/${m.id}.json`, JSON.stringify(m));
    }
    const lock = env.VAULT_LOCK.getByName("default");
    await runInDurableObject(lock, (_instance: VaultLock, state) => {
      state.storage.sql.exec("INSERT INTO meta (key, value) VALUES ('head', ?)", legacy3.id);
    });

    const first = await lock.advanceGcIndex({ maxManifests: 1 });
    expect(first).toMatchObject({ done: false, indexed: 1, cursor: legacy2.id });
    // Nothing may be deleted while the walk is only partly done.
    const midway = await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 0, indexChunk: 1 });
    expect(midway.skipped).toBe("index_backfilling");
    expect(midway.deletedManifests).toBe(0);
    expect(await env.VAULT.head(`blobs/${dropped}`)).not.toBeNull();

    let guard = 0;
    let progress = await lock.advanceGcIndex({ maxManifests: 1 });
    while (!progress.done) {
      if (++guard > 10) throw new Error("index walk did not converge");
      progress = await lock.advanceGcIndex({ maxManifests: 1 });
    }
    // A finished index answers immediately and reads nothing further.
    expect(await lock.advanceGcIndex({ maxManifests: 1 })).toEqual({
      done: true,
      indexed: 0,
      cursor: null,
    });

    await runInDurableObject(lock, (_instance: VaultLock, state) => {
      expect(
        state.storage.sql
          .exec<{ id: string }>("SELECT id FROM manifest_index ORDER BY uploaded_at, id")
          .toArray()
          .map((r) => r.id)
      ).toEqual([legacy1.id, legacy2.id, legacy3.id]);
      expect(
        state.storage.sql.exec<{ hash: string }>("SELECT hash FROM current_blob_refs").toArray()
      ).toEqual([{ hash: kept }]);
      // legacy2 is where `dropped` stopped being referenced; legacy1 is where both began.
      expect(
        state.storage.sql
          .exec<{ manifest_id: string; hash: string; delta: number }>(
            "SELECT manifest_id, hash, delta FROM manifest_blob_deltas WHERE hash = ? ORDER BY delta",
            dropped
          )
          .toArray()
      ).toEqual([
        { manifest_id: legacy2.id, hash: dropped, delta: -1 },
        { manifest_id: legacy1.id, hash: dropped, delta: 1 },
      ]);
    });

    const report = await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 0 });
    expect(report.skipped).toBeNull();
    expect(report.retainedManifests).toBe(1);
    expect(report.deletedManifests).toBe(2);
    expect(await env.VAULT.head(`blobs/${kept}`)).not.toBeNull();
    expect(await env.VAULT.head(`blobs/${dropped}`)).toBeNull();
  });

  /**
   * Cloudflare cannot fire a deployed Worker's Cron Trigger — `--test-scheduled` is a local
   * dev server only — so without these routes the only way to see GC act on a real vault is
   * to wait for 04:00 and read logs afterwards.
   */
  describe("admin trigger", () => {
    it("runs the sweep on demand and reports what it did", async () => {
      const blob = await seedBlob("swept by hand");
      const orphan = await seedBlob("nothing references me");
      await publish(makeManifest({ files: { "a.md": { h: blob } } }), null);

      const res = await SELF.fetch(`${BASE}/api/gc`, authed(ADMIN, { method: "POST" }));

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ skipped: null, retainedManifests: 1 });
      // minAgeMs defaults to a day, so a freshly written orphan is deliberately spared.
      expect(await env.VAULT.head(`blobs/${orphan}`)).not.toBeNull();
      expect(await env.VAULT.head(`blobs/${blob}`)).not.toBeNull();
    });

    it("advances the reference-index migration by the requested bound", async () => {
      const blob = await seedBlob("legacy");
      const legacy1 = manifest(ulid(Date.now() - 2 * DAY), null, Date.now() - 2 * DAY, {
        "a.md": blob,
      });
      const legacy2 = manifest(ulid(Date.now() - DAY), legacy1.id, Date.now() - DAY, {
        "a.md": blob,
      });
      await env.VAULT.put(`manifests/${legacy1.id}.json`, JSON.stringify(legacy1));
      await env.VAULT.put(`manifests/${legacy2.id}.json`, JSON.stringify(legacy2));
      await runInDurableObject(
        env.VAULT_LOCK.getByName("default"),
        (_instance: VaultLock, state) => {
          state.storage.sql.exec("INSERT INTO meta (key, value) VALUES ('head', ?)", legacy2.id);
        }
      );

      const step = await SELF.fetch(
        `${BASE}/api/gc/index?manifests=1`,
        authed(ADMIN, { method: "POST" })
      );
      expect(step.status).toBe(200);
      // One link per call, and the cursor names where the next one picks up.
      expect(await step.json()).toEqual({ done: false, indexed: 1, cursor: legacy1.id });

      const finish = await SELF.fetch(
        `${BASE}/api/gc/index?manifests=1`,
        authed(ADMIN, { method: "POST" })
      );
      expect(await finish.json()).toEqual({ done: true, indexed: 1, cursor: null });

      const again = await SELF.fetch(`${BASE}/api/gc/index`, authed(ADMIN, { method: "POST" }));
      expect(await again.json()).toEqual({ done: true, indexed: 0, cursor: null });
    });

    it("refuses an unusable bound rather than silently choosing one", async () => {
      for (const bad of ["0", "-3", "2.5", "1001", "lots"]) {
        const res = await SELF.fetch(
          `${BASE}/api/gc/index?manifests=${bad}`,
          authed(ADMIN, { method: "POST" })
        );
        expect(res.status).toBe(422);
      }
    });

    it("is admin-only — an access token may sync, not collect", async () => {
      const { token } = await mintToken("device");
      for (const path of ["/api/gc", "/api/gc/index"]) {
        expect((await SELF.fetch(`${BASE}${path}`, authed(token, { method: "POST" }))).status).toBe(
          403
        );
        expect((await SELF.fetch(`${BASE}${path}`, { method: "POST" })).status).toBe(401);
      }
    });
  });

  it("derives retained liveness without downloading retained manifests", async () => {
    const blob = await seedBlob("indexed");
    const first = makeManifest({ files: { "a.md": { h: blob } } });
    await publish(first, null);
    let manifestGets = 0;
    let listCalls = 0;
    const real = env.VAULT;
    const counting = {
      head: (key: string) => real.head(key),
      get: (key: string, options?: R2GetOptions) => {
        if (key.startsWith("manifests/")) manifestGets++;
        return real.get(key, options);
      },
      list: (options?: R2ListOptions) => {
        listCalls++;
        return real.list(options);
      },
      put: (key: string, value: ReadableStream | ArrayBuffer | string, options?: R2PutOptions) =>
        real.put(key, value, options),
      delete: (keys: string | string[]) => real.delete(keys),
    };

    const report = await runGc(
      { ...env, VAULT: counting as unknown as R2Bucket },
      { now: Date.now(), minAgeMs: 0 }
    );
    expect(report.skipped).toBeNull();
    expect(manifestGets).toBe(0);
    expect(listCalls).toBe(2); // one incremental pass per prefix at this bucket size
  });
});
