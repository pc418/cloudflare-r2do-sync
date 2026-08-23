// The snapshot chain, answered from the index instead of walked over the network.
//
// The client's own walk is a linked list: a manifest's parent is only known once that manifest
// has been fetched AND decrypted, so listing N snapshots costs N sequential round trips, each
// carrying the whole encrypted path map. Measured on the real vault that is 12.7 MiB over 41
// round trips to draw a list of dates. Everything this route returns is already in the clear on
// the manifest envelope, so the saving is round trips and bytes, never confidentiality.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { ADMIN, BASE, authed, commit, makeManifest, makeManifestV2, mintToken, sha256hex, ulid } from "./helpers";
import type { Manifest } from "../src/manifest";
import type { VaultLock } from "../src/vault-lock";

let token: string;

beforeEach(async () => {
  ({ token } = await mintToken("history-tester"));
});

async function seedBlob(content: string): Promise<string> {
  const h = await sha256hex(content);
  await env.VAULT.put(`blobs/${h}`, content);
  return h;
}

async function publish(m: Manifest, expectedHead: string | null): Promise<string> {
  const res = await commit(token, m, expectedHead);
  if (res.status !== 200) throw new Error(`commit failed: ${res.status} ${await res.text()}`);
  return m.id;
}

async function history(limit?: number): Promise<Response> {
  const q = limit === undefined ? "" : `?limit=${limit}`;
  return SELF.fetch(`${BASE}/api/history${q}`, authed(token));
}

interface Page {
  complete: boolean;
  entries: Array<{ id: string; parent: string | null; spliceParent?: string | null; pruned?: number | null }>;
}

