import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { ADMIN, BASE, authed, commit, makeManifest, mintToken, putBlob, ulid } from "./helpers";
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
