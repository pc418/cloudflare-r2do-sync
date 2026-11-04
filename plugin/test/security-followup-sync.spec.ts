import { describe, it, expect, beforeEach } from "vitest";
import { SyncEngine } from "../src/sync";
import { FakeServer, FakeStore, FakeVault } from "./fakes";
import { VaultCrypto } from "../src/crypto";
import { sha256Hex } from "../src/hash";
import {
  alwaysSkip,
  isConfigCodePath,
  isConfigPath,
  isUnderDir,
  makeScopeFilter,
  pruneCandidates,
  selfDirs,
} from "../src/paths";
import { buildManifest, parseFileEntries, parseManifest, type FileEntry, type Manifest } from "../src/types";

let vault: FakeVault;
let server: FakeServer;
let store: FakeStore;
let seq = 0;

function makeEngine(overrides: Partial<ConstructorParameters<typeof SyncEngine>[0]> = {}) {
  return new SyncEngine({
    vault,
    api: server,
    store,
    deviceName: "test-device",
    excludes: [],
    maxBlobBytes: 1024,
    now: () => 1_754_000_000_000,
    ...overrides,
  });
}

beforeEach(() => {
  vault = new FakeVault();
  server = new FakeServer();
  store = new FakeStore();
  seq = 0;
});

const bytes = (s: string) => new TextEncoder().encode(s);
const keyOf = (fill: number) =>
  VaultCrypto.fromText(btoa(String.fromCharCode(...new Uint8Array(32).fill(fill))));

function nextId(): string {
  seq++;
  return `01SECFOLLOWUP${String(seq).padStart(13, "0")}`;
}

/** A v3 snapshot written by a device holding `crypto`, on top of the server's head. */
async function encryptedCommit(crypto: VaultCrypto, files: Record<string, string>): Promise<{
  id: string;
  entries: Record<string, FileEntry>;
}> {
  const entries: Record<string, FileEntry> = {};
  for (const [path, content] of Object.entries(files)) {
    const plain = bytes(content);
    const h = await sha256Hex(plain);
    const cipher = await crypto.encryptBlob(h, plain);
    const c = await sha256Hex(cipher);
    server.blobs.set(c, cipher);
    entries[path] = { h, size: plain.byteLength, mtime: 1_754_000_000_000, c };
  }
  const id = nextId();
  const manifest = await buildManifest({
    crypto,
    parent: server.head,
    files: entries,
    blobs: [...new Set(Object.values(entries).map((e) => e.c!))],
    id,
    device: "laptop",
    createdAt: "2026-11-01T00:00:00.000Z",
  });
  server.manifests.set(id, manifest);
  server.head = id;
  return { id, entries };
}

/**
 * A v1 snapshot the server (or anything that can answer for it) invented. Nothing authenticates
 * a v1 path map, so it can name any path and point it at any blob — including a genuine
 * encrypted blob of this vault, which this device's key then opens without complaint.
 */
function forgedV1(files: Record<string, FileEntry>): string {
  const id = nextId();
  const manifest: Manifest = {
    v: 1,
    id,
    parent: server.head,
    device: "laptop",
    createdAt: "2026-10-01T00:00:00.000Z",
    files,
  };
  server.manifests.set(id, manifest);
  server.head = id;
  return id;
}

function snapshotVault(): Map<string, string> {
  return new Map([...vault.files].map(([p, f]) => [p, new TextDecoder().decode(f.data)]));
}

