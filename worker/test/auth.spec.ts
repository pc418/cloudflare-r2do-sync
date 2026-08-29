import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  ADMIN,
  BASE,
  authed,
  commit,
  makeManifest,
  mintScoped,
  mintToken,
  putBlob,
  sha256hex,
  ulid,
} from "./helpers";
import type { VaultLock } from "../src/vault-lock";

describe("auth", () => {
  it("health endpoint needs no auth", async () => {
    const res = await SELF.fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects missing token on device routes with 401", async () => {
    const res = await SELF.fetch(`${BASE}/api/head`);
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("unauthorized");
  });

  it("rejects garbage token with 401", async () => {
    const res = await SELF.fetch(`${BASE}/api/head`, authed("not-a-real-token"));
    expect(res.status).toBe(401);
  });

  it("rejects an access token on admin routes with 403", async () => {
    const { token } = await mintToken();
    const res = await SELF.fetch(
      `${BASE}/api/tokens`,
      authed(token, {
        method: "POST",
        body: JSON.stringify({ name: "sneaky" }),
        headers: { "content-type": "application/json" },
      })
    );
    expect(res.status).toBe(403);
  });

  it("rejects the admin token on vault routes (it administers, it does not sync)", async () => {
    const res = await SELF.fetch(`${BASE}/api/head`, authed(ADMIN));
    expect(res.status).toBe(401);
  });

  it("mint → use → revoke → 401", async () => {
    const { id, token } = await mintToken("laptop");

    const ok = await SELF.fetch(`${BASE}/api/head`, authed(token));
    expect(ok.status).toBe(200);

    const revoke = await SELF.fetch(`${BASE}/api/tokens/${id}`, authed(ADMIN, { method: "DELETE" }));
    expect(revoke.status).toBe(204);

    const after = await SELF.fetch(`${BASE}/api/head`, authed(token));
    expect(after.status).toBe(401);
  });

  it("lists active tokens without any token material, and drops revoked ones", async () => {
    const first = await mintToken("vault");
    const second = await mintToken("old-phone");

    const listed = await SELF.fetch(`${BASE}/api/tokens`, authed(ADMIN));
    expect(listed.status).toBe(200);
    const { tokens } = await listed.json<{
      tokens: { id: string; name: string; createdAt: string; scopes: string[]; expiresAt: null }[];
    }>();
    expect(tokens.map((t) => t.name).sort()).toEqual(["old-phone", "vault"]);
    expect(tokens.map((t) => t.id).sort()).toEqual([first.id, second.id].sort());
    // A leaked list must not be usable as credentials.
    for (const entry of tokens) {
      expect(Object.keys(entry).sort()).toEqual(["createdAt", "expiresAt", "id", "name", "scopes"]);
      expect(JSON.stringify(entry)).not.toContain(first.token);
      expect(JSON.stringify(entry)).not.toContain(second.token);
    }

    await SELF.fetch(`${BASE}/api/tokens/${second.id}`, authed(ADMIN, { method: "DELETE" }));
    const after = await SELF.fetch(`${BASE}/api/tokens`, authed(ADMIN));
    const remaining = await after.json<{ tokens: { id: string }[] }>();
    expect(remaining.tokens.map((t) => t.id)).toEqual([first.id]);
  });

  it("listing tokens is admin-only", async () => {
    const { token } = await mintToken();
    expect((await SELF.fetch(`${BASE}/api/tokens`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/tokens`, authed(token))).status).toBe(403);
  });

  it("revoking an unknown token returns 404", async () => {
    const res = await SELF.fetch(
      `${BASE}/api/tokens/00000000-0000-4000-8000-000000000000`,
      authed(ADMIN, { method: "DELETE" })
    );
    expect(res.status).toBe(404);
  });

  it("minting requires a non-empty name", async () => {
    const res = await SELF.fetch(
      `${BASE}/api/tokens`,
      authed(ADMIN, {
        method: "POST",
        body: JSON.stringify({ name: "" }),
        headers: { "content-type": "application/json" },
      })
    );
    expect(res.status).toBe(422);
  });
});

describe("token authority", () => {
  // A stolen token used to carry every power the vault has, including the one operation that
  // makes remote content stop existing. Splitting it means an ordinary device can be given a
  // token that syncs and nothing else.
  it("refuses a reroot from a token that was not issued the authority", async () => {
    const res = await SELF.fetch(
      `${BASE}/api/tokens`,
      authed(ADMIN, {
        method: "POST",
        body: JSON.stringify({ name: "sync-only", scopes: ["sync"] }),
        headers: { "content-type": "application/json" },
      })
    );
    expect(res.status).toBe(201);
    const { token } = await res.json<{ token: string }>();

    const h = await putBlob(token, "content");
    const ordinary = await commit(token, makeManifest({ files: { "a.md": { h } } }), null);
    expect(ordinary.status).toBe(200);

    const destructive = await commit(
      token,
      makeManifest({ id: ulid(Date.now() + 1), files: { "a.md": { h } } }),
      null,
      { reroot: true }
    );
    expect(destructive.status).toBe(403);
    expect(await destructive.json()).toMatchObject({ error: { code: "forbidden" } });
  });

  it("a full token still reroots, so existing devices are unaffected", async () => {
    const { token } = await mintToken("full");
    const h = await putBlob(token, "content");
    expect((await commit(token, makeManifest({ files: { "a.md": { h } } }), null)).status).toBe(200);

    const head = await SELF.fetch(`${BASE}/api/head`, authed(token));
    const { head: current } = await head.json<{ head: string }>();
    const res = await commit(token, makeManifest({ id: ulid(Date.now() + 2), files: {} }), current, {
      reroot: true,
    });
    expect(res.status).toBe(200);
  });

  it("an expired token stops working without anyone revoking it", async () => {
    const res = await SELF.fetch(
      `${BASE}/api/tokens`,
      authed(ADMIN, {
        method: "POST",
        body: JSON.stringify({ name: "temporary", expiresAt: new Date(Date.now() - 1000).toISOString() }),
        headers: { "content-type": "application/json" },
      })
    );
    const { token } = await res.json<{ token: string }>();

    const head = await SELF.fetch(`${BASE}/api/head`, authed(token));
    expect(head.status).toBe(401);
  });

  it("a token without the sync scope cannot touch the vault at all", async () => {
    // Minted through the DO directly, because the route now refuses to create one.
    const minted = await runInDurableObject(env.VAULT_LOCK.getByName("default"), (instance: VaultLock) =>
      instance.mintToken("reroot-only", { scopes: ["reroot"] })
    );

    expect((await SELF.fetch(`${BASE}/api/head`, authed(minted.token))).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/api/settings`, authed(minted.token))).status).toBe(403);
    const res = await commit(minted.token, makeManifest({ files: {} }), null);
    expect(res.status).toBe(403);
  });

  it("refuses to mint a token that cannot sync, instead of quietly granting everything", async () => {
    // An empty list used to be upgraded to full authority — the opposite of what it says.
    const mint = async (scopes: unknown) =>
      (
        await SELF.fetch(
          `${BASE}/api/tokens`,
          authed(ADMIN, {
            method: "POST",
            body: JSON.stringify({ name: "x", scopes }),
            headers: { "content-type": "application/json" },
          })
        )
      ).status;
    expect(await mint([])).toBe(422);
    expect(await mint(["reroot"])).toBe(422);
    expect(await mint(["sync"])).toBe(201);
    // `read` is the other way to be useful, so it is the other way to be mintable.
    expect(await mint(["read"])).toBe(201);
    // Reroot destroys history through a route a read-only token cannot reach, so this
    // combination grants nothing. Minting it would advertise an authority that does not exist.
    expect(await mint(["read", "reroot"])).toBe(422);
  });

  it("rejects malformed scope and expiry requests instead of ignoring them", async () => {
    const bad = async (body: unknown) =>
      (
        await SELF.fetch(
          `${BASE}/api/tokens`,
          authed(ADMIN, {
            method: "POST",
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          })
        )
      ).status;
    expect(await bad({ name: "x", scopes: ["admin"] })).toBe(422);
    expect(await bad({ name: "x", scopes: "sync" })).toBe(422);
    expect(await bad({ name: "x", expiresAt: "not-a-date" })).toBe(422);
  });
});

