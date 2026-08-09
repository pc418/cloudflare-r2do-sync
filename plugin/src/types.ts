import type { EncPayload } from "./crypto";

export interface FileEntry {
  /** sha256 of the file's plaintext. */
  h: string;
  size: number;
  mtime: number;
  /** sha256 of the ciphertext — the R2 blob key. Present iff the vault is encrypted. */
  c?: string;
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

export type Manifest = ManifestV1 | ManifestV2;

export function isEmptyManifest(m: Manifest): boolean {
  return m.v === 1 ? Object.keys(m.files).length === 0 : m.blobs.length === 0;
}

export interface VaultFile {
  path: string;
  size: number;
  mtime: number;
}

export interface VaultAdapter {
  list(): Promise<VaultFile[]>;
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
}

export interface StateStore {
  load(): Promise<SyncState | null>;
  save(state: SyncState): Promise<void>;
}
