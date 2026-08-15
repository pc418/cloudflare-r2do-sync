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

    // A vault whose older history predates the index: the row is simply not there. Reporting
    // `complete: true` would tell the client the vault has one snapshot, which is a lie about
    // the user's own history — the same mistake as reading a 5xx as a 404.
    await runInDurableObject(lockStub(), (lock: VaultLock) => {
      (lock as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
        "DELETE FROM manifest_index WHERE id = ?",
        a
      );
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
