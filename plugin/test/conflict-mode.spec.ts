import { describe, it, expect, beforeEach } from "vitest";
import { SyncEngine, type ConflictInfo } from "../src/sync";
import type { ConflictMode } from "../src/merge";
import { FakeServer, FakeStore, FakeVault } from "./fakes";

let vault: FakeVault;
let server: FakeServer;
let store: FakeStore;
let now: number;

function makeEngine(conflictMode?: ConflictMode) {
  return new SyncEngine({
    vault,
    api: server,
    store,
    deviceName: "test-device",
    excludes: [".obsidian/**"],
    maxBlobBytes: 1024,
    now: () => now,
    conflictMode,
  });
}

beforeEach(() => {
  vault = new FakeVault();
  server = new FakeServer();
  store = new FakeStore();
  now = 1_754_000_000_000;
});

/** Seed a shared base, then diverge both sides so diff3 cannot merge. */
async function divergeNote(engine: SyncEngine, oursMtime: number) {
  vault.set("note.md", "original\n");
  await engine.sync();
  await server.seedRemoteCommit({ "note.md": "their rewrite\n" }); // remote mtime is the seed default
  vault.set("note.md", "our rewrite\n", oursMtime);
}

describe("conflict modes", () => {
  it("keep-both (default) still parks the loser and now reports full details", async () => {
    const engine = makeEngine();
    await divergeNote(engine, now + 1000);

    const res = await engine.sync();

    expect(res.conflicts).toHaveLength(1);
    expect(res.conflictDetails).toHaveLength(1);
    const d = res.conflictDetails[0];
    expect(d.path).toBe("note.md");
    expect(d.kept).toBe("ours");
    expect(d.copy).toBe(res.conflicts[0]);
    // The facts a human needs: both sides' last edit and size.
    expect(d.ours).toEqual({ mtime: now + 1000, size: "our rewrite\n".length });
    expect(d.theirs).toEqual({ mtime: 1_754_000_000_000, size: "their rewrite\n".length });
  });

  it("newest wins: the newer local edit keeps the path and theirs is discarded", async () => {
    const engine = makeEngine("newest");
    await divergeNote(engine, now + 1000); // ours is newer than the seeded remote mtime

    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(res.conflicts).toEqual([]); // no copy parked
    expect(res.conflictDetails).toEqual([
      {
        path: "note.md",
        copy: null,
        kept: "ours",
        ours: { mtime: now + 1000, size: "our rewrite\n".length },
        theirs: { mtime: 1_754_000_000_000, size: "their rewrite\n".length },
      },
    ]);
    expect(vault.text("note.md")).toBe("our rewrite\n");
    expect([...vault.files.keys()].some((p) => p.includes(".conflict-"))).toBe(false);
  });

  it("newest wins: a newer remote overwrites the local edit", async () => {
    const engine = makeEngine("newest");
    await divergeNote(engine, now - 5000); // ours is OLDER

    const res = await engine.sync();

    expect(vault.text("note.md")).toBe("their rewrite\n");
    expect(res.conflictDetails[0]).toMatchObject({ copy: null, kept: "theirs" });
    expect([...vault.files.keys()].some((p) => p.includes(".conflict-"))).toBe(false);
  });

  it("largest wins, and equal sizes fall back to the hash tiebreak", async () => {
    const engine = makeEngine("largest");
    vault.set("note.md", "original\n");
    await engine.sync();
    await server.seedRemoteCommit({ "note.md": "their much longer rewrite\n" });
    vault.set("note.md", "ours\n", now + 9999); // newer but smaller — size decides, not time

    const res = await engine.sync();

    expect(vault.text("note.md")).toBe("their much longer rewrite\n");
    expect(res.conflictDetails[0]).toMatchObject({ kept: "theirs", copy: null });
  });

  it("both devices converge on the same winner (no ping-pong)", async () => {
    // A and B share a synced base, then edit the same line divergently. A commits its
    // (newer) version; B, holding the losing version, must adopt A's result rather than
    // fight it — and a further sync on B must be a no-op.
    const a = makeEngine("newest");
    vault.set("note.md", "original\n");
    await a.sync();

    const bVault = new FakeVault();
    const bStore = new FakeStore();
    const b = new SyncEngine({
      vault: bVault,
      api: server,
      store: bStore,
      deviceName: "other",
      now: () => now + 60_000,
      conflictMode: "newest",
    });
    await b.sync(); // B now shares the base

    bVault.set("note.md", "B version\n", now + 500); // older edit, never synced
    vault.set("note.md", "A version\n", now + 1000);
    await a.sync(); // no conflict on A: only A moved vs the head

    const res = await b.sync();

    expect(bVault.text("note.md")).toBe("A version\n");
    expect(res.conflictDetails[0]).toMatchObject({ copy: null, kept: "theirs" });
    expect([...bVault.files.keys()].some((p) => p.includes(".conflict-"))).toBe(false);

    const again = await b.sync();
    expect(again.status).toBe("unchanged");
    expect(again.conflictDetails).toEqual([]);
  });

  it("a clean diff3 merge still wins over any conflict mode", async () => {
    const engine = makeEngine("newest");
    vault.set("log.md", "# log\n- one\n");
    await engine.sync();
    await server.seedRemoteCommit({ "log.md": "# log\n- one\n- theirs\n" });
    vault.set("log.md", "# log\n- one\n- ours\n", now + 1000);

    const res = await engine.sync();

    expect(res.merged).toBe(1);
    expect(res.conflictDetails).toEqual([]);
    expect(vault.text("log.md")).toContain("- ours");
    expect(vault.text("log.md")).toContain("- theirs");
  });

  it("attachments under keep-both report which side kept the path", async () => {
    const engine = makeEngine();
    vault.set("img.png", "v1");
    await engine.sync();
    await server.seedRemoteCommit({ "img.png": "THEIRS" });
    vault.set("img.png", "OURS", now - 5000); // ours older → theirs takes the path

    const res = await engine.sync();

    const d: ConflictInfo = res.conflictDetails[0];
    expect(d.kept).toBe("theirs");
    expect(d.copy).toBe(res.conflicts[0]);
    expect(vault.text("img.png")).toBe("THEIRS");
    expect(vault.text(d.copy!)).toBe("OURS");
  });
});
