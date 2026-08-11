import { SELF, env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { BASE, authed, mintToken, putBlob, sha256hex } from "./helpers";
import { checkBlobs, LIST_THRESHOLD } from "../src/blobs";
import type { Env } from "../src/index";

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

  it("answers a request past the listing threshold over HTTP", async () => {
    const present = await putBlob(token, "present among many");
    const absent = Array.from({ length: LIST_THRESHOLD }, (_, i) => hexHash(1000 + i));
    const res = await SELF.fetch(
      `${BASE}/api/blobs/check`,
      authed(token, {
        method: "POST",
        body: JSON.stringify({ hashes: [present, ...absent] }),
        headers: { "content-type": "application/json" },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ missing: string[] }>();
    expect(body.missing).toEqual(absent);
  });
});

const hexHash = (n: number): string => n.toString(16).padStart(64, "0");

/**
 * A bucket stand-in that counts binding calls.
 *
 * What broke the vault on 2026-08-10 was not a wrong answer but a wrong *cost*: one check
 * of an 820-blob snapshot made 820 `head()` calls and exceeded the Worker CPU limit, which
 * the edge reports as `error code: 1102` and the plugin can only log verbatim. CPU time is
 * not observable from inside a test, so call counts stand in for it.
 */
function countingBucket(presentHashes: string[]): { env: Env; calls: { head: number; list: number } } {
  const keys = presentHashes.map((h) => `blobs/${h}`).sort();
  const calls = { head: 0, list: 0 };
  const VAULT = {
    head(key: string): Promise<R2Object | null> {
      calls.head++;
      return Promise.resolve(keys.includes(key) ? ({ key } as unknown as R2Object) : null);
    },
    list(options: R2ListOptions): Promise<R2Objects> {
      calls.list++;
      const matching = keys.filter((k) => k.startsWith(options.prefix ?? ""));
      const start = options.cursor === undefined ? 0 : Number(options.cursor);
      const page = matching.slice(start, start + (options.limit ?? 1000));
      const end = start + page.length;
      const truncated = end < matching.length;
      return Promise.resolve({
        objects: page.map((key) => ({ key }) as unknown as R2Object),
        truncated,
        cursor: truncated ? String(end) : undefined,
        delimitedPrefixes: [],
      } as unknown as R2Objects);
    },
  };
  return { env: { VAULT } as unknown as Env, calls };
}

function expectMissing(result: Awaited<ReturnType<typeof checkBlobs>>): string[] {
  if (!result.ok) throw new Error(`check failed: ${result.message}`);
  return result.missing;
}

describe("checkBlobs cost", () => {
  it("answers a large check with one listing instead of one head per hash", async () => {
    const asked = Array.from({ length: 200 }, (_, i) => hexHash(i));
    const { env: fake, calls } = countingBucket(asked.slice(0, 150));
    expect(expectMissing(await checkBlobs(fake, asked))).toEqual(asked.slice(150));
    expect(calls.head).toBe(0);
    expect(calls.list).toBe(1);
  });

  it("keeps head() for a handful of hashes, where listing the bucket would cost more", async () => {
    const asked = [hexHash(1), hexHash(2), hexHash(3)];
    const { env: fake, calls } = countingBucket([hexHash(2)]);
    expect(expectMissing(await checkBlobs(fake, asked))).toEqual([hexHash(1), hexHash(3)]);
    expect(calls.list).toBe(0);
    expect(calls.head).toBe(3);
  });

  it("pages through a bucket holding more blobs than one listing page", async () => {
    const stored = Array.from({ length: 5 }, (_, i) => hexHash(i));
    const { env: fake, calls } = countingBucket(stored);
    const asked = [...stored, hexHash(99)];
    const missing = expectMissing(
      await checkBlobs(fake, asked, { listThreshold: 0, listPageLimit: 2 })
    );
    expect(missing).toEqual([hexHash(99)]);
    expect(calls.list).toBe(3);
  });

  it("returns missing hashes in request order, not storage order", async () => {
    const asked = Array.from({ length: 100 }, (_, i) => hexHash(100 - i));
    const { env: fake } = countingBucket([hexHash(50)]);
    expect(expectMissing(await checkBlobs(fake, asked))).toEqual(
      asked.filter((h) => h !== hexHash(50))
    );
  });

  it("collapses duplicates before asking the bucket anything", async () => {
    const asked = [hexHash(7), hexHash(7), hexHash(7)];
    const { env: fake, calls } = countingBucket([]);
    expect(expectMissing(await checkBlobs(fake, asked))).toEqual([hexHash(7)]);
    expect(calls.head).toBe(1);
  });

  it("touches R2 not at all when asked about nothing", async () => {
    const { env: fake, calls } = countingBucket([]);
    expect(expectMissing(await checkBlobs(fake, []))).toEqual([]);
    expect(calls).toEqual({ head: 0, list: 0 });
  });
});
