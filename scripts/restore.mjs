#!/usr/bin/env node
// Restores a vault snapshot from the sync server to a local directory, decrypting it.
//
//   node scripts/restore.mjs --out ./restored [--head <manifest-id>] [--url <worker-url>]
//   node scripts/restore.mjs --out ./restored --passphrase --salt <base64-vault-salt>
//   node scripts/restore.mjs --out ./restored --plaintext      (an unencrypted vault only)
//   node scripts/restore.mjs --out ./restored --legacy-v2      (accept an unauthenticated v2 head)
//
// Credentials come from the environment (ACCESS_TOKEN and either MASTER_KEY or
// VAULT_PASSPHRASE) or a hidden prompt, so they stay out of shell history. `--passphrase` is
// a mode flag, never a secret value; its public salt comes from --salt or VAULT_SALT.
//
// This deliberately re-implements the crypto rather than importing the plugin's TypeScript:
// disaster recovery must not depend on the thing that failed. plugin/test/restore.spec.ts
// proves the two implementations agree.
import { pbkdf2, webcrypto } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const subtle = webcrypto.subtle;
const SALT = new TextEncoder().encode("obsidian-log-sync/hkdf/v1");
const IV_BYTES = 12;
const ZERO_IV = new Uint8Array(IV_BYTES);
const CONTROL_RE = new RegExp("[\\u0000-\\u001f\\u007f]");
const PBKDF2_ITERATIONS = 600_000;
const VAULT_SALT_MIN_BYTES = 16;
const pbkdf2Async = promisify(pbkdf2);

function parseVaultSalt(text) {
  const trimmed = String(text).trim();
  if (!trimmed) throw new Error("vault salt is empty");
  const raw = Buffer.from(trimmed, "base64");
  if (raw.toString("base64") !== trimmed) {
    throw new Error("vault salt must use canonical base64");
  }
  if (raw.length < VAULT_SALT_MIN_BYTES) {
    throw new Error(`vault salt must be at least ${VAULT_SALT_MIN_BYTES} bytes, got ${raw.length}`);
  }
  return raw;
}

/** Independent Node implementation of the plugin's PBKDF2 master-key derivation. */
export async function deriveMasterKeyFromPassphrase(passphrase, vaultSalt) {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new Error("passphrase is empty");
  }
  const salt = parseVaultSalt(vaultSalt);
  const derived = await pbkdf2Async(
    Buffer.from(passphrase, "utf8"),
    salt,
    PBKDF2_ITERATIONS,
    32,
    "sha256"
  );
  return new Uint8Array(derived);
}

/** Resolves exactly one encrypted-vault credential form without retaining the passphrase. */
export async function resolveMasterKeyInput({ masterKey, passphrase, vaultSalt }) {
  const hasMasterKey = masterKey !== undefined;
  const hasPassphrase = passphrase !== undefined;
  const hasVaultSalt = vaultSalt !== undefined;

  if (hasMasterKey && hasPassphrase) {
    throw new Error("supply exactly one of a raw master key or a passphrase plus vault salt");
  }
  if (hasMasterKey) {
    if (hasVaultSalt) throw new Error("vault salt may only be supplied with a passphrase");
    return parseMasterKey(masterKey);
  }
  if (hasPassphrase) {
    if (!hasVaultSalt) throw new Error("passphrase restore requires a vault salt");
    return deriveMasterKeyFromPassphrase(passphrase, vaultSalt);
  }
  if (hasVaultSalt) throw new Error("vault salt requires a passphrase");
  throw new Error("supply exactly one of a raw master key or a passphrase plus vault salt");
}

export async function deriveBits(master, info, bytes) {
  const base = await subtle.importKey("raw", master, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: new TextEncoder().encode(info) },
    base,
    bytes * 8
  );
  return new Uint8Array(bits);
}

async function deriveAesKey(master, info) {
  const raw = await deriveBits(master, info, 32);
  return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
}

export async function keyIdOf(master) {
  return Buffer.from(await deriveBits(master, "keyid", 8)).toString("hex");
}

export async function sha256Hex(bytes) {
  return Buffer.from(await subtle.digest("SHA-256", bytes)).toString("hex");
}

/** Decrypts one file's bytes. The key is derived from the expected plaintext hash, so a
 *  substituted blob fails the GCM tag rather than yielding wrong content. */
export async function decryptBlob(master, plainHash, cipher) {
  const key = await deriveAesKey(master, `blob:${plainHash}`);
  try {
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: ZERO_IV }, key, cipher));
  } catch {
    throw new Error(`blob ${plainHash} failed authentication (wrong key or corrupted data)`);
  }
}

/**
 * The envelope a v3 snapshot authenticates. Must stay byte-identical to `manifestAad` in
 * plugin/src/crypto.ts — plugin/test/restore.spec.ts is what keeps the two honest.
 */
