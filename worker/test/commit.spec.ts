import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  BASE,
  authed,
  commit,
  makeManifest,
  makeManifestV2,
  mintToken,
  putBlob,
  sha256hex,
  ulid,
} from "./helpers";
import { LIST_THRESHOLD } from "../src/blobs";
import type { Env } from "../src/index";
import type { VaultLock } from "../src/vault-lock";

let token: string;

beforeEach(async () => {
  ({ token } = await mintToken("commit-tester"));
});

describe("POST /api/commit", () => {
  it("first commit on empty vault advances head, persists manifest, mirrors head.json", async () => {
    const h = await putBlob(token, "first note");
    const m = makeManifest({ files: { "a.md": { h } } });

    const res = await commit(token, m, null);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ head: m.id });

    const headRes = await SELF.fetch(`${BASE}/api/head`, authed(token));
    expect(await headRes.json()).toEqual({ head: m.id });

    const stored = await env.VAULT.get(`manifests/${m.id}.json`);
    expect(stored).not.toBeNull();
    expect((await stored!.json<{ id: string }>()).id).toBe(m.id);

    const mirror = await env.VAULT.get("head.json");
    expect(mirror).not.toBeNull();
    expect(await mirror!.json()).toEqual({ head: m.id });
  });

  it("second commit chains onto the first", async () => {
    const h1 = await putBlob(token, "note one");
    const m1 = makeManifest({ files: { "a.md": { h: h1 } } });
    expect((await commit(token, m1, null)).status).toBe(200);

    const h2 = await putBlob(token, "note two");
    const m2 = makeManifest({ id: ulid(Date.now() + 1), parent: m1.id, files: { "a.md": { h: h1 }, "b.md": { h: h2 } } });
    const res = await commit(token, m2, m1.id);
    expect(res.status).toBe(200);

    const headRes = await SELF.fetch(`${BASE}/api/head`, authed(token));
    expect(await headRes.json()).toEqual({ head: m2.id });
  });

  it("delete-by-omission round-trips", async () => {
    const h1 = await putBlob(token, "keep me");
    const h2 = await putBlob(token, "delete me");
    const m1 = makeManifest({ files: { "keep.md": { h: h1 }, "gone.md": { h: h2 } } });
    expect((await commit(token, m1, null)).status).toBe(200);

    const m2 = makeManifest({ id: ulid(Date.now() + 1), parent: m1.id, files: { "keep.md": { h: h1 } } });
    expect((await commit(token, m2, m1.id)).status).toBe(200);

    const res = await SELF.fetch(`${BASE}/api/manifests/${m2.id}`, authed(token));
    const stored = await res.json<{ files: Record<string, unknown> }>();
    expect(Object.keys(stored.files)).toEqual(["keep.md"]);
  });

  it("round-trips a root __proto__ file through JSON validation and R2", async () => {
    const h = await putBlob(token, "prototype note");
    const files = Object.create(null) as Record<string, { h: string }>;
    files.__proto__ = { h };
    const m = makeManifest({ files });

    expect((await commit(token, m, null)).status).toBe(200);
    const res = await SELF.fetch(`${BASE}/api/manifests/${m.id}`, authed(token));
    const stored = await res.json<{ files: Record<string, { h: string }> }>();
    expect(Object.hasOwn(stored.files, "__proto__")).toBe(true);
    expect(stored.files.__proto__.h).toBe(h);
  });

  it("stale expectedHead returns 409 with the current head", async () => {
    const h = await putBlob(token, "device A note");
    const mA = makeManifest({ files: { "a.md": { h } } });
    expect((await commit(token, mA, null)).status).toBe(200);

    // device B still thinks head is null
    const mB = makeManifest({ id: ulid(Date.now() + 1), files: { "b.md": { h } } });
    const res = await commit(token, mB, null);
    expect(res.status).toBe(409);
    const body = await res.json<{ error: { code: string }; head: string }>();
    expect(body.error.code).toBe("stale_head");
    expect(body.head).toBe(mA.id);
  });

  it("commit referencing a missing blob returns 422 and does not move head", async () => {
    const ghost = await sha256hex("never uploaded");
    const m = makeManifest({ files: { "ghost.md": { h: ghost } } });
    const res = await commit(token, m, null);
    expect(res.status).toBe(422);
    const body = await res.json<{ error: { code: string }; hashes: string[] }>();
    expect(body.error.code).toBe("missing_blob");
    expect(body.hashes).toEqual([ghost]);

    const headRes = await SELF.fetch(`${BASE}/api/head`, authed(token));
    expect(await headRes.json()).toEqual({ head: null });
  });

  it("manifest.parent must equal expectedHead", async () => {
    const h = await putBlob(token, "x");
    const m = makeManifest({ parent: ulid(), files: { "a.md": { h } } });
    const res = await commit(token, m, null);
    expect(res.status).toBe(422);
  });

  // "Rebuild remote history": publish the current state as a new root and orphan the whole
  // existing chain, which the next GC then deletes. It is the only sanctioned way to commit a
  // manifest whose parent is not the head, so every guard around it is worth pinning.
  describe("reroot", () => {
    it("commits a new root over an existing head and makes it the head", async () => {
      const h1 = await putBlob(token, "old");
      const m1 = makeManifest({ files: { "a.md": { h: h1 } } });
      expect((await commit(token, m1, null)).status).toBe(200);

      const h2 = await putBlob(token, "new");
      const root = makeManifest({ id: ulid(Date.now() + 1), parent: null, files: { "a.md": { h: h2 } } });
      const res = await commit(token, root, m1.id, { reroot: true });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ head: root.id });
      const headRes = await SELF.fetch(`${BASE}/api/head`, authed(token));
      expect(await headRes.json()).toEqual({ head: root.id });
      // The old manifest is merely orphaned, not deleted: GC removes it on its own schedule,
      // which is why the UI says the purge completes later rather than now.
      expect(await env.VAULT.get(`manifests/${m1.id}.json`)).not.toBeNull();
    });

    // Still compare-and-set. Without this a reroot raced against another device's commit
    // would silently discard that device's work along with the history.
    it("refuses a reroot whose expectedHead is stale", async () => {
      const h = await putBlob(token, "old");
      const m1 = makeManifest({ files: { "a.md": { h } } });
      expect((await commit(token, m1, null)).status).toBe(200);

      const root = makeManifest({ id: ulid(Date.now() + 1), parent: null, files: { "a.md": { h } } });
      const res = await commit(token, root, ulid(), { reroot: true });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: "stale_head" }, head: m1.id });
    });

    // The expectedHead here is the REAL head, so the parent/head rule is satisfied and only
    // the reroot rule can reject it. Asking with a stale expectedHead would have failed for
    // the wrong reason and left this exact case — "reroot" quietly committing an ordinary
    // child, reporting success, and discarding nothing — completely untested.
    it("refuses a reroot that is a valid child rather than committing it as one", async () => {
      const h = await putBlob(token, "old");
      const m1 = makeManifest({ files: { "a.md": { h } } });
      expect((await commit(token, m1, null)).status).toBe(200);

      const child = makeManifest({ id: ulid(Date.now() + 1), parent: m1.id, files: { "a.md": { h } } });
      const res = await commit(token, child, m1.id, { reroot: true });

      expect(res.status).toBe(422);
      expect(await res.text()).toContain("parent null");
      // The head must not have moved: a refused commit changes nothing.
      const headRes = await SELF.fetch(`${BASE}/api/head`, authed(token));
      expect(await headRes.json()).toEqual({ head: m1.id });
    });

    it("refuses a reroot whose parent is some unrelated snapshot", async () => {
      const h = await putBlob(token, "old");
      const m1 = makeManifest({ files: { "a.md": { h } } });
      expect((await commit(token, m1, null)).status).toBe(200);

      const child = makeManifest({ id: ulid(Date.now() + 1), parent: ulid(), files: { "a.md": { h } } });
      const res = await commit(token, child, m1.id, { reroot: true });

      expect(res.status).toBe(422);
      expect(await res.text()).toContain("parent null");
    });

    // Without the flag this is the ordinary "you lost track of the chain" mistake, and it
    // must stay an error: discarding history cannot be something a client does by accident.
    it("still refuses a root manifest over a head when the flag is absent", async () => {
      const h = await putBlob(token, "old");
      const m1 = makeManifest({ files: { "a.md": { h } } });
      expect((await commit(token, m1, null)).status).toBe(200);

      const root = makeManifest({ id: ulid(Date.now() + 1), parent: null, files: { "a.md": { h } } });
      expect((await commit(token, root, m1.id)).status).toBe(422);
    });

    it("rejects a non-boolean reroot rather than guessing what was meant", async () => {
      const res = await SELF.fetch(
        `${BASE}/api/commit`,
        authed(token, {
          method: "POST",
          body: JSON.stringify({ manifest: makeManifest({ files: {} }), expectedHead: null, reroot: "yes" }),
          headers: { "content-type": "application/json" },
        })
      );
      expect(res.status).toBe(422);
      expect(await res.text()).toContain("reroot must be a boolean");
    });

    // A root verifies every blob it names, having no parent to inherit a verified set from.
    it("still refuses a root that references a blob which is not there", async () => {
      const h = await putBlob(token, "old");
      const m1 = makeManifest({ files: { "a.md": { h } } });
      expect((await commit(token, m1, null)).status).toBe(200);

      const ghost = await sha256hex("never uploaded");
      const root = makeManifest({ id: ulid(Date.now() + 1), parent: null, files: { "a.md": { h: ghost } } });
      const res = await commit(token, root, m1.id, { reroot: true });

      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: { code: "missing_blob" } });
    });
  });

  it("retrying an already-committed manifest repairs a missing head mirror", async () => {
    const h = await putBlob(token, "retry me");
    const m = makeManifest({ files: { "a.md": { h } } });
    expect((await commit(token, m, null)).status).toBe(200);

    // Model the partial-commit failure: manifest + DO head persisted, but the final
    // head.json R2 write failed. The retry must repair the disaster-recovery mirror.
    await env.VAULT.delete("head.json");
    const retry = await commit(token, m, null);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ head: m.id });

    const mirror = await env.VAULT.get("head.json");
    expect(mirror).not.toBeNull();
    expect(await mirror!.json()).toEqual({ head: m.id });
  });

  it("two concurrent commits with the same expectedHead: exactly one wins", async () => {
    const h = await putBlob(token, "contested");
    const m1 = makeManifest({ files: { "one.md": { h } } });
    const m2 = makeManifest({ id: ulid(Date.now() + 1), files: { "two.md": { h } } });

    const [r1, r2] = await Promise.all([commit(token, m1, null), commit(token, m2, null)]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = r1.status === 200 ? m1 : m2;
    const headRes = await SELF.fetch(`${BASE}/api/head`, authed(token));
    expect(await headRes.json()).toEqual({ head: winner.id });
  });

  it("malformed JSON body returns 400", async () => {
    const res = await SELF.fetch(
      `${BASE}/api/commit`,
      authed(token, { method: "POST", body: "{not json", headers: { "content-type": "application/json" } })
    );
    expect(res.status).toBe(400);
  });

  it("GET /api/manifests/:id returns 404 for unknown id", async () => {
    const res = await SELF.fetch(`${BASE}/api/manifests/${ulid()}`, authed(token));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/commit — encrypted (v2) snapshots", () => {
  it("commits an encrypted snapshot and round-trips the ciphertext untouched", async () => {
    const c = await putBlob(token, "ciphertext-bytes");
    const enc = { alg: "AES-GCM" as const, iv: "MDEyMzQ1Njc4OWFi", data: "c2VjcmV0LW1hcA==" };
    const m = makeManifestV2({ blobs: [c], enc });

    expect((await commit(token, m, null)).status).toBe(200);

    const res = await SELF.fetch(`${BASE}/api/manifests/${m.id}`, authed(token));
    const stored = await res.json<typeof m>();
    expect(stored.enc).toEqual(enc);
    expect(stored.keyId).toBe(m.keyId);
    expect(stored.blobs).toEqual([c]);
  });

  it("verifies encrypted blobs exist: unknown blob → 422, head unchanged", async () => {
    const ghost = await sha256hex("never uploaded ciphertext");
    const res = await commit(token, makeManifestV2({ blobs: [ghost] }), null);
    expect(res.status).toBe(422);
    const body = await res.json<{ error: { code: string }; hashes: string[] }>();
    expect(body.error.code).toBe("missing_blob");
    expect(body.hashes).toEqual([ghost]);

    const headRes = await SELF.fetch(`${BASE}/api/head`, authed(token));
    expect(await headRes.json()).toEqual({ head: null });
  });

  it("an encrypted snapshot can chain onto an empty plaintext head (the live migration path)", async () => {
    const v1 = makeManifest({ files: {} });
    expect((await commit(token, v1, null)).status).toBe(200);

    const c = await putBlob(token, "first encrypted blob");
    const v2 = makeManifestV2({ id: ulid(Date.now() + 1), parent: v1.id, blobs: [c] });
    expect((await commit(token, v2, v1.id)).status).toBe(200);

    const headRes = await SELF.fetch(`${BASE}/api/head`, authed(token));
    expect(await headRes.json()).toEqual({ head: v2.id });
  });

  it("only blobs new relative to the encrypted parent must exist at commit time", async () => {
    const c1 = await putBlob(token, "kept ciphertext");
    const m1 = makeManifestV2({ blobs: [c1] });
    expect((await commit(token, m1, null)).status).toBe(200);

    // c1 is inherited; only c2 is new, and it is present.
    const c2 = await putBlob(token, "added ciphertext");
    const m2 = makeManifestV2({ id: ulid(Date.now() + 1), parent: m1.id, blobs: [c1, c2] });
    expect((await commit(token, m2, m1.id)).status).toBe(200);
  });

  it("rejects a duplicate-blob manifest with 422", async () => {
    const c = await putBlob(token, "dupe ciphertext");
    const res = await commit(token, makeManifestV2({ blobs: [c, c] }), null);
    expect(res.status).toBe(422);
  });
});

/**
 * A commit verifies the blobs it adds to its parent, so the count is normally small — but a
 * first sync and a reroot both parent onto nothing and verify the entire snapshot. That is
 * the shape that took the vault down through `/api/blobs/check` on 2026-08-10, so the same
 * threshold policy applies here. These cases sit either side of `LIST_THRESHOLD` (64).
 */
describe("POST /api/commit — verifying many new blobs at once", () => {
  /** Enough blobs to cross the listing threshold, uploaded for real. */
  async function uploadMany(count: number, tag: string): Promise<string[]> {
    const hashes: string[] = [];
    for (let i = 0; i < count; i++) hashes.push(await putBlob(token, `${tag}-${i}`));
    return hashes;
  }

  it("a first sync past the threshold verifies every blob and commits", async () => {
    const blobs = await uploadMany(LIST_THRESHOLD + 6, "first-sync");
    const m = makeManifestV2({ blobs });

    expect((await commit(token, m, null)).status).toBe(200);
    const headRes = await SELF.fetch(`${BASE}/api/head`, authed(token));
    expect(await headRes.json()).toEqual({ head: m.id });
  });

  it("names exactly the absent blobs among many present ones, and does not move head", async () => {
    const present = await uploadMany(LIST_THRESHOLD + 4, "mixed");
    const ghostA = await sha256hex("absent one");
    const ghostB = await sha256hex("absent two");
    const m = makeManifestV2({ blobs: [...present, ghostA, ghostB] });

    const res = await commit(token, m, null);
    expect(res.status).toBe(422);
    const body = await res.json<{ error: { code: string }; hashes: string[] }>();
    expect(body.error.code).toBe("missing_blob");
    expect(body.hashes.sort()).toEqual([ghostA, ghostB].sort());

    const headRes = await SELF.fetch(`${BASE}/api/head`, authed(token));
    expect(await headRes.json()).toEqual({ head: null });
  });

  it("a reroot past the threshold re-verifies the whole snapshot it re-roots", async () => {
    const blobs = await uploadMany(LIST_THRESHOLD + 2, "reroot");
    const first = makeManifestV2({ blobs });
    expect((await commit(token, first, null)).status).toBe(200);

    const rerooted = makeManifestV2({ id: ulid(Date.now() + 1), parent: null, blobs });
    expect((await commit(token, rerooted, first.id, { reroot: true })).status).toBe(200);

    const headRes = await SELF.fetch(`${BASE}/api/head`, authed(token));
    expect(await headRes.json()).toEqual({ head: rerooted.id });
  });

  /**
   * The cases above pass against the old per-hash loop too — they assert the answer, and the
   * answer never changed. This one asserts the *cost*, by driving the Durable Object with a
   * bucket that counts binding calls, so reverting the commit path to a head() per hash
   * cannot slip through green.
   */
  it("verifies a large snapshot by listing, not by one head() per new blob", async () => {
    const blobs = await uploadMany(LIST_THRESHOLD + 3, "counted");
    const m = makeManifestV2({ blobs });
    const counts = { head: 0, list: 0 };
    const real = env.VAULT;
    const counting = {
      head: (key: string) => {
        counts.head++;
        return real.head(key);
      },
      list: (options?: R2ListOptions) => {
        counts.list++;
        return real.list(options);
      },
      get: (key: string) => real.get(key),
      put: (key: string, value: ReadableStream | ArrayBuffer | string, options?: R2PutOptions) =>
        real.put(key, value, options),
      delete: (keys: string | string[]) => real.delete(keys),
    };

    const stub = env.VAULT_LOCK.getByName("default");
    const result = await runInDurableObject(stub, async (instance: VaultLock) => {
      const swappable = instance as unknown as { env: Env };
      const original = swappable.env;
      swappable.env = { ...original, VAULT: counting as unknown as R2Bucket };
      try {
        return await instance.commit(m, null);
      } finally {
        swappable.env = original;
      }
    });

    expect(result).toEqual({ ok: true, head: m.id });
    expect(counts.head).toBe(0);
    expect(counts.list).toBeGreaterThan(0);
  });

  it("a small reroot still verifies correctly, without scanning for two blobs", async () => {
    const kept = await putBlob(token, "small reroot blob");
    const first = makeManifestV2({ blobs: [kept] });
    expect((await commit(token, first, null)).status).toBe(200);

    const ghost = await sha256hex("small reroot ghost");
    const bad = makeManifestV2({ id: ulid(Date.now() + 1), parent: null, blobs: [kept, ghost] });
    const res = await commit(token, bad, first.id, { reroot: true });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "missing_blob" }, hashes: [ghost] });
  });
});
