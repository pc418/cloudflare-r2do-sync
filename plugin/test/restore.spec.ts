import { describe, it, expect } from "vitest";
import { VaultCrypto, deriveMasterKeyFromPassphrase, generateMasterKey, manifestAad, parseMasterKey, toBase64 } from "../src/crypto";
import { sha256Hex } from "../src/hash";

// Resolve Node-only test helpers without adding Node globals to the browser plugin build.
const fs = await import(/* @vite-ignore */ "node:fs/promises" as string);
const os = await import(/* @vite-ignore */ "node:os" as string);
const path = (await import(/* @vite-ignore */ "node:path" as string)).default;
const { mkdtemp, mkdir, readFile, rm, symlink } = fs;
const { tmpdir } = os;

/**
 * Cross-implementation check. scripts/restore.mjs re-implements the crypto independently so
 * recovery never depends on the plugin build; that is only safe if the two agree, which is
 * what this file proves. The specifier is built at runtime so TypeScript treats the plain-JS
 * module as untyped rather than failing to resolve it.
 */
interface RestoreModule {
  deriveMasterKeyFromPassphrase(passphrase: string, vaultSalt: string): Promise<Uint8Array>;
  resolveMasterKeyInput(input: {
    masterKey?: string;
    passphrase?: string;
    vaultSalt?: string;
  }): Promise<Uint8Array>;
  passphraseModeRequested(argv?: string[]): boolean;
  keyIdOf(master: Uint8Array): Promise<string>;
  decryptBlob(master: Uint8Array, plainHash: string, cipher: Uint8Array): Promise<Uint8Array>;
  decryptManifestMap(master: Uint8Array, enc: unknown, aad?: string): Promise<unknown>;
  /** Mirrors `manifestAad` in src/crypto.ts; the pairing is asserted below. */
  manifestAad(envelope: {
    v: number;
    id: string;
    parent: string | null;
    device: string;
    createdAt: string;
    keyId: string;
    blobs: readonly string[];
  }): string;
  parseMasterKey(text: string): Uint8Array;
  assertSafePath(p: string): string;
  writeFileSafely(outDir: string, vaultPath: string, bytes: Uint8Array): Promise<void>;
}

const restore: RestoreModule = await import(
  new URL("../../scripts/restore.mjs", import.meta.url).href
);

