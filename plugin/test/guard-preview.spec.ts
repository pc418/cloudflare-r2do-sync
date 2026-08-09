import { describe, it, expect, beforeEach } from "vitest";
import { SyncEngine, type MassChangeDecision, type MassChangeSummary } from "../src/sync";
import { FakeServer, FakeStore, FakeVault } from "./fakes";
import type { Manifest, ManifestV1 } from "../src/types";
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

function plainFiles(m: Manifest): ManifestV1["files"] {
  if (m.v !== 1) throw new Error(`expected a plaintext manifest, got v${m.v}`);
  return m.files;
}

/** Four synced files, then a remote snapshot that keeps only `a.md` — a 75% wipe. */
async function setUpWipe(engine: SyncEngine): Promise<void> {
  vault.set("a.md", "alpha");
  vault.set("b.md", "bravo");
  vault.set("c.md", "charlie");
  vault.set("d.md", "delta");
  await engine.sync();
  await server.seedRemoteCommit({ "a.md": "alpha" });
}

describe("mass-change guard", () => {
  it("pauses instead of applying a plan that deletes most of the vault", async () => {
    const seen: MassChangeSummary[] = [];
    const engine = makeEngine({
      decideMassChange: async (s) => {
        seen.push(s);
        return "cancel";
      },
    });
    await setUpWipe(engine);

    const res = await engine.sync();

    expect(res.status).toBe("needs-decision");
    expect(seen).toHaveLength(1);
    expect(seen[0].deletes.sort()).toEqual(["b.md", "c.md", "d.md"]);
    expect(seen[0].overwrites).toEqual([]);
    expect(seen[0].localFileCount).toBe(4);
    expect(seen[0].percent).toBe(75);
    expect(seen[0].threshold).toBe(50);
    // Nothing touched on either side.
    expect(vault.removes).toEqual([]);
    expect(vault.files.size).toBe(4);
  });

  it("cancelling is not sticky — the next pass asks again", async () => {
    let calls = 0;
    const engine = makeEngine({
      decideMassChange: async () => {
        calls++;
        return "cancel";
      },
    });
    await setUpWipe(engine);

    expect((await engine.sync()).status).toBe("needs-decision");
    expect((await engine.sync()).status).toBe("needs-decision");
    expect(calls).toBe(2);
  });

  it("treats a missing decision callback as cancel, so unattended syncs never wipe", async () => {
    const engine = makeEngine();
    await setUpWipe(engine);

    const res = await engine.sync();

    expect(res.status).toBe("needs-decision");
    expect(vault.files.size).toBe(4);
  });

  it("apply-remote carries out the deletions and commits the result", async () => {
    const engine = makeEngine({ decideMassChange: async () => "apply-remote" });
    await setUpWipe(engine);

    const res = await engine.sync();

    expect(res.status).toBe("pulled");
    expect(vault.removes.sort()).toEqual(["b.md", "c.md", "d.md"]);
    expect([...vault.files.keys()]).toEqual(["a.md"]);
  });

  it("keep-local leaves the vault alone and republishes it over the remote", async () => {
    const engine = makeEngine({ decideMassChange: async () => "keep-local" });
    await setUpWipe(engine);

    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(vault.removes).toEqual([]);
    expect(vault.files.size).toBe(4);
    const committed = plainFiles(server.manifests.get(server.head!)!);
    expect(Object.keys(committed).sort()).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    // The wipe snapshot is still in the chain, so the other device's state is recoverable.
    expect(server.manifests.size).toBeGreaterThan(1);
  });

  it("does not stop for overwrites alone — those cannot lose authored work", async () => {
    // `take-theirs` only fires when our copy still equals the base, so every one of these
    // replaces a file this device had not touched. The old content stays in the snapshot
    // chain. Rewriting the whole vault is therefore a fast-forward, not a wipe.
    let called = false;
    const engine = makeEngine({ decideMassChange: async () => ((called = true), "cancel") });
    vault.set("a.md", "alpha");
    vault.set("b.md", "bravo");
    vault.set("c.md", "charlie");
    await engine.sync();
    await server.seedRemoteCommit({ "a.md": "ONE", "b.md": "TWO", "c.md": "THREE" });

    const res = await engine.sync();

    expect(called).toBe(false);
    expect(res.status).toBe("pulled");
    expect(vault.text("a.md")).toBe("ONE");
  });

  it("lists overwrites alongside the deletions that did trigger it", async () => {
    let summary: MassChangeSummary | null = null;
    const engine = makeEngine({
      decideMassChange: async (s) => ((summary = s), "cancel"),
    });
    vault.set("a.md", "alpha");
    vault.set("b.md", "bravo");
    vault.set("c.md", "charlie");
    await engine.sync();
    // Two of three gone (67% > 50%), and the survivor rewritten.
    await server.seedRemoteCommit({ "a.md": "REWRITTEN" });

    await engine.sync();

    expect(summary!.deletes.sort()).toEqual(["b.md", "c.md"]);
    expect(summary!.overwrites).toEqual(["a.md"]);
    expect(summary!.percent).toBe(67);
  });

  it("stays quiet at exactly the threshold — the test is strictly greater", async () => {
    // A two-file vault losing one file is exactly 50%, not more than it, so this merges
    // automatically. That strictness is what keeps small vaults quiet: losing one file is
    // ordinary sync traffic, it lands in the trash, and the old snapshot is still on the
    // server.
    let called = false;
    const engine = makeEngine({ decideMassChange: async () => ((called = true), "cancel") });
    vault.set("a.md", "alpha");
    vault.set("b.md", "bravo");
    await engine.sync();
    await server.seedRemoteCommit({ "a.md": "alpha" });

    const res = await engine.sync();

    expect(called).toBe(false);
    expect(res.status).toBe("pulled");
    expect(vault.removes).toEqual(["b.md"]);
  });

  it("does not count new remote files — a fresh device adopting a vault is not a wipe", async () => {
    let called = false;
    const engine = makeEngine({ decideMassChange: async () => ((called = true), "cancel") });
    await server.seedRemoteCommit({
      "a.md": "alpha",
      "b.md": "bravo",
      "c.md": "charlie",
      "d.md": "delta",
    });

    const res = await engine.sync();

    expect(called).toBe(false);
    expect(res.status).toBe("pulled");
    expect(vault.files.size).toBe(4);
  });

  it("does not count merges or conflict copies — both sides survive those", async () => {
    let called = false;
    const engine = makeEngine({
      protectPercent: 1,
      decideMassChange: async () => ((called = true), "cancel"),
    });
    vault.set("note.md", "line one\n");
    await engine.sync();
    await server.seedRemoteCommit({ "note.md": "line one\nthem\n" });
    vault.set("note.md", "line one\nus\n", 1_754_000_900_000);

    await engine.sync();

    expect(called).toBe(false);
  });

  it("a threshold of 100 disables the guard entirely", async () => {
    let called = false;
    const engine = makeEngine({
      protectPercent: 100,
      decideMassChange: async () => ((called = true), "cancel"),
    });
    await setUpWipe(engine);

    const res = await engine.sync();

    expect(called).toBe(false);
    expect(res.status).toBe("pulled");
    expect(vault.removes.sort()).toEqual(["b.md", "c.md", "d.md"]);
  });

  it("a threshold of 0 asks about any destructive change at all", async () => {
    let summary: MassChangeSummary | null = null;
    const engine = makeEngine({
      protectPercent: 0,
      decideMassChange: async (s) => ((summary = s), "cancel"),
    });
    vault.set("a.md", "alpha");
    vault.set("b.md", "bravo");
    vault.set("c.md", "charlie");
    vault.set("d.md", "delta");
    await engine.sync();
    await server.seedRemoteCommit({ "a.md": "alpha", "b.md": "bravo", "c.md": "charlie" });

    await engine.sync();

    expect(summary!.deletes).toEqual(["d.md"]);
    expect(summary!.percent).toBe(25);
  });
});

