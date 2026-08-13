import { sha256Hex } from "../src/hash";
import { blobKey, type Manifest, type ManifestV1, type ManifestV2, type ManifestV3 } from "../src/types";
import type { StateStore, SyncState, VaultAdapter, VaultFile } from "../src/types";
import { MissingBlobError, StaleHeadError } from "../src/api";
import type { SyncApiLike } from "../src/sync";

/** In-memory vault. Paths map to string or binary content. */
export class FakeVault implements VaultAdapter {
  files = new Map<string, { data: Uint8Array; mtime: number }>();
  reads: string[] = [];
  listCalls = 0;
  stats: string[] = [];
  writes: string[] = [];
  removes: string[] = [];
  /** Every engine-driven write gets a fresh mtime, as a real filesystem would. */
  nextMtime = 1_754_000_500_000;

  set(path: string, content: string | Uint8Array, mtime = 1_754_000_000_000): void {
    const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.files.set(path, { data, mtime });
  }

  /** Convenience for assertions: a file's content as text. */
  text(path: string): string {
    const f = this.files.get(path);
    if (!f) throw new Error(`no such file: ${path}`);
    return new TextDecoder().decode(f.data);
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.writes.push(path);
    this.files.set(path, { data: bytes.slice(), mtime: this.nextMtime++ });
  }

  async remove(path: string): Promise<void> {
    if (!this.files.has(path)) throw new Error(`no such file: ${path}`);
    this.removes.push(path);
    this.files.delete(path);
  }

  delete(path: string): void {
    this.files.delete(path);
  }

  rename(from: string, to: string): void {
    const f = this.files.get(from);
    if (!f) throw new Error(`no such file: ${from}`);
    this.files.delete(from);
    this.files.set(to, f);
  }

  async list(): Promise<VaultFile[]> {
    this.listCalls++;
    return [...this.files.entries()].map(([path, f]) => ({
      path,
      size: f.data.byteLength,
      mtime: f.mtime,
    }));
  }

  async stat(path: string): Promise<VaultFile | null> {
    this.stats.push(path);
    const file = this.files.get(path);
    return file === undefined
      ? null
      : { path, size: file.data.byteLength, mtime: file.mtime };
  }

  /**
   * Called after each read is recorded and before its bytes are returned, so a test can change
   * a file underneath a pass. The count is how many times this path has been read.
   */
  beforeRead: ((path: string, count: number) => void) | null = null;

  async read(path: string): Promise<Uint8Array> {
    const f = this.files.get(path);
    if (!f) throw new Error(`no such file: ${path}`);
    this.reads.push(path);
    if (this.beforeRead) {
      this.beforeRead(path, this.reads.filter((p) => p === path).length);
      const after = this.files.get(path);
      if (!after) throw new Error(`beforeRead removed ${path}`);
      return after.data;
    }
    return f.data;
  }
}

/** In-memory stand-in for the Worker, enforcing the same commit invariants. */
export class FakeServer implements SyncApiLike {
  blobs = new Map<string, Uint8Array>();
  manifests = new Map<string, Manifest>();
  head: string | null = null;
  uploads: string[] = [];
  downloads: string[] = [];
  failNextCommitWith: Error | null = null;
  /** Manifest ids committed as a new root, so a test can prove history was discarded. */
  readonly reroots: string[] = [];
  /** Queue of errors for consecutive commits, so a test can lose the head race twice. */
  failCommitsWith: Error[] = [];

  async getHead(): Promise<string | null> {
    return this.head;
  }

  async getManifest(id: string): Promise<Manifest> {
    const m = this.manifests.get(id);
    if (!m) throw new Error(`unknown manifest ${id}`);
    return m;
  }

  /**
   * What each pass asked about, so a test can assert the *size* of the question and not
   * only the answer. Asking about every blob in the vault once per pass is what exceeded
   * the Worker's CPU limit in production.
   */
  readonly checked: string[][] = [];

