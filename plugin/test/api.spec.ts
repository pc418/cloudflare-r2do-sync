import { describe, it, expect, vi } from "vitest";
import { SyncApi, ApiError, AuthError, StaleHeadError, MissingBlobError } from "../src/api";
import type { HttpClient, HttpRequest } from "../src/api";

function fakeHttp(
  handler: (req: HttpRequest & { url: string }) => { status: number; body?: unknown; bytes?: ArrayBuffer }
): { client: HttpClient; calls: Array<HttpRequest & { url: string }> } {
  const calls: Array<HttpRequest & { url: string }> = [];
  const client: HttpClient = async (url, req) => {
    const call = { url, ...req };
    calls.push(call);
    const res = handler(call);
    const text = res.bytes ? "" : JSON.stringify(res.body ?? null);
    return {
      status: res.status,
      text: async () => text,
      json: async () => JSON.parse(text),
      arrayBuffer: async () => res.bytes ?? new ArrayBuffer(0),
    };
  };
  return { client, calls };
}

const api = (client: HttpClient) =>
  new SyncApi({ baseUrl: "https://vault.example/", token: "dev-token", http: client });

describe("SyncApi", () => {
  it("refuses credential transport over non-loopback HTTP at the API boundary", () => {
    const { client } = fakeHttp(() => ({ status: 200, body: { head: null } }));
    expect(
      () => new SyncApi({ baseUrl: "http://sync.example.com", token: "secret", http: client })
    ).toThrow(/HTTPS/);
    expect(
      () => new SyncApi({ baseUrl: "http://localhost:8787", token: "local", http: client })
    ).not.toThrow();
  });

  it("sends bearer auth and normalizes the base URL", async () => {
    const { client, calls } = fakeHttp(() => ({ status: 200, body: { head: null } }));
    await api(client).getHead();
    expect(calls[0].url).toBe("https://vault.example/api/head");
    expect(calls[0].headers.authorization).toBe("Bearer dev-token");
  });

  it("getHead returns the head id", async () => {
    const { client } = fakeHttp(() => ({ status: 200, body: { head: "01ABC" } }));
    expect(await api(client).getHead()).toBe("01ABC");
  });

  it("checkBlobs posts hashes and returns the missing subset", async () => {
    const { client, calls } = fakeHttp(() => ({ status: 200, body: { missing: ["bb"] } }));
    const missing = await api(client).checkBlobs(["aa", "bb"]);
    expect(missing).toEqual(["bb"]);
    expect(JSON.parse(calls[0].body as string)).toEqual({ hashes: ["aa", "bb"] });
  });

  it("checkBlobs chunks requests above the server limit of 1000", async () => {
    const { client, calls } = fakeHttp(() => ({ status: 200, body: { missing: [] } }));
    const hashes = Array.from({ length: 2500 }, (_, i) => String(i).padStart(64, "0"));
    await api(client).checkBlobs(hashes);
    expect(calls.length).toBe(3);
    expect(JSON.parse(calls[0].body as string).hashes.length).toBe(1000);
    expect(JSON.parse(calls[2].body as string).hashes.length).toBe(500);
  });

  it("putBlob PUTs raw bytes to the hash-keyed route", async () => {
    const { client, calls } = fakeHttp(() => ({ status: 201, body: { existed: false } }));
    const bytes = new TextEncoder().encode("payload");
    await api(client).putBlob("a".repeat(64), bytes);
    expect(calls[0].url).toBe(`https://vault.example/api/blobs/${"a".repeat(64)}`);
    expect(calls[0].method).toBe("PUT");
    expect(new Uint8Array(calls[0].body as ArrayBuffer)).toEqual(bytes);
  });

  it("commit returns the new head on success", async () => {
    const { client } = fakeHttp(() => ({ status: 200, body: { head: "01NEW" } }));
    const head = await api(client).commit({ id: "01NEW" } as never, null);
    expect(head).toBe("01NEW");
  });

  it("maps 409 to StaleHeadError carrying the current head", async () => {
    const { client } = fakeHttp(() => ({
      status: 409,
      body: { error: { code: "stale_head", message: "head moved" }, head: "01OTHER" },
    }));
    await expect(api(client).commit({ id: "x" } as never, null)).rejects.toMatchObject({
      name: "StaleHeadError",
      head: "01OTHER",
    });
  });

  it("keeps non-stale 409 responses as ApiError with their server code", async () => {
    const { client } = fakeHttp(() => ({
      status: 409,
      body: {
        error: { code: "vault_salt_conflict", message: "vault salt is write-once" },
      },
    }));
    const err = await api(client).putSettingsDoc({
      v: 1,
      updatedAt: 1,
      device: "laptop",
      vaultSalt: "AAAAAAAAAAAAAAAAAAAAAA==",
      plain: {},
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(StaleHeadError);
    expect(err).toMatchObject({ status: 409, code: "vault_salt_conflict" });
  });

  it("maps 422 missing_blob to MissingBlobError carrying the hashes", async () => {
    const { client } = fakeHttp(() => ({
      status: 422,
      body: { error: { code: "missing_blob", message: "upload first" }, hashes: ["cc"] },
    }));
    const err = await api(client)
      .commit({ id: "x" } as never, null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(MissingBlobError);
    expect(err.hashes).toEqual(["cc"]);
  });

  it("maps 401 to AuthError", async () => {
    const { client } = fakeHttp(() => ({
      status: 401,
      body: { error: { code: "unauthorized", message: "invalid or revoked token" } },
    }));
    await expect(api(client).getHead()).rejects.toBeInstanceOf(AuthError);
  });

  it("surfaces unexpected statuses as ApiError with the server message", async () => {
    const { client } = fakeHttp(() => ({
      status: 500,
      body: { error: { code: "boom", message: "internal" } },
    }));
    const err = await api(client).getHead().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.message).toContain("internal");
  });

  it("does not swallow non-JSON error bodies", async () => {
    const client: HttpClient = async () => ({
      status: 502,
      text: async () => "<html>bad gateway</html>",
      json: async () => {
        throw new Error("not json");
      },
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    const err = await api(client).getHead().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
  });

  it("getManifest fetches by id", async () => {
    const { client, calls } = fakeHttp(() => ({
      status: 200,
      body: { v: 1, id: "01ABC", parent: null, device: "d", createdAt: "t", files: {} },
    }));
    const m = await api(client).getManifest("01ABC");
    expect(m.id).toBe("01ABC");
    expect(calls[0].url).toBe("https://vault.example/api/manifests/01ABC");
  });

  it("getSettingsDoc returns null on 404 — no doc is a normal state, not an error", async () => {
    const { client } = fakeHttp(() => ({
      status: 404,
      body: { error: { code: "not_found", message: "no shared settings document" } },
    }));
    expect(await api(client).getSettingsDoc()).toBeNull();
  });

  it("getSettingsDoc returns the document and still throws on real failures", async () => {
    const doc = { v: 1, updatedAt: 5, device: "laptop", plain: { protectPercent: 60 } };
    const ok = fakeHttp(() => ({ status: 200, body: doc }));
    expect(await api(ok.client).getSettingsDoc()).toEqual(doc);

    const down = fakeHttp(() => ({ status: 500, body: { error: { code: "boom", message: "x" } } }));
    await expect(api(down.client).getSettingsDoc()).rejects.toBeInstanceOf(ApiError);
  });

  it("putSettingsDoc PUTs the document as JSON", async () => {
    const { client, calls } = fakeHttp(() => ({ status: 200, body: { ok: true } }));
    const doc = { v: 1 as const, updatedAt: 5, device: "laptop", plain: { protectPercent: 60 } };
    await api(client).putSettingsDoc(doc);
    expect(calls[0].url).toBe("https://vault.example/api/settings");
    expect(calls[0].method).toBe("PUT");
    expect(JSON.parse(calls[0].body as string)).toEqual(doc);
  });
});
