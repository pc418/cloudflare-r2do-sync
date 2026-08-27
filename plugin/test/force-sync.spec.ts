import { describe, it, expect, beforeEach, vi } from "vitest";
import { SyncEngine, type SyncResult } from "../src/sync";
import { FakeServer, FakeStore, FakeVault } from "./fakes";
import { StaleHeadError } from "../src/api";
import { VaultCrypto } from "../src/crypto";
import type { ManifestV1 } from "../src/types";

// The two "make this side win" actions. Everything else in the engine reconciles; these two
// deliberately do not, so each one has to be explicit about what it destroys and what it
// preserves. Force-pull keeps unpublished local work as .conflict-… copies (the same promise
// the merge makes); force-push never touches local files and never asks the mass-change
// guard, because the user just answered the question the guard would have asked.

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
    excludes: [],
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

/** Committed base {a,b}, then another device publishes {a changed, c added, b deleted}. */
async function divergedRemote(engine: SyncEngine): Promise<string> {
  vault.set("a.md", "one");
  vault.set("b.md", "bee");
  await engine.sync();
  return await server.seedRemoteCommit({ "a.md": "remote-a", "c.md": "remote-c" });
}

function committedFiles(): string[] {
  const manifest = server.manifests.get(server.head!) as ManifestV1;
  return Object.keys(manifest.files).sort();
}

const CONFLICT_COPY = /^b\.conflict-test-device-\d{6}-\d{4}(?:-\d+)?\.md$/;

function haltReason(result: SyncResult): string {
  if (result.status !== "halted") throw new Error(`expected a halt, got ${result.status}`);
  return result.reason;
}

describe("SyncEngine.forcePull", () => {
  it("makes the vault match the remote head", async () => {
    const engine = makeEngine();
    const head = await divergedRemote(engine);

    const result = await engine.forcePull();

    expect(result.head).toBe(head);
    expect(vault.text("a.md")).toBe("remote-a");
    expect(vault.text("c.md")).toBe("remote-c");
    expect(vault.files.has("b.md")).toBe(false);
    expect(result.written).toBe(2);
    expect(result.removed).toBe(1);
  });

  it("parks unpublished local changes as conflict copies instead of destroying them", async () => {
    const engine = makeEngine();
    await divergedRemote(engine);
    vault.set("b.md", "bee-edited", 1_754_000_100_000);

    const result = await engine.forcePull();

    expect(result.parked).toHaveLength(1);
    expect(result.parked[0]).toMatch(CONFLICT_COPY);
    expect(vault.text(result.parked[0])).toBe("bee-edited");
  });

  it("overwrites files this device had not touched without parking a copy", async () => {
    const engine = makeEngine();
    await divergedRemote(engine);
    // a.md still equals the last synced snapshot, so the remote replaces it silently —
    // the same rule the merge's take-theirs follows. b.md was deleted remotely and is
    // likewise untouched here, so it is simply removed.
    const result = await engine.forcePull();

    expect(result.parked).toEqual([]);
    expect(vault.text("a.md")).toBe("remote-a");
  });

  it("parks every local file that differs when the device has never synced", async () => {
    const engine = makeEngine();
    await server.seedRemoteCommit({ "a.md": "remote-a", "shared.md": "same" });
    vault.set("a.md", "local-a");
    vault.set("shared.md", "same");

    const result = await engine.forcePull();

    // Identical content is not divergence, so only a.md is worth keeping a copy of.
    expect(result.parked).toHaveLength(1);
    expect(result.parked[0]).toMatch(/^a\.conflict-test-device-/);
    expect(vault.text("a.md")).toBe("remote-a");
  });

  // The stale removal is the other place a whole subtree can disappear at once, and it
  // strands the same directory skeleton the pull merge used to.
  it("prunes the folders its stale removals emptied, deepest first", async () => {
    const engine = makeEngine();
    vault.set("a/b/x.md", "one");
    vault.set("keep.md", "keep");
    await engine.sync();
    await server.seedRemoteCommit({ "keep.md": "keep" });

    await engine.forcePull();

    expect(vault.removes).toEqual(["a/b/x.md"]);
    expect(vault.folderRemoves).toEqual(["a/b", "a"]);
  });

  it("still prunes what its stale removal managed before a failing lane", async () => {
    const engine = makeEngine();
    vault.set("a/b/x.md", "one");
    vault.set("c/y.md", "two");
    vault.set("keep.md", "keep");
    await engine.sync();
    await server.seedRemoteCommit({ "keep.md": "keep" });

    const remove = vault.remove.bind(vault);
    vault.remove = async (path) => {
      if (path === "c/y.md") throw new Error("volume locked");
      await remove(path);
    };

    await expect(engine.forcePull()).rejects.toThrow(/volume locked/);
    expect(vault.files.has("a/b/x.md")).toBe(false);
    expect(vault.folderRemoves).toEqual(["a/b", "a"]);
    expect(vault.files.has("c/y.md")).toBe(true);
  });

  it("leaves paths this device does not sync alone on both sides", async () => {
    const engine = makeEngine({ excludes: ["private/**"] });
    await divergedRemote(engine);
    vault.set("private/secret.md", "mine");

    await engine.forcePull();

    expect(vault.text("private/secret.md")).toBe("mine");
    expect(vault.removes).not.toContain("private/secret.md");
  });

  it("refuses when the remote vault has no snapshot", async () => {
    await expect(makeEngine().forcePull()).rejects.toThrow(/no snapshot/i);
  });

  it("refuses when the sync direction forbids writing local files", async () => {
    const engine = makeEngine({ mode: "push-only" });
    await server.seedRemoteCommit({ "a.md": "remote-a" });

    await expect(engine.forcePull()).rejects.toThrow(/push-only/);
    expect(vault.writes).toEqual([]);
  });

  it("refuses an encrypted remote this device cannot read", async () => {
    const crypto = await VaultCrypto.fromText(btoa("k".repeat(32)));
    server.seedRemoteEncryptedCommit({ keyId: "someone-elses-key" });

    await expect(makeEngine({ crypto }).forcePull()).rejects.toThrow(/different master key/);
    expect(vault.writes).toEqual([]);
  });

  it("refuses to start while a pass is running", async () => {
    const engine = makeEngine();
    await divergedRemote(engine);
    engine.status = { phase: "syncing" };

    await expect(engine.forcePull()).rejects.toThrow(/already running/);
  });

  it("publishes the result on the next ordinary sync", async () => {
    const engine = makeEngine();
    await divergedRemote(engine);
    vault.set("b.md", "bee-edited", 1_754_000_100_000);

    const { parked } = await engine.forcePull();
    const result = await engine.sync();

    expect(result.status).toBe("committed");
    expect(committedFiles()).toEqual(["a.md", "c.md", parked[0]].sort());
  });
});

