import { describe, it, expect } from "vitest";
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

  describe("fetched manifests are validated, not cast", () => {
    const good = {
      v: 1,
      id: "01ABC",
      parent: null,
      device: "laptop",
      createdAt: "2026-08-11T00:00:00.000Z",
      files: { "a.md": { h: "a".repeat(64), size: 1, mtime: 2 } },
    };

    it("refuses a snapshot that is not the one that was asked for", async () => {
      // The id is the only thing tying the answer to the request; without the check a
      // server can serve an older snapshot for any id and the client plans it as current.
      const { client } = fakeHttp(() => ({ status: 200, body: { ...good, id: "01OTHER" } }));
      await expect(api(client).getManifest("01ABC")).rejects.toThrow(/01OTHER.*01ABC/);
    });

    it("refuses malformed documents before anything can plan writes from them", async () => {
      for (const body of [
        null,
        { ...good, id: undefined },
        { ...good, createdAt: undefined },
        { ...good, parent: 7 },
        { ...good, files: { "a.md": { h: "x", size: "big", mtime: 2 } } },
        { ...good, v: 9 },
        { v: 3, id: "01ABC", parent: null, device: "d", createdAt: "x", keyId: "k", blobs: ["nope"], enc: {} },
      ]) {
        const { client } = fakeHttp(() => ({ status: 200, body }));
        await expect(api(client).getManifest("01ABC")).rejects.toThrow(/invalid manifest/);
      }
    });

    it("accepts both encrypted versions", async () => {
      const enc = { alg: "AES-GCM", iv: "AAAAAAAAAAAAAAAA", data: "ZmFrZQ==" };
      for (const v of [2, 3]) {
        const body = {
          v,
          id: "01ABC",
          parent: null,
          device: "laptop",
          createdAt: "2026-08-11T00:00:00.000Z",
          keyId: "0011223344556677",
          blobs: ["b".repeat(64)],
          enc,
        };
        const { client } = fakeHttp(() => ({ status: 200, body }));
        expect((await api(client).getManifest("01ABC")).v).toBe(v);
      }
    });
  });

  describe("gc_busy", () => {
    const busy = { status: 503, body: { error: { code: "gc_busy", message: "gc is running" } } };
    const manifest = { v: 1 as const, id: "01ABC", parent: null, device: "d", createdAt: "", files: {} };
    const retrying = (client: HttpClient, slept: number[]) =>
      new SyncApi({
        baseUrl: "https://vault.example/",
        token: "dev-token",
        http: client,
        sleep: async (ms) => {
          slept.push(ms);
        },
      });

    it("retries the identical body until the sweep finishes", async () => {
      let n = 0;
      const slept: number[] = [];
      const { client, calls } = fakeHttp(() =>
        ++n < 3 ? busy : { status: 200, body: { head: "01ABC" } }
      );
      expect(await retrying(client, slept).commit(manifest, null)).toBe("01ABC");
      expect(calls).toHaveLength(3);
      // Rebuilding the snapshot would be wasted work: nothing about it was rejected.
      expect(new Set(calls.map((c) => c.body as string)).size).toBe(1);
      expect(slept).toEqual([2000, 2000]);
    });

    it("gives up loudly rather than waiting out an unbounded sweep", async () => {
      const slept: number[] = [];
      const { client, calls } = fakeHttp(() => busy);
      await expect(retrying(client, slept).commit(manifest, null)).rejects.toMatchObject({
        code: "gc_busy",
      });
      expect(calls).toHaveLength(4);
    });

    it("does not retry a duplicate id — that is history, not congestion", async () => {
      const { client, calls } = fakeHttp(() => ({
        status: 409,
        body: { error: { code: "duplicate_manifest_id", message: "id already used" } },
      }));
      await expect(api(client).commit(manifest, null)).rejects.toMatchObject({
        code: "duplicate_manifest_id",
        status: 409,
      });
      expect(calls).toHaveLength(1);
    });
  });
});
