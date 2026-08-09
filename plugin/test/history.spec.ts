import { describe, it, expect, beforeEach } from "vitest";
import { SyncEngine } from "../src/sync";
import { FakeServer, FakeStore, FakeVault } from "./fakes";
import { VaultCrypto } from "../src/crypto";

let vault: FakeVault;
let server: FakeServer;
let store: FakeStore;
let now: number;

function makeEngine(overrides: Partial<ConstructorParameters<typeof SyncEngine>[0]> = {}) {
  return new SyncEngine({
    vault,
    api: server,
    store,
    deviceName: "test-device",
    excludes: [".obsidian/**"],
    maxBlobBytes: 1024,
    now: () => now,
    ...overrides,
  });
}

beforeEach(() => {
  vault = new FakeVault();
  server = new FakeServer();
  store = new FakeStore();
  now = 1_754_000_000_000;
});

/** Three commits from this device, each a distinct vault state. */
async function threeCommits(engine: SyncEngine): Promise<string[]> {
  const heads: string[] = [];
  vault.set("a.md", "one");
  await engine.sync();
  heads.push(server.head!);

  vault.set("a.md", "two", 1_754_000_100_000);
  vault.set("b.md", "bee", 1_754_000_100_000);
  await engine.sync();
  heads.push(server.head!);

  vault.delete("b.md");
  vault.set("a.md", "three", 1_754_000_200_000);
  await engine.sync();
  heads.push(server.head!);
  return heads;
}

describe("SyncEngine.listHistory", () => {
  it("walks the chain from head, newest first", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);

    const history = await engine.listHistory(10);

    expect(history.map((h) => h.id)).toEqual([heads[2], heads[1], heads[0]]);
    expect(history.map((h) => h.fileCount)).toEqual([1, 2, 1]);
    expect(history[0].device).toBe("test-device");
    expect(history[0].readable).toBe(true);
  });

  it("stops at the requested limit rather than walking the whole chain", async () => {
    const engine = makeEngine();
    await threeCommits(engine);

    expect(await engine.listHistory(2)).toHaveLength(2);
  });

  it("returns nothing for an empty remote", async () => {
    expect(await makeEngine().listHistory(10)).toEqual([]);
  });

  it("stops cleanly when an ancestor has been garbage-collected", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    server.manifests.delete(heads[0]);

    const history = await engine.listHistory(10);

    expect(history.map((h) => h.id)).toEqual([heads[2], heads[1]]);
  });

  it("marks snapshots it cannot decrypt instead of throwing", async () => {
    const engine = makeEngine();
    vault.set("a.md", "one");
    await engine.sync();
    server.seedRemoteEncryptedCommit({ keyId: "not-our-key" });

    const history = await engine.listHistory(10);

    expect(history[0].readable).toBe(false);
    expect(history[0].fileCount).toBeNull();
    // The readable ancestor is still listed, so history stays usable.
    expect(history[1].readable).toBe(true);
  });
});

describe("SyncEngine.snapshotFiles", () => {
  it("lists the paths a snapshot held", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);

    expect(Object.keys(await engine.snapshotFiles(heads[1])).sort()).toEqual(["a.md", "b.md"]);
    expect(Object.keys(await engine.snapshotFiles(heads[2]))).toEqual(["a.md"]);
  });
});

describe("SyncEngine.restoreFile", () => {
  it("brings back a deleted file at its original path", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    expect(vault.files.has("b.md")).toBe(false);

    await engine.restoreFile(heads[1], "b.md");

    expect(vault.text("b.md")).toBe("bee");
  });

  it("replaces current content when restoring over a live file", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);

    await engine.restoreFile(heads[0], "a.md");

    expect(vault.text("a.md")).toBe("one");
  });

  it("refuses a path the snapshot never held rather than writing nothing silently", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);

    await expect(engine.restoreFile(heads[2], "b.md")).rejects.toThrow(/not in snapshot/);
  });

  it("refuses to restore a path this device would never sync", async () => {
    const engine = makeEngine({ excludes: [] });
    vault.set("a.md", "one");
    await engine.sync();
    await server.seedRemoteCommit({
      "a.md": "one",
      ".obsidian/plugins/obsidian-log-sync/data.json": "secret",
    });
    await engine.sync();

    await expect(
      engine.restoreFile(server.head!, ".obsidian/plugins/obsidian-log-sync/data.json")
    ).rejects.toThrow(/not synced/);
  });
});

describe("SyncEngine.restoreAll", () => {
  it("makes the vault match the snapshot, writing and removing as needed", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    vault.set("stray.md", "written after the snapshot");

    const res = await engine.restoreAll(heads[1]);

    expect(vault.text("a.md")).toBe("two");
    expect(vault.text("b.md")).toBe("bee");
    expect(vault.files.has("stray.md")).toBe(false);
    expect(res.written).toBe(2);
    expect(res.removed).toBe(1);
  });

  it("leaves excluded and always-skipped paths alone in both directions", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    vault.set(".obsidian/appearance.json", "{}");
    vault.set(".DS_Store", "junk");

    await engine.restoreAll(heads[1]);

    expect(vault.files.has(".obsidian/appearance.json")).toBe(true);
    expect(vault.files.has(".DS_Store")).toBe(true);
  });

  it("does not skip files whose content matches — restore is explicit, not a sync", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);

    const res = await engine.restoreAll(heads[2]);

    expect(res.written).toBe(1);
    expect(res.removed).toBe(0);
    expect(vault.text("a.md")).toBe("three");
  });

  it("fetches and verifies every blob before changing the vault", async () => {
    const engine = makeEngine();
    const id = await server.seedRemoteCommit({ "a.md": "snapshot a", "b.md": "snapshot b" });
    vault.set("a.md", "current a");
    vault.set("stray.md", "current stray");
    const manifest = server.manifests.get(id)!;
    if (manifest.v !== 1) throw new Error("expected plaintext manifest");
    server.blobs.delete(manifest.files["b.md"].h);
    vault.writes.length = 0;
    vault.removes.length = 0;

    await expect(engine.restoreAll(id)).rejects.toThrow(/unknown blob/);

    expect(vault.text("a.md")).toBe("current a");
    expect(vault.text("stray.md")).toBe("current stray");
    expect(vault.writes).toEqual([]);
    expect(vault.removes).toEqual([]);
  });

  it("restores case-folding collisions under distinct deterministic paths", async () => {
    const engine = makeEngine();
    const id = await server.seedRemoteCommit({ "Note.md": "upper", "note.md": "lower" });

    const res = await engine.restoreAll(id);

    expect(vault.text("Note.md")).toBe("upper");
    const conflict = [...vault.files.keys()].find((path) =>
      path.startsWith("note.conflict-other-device-")
    );
    expect(conflict).toBeDefined();
    expect(vault.text(conflict!)).toBe("lower");
    expect(res.written).toBe(2);
  });
});

describe("history with encryption on", () => {
  it("reads counts and restores content through the master key", async () => {
    const crypto = await VaultCrypto.fromText(
      btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
    );
    const engine = makeEngine({ crypto });
    vault.set("a.md", "secret one");
    vault.set("b.md", "secret two");
    await engine.sync();
    const first = server.head!;
    vault.delete("b.md");
    await engine.sync();

    const history = await engine.listHistory(10);
    expect(history[1].fileCount).toBe(2);
    expect(history[1].readable).toBe(true);

    await engine.restoreFile(first, "b.md");
    expect(vault.text("b.md")).toBe("secret two");
  });
});
