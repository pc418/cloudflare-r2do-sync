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
  /**
   * Removes a folder only when a fresh listing shows it truly empty (no files, no subfolders).
   * Returns whether it removed. Destroys nothing: an empty folder has no content to lose.
   */
  removeFolderIfEmpty(path: string): Promise<boolean>;
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

/** One row of the server's snapshot listing: the clear envelope, and nothing else. */
export interface HistoryEntry {
  id: string;
  /** The snapshot's own parent. The manifest authenticates this one, so it is never guessed. */
  parent: string | null;
  uploadedAt: number;
  /** Null on a snapshot the server has indexed but not yet described. */
  device: string | null;
  createdAt: string | null;
  /**
   * The nearest snapshot the server still holds, when `parent` has been collected. Null when
   * the true parent is still there. Advisory — no manifest can confirm it — so it may say
   * which snapshot to compare against and how wide the interval is, and nothing more.
   */
  spliceParent: string | null;
  /** Commits collected between this snapshot and `spliceParent`. Null when none were. */
  pruned: number | null;
}

/** The snapshot a listing says comes before this one: the real parent, or what replaced it. */
export function previousOf(entry: HistoryEntry): string | null {
  return entry.spliceParent ?? entry.parent;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  /**
   * False when the server's index does not reach the end of the chain. A short list is then
   * not evidence that the vault's history stops there, and must never be shown as if it were.
   */
  complete: boolean;
}

/**
 * Validates a history listing.
 *
 * The chain is checked structurally here rather than trusted: a listing whose links do not
 * actually join up would produce a diff between two snapshots that are not consecutive, which
 * is a wrong answer presented as a fact about the user's own history.
 *
 * Generational retention means the link a row is followed by is not always its parent: once
 * the commits in between are collected, the server names the nearest snapshot it still has.
 * So the join is checked on that link, and `spliceParent`/`pruned` have to agree with each
 * other — a skip of no commits, or a count with nothing skipped, is a page describing
 * something that cannot exist.
 */
export function parseHistoryPage(value: unknown): HistoryPage {
  const fail = (why: string): never => {
    throw new Error(`invalid history from server: ${why}`);
  };
  if (typeof value !== "object" || value === null) return fail("not an object");
  const page = value as Record<string, unknown>;
  if (typeof page.complete !== "boolean") return fail("complete is missing");
  if (!Array.isArray(page.entries)) return fail("entries is missing");

  const entries: HistoryEntry[] = [];
  const seen = new Set<string>();
  for (const raw of page.entries as unknown[]) {
    if (typeof raw !== "object" || raw === null) return fail("an entry is not an object");
    const e = raw as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id === "") return fail("an entry has no id");
    if (e.parent !== null && typeof e.parent !== "string") return fail(`${e.id}: bad parent`);
    if (typeof e.uploadedAt !== "number" || !Number.isFinite(e.uploadedAt)) {
      return fail(`${e.id}: bad uploadedAt`);
    }
    if (e.device !== null && typeof e.device !== "string") return fail(`${e.id}: bad device`);
    if (e.createdAt !== null && typeof e.createdAt !== "string") return fail(`${e.id}: bad createdAt`);
    // Absent on a server that predates thinning, which is a chain with no gaps in it.
    const spliceParent = e.spliceParent ?? null;
    const pruned = e.pruned ?? null;
    if (spliceParent !== null && (typeof spliceParent !== "string" || spliceParent === "")) {
      return fail(`${e.id}: bad spliceParent`);
    }
    if (pruned !== null && (typeof pruned !== "number" || !Number.isInteger(pruned) || pruned < 1)) {
      return fail(`${e.id}: bad pruned`);
    }
    if ((spliceParent === null) !== (pruned === null)) {
      return fail(`${e.id}: spliceParent and pruned must be given together`);
    }
    // A manifest id is used once, ever. A repeat — including a row naming itself as its own
    // parent — means the listing is not a chain, and a diff taken across it would compare a
    // snapshot with itself and report "changed nothing".
    if (seen.has(e.id) || e.parent === e.id || spliceParent === e.id) {
      return fail(`${e.id} appears twice`);
    }
    const previous = entries[entries.length - 1];
    if (previous !== undefined && previousOf(previous) !== e.id) {
      return fail(`${e.id} does not follow ${previous.id}`);
    }
    seen.add(e.id);
    entries.push({
      id: e.id,
      parent: e.parent,
      uploadedAt: e.uploadedAt,
      device: e.device,
      createdAt: e.createdAt,
      spliceParent,
      pruned,
    });
  }
  return { entries, complete: page.complete };
}
