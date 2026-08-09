import { parseVaultSalt, type EncPayload } from "./crypto";
import { CONFLICT_MODES, type ConflictMode } from "./merge";
import { LOG_ENTRIES_RANGE } from "./log";
import { isSyncMode, type SyncMode } from "./sync-policy";

/**
 * The vault-wide settings every device applies — the "policy" half of the plugin's
 * settings. Deliberately NOT here: credentials (`serverUrl`, `accessToken`, `masterKey`
 * — a device needs them *before* it can pull anything, and they are identical per vault
 * anyway), `deviceName` (its whole point is to differ), `lanes` (a phone and a desktop
 * want different widths), and `syncSettings` itself (turning it off must stick locally).
 */
export interface SharedSettings {
  excludes: string;
  onlyPaths: string;
  syncMode: SyncMode;
  conflictMode: ConflictMode;
  debounceSeconds: number;
  intervalMinutes: number;
  syncOnStartup: boolean;
  maxBlobMB: number;
  protectPercent: number;
  logEntries: number;
  historyLimit: number;
  retryAttempts: number;
  logNoteFolder: string;
  notifyOnSync: boolean;
  notifyOnlyChanged: boolean;
  verboseSyncNotice: boolean;
}

/** Fixed order — `sharedFingerprint` depends on it being stable across builds. */
const SHARED_KEYS: readonly (keyof SharedSettings)[] = [
  "excludes",
  "onlyPaths",
  "syncMode",
  "conflictMode",
  "debounceSeconds",
  "intervalMinutes",
  "syncOnStartup",
  "maxBlobMB",
  "protectPercent",
  "logEntries",
  "historyLimit",
  "retryAttempts",
  "logNoteFolder",
  "notifyOnSync",
  "notifyOnlyChanged",
  "verboseSyncNotice",
];

/**
 * Bounds a value from a *remote* document is clamped into. The settings UI refuses
 * out-of-range input instead; a peer (possibly a newer build with wider limits) already
 * accepted these, so clamping beats rejecting the whole document. Mirrors the UI ranges
 * and the worker's 100 MiB body cap; retries mirror `RETRY_DELAYS_MS` in main.ts.
 */
const NUMBER_BOUNDS: Partial<Record<keyof SharedSettings, { min: number; max: number }>> = {
  debounceSeconds: { min: 0, max: 3600 },
  intervalMinutes: { min: 0, max: 24 * 60 },
  maxBlobMB: { min: 1, max: 100 },
  protectPercent: { min: 0, max: 100 },
  logEntries: LOG_ENTRIES_RANGE,
  historyLimit: { min: 1, max: 200 },
  retryAttempts: { min: 0, max: 5 },
};

/** The shared subset of `settings`, keys in fixed order. */
export function extractSharedSettings(settings: SharedSettings): SharedSettings {
  const out = {} as Record<keyof SharedSettings, unknown>;
  for (const key of SHARED_KEYS) out[key] = settings[key];
  return out as unknown as SharedSettings;
}

/**
 * Identity of the shared subset. Two devices holding the same policy produce the same
 * string, so "did MY settings change since the last agreed doc?" is one comparison.
 */
export function sharedFingerprint(settings: SharedSettings): string {
  return JSON.stringify(extractSharedSettings(settings));
}

/**
 * Applies a remote document's fields onto `target`. Unknown keys are ignored — an older
 * build reading a newer device's doc must not choke on a knob it does not have. A wrong
 * TYPE on a known key throws: that is corruption or a broken client, not versioning.
 * Returns whether anything actually changed.
 */
export function applySharedSettings(
  target: SharedSettings,
  incoming: Record<string, unknown>
): boolean {
  let changed = false;
  for (const key of SHARED_KEYS) {
    if (!(key in incoming)) continue;
    let value = incoming[key];
    const expected = typeof target[key];
    if (typeof value !== expected) {
      throw new Error(`shared settings field "${key}" is a ${typeof value}, expected ${expected}`);
    }
    if (key === "conflictMode" && !CONFLICT_MODES.includes(value as ConflictMode)) {
      // A newer build may know modes this one does not; skipping the key beats
      // rejecting the whole document or storing a value the engine cannot honour.
      continue;
    }
    if (key === "syncMode" && !isSyncMode(value)) continue;
    const bounds = NUMBER_BOUNDS[key];
    if (bounds !== undefined) {
      const n = value as number;
      if (!Number.isFinite(n)) throw new Error(`shared settings field "${key}" is not a finite number`);
      value = Math.min(bounds.max, Math.max(bounds.min, n));
    }
    if (target[key] !== value) {
      (target as unknown as Record<string, unknown>)[key] = value;
      changed = true;
    }
  }
  return changed;
}

/** Who wrote a settings document, for last-writer-wins comparison. */
export interface SettingsRev {
  updatedAt: number;
  device: string;
}

export interface SaltReconciliation {
  /** The salt this device must use from now on. */
  salt: string;
  /** True when the local value changed and has to be persisted. */
  changed: boolean;
  /** The locally generated salt that was superseded, or null when nothing was overwritten. */
  replaced: string | null;
}

/**
 * Decide which per-vault salt wins. The vault's published salt is canonical: it is public,
 * write-once on the server, and only ever an input to passphrase derivation — it is never
 * key material by itself.
 *
 * A hand-configured device mints a random salt of its own before it can possibly have seen
 * the vault's, so treating a local salt as authoritative made the SECOND device of any vault
 * fail with "vault salt differs from this device" forever. The local value is provisional and
 * yields. Real key disagreement is still caught downstream, where it belongs: the document's
 * `keyId` check and manifest authentication both halt loudly on a wrong master key.
 */
export function reconcileVaultSalt(local: string, remote: string | undefined): SaltReconciliation {
  if (remote === undefined || remote === "" || remote === local) {
    return { salt: local, changed: false, replaced: null };
  }
  return { salt: remote, changed: true, replaced: local === "" ? null : local };
}

/**
 * Last writer wins on device wall clocks, device name as the deterministic tiebreak.
 * Clock skew between two phones is real but harmless here: the loser's next edit wins.
 */
export function isNewerRev(a: SettingsRev, b: SettingsRev | null): boolean {
  if (b === null) return true;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  return a.device > b.device;
}

/** Wire shape of the document — mirrors `worker/src/settings.ts`. */
export interface SettingsDocV1 extends SettingsRev {
  v: 1;
  vaultSalt?: string;
  plain: Record<string, unknown>;
}

export interface SettingsDocV2 extends SettingsRev {
  v: 2;
  vaultSalt?: string;
  keyId: string;
  enc: EncPayload;
}

export type SettingsDoc = SettingsDocV1 | SettingsDocV2;

/** Shape check for a fetched document. The server validates writes; trust but verify. */
export function isSettingsDoc(value: unknown): value is SettingsDoc {
  if (typeof value !== "object" || value === null) return false;
  const doc = value as Record<string, unknown>;
  if (typeof doc.updatedAt !== "number" || typeof doc.device !== "string") return false;
  if (doc.vaultSalt !== undefined) {
    if (typeof doc.vaultSalt !== "string") return false;
    try {
      parseVaultSalt(doc.vaultSalt);
    } catch {
      return false;
    }
  }
  if (doc.v === 1) return typeof doc.plain === "object" && doc.plain !== null;
  if (doc.v === 2) return typeof doc.keyId === "string" && typeof doc.enc === "object" && doc.enc !== null;
  return false;
}
