import type { Manifest } from "./types";

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