export function manifestAad(envelope) {
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

/**
 * Decrypts the manifest's path map. `aad` is supplied for v3 snapshots, whose ciphertext
 * also authenticates the header it arrived in; v2 has no such binding and passes undefined.
 */
export async function decryptManifestMap(master, enc, aad) {
  if (enc.alg !== "AES-GCM") throw new Error(`unsupported manifest cipher "${enc.alg}"`);
  const key = await deriveAesKey(master, "manifest");
  const params = { name: "AES-GCM", iv: Buffer.from(enc.iv, "base64") };
  if (aad !== undefined) params.additionalData = Buffer.from(aad, "utf8");
  let plain;
  try {
    plain = await subtle.decrypt(params, key, Buffer.from(enc.data, "base64"));
  } catch {
    throw new Error("manifest failed authentication (wrong master key or corrupted data)");
  }
  return JSON.parse(Buffer.from(plain).toString("utf8"));
}

export function parseMasterKey(text) {
  const raw = Buffer.from(String(text).trim(), "base64");
  if (raw.length !== 32) throw new Error(`master key must be 32 bytes, got ${raw.length}`);
  return new Uint8Array(raw);
}

/** Rejects anything that would write outside the output directory. */
export function assertSafePath(p) {
  if (p === "" || p.startsWith("/") || p.includes("\\") || CONTROL_RE.test(p)) {
    throw new Error(`unsafe path in manifest: ${JSON.stringify(p)}`);
  }
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new Error(`unsafe path in manifest: ${JSON.stringify(p)}`);
    }
  }
  return p;
}

function isLoopbackHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host === "::1") return true;
  const octets = host.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function normalizeServerUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value).trim());
  } catch {
    throw new Error("worker URL must be a valid http(s) URL");
  }
  if (parsed.username || parsed.password) throw new Error("worker URL must not contain credentials");
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("worker URL must be http(s)");
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error("worker URL must use HTTPS (HTTP is allowed only for explicit loopback hosts)");
  }
  return parsed.toString().replace(/\/+$/, "");
}