describe("per-file history restore takes content only from a snapshot this device can trust", () => {
  async function chain() {
    const ours = await keyOf(7);
    const other = await keyOf(8);
    // Oldest first: a plaintext snapshot that re-paths a genuine encrypted blob of this vault
    // under a config path and a note path, then one under another key, then our own.
    const genuine = await encryptedCommit(ours, { "secret.md": "the real secret" });
    const repathed = genuine.entries["secret.md"];
    const v1 = forgedV1({
      "note.md": repathed,
      ".obsidian/snippets/x.css": repathed,
    });
    const foreign = (await encryptedCommit(other, { "note.md": "other key's note" })).id;
    const recent = (await encryptedCommit(ours, { "note.md": "compatible version" })).id;
    return { ours, v1, foreign, recent };
  }

  it("refuses to preview or restore a v1 snapshot on an encrypted device, writing nothing", async () => {
    const { ours, v1 } = await chain();
    const engine = makeEngine({ crypto: ours });
    vault.set("note.md", "local current");
    const before = snapshotVault();
    const localHash = await sha256Hex(bytes("local current"));
    vault.writes.length = 0;

    await expect(engine.snapshotFiles(v1)).rejects.toThrow(/unencrypted/);
    await expect(engine.inspectRestore(v1, "note.md")).rejects.toThrow(/unencrypted/);
    await expect(
      engine.restoreFile(v1, "note.md", { overwrite: true, expectedHash: localHash })
    ).rejects.toThrow(/unencrypted/);
    // A free destination is the case nothing else would have stopped.
    await expect(engine.restoreFile(v1, ".obsidian/snippets/x.css")).rejects.toThrow(/unencrypted/);
    await expect(
      engine.restoreFile(v1, "note.md", { destination: "elsewhere.md" })
    ).rejects.toThrow(/unencrypted/);

    expect(snapshotVault()).toEqual(before);
    expect(vault.writes).toEqual([]);
    expect(server.downloads).toEqual([]);
  });

  it("refuses to preview or restore a snapshot under another key, writing nothing", async () => {
    const { ours, foreign } = await chain();
    const engine = makeEngine({ crypto: ours });
    vault.set("note.md", "local current");
    const before = snapshotVault();
    const localHash = await sha256Hex(bytes("local current"));
    vault.writes.length = 0;

    await expect(engine.snapshotFiles(foreign)).rejects.toThrow(/different master key/);
    await expect(engine.inspectRestore(foreign, "note.md")).rejects.toThrow(/different master key/);
    await expect(
      engine.restoreFile(foreign, "note.md", { overwrite: true, expectedHash: localHash })
    ).rejects.toThrow(/different master key/);

    expect(snapshotVault()).toEqual(before);
    expect(vault.writes).toEqual([]);
  });

  it("still previews and restores the compatible snapshot", async () => {
    const { ours, recent } = await chain();
    const engine = makeEngine({ crypto: ours });
    vault.set("note.md", "local current");
    const localHash = await sha256Hex(bytes("local current"));

    expect(Object.keys(await engine.snapshotFiles(recent))).toEqual(["note.md"]);
    const seen = await engine.inspectRestore(recent, "note.md");
    expect(seen.current).toBe("differs");
    const out = await engine.restoreFile(recent, "note.md", {
      overwrite: true,
      expectedHash: localHash,
    });

    expect(out.kind).toBe("replaced");
    expect(vault.text("note.md")).toBe("compatible version");
  });

  it("keeps the whole listing, marking only the incompatible rows unreadable", async () => {
    for (const indexed of [false, true]) {
      server = new FakeServer();
      const { ours, v1, foreign, recent } = await chain();
      server.serveHistoryIndex = indexed;
      const engine = makeEngine({ crypto: ours });

      const rows = (await engine.listHistory(10, { changes: true })).rows;

      expect(rows.map((r) => r.id)).toEqual([recent, foreign, v1, rows[3].id]);
      expect(rows.map((r) => r.readable)).toEqual([true, false, false, true]);
      // The forged map's paths are not shown as if they were this vault's history.
      expect(rows[2].fileCount).toBeNull();
      expect(rows[2].changes).toEqual({ unknown: "unreadable" });
    }
  });

  it("a plaintext device still restores plaintext history", async () => {
    const engine = makeEngine();
    vault.set("a.md", "one");
    await engine.sync();
    const first = server.head!;
    vault.set("a.md", "two", 1_754_000_100_000);
    await engine.sync();

    expect((await engine.inspectRestore(first, "a.md")).current).toBe("differs");
    await engine.restoreFile(first, "a.md", { destination: "copy.md" });
    expect(vault.text("copy.md")).toBe("one");
  });
});

