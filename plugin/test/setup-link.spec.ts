import { describe, it, expect } from "vitest";
import {
  SETUP_ACTION,
  decodeSetupPayload,
  encodeSetupPayload,
  encodeSetupUri,
  parseSetupText,
  type SetupPayload,
} from "../src/setup-link";
import { generateMasterKey, generateVaultSalt, toBase64 } from "../src/crypto";

const base: SetupPayload = {
  v: 2,
  url: "https://obsidian-log-sync.example.workers.dev",
  name: "phone",
  token: "b".repeat(64),
  mode: "plaintext",
};

const encrypted = (): SetupPayload => ({
  ...base,
  mode: "encrypted",
  key: generateMasterKey(),
  vaultSalt: generateVaultSalt(),
});

describe("setup link round-trip", () => {
  it("round-trips an explicitly plaintext payload", () => {
    expect(decodeSetupPayload(encodeSetupPayload(base))).toEqual(base);
  });

  it("round-trips an encrypted payload carrying the derived key and public vault salt", () => {
    const payload = encrypted();
    expect(decodeSetupPayload(encodeSetupPayload(payload))).toEqual(payload);
  });

  it("accepts what a user can realistically paste on a phone", () => {
    // A scanner that opens the link in a browser instead of Obsidian leaves copy-paste as
    // the only route onto the device, so all three shapes have to work.
    const uri = encodeSetupUri(base);
    expect(parseSetupText(uri)).toEqual(base);
    expect(parseSetupText(`  ${uri}  `)).toEqual(base);
    expect(parseSetupText(encodeSetupPayload(base))).toEqual(base);
    expect(parseSetupText(`?d=${encodeSetupPayload(base)}`)).toEqual(base);
  });

  it("names what is wrong with an unusable paste instead of half-configuring", () => {
    expect(() => parseSetupText("")).toThrow(/paste the setup link/i);
    expect(() => parseSetupText("   ")).toThrow(/paste the setup link/i);
    expect(() => parseSetupText("https://example.com/nothing-here")).toThrow(/no "d=" payload/);
    expect(() => parseSetupText("not-a-payload")).toThrow(/corrupt|payload/i);
  });

  it("produces a URI the OS can hand to Obsidian", () => {
    const uri = encodeSetupUri(base);
    expect(uri.startsWith(`obsidian://${SETUP_ACTION}?d=`)).toBe(true);
    const d = uri.slice(uri.indexOf("?d=") + 3);
    expect(decodeSetupPayload(d)).toEqual(base);
  });

  it("uses a URL-safe alphabet so the URI needs no escaping", () => {
    // A key full of 0xfb bytes forces '+' and '/' in standard base64.
    const key = toBase64(new Uint8Array(32).fill(0xfb));
    const payload: SetupPayload = {
      ...base,
      mode: "encrypted",
      key,
      vaultSalt: generateVaultSalt(),
    };
    const encoded = encodeSetupPayload(payload);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeSetupPayload(encoded)).toEqual(payload);
  });

  it("stays comfortably inside QR capacity", () => {
    const payload = encrypted();
    const encoded = encodeSetupPayload(payload);
    expect(encodeSetupUri(payload).length).toBeLessThan(500);
    expect(encoded.length).toBeGreaterThan(0);
  });

  it("normalizes a trailing slash on the server URL", () => {
    const decoded = decodeSetupPayload(encodeSetupPayload({ ...base, url: `${base.url}/` }));
    expect(decoded.url).toBe(base.url);
  });
});