describe("engine exclusivity", () => {
  it("refuses a pass while the vault is being rewritten", async () => {
    const engine = makeEngine();
    await divergedRemote(engine);
    // What restoreAll, migrateEncryption and forcePull all claim while they work: a pass
    // starting mid-rewrite would plan against a vault that is half old and half new.
    engine.status = { phase: "syncing" };

    await expect(engine.sync()).rejects.toThrow(/already running/);
  });

  it("frees the engine again after a failed force pull", async () => {
    const engine = makeEngine();
    vault.set("a.md", "one");

    await expect(engine.forcePull()).rejects.toThrow(/no snapshot/i);

    expect((await engine.sync()).status).toBe("committed");
  });
});

describe("SyncEngine.forcePullSummary", () => {
  it("reports what the pull would touch without touching anything", async () => {
    const engine = makeEngine();
    const head = await divergedRemote(engine);
    vault.set("b.md", "bee-edited", 1_754_000_100_000);
    vault.writes = [];
    vault.removes = [];

    const summary = await engine.forcePullSummary();

    expect(summary).toEqual({ head, write: 2, remove: ["b.md"], park: ["b.md"] });
    expect(vault.writes).toEqual([]);
    expect(vault.removes).toEqual([]);
  });

  it("refuses for the same reasons the pull itself does", async () => {
    await expect(makeEngine().forcePullSummary()).rejects.toThrow(/no snapshot/i);
  });
});