/**
 * A token that reads the vault and cannot change it. It exists so a process holding the
 * master key — the mobile agent Worker — can answer questions about the vault without
 * carrying the authority to write to it: read and write stay separately revocable.
 */
describe("read-only scope", () => {
  const settingsDoc = (device: string) =>
    JSON.stringify({ v: 1, updatedAt: 1_754_000_000_000, device, plain: { protectPercent: 25 } });

  /** A vault with one snapshot, one blob and a settings document, plus a read-only token. */
  async function seeded(): Promise<{ read: string; manifestId: string; hash: string }> {
    const { token: writer } = await mintToken("writer");
    const hash = await putBlob(writer, "note body");
    const manifest = makeManifest({ files: { "a.md": { h: hash } } });
    expect((await commit(writer, manifest, null)).status).toBe(200);
    const wrote = await SELF.fetch(
      `${BASE}/api/settings`,
      authed(writer, {
        method: "PUT",
        body: settingsDoc("writer"),
        headers: { "content-type": "application/json" },
      })
    );
    expect(wrote.status).toBe(200);
    const { token: read } = await mintScoped("agent", ["read"]);
    return { read, manifestId: manifest.id, hash };
  }

  it("reads head, history, manifests, blobs and settings", async () => {
    const { read, manifestId, hash } = await seeded();
    for (const path of [
      "/api/head",
      "/api/history",
      `/api/manifests/${manifestId}`,
      `/api/blobs/${hash}`,
      "/api/settings",
    ]) {
      const res = await SELF.fetch(`${BASE}${path}`, authed(read));
      expect(`${path} → ${res.status}`).toBe(`${path} → 200`);
    }
  });

  it("refuses every route that writes, and says which kind of refusal it is", async () => {
    const { read } = await seeded();
    const attempts: [string, RequestInit][] = [
      [`/api/blobs/${await sha256hex("smuggled")}`, { method: "PUT", body: "smuggled" }],
      [
        "/api/blobs/check",
        {
          method: "POST",
          body: JSON.stringify({ hashes: [] }),
          headers: { "content-type": "application/json" },
        },
      ],
      [
        "/api/settings",
        {
          method: "PUT",
          body: settingsDoc("agent"),
          headers: { "content-type": "application/json" },
        },
      ],
    ];
    for (const [path, init] of attempts) {
      const res = await SELF.fetch(`${BASE}${path}`, authed(read, init));
      expect(`${path} → ${res.status}`).toBe(`${path} → 403`);
      expect(await res.json()).toMatchObject({
        error: { code: "forbidden", message: "this access token may read the vault but not write to it" },
      });
    }

    const committed = await commit(read, makeManifest({ files: {} }), null);
    expect(committed.status).toBe(403);
    // The destructive form is refused as a write, before the reroot scope is ever consulted.
    const destructive = await commit(read, makeManifest({ files: {} }), null, { reroot: true });
    expect(destructive.status).toBe(403);
  });

  it("leaves the vault exactly as it found it when it refuses", async () => {
    const { read, manifestId, hash } = await seeded();
    const headBefore = await (await SELF.fetch(`${BASE}/api/head`, authed(read))).json<{ head: string }>();

    const smuggled = await sha256hex("smuggled");
    await SELF.fetch(`${BASE}/api/blobs/${smuggled}`, authed(read, { method: "PUT", body: "smuggled" }));
    await commit(read, makeManifest({ files: { "b.md": { h: hash } } }), manifestId);
    await SELF.fetch(
      `${BASE}/api/settings`,
      authed(read, {
        method: "PUT",
        body: settingsDoc("agent"),
        headers: { "content-type": "application/json" },
      })
    );

    const headAfter = await (await SELF.fetch(`${BASE}/api/head`, authed(read))).json<{ head: string }>();
    expect(headAfter.head).toBe(headBefore.head);
    expect(await env.VAULT.head(`blobs/${smuggled}`)).toBeNull();
    const settings = await (await SELF.fetch(`${BASE}/api/settings`, authed(read))).json<{
      device: string;
      rev: number;
    }>();
    expect(settings.device).toBe("writer");
    expect(settings.rev).toBe(1);
  });

  it("does not narrow what an ordinary sync token could already do", async () => {
    const { token } = await mintToken("device");
    const hash = await putBlob(token, "still writable");
    expect((await commit(token, makeManifest({ files: { "a.md": { h: hash } } }), null)).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/api/head`, authed(token))).status).toBe(200);
  });

  it("a legacy token stored before `read` existed still reads, because sync implies read", async () => {
    const minted = await runInDurableObject(env.VAULT_LOCK.getByName("default"), (instance: VaultLock) =>
      instance.mintToken("pre-read-scope", { scopes: ["sync", "reroot"] })
    );
    expect(minted.scopes).not.toContain("read");
    expect((await SELF.fetch(`${BASE}/api/head`, authed(minted.token))).status).toBe(200);
    const hash = await putBlob(minted.token, "legacy write");
    expect((await commit(minted.token, makeManifest({ files: { "a.md": { h: hash } } }), null)).status).toBe(200);
  });
});
