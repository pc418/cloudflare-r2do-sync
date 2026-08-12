import { SELF, env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { runGc } from "../src/gc";
import { BASE, authed, commit, makeManifest, mintToken, putBlob, ulid } from "./helpers";
import type { Manifest } from "../src/manifest";

const DAY = 24 * 60 * 60 * 1000;

let token: string;

beforeEach(async () => {
  ({ token } = await mintToken("id-reuse-tester"));
});

async function head(): Promise<string | null> {
  const res = await SELF.fetch(`${BASE}/api/head`, authed(token));
  return ((await res.json()) as { head: string | null }).head;
}

async function commitOk(m: Manifest, expectedHead: string | null, opts: { reroot?: boolean } = {}) {
  const res = await commit(token, m, expectedHead, opts);
  if (res.status !== 200) throw new Error(`commit failed: ${res.status} ${await res.text()}`);
  return m.id;
}

async function storedManifest(id: string): Promise<Manifest | null> {
  const obj = await env.VAULT.get(`manifests/${id}.json`);
  return obj === null ? null : await obj.json();
}

/**
 * Manifest IDs are chosen by the client. Nothing else in the protocol stops a valid writer
 * from choosing one that already exists, and an overwritten ancestor closes the chain into a
 * cycle: `old → previous-head → … → old`. GC walks that until the Worker kills the request,
 * so the vault stops being collected at all. The ID registry is what makes it impossible.
 */
describe("manifest id reuse", () => {
  it("refuses to overwrite an ancestor, leaving head and the stored ancestor untouched", async () => {
    const h1 = await putBlob(token, "one");
    const m1 = makeManifest({ files: { "a.md": { h: h1 } } });
    await commitOk(m1, null);

    const h2 = await putBlob(token, "two");
    const m2 = makeManifest({ id: ulid(Date.now() + 1), parent: m1.id, files: { "b.md": { h: h2 } } });
    await commitOk(m2, m1.id);

    // The attack: a well-formed child of the current head that reuses the root's ID.
    const cycle = makeManifest({ id: m1.id, parent: m2.id, files: { "b.md": { h: h2 } } });
    const res = await commit(token, cycle, m2.id);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "duplicate_manifest_id" } });
    expect(await head()).toBe(m2.id);
    expect((await storedManifest(m1.id))?.parent).toBeNull();
  });

  it("refuses an id whose manifest GC has already deleted", async () => {
    // The registry has to outlive the object, or the ID becomes free again the moment
    // history is trimmed — and retained manifests still name it as their parent.
    const old = new Date(Date.now() - 90 * DAY).toISOString();
    const h1 = await putBlob(token, "ancient");
    const m1 = makeManifest({ files: { "a.md": { h: h1 } }, createdAt: old });
    await commitOk(m1, null);
    const m2 = makeManifest({ id: ulid(Date.now() + 1), parent: m1.id, files: { "a.md": { h: h1 } }, createdAt: old });
    await commitOk(m2, m1.id);

    // Ages are measured from the upload time R2 recorded, so the logical clock moves past
    // keepDays rather than the manifests claiming to be old.
    const report = await runGc(env, { now: Date.now() + 100 * DAY, keepCount: 1, keepDays: 30, minAgeMs: 0 });
    expect(report.deletedManifests).toBe(1);
    expect(await storedManifest(m1.id)).toBeNull();

    const revived = makeManifest({ id: m1.id, parent: m2.id, files: { "a.md": { h: h1 } } });
    const res = await commit(token, revived, m2.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "duplicate_manifest_id" } });
  });

  it("refuses ids that predate the registry, backfilled from the bucket", async () => {
    // A vault deployed before this rule has manifests in R2 and no registry rows. The
    // backfill is what stops the upgrade from handing every historical ID back out.
    const legacyId = ulid(Date.now() - 5000);
    const legacy = makeManifest({ id: legacyId, files: {} });
    await env.VAULT.put(`manifests/${legacyId}.json`, JSON.stringify(legacy));

    const res = await commit(token, makeManifest({ id: legacyId, files: {} }), null);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "duplicate_manifest_id" } });
  });

  it("still treats an identical re-commit of the head as the idempotent retry it is", async () => {
    // The mirror write is the last step of a commit and can fail on its own. The client's
    // retry must repair it rather than be rejected as a duplicate.
    const h = await putBlob(token, "retry me");
    const m = makeManifest({ files: { "a.md": { h } } });
    await commitOk(m, null);
    await env.VAULT.delete("head.json");

    const res = await commit(token, m, null);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ head: m.id });
    const mirror = await env.VAULT.get("head.json");
    expect(await mirror!.json()).toEqual({ head: m.id });
  });

  it("accepts a retry whose JSON key order differs", async () => {
    const h = await putBlob(token, "reordered");
    const m = makeManifest({ files: { "a.md": { h } } });
    await commitOk(m, null);

    const reordered = {
      files: m.files,
      createdAt: m.createdAt,
      device: m.device,
      parent: m.parent,
      id: m.id,
      v: m.v,
    } as unknown as Manifest;
    const res = await commit(token, reordered, null);
    expect(res.status).toBe(200);
  });

  it("refuses a re-commit of the head id that carries different content", async () => {
    const h1 = await putBlob(token, "original");
    const m = makeManifest({ files: { "a.md": { h: h1 } } });
    await commitOk(m, null);

    const h2 = await putBlob(token, "substituted");
    const impostor = { ...m, files: { "a.md": { h: h2, size: 1, mtime: 1_754_000_000_000 } } };
    const res = await commit(token, impostor as Manifest, null);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "duplicate_manifest_id" } });
    // The published snapshot still says what it said when it was published.
    expect((await storedManifest(m.id)) as unknown as { files: Record<string, { h: string }> }).toMatchObject({
      files: { "a.md": { h: h1 } },
    });
  });

  it("refuses a reroot that reuses an orphaned id", async () => {
    const h = await putBlob(token, "content");
    const m1 = makeManifest({ files: { "a.md": { h } } });
    await commitOk(m1, null);

    const res = await commit(token, makeManifest({ id: m1.id, files: { "a.md": { h } } }), m1.id, {
      reroot: true,
    });
    // Same id as the head but different content (parent differs from the stored one is not
    // even reached — content comparison rejects it first).
    expect(res.status).toBe(409);
    expect(await head()).toBe(m1.id);
  });
});

describe("gc chain walking", () => {
  it("fails closed on a cyclic chain instead of walking until the CPU limit", async () => {
    const h = await putBlob(token, "cycle content");
    const m1 = makeManifest({ files: { "a.md": { h } } });
    await commitOk(m1, null);
    const m2 = makeManifest({ id: ulid(Date.now() + 1), parent: m1.id, files: { "a.md": { h } } });
    await commitOk(m2, m1.id);

    // Corruption that predates the registry: the root now points back at its own child.
    await env.VAULT.put(`manifests/${m1.id}.json`, JSON.stringify({ ...m1, parent: m2.id }));

    await expect(runGc(env, { now: Date.now(), keepCount: 50, minAgeMs: 0 })).rejects.toThrow(
      /manifest chain cycles at/
    );
    // Fail-closed means nothing was deleted on the way to noticing.
    expect(await env.VAULT.head(`blobs/${h}`)).not.toBeNull();
  });
});