describe("forced push (sync with keepLocal)", () => {
  it("commits this device's files over a diverged remote", async () => {
    const engine = makeEngine();
    await divergedRemote(engine);

    const result = await engine.sync({ keepLocal: true });

    expect(result.status).toBe("committed");
    expect(committedFiles()).toEqual(["a.md", "b.md"]);
  });

  it("never writes or removes a local file", async () => {
    const engine = makeEngine();
    await divergedRemote(engine);
    vault.writes = [];
    vault.removes = [];

    await engine.sync({ keepLocal: true });

    expect(vault.writes).toEqual([]);
    expect(vault.removes).toEqual([]);
    expect(vault.files.has("c.md")).toBe(false);
  });

  it("parents onto the remote head, so the replaced snapshot stays in the chain", async () => {
    const engine = makeEngine();
    const remoteHead = await divergedRemote(engine);

    await engine.sync({ keepLocal: true });

    expect(server.manifests.get(server.head!)!.parent).toBe(remoteHead);
  });

  it("still carries remote paths this device does not scan", async () => {
    const engine = makeEngine({ excludes: ["private/**"] });
    vault.set("a.md", "one");
    await engine.sync();
    await server.seedRemoteCommit({ "private/theirs.md": "not ours", "c.md": "remote-c" });

    await engine.sync({ keepLocal: true });

    // c.md is dropped — this device wins — but an excluded path is another device's file,
    // not divergence this device is entitled to resolve.
    expect(committedFiles()).toEqual(["a.md", "private/theirs.md"]);
  });

  it("does not ask the mass-change guard", async () => {
    const decide = vi.fn().mockResolvedValue("cancel" as const);
    const engine = makeEngine({ protectPercent: 1, decideMassChange: decide });
    vault.set("a.md", "one");
    await engine.sync();
    await server.seedRemoteCommit({
      "a.md": "one",
      "x1.md": "x",
      "x2.md": "x",
      "x3.md": "x",
      "x4.md": "x",
    });

    const result = await engine.sync({ keepLocal: true });

    expect(decide).not.toHaveBeenCalled();
    expect(result.status).toBe("committed");
    expect(committedFiles()).toEqual(["a.md"]);
  });

  it("refuses when the sync direction forbids committing", async () => {
    const engine = makeEngine({ mode: "pull-only" });
    vault.set("a.md", "one");

    await expect(engine.sync({ keepLocal: true })).rejects.toThrow(/pull-only/);
    expect(server.head).toBeNull();
  });

  it("still halts when the remote is unreadable with this device's key", async () => {
    const crypto = await VaultCrypto.fromText(btoa("k".repeat(32)));
    server.seedRemoteEncryptedCommit({ keyId: "someone-elses-key" });
    vault.set("a.md", "one");

    const result = await makeEngine({ crypto }).sync({ keepLocal: true });

    expect(result.status).toBe("halted");
  });
});