const KEY = new Uint8Array(32).fill(11);
const OTHER_KEY = new Uint8Array(32).fill(12);
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("restore.mjs agrees with the plugin's crypto", () => {
  it("derives the same keyId", async () => {
    const plugin = await VaultCrypto.create(KEY);
    expect(await restore.keyIdOf(KEY)).toBe(plugin.keyId);
  });

  it("decrypts a blob the plugin encrypted", async () => {
    const plugin = await VaultCrypto.create(KEY);
    const plain = bytes("# daily log\n\n- restored from ciphertext\n");
    const h = await sha256Hex(plain);
    const cipher = await plugin.encryptBlob(h, plain);

    expect(text(await restore.decryptBlob(KEY, h, cipher))).toBe(text(plain));
  });

  it("decrypts binary content byte-exactly", async () => {
    const plugin = await VaultCrypto.create(KEY);
    const plain = new Uint8Array(2048);
    crypto.getRandomValues(plain);
    const h = await sha256Hex(plain);

    const out = await restore.decryptBlob(KEY, h, await plugin.encryptBlob(h, plain));
    expect(new Uint8Array(out)).toEqual(plain);
  });

  it("decrypts the manifest path map the plugin produced", async () => {
    const plugin = await VaultCrypto.create(KEY);
    const files = {
      "daily/2026-08-03.md": { h: "a".repeat(64), size: 12, mtime: 1, c: "b".repeat(64) },
      "private/therapy.md": { h: "c".repeat(64), size: 34, mtime: 2, c: "d".repeat(64) },
    };
    expect(await restore.decryptManifestMap(KEY, await plugin.encryptJson(files))).toEqual(files);
  });

  it("computes the same v3 envelope the plugin does, byte for byte", async () => {
    // restore.mjs re-implements the crypto on purpose, so a restore does not depend on the
    // plugin still working. That only holds while the two agree: the AAD string is now part
    // of the contract, and a one-character drift makes every v3 snapshot un-restorable.
    const envelope = {
      v: 3,
      id: "01JJJJJJJJJJJJJJJJJJJJJJJJ",
      parent: "01KKKKKKKKKKKKKKKKKKKKKKKK",
      device: "laptop",
      createdAt: "2026-08-11T00:00:00.000Z",
      keyId: "0011223344556677",
      blobs: ["a".repeat(64), "b".repeat(64)],
    };
    expect(restore.manifestAad(envelope)).toBe(manifestAad(envelope));
  });

  it("decrypts a v3 path map the plugin produced, and refuses a swapped envelope", async () => {
    const plugin = await VaultCrypto.create(KEY);
    const envelope = {
      v: 3,
      id: "01JJJJJJJJJJJJJJJJJJJJJJJJ",
      parent: null,
      device: "laptop",
      createdAt: "2026-08-11T00:00:00.000Z",
      keyId: plugin.keyId,
      blobs: ["e".repeat(64)],
    };
    const files = { "note.md": { h: "f".repeat(64), size: 3, mtime: 4, c: "e".repeat(64) } };
    const enc = await plugin.encryptJson(files, manifestAad(envelope));

    expect(await restore.decryptManifestMap(KEY, enc, restore.manifestAad(envelope))).toEqual(files);
    await expect(
      restore.decryptManifestMap(KEY, enc, restore.manifestAad({ ...envelope, device: "impostor" }))
    ).rejects.toThrow(/failed authentication/);
  });

  it("refuses the wrong master key on both blobs and manifests", async () => {
    const plugin = await VaultCrypto.create(KEY);
    const plain = bytes("private");
    const h = await sha256Hex(plain);

    await expect(
      restore.decryptBlob(OTHER_KEY, h, await plugin.encryptBlob(h, plain))
    ).rejects.toThrow(/failed authentication/);
    await expect(
      restore.decryptManifestMap(OTHER_KEY, await plugin.encryptJson({ a: 1 }))
    ).rejects.toThrow(/failed authentication/);
  });

  it("parses the same master key format the plugin generates", async () => {
    const generated = generateMasterKey();
    expect(new Uint8Array(restore.parseMasterKey(generated))).toEqual(parseMasterKey(generated));
  });

  it("independently derives the same passphrase key as the plugin", async () => {
    const salt = toBase64(new Uint8Array([...Array(16).keys()]));
    const fromPlugin = parseMasterKey(
      await deriveMasterKeyFromPassphrase("correct horse battery staple", salt)
    );
    expect(
      await restore.deriveMasterKeyFromPassphrase("correct horse battery staple", salt)
    ).toEqual(fromPlugin);
  });

  it("matches the Unicode PBKDF2 known vector without logging or returning a passphrase", async () => {
    const derived = await restore.deriveMasterKeyFromPassphrase(
      "pāssphrase 🔐",
      "ABEiM0RVZneImaq7zN3u/w=="
    );
    expect(toBase64(derived)).toBe("KbJW45as4BM/VS40KOzr9Oasd8UMJ2xxjAI3jVGP45w=");
  });
});

