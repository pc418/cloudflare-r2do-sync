import { exactArrayBuffer } from "./buffer";

/**
 * End-to-end encryption for vault contents and metadata.
 *
 * One master key, shared across a user's devices, never sent to the server. Every working
 * key is derived from it with HKDF-SHA-256, and AES-256-GCM does the encrypting — both via
 * WebCrypto, so this runs on Obsidian mobile without shipping a WASM cipher.
 */

const SALT = new TextEncoder().encode("obsidian-log-sync/hkdf/v1");
const IV_BYTES = 12;

export const MASTER_KEY_BYTES = 32;
export const VAULT_SALT_MIN_BYTES = 16;
export const VAULT_SALT_MAX_BYTES = 64;
export const PBKDF2_ITERATIONS = 600_000;

/**
 * Blob encryption uses an all-zero IV. That is safe *because* each blob's key is derived
 * from that blob's own plaintext hash, so any given key encrypts exactly one message for
 * all time — nonce reuse needs one key across two messages. Determinism is the point: the
 * same content always yields the same ciphertext, so the server still deduplicates and a
 * rename still uploads nothing, all without the server learning a plaintext hash.
 */
const ZERO_IV = new Uint8Array(IV_BYTES);

export interface EncPayload {
  alg: "AES-GCM";
  iv: string;
  data: string;
}

function view(bytes: Uint8Array): ArrayBuffer {
  return exactArrayBuffer(bytes);
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  // Chunked: String.fromCharCode(...huge) blows the argument stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A fresh master key, base64, for the user to store in a password manager. */
export function generateMasterKey(): string {
  const raw = new Uint8Array(MASTER_KEY_BYTES);
  crypto.getRandomValues(raw);
  return toBase64(raw);
}

/** A fresh public salt for passphrase derivation, serialized as canonical base64. */
export function generateVaultSalt(): string {
  const raw = new Uint8Array(VAULT_SALT_MIN_BYTES);
  crypto.getRandomValues(raw);
  return toBase64(raw);
}

/** Parses the public vault salt without accepting decoder-specific base64 variants. */
export function parseVaultSalt(text: string): Uint8Array {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("vault salt is empty");

  let raw: Uint8Array;
  try {
    raw = fromBase64(trimmed);
  } catch {
    throw new Error("vault salt is not valid base64");
  }
  if (toBase64(raw) !== trimmed) {
    throw new Error("vault salt must use canonical base64");
  }
  if (raw.length < VAULT_SALT_MIN_BYTES) {
    throw new Error(`vault salt must be at least ${VAULT_SALT_MIN_BYTES} bytes, got ${raw.length}`);
  }
  if (raw.length > VAULT_SALT_MAX_BYTES) {
    throw new Error(`vault salt must be at most ${VAULT_SALT_MAX_BYTES} bytes, got ${raw.length}`);
  }
  return raw;
}

/**
 * Derives the stored 32-byte master key from an exact passphrase and a public vault salt.
 * Passphrases are UTF-8 encoded verbatim: no trimming or Unicode normalization is applied.
 */
export async function deriveMasterKeyFromPassphrase(
  passphrase: string,
  vaultSalt: string
): Promise<string> {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new Error("passphrase is empty");
  }
  const salt = parseVaultSalt(vaultSalt);
  const material = await crypto.subtle.importKey(
    "raw",
    view(new TextEncoder().encode(passphrase)),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: view(salt),
      iterations: PBKDF2_ITERATIONS,
    },
    material,
    MASTER_KEY_BYTES * 8
  );
  return toBase64(new Uint8Array(bits));
}

/** Parses a user-supplied master key. Throws with a usable message rather than degrading. */
export function parseMasterKey(text: string): Uint8Array {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("master key is empty");
  let raw: Uint8Array;
  try {
    raw = fromBase64(trimmed);
  } catch {
    throw new Error("master key is not valid base64");
  }
  if (raw.length !== MASTER_KEY_BYTES) {
    throw new Error(`master key must be ${MASTER_KEY_BYTES} bytes, got ${raw.length}`);
  }
  return raw;
}

async function deriveBits(master: Uint8Array, info: string, bytes: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", view(master), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: new TextEncoder().encode(info) },
    base,
    bytes * 8
  );
  return new Uint8Array(bits);
}

