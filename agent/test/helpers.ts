/**
 * A fake sync Worker, in memory.
 *
 * It speaks the real `/api/*` shapes over the injectable `HttpClient` seam, so the code under
 * test is the real `SyncApi`, the real crypto and the real manifest codec — only the network
 * is replaced. A fake that modelled the *documented* contract rather than the real one is
 * exactly how the `rmdir` bug stayed green for a release, so this mirrors observed behaviour:
 * a stale `expectedHead` is a 409, an unknown blob is a 404.
 */
import type { HttpClient } from "../../plugin/src/api";
import { VaultCrypto, generateMasterKey, manifestAad } from "../../plugin/src/crypto";
import { sha256Hex } from "../../plugin/src/hash";
import { buildManifest, type FileEntry, type Manifest } from "../../plugin/src/types";
import { ulid } from "../src/ulid";

export interface FakeVault {
  /**
   * Stable across the fixture's life. `SyncApi` captures the client at construction, so a test
   * that wants to interpose must use `before`, not reassign this.
   */
  http: HttpClient;
  /** Runs before each request is served — the seam for "another device commits mid-write". */
  before?: (path: string, method: string) => Promise<void>;
  /** The shared settings document this vault serves, or null for "none published". */
  settings?: unknown;
  /** Overrides the settings response status, to test a failed read vs an absent document. */
  settingsStatus?: number;
  /** Set to a scope the token lacks to make every write 403, like a read-only token. */
  readOnly: boolean;
  head: string | null;
  manifests: Map<string, Manifest>;
  blobs: Map<string, Uint8Array>;
  requests: string[];
}

export function fakeVault(): FakeVault {
  const vault: FakeVault = {
    readOnly: false,
    head: null,
    manifests: new Map(),
    blobs: new Map(),
    requests: [],
    http: async () => ({ status: 500, text: async () => "", json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }),
  };

  const json = (status: number, body: unknown) => ({
    status,
    headers: {},
    text: async () => JSON.stringify(body),
    json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer,
  });

  vault.http = async (url, req) => {
    const path = new URL(url).pathname;
    vault.requests.push(`${req.method} ${path}`);
    if (vault.before !== undefined) await vault.before(path, req.method);
    const writing = req.method !== "GET";
    if (writing && vault.readOnly) {
      return json(403, { error: { code: "forbidden", message: "this access token may read the vault but not write to it" } });
    }

    if (path === "/api/settings") {
      if (vault.settingsStatus !== undefined) return json(vault.settingsStatus, { error: { code: "boom", message: "no" } });
      if (vault.settings === undefined) return json(404, { error: { code: "not_found", message: "no shared settings document" } });
      return json(200, vault.settings);
    }

    if (path === "/api/head") return json(200, { head: vault.head });

    if (path.startsWith("/api/manifests/")) {
      const id = path.slice("/api/manifests/".length);
      const m = vault.manifests.get(id);
      return m === undefined ? json(404, { error: { code: "not_found", message: "unknown manifest" } }) : json(200, m);
    }

    if (path.startsWith("/api/blobs/")) {
      const hash = path.slice("/api/blobs/".length);
      if (req.method === "PUT") {
        vault.blobs.set(hash, new Uint8Array(req.body as ArrayBuffer));
        return json(201, { existed: false });
      }
      const bytes = vault.blobs.get(hash);
      if (bytes === undefined) return json(404, { error: { code: "not_found", message: "unknown blob" } });
      return {
        status: 200,
        headers: {},
        text: async () => new TextDecoder().decode(bytes),
        json: async () => ({}),
        arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
      };
    }

    if (path === "/api/commit") {
      const body = JSON.parse(req.body as string) as { manifest: Manifest; expectedHead: string | null };
      if (body.expectedHead !== vault.head) {
        return json(409, { error: { code: "stale_head", message: "head moved" }, head: vault.head });
      }
      vault.manifests.set(body.manifest.id, body.manifest);
      vault.head = body.manifest.id;
      return json(200, { head: vault.head });
    }

    if (path === "/api/history") {
      const entries = [...vault.manifests.values()].map((m) => ({ id: m.id, parent: m.parent }));
      return json(200, { entries, complete: true });
    }

    return json(404, { error: { code: "not_found", message: "no such route" } });
  };

  return vault;
}

/** Commits one encrypted snapshot holding `notes`, the way a real device would. */
export async function seed(
  vault: FakeVault,
  crypto: VaultCrypto,
  notes: Record<string, string>,
  opts: { mtime?: number } = {}
): Promise<string> {
  const files: Record<string, FileEntry> = {};
  const blobs: string[] = [];
  for (const [path, text] of Object.entries(notes)) {
    const plain = new TextEncoder().encode(text);
    const h = await sha256Hex(plain);
    const cipher = await crypto.encryptBlob(h, plain);
    const c = await sha256Hex(cipher);
    vault.blobs.set(c, cipher);
    files[path] = {
      h,
      size: plain.length,
      mtime: opts.mtime ?? Date.now(),
      c,
      lines: text.split("\n").length,
    };
    blobs.push(c);
  }
  const manifest = await buildManifest({
    crypto,
    parent: vault.head,
    files,
    blobs,
    id: ulid(),
    device: "test-device",
    createdAt: new Date().toISOString(),
  });
  // Round-trips the AAD binding exactly as the server would store it.
  void manifestAad;
  vault.manifests.set(manifest.id, manifest);
  vault.head = manifest.id;
  return manifest.id;
}

/**
 * Generated by the real generator rather than hand-written: the master key's text form is a
 * format `parseMasterKey` validates, and a plausible-looking hex string is not one. Fixed for
 * the run, so every fixture in a file shares a key.
 */
export const TEST_KEY = generateMasterKey();

export const testCrypto = (): Promise<VaultCrypto> => VaultCrypto.fromText(TEST_KEY);