describe("restoreAll checks the snapshot's mode before reconciling the vault", () => {
  it("refuses an empty v1 snapshot on an encrypted device and keeps the local note", async () => {
    const ours = await keyOf(7);
    await encryptedCommit(ours, { "note.md": "encrypted era" });
    const empty = forgedV1({});
    const engine = makeEngine({ crypto: ours });
    vault.set("note.md", "local note");
    vault.writes.length = 0;
    vault.removes.length = 0;

    await expect(engine.restoreAll(empty)).rejects.toThrow(/unencrypted/);

    expect(vault.text("note.md")).toBe("local note");
    expect(vault.removes).toEqual([]);
    expect(vault.writes).toEqual([]);
  });

  it("refuses a non-empty v1 snapshot and one under another key on an encrypted device", async () => {
    const ours = await keyOf(7);
    const genuine = await encryptedCommit(ours, { "secret.md": "the real secret" });
    const v1 = forgedV1({ "note.md": genuine.entries["secret.md"] });
    const foreign = (await encryptedCommit(await keyOf(8), { "note.md": "x" })).id;
    const engine = makeEngine({ crypto: ours });
    vault.set("note.md", "local note");
    vault.set("other.md", "kept");
    const before = snapshotVault();

    await expect(engine.restoreAll(v1)).rejects.toThrow(/unencrypted/);
    await expect(engine.restoreAll(foreign)).rejects.toThrow(/different master key/);

    expect(snapshotVault()).toEqual(before);
  });

  it("restores a matching encrypted snapshot", async () => {
    const ours = await keyOf(7);
    const { id } = await encryptedCommit(ours, { "note.md": "from snapshot" });
    const engine = makeEngine({ crypto: ours });
    vault.set("note.md", "local note");
    vault.set("stray.md", "not in the snapshot");

    const res = await engine.restoreAll(id);

    expect(res).toEqual({ written: 1, removed: 1 });
    expect(vault.text("note.md")).toBe("from snapshot");
    expect(vault.files.has("stray.md")).toBe(false);
  });

  it("a plaintext device still restores an empty plaintext snapshot", async () => {
    const empty = forgedV1({});
    const engine = makeEngine();
    vault.set("note.md", "local note");

    const res = await engine.restoreAll(empty);

    expect(res).toEqual({ written: 0, removed: 1 });
    expect(vault.files.has("note.md")).toBe(false);
  });

  it("a plaintext device refuses an encrypted snapshot without touching the vault", async () => {
    const { id } = await encryptedCommit(await keyOf(7), { "note.md": "x" });
    const engine = makeEngine();
    vault.set("note.md", "local note");
    const before = snapshotVault();

    await expect(engine.restoreAll(id)).rejects.toThrow(/no vault master key/);

    expect(snapshotVault()).toEqual(before);
  });
});