describe("always-skipped paths in the engine", () => {
  it("never uploads junk, even with no exclude globs configured", async () => {
    const engine = makeEngine({ excludes: [] });
    vault.set("real.md", "keep me");
    vault.set(".DS_Store", "junk");
    vault.set("notes/Thumbs.db", "junk");
    vault.set(".git/config", "junk");
    vault.set("~$draft.docx", "junk");

    const res = await engine.sync();

    expect(Object.keys(plainFiles(server.manifests.get(server.head!)!))).toEqual(["real.md"]);
    // Silent: junk is not actionable, so it must not nag through the skipped list.
    expect(res.skipped).toEqual([]);
  });

  it("never uploads this plugin's own folder, which holds the token and master key", async () => {
    const engine = makeEngine({ excludes: [] });
    vault.set("real.md", "keep me");
    vault.set(".obsidian/plugins/obsidian-log-sync/data.json", '{"masterKey":"secret"}');

    await engine.sync();

    expect(Object.keys(plainFiles(server.manifests.get(server.head!)!))).toEqual(["real.md"]);
  });

  it("never writes a skipped path to disk, but keeps it in the snapshot for other devices", async () => {
    // An older or differently-configured device may have uploaded these. Dropping them from
    // our snapshot would delete another device's files; writing them would let a remote
    // data.json overwrite this device's identity. So: carry, never materialise.
    const engine = makeEngine({ excludes: [] });
    vault.set("real.md", "keep me");
    await engine.sync();
    await server.seedRemoteCommit({
      "real.md": "keep me",
      ".DS_Store": "junk",
      ".obsidian/plugins/obsidian-log-sync/data.json": '{"masterKey":"theirs"}',
    });

    const res = await engine.sync();

    expect(res.status).toBe("pulled");
    expect(vault.writes).toEqual([]);
    expect(vault.files.has(".DS_Store")).toBe(false);
    expect(vault.files.has(".obsidian/plugins/obsidian-log-sync/data.json")).toBe(false);
    expect(store.state!.files[".obsidian/plugins/obsidian-log-sync/data.json"]).toBeDefined();
  });
});