async function deriveAesKey(master: Uint8Array, info: string): Promise<CryptoKey> {
  const raw = await deriveBits(master, info, 32);
  return crypto.subtle.importKey("raw", view(raw), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * The immutable envelope a v3 snapshot authenticates alongside its ciphertext.
 *
 * Serialized as a fixed-order array behind a domain string, so it cannot be confused with
 * any other authenticated payload and cannot change meaning if a field is added later
 * (a new field means a new version, not a new key in a map whose order might vary).
 */
export function manifestAad(envelope: {
  v: number;
  id: string;
  parent: string | null;
  device: string;
  createdAt: string;
  keyId: string;
  blobs: readonly string[];
}): string {
  return JSON.stringify([
    "r2do-sync/manifest/aad/1",
    envelope.v,
    envelope.id,
    envelope.parent,
    envelope.device,
    envelope.createdAt,
    envelope.keyId,
    [...envelope.blobs],
  ]);
}

/** The same idea for the shared settings document; `rev` is what stops replay. */
export function settingsAad(envelope: {
  v: number;
  rev: number;
  device: string;
  keyId: string;
  vaultSalt?: string;
}): string {
  return JSON.stringify([
    "r2do-sync/settings/aad/1",
    envelope.v,
    envelope.rev,
    envelope.device,
    envelope.keyId,
    envelope.vaultSalt ?? null,
  ]);
}

export class VaultCrypto {
  private constructor(
    private readonly master: Uint8Array,
    private readonly manifestKey: CryptoKey,
    /** Its own derivation, NOT the manifest key: the server holds both ciphertexts, and a
     * shared key would let it swap one document type's payload into the other undetected. */
    private readonly settingsKey: CryptoKey,
    /** Identifies the key without revealing it, so a wrong-key device halts instead of
     * committing a snapshot nobody can read. */
    readonly keyId: string
  ) {}

  static async create(master: Uint8Array): Promise<VaultCrypto> {
    if (master.length !== MASTER_KEY_BYTES) {
      throw new Error(`master key must be ${MASTER_KEY_BYTES} bytes, got ${master.length}`);
    }
    const manifestKey = await deriveAesKey(master, "manifest");
    const settingsKey = await deriveAesKey(master, "settings");
    const keyId = toHex(await deriveBits(master, "keyid", 8));
    return new VaultCrypto(master, manifestKey, settingsKey, keyId);
  }

  static async fromText(text: string): Promise<VaultCrypto> {
    return VaultCrypto.create(parseMasterKey(text));
  }

  /** Encrypts one file's bytes. `plainHash` is the sha256 of `bytes`. */
  async encryptBlob(plainHash: string, bytes: Uint8Array): Promise<Uint8Array> {
    const key = await deriveAesKey(this.master, `blob:${plainHash}`);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: ZERO_IV }, key, view(bytes));
    return new Uint8Array(ct);
  }

  /**
   * Decrypts one file's bytes. Because the key comes from the expected plaintext hash, a
   * substituted or corrupted blob fails the GCM tag instead of returning wrong content.
   */
  async decryptBlob(plainHash: string, cipher: Uint8Array): Promise<Uint8Array> {
    const key = await deriveAesKey(this.master, `blob:${plainHash}`);
    try {
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ZERO_IV }, key, view(cipher));
      return new Uint8Array(pt);
    } catch {
      throw new Error(`blob ${plainHash} failed authentication (wrong key or corrupted data)`);
    }
  }

  /**
   * Encrypts the manifest's path map. Random IV — this payload is not deduplicated.
   *
   * `aad` binds the ciphertext to the plaintext envelope around it (id, parent, device,
   * createdAt, keyId, blob set). AES-GCM authenticates but does not conceal it, which is
   * exactly what is needed: the server has to read those fields, and nobody may change them.
   * Without it a bearer-token holder can lift a valid encrypted map into a header of their
   * choosing — a new id and parent — and a correct-key device accepts the result as a
   * genuine snapshot, rolling files back as if they were ordinary remote edits.
   */
  async encryptJson(value: unknown, aad?: string): Promise<EncPayload> {
    return this.encryptJsonWith(this.manifestKey, value, aad);
  }

  async decryptJson<T>(payload: EncPayload, aad?: string): Promise<T> {
    return this.decryptJsonWith(this.manifestKey, payload, "manifest", aad);
  }

  /** Encrypts the shared settings document, under the settings-specific key. */
  async encryptSettingsJson(value: unknown, aad?: string): Promise<EncPayload> {
    return this.encryptJsonWith(this.settingsKey, value, aad);
  }

  async decryptSettingsJson<T>(payload: EncPayload, aad?: string): Promise<T> {
    return this.decryptJsonWith(this.settingsKey, payload, "settings document", aad);
  }

  private async encryptJsonWith(key: CryptoKey, value: unknown, aad?: string): Promise<EncPayload> {
    const iv = new Uint8Array(IV_BYTES);
    crypto.getRandomValues(iv);
    const plain = new TextEncoder().encode(JSON.stringify(value));
    const ct = await crypto.subtle.encrypt(algorithm(iv, aad), key, view(plain));
    return { alg: "AES-GCM", iv: toBase64(iv), data: toBase64(new Uint8Array(ct)) };
  }

  private async decryptJsonWith<T>(
    key: CryptoKey,
    payload: EncPayload,
    what: string,
    aad?: string
  ): Promise<T> {
    if (payload.alg !== "AES-GCM") {
      // `payload.alg` narrows to `never` — the declared type says this cannot happen. It is
      // remote data, so it can: stringify whatever actually arrived instead of trusting it.
      throw new Error(`unsupported ${what} cipher "${String(payload.alg)}"`);
    }
    let pt: ArrayBuffer;
    try {
      pt = await crypto.subtle.decrypt(
        algorithm(fromBase64(payload.iv), aad),
        key,
        view(fromBase64(payload.data))
      );
    } catch {
      throw new Error(
        aad === undefined
          ? `${what} failed authentication (wrong key or corrupted data)`
          : `${what} failed authentication (wrong key, corrupted data, or an altered header)`
      );
    }
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  }
}

function algorithm(iv: Uint8Array, aad?: string): AesGcmParams {
  const params: AesGcmParams = { name: "AES-GCM", iv: view(iv) };
  if (aad !== undefined) params.additionalData = view(new TextEncoder().encode(aad));
  return params;
}