describe("restore.mjs encrypted credential selection", () => {
  const salt = toBase64(new Uint8Array(16).fill(3));

  it("accepts exactly a raw key or a passphrase plus salt", async () => {
    const raw = generateMasterKey();
    expect(await restore.resolveMasterKeyInput({ masterKey: raw })).toEqual(parseMasterKey(raw));
    expect(
      await restore.resolveMasterKeyInput({ passphrase: "long private phrase", vaultSalt: salt })
    ).toEqual(await restore.deriveMasterKeyFromPassphrase("long private phrase", salt));
  });

  it("fails loudly on missing, mixed, or incomplete inputs", async () => {
    await expect(restore.resolveMasterKeyInput({})).rejects.toThrow(/exactly one/);
    await expect(
      restore.resolveMasterKeyInput({
        masterKey: generateMasterKey(),
        passphrase: "phrase",
        vaultSalt: salt,
      })
    ).rejects.toThrow(/exactly one/);
    await expect(restore.resolveMasterKeyInput({ passphrase: "phrase" })).rejects.toThrow(
      /vault salt/
    );
    await expect(
      restore.resolveMasterKeyInput({ passphrase: "", vaultSalt: salt })
    ).rejects.toThrow(/passphrase is empty/);
    await expect(
      restore.resolveMasterKeyInput({ passphrase: "phrase", vaultSalt: "not base64" })
    ).rejects.toThrow(/vault salt.*base64/);
    await expect(restore.resolveMasterKeyInput({ vaultSalt: salt })).rejects.toThrow(/passphrase/);
    await expect(
      restore.resolveMasterKeyInput({ masterKey: generateMasterKey(), vaultSalt: salt })
    ).rejects.toThrow(/vault salt.*passphrase/i);
  });

  it("treats --passphrase only as a mode flag and rejects secrets in argv", () => {
    expect(restore.passphraseModeRequested(["node", "restore.mjs"])).toBe(false);
    expect(
      restore.passphraseModeRequested([
        "node",
        "restore.mjs",
        "--passphrase",
        "--salt",
        salt,
      ])
    ).toBe(true);
    expect(() =>
      restore.passphraseModeRequested(["node", "restore.mjs", "--passphrase=secret"])
    ).toThrow(/mode flag/);
    expect(() =>
      restore.passphraseModeRequested(["node", "restore.mjs", "--passphrase", "secret"])
    ).toThrow(/mode flag/);
    expect(() =>
      restore.passphraseModeRequested([
        "node",
        "restore.mjs",
        "--passphrase",
        "--passphrase",
      ])
    ).toThrow(/only be supplied once/);
  });
});

describe("restore.mjs path safety", () => {
  it("accepts ordinary vault paths", () => {
    expect(restore.assertSafePath("daily/2026-08-03.md")).toBe("daily/2026-08-03.md");
    expect(restore.assertSafePath("note.md")).toBe("note.md");
  });

  it("rejects anything that could escape the output directory", () => {
    for (const bad of ["", "/etc/passwd", "../escape.md", "a/../../b.md", "a//b.md", "a\\b.md", "./x.md"]) {
      expect(() => restore.assertSafePath(bad)).toThrow(/unsafe path/);
    }
  });

  it("rejects control characters in paths", () => {
    const ctrl = (code: number) => `a${String.fromCharCode(code)}b.md`;
    for (const code of [0x00, 0x09, 0x0a, 0x1f, 0x7f]) {
      expect(() => restore.assertSafePath(ctrl(code))).toThrow(/unsafe path/);
    }
  });

  it("refuses a pre-existing directory symlink under the output root", async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "log-sync-restore-"));
    const out = path.join(sandbox, "out");
    const escaped = path.join(sandbox, "escaped");
    await mkdir(out);
    await mkdir(escaped);
    await symlink(escaped, path.join(out, "notes"));

    try {
      await expect(
        restore.writeFileSafely(out, "notes/private.md", bytes("must stay inside"))
      ).rejects.toThrow(/symbolic link/);
      await expect(readFile(path.join(escaped, "private.md"))).rejects.toThrow();
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("refuses a pre-existing file symlink at the final target", async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "log-sync-restore-"));
    const out = path.join(sandbox, "out");
    const escaped = path.join(sandbox, "escaped.md");
    await mkdir(out);
    await symlink(escaped, path.join(out, "note.md"));

    try {
      await expect(restore.writeFileSafely(out, "note.md", bytes("secret"))).rejects.toThrow();
      await expect(readFile(escaped)).rejects.toThrow();
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