  async checkBlobs(hashes: string[]): Promise<string[]> {
    this.checked.push([...hashes]);
    return [...new Set(hashes)].filter((h) => !this.blobs.has(h));
  }

  async putBlob(hash: string, bytes: Uint8Array): Promise<void> {
    const actual = await sha256Hex(bytes);
    if (actual !== hash) throw new Error(`hash mismatch: ${actual} !== ${hash}`);
    this.uploads.push(hash);
    this.blobs.set(hash, bytes.slice());
  }

  async getBlob(hash: string): Promise<Uint8Array> {
    const bytes = this.blobs.get(hash);
    if (!bytes) throw new Error(`unknown blob ${hash}`);
    this.downloads.push(hash);
    return bytes;
  }

  async commit(
    manifest: Manifest,
    expectedHead: string | null,
    opts: { reroot?: boolean } = {}
  ): Promise<string> {
    const queued = this.failCommitsWith.shift();
    if (queued) throw queued;
    if (this.failNextCommitWith) {
      const err = this.failNextCommitWith;
      this.failNextCommitWith = null;
      throw err;
    }
    if (this.head !== expectedHead) throw new StaleHeadError("head moved", this.head);
    // The Worker's rule, enforced here so the engine cannot pass a shape the real server
    // rejects: only an explicit reroot may commit a manifest that is not the head's child,
    // and only by being a root.
    const rerooting = opts.reroot === true && manifest.parent === null;
    if (!rerooting && manifest.parent !== expectedHead) {
      throw new Error("manifest.parent must equal expectedHead");
    }
    if (rerooting) this.reroots.push(manifest.id);
    const refs = manifest.v === 1 ? Object.values(manifest.files).map(blobKey) : manifest.blobs;
    const missing = refs.filter((h) => !this.blobs.has(h));
    if (missing.length > 0) throw new MissingBlobError("missing blobs", [...new Set(missing)]);
    this.manifests.set(manifest.id, manifest);
    this.head = manifest.id;
    return manifest.id;
  }

  #nextId(): string {
    return `01OTHER${String(this.manifests.size).padStart(19, "0")}`;
  }

  /** Simulate another device committing a plaintext snapshot. */
  async seedRemoteCommit(files: Record<string, string>): Promise<string> {
    const entries: ManifestV1["files"] = Object.create(null) as ManifestV1["files"];
    for (const [path, content] of Object.entries(files)) {
      const bytes = new TextEncoder().encode(content);
      const h = await sha256Hex(bytes);
      this.blobs.set(h, bytes);
      entries[path] = { h, size: bytes.byteLength, mtime: 1_754_000_000_000 };
    }
    const id = this.#nextId();
    const m: ManifestV1 = {
      v: 1,
      id,
      parent: this.head,
      device: "other-device",
      createdAt: "2026-08-03T00:00:00Z",
      files: entries,
    };
    this.manifests.set(id, m);
    this.head = id;
    return id;
  }

  /** Simulate another device committing an encrypted snapshot. */
  seedRemoteEncryptedCommit(opts: { keyId: string; blobs?: string[]; v?: 2 | 3 }): string {
    const blobs = opts.blobs ?? ["c".repeat(64)];
    for (const b of blobs) this.blobs.set(b, new Uint8Array());
    const id = this.#nextId();
    const m: ManifestV2 | ManifestV3 = {
      v: opts.v ?? 2,
      id,
      parent: this.head,
      device: "other-device",
      createdAt: "2026-08-03T00:00:00Z",
      keyId: opts.keyId,
      blobs,
      enc: { alg: "AES-GCM", iv: "AAAAAAAAAAAAAAAA", data: "ZmFrZQ==" },
    };
    this.manifests.set(id, m);
    this.head = id;
    return id;
  }
}

export class FakeStore implements StateStore {
  state: SyncState | null = null;
  saves = 0;

  async load(): Promise<SyncState | null> {
    return this.state;
  }

  async save(s: SyncState): Promise<void> {
    this.saves++;
    this.state = structuredClone(s);
  }
}