async function lstatIfPresent(target) {
  try {
    return await lstat(target);
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Writes beneath outDir without following pre-existing symlinks in the manifest path.
 *
 * The final `open()` carries `O_NOFOLLOW`, so the file itself cannot be swapped for a link
 * between the check and the write. The *parent directory* checks are ordinary
 * check-then-use: an attacker with write access to `outDir` while a restore is running could
 * replace an already-verified directory with a symlink and land bytes outside the tree. That
 * window is accepted because restore targets a directory the operator names and owns,
 * usually a fresh one. Point it at a shared or world-writable directory and the assumption
 * is gone — which would call for descriptor-relative traversal (`openat`-style, holding each
 * parent's fd and resolving the next segment against it) rather than path-based `lstat`.
 */
export async function writeFileSafely(outDir, vaultPath, bytes) {
  assertSafePath(vaultPath);
  await mkdir(outDir, { recursive: true });
  const rootStat = await lstat(outDir);
  if (rootStat.isSymbolicLink()) throw new Error(`output directory is a symbolic link: ${outDir}`);
  if (!rootStat.isDirectory()) throw new Error(`output path is not a directory: ${outDir}`);

  const segments = vaultPath.split("/");
  let directory = outDir;
  for (const segment of segments.slice(0, -1)) {
    directory = path.join(directory, segment);
    let stat = await lstatIfPresent(directory);
    if (stat === null) {
      await mkdir(directory);
      stat = await lstat(directory);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to restore through symbolic link: ${directory}`);
    }
    if (!stat.isDirectory()) throw new Error(`restore parent is not a directory: ${directory}`);
  }

  const target = path.join(directory, segments.at(-1));
  const existing = await lstatIfPresent(target);
  if (existing?.isSymbolicLink()) throw new Error(`refusing to replace symbolic link: ${target}`);
  if (existing?.isDirectory()) throw new Error(`restore target is a directory: ${target}`);

  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o666
  );
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name) {
  const option = `--${name}`;
  const matches = process.argv.flatMap((value, index) => (value === option ? [index] : []));
  if (matches.length > 1) throw new Error(`${option} may only be supplied once`);
  if (matches.length === 0) return undefined;
  const value = process.argv[matches[0] + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

/**
 * Decides how a fetched snapshot may be restored, before any of it is trusted.
 *
 * The manifest's own `v` is server-controlled, so it cannot be what decides whether the
 * restore authenticates anything. A key-less holder of a sync token can commit a plaintext
 * v1 head onto an encrypted vault (the Worker cannot tell the modes apart), and restoring
 * that "as plaintext" would write an attacker-chosen tree with a clean exit while the key the
 * operator supplied went unused. Synced devices refuse exactly this mix (`#modeError`).
 *
 * So the operator states the mode: any key input means the vault is encrypted and only an
 * encrypted snapshot is accepted; a plaintext snapshot needs `--plaintext`, which in turn
 * refuses key inputs and encrypted snapshots. Anything that is not v1/v2/v3 is refused.
 *
 * v2 is encrypted but its clear header is not authenticated, so a key-less token holder can
 * lift a retained v2 path map under any header. It needs `--legacy-v2`, which relaxes only
 * that refusal: the keyId check and v3 authentication in `openEncryptedManifest` still apply.
 */
export function restoreMode({ version, keyInput, plaintext, legacyV2 = false }) {
  if (keyInput && plaintext) {
    throw new Error("--plaintext cannot be combined with a master key or passphrase");
  }
  if (version === 2 || version === 3) {
    if (plaintext) {
      throw new Error(`snapshot is encrypted (v${version}), but --plaintext was given`);
    }
    if (version === 2 && !legacyV2) {
      throw new Error(
        "snapshot is v2, whose header is not authenticated, so nothing proves it is a snapshot " +
          "your devices wrote. Pass --head with a known-good v3 snapshot id, or --legacy-v2 to " +
          "restore it anyway"
      );
    }
    return "encrypted";
  }
  if (version === 1) {
    if (keyInput) {
      throw new Error(
        "snapshot is unencrypted (v1), but a master key or passphrase was supplied: this vault " +
          "is encrypted, so an unencrypted head is not one its devices wrote. Refusing to restore it; " +
          "pass --head with a known-good snapshot id"
      );
    }
    if (!plaintext) {
      throw new Error("snapshot is unencrypted (v1); pass --plaintext to restore an unencrypted vault");
    }
    return "plaintext";
  }
  throw new Error(`snapshot has unsupported format version ${JSON.stringify(version)}`);
}

function modeFlagRequested(flag, argv) {
  const matches = argv.filter((value) => value === flag);
  if (matches.length > 1) throw new Error(`${flag} may only be supplied once`);
  return matches.length === 1;
}

export function plaintextModeRequested(argv = process.argv) {
  return modeFlagRequested("--plaintext", argv);
}

export function legacyV2Requested(argv = process.argv) {
  return modeFlagRequested("--legacy-v2", argv);
}

const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * The snapshot served must be the one asked for, whatever its format. Checked before the mode
 * is decided, so it holds for v1 as much as v2/v3: a plaintext restore has nothing else binding
 * the manifest to the id the operator named with `--head`, and restoring snapshot B as A is a
 * silent substitution even when every byte of B is genuine.
 */
export function assertServedSnapshot(manifest, requested) {
  const served = typeof manifest === "object" && manifest !== null ? manifest.id : undefined;
  if (typeof served !== "string" || served !== requested) {
    throw new Error(`invalid snapshot from server: asked for snapshot ${requested}, got ${JSON.stringify(served)}`);
  }
  return manifest;
}

/**
 * Checks an encrypted snapshot's envelope and opens its path map, before anything is written.
 *
 * The key must be the one the snapshot names (a wrong key is refused here, whatever flags were
 * given), the envelope must be the snapshot that was asked for, and a v3 path map is decrypted
 * with `manifestAad` over the envelope as it arrived — so a changed id, parent, device, time,
 * keyId or blob set fails authentication. Only `restoreMode` decides whether v2 is acceptable.
 */
export async function openEncryptedManifest(master, manifest, expectedId) {
  const fail = (why) => {
    throw new Error(`invalid snapshot from server: ${why}`);
  };
  if (typeof manifest !== "object" || manifest === null) fail("not an object");
  if (manifest.v !== 2 && manifest.v !== 3) fail(`not an encrypted snapshot (v${manifest.v})`);
  if (typeof manifest.id !== "string" || manifest.id !== expectedId) {
    fail(`asked for snapshot ${expectedId}, got ${JSON.stringify(manifest.id)}`);
  }
  if (manifest.parent !== null && typeof manifest.parent !== "string") fail("parent is malformed");
  if (typeof manifest.device !== "string") fail("device is missing");
  if (typeof manifest.createdAt !== "string") fail("createdAt is missing");
  if (typeof manifest.keyId !== "string") fail("keyId is missing");
  if (!Array.isArray(manifest.blobs) || manifest.blobs.some((h) => typeof h !== "string" || !HASH_RE.test(h))) {
    fail("blobs must be an array of sha256 hex digests");
  }
  const enc = manifest.enc;
  if (typeof enc !== "object" || enc === null || typeof enc.iv !== "string" || typeof enc.data !== "string") {
    fail("enc is malformed");
  }
  const expected = await keyIdOf(master);
  if (expected !== manifest.keyId) {
    throw new Error(`wrong master key: snapshot wants keyId ${manifest.keyId}, this key is ${expected}`);
  }
  const files = await decryptManifestMap(master, enc, manifest.v === 3 ? manifestAad(manifest) : undefined);
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    fail("decrypted snapshot is not a path map");
  }
  return files;
}

export function passphraseModeRequested(argv = process.argv) {
  if (argv.some((value) => value.startsWith("--passphrase="))) {
    throw new Error("--passphrase is a mode flag; do not put the passphrase in command arguments");
  }
  const matches = argv.filter((value) => value === "--passphrase");
  if (matches.length > 1) throw new Error("--passphrase may only be supplied once");
  const index = argv.indexOf("--passphrase");
  if (index !== -1) {
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      throw new Error("--passphrase is a mode flag; do not put the passphrase in command arguments");
    }
  }
  return index !== -1;
}

async function promptHidden(question, envVar, trim = true) {
  if (process.env[envVar] !== undefined) {
    return trim ? process.env[envVar].trim() : process.env[envVar];
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const original = rl._writeToOutput?.bind(rl);
  rl._writeToOutput = function (s) {
    if (s.includes(question)) original?.(s);
  };
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  process.stdout.write("\n");
  if (original) rl._writeToOutput = original;
  return trim ? answer.trim() : answer;
}

async function main() {
  const outDir = arg("out");
  if (!outDir) {
    console.error(
      "usage: node scripts/restore.mjs --out <dir> [--head <id>] [--url <worker-url>] [--passphrase --salt <base64> | --plaintext] [--legacy-v2]"
    );
    process.exit(2);
  }
  const suppliedUrl = arg("url") ?? process.env.WORKER_URL ?? "";
  if (!suppliedUrl) {
    console.error("no worker URL: pass --url or set WORKER_URL");
    process.exit(2);
  }
  const baseUrl = normalizeServerUrl(suppliedUrl);

  const token = await promptHidden("Access token (input hidden): ", "ACCESS_TOKEN");
  if (!token) {
    console.error("no access token supplied");
    process.exit(2);
  }

  const api = async (p, asBytes = false) => {
    const res = await fetch(`${baseUrl}${p}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GET ${p} -> HTTP ${res.status} ${await res.text()}`);
    return asBytes ? new Uint8Array(await res.arrayBuffer()) : res.json();
  };

  const head = arg("head") ?? (await api("/api/head")).head;
  if (!head) {
    console.error("remote vault has no head — nothing to restore");
    process.exit(1);
  }
  const manifest = assertServedSnapshot(await api(`/api/manifests/${head}`), head);
  console.log(`restoring snapshot ${head} (v${manifest.v}, ${manifest.device}, ${manifest.createdAt})`);

  let files;
  let master = null;
  const passphraseMode = passphraseModeRequested();
  const mode = restoreMode({
    version: manifest.v,
    keyInput:
      passphraseMode ||
      process.env.MASTER_KEY !== undefined ||
      process.env.VAULT_PASSPHRASE !== undefined,
    plaintext: plaintextModeRequested(),
    legacyV2: legacyV2Requested(),
  });
  if (mode === "encrypted") {
    const vaultSalt = arg("salt") ?? process.env.VAULT_SALT?.trim();
    if (passphraseMode) {
      master = await resolveMasterKeyInput({
        masterKey: process.env.MASTER_KEY?.trim(),
        passphrase: await promptHidden(
          "Vault passphrase (input hidden): ",
          "VAULT_PASSPHRASE",
          false
        ),
        vaultSalt,
      });
    } else {
      if (process.env.VAULT_PASSPHRASE !== undefined) {
        throw new Error("VAULT_PASSPHRASE requires the --passphrase mode flag");
      }
      master = await resolveMasterKeyInput({
        masterKey: await promptHidden("Vault master key (input hidden): ", "MASTER_KEY"),
        vaultSalt,
      });
    }
    files = await openEncryptedManifest(master, manifest, head);
  } else {
    files = manifest.files;
  }

  const entries = Object.entries(files);
  console.log(`${entries.length} file(s) -> ${outDir}`);
  let written = 0;
  for (const [vaultPath, entry] of entries) {
    assertSafePath(vaultPath);
    const stored = await api(`/api/blobs/${entry.c ?? entry.h}`, true);
    const plain = master ? await decryptBlob(master, entry.h, stored) : stored;
    const actual = await sha256Hex(plain);
    if (actual !== entry.h) {
      throw new Error(`content hash mismatch for "${vaultPath}": got ${actual}, expected ${entry.h}`);
    }
    await writeFileSafely(outDir, vaultPath, plain);
    written++;
  }
  console.log(`restored ${written} file(s) to ${path.resolve(outDir)}`);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`restore failed: ${e.message}`);
    process.exit(1);
  });
}
