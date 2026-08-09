import { describe, it, expect } from "vitest";
import {
  MASTER_KEY_BYTES,
  PBKDF2_ITERATIONS,
  VAULT_SALT_MAX_BYTES,
  VAULT_SALT_MIN_BYTES,
  VaultCrypto,
  deriveMasterKeyFromPassphrase,
  fromBase64,
  generateMasterKey,
  generateVaultSalt,
  parseMasterKey,
  parseVaultSalt,
  toBase64,
} from "../src/crypto";
import { sha256Hex } from "../src/hash";

const KEY_A = new Uint8Array(32).fill(7);
const KEY_B = new Uint8Array(32).fill(9);

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("base64 helpers", () => {
  it("round-trips arbitrary bytes including 0x00 and 0xff", () => {
    const raw = new Uint8Array([0, 1, 127, 128, 254, 255, 0]);
    expect(fromBase64(toBase64(raw))).toEqual(raw);
  });

  it("round-trips data larger than the chunking window", () => {
    const raw = new Uint8Array(0x8000 * 2 + 5);
    // getRandomValues caps at 65536 bytes per call, so fill in slices.
    for (let i = 0; i < raw.length; i += 0x8000) crypto.getRandomValues(raw.subarray(i, i + 0x8000));
    expect(fromBase64(toBase64(raw))).toEqual(raw);
  });
});

describe("master key handling", () => {
  it("generates a 32-byte key that parses back", () => {
    const k = generateMasterKey();
    expect(parseMasterKey(k)).toHaveLength(MASTER_KEY_BYTES);
  });

  it("generates a different key each time", () => {
    expect(generateMasterKey()).not.toBe(generateMasterKey());
  });

  it("tolerates surrounding whitespace from a paste", () => {
    const k = generateMasterKey();
    expect(parseMasterKey(`  ${k}\n`)).toEqual(parseMasterKey(k));
  });

  it("rejects empty, non-base64, and wrong-length keys loudly", () => {
    expect(() => parseMasterKey("")).toThrow(/empty/);
    expect(() => parseMasterKey("   ")).toThrow(/empty/);
    expect(() => parseMasterKey("not valid base64!!")).toThrow(/base64/);
    expect(() => parseMasterKey(toBase64(new Uint8Array(16)))).toThrow(/32 bytes, got 16/);
  });

  it("refuses to build a VaultCrypto from a wrong-size key", async () => {
    await expect(VaultCrypto.create(new Uint8Array(16))).rejects.toThrow(/32 bytes/);
  });
});

describe("passphrase-derived master keys", () => {
  const saltA = toBase64(new Uint8Array([...Array(16).keys()]));
  const saltB = toBase64(new Uint8Array(16).fill(42));

  it("uses PBKDF2-SHA256 with 600,000 iterations and returns a 32-byte base64 key", async () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000);
    const key = await deriveMasterKeyFromPassphrase("correct horse battery staple", saltA);
    expect(key).toBe("7xdxRO7JQgy8EJPSqLNEqSvFBtDU7JwCjdGfgyTYweY=");
    expect(parseMasterKey(key)).toHaveLength(MASTER_KEY_BYTES);
  });

  it("is deterministic and changes when the public vault salt changes", async () => {
    const one = await deriveMasterKeyFromPassphrase("same passphrase", saltA);
    expect(await deriveMasterKeyFromPassphrase("same passphrase", saltA)).toBe(one);
    expect(await deriveMasterKeyFromPassphrase("same passphrase", saltB)).not.toBe(one);
  });

  it("uses the passphrase's exact UTF-8 bytes, including Unicode and whitespace", async () => {
    const unicodeSalt = "ABEiM0RVZneImaq7zN3u/w==";
    expect(await deriveMasterKeyFromPassphrase("pāssphrase 🔐", unicodeSalt)).toBe(
      "KbJW45as4BM/VS40KOzr9Oasd8UMJ2xxjAI3jVGP45w="
    );
    expect(await deriveMasterKeyFromPassphrase(" passphrase ", saltA)).not.toBe(
      await deriveMasterKeyFromPassphrase("passphrase", saltA)
    );
    expect(await deriveMasterKeyFromPassphrase("é", saltA)).not.toBe(
      await deriveMasterKeyFromPassphrase("e\u0301", saltA)
    );
  });

  it("rejects an empty passphrase and malformed or undersized salts", async () => {
    await expect(deriveMasterKeyFromPassphrase("", saltA)).rejects.toThrow(/passphrase is empty/);
    await expect(deriveMasterKeyFromPassphrase("passphrase", "not base64")).rejects.toThrow(
      /vault salt.*base64/
    );
    await expect(
      deriveMasterKeyFromPassphrase("passphrase", toBase64(new Uint8Array(15)))
    ).rejects.toThrow(/at least 16 bytes, got 15/);
  });
});

