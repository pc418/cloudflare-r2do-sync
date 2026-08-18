import { describe, it, expect } from "vitest";
import {
  applySharedSettings,
  extractSharedSettings,
  reconcileVaultSalt,
  isNewerRev,
  isSettingsDoc,
  sharedFingerprint,
  type SharedSettings,
} from "../src/settings-doc";
import { toBase64 } from "../src/crypto";

function base(): SharedSettings {
  return {
    excludes: ".obsidian/**\n.trash/**",
    onlyPaths: "",
    syncMode: "two-way",
    conflictMode: "keep-both" as const,
    debounceSeconds: 3,
    intervalMinutes: 15,
    syncOnStartup: true,
    resumeSyncMinutes: 15,
    maxBlobMB: 90,
    protectPercent: 50,
    logEntries: 50,
    historyLimit: 40,
    retryAttempts: 3,
    logNoteFolder: "",
  };
}

describe("extractSharedSettings / sharedFingerprint", () => {
  it("drops device-local fields so credentials can never ride the document", () => {
    const settings = {
      ...base(),
      serverUrl: "https://example.com",
      accessToken: "secret",
      masterKey: "secret",
      deviceName: "laptop",
      lanes: 8,
      syncSettings: true,
    };
    const shared = extractSharedSettings(settings) as unknown as Record<string, unknown>;
    for (const leak of [
      "serverUrl",
      "accessToken",
      "masterKey",
      "deviceName",
      "lanes",
      "syncSettings",
      "syncConfigDir",
    ]) {
      expect(shared, leak).not.toHaveProperty(leak);
    }
  });

  it("fingerprints are equal for equal policy regardless of source key order", () => {
    const a = base();
    // Same values, object built in a different insertion order.
    const b = Object.fromEntries(Object.entries(base()).reverse()) as unknown as SharedSettings;
    expect(sharedFingerprint(a)).toBe(sharedFingerprint(b));
  });

  it("fingerprint changes when any shared field changes", () => {
    const a = base();
    const b = { ...base(), protectPercent: 60 };
    expect(sharedFingerprint(a)).not.toBe(sharedFingerprint(b));
  });
});

describe("applySharedSettings", () => {
  it("applies changed fields and reports the change", () => {
    const target = base();
    const changed = applySharedSettings(target, { protectPercent: 70, excludes: "secret/**" });
    expect(changed).toBe(true);
    expect(target.protectPercent).toBe(70);
    expect(target.excludes).toBe("secret/**");
    expect(target.intervalMinutes).toBe(15); // untouched
  });

  it("reports no change for an identical document", () => {
    const target = base();
    expect(applySharedSettings(target, { ...base() })).toBe(false);
  });

  it("ignores unknown keys — an older build must survive a newer device's doc", () => {
    const target = base();
    expect(applySharedSettings(target, { futureKnob: 42 })).toBe(false);
    expect(target).not.toHaveProperty("futureKnob");
  });

  it("never lets a doc smuggle in device-local fields", () => {
    const target = base() as SharedSettings & { accessToken?: string };
    applySharedSettings(target, { accessToken: "stolen", lanes: 16 });
    expect(target.accessToken).toBeUndefined();
    expect(target).not.toHaveProperty("lanes");
  });

  it("throws on a wrong type — corruption, not versioning", () => {
    expect(() => applySharedSettings(base(), { protectPercent: "high" })).toThrow(/protectPercent/);
    expect(() => applySharedSettings(base(), { protectPercent: NaN })).toThrow(/finite/);
  });

  it("clamps out-of-range numbers from a peer instead of rejecting the whole doc", () => {
    const target = base();
    applySharedSettings(target, { protectPercent: 250, retryAttempts: -2, maxBlobMB: 5000 });
    expect(target.protectPercent).toBe(100);
    expect(target.retryAttempts).toBe(0);
    expect(target.maxBlobMB).toBe(100);
  });
});

describe("isNewerRev", () => {
  it("anything beats no known revision", () => {
    expect(isNewerRev({ updatedAt: 1, device: "a" }, null)).toBe(true);
  });

  it("later timestamp wins; device name breaks exact ties deterministically", () => {
    expect(isNewerRev({ updatedAt: 2, device: "a" }, { updatedAt: 1, device: "z" })).toBe(true);
    expect(isNewerRev({ updatedAt: 1, device: "z" }, { updatedAt: 2, device: "a" })).toBe(false);
    expect(isNewerRev({ updatedAt: 1, device: "b" }, { updatedAt: 1, device: "a" })).toBe(true);
    expect(isNewerRev({ updatedAt: 1, device: "a" }, { updatedAt: 1, device: "a" })).toBe(false);
  });
});

