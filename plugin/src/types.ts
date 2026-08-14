import type { EncPayload } from "./crypto";

export interface FileEntry {
  /** sha256 of the file's plaintext. */
  h: string;
  size: number;
  mtime: number;
  /** sha256 of the ciphertext — the R2 blob key. Present iff the vault is encrypted. */
  c?: string;
  /**
   * Lines the file's text held when this snapshot was committed. Absent for binary content,
   * and for every snapshot written before this field existed.
   *
   * Recorded in the snapshot — not only in the device-local cache `lines.ts` keeps — so the
   * history browser can say what a snapshot changed without downloading both versions of
   * every file. In an encrypted vault it lives inside the encrypted path map, so the server
   * never sees it. The figure is per-file and absolute; a *delta* built from two snapshots is
   * net, with the caveat `lines.ts` spells out: replacing five lines with five others is zero.
   */
  lines?: number;
}

/** The R2 key a file's bytes are stored under, encrypted or not. */
export function blobKey(entry: FileEntry): string {
  return entry.c ?? entry.h;
}

/** Plaintext snapshot: the server can read every path and content hash. */
export interface ManifestV1 {
  v: 1;
  id: string;
  parent: string | null;
  device: string;
  createdAt: string;
  files: Record<string, FileEntry>;
}

/** Encrypted snapshot: the server sees only blob keys and an opaque path map. */
export interface ManifestV2 {
  v: 2;
  id: string;
  parent: string | null;
  device: string;
  createdAt: string;
  keyId: string;
  blobs: string[];
  enc: EncPayload;
}

/**
 * Identical on the wire to v2, but `enc` additionally authenticates the envelope around it
 * (see `manifestAad`). v2 left `id`, `parent`, `device`, `createdAt`, `keyId` and `blobs`
 * unauthenticated, so anyone holding an access token could move a valid encrypted path map
 * under a header of their choosing. Reading v2 stays supported forever — existing history is
 * v2 — so the protection is prospective: it covers every snapshot written from now on.
 */
export interface ManifestV3 extends Omit<ManifestV2, "v"> {
  v: 3;
}

export type Manifest = ManifestV1 | ManifestV2 | ManifestV3;

/** True for the encrypted versions, whose payload is an opaque `enc` blob. */
export function isEncryptedManifest(m: Manifest): m is ManifestV2 | ManifestV3 {
  return m.v === 2 || m.v === 3;
}

export function isEmptyManifest(m: Manifest): boolean {
  return m.v === 1 ? Object.keys(m.files).length === 0 : m.blobs.length === 0;
}

const HASH_RE = /^[0-9a-f]{64}$/;

function isFileEntry(value: unknown): value is FileEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.h === "string" &&
    typeof e.size === "number" &&
    Number.isFinite(e.size) &&
    typeof e.mtime === "number" &&
    Number.isFinite(e.mtime) &&
    (e.c === undefined || (typeof e.c === "string" && HASH_RE.test(e.c))) &&
    // Optional, because every snapshot older than the field lacks it and stays valid. A
    // present-but-nonsense count is still rejected: it is reported to the user as fact.
    (e.lines === undefined ||
      (typeof e.lines === "number" && Number.isInteger(e.lines) && e.lines >= 0))
  );
}

/**
 * Validates a manifest fetched from the server before anything plans writes from it.
 *
 * `SyncApi` used to cast the parsed JSON, so a malformed or corrupted document reached the
 * merge as a half-typed object. A pull mutates the vault as concurrent fetches complete, so
 * "it threw eventually" is not the same as "nothing happened": some files can already have
 * been written by the time a later entry turns out to be nonsense.
 */
export function parseManifest(value: unknown): Manifest {
  const fail = (why: string): never => {
    throw new Error(`invalid manifest from server: ${why}`);
  };
  if (typeof value !== "object" || value === null) return fail("not an object");
  const m = value as Record<string, unknown>;
  if (typeof m.id !== "string" || m.id === "") return fail("id is missing");
  if (m.parent !== null && typeof m.parent !== "string") return fail("parent must be a string or null");
  if (typeof m.device !== "string") return fail("device is missing");
  if (typeof m.createdAt !== "string") return fail("createdAt is missing");

  if (m.v === 1) {
    if (typeof m.files !== "object" || m.files === null) return fail("files is missing");
    for (const [path, entry] of Object.entries(m.files as Record<string, unknown>)) {
      if (!isFileEntry(entry)) return fail(`entry "${path}" is malformed`);
    }
    return m as unknown as ManifestV1;
  }
  if (m.v === 2 || m.v === 3) {
    if (typeof m.keyId !== "string") return fail("keyId is missing");
    if (!Array.isArray(m.blobs) || m.blobs.some((h) => typeof h !== "string" || !HASH_RE.test(h))) {
      return fail("blobs must be an array of sha256 hex digests");
    }
    const enc = m.enc as Record<string, unknown> | undefined;
    if (typeof enc !== "object" || enc === null) return fail("enc is missing");
    if (typeof enc.iv !== "string" || typeof enc.data !== "string") return fail("enc is malformed");
    return m as unknown as ManifestV2 | ManifestV3;
  }
  return fail(`unsupported version ${String(m.v)}`);
}

/** Validates a decrypted path map, which arrives as opaque JSON from inside the ciphertext. */
export function parseFileEntries(value: unknown): Record<string, FileEntry> {
  if (typeof value !== "object" || value === null) {
    throw new Error("decrypted snapshot is not a path map");
  }
  for (const [path, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isFileEntry(entry)) throw new Error(`decrypted snapshot entry "${path}" is malformed`);
  }
  return value as Record<string, FileEntry>;
}

export interface VaultFile {
  path: string;
  size: number;
  mtime: number;
}

export interface VaultAdapter {
  list(): Promise<VaultFile[]>;
  /** Metadata for one journaled path, or null when it no longer exists. */
  stat(path: string): Promise<VaultFile | null>;
  read(path: string): Promise<Uint8Array>;
  /** Creates or overwrites a file, making parent folders as needed. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Removes a file. Implementations should trash rather than destroy where they can. */
  remove(path: string): Promise<void>;
}

/** What this device believes it last pushed. The basis for divergence detection. */
export interface SyncState {
  lastSyncedHead: string | null;
  files: Record<string, FileEntry>;
  /** Encryption identity the cached entries were built under; null when unencrypted. */
  keyId?: string | null;
  /**
   * Lines per text file in the last synced snapshot. Device-local and deliberately outside the
   * manifest: it exists so a sync message can say "+35 lines" without re-downloading the
   * previous version of every edited file. Absent for binary and never-scanned paths.
   */
  lines?: Record<string, number>;
  /** Device-local discovery cache used to reconstruct occupied paths from a dirty journal. */
  inventory?: Record<string, VaultFile>;
}

export interface StateStore {
  load(): Promise<SyncState | null>;
  save(state: SyncState): Promise<void>;
}