// "Rebuild remote history": the only action that makes remote content stop existing. Every
// other publish, forced or not, commits a child of the head and leaves the old versions in
// the chain. This one commits a new ROOT, orphaning everything behind it for the server's GC
// to delete — so what it publishes must be exactly what a forced push would, and what it
// discards must be everything else.
describe("reroot (rebuild remote history)", () => {
  it("commits a root manifest and makes it the head", async () => {
    const engine = makeEngine();
    await divergedRemote(engine);

    const result = await engine.sync({ reroot: { previewedHead: server.head } });

    expect(result.status).toBe("committed");
    expect(server.manifests.get(server.head!)!.parent).toBeNull();
    expect(server.reroots).toEqual([server.head]);
    expect(committedFiles()).toEqual(["a.md", "b.md"]);
  });

  // The whole point can be to stop storing something while the files themselves are already
  // correct. "Your vault already matches the remote" is not an answer to that.
  it("commits even when nothing about the files changed", async () => {
    const engine = makeEngine();
    vault.set("a.md", "one");
    await engine.sync();
    const firstHead = server.head;

    const result = await engine.sync({ reroot: { previewedHead: firstHead } });

    expect(result.status).toBe("committed");
    expect(server.head).not.toBe(firstHead);
    expect(server.manifests.get(server.head!)!.parent).toBeNull();
    expect(committedFiles()).toEqual(["a.md"]);
  });

  it("never writes or removes a local file", async () => {
    const engine = makeEngine();
    await divergedRemote(engine);
    vault.writes = [];
    vault.removes = [];

    await engine.sync({ reroot: { previewedHead: server.head } });

    expect(vault.writes).toEqual([]);
    expect(vault.removes).toEqual([]);
  });

  // Carrying is about other devices' *files*, not their history: dropping an excluded path
  // would delete a file this device was never entitled to speak for.
  it("still carries remote paths this device does not scan", async () => {
    const engine = makeEngine({ excludes: ["private/**"] });
    vault.set("a.md", "one");
    await engine.sync();
    await server.seedRemoteCommit({ "private/theirs.md": "not ours", "c.md": "remote-c" });

    await engine.sync({ reroot: { previewedHead: server.head } });

    expect(committedFiles()).toEqual(["a.md", "private/theirs.md"]);
  });

  it("refuses when the sync direction forbids committing", async () => {
    const engine = makeEngine({ mode: "pull-only" });
    vault.set("a.md", "one");

    await expect(engine.sync({ reroot: { previewedHead: null } })).rejects.toThrow(/pull-only/);
    expect(server.head).toBeNull();
  });

  it("still halts when the remote is unreadable with this device's key", async () => {
    const crypto = await VaultCrypto.fromText(btoa("k".repeat(32)));
    server.seedRemoteEncryptedCommit({ keyId: "someone-elses-key" });
    vault.set("a.md", "one");

    const result = await makeEngine({ crypto }).sync({ reroot: { previewedHead: server.head } });

    expect(result.status).toBe("halted");
  });

  // The confirmation names one head and describes what discarding everything behind it costs.
  // Without pinning, a snapshot published between the preview and the click — or between a
  // lost CAS race and its retry — would be rerooted over too: deleted outright, along with
  // the history that made it recoverable. Every other pass merges a moved head and retries;
  // this is the one where that would destroy the thing it absorbed.
  it("refuses when the head moved after the preview, and changes nothing", async () => {
    const engine = makeEngine();
    vault.set("a.md", "one");
    await engine.sync();
    const previewed = server.head;
    const theirs = await server.seedRemoteCommit({ "a.md": "one", "theirs.md": "unreviewed" });

    await expect(engine.sync({ reroot: { previewedHead: previewed } })).rejects.toThrow(
      /published .* since this rebuild was previewed/
    );
    expect(server.head).toBe(theirs);
    expect(server.reroots).toEqual([]);
  });

  it("refuses when another device commits during the pass, rather than retrying over it", async () => {
    const engine = makeEngine();
    vault.set("a.md", "one");
    await engine.sync();
    const previewed = server.head;

    // The head is still the previewed one when the pass starts, and moves exactly when this
    // commit races another device — the case a CAS retry exists for. An ordinary pass would
    // absorb the winner and try again; this one must not, because absorbing means deleting.
    const realCommit = server.commit.bind(server);
    let raced = false;
    server.commit = async (manifest, expectedHead, opts) => {
      if (!raced) {
        raced = true;
        server.head = await server.seedRemoteCommit({ "a.md": "one", "theirs.md": "unreviewed" });
        throw new StaleHeadError("head moved", server.head);
      }
      return realCommit(manifest, expectedHead, opts);
    };

    await expect(engine.sync({ reroot: { previewedHead: previewed } })).rejects.toThrow(
      /published .* since this rebuild was previewed/
    );
    expect(raced).toBe(true);
    expect(server.reroots).toEqual([]);
    expect(server.manifests.get(server.head!)!.parent).not.toBeNull();
  });

  describe("rerootSummary", () => {
    it("reports what would be published and how much history goes with it", async () => {
      const engine = makeEngine();
      vault.set("a.md", "one");
      await engine.sync();
      vault.set("b.md", "two");
      await engine.sync();

      const summary = await engine.rerootSummary(40);

      expect(summary.head).toBe(server.head);
      expect(summary.files).toBe(2);
      expect(summary.discarded).toBe(2);
      expect(summary.discardedIsFloor).toBe(false);
    });

    // A count that stopped at the limit is a floor, and saying "2 snapshots" when the chain
    // holds hundreds would understate exactly the thing being destroyed.
    it("marks the count as a floor when the chain is longer than it walked", async () => {
      const engine = makeEngine();
      vault.set("a.md", "one");
      await engine.sync();
      vault.set("b.md", "two");
      await engine.sync();

      expect((await engine.rerootSummary(1)).discardedIsFloor).toBe(true);
    });

    it("says there is nothing to rebuild on a vault with no snapshot", async () => {
      vault.set("a.md", "one");
      expect((await makeEngine().rerootSummary(40)).head).toBeNull();
    });
  });
});