describe("isSettingsDoc", () => {
  it("accepts both wire shapes", () => {
    const vaultSalt = toBase64(new Uint8Array(16));
    expect(isSettingsDoc({ v: 1, updatedAt: 1, device: "a", vaultSalt, plain: {} })).toBe(true);
    expect(
      isSettingsDoc({
        v: 2,
        updatedAt: 1,
        device: "a",
        vaultSalt,
        keyId: "00112233445566aa",
        enc: { alg: "AES-GCM", iv: "x", data: "y" },
      })
    ).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isSettingsDoc(null)).toBe(false);
    expect(isSettingsDoc("doc")).toBe(false);
    expect(isSettingsDoc({ v: 3, updatedAt: 1, device: "a" })).toBe(false);
    expect(isSettingsDoc({ v: 1, updatedAt: "1", device: "a", plain: {} })).toBe(false);
    expect(isSettingsDoc({ v: 2, updatedAt: 1, device: "a" })).toBe(false);
    expect(isSettingsDoc({ v: 1, updatedAt: 1, device: "a", vaultSalt: "short", plain: {} })).toBe(false);
  });
});

describe("conflictMode in the shared document", () => {
  it("syncs like any other policy knob", () => {
    const target = base();
    expect(applySharedSettings(target, { conflictMode: "newest" })).toBe(true);
    expect(target.conflictMode).toBe("newest");
  });

  it("ignores a mode this build does not know — future builds may add modes", () => {
    const target = base();
    expect(applySharedSettings(target, { conflictMode: "quantum" })).toBe(false);
    expect(target.conflictMode).toBe("keep-both");
  });

  it("still throws on a wrong type", () => {
    expect(() => applySharedSettings(base(), { conflictMode: 3 })).toThrow(/conflictMode/);
  });
});

describe("selective sync policy in the shared document", () => {
  it("applies allow-list and direction but never enables config sync remotely", () => {
    const target = base();
    expect(
      applySharedSettings(target, {
        onlyPaths: "daily/**",
        syncMode: "pull-only",
        syncConfigDir: true,
      })
    ).toBe(true);
    expect(target).toMatchObject({
      onlyPaths: "daily/**",
      syncMode: "pull-only",
    });
    expect(target).not.toHaveProperty("syncConfigDir");
  });

  it("ignores an unknown future direction mode", () => {
    const target = base();
    expect(applySharedSettings(target, { syncMode: "mirror-magic" })).toBe(false);
    expect(target.syncMode).toBe("two-way");
  });
});

describe("reconcileVaultSalt", () => {
  const A = "32lVElGCzR+pBQCyFwu+Fg==";
  const B = "AAAAAAAAAAAAAAAAAAAAAA==";

  it("keeps the local salt when the document has none", () => {
    expect(reconcileVaultSalt(A, undefined)).toEqual({ salt: A, changed: false, replaced: null });
  });

  it("is a no-op when both sides already agree", () => {
    expect(reconcileVaultSalt(A, A)).toEqual({ salt: A, changed: false, replaced: null });
  });

  it("adopts the published salt when this device has none", () => {
    expect(reconcileVaultSalt("", A)).toEqual({ salt: A, changed: true, replaced: null });
  });

  // The vault's published salt is canonical: public, write-once, and only ever an input to
  // passphrase derivation. Refusing here meant two hand-configured devices — each of which
  // generates its own salt before it can ever see the vault's — could never sync.
  it("adopts the published salt over a locally generated one and reports what it replaced", () => {
    expect(reconcileVaultSalt(B, A)).toEqual({ salt: A, changed: true, replaced: B });
  });

  it("never invents a salt when neither side has one", () => {
    expect(reconcileVaultSalt("", undefined)).toEqual({ salt: "", changed: false, replaced: null });
    expect(reconcileVaultSalt("", "")).toEqual({ salt: "", changed: false, replaced: null });
  });
});

describe("revision ordering across the upgrade", () => {
  // Every vault passes through mixed state exactly once. A cached pre-upgrade document with
  // a far-future clock — the very capture server revisions exist to end — must not be able to
  // reject every revisioned document that follows it.
  it("a revisioned document supersedes a revisionless one whatever the clocks say", () => {
    const legacy = { updatedAt: 4_000_000_000_000, device: "skewed-phone" };
    const incoming = { updatedAt: 1, device: "laptop", rev: 1 };

    expect(isNewerRev(incoming, legacy)).toBe(true);
    // ...and not the other way round: once ordering is server-assigned it does not regress.
    expect(isNewerRev(legacy, incoming)).toBe(false);
  });

  it("compares revisions once both sides have them, ignoring the clocks entirely", () => {
    expect(isNewerRev({ updatedAt: 1, device: "a", rev: 5 }, { updatedAt: 9e12, device: "b", rev: 4 })).toBe(true);
    expect(isNewerRev({ updatedAt: 9e12, device: "a", rev: 4 }, { updatedAt: 1, device: "b", rev: 5 })).toBe(false);
  });

  it("still falls back to the clock when neither side has a revision", () => {
    expect(isNewerRev({ updatedAt: 2, device: "a" }, { updatedAt: 1, device: "b" })).toBe(true);
    expect(isNewerRev({ updatedAt: 1, device: "b" }, { updatedAt: 1, device: "a" })).toBe(true);
  });
});
