import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { ADMIN, BASE, authed, mintToken } from "./helpers";
import { MAX_SETTINGS_BYTES } from "../src/settings";

const URL = `${BASE}/api/settings`;
const VAULT_SALT = "AAECAwQFBgcICQoLDA0ODw==";
const OTHER_VAULT_SALT = "EBESExQVFhcYGRobHB0eHw==";

function plainDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    updatedAt: 1_754_000_000_000,
    device: "laptop",
    plain: { protectPercent: 50, excludes: ".obsidian/**" },
    ...overrides,
  };
}

function encDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 2,
    updatedAt: 1_754_000_000_000,
    device: "laptop",
    keyId: "00112233445566aa",
    enc: { alg: "AES-GCM", iv: "AAAAAAAAAAAAAAAA", data: "ZmFrZS1jaXBoZXJ0ZXh0" },
    ...overrides,
  };
}

async function put(token: string, body: unknown): Promise<Response> {
  return SELF.fetch(
    URL,
    authed(token, {
      method: "PUT",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  );
}

describe("shared settings document", () => {
  it("requires an access token on both verbs", async () => {
    expect((await SELF.fetch(URL)).status).toBe(401);
    expect((await SELF.fetch(URL, { method: "PUT", body: "{}" })).status).toBe(401);
    // The admin token administers tokens; it must not read or write vault data.
    expect((await SELF.fetch(URL, authed(ADMIN))).status).toBe(401);
  });

  it("404s before any document has been written", async () => {
    const { token } = await mintToken();
    const res = await SELF.fetch(URL, authed(token));
    expect(res.status).toBe(404);
  });

  it("round-trips a plaintext (v1) document", async () => {
    const { token } = await mintToken();
    const doc = plainDoc();
    expect((await put(token, doc)).status).toBe(200);
    const res = await SELF.fetch(URL, authed(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(doc);
  });

  it("round-trips an encrypted (v2) document", async () => {
    const { token } = await mintToken();
    const doc = encDoc();
    expect((await put(token, doc)).status).toBe(200);
    const res = await SELF.fetch(URL, authed(token));
    expect(await res.json()).toEqual(doc);
  });

  it("accepts a public vault salt on both document versions", async () => {
    const { token } = await mintToken();
    const v1 = plainDoc({ vaultSalt: VAULT_SALT });
    expect((await put(token, v1)).status).toBe(200);
    expect(await (await SELF.fetch(URL, authed(token))).json()).toEqual(v1);

    const v2 = encDoc({ updatedAt: 1_754_000_000_001, vaultSalt: VAULT_SALT });
    expect((await put(token, v2)).status).toBe(200);
    expect(await (await SELF.fetch(URL, authed(token))).json()).toEqual(v2);
  });

  it("establishes a vault salt once and preserves it when later writes omit it", async () => {
    const { token } = await mintToken();
    expect((await put(token, plainDoc({ vaultSalt: VAULT_SALT }))).status).toBe(200);

    const replacement = encDoc({ updatedAt: 1_754_000_000_002, device: "phone" });
    expect((await put(token, replacement)).status).toBe(200);
    expect(await (await SELF.fetch(URL, authed(token))).json()).toEqual({
      ...replacement,
      vaultSalt: VAULT_SALT,
    });
  });

  it("allows a valid vault salt to be established after saltless settings", async () => {
    const { token } = await mintToken();
    expect((await put(token, plainDoc())).status).toBe(200);

    const replacement = plainDoc({ updatedAt: 2, device: "phone", vaultSalt: VAULT_SALT });
    expect((await put(token, replacement)).status).toBe(200);
    expect(await (await SELF.fetch(URL, authed(token))).json()).toEqual(replacement);
  });

  it("rejects replacing an established vault salt without changing the document", async () => {
    const { token } = await mintToken();
    const original = plainDoc({ updatedAt: 7, vaultSalt: VAULT_SALT });
    expect((await put(token, original)).status).toBe(200);

    const res = await put(token, encDoc({ updatedAt: 8, vaultSalt: OTHER_VAULT_SALT }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "vault_salt_conflict",
        message: "vaultSalt is already established and cannot be changed",
      },
    });
    expect(await (await SELF.fetch(URL, authed(token))).json()).toEqual(original);
  });

  it("allows only one salt to win concurrent first writes", async () => {
    const { token } = await mintToken();
    const [first, second] = await Promise.all([
      put(token, plainDoc({ device: "laptop", vaultSalt: VAULT_SALT })),
      put(token, plainDoc({ device: "phone", vaultSalt: OTHER_VAULT_SALT })),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const stored = await (await SELF.fetch(URL, authed(token))).json() as { vaultSalt: string };
    expect([VAULT_SALT, OTHER_VAULT_SALT]).toContain(stored.vaultSalt);
  });

  it("last writer wins", async () => {
    const { token } = await mintToken();
    await put(token, plainDoc({ updatedAt: 1 }));
    await put(token, plainDoc({ updatedAt: 2, device: "phone" }));
    const res = await SELF.fetch(URL, authed(token));
    expect(await res.json()).toMatchObject({ updatedAt: 2, device: "phone" });
  });

  it("rejects malformed documents loudly", async () => {
    const { token } = await mintToken();
    expect((await put(token, "not json")).status).toBe(400);
    // missing device
    expect((await put(token, { v: 1, updatedAt: 1, plain: {} })).status).toBe(422);
    // v2 without keyId — a device could not tell whose key wrote it
    expect((await put(token, encDoc({ keyId: undefined }))).status).toBe(422);
    // unknown fields are a client bug, not a forward-compat channel
    expect((await put(token, plainDoc({ extra: true }))).status).toBe(422);
    // mixed shape: enc payload on a v1 doc
    expect((await put(token, plainDoc({ enc: encDoc().enc }))).status).toBe(422);
    // vaultSalt is canonical base64 representing 16-64 bytes
    for (const vaultSalt of [
      "dG9vLXNob3J0",
      "AAECAwQFBgcICQoLDA0ODw",
      "AB==",
      `${"AA".repeat(65)}==`,
    ]) {
      const res = await put(token, plainDoc({ vaultSalt }));
      expect(res.status).toBe(422);
      expect((await res.json() as { error: { code: string } }).error.code).toBe("invalid_settings");
    }
  });

  it("caps the document size", async () => {
    const { token } = await mintToken();
    const res = await put(token, plainDoc({ plain: { pad: "x".repeat(MAX_SETTINGS_BYTES) } }));
    expect(res.status).toBe(413);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("too_large");
  });

  it("a rejected write leaves the previous document in place", async () => {
    const { token } = await mintToken();
    await put(token, plainDoc({ updatedAt: 7 }));
    await put(token, { v: 1, updatedAt: 8 }); // invalid
    const res = await SELF.fetch(URL, authed(token));
    expect(await res.json()).toMatchObject({ updatedAt: 7 });
  });
});