describe("file entries carry a lowercase sha256 hex content hash", () => {
  const v1 = (h: unknown) => ({
    v: 1,
    id: "01ABCDEFGHJKMNPQRSTVWXYZ00",
    parent: null,
    device: "d",
    createdAt: "2026-11-01T00:00:00.000Z",
    files: { "a.md": { h, size: 1, mtime: 1 } },
  });

  it("accepts what the plaintext, encrypted and migration writers produce", async () => {
    const plain = makeEngine();
    vault.set("a.md", "alpha");
    vault.set("b.bin", new Uint8Array([0, 1, 2, 255]));
    await plain.sync();
    const written = server.manifests.get(server.head!)!;
    expect(written.v).toBe(1);
    expect(() => parseManifest(JSON.parse(JSON.stringify(written)))).not.toThrow();

    const ours = await keyOf(7);
    await plain.migrateEncryption(ours);
    const migrated = makeEngine({ crypto: ours });
    expect(Object.keys(await migrated.snapshotFiles(server.head!)).sort()).toEqual(["a.md", "b.bin"]);

    vault.set("c.md", "gamma", 1_754_000_100_000);
    const encrypted = makeEngine({ crypto: ours });
    await encrypted.sync();
    expect(server.manifests.get(server.head!)!.v).toBe(3);
    const files = await encrypted.snapshotFiles(server.head!);
    expect(Object.keys(files).sort()).toEqual(["a.md", "b.bin", "c.md"]);
    for (const entry of Object.values(files)) expect(entry.h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a non-hex, wrong-length or uppercase h in a plaintext manifest", () => {
    expect(() => parseManifest(v1("a".repeat(64)))).not.toThrow();
    for (const bad of ["x", "g".repeat(64), "a".repeat(63), "a".repeat(65), "A".repeat(64), "../a", ""]) {
      expect(() => parseManifest(v1(bad))).toThrow(/entry "a.md" is malformed/);
    }
  });

  it("rejects the same inside a decrypted path map", () => {
    expect(() => parseFileEntries({ "a.md": { h: "0".repeat(64), size: 1, mtime: 1 } })).not.toThrow();
    for (const bad of ["x", "F".repeat(64), "f".repeat(32)]) {
      expect(() => parseFileEntries({ "a.md": { h: bad, size: 1, mtime: 1 } })).toThrow(/malformed/);
    }
  });
});

describe("8.3 short names of the config directory are treated as the config root", () => {
  it("classifies OBSIDI~1 as the default config directory, in any case and with a stream suffix", () => {
    for (const root of ["OBSIDI~1", "obsidi~1", "Obsidi~1", "OBSIDI~2", "OBSIDI~1:stream", "OBSIDI~1::$INDEX_ALLOCATION"]) {
      expect(alwaysSkip(`${root}/plugins/x/main.js`)).toBe(true);
      expect(isConfigCodePath(`${root}/themes/t/theme.css`)).toBe(true);
      expect(alwaysSkip(`${root}/community-plugins.json`)).toBe(true);
      expect(alwaysSkip(`${root}/workspace.json`)).toBe(true);
      expect(alwaysSkip(`${root}/plugins/cloudflare-rdo-sync/data.json`)).toBe(true);
      expect(isConfigPath(`${root}/app.json`)).toBe(true);
      expect(makeScopeFilter({ excludes: [], onlyPaths: [], syncConfigDir: false })(`${root}/app.json`)).toBe(false);
    }
    // Shorter prefixes, as Windows uses once the number grows past one digit.
    expect(alwaysSkip("OBSID~12/plugins/x/main.js")).toBe(true);
    expect(pruneCandidates(["OBSIDI~1/plugins/cloudflare-rdo-sync/x/y.md"], ".obsidian")).not.toContain(
      "OBSIDI~1/plugins/cloudflare-rdo-sync"
    );
  });

  it("only at the first segment, and only for a prefix of the config directory's name", () => {
    expect(alwaysSkip("notes/OBSIDI~1/plugins/x/main.js")).toBe(false);
    expect(isConfigPath("notes/OBSIDI~1/app.json")).toBe(false);
    for (const root of ["NOTES~1", "OBSIDX~1", "OBSIDIA~1", "OBSIDI~", "OBSIDI~X", "OBSIDI1", "~1"]) {
      expect(alwaysSkip(`${root}/plugins/x/main.js`)).toBe(false);
      expect(isConfigPath(`${root}/app.json`)).toBe(false);
    }
    expect(isUnderDir("OBSIDI~1/plugins/x", "notes/plugins")).toBe(false);
  });

  it("follows a custom config directory, and still covers the default one", () => {
    const custom = ".config-x";
    for (const root of ["CONFIG~1", "config~1", "CONFI~10"]) {
      expect(alwaysSkip(`${root}/plugins/x/main.js`, custom)).toBe(true);
      expect(alwaysSkip(`${root}/plugins/cloudflare-rdo-sync/data.json`, custom)).toBe(true);
      expect(isConfigPath(`${root}/app.json`, custom)).toBe(true);
    }
    // `selfDirs` keeps the default directory for a renamed vault, and so does its short name.
    expect(alwaysSkip("OBSIDI~1/plugins/cloudflare-rdo-sync/data.json", custom)).toBe(true);
    expect(selfDirs(custom).some((dir) => isUnderDir("OBSIDI~1/plugins/cloudflare-rdo-sync/data.json", dir))).toBe(true);
    // The consent predicate is the active directory only, short name included.
    expect(isConfigPath("OBSIDI~1/app.json", custom)).toBe(false);
    expect(alwaysSkip("OTHER~1/plugins/x/main.js", custom)).toBe(false);
  });

  it("keeps the restore destination rule closed under the short name", () => {
    const engine = makeEngine();
    expect(engine.restoreDestinationBlock("OBSIDI~1/plugins/cloudflare-rdo-sync/data.json")).toMatch(
      /this plugin's own folder/
    );
    expect(engine.restoreDestinationBlock("notes/OBSIDI~1/plugins/cloudflare-rdo-sync/data.json")).toBeNull();
  });
});
