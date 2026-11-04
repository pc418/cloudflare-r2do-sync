import { manifestAad, type VaultCrypto } from "./crypto";
import { parseFileEntries, type FileEntry, type Manifest, type SyncState } from "./types";

export type EncryptionMode = "encrypted" | "plaintext";

export interface EncryptionState {
  encryptionMode: EncryptionMode;
  masterKey: string;
  masterKeyBackedUp: boolean;
  /** Public vault identity used only as PBKDF2 salt; never the HKDF domain separator. */
  vaultSalt: string;
}

export type EncryptionReadiness =
  | "ready"
  | "key-required"
  | "backup-required"
  | "plaintext-key-conflict";

/**
 * Upgrades persisted settings without turning an established plaintext install into an
 * accidental encrypted reconfiguration. Only the complete absence of persisted settings
 * means a genuinely fresh, default-encrypted install.
 */
export function normalizeEncryptionState(
  raw: Partial<EncryptionState> | null
): EncryptionState {
  if (raw === null) {
    return {
      encryptionMode: "encrypted",
      masterKey: "",
      masterKeyBackedUp: false,
      vaultSalt: "",
    };
  }

  const masterKey = typeof raw.masterKey === "string" ? raw.masterKey : "";
  if (raw.encryptionMode === "encrypted" || raw.encryptionMode === "plaintext") {
    return {
      encryptionMode: raw.encryptionMode,
      masterKey,
      masterKeyBackedUp: raw.masterKeyBackedUp === true,
      vaultSalt: typeof raw.vaultSalt === "string" ? raw.vaultSalt : "",
    };
  }

  // Legacy builds used only key presence. Preserve their already-active mode and treat the
  // old explicit setup as acknowledged; default-on applies to new installs, not by surprise.
  return {
    encryptionMode: masterKey.trim() === "" ? "plaintext" : "encrypted",
    masterKey,
    masterKeyBackedUp: true,
    vaultSalt: typeof raw.vaultSalt === "string" ? raw.vaultSalt : "",
  };
}

export function encryptionReadiness(state: EncryptionState): EncryptionReadiness {
  if (state.encryptionMode === "plaintext") {
    return state.masterKey.trim() === "" ? "ready" : "plaintext-key-conflict";
  }
  if (state.masterKey.trim() === "") return "key-required";
  return state.masterKeyBackedUp ? "ready" : "backup-required";
}

/** Activates a target without ever forgetting an already-established public vault salt. */
export function activateEncryptionState(
  current: EncryptionState,
  target: EncryptionState
): EncryptionState {
  return {
    ...target,
    vaultSalt: target.vaultSalt || current.vaultSalt,
  };
}

/** A state-less device may adopt only the exact encryption identity already on the remote. */
export function remoteManifestMatchesTarget(manifest: Manifest, targetKeyId: string | null): boolean {
  return manifest.v === 1 ? targetKeyId === null : targetKeyId === manifest.keyId;
}

/**
 * Whether `manifest` is a v3 snapshot under `crypto`'s key whose envelope authenticates.
 *
 * This is the only remote evidence that a holder of that key wrote this exact header — id,
 * parent, keyId and blob list are all in `manifestAad`. A clear `keyId` by itself is a claim
 * anyone with a sync token can make, and a v2 envelope binds none of it.
 */
