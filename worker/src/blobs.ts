import { HASH_RE } from "./manifest";
import type { Env } from "./index";

export const MAX_BLOB_BYTES = 100 * 1024 * 1024; // Workers request-body limit (free plan)
export const MAX_CHECK_HASHES = 1000;
/** Below this size we buffer + verify before writing (no wrong-key window at all). */
const BUFFER_VERIFY_LIMIT = 32 * 1024 * 1024;
const HEAD_BATCH = 50;
/**
 * Above this many hashes, one prefix listing costs less than a head() per hash. Chosen well
 * under the 820 that exceeded the CPU limit in production, and high enough that an ordinary
 * incremental pass — which asks about the handful of blobs it is actually adding — never
 * walks the bucket.
 */
export const LIST_THRESHOLD = 64;
const LIST_PAGE_LIMIT = 1000;

export type PutBlobResult =
  | { ok: true; existed: boolean }
  | { ok: false; code: "bad_hash" | "hash_mismatch" | "length_required" | "too_large"; message: string };

async function digestHex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function putBlob(env: Env, hash: string, request: Request): Promise<PutBlobResult> {
  if (!HASH_RE.test(hash)) {
    return { ok: false, code: "bad_hash", message: "hash must be lowercase sha256 hex" };
  }
  const key = `blobs/${hash}`;
  if ((await env.VAULT.head(key)) !== null) {
    return { ok: true, existed: true }; // content-addressed: same key ⇒ same bytes
  }

  const lenHeader = request.headers.get("content-length");
  const length = lenHeader === null ? null : Number(lenHeader);
  if (length !== null && length > MAX_BLOB_BYTES) {
    return { ok: false, code: "too_large", message: `blob exceeds ${MAX_BLOB_BYTES} bytes` };
  }

  if (length === null || length <= BUFFER_VERIFY_LIMIT) {
    // Small path: buffer, verify, then write — a mismatched body never touches R2.
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_BLOB_BYTES) {
      return { ok: false, code: "too_large", message: `blob exceeds ${MAX_BLOB_BYTES} bytes` };
    }
    const actual = await digestHex(buf);
    if (actual !== hash) {
      return { ok: false, code: "hash_mismatch", message: `body hashes to ${actual}, not ${hash}` };
    }
    await env.VAULT.put(key, buf);
    return { ok: true, existed: false };
  }

  // Large path: stream to R2 with server-side checksum enforcement — R2 rejects
  // and discards the object atomically if the payload does not hash to `hash`.
  try {
    await env.VAULT.put(key, request.body, { sha256: hash });
  } catch (e) {
    return { ok: false, code: "hash_mismatch", message: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, existed: false };
}

export async function getBlob(env: Env, hash: string): Promise<R2ObjectBody | null> {
  if (!HASH_RE.test(hash)) return null;
  return env.VAULT.get(`blobs/${hash}`);
}

export type CheckResult = { ok: true; missing: string[] } | { ok: false; message: string };

export interface CheckOptions {
  /** Test seam: force the listing path without storing thousands of blobs. */
  listThreshold?: number;
  /** Test seam: force pagination. R2 caps a page at 1000 objects. */
  listPageLimit?: number;
}

/** One head() per requested hash. Cheap only while the request is small. */
async function missingByHead(env: Env, hashes: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (let i = 0; i < hashes.length; i += HEAD_BATCH) {
    const batch = hashes.slice(i, i + HEAD_BATCH);
    const results = await Promise.all(batch.map((h) => env.VAULT.head(`blobs/${h}`)));
    results.forEach((r, j) => {
      if (r === null) missing.push(batch[j]);
    });
  }
  return missing;
}

/** One listing per 1000 *stored* blobs, then a set difference. Cost is independent of how
 *  many hashes were asked about. */
async function missingByListing(env: Env, hashes: string[], limit: number): Promise<string[]> {
  const present = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await env.VAULT.list({ prefix: "blobs/", cursor, limit });
    for (const o of page.objects) present.add(o.key.slice("blobs/".length));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return hashes.filter((h) => !present.has(h));
}

export async function checkBlobs(
  env: Env,
  hashes: unknown,
  opts: CheckOptions = {}
): Promise<CheckResult> {
  if (!Array.isArray(hashes)) return { ok: false, message: "hashes must be an array" };
  if (hashes.length > MAX_CHECK_HASHES)
    return { ok: false, message: `at most ${MAX_CHECK_HASHES} hashes per check` };
  for (const h of hashes) {
    if (typeof h !== "string" || !HASH_RE.test(h))
      return { ok: false, message: `invalid hash: ${String(h).slice(0, 80)}` };
  }
  const unique = [...new Set(hashes as string[])];
  if (unique.length === 0) return { ok: true, missing: [] };

  // Both paths answer identically; they differ only in what they cost, and neither is
  // cheaper everywhere. head() is one binding call per *requested* hash; list() is one per
  // 1000 *stored* blobs. Asking about a whole snapshot the head() way is what exceeded the
  // CPU limit at 820 files. Asking about three hashes the list() way would walk the entire
  // bucket to answer three questions. So: pick by request size. Daily GC keeps the stored
  // set proportional to the vault, which is what keeps the listing path bounded.
  const missing =
    unique.length > (opts.listThreshold ?? LIST_THRESHOLD)
      ? await missingByListing(env, unique, opts.listPageLimit ?? LIST_PAGE_LIMIT)
      : await missingByHead(env, unique);

  // Input order, both paths: the caller uploads in this order and the plugin's reporting is
  // user-facing, so the answer must not depend on storage or completion order.
  return { ok: true, missing };
}
