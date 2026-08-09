import { SELF, env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { BASE, authed, mintToken, putBlob, sha256hex } from "./helpers";

let token: string;

beforeEach(async () => {
  ({ token } = await mintToken("blob-tester"));
});

describe("PUT /api/blobs/:hash", () => {
  it("stores a blob under its verified hash", async () => {
    const content = "hello vault";
    const h = await putBlob(token, content);
    const stored = await env.VAULT.get(`blobs/${h}`);
    expect(stored).not.toBeNull();
    expect(await stored!.text()).toBe(content);
  });

  it("rejects hash mismatch with 422 and stores nothing", async () => {
    const wrongHash = await sha256hex("something else entirely");
    const res = await SELF.fetch(
      `${BASE}/api/blobs/${wrongHash}`,
      authed(token, { method: "PUT", body: "actual content" })
    );
    expect(res.status).toBe(422);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("hash_mismatch");
    expect(await env.VAULT.get(`blobs/${wrongHash}`)).toBeNull();
  });

  it("rejects a malformed hash param with 422", async () => {
    const res = await SELF.fetch(
      `${BASE}/api/blobs/nothex`,
      authed(token, { method: "PUT", body: "x" })
    );
    expect(res.status).toBe(422);
  });

  it("re-uploading an existing blob is an idempotent 200", async () => {
    const content = "idempotent blob";
    const h = await putBlob(token, content);
    const res = await SELF.fetch(
      `${BASE}/api/blobs/${h}`,
      authed(token, { method: "PUT", body: content })
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ existed: boolean }>();
    expect(body.existed).toBe(true);
  });
});

describe("GET /api/blobs/:hash", () => {
  it("round-trips bytes exactly", async () => {
    const content = "byte-exact ✓ content\nline2";
    const h = await putBlob(token, content);
    const res = await SELF.fetch(`${BASE}/api/blobs/${h}`, authed(token));
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(content);
  });

  it("404 on unknown blob", async () => {
    const res = await SELF.fetch(`${BASE}/api/blobs/${"f".repeat(64)}`, authed(token));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/blobs/check", () => {
  it("returns exactly the missing subset", async () => {
    const present = await putBlob(token, "i exist");
    const missing = await sha256hex("i do not exist");
    const res = await SELF.fetch(
      `${BASE}/api/blobs/check`,
      authed(token, {
        method: "POST",
        body: JSON.stringify({ hashes: [present, missing] }),
        headers: { "content-type": "application/json" },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ missing: string[] }>();
    expect(body.missing).toEqual([missing]);
  });

  it("rejects over 1000 hashes with 422", async () => {
    const hashes = Array.from({ length: 1001 }, (_, i) =>
      i.toString(16).padStart(64, "0")
    );
    const res = await SELF.fetch(
      `${BASE}/api/blobs/check`,
      authed(token, {
        method: "POST",
        body: JSON.stringify({ hashes }),
        headers: { "content-type": "application/json" },
      })
    );
    expect(res.status).toBe(422);
  });

  it("rejects malformed hash entries with 422", async () => {
    const res = await SELF.fetch(
      `${BASE}/api/blobs/check`,
      authed(token, {
        method: "POST",
        body: JSON.stringify({ hashes: ["nope"] }),
        headers: { "content-type": "application/json" },
      })
    );
    expect(res.status).toBe(422);
  });
});
