import { SELF } from "cloudflare:test";
import type { Manifest, ManifestV1, ManifestV2 } from "../src/manifest";

export const ADMIN = "test-admin-token";
export const BASE = "http://vault.test";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Deterministic-enough ULID for tests; time-ordered by `t`. */
export function ulid(t = Date.now()): string {
  let time = "";
  let ms = t;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[ms % 32] + time;
    ms = Math.floor(ms / 32);
  }
  const rand = new Uint8Array(16);
  crypto.getRandomValues(rand);
  let tail = "";
  for (let i = 0; i < 16; i++) tail += CROCKFORD[rand[i] % 32];
  return time + tail;
}

export async function sha256hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function authed(token: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  };
}

/** Mint a fresh access token through the real admin API. */
export async function mintToken(name = "test-token"): Promise<{ id: string; token: string }> {
  const res = await SELF.fetch(
    `${BASE}/api/tokens`,
    authed(ADMIN, {
      method: "POST",
      body: JSON.stringify({ name }),
      headers: { "content-type": "application/json" },
    })
  );
  if (res.status !== 201) throw new Error(`mintToken failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Upload a blob for `content`, returning its hash. */
export async function putBlob(token: string, content: string): Promise<string> {
  const h = await sha256hex(content);
  const res = await SELF.fetch(
    `${BASE}/api/blobs/${h}`,
    authed(token, { method: "PUT", body: content })
  );
  if (res.status !== 200 && res.status !== 201)
    throw new Error(`putBlob failed: ${res.status} ${await res.text()}`);
  return h;
}

export function makeManifest(opts: {
  id?: string;
  parent?: string | null;
  files: Record<string, { h: string; size?: number; mtime?: number }>;
  device?: string;
  createdAt?: string;
}): ManifestV1 {
  const files = Object.create(null) as ManifestV1["files"];
  for (const [p, f] of Object.entries(opts.files)) {
    files[p] = { h: f.h, size: f.size ?? 1, mtime: f.mtime ?? 1_754_000_000_000 };
  }
  return {
    v: 1,
    id: opts.id ?? ulid(),
    parent: opts.parent ?? null,
    device: opts.device ?? "test-token",
    createdAt: opts.createdAt ?? new Date().toISOString(),
    files,
  };
}

/** An encrypted (v2) snapshot. `enc` is opaque to the server, so tests use a placeholder. */
export function makeManifestV2(opts: {
  id?: string;
  parent?: string | null;
  blobs: string[];
  device?: string;
  createdAt?: string;
  keyId?: string;
  enc?: ManifestV2["enc"];
}): ManifestV2 {
  return {
    v: 2,
    id: opts.id ?? ulid(),
    parent: opts.parent ?? null,
    device: opts.device ?? "test-token",
    createdAt: opts.createdAt ?? new Date().toISOString(),
    keyId: opts.keyId ?? "00112233445566aa",
    blobs: opts.blobs,
    enc: opts.enc ?? { alg: "AES-GCM", iv: "AAAAAAAAAAAAAAAA", data: "ZmFrZS1jaXBoZXJ0ZXh0" },
  };
}

export async function commit(
  token: string,
  manifest: Manifest,
  expectedHead: string | null
): Promise<Response> {
  return SELF.fetch(
    `${BASE}/api/commit`,
    authed(token, {
      method: "POST",
      body: JSON.stringify({ manifest, expectedHead }),
      headers: { "content-type": "application/json" },
    })
  );
}