describe("public vault salt handling", () => {
  it("generates canonical base64 salts within the server's 16-64 byte range", () => {
    const salt = generateVaultSalt();
    const raw = parseVaultSalt(salt);
    expect(raw.length).toBeGreaterThanOrEqual(VAULT_SALT_MIN_BYTES);
    expect(raw.length).toBeLessThanOrEqual(VAULT_SALT_MAX_BYTES);
    expect(toBase64(raw)).toBe(salt);
    expect(generateVaultSalt()).not.toBe(salt);
  });

  it("accepts surrounding paste whitespace but returns the canonical bytes", () => {
    const salt = toBase64(new Uint8Array(16).fill(7));
    expect(parseVaultSalt(`  ${salt}\n`)).toEqual(fromBase64(salt));
  });

  it("rejects empty, non-canonical, malformed, undersized, and oversized base64", () => {
    expect(() => parseVaultSalt("")).toThrow(/vault salt is empty/);
    expect(() => parseVaultSalt("not base64!")).toThrow(/vault salt.*base64/);
    expect(() => parseVaultSalt("AAAAAAAAAAAAAAAAAAAAAA")).toThrow(/canonical base64/);
    expect(() => parseVaultSalt(toBase64(new Uint8Array(15)))).toThrow(/at least 16 bytes/);
    expect(() => parseVaultSalt(toBase64(new Uint8Array(65)))).toThrow(/at most 64 bytes/);
  });
});