// The settings tab offers "paste a setup link" when — and only when — the halt means this
// device holds the wrong key. The predicate reads the messages #modeError writes, so these
// pin the pairing: editing one of those strings without the other fails here.
describe("SyncEngine.isWrongKeyHalt", () => {
  it("recognises a remote encrypted with someone else's key", async () => {
    const crypto = await VaultCrypto.fromText(btoa("k".repeat(32)));
    server.seedRemoteEncryptedCommit({ keyId: "someone-elses-key" });
    vault.set("a.md", "one");

    const reason = haltReason(await makeEngine({ crypto }).sync());

    expect(SyncEngine.isWrongKeyHalt(reason)).toBe(true);
  });

  it("recognises an encrypted remote and no key at all", async () => {
    server.seedRemoteEncryptedCommit({ keyId: "any-key" });
    vault.set("a.md", "one");

    const reason = haltReason(await makeEngine().sync());

    expect(SyncEngine.isWrongKeyHalt(reason)).toBe(true);
  });

  it("does not read an unrelated halt as a key problem", () => {
    // Losing the head race repeatedly is a busy vault, not a wrong key.
    expect(SyncEngine.isWrongKeyHalt("gave up after 3 attempts: another device keeps committing")).toBe(
      false
    );
  });
});

describe("SyncEngine.forcePushSummary", () => {
  it("reports the parent, the file count and what disappears", async () => {
    const engine = makeEngine();
    const head = await divergedRemote(engine);

    expect(await engine.forcePushSummary()).toEqual({
      head,
      files: 2,
      drop: ["c.md"],
      carried: 0,
    });
  });

  it("counts carried paths separately from dropped ones", async () => {
    const engine = makeEngine({ excludes: ["private/**"] });
    vault.set("a.md", "one");
    await server.seedRemoteCommit({ "private/theirs.md": "not ours", "c.md": "remote-c" });

    const summary = await engine.forcePushSummary();

    expect(summary.carried).toBe(1);
    expect(summary.drop).toEqual(["c.md"]);
  });

  it("reports an empty vault as the parentless first snapshot", async () => {
    vault.set("a.md", "one");

    expect(await makeEngine().forcePushSummary()).toEqual({
      head: null,
      files: 1,
      drop: [],
      carried: 0,
    });
  });

  it("refuses in pull-only mode", async () => {
    await expect(makeEngine({ mode: "pull-only" }).forcePushSummary()).rejects.toThrow(
      /pull-only/
    );
  });
});

describe("forced actions are pinned to the head they previewed", () => {
  let engine: SyncEngine;
  beforeEach(() => {
    engine = makeEngine();
  });

  // The typed confirmation names a snapshot and counts its files. Between the preview and
  // the click another device can publish; acting on that instead means the destructive thing
  // that happened is not the destructive thing that was agreed to. Rebuild-history already
  // refused a moved head for this reason — these two did not.
  it("forcePull refuses when the remote moved after the preview", async () => {
    vault.set("a.md", "local");
    await engine.sync();
    const summary = await engine.forcePullSummary();

    await server.seedRemoteCommit({ "b.md": "someone else's newer snapshot" });

    await expect(engine.forcePull(summary.head)).rejects.toThrow(/since this pull was previewed/);
    // Nothing was written over the vault.
    expect(vault.text("a.md")).toBe("local");
  });

  it("forcePull still runs when the head is the one that was previewed", async () => {
    vault.set("a.md", "local");
    await engine.sync();
    await server.seedRemoteCommit({ "remote.md": "theirs" });
    const summary = await engine.forcePullSummary();

    await expect(engine.forcePull(summary.head)).resolves.toMatchObject({ head: summary.head });
  });

  it("forcePush refuses when the remote moved after the preview", async () => {
    vault.set("a.md", "local");
    await engine.sync();
    const summary = await engine.forcePushSummary();

    await server.seedRemoteCommit({ "b.md": "published in the meantime" });

    await expect(
      engine.sync({ keepLocal: true, previewedHead: summary.head })
    ).rejects.toThrow(/since this push was previewed/);
  });

  it("forcePush publishes when the head has not moved", async () => {
    vault.set("a.md", "local");
    await engine.sync();
    vault.set("a.md", "edited since the last pass", 1_754_000_100_000);
    const summary = await engine.forcePushSummary();

    const res = await engine.sync({ keepLocal: true, previewedHead: summary.head });
    expect(res.status).toBe("committed");
  });
});
