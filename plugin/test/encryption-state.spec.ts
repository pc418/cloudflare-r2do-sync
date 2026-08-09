import { describe, expect, it } from "vitest";
import {
  activateEncryptionState,
  encryptionReadiness,
  normalizeEncryptionState,
  remoteManifestMatchesTarget,
  type EncryptionState,
} from "../src/encryption-state";

const KEY = "A".repeat(44);

describe("normalizeEncryptionState", () => {
  it("makes a genuinely fresh install encrypted and backup-gated", () => {
    expect(normalizeEncryptionState(null)).toEqual({
      encryptionMode: "encrypted",
      masterKey: "",
      masterKeyBackedUp: false,
      vaultSalt: "",
    });
  });

  it("treats a legacy empty key as an explicit plaintext install", () => {
    expect(normalizeEncryptionState({ masterKey: "" })).toMatchObject({
      encryptionMode: "plaintext",
      masterKeyBackedUp: true,
    });
  });

  it("treats a legacy populated key as already acknowledged encrypted state", () => {
    expect(normalizeEncryptionState({ masterKey: KEY })).toMatchObject({
      encryptionMode: "encrypted",
      masterKey: KEY,
      masterKeyBackedUp: true,
    });
  });

  it("preserves explicit modern state", () => {
    const state: EncryptionState = {
      encryptionMode: "encrypted",
      masterKey: KEY,
      masterKeyBackedUp: false,
      vaultSalt: "salt",
    };
    expect(normalizeEncryptionState(state)).toEqual(state);
  });
});

describe("encryptionReadiness", () => {
  it("blocks encrypted sync until a key exists and its backup is acknowledged", () => {
    expect(
      encryptionReadiness({
        encryptionMode: "encrypted",
        masterKey: "",
        masterKeyBackedUp: false,
        vaultSalt: "",
      })
    ).toBe("key-required");
    expect(
      encryptionReadiness({
        encryptionMode: "encrypted",
        masterKey: KEY,
        masterKeyBackedUp: false,
        vaultSalt: "",
      })
    ).toBe("backup-required");
  });

  it("allows encrypted sync only after backup acknowledgement", () => {
    expect(
      encryptionReadiness({
        encryptionMode: "encrypted",
        masterKey: KEY,
        masterKeyBackedUp: true,
        vaultSalt: "",
      })
    ).toBe("ready");
  });

  it("allows plaintext only when no key remains configured", () => {
    expect(
      encryptionReadiness({
        encryptionMode: "plaintext",
        masterKey: "",
        masterKeyBackedUp: true,
        vaultSalt: "",
      })
    ).toBe("ready");
    expect(
      encryptionReadiness({
        encryptionMode: "plaintext",
        masterKey: KEY,
        masterKeyBackedUp: true,
        vaultSalt: "",
      })
    ).toBe("plaintext-key-conflict");
  });
});

describe("activateEncryptionState", () => {
  it("preserves the write-once public salt when opting into plaintext", () => {
    const current: EncryptionState = {
      encryptionMode: "encrypted",
      masterKey: KEY,
      masterKeyBackedUp: true,
      vaultSalt: "established-public-salt",
    };
    expect(
      activateEncryptionState(current, {
        encryptionMode: "plaintext",
        masterKey: "",
        masterKeyBackedUp: true,
        vaultSalt: "",
      })
    ).toEqual({
      encryptionMode: "plaintext",
      masterKey: "",
      masterKeyBackedUp: true,
      vaultSalt: "established-public-salt",
    });
  });

  it("uses the explicitly supplied salt for an encrypted target", () => {
    const current: EncryptionState = {
      encryptionMode: "plaintext",
      masterKey: "",
      masterKeyBackedUp: true,
      vaultSalt: "old-salt",
    };
    expect(
      activateEncryptionState(current, {
        encryptionMode: "encrypted",
        masterKey: KEY,
        masterKeyBackedUp: true,
        vaultSalt: "new-salt",
      }).vaultSalt
    ).toBe("new-salt");
  });
});

describe("remoteManifestMatchesTarget", () => {
  const common = {
    id: "01TEST",
    parent: null,
    device: "phone",
    createdAt: "2026-08-05T00:00:00.000Z",
  };

  it("matches plaintext only to a v1 remote", () => {
    const v1 = { ...common, v: 1 as const, files: {} };
    expect(remoteManifestMatchesTarget(v1, null)).toBe(true);
    expect(remoteManifestMatchesTarget(v1, "aabbccddeeff0011")).toBe(false);
  });

  it("matches encrypted mode only to the exact remote key id", () => {
    const v2 = {
      ...common,
      v: 2 as const,
      keyId: "aabbccddeeff0011",
      blobs: [],
      enc: { alg: "AES-GCM" as const, iv: "iv", data: "data" },
    };
    expect(remoteManifestMatchesTarget(v2, "aabbccddeeff0011")).toBe(true);
    expect(remoteManifestMatchesTarget(v2, "0011223344556677")).toBe(false);
    expect(remoteManifestMatchesTarget(v2, null)).toBe(false);
  });
});