export async function authenticatesUnderKey(
  manifest: Manifest,
  crypto: VaultCrypto
): Promise<boolean> {
  if (manifest.v !== 3 || manifest.keyId !== crypto.keyId) return false;
  try {
    parseFileEntries(await crypto.decryptJson(manifest.enc, manifestAad(manifest)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a device with no snapshot of its own may adopt the target (null = plaintext) as the
 * vault's existing identity, at the user's explicit request.
 *
 * Deliberately weaker than `authenticatesUnderKey`, and never used as migration-completion
 * evidence: a legacy v2 head is accepted when its path map decrypts under the target key, which
 * proves the content was written under that key but not the envelope or its freshness. Without
 * it a vault whose head predates v3 could not be joined by typing its key. A plaintext target
 * has no key to prove anything with; the explicit request is the authority there.
 */
export async function remoteAdoptableAsTarget(
  manifest: Manifest,
  targetCrypto: VaultCrypto | null
): Promise<boolean> {
  if (!remoteManifestMatchesTarget(manifest, targetCrypto?.keyId ?? null)) return false;
  if (targetCrypto === null || manifest.v === 1) return true;
  if (manifest.v === 3) return authenticatesUnderKey(manifest, targetCrypto);
  try {
    parseFileEntries(await targetCrypto.decryptJson(manifest.enc));
    return true;
  } catch {
    return false;
  }
}

/**
 * The same plaintext content at the same paths, which is everything a plaintext migration of
 * `source` can produce. `c` must be absent: on a v1 snapshot the blob a file points at is its
 * plaintext hash, and a ciphertext reference would be a different blob.
 */
export function samePlainContent(
  plain: Record<string, FileEntry>,
  source: Record<string, FileEntry>
): boolean {
  const keys = Object.keys(plain);
  if (keys.length !== Object.keys(source).length) return false;
  return keys.every((path) => {
    const a = plain[path];
    const b = Object.hasOwn(source, path) ? source[path] : undefined;
    return b !== undefined && a.c === undefined && a.h === b.h && a.size === b.size;
  });
}

/**
 * Where an interrupted or failed encryption change stands.
 *
 * - `complete`: the remote head is this change's own publication.
 * - `not-started`: the remote is still in the source mode, so no migration commit happened.
 * - `unverified`: neither can be shown. The pending change and the current key must both be
 *   kept, because a clear envelope can claim anything in either direction.
 */
export type TransitionOutcome = "complete" | "not-started" | "unverified";

export type TransitionBase = Pick<SyncState, "lastSyncedHead" | "files" | "keyId">;

/**
 * Decides a transition from the remote head and this device's own records.
 *
 * Clear-envelope fields only ever select which proof to try; none of them is the proof. The
 * proofs, in order:
 *
 * 1. The head is still the snapshot the migration started from: nothing was committed.
 * 2. This device's own post-commit record (`current`, saved by the migration itself) names the
 *    head under the target key — and the head authenticates under it (encrypted target) or
 *    carries exactly the path map that record saved (plaintext target).
 * 3. The head is a direct child of the source head (`base`), and either authenticates under the
 *    target key (encrypted target; `parent` is inside the AAD) or carries exactly the source's
 *    content (plaintext target, which has no key: persisted intent plus content equivalence).
 *    A descendant further down is left `unverified` rather than walked: an availability cost
 *    paid only when another device has already committed under the target.
 * 4. The head authenticates under the source key: the vault is still in the source mode.
 *
 * Authentication is not freshness. A replayed older target-key snapshot authenticates, which is
 * why completion also requires our own record or the recorded source head as its parent.
 */
export async function classifyTransition(evidence: {
  head: string | null;
  manifest: Manifest | null;
  /** This device's state captured before the attempt, under the source mode. */
  base: TransitionBase | null;
  /** This device's state now, which the migration overwrites after its commit. */
  current: TransitionBase | null;
  sourceCrypto: VaultCrypto | null;
  targetCrypto: VaultCrypto | null;
}): Promise<TransitionOutcome> {
  const { head, manifest, base, current, sourceCrypto, targetCrypto } = evidence;
  if (head === null || manifest === null || manifest.id !== head) return "unverified";
  const sourceKeyId = sourceCrypto?.keyId ?? null;
  const targetKeyId = targetCrypto?.keyId ?? null;
  const source =
    base !== null && base.lastSyncedHead !== null && (base.keyId ?? null) === sourceKeyId
      ? base
      : null;
  if (source !== null && head === source.lastSyncedHead) return "not-started";

  if (
    current !== null &&
    current.lastSyncedHead === head &&
    (current.keyId ?? null) === targetKeyId
  ) {
    // The record names the head, but the head's content is still the server's word. A plaintext
    // target has no key, so the served map must be the one this device recorded committing —
    // otherwise the recorded id could be answered with any map, an empty one included.
    const proven =
      targetCrypto === null
        ? manifest.v === 1 && samePlainContent(manifest.files, current.files)
        : await authenticatesUnderKey(manifest, targetCrypto);
    if (proven) return "complete";
  }
  if (source !== null && manifest.parent === source.lastSyncedHead) {
    const proven =
      targetCrypto === null
        ? manifest.v === 1 && samePlainContent(manifest.files, source.files)
        : await authenticatesUnderKey(manifest, targetCrypto);
    if (proven) return "complete";
  }
  if (sourceCrypto !== null && (await authenticatesUnderKey(manifest, sourceCrypto))) {
    return "not-started";
  }
  return "unverified";
}
