import { describe, it, expect } from "vitest";
import { VaultCrypto, deriveMasterKeyFromPassphrase, generateMasterKey, manifestAad, parseMasterKey, toBase64 } from "../src/crypto";
import { sha256Hex } from "../src/hash";
import { buildManifest } from "../src/types";

// Resolve Node-only test helpers without adding Node globals to the browser plugin build.
const fs = await import(/* @vite-ignore */ "node:fs/promises" as string);
const os = await import(/* @vite-ignore */ "node:os" as string);
const path = (await import(/* @vite-ignore */ "node:path" as string)).default;
const { mkdtemp, mkdir, readFile, rm, symlink } = fs;
const { tmpdir } = os;
const proc = (await import(/* @vite-ignore */ "node:process" as string)).default as {
  execPath: string;
  env: Record<string, string | undefined>;
};

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
  plaintextModeRequested(argv?: string[]): boolean;
  legacyV2Requested(argv?: string[]): boolean;
  restoreMode(input: {
    version: unknown;
    keyInput: boolean;
    plaintext: boolean;
    legacyV2?: boolean;
  }): "encrypted" | "plaintext";
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

describe("restore.mjs snapshot mode", () => {
  it("decides the mode from what the operator supplied, never from the manifest alone", () => {
    expect(restore.restoreMode({ version: 3, keyInput: true, plaintext: false })).toBe("encrypted");
    expect(
      restore.restoreMode({ version: 2, keyInput: false, plaintext: false, legacyV2: true })
    ).toBe("encrypted");
    expect(restore.restoreMode({ version: 1, keyInput: false, plaintext: true })).toBe("plaintext");
  });

  it("refuses an unencrypted head when a key was supplied, or without --plaintext", () => {
    expect(() => restore.restoreMode({ version: 1, keyInput: true, plaintext: false })).toThrow(
      /unencrypted \(v1\).*master key or passphrase/
    );
    expect(() => restore.restoreMode({ version: 1, keyInput: false, plaintext: false })).toThrow(
      /--plaintext/
    );
  });

  it("refuses contradictory flags and unknown versions", () => {
    expect(() => restore.restoreMode({ version: 3, keyInput: false, plaintext: true })).toThrow(
      /encrypted \(v3\).*--plaintext/
    );
    expect(() => restore.restoreMode({ version: 1, keyInput: true, plaintext: true })).toThrow(
      /cannot be combined/
    );
    for (const version of [0, 4, "1", undefined, null]) {
      expect(() => restore.restoreMode({ version, keyInput: false, plaintext: true })).toThrow(
        /unsupported format version/
      );
    }
  });

  it("treats --plaintext as a single mode flag", () => {
    expect(restore.plaintextModeRequested(["node", "restore.mjs"])).toBe(false);
    expect(restore.plaintextModeRequested(["node", "restore.mjs", "--plaintext"])).toBe(true);
    expect(() =>
      restore.plaintextModeRequested(["node", "restore.mjs", "--plaintext", "--plaintext"])
    ).toThrow(/only be supplied once/);
  });

  it("end to end: a forged v1 head is refused when the operator holds the key, and nothing is written", async () => {
    const http = await import(/* @vite-ignore */ "node:http" as string);
    const { spawn } = await import(/* @vite-ignore */ "node:child_process" as string);
    const injected = bytes("INJECTED");
    const h = await sha256Hex(injected);
    const id = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
    const forged = {
      v: 1, id, parent: null, device: "x", createdAt: "2026-01-01T00:00:00.000Z",
      files: { "note.md": { h, size: injected.length, mtime: 0 } },
    };
    const server = http.createServer((req: { url: string }, res: {
      writeHead(s: number, h?: Record<string, string>): void; end(b?: string | Uint8Array): void;
    }) => {
      if (req.url === "/api/head") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ head: id })); }
      else if (req.url === `/api/manifests/${id}`) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(forged)); }
      else if (req.url === `/api/blobs/${h}`) { res.writeHead(200); res.end(injected); }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const dir = await mkdtemp(path.join(tmpdir(), "restore-mode-"));
    const run = (env: Record<string, string>, extra: string[] = []) =>
      new Promise<{ code: number; stderr: string }>((resolve) => {
        const child = spawn(
          proc.execPath,
          [new URL("../../scripts/restore.mjs", import.meta.url).pathname, "--out", path.join(dir, "out"), "--url", `http://127.0.0.1:${port}`, ...extra],
          { env: { PATH: proc.env.PATH ?? "", ACCESS_TOKEN: "dummy", ...env }, stdio: ["ignore", "pipe", "pipe"] }
        );
        let stderr = "";
        child.stderr.on("data", (d: Uint8Array) => (stderr += text(d)));
        child.on("close", (code: number) => resolve({ code, stderr }));
      });
    try {
      const keyed = await run({ MASTER_KEY: toBase64(KEY) });
      expect(keyed.code).not.toBe(0);
      expect(keyed.stderr).toMatch(/unencrypted \(v1\)/);
      await expect(readFile(path.join(dir, "out", "note.md"))).rejects.toThrow();

      const unflagged = await run({});
      expect(unflagged.code).not.toBe(0);
      expect(unflagged.stderr).toMatch(/--plaintext/);

      // The explicit opt-in still restores a genuinely unencrypted vault.
      const plain = await run({}, ["--plaintext"]);
      expect(plain.code).toBe(0);
      expect(text(await readFile(path.join(dir, "out", "note.md")))).toBe("INJECTED");
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

type Served = Record<string, string | Uint8Array>;

/** Serves fixed routes on loopback and runs the real CLI against them, as an operator would. */
async function withRestoreServer(
  routes: Served,
  body: (run: (env: Record<string, string>, extra?: string[]) => Promise<{ code: number; stderr: string }>, out: string) => Promise<void>
): Promise<void> {
  const http = await import(/* @vite-ignore */ "node:http" as string);
  const { spawn } = await import(/* @vite-ignore */ "node:child_process" as string);
  const server = http.createServer((req: { url: string }, res: {
    writeHead(s: number, h?: Record<string, string>): void; end(b?: string | Uint8Array): void;
  }) => {
    const hit = routes[req.url];
    if (hit === undefined) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, typeof hit === "string" ? { "content-type": "application/json" } : {});
    res.end(hit);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const dir = await mkdtemp(path.join(tmpdir(), "restore-integrity-"));
  const out = path.join(dir, "out");
  const run = (env: Record<string, string>, extra: string[] = []) =>
    new Promise<{ code: number; stderr: string }>((resolve) => {
      const child = spawn(
        proc.execPath,
        [new URL("../../scripts/restore.mjs", import.meta.url).pathname, "--out", out, "--url", `http://127.0.0.1:${port}`, ...extra],
        { env: { PATH: proc.env.PATH ?? "", ACCESS_TOKEN: "dummy", ...env }, stdio: ["ignore", "pipe", "pipe"] }
      );
      let stderr = "";
      child.stderr.on("data", (d: Uint8Array) => (stderr += text(d)));
      child.on("close", (code: number) => resolve({ code, stderr }));
    });
  try {
    await body(run, out);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("restore.mjs encrypted head integrity", () => {
  const ID = "01J00000000000000000000000";
  const PARENT = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
  const content = bytes("# genuine note\n");

  /** A snapshot the plugin itself produced: real `buildManifest`, real blob encryption. */
  async function pluginSnapshot(key: Uint8Array = KEY) {
    const plugin = await VaultCrypto.create(key);
    const h = await sha256Hex(content);
    const cipher = await plugin.encryptBlob(h, content);
    const c = await sha256Hex(cipher);
    const files = { "note.md": { h, size: content.length, mtime: 1, c } };
    const manifest = (await buildManifest({
      crypto: plugin, parent: PARENT, files, blobs: [c], id: ID, device: "laptop",
      createdAt: "2026-11-01T00:00:00.000Z",
    })) as unknown as Record<string, unknown>;
    return { plugin, manifest, files, cipher, c };
  }

  const routesFor = (manifest: Record<string, unknown>, c: string, cipher: Uint8Array): Served => ({
    "/api/head": JSON.stringify({ head: manifest.id }),
    [`/api/manifests/${String(manifest.id)}`]: JSON.stringify(manifest),
    [`/api/blobs/${c}`]: cipher,
  });

  it("restores a v3 snapshot the plugin produced", async () => {
    const { manifest, c, cipher } = await pluginSnapshot();
    expect(manifest.v).toBe(3);
    await withRestoreServer(routesFor(manifest, c, cipher), async (run, out) => {
      const result = await run({ MASTER_KEY: toBase64(KEY) });
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(text(await readFile(path.join(out, "note.md")))).toBe(text(content));
    });
  });

  it("refuses a v3 snapshot whose authenticated header was changed, writing nothing", async () => {
    const { manifest, c, cipher } = await pluginSnapshot();
    const altered: Record<string, unknown>[] = [
      { ...manifest, id: "01J11111111111111111111111" },
      { ...manifest, parent: null },
      { ...manifest, device: "impostor" },
      { ...manifest, createdAt: "2030-01-01T00:00:00.000Z" },
      { ...manifest, blobs: [c, "0".repeat(64)] },
    ];
    for (const forged of altered) {
      await withRestoreServer(routesFor(forged, c, cipher), async (run, out) => {
        // --legacy-v2 relaxes the v2 refusal only; it must not relax v3 authentication.
        for (const extra of [[], ["--legacy-v2"]]) {
          const result = await run({ MASTER_KEY: toBase64(KEY) }, extra);
          expect(result.code).not.toBe(0);
          expect(result.stderr).toMatch(/failed authentication/);
          await expect(readFile(path.join(out, "note.md"))).rejects.toThrow();
        }
      });
    }
  });

  it("refuses a head served under a different id than the one asked for", async () => {
    const { manifest, c, cipher } = await pluginSnapshot();
    const routes = routesFor(manifest, c, cipher);
    routes["/api/head"] = JSON.stringify({ head: "01J22222222222222222222222" });
    routes["/api/manifests/01J22222222222222222222222"] = JSON.stringify(manifest);
    await withRestoreServer(routes, async (run, out) => {
      const result = await run({ MASTER_KEY: toBase64(KEY) });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/asked for snapshot 01J22222222222222222222222/);
      await expect(readFile(path.join(out, "note.md"))).rejects.toThrow();
    });
  });

  it("refuses a v2 snapshot by default and restores it with --legacy-v2", async () => {
    const { plugin, files, c, cipher } = await pluginSnapshot();
    const v2 = {
      v: 2, id: ID, parent: PARENT, device: "laptop", createdAt: "2026-11-01T00:00:00.000Z",
      keyId: plugin.keyId, blobs: [c], enc: await plugin.encryptJson(files),
    };
    await withRestoreServer(routesFor(v2, c, cipher), async (run, out) => {
      const refused = await run({ MASTER_KEY: toBase64(KEY) });
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toMatch(/v2.*--legacy-v2/);
      await expect(readFile(path.join(out, "note.md"))).rejects.toThrow();

      const accepted = await run({ MASTER_KEY: toBase64(KEY) }, ["--legacy-v2"]);
      expect(accepted.stderr).toBe("");
      expect(accepted.code).toBe(0);
      expect(text(await readFile(path.join(out, "note.md")))).toBe(text(content));
    });
    expect(() => restore.restoreMode({ version: 2, keyInput: true, plaintext: false })).toThrow(
      /--legacy-v2/
    );
    expect(() =>
      restore.restoreMode({ version: 2, keyInput: false, plaintext: true, legacyV2: true })
    ).toThrow(/--plaintext/);
    expect(restore.legacyV2Requested(["node", "restore.mjs", "--legacy-v2"])).toBe(true);
    expect(() =>
      restore.legacyV2Requested(["node", "restore.mjs", "--legacy-v2", "--legacy-v2"])
    ).toThrow(/only be supplied once/);
  });

  it("refuses a key the snapshot does not name, whatever flags are given", async () => {
    const { plugin, manifest, files, c, cipher } = await pluginSnapshot();
    const v2 = {
      ...manifest, v: 2, enc: await plugin.encryptJson(files),
    };
    const otherKeyId = await restore.keyIdOf(OTHER_KEY);
    for (const served of [manifest, v2]) {
      await withRestoreServer(routesFor(served, c, cipher), async (run, out) => {
        const result = await run({ MASTER_KEY: toBase64(OTHER_KEY) }, ["--legacy-v2"]);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toMatch(/wrong master key/);
        await expect(readFile(path.join(out, "note.md"))).rejects.toThrow();
      });
    }
    // Relabelling the header to the operator's key does not help: the keyId is authenticated.
    await withRestoreServer(routesFor({ ...manifest, keyId: otherKeyId }, c, cipher), async (run, out) => {
      const result = await run({ MASTER_KEY: toBase64(OTHER_KEY) }, ["--legacy-v2"]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/failed authentication/);
      await expect(readFile(path.join(out, "note.md"))).rejects.toThrow();
    });
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
