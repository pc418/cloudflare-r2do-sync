import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runGc } from "../src/gc";
import { commit, makeManifest, mintToken, sha256hex, ulid } from "./helpers";
import type { VaultLock } from "../src/vault-lock";

let token: string;

const lock = () => env.VAULT_LOCK.getByName("default");

beforeEach(async () => {
  ({ token } = await mintToken("race-tester"));
});

afterEach(async () => {
  await runInDurableObject(lock(), (instance: VaultLock) => {
    instance.testHookAfterVerify = undefined;
  });
  await lock().releaseGcLease();
});

/**
 * Waits in the caller's own I/O context. A promise created in one context and awaited in
 * another kills the runtime outright ("Promise callback destroyed itself"), so the gate
 * between the test and the paused commit is plain booleans — never a shared promise.
 */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 5));
}

/**
 * Commit verifies that every blob it needs is present, then writes. GC lists what nothing
 * references and deletes it. Nothing used to connect the two, so an *aged* orphan — one past
 * the fresh-upload floor — could pass a commit's verification and be deleted before the head
 * that protects it landed. Content addressing makes that ordinary, not exotic: a file whose
 * bytes match an old orphan uploads nothing and simply references it.
 */
describe("gc / commit exclusion", () => {
  it("refuses the lease while a commit is between verifying its blobs and writing", async () => {
    const orphanContent = "an aged blob a new snapshot is about to reference";
    const hash = await sha256hex(orphanContent);
    await env.VAULT.put(`blobs/${hash}`, orphanContent); // unreferenced by anything

    let reached = false;
    let released = false;
    await runInDurableObject(lock(), (instance: VaultLock) => {
      instance.testHookAfterVerify = async () => {
        reached = true;
        while (!released) await new Promise<void>((r) => setTimeout(r, 5));
      };
    });

    const m = makeManifest({ files: { "a.md": { h: hash } } });
    const inFlight = commit(token, m, null);
    while (!reached) await tick(); // the commit has now been told the blob exists

    const report = await runGc(env, { now: Date.now(), minAgeMs: 0 });
    expect(report.skipped).toBe("commit_in_flight");
    expect(report.deletedBlobs).toBe(0);

    released = true;
    const res = await inFlight;
    expect(res.status).toBe(200);
    // The head that just landed still has the bytes it promised.
    expect(await env.VAULT.head(`blobs/${hash}`)).not.toBeNull();
  });

  it("refuses a commit while GC holds the lease, as a retryable 503", async () => {
    const hash = await sha256hex("content");
    await env.VAULT.put(`blobs/${hash}`, "content");
    const lease = await lock().acquireGcLease({ nowMs: Date.now(), ttlMs: 60_000 });
    expect(lease.ok).toBe(true);

    const m = makeManifest({ files: { "a.md": { h: hash } } });
    const res = await commit(token, m, null);

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(await res.json()).toMatchObject({ error: { code: "gc_busy" } });
    expect(await lock().getHead()).toBeNull();

    await lock().releaseGcLease();
    expect((await commit(token, m, null)).status).toBe(200);
  });

  it("expires the lease so a killed sweep cannot wedge commits", async () => {
    const hash = await sha256hex("content");
    await env.VAULT.put(`blobs/${hash}`, "content");
    // A run that acquired the lease and then died: nothing ever released it.
    const lease = await lock().acquireGcLease({ nowMs: Date.now() - 10_000, ttlMs: 1 });
    expect(lease.ok).toBe(true);

    const res = await commit(token, makeManifest({ files: { "a.md": { h: hash } } }), null);
    expect(res.status).toBe(200);
  });

  it("lets a second GC run take the lease once the first released it", async () => {
    const hash = await sha256hex("content");
    await env.VAULT.put(`blobs/${hash}`, "content");
    await commit(token, makeManifest({ id: ulid(), files: { "a.md": { h: hash } } }), null);

    expect((await runGc(env, { now: Date.now(), minAgeMs: 0 })).skipped).toBeNull();
    expect((await runGc(env, { now: Date.now(), minAgeMs: 0 })).skipped).toBeNull();
  });

  it("aborts the sweep if its lease lapsed rather than deleting against a stale live set", async () => {
    // A lease that expires mid-run stops excluding commits, so a snapshot can land and make
    // the live set computed earlier wrong. Deleting against it would remove blobs the new
    // head references — so a lapsed lease has to stop the sweep, not be ignored.
    const hash = await sha256hex("live content");
    await env.VAULT.put(`blobs/${hash}`, "live content");
    await commit(token, makeManifest({ files: { "a.md": { h: hash } } }), null);
    const orphan = await sha256hex("orphan");
    await env.VAULT.put(`blobs/${orphan}`, "orphan");

    // ttl 1ms: the lease is already gone by the time the first delete phase is reached.
    await expect(runGc(env, { now: Date.now(), minAgeMs: 0, leaseTtlMs: 1 })).rejects.toThrow(
      /lost the deletion lease/
    );
    expect(await env.VAULT.head(`blobs/${orphan}`)).not.toBeNull();
  });

  it("a lapsed sweep cannot renew, nor release the lease a later sweep now holds", async () => {
    const stale = await lock().acquireGcLease({ nowMs: Date.now() - 10_000, ttlMs: 1 });
    expect(stale.ok).toBe(true);
    if (!stale.ok) throw new Error("unreachable");

    // Expired: renewal is refused rather than silently resurrecting the exclusion.
    expect(await lock().renewGcLease(stale.leaseId, { nowMs: Date.now(), ttlMs: 60_000 })).toBe(false);

    const fresh = await lock().acquireGcLease({ nowMs: Date.now(), ttlMs: 60_000 });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) throw new Error("unreachable");
    expect(fresh.leaseId).not.toBe(stale.leaseId);

    // The lapsed run's `finally` must not free the new run's exclusion.
    await lock().releaseGcLease(stale.leaseId);
    const hash = await sha256hex("content");
    await env.VAULT.put(`blobs/${hash}`, "content");
    const res = await commit(token, makeManifest({ files: { "a.md": { h: hash } } }), null);
    expect(res.status).toBe(503);

    await lock().releaseGcLease(fresh.leaseId);
    expect((await commit(token, makeManifest({ files: { "a.md": { h: hash } } }), null)).status).toBe(200);
  });

  it("refuses a commit under a lease before it lists anything for the id registry", async () => {
    // The registry backfill lists R2 and then records completion permanently, so a manifest
    // deleted mid-listing would be missed forever and its id handed back out. The exclusion
    // has to be taken before that listing, which on a fresh vault is what this proves.
    const hash = await sha256hex("content");
    await env.VAULT.put(`blobs/${hash}`, "content");
    await lock().acquireGcLease({ nowMs: Date.now(), ttlMs: 60_000 });

    const res = await commit(token, makeManifest({ files: { "a.md": { h: hash } } }), null);
    expect(res.status).toBe(503);
    // Nothing was recorded as backfilled, so the next commit still does the listing.
    await lock().releaseGcLease();
    expect((await commit(token, makeManifest({ files: { "a.md": { h: hash } } }), null)).status).toBe(200);
  });

  it("skips rather than deleting when another sweep already holds the lease", async () => {
    const hash = await sha256hex("content");
    await env.VAULT.put(`blobs/${hash}`, "content");
    await commit(token, makeManifest({ files: { "a.md": { h: hash } } }), null);
    const orphan = await sha256hex("orphan");
    await env.VAULT.put(`blobs/${orphan}`, "orphan");

    await lock().acquireGcLease({ nowMs: Date.now(), ttlMs: 60_000 });
    const report = await runGc(env, { now: Date.now(), minAgeMs: 0 });

    expect(report.skipped).toBe("already_leased");
    expect(await env.VAULT.head(`blobs/${orphan}`)).not.toBeNull();
  });

});