async function page(query: string): Promise<Page> {
  const res = await SELF.fetch(`${BASE}/api/history?${query}`, authed(token));
  if (res.status !== 200) throw new Error(`history failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as Page;
}

function lockStub(): DurableObjectStub<VaultLock> {
  return env.VAULT_LOCK.get(env.VAULT_LOCK.idFromName("default")) as DurableObjectStub<VaultLock>;
}

describe("GET /api/history", () => {
  it("returns the chain newest first, in one request", async () => {
    const h = await seedBlob("one");
    const a = await publish(makeManifest({ files: { "a.md": { h } }, device: "laptop" }), null);
    const b = await publish(
      makeManifest({ parent: a, files: { "a.md": { h } }, device: "phone" }),
      a
    );

    const res = await history();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      complete: boolean;
      entries: Array<{ id: string; parent: string | null; device: string | null; createdAt: string | null }>;
    };

    expect(body.complete).toBe(true);
    expect(body.entries.map((e) => e.id)).toEqual([b, a]);
    expect(body.entries.map((e) => e.parent)).toEqual([a, null]);
    // Device and creation time come from the clear envelope, recorded at commit.
    expect(body.entries.map((e) => e.device)).toEqual(["phone", "laptop"]);
    expect(body.entries.every((e) => typeof e.createdAt === "string")).toBe(true);
  });

  it("costs no R2 read at all", async () => {
    const h = await seedBlob("one");
    await publish(makeManifest({ files: { "a.md": { h } } }), null);

    // The whole point: the list is served from SQLite. A route that read manifests would move
    // the same megabytes, just one hop further from the user.
    const original = env.VAULT.get.bind(env.VAULT);
    let reads = 0;
    env.VAULT.get = ((...args: Parameters<typeof original>) => {
      reads++;
      return original(...args);
    }) as typeof env.VAULT.get;
    try {
      expect((await history()).status).toBe(200);
    } finally {
      env.VAULT.get = original;
    }
    expect(reads).toBe(0);
  });

  it("says the list is incomplete rather than implying history ends there", async () => {
    const h = await seedBlob("one");
    const a = await publish(makeManifest({ files: { "a.md": { h } } }), null);
    const b = await publish(makeManifest({ parent: a, files: { "a.md": { h } } }), a);

    // A vault whose older history predates the index: the row is simply not there, and the
    // backfill has not finished, so nothing can vouch for what is behind it. Reporting
    // `complete: true` would tell the client the vault has one snapshot, which is a lie about
    // the user's own history — the same mistake as reading a 5xx as a 404.
    //
    // The unfinished backfill is the whole premise and has to be set up, not assumed: once it
    // *is* finished, a row that is not there was collected, and the walk has reached the end of
    // retained history rather than a hole. That case is its own test.
    await runInDurableObject(lockStub(), (lock: VaultLock) => {
      const ctx = (lock as unknown as { ctx: DurableObjectState }).ctx;
      ctx.storage.sql.exec("DELETE FROM manifest_index WHERE id = ?", a);
      ctx.storage.sql.exec("DELETE FROM meta WHERE key = ?", "gc_index_backfilled");
    });

    const body = (await (await history()).json()) as { complete: boolean; entries: Array<{ id: string }> };
    expect(body.entries.map((e) => e.id)).toEqual([b]);
    expect(body.complete).toBe(false);
  });

  it("stops at the limit and reports the list as complete", async () => {
    const h = await seedBlob("one");
    let head: string | null = null;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      head = await publish(makeManifest({ parent: head, files: { "a.md": { h } } }), head);
      ids.push(head);
    }

    const body = (await (await history(2)).json()) as { complete: boolean; entries: Array<{ id: string }> };
    // Hitting the limit is not the same as running out of chain, and both are "complete" in
    // the sense that matters: nothing was lost.
    expect(body.entries.map((e) => e.id)).toEqual([ids[2], ids[1]]);
    expect(body.complete).toBe(true);
  });

  it("is empty and complete on a vault with no head", async () => {
    const body = (await (await history()).json()) as { complete: boolean; entries: unknown[] };
    expect(body).toEqual({ entries: [], complete: true });
  });

  it("refuses a limit that is not a usable count", async () => {
    for (const bad of ["0", "-1", "501", "abc", "1.5"]) {
      const res = await SELF.fetch(`${BASE}/api/history?limit=${bad}`, authed(token));
      expect(res.status).toBe(422);
    }
  });

  it("requires an access token", async () => {
    expect((await SELF.fetch(`${BASE}/api/history`)).status).toBe(401);
  });

  it("continues from a cursor without repeating or skipping a snapshot", async () => {
    const h = await seedBlob("one");
    let head: string | null = null;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      head = await publish(makeManifest({ parent: head, files: { "a.md": { h } } }), head);
      ids.push(head);
    }
    const newestFirst = [...ids].reverse();

    const first = await page("limit=2");
    expect(first.entries.map((e) => e.id)).toEqual(newestFirst.slice(0, 2));

    // The cursor names a row the client already holds; the server resolves that row's own link
    // rather than taking a start id, so the seam cannot be handed a chain that does not join.
    const second = await page(`limit=2&before=${first.entries[1].id}`);
    expect(second.entries.map((e) => e.id)).toEqual(newestFirst.slice(2, 4));
    expect(second.complete).toBe(true);

    const third = await page(`limit=2&before=${second.entries[1].id}`);
    expect(third.entries.map((e) => e.id)).toEqual(newestFirst.slice(4));
    // Ran out of chain rather than out of limit, and said so by ending with a null link.
    expect(third.entries[0].parent).toBeNull();
    expect(third.complete).toBe(true);
  });

  it("is empty and complete when the cursor is the last snapshot", async () => {
    const h = await seedBlob("one");
    const only = await publish(makeManifest({ files: { "a.md": { h } } }), null);

    // Nothing older exists. That is a finished listing, not a broken one.
    expect(await page(`before=${only}`)).toEqual({ entries: [], complete: true });
  });

  it("reports an incomplete page when the cursor row itself was collected", async () => {
    const h = await seedBlob("one");
    const a = await publish(makeManifest({ files: { "a.md": { h } } }), null);
    const b = await publish(makeManifest({ parent: a, files: { "a.md": { h } } }), a);

    await runInDurableObject(lockStub(), (lock: VaultLock) => {
      (lock as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
        "DELETE FROM manifest_index WHERE id = ?",
        b
      );
    });

    // A sweep can collect a cursor row between two pages. That is not an error and not
    // evidence about history — it is a page the client must not treat as the end, so it says
    // so and the client walks instead.
    expect(await page(`before=${b}`)).toEqual({ entries: [], complete: false });
    expect(a).not.toBe(b);
  });

  it("cuts a cursor page at a splice the client did not opt into", async () => {
    const h = await seedBlob("one");
    const a = await publish(makeManifest({ files: { "a.md": { h } } }), null);
    const b = await publish(makeManifest({ parent: a, files: { "a.md": { h } } }), a);
    const c = await publish(makeManifest({ parent: b, files: { "a.md": { h } } }), b);

    // b's commits were thinned away: c now reaches a directly, and only a client that
    // understands splices may be handed that link.
    await runInDurableObject(lockStub(), (lock: VaultLock) => {
      (lock as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
        "INSERT INTO manifest_splices (survivor_id, splice_parent, spliced) VALUES (?, ?, ?)",
        c,
        a,
        1
      );
    });

    const cut = await page(`limit=5&before=${c}`);
    expect(cut).toEqual({ entries: [], complete: false });

    const followed = await page(`limit=5&before=${c}&splices=1`);
    expect(followed.entries.map((e) => e.id)).toEqual([a]);
    expect(followed.complete).toBe(true);
  });

  it("calls the end of a thinned chain complete, not a hole in the index", async () => {
    const h = await seedBlob("one");
    const a = await publish(makeManifest({ files: { "a.md": { h } } }), null);
    const b = await publish(makeManifest({ parent: a, files: { "a.md": { h } } }), a);

    // What every mature vault looks like: a sweep collected `a`, so the oldest snapshot the
    // vault still keeps names a parent that is gone from the index. There is nothing older to
    // splice onto, so the link is left dangling — `applyGcSplices` drops an open run at the
    // chain's end rather than splicing it onto nothing.
    await runInDurableObject(lockStub(), (lock: VaultLock) => {
      (lock as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
        "DELETE FROM manifest_index WHERE id = ?",
        a
      );
    });

    // Reporting this as incomplete made every client refuse the page and walk the manifests
    // instead, so the index's fast path never engaged on a vault that had ever been swept.
    const body = await page("limit=500&splices=1");
    expect(body.entries.map((e) => e.id)).toEqual([b]);
    expect(body.complete).toBe(true);
    // The link itself is untouched: the client still sees that `b` had a parent.
    expect(body.entries[0].parent).toBe(a);
  });

  it("fails closed when a splice names a snapshot the index does not have", async () => {
    const h = await seedBlob("one");
    const a = await publish(makeManifest({ files: { "a.md": { h } } }), null);
    const b = await publish(makeManifest({ parent: a, files: { "a.md": { h } } }), a);
    const c = await publish(makeManifest({ parent: b, files: { "a.md": { h } } }), b);

    await runInDurableObject(lockStub(), (lock: VaultLock) => {
      const ctx = (lock as unknown as { ctx: DurableObjectState }).ctx;
      ctx.storage.sql.exec(
        "INSERT INTO manifest_splices (survivor_id, splice_parent, spliced) VALUES (?, ?, ?)",
        c, a, 1
      );
      ctx.storage.sql.exec("DELETE FROM manifest_index WHERE id = ?", a);
      expect(b).not.toBe(c);
    });

    // A sweep only ever splices onto a survivor, so a splice into nothing is corruption — not
    // the ordinary dangling `parent` at the end of retained history. It must not be waved
    // through as a complete listing.
    const body = await page("limit=500&splices=1");
    expect(body.complete).toBe(false);
  });

  it("refuses a cursor that is not a manifest id", async () => {
    for (const bad of ["", "abc", "../etc", "01".repeat(40)]) {
      const res = await SELF.fetch(
        `${BASE}/api/history?before=${encodeURIComponent(bad)}`,
        authed(token)
      );
      expect(res.status).toBe(422);
    }
  });

  it("never exposes the encrypted path map", async () => {
    const h = await seedBlob("one");
    await publish(makeManifestV2({ blobs: [h], device: "phone" }), null);

    const text = await (await history()).text();
    // The envelope is public; `enc` is the vault's content and has no business here.
    expect(text).toContain("phone");
    expect(text).not.toContain("enc");
    expect(text).not.toContain("ZmFrZS1jaXBoZXJ0ZXh0");
  });
});

describe("POST /api/history/index", () => {
  /** Blanks the columns, which is exactly what a vault indexed before they existed looks like. */
  async function blankDetail(): Promise<void> {
    await runInDurableObject(lockStub(), (lock: VaultLock) => {
      (lock as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
        "UPDATE manifest_index SET device = NULL, created_at = NULL"
      );
    });
  }

  it("fills in rows indexed before the columns existed", async () => {
    const h = await seedBlob("one");
    const a = await publish(makeManifest({ files: { "a.md": { h } }, device: "laptop" }), null);
    await publish(makeManifest({ parent: a, files: { "a.md": { h } }, device: "phone" }), a);
    await blankDetail();

    // Null is reported honestly rather than guessed at: there is no value that would be true.
    let body = (await (await history()).json()) as { entries: Array<{ device: string | null }> };
    expect(body.entries.map((e) => e.device)).toEqual([null, null]);

    const res = await SELF.fetch(`${BASE}/api/history/index`, authed(ADMIN, { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: true, indexed: 2, cursor: null });

    body = (await (await history()).json()) as { entries: Array<{ device: string | null }> };
    expect(body.entries.map((e) => e.device)).toEqual(["phone", "laptop"]);
  });

  it("resumes where it stopped instead of restarting", async () => {
    const h = await seedBlob("one");
    let head: string | null = null;
    for (let i = 0; i < 3; i++) {
      head = await publish(makeManifest({ parent: head, files: { "a.md": { h } } }), head);
    }
    await blankDetail();

    const first = await SELF.fetch(
      `${BASE}/api/history/index?manifests=1`,
      authed(ADMIN, { method: "POST" })
    );
    expect(await first.json()).toEqual(expect.objectContaining({ done: false, indexed: 1 }));

    // Each call skips the rows already filled, so a killed invocation costs one manifest, not
    // the whole walk.
    const second = await SELF.fetch(
      `${BASE}/api/history/index?manifests=1`,
      authed(ADMIN, { method: "POST" })
    );
    expect(await second.json()).toEqual(expect.objectContaining({ done: false, indexed: 1 }));

    const rest = await SELF.fetch(`${BASE}/api/history/index`, authed(ADMIN, { method: "POST" }));
    expect(await rest.json()).toEqual({ done: true, indexed: 1, cursor: null });

    const body = (await (await history()).json()) as { entries: Array<{ device: string | null }> };
    expect(body.entries.every((e) => e.device !== null)).toBe(true);
  });

  it("throws rather than reporting success when the head manifest is gone", async () => {
    const h = await seedBlob("one");
    const head = await publish(makeManifest({ files: { "a.md": { h } } }), null);
    await blankDetail();
    await env.VAULT.delete(`manifests/${head}.json`);

    // An ancestor can vanish legitimately — a sweep collects trimmed history. The head cannot:
    // it is what the authority points at. Answering `done: true` would record a finished
    // migration over a row that was never resolved, and nothing would ever come back to it.
    const res = await SELF.fetch(`${BASE}/api/history/index`, authed(ADMIN, { method: "POST" }));
    expect(res.status).toBe(500);
  });

  it("stops quietly when an older ancestor was collected", async () => {
    const h = await seedBlob("one");
    const a = await publish(makeManifest({ files: { "a.md": { h } } }), null);
    const b = await publish(makeManifest({ parent: a, files: { "a.md": { h } } }), a);
    await blankDetail();
    await env.VAULT.delete(`manifests/${a}.json`);

    const res = await SELF.fetch(`${BASE}/api/history/index`, authed(ADMIN, { method: "POST" }));
    expect(res.status).toBe(200);
    // The head was still described; the walk simply ended where retention did.
    expect(await res.json()).toEqual({ done: true, indexed: 1, cursor: null });
    const body = (await (await history()).json()) as { entries: Array<{ id: string; device: string | null }> };
    expect(body.entries[0]).toEqual(expect.objectContaining({ id: b, device: "test-token" }));
  });

  it("does nothing on an already-filled index", async () => {
    const h = await seedBlob("one");
    await publish(makeManifest({ files: { "a.md": { h } } }), null);

    const res = await SELF.fetch(`${BASE}/api/history/index`, authed(ADMIN, { method: "POST" }));
    expect(await res.json()).toEqual({ done: true, indexed: 0, cursor: null });
  });

  it("is admin-only, and an access token cannot reach it", async () => {
    // 403, not 401: a sync token is a real credential, it just has no business running a
    // migration. Answering 401 would tell a device its token had stopped working.
    expect(
      (await SELF.fetch(`${BASE}/api/history/index`, authed(token, { method: "POST" }))).status
    ).toBe(403);
  });

  it("refuses a chunk size that is not a usable count", async () => {
    for (const bad of ["0", "1001", "abc"]) {
      const res = await SELF.fetch(
        `${BASE}/api/history/index?manifests=${bad}`,
        authed(ADMIN, { method: "POST" })
      );
      expect(res.status).toBe(422);
    }
  });
});

describe("history detail on new commits", () => {
  it("is recorded by the commit itself, so no backfill is ever needed for it", async () => {
    const h = await seedBlob("one");
    const at = "2026-08-14T10:00:00.000Z";
    await publish(
      makeManifest({ id: ulid(), files: { "a.md": { h } }, device: "desktop", createdAt: at }),
      null
    );

    const body = (await (await history()).json()) as {
      entries: Array<{ device: string | null; createdAt: string | null }>;
    };
    expect(body.entries[0]).toEqual(expect.objectContaining({ device: "desktop", createdAt: at }));
  });
});