describe("SyncEngine.preview", () => {
  it("reports what a pull would do without touching the vault or the server", async () => {
    const engine = makeEngine();
    vault.set("a.md", "alpha");
    vault.set("keep.md", "keep");
    await engine.sync();
    const headBefore = server.head;
    await server.seedRemoteCommit({ "keep.md": "keep", "new.md": "arrived" });
    // Only count what preview itself does.
    vault.writes.length = 0;
    vault.removes.length = 0;
    server.uploads.length = 0;
    const savesBefore = store.saves;

    const p = await engine.preview();

    expect(p.pull).toContainEqual({ path: "new.md", action: "write" });
    expect(p.pull).toContainEqual({ path: "a.md", action: "delete" });
    expect(vault.writes).toEqual([]);
    expect(vault.removes).toEqual([]);
    expect(server.uploads).toEqual([]);
    expect(store.saves).toBe(savesBefore);
    expect(store.state!.lastSyncedHead).toBe(headBefore);
  });

  it("reports what a push would do when the remote has not moved", async () => {
    const engine = makeEngine();
    vault.set("a.md", "alpha");
    await engine.sync();
    vault.set("a.md", "alpha edited", 1_754_000_900_000);
    vault.set("brand-new.md", "hello");
    vault.delete("gone.md");

    const p = await engine.preview();

    expect(p.pull).toEqual([]);
    expect(p.push).toContainEqual({ path: "a.md", action: "update" });
    expect(p.push).toContainEqual({ path: "brand-new.md", action: "add" });
  });

  it("reports a local deletion as a remote delete", async () => {
    const engine = makeEngine();
    vault.set("a.md", "alpha");
    vault.set("b.md", "bravo");
    await engine.sync();
    vault.delete("b.md");

    const p = await engine.preview();

    expect(p.push).toEqual([{ path: "b.md", action: "delete" }]);
  });

  it("pull-only preview never reports a push", async () => {
    const engine = makeEngine({ mode: "pull-only" });
    vault.set("local.md", "local");
    await server.seedRemoteCommit({ "remote.md": "remote" });

    const p = await engine.preview();

    expect(p.pull).toEqual([{ path: "remote.md", action: "write" }]);
    expect(p.push).toEqual([]);
    expect(p.guard).toBeNull();
  });

  it("push-only preview never reports a pull or mass-change guard", async () => {
    vault.set("a.md", "base");
    const engine = makeEngine({ mode: "push-only" });
    await engine.sync();
    await server.seedRemoteCommit({ "a.md": "remote edit", "remote.md": "carry" });
    vault.set("a.md", "local edit", now + 1);

    const p = await engine.preview();

    expect(p.pull).toEqual([]);
    expect(p.push).toEqual(
      expect.arrayContaining([
        { path: "a.md", action: "update" },
        { path: expect.stringMatching(/^a\.conflict-other-device-/), action: "add" },
      ])
    );
    expect(p.guard).toBeNull();
  });

  it("flags a merge rather than calling it a plain overwrite", async () => {
    const engine = makeEngine();
    vault.set("note.md", "line one\n");
    await engine.sync();
    await server.seedRemoteCommit({ "note.md": "line one\nthem\n" });
    vault.set("note.md", "line one\nus\n", 1_754_000_900_000);

    const p = await engine.preview();

    expect(p.pull).toEqual([{ path: "note.md", action: "merge" }]);
    expect(p.push).toContainEqual({ path: "note.md", action: "update" });
  });

  it("surfaces skipped files and the guard verdict", async () => {
    const engine = makeEngine({ maxBlobBytes: 8 });
    vault.set("one.md", "ok");
    vault.set("two.md", "ok");
    vault.set("three.md", "ok");
    vault.set("big.md", "x".repeat(64));
    await engine.sync();
    await server.seedRemoteCommit({ "nothing-of-ours.md": "hi" });

    const p = await engine.preview();

    expect(p.skipped.map((s) => s.path)).toEqual(["big.md"]);
    expect(p.guard).not.toBeNull();
    expect(p.guard!.deletes.sort()).toEqual(["one.md", "three.md", "two.md"]);
  });

  it("reports an unreadable remote instead of throwing", async () => {
    const engine = makeEngine();
    vault.set("a.md", "alpha");
    await engine.sync();
    server.seedRemoteEncryptedCommit({ keyId: "someone-elses-key" });

    const p = await engine.preview();

    expect(p.halted).toMatch(/encrypted/);
    expect(p.pull).toEqual([]);
  });

  it("says nothing is pending when both sides are already in step", async () => {
    const engine = makeEngine();
    vault.set("a.md", "alpha");
    await engine.sync();

    const p = await engine.preview();

    expect(p.pull).toEqual([]);
    expect(p.push).toEqual([]);
    expect(p.guard).toBeNull();
  });

  it("reports a publish after the configured master key changes", async () => {
    const oldCrypto = await VaultCrypto.create(new Uint8Array(32).fill(1));
    const newCrypto = await VaultCrypto.create(new Uint8Array(32).fill(2));
    const oldEngine = makeEngine({ crypto: oldCrypto });
    vault.set("a.md", "alpha");
    await oldEngine.sync();

    const p = await makeEngine({ crypto: newCrypto }).preview();

    expect(p.push).toEqual([{ path: "a.md", action: "update" }]);
  });

  it("halts a key-change preview when a prior file is now too large to re-encrypt", async () => {
    const oldCrypto = await VaultCrypto.create(new Uint8Array(32).fill(1));
    const newCrypto = await VaultCrypto.create(new Uint8Array(32).fill(2));
    const oldEngine = makeEngine({ crypto: oldCrypto, maxBlobBytes: 1024 });
    vault.set("large.bin", "small enough before");
    await oldEngine.sync();
    vault.set("large.bin", "x".repeat(64));

    const p = await makeEngine({ crypto: newCrypto, maxBlobBytes: 8 }).preview();

    expect(p.halted).toMatch(/cannot change the vault key/);
    expect(p.skipped).toEqual([{ path: "large.bin", reason: "exceeds 8 byte limit" }]);
    expect(p.push).toEqual([]);
  });
});