describe("keyId", () => {
  it("is stable for a key and differs between keys", async () => {
    const a1 = await VaultCrypto.create(KEY_A);
    const a2 = await VaultCrypto.create(KEY_A);
    const b = await VaultCrypto.create(KEY_B);
    expect(a1.keyId).toBe(a2.keyId);
    expect(a1.keyId).not.toBe(b.keyId);
    expect(a1.keyId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("blob encryption", () => {
  it("round-trips content", async () => {
    const c = await VaultCrypto.create(KEY_A);
    const plain = bytes("# daily log\n\n- shipped encryption\n");
    const h = await sha256Hex(plain);
    expect(text(await c.decryptBlob(h, await c.encryptBlob(h, plain)))).toBe(text(plain));
  });

  it("round-trips empty content", async () => {
    const c = await VaultCrypto.create(KEY_A);
    const plain = new Uint8Array(0);
    const h = await sha256Hex(plain);
    expect(await c.decryptBlob(h, await c.encryptBlob(h, plain))).toEqual(plain);
  });

  it("round-trips binary content", async () => {
    const c = await VaultCrypto.create(KEY_A);
    const plain = new Uint8Array(4096);
    crypto.getRandomValues(plain);
    const h = await sha256Hex(plain);
    expect(await c.decryptBlob(h, await c.encryptBlob(h, plain))).toEqual(plain);
  });

  it("is deterministic, so identical content still dedupes", async () => {
    const c = await VaultCrypto.create(KEY_A);
    const plain = bytes("same content in two places");
    const h = await sha256Hex(plain);
    const one = await c.encryptBlob(h, plain);
    const two = await c.encryptBlob(h, plain);
    expect(toBase64(one)).toBe(toBase64(two));
  });

  it("is deterministic across separate VaultCrypto instances with the same key", async () => {
    const plain = bytes("committed from two devices");
    const h = await sha256Hex(plain);
    const one = await (await VaultCrypto.create(KEY_A)).encryptBlob(h, plain);
    const two = await (await VaultCrypto.create(KEY_A)).encryptBlob(h, plain);
    expect(toBase64(one)).toBe(toBase64(two));
  });

  it("gives different ciphertext for different content and for different keys", async () => {
    const a = await VaultCrypto.create(KEY_A);
    const b = await VaultCrypto.create(KEY_B);
    const p1 = bytes("one");
    const p2 = bytes("two");
    const h1 = await sha256Hex(p1);
    const h2 = await sha256Hex(p2);
    expect(toBase64(await a.encryptBlob(h1, p1))).not.toBe(toBase64(await a.encryptBlob(h2, p2)));
    expect(toBase64(await a.encryptBlob(h1, p1))).not.toBe(toBase64(await b.encryptBlob(h1, p1)));
  });

  it("hides the plaintext", async () => {
    const c = await VaultCrypto.create(KEY_A);
    const plain = bytes("PATIENT NAME: confidential");
    const h = await sha256Hex(plain);
    expect(text(await c.encryptBlob(h, plain))).not.toContain("confidential");
  });

  it("fails authentication when the ciphertext is tampered with", async () => {
    const c = await VaultCrypto.create(KEY_A);
    const plain = bytes("trustworthy");
    const h = await sha256Hex(plain);
    const ct = await c.encryptBlob(h, plain);
    ct[0] ^= 0xff;
    await expect(c.decryptBlob(h, ct)).rejects.toThrow(/failed authentication/);
  });

  it("fails when a different blob is substituted under the expected hash", async () => {
    const c = await VaultCrypto.create(KEY_A);
    const mine = bytes("my note");
    const other = bytes("attacker's note");
    const hMine = await sha256Hex(mine);
    const hOther = await sha256Hex(other);
    const ctOther = await c.encryptBlob(hOther, other);
    await expect(c.decryptBlob(hMine, ctOther)).rejects.toThrow(/failed authentication/);
  });

  it("cannot be decrypted with the wrong master key", async () => {
    const a = await VaultCrypto.create(KEY_A);
    const b = await VaultCrypto.create(KEY_B);
    const plain = bytes("private");
    const h = await sha256Hex(plain);
    await expect(b.decryptBlob(h, await a.encryptBlob(h, plain))).rejects.toThrow(
      /failed authentication/
    );
  });
});

describe("manifest encryption", () => {
  const files = {
    "daily/2026-08-03.md": { h: "a".repeat(64), size: 12, mtime: 1_754_000_000_000 },
    "private/therapy.md": { h: "b".repeat(64), size: 34, mtime: 1_754_000_000_001 },
  };

  it("round-trips the path map", async () => {
    const c = await VaultCrypto.create(KEY_A);
    expect(await c.decryptJson(await c.encryptJson(files))).toEqual(files);
  });

  it("hides paths from the payload", async () => {
    const c = await VaultCrypto.create(KEY_A);
    const enc = await c.encryptJson(files);
    expect(enc.data).not.toContain("therapy");
    expect(text(fromBase64(enc.data))).not.toContain("therapy");
    expect(enc.alg).toBe("AES-GCM");
    expect(fromBase64(enc.iv)).toHaveLength(12);
  });

  it("uses a fresh IV each time (identical input, different payload)", async () => {
    const c = await VaultCrypto.create(KEY_A);
    const one = await c.encryptJson(files);
    const two = await c.encryptJson(files);
    expect(one.iv).not.toBe(two.iv);
    expect(one.data).not.toBe(two.data);
  });

  it("cannot be decrypted with the wrong master key", async () => {
    const a = await VaultCrypto.create(KEY_A);
    const b = await VaultCrypto.create(KEY_B);
    await expect(b.decryptJson(await a.encryptJson(files))).rejects.toThrow(
      /failed authentication/
    );
  });

  it("rejects a tampered payload and an unknown cipher", async () => {
    const c = await VaultCrypto.create(KEY_A);
    const enc = await c.encryptJson(files);
    const raw = fromBase64(enc.data);
    raw[0] ^= 0xff;
    await expect(c.decryptJson({ ...enc, data: toBase64(raw) })).rejects.toThrow(
      /failed authentication/
    );
    await expect(
      c.decryptJson({ ...enc, alg: "AES-CBC" as unknown as "AES-GCM" })
    ).rejects.toThrow(/unsupported manifest cipher/);
  });
});

describe("settings document encryption", () => {
  const policy = { excludes: "private/**", protectPercent: 60, notifyOnSync: true };

  it("round-trips under the settings key", async () => {
    const c = await VaultCrypto.create(KEY_A);
    expect(await c.decryptSettingsJson(await c.encryptSettingsJson(policy))).toEqual(policy);
  });

  it("cannot be decrypted with the wrong master key", async () => {
    const a = await VaultCrypto.create(KEY_A);
    const b = await VaultCrypto.create(KEY_B);
    await expect(b.decryptSettingsJson(await a.encryptSettingsJson(policy))).rejects.toThrow(
      /failed authentication/
    );
  });

  it("settings and manifest payloads are NOT interchangeable, even under one master key", async () => {
    // The server stores both ciphertexts. With a shared key it could swap a settings doc
    // into a manifest slot (or vice versa) and the swap would decrypt cleanly.
    const c = await VaultCrypto.create(KEY_A);
    await expect(c.decryptJson(await c.encryptSettingsJson(policy))).rejects.toThrow(
      /failed authentication/
    );
    await expect(c.decryptSettingsJson(await c.encryptJson(policy))).rejects.toThrow(
      /failed authentication/
    );
  });
});
