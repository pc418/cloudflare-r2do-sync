import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { runGc } from "../src/gc";
import type { Manifest, ManifestV2 } from "../src/manifest";
import { makeManifestV2, sha256hex, ulid } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

async function seedBlob(content: string): Promise<string> {
  const h = await sha256hex(content);
  await env.VAULT.put(`blobs/${h}`, content);
  return h;
}

async function seedManifest(m: Manifest): Promise<void> {
  await env.VAULT.put(`manifests/${m.id}.json`, JSON.stringify(m));
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
  it("no head.json → no-op with zero counts", async () => {
    const report = await runGc(env, { now: Date.now(), minAgeMs: 0 });
    expect(report.deletedManifests).toBe(0);
    expect(report.deletedBlobs).toBe(0);
  });

  it("missing mirrored head manifest aborts without deleting anything", async () => {
    const now = Date.now() + 2 * DAY;
    const danglingHead = ulid(now - DAY);
    const orphan = await seedBlob("must survive a broken head");
    await env.VAULT.put("head.json", JSON.stringify({ head: danglingHead }));

    await expect(runGc(env, { now, minAgeMs: 0 })).rejects.toThrow(
      `head manifest ${danglingHead} is missing`
    );
    expect(await env.VAULT.head(`blobs/${orphan}`)).not.toBeNull();
  });

  it("keeps the retained chain and its blobs, deletes expired manifests and orphaned blobs", async () => {
    const now = Date.now() + 2 * DAY; // logical "now" ahead of upload times so minAge can be tested separately
    const oldT = now - 100 * DAY;
    const newT = now - 1 * DAY;

    const liveBlob = await seedBlob("still referenced");
    const oldOnlyBlob = await seedBlob("only in expired manifest");
    const orphanBlob = await seedBlob("referenced by nothing");

    // chain: mOld (expired, beyond keepCount) <- m1 <- m2 (head)
    const mOld = manifest(ulid(oldT), null, oldT, { "old.md": oldOnlyBlob });
    const m1 = manifest(ulid(newT - 1000), mOld.id, newT - 1000, { "a.md": liveBlob });
    const m2 = manifest(ulid(newT), m1.id, newT, { "a.md": liveBlob });
    await seedManifest(mOld);
    await seedManifest(m1);
    await seedManifest(m2);
    await env.VAULT.put("head.json", JSON.stringify({ head: m2.id }));

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
    await seedManifest(m1);
    await seedManifest(m2);
    await env.VAULT.put("head.json", JSON.stringify({ head: m2.id }));

    const report = await runGc(env, { now, keepCount: 50, keepDays: 30, minAgeMs: 0 });
    expect(report.retainedManifests).toBe(2);
    expect(report.deletedManifests).toBe(0);
    expect(await env.VAULT.head(`blobs/${blob}`)).not.toBeNull();
  });

  it("traces liveness through encrypted manifests (blobs[] is the only readable reference)", async () => {
    const now = Date.now() + 2 * DAY;
    const newT = now - 1 * DAY;
    const oldT = now - 100 * DAY;

    const live = await seedBlob("live ciphertext");
    const dropped = await seedBlob("ciphertext only in the expired snapshot");

    const old: ManifestV2 = makeManifestV2({
      id: ulid(oldT),
      blobs: [dropped],
      createdAt: new Date(oldT).toISOString(),
    });
    const head: ManifestV2 = makeManifestV2({
      id: ulid(newT),
      parent: old.id,
      blobs: [live],
      createdAt: new Date(newT).toISOString(),
    });
    await seedManifest(old);
    await seedManifest(head);
    await env.VAULT.put("head.json", JSON.stringify({ head: head.id }));

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
    await seedManifest(m);
    await env.VAULT.put("head.json", JSON.stringify({ head: m.id }));

    // minAge of 30 days: everything in the bucket is younger than that in real time
    const report = await runGc(env, { now, keepCount: 50, keepDays: 30, minAgeMs: 30 * DAY });
    expect(report.deletedBlobs).toBe(0);
    expect(await env.VAULT.head(`blobs/${orphan}`)).not.toBeNull();
  });
});
