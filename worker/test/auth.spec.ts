import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { ADMIN, BASE, authed, mintToken } from "./helpers";

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
      tokens: { id: string; name: string; createdAt: string }[];
    }>();
    expect(tokens.map((t) => t.name).sort()).toEqual(["old-phone", "vault"]);
    expect(tokens.map((t) => t.id).sort()).toEqual([first.id, second.id].sort());
    // A leaked list must not be usable as credentials.
    for (const entry of tokens) {
      expect(Object.keys(entry).sort()).toEqual(["createdAt", "id", "name"]);
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
