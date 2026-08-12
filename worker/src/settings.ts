import { z } from "zod";
import { KEY_ID_RE, encPayloadSchema } from "./manifest";

/**
 * The shared settings document: vault-wide plugin settings (excludes, guard threshold,
 * intervals, …) that every device applies. It lives OUTSIDE the snapshot chain on purpose:
 * a manifest field would be silently dropped by any client build that predates it, and the
 * plugin's own folder is hard-excluded from snapshots because it holds credentials.
 *
 * Under `settings/` so GC (which only sweeps `manifests/` and `blobs/`) never touches it.
 * Last writer wins for ordinary fields. vaultSalt is the one exception: once present, the
 * API preserves it because changing the KDF salt would strand encrypted vault data.
 */
export const SETTINGS_KEY = "settings/policy.json";

/** Far above any real settings subset, far below anything worth streaming. */
export const MAX_SETTINGS_BYTES = 64 * 1024;

/** A public PBKDF2 salt, never key material. Bound it to avoid abusive KDF metadata. */
export const MIN_VAULT_SALT_BYTES = 16;
export const MAX_VAULT_SALT_BYTES = 64;

const CANONICAL_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const vaultSaltSchema = z.string().refine((value) => {
  if (!CANONICAL_BASE64_RE.test(value)) return false;
  try {
    const decoded = atob(value);
    return (
      btoa(decoded) === value &&
      decoded.length >= MIN_VAULT_SALT_BYTES &&
      decoded.length <= MAX_VAULT_SALT_BYTES
    );
  } catch {
    return false;
  }
}, `vaultSalt must be canonical base64 encoding ${MIN_VAULT_SALT_BYTES}-${MAX_VAULT_SALT_BYTES} bytes`);

const common = {
  /** Device wall clock. Kept for display and for ordering documents that predate `rev`. */
  updatedAt: z.number().int().nonnegative(),
  device: z.string().min(1).max(64),
  /** Public, vault-wide PBKDF2 salt. Once established, the API preserves it forever. */
  vaultSalt: vaultSaltSchema.optional(),
  /**
   * Monotonic revision, assigned here rather than taken on trust. A device clock decided
   * last-writer-wins before this existed, so one far-future `updatedAt` — accidental skew or
   * a replayed capture — made every honest later write look older and be ignored forever.
   * Absent on writes from clients that predate it, which are still accepted and stamped.
   */
  rev: z.number().int().positive().optional(),
};

/** v1: plaintext vault — settings are readable JSON, like its manifests. */
const settingsDocV1Schema = z
  .object({ v: z.literal(1), ...common, plain: z.record(z.string(), z.unknown()) })
  .strict();

/** v2: encrypted vault — opaque ciphertext; keyId lets a wrong-key device halt loudly. */
const settingsDocV2Schema = z
  .object({
    v: z.literal(2),
    ...common,
    keyId: z.string().regex(KEY_ID_RE, "keyId must be 16 lowercase hex chars"),
    enc: encPayloadSchema,
  })
  .strict();

/** v3 additionally binds `rev`, `device`, `keyId` and `vaultSalt` into the ciphertext. */
const settingsDocV3Schema = z
  .object({
    v: z.literal(3),
    ...common,
    keyId: z.string().regex(KEY_ID_RE, "keyId must be 16 lowercase hex chars"),
    enc: encPayloadSchema,
  })
  .strict();

export const settingsDocSchema = z
  .discriminatedUnion("v", [settingsDocV1Schema, settingsDocV2Schema, settingsDocV3Schema])
  // v3 authenticates `rev` inside its ciphertext, so the server cannot be the one to choose
  // it: assigning a revision to a v3 document that arrived without one would produce a
  // stored document nobody can decrypt. A v3 writer knows about revisions by definition.
  .refine((doc) => doc.v !== 3 || doc.rev !== undefined, {
    message: "a v3 settings document must carry the revision its ciphertext authenticates",
  });

export type SettingsDoc = z.infer<typeof settingsDocSchema>;