describe("setup link rejection", () => {
  const encodeRaw = (o: unknown) =>
    toBase64(new TextEncoder().encode(JSON.stringify(o)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

  it("rejects a missing or non-string payload", () => {
    expect(() => decodeSetupPayload(undefined)).toThrow(/no payload/);
    expect(() => decodeSetupPayload("")).toThrow(/no payload/);
    expect(() => decodeSetupPayload(42)).toThrow(/no payload/);
  });

  it("rejects a corrupt payload", () => {
    expect(() => decodeSetupPayload("!!!not base64!!!")).toThrow(/corrupt/);
    expect(() => decodeSetupPayload("eyJ2Ijox")).toThrow(/corrupt/); // truncated JSON
  });

  it("rejects a non-object payload", () => {
    expect(() => decodeSetupPayload(encodeRaw("a string"))).toThrow(/not an object/);
    expect(() => decodeSetupPayload(encodeRaw([1, 2]))).toThrow(/not an object/);
  });

  it("rejects legacy v1 and unknown versions", () => {
    expect(() => decodeSetupPayload(encodeRaw({ ...base, v: 1 }))).toThrow(
      /unsupported setup link version/
    );
    expect(() => decodeSetupPayload(encodeRaw({ ...base, v: 3 }))).toThrow(
      /unsupported setup link version/
    );
    expect(() => decodeSetupPayload(encodeRaw({ url: base.url }))).toThrow(
      /unsupported setup link version/
    );
  });

  it("names the specific missing field", () => {
    expect(() => decodeSetupPayload(encodeRaw({ ...base, token: "" }))).toThrow(/"token"/);
    expect(() => decodeSetupPayload(encodeRaw({ ...base, name: undefined }))).toThrow(/"name"/);
    expect(() => decodeSetupPayload(encodeRaw({ ...base, url: undefined }))).toThrow(/"url"/);
  });

  it("rejects a non-http url", () => {
    expect(() => decodeSetupPayload(encodeRaw({ ...base, url: "ftp://x.test" }))).toThrow(/http/);
  });

  it("rejects plaintext HTTP except for explicit loopback hosts", () => {
    for (const url of ["http://example.com", "http://192.168.1.5:8787", "http://localhost.example.com"]) {
      expect(() => decodeSetupPayload(encodeRaw({ ...base, url }))).toThrow(/HTTPS/);
    }

    for (const url of ["http://localhost:8787", "http://127.0.0.1:8787", "http://127.9.8.7", "http://[::1]:8787"]) {
      expect(decodeSetupPayload(encodeRaw({ ...base, url })).url).toBe(url);
    }
  });

  it("rejects credentials embedded in a server URL", () => {
    expect(() =>
      decodeSetupPayload(encodeRaw({ ...base, url: "https://token@example.com" }))
    ).toThrow(/credentials/);
  });

  it("requires an explicit supported encryption mode", () => {
    expect(() => decodeSetupPayload(encodeRaw({ ...base, mode: undefined }))).toThrow(/"mode"/);
    expect(() => decodeSetupPayload(encodeRaw({ ...base, mode: "surprise" }))).toThrow(/mode/);
  });

  it("requires and validates both encrypted-mode secrets up front", () => {
    const shortButValidBase64 = toBase64(new Uint8Array(16));
    const good = encrypted();
    expect(() => decodeSetupPayload(encodeRaw({ ...good, key: shortButValidBase64 }))).toThrow(
      /32 bytes, got 16/
    );
    expect(() => decodeSetupPayload(encodeRaw({ ...good, key: "not base64!" }))).toThrow(/base64/);
    expect(() => decodeSetupPayload(encodeRaw({ ...good, key: "" }))).toThrow(/"key"/);
    expect(() => decodeSetupPayload(encodeRaw({ ...good, vaultSalt: undefined }))).toThrow(
      /"vaultSalt"/
    );
    expect(() => decodeSetupPayload(encodeRaw({ ...good, vaultSalt: "not base64" }))).toThrow(
      /vault salt.*base64/
    );
  });

  it("forbids encryption material in explicit plaintext mode", () => {
    expect(() => decodeSetupPayload(encodeRaw({ ...base, key: generateMasterKey() }))).toThrow(
      /plaintext.*key/
    );
    expect(() => decodeSetupPayload(encodeRaw({ ...base, vaultSalt: generateVaultSalt() }))).toThrow(
      /plaintext.*vaultSalt/
    );
  });
});
