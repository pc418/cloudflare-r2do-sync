import { describe, it, expect, beforeEach } from "vitest";
import { SyncEngine } from "../src/sync";
import { StaleHeadError } from "../src/api";
import { FakeServer, FakeStore, FakeVault } from "./fakes";
import type { Manifest, ManifestV1 } from "../src/types";

let vault: FakeVault;
let server: FakeServer;
let store: FakeStore;
let engine: SyncEngine;

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
  engine = makeEngine();
});

function plainFiles(m: Manifest): ManifestV1["files"] {
  if (m.v !== 1) throw new Error(`expected a plaintext manifest, got v${m.v}`);
  return m.files;
}

const byPath = (changes: Array<{ path: string }>) => changes.map((c) => c.path).sort();

describe("what a pass reports it pushed", () => {
  it("names every file of a first sync as an addition, with its line count", async () => {
    vault.set("a.md", "one\ntwo\nthree");
    vault.set("b.md", "solo");

    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(res.pushedChanges).toEqual([
      { path: "a.md", action: "add", lines: 3 },
      { path: "b.md", action: "add", lines: 1 },
    ]);
    expect(res.pulledChanges).toEqual([]);
  });

  it("reports an edit as a net line change against the previous snapshot", async () => {
    vault.set("log.md", "day one");
    await engine.sync();

    vault.set("log.md", "day one\nday two\nday three", 1_754_000_100_000);
    const res = await engine.sync();

    expect(res.pushedChanges).toEqual([{ path: "log.md", action: "update", lines: 2 }]);
  });

  it("reports a shrinking file as a negative net change", async () => {
    vault.set("log.md", "a\nb\nc\nd");
    await engine.sync();

    vault.set("log.md", "a", 1_754_000_100_000);
    const res = await engine.sync();

    expect(res.pushedChanges).toEqual([{ path: "log.md", action: "update", lines: -3 }]);
  });

  it("attributes every line of a deleted file, from the count it cached", async () => {
    vault.set("gone.md", "1\n2\n3\n4\n5");
    vault.set("stay.md", "x");
    await engine.sync();

    vault.delete("gone.md");
    const res = await engine.sync();

    expect(res.pushedChanges).toEqual([{ path: "gone.md", action: "delete", lines: -5 }]);
  });

  it("leaves binary content unattributed instead of counting bytes as lines", async () => {
    vault.set("img.png", new Uint8Array([0x89, 0x50, 0x00, 0x01, 0x02]));
    const res = await engine.sync();

    expect(res.pushedChanges).toEqual([{ path: "img.png", action: "add", lines: null }]);
  });

  it("reports nothing pushed when the pass had nothing to do", async () => {
    vault.set("a.md", "one");
    await engine.sync();

    const res = await engine.sync();
    expect(res.status).toBe("unchanged");
    expect(res.pushedChanges).toEqual([]);
  });

  it("carries the current snapshot on a pass that committed nothing", async () => {
    // The field the "show the current snapshot" notice reads. `committed` and `pulled` have a
    // `head` of their own describing what the pass produced; an `unchanged` pass produced
    // nothing, so without this there is no way to say which snapshot "up to date" means.
    vault.set("a.md", "one");
    const first = await engine.sync();
    expect(first.status).toBe("committed");

    const idle = await engine.sync();
    expect(idle.status).toBe("unchanged");
    // The same snapshot the commit produced, and the one the device's own state records.
    expect(idle.currentHead).toBe(first.status === "committed" ? first.head : null);
    expect(idle.currentHead).toBe(store.state?.lastSyncedHead);
  });

  it("has no current snapshot before anything has ever been committed", async () => {
    // Null rather than an empty string, so the notice can say "nothing committed yet" instead
    // of printing a blank id.
    const res = await engine.sync();
    expect(res.status).toBe("unchanged");
    expect(res.currentHead).toBeNull();
  });

  it("caches counts only for paths still in the snapshot", async () => {
    vault.set("a.md", "1\n2");
    vault.set("b.md", "1");
    await engine.sync();
    vault.delete("b.md");
    await engine.sync();

    expect(store.state?.lines).toEqual({ "a.md": 2 });
  });

  it("records the count in the manifest so history can be diffed without downloading blobs", async () => {
    vault.set("a.md", "1\n2");
    await engine.sync();

    const entry = plainFiles(server.manifests.get(server.head!)!)["a.md"];
    expect(Object.keys(entry).sort()).toEqual(["h", "lines", "mtime", "size"]);
    expect(entry.lines).toBe(2);
  });

  it("omits the count for binary content rather than claiming zero lines", async () => {
    vault.set("shot.png", new Uint8Array([0x89, 0x50, 0x00, 0x01]));
    await engine.sync();

    const entry = plainFiles(server.manifests.get(server.head!)!)["shot.png"];
    expect(entry.lines).toBeUndefined();
    expect(Object.keys(entry).sort()).toEqual(["h", "mtime", "size"]);
  });
});

describe("what a pass reports it pulled", () => {
  it("names a file that arrived from another device, and counts its lines", async () => {
    vault.set("mine.md", "mine");
    await engine.sync();
    await server.seedRemoteCommit({ "mine.md": "mine", "theirs.md": "one\ntwo" });

    const res = await engine.sync();

    expect(byPath(res.pulledChanges)).toEqual(["theirs.md"]);
    expect(res.pulledChanges[0]).toEqual({ path: "theirs.md", action: "add", lines: 2 });
  });

  it("reports a remote overwrite as an update with its net line change", async () => {
    vault.set("note.md", "one\ntwo\nthree");
    await engine.sync();
    // Untouched locally, so the merge takes theirs outright.
    await server.seedRemoteCommit({ "note.md": "one" });

    const res = await engine.sync();

    expect(res.pulledChanges).toEqual([{ path: "note.md", action: "update", lines: -2 }]);
  });

  it("reports a remote deletion as every line removed", async () => {
    vault.set("note.md", "one\ntwo");
    vault.set("keep.md", "k");
    await engine.sync();
    await server.seedRemoteCommit({ "keep.md": "k" });

    const res = await engine.sync();

    expect(res.pulledChanges).toEqual([{ path: "note.md", action: "delete", lines: -2 }]);
  });

  it("marks a clean three-way merge as a merge, not a plain write", async () => {
    vault.set("note.md", "base");
    await engine.sync();

    vault.set("note.md", "base\nmine", 1_754_000_100_000);
    await server.seedRemoteCommit({ "note.md": "theirs\nbase" });

    const res = await engine.sync();

    const merged = res.pulledChanges.find((c) => c.path === "note.md");
    expect(merged?.action).toBe("merge");
    expect(merged?.lines).not.toBeNull();
  });

  it("keeps the two directions separate so one pass cannot double count", async () => {
    vault.set("mine.md", "m");
    await engine.sync();
    vault.set("fresh.md", "f", 1_754_000_100_000);
    await server.seedRemoteCommit({ "mine.md": "m", "theirs.md": "t" });

    const res = await engine.sync();

    expect(byPath(res.pushedChanges)).toEqual(["fresh.md"]);
    expect(byPath(res.pulledChanges)).toEqual(["theirs.md"]);
  });

  it("updates the cached counts in pull-only mode, which never commits", async () => {
    engine = makeEngine({ mode: "pull-only" });
    await server.seedRemoteCommit({ "theirs.md": "one\ntwo\nthree" });

    const first = await engine.sync();
    expect(first.status).toBe("pulled");
    expect(first.pulledChanges).toEqual([{ path: "theirs.md", action: "add", lines: 3 }]);
    expect(store.state?.lines).toEqual({ "theirs.md": 3 });

    // A second remote edit must be measured against the count the first pass left behind.
    await server.seedRemoteCommit({ "theirs.md": "one" });
    const second = await engine.sync();
    expect(second.pulledChanges).toEqual([{ path: "theirs.md", action: "update", lines: -2 }]);
  });
});

describe("a file that changes while the pass is publishing it", () => {
  it("rescans and publishes what the file became, instead of failing the pass", async () => {
    vault.set("a.md", "first");
    vault.beforeRead = (path, count) => {
      // Read 1 is the scan that builds the snapshot; read 2 is the upload re-reading it.
      if (path === "a.md" && count === 2) vault.set("a.md", "second", 1_754_000_100_000);
    };

    const res = await engine.sync();

    expect(res.status).toBe("committed");
    const entry = plainFiles(server.manifests.get(server.head!)!)["a.md"];
    expect(new TextDecoder().decode(server.blobs.get(entry.h)!)).toBe("second");
  });

  it("reports the rescanned content, not the content it first scanned", async () => {
    vault.set("a.md", "one");
    vault.beforeRead = (path, count) => {
      if (path === "a.md" && count === 2) vault.set("a.md", "one\ntwo\nthree", 1_754_000_100_000);
    };

    const res = await engine.sync();
    expect(res.pushedChanges).toEqual([{ path: "a.md", action: "add", lines: 3 }]);
  });

  it("fails loudly and names the file when it never settles", async () => {
    let version = 0;
    vault.set("busy.md", "v0");
    vault.beforeRead = (path) => {
      if (path === "busy.md") vault.set("busy.md", `v${++version}`, 1_754_000_000_000 + version);
    };

    await expect(engine.sync()).rejects.toThrow(/busy\.md.*kept changing/s);
    // Nothing half-published: the commit never happened.
    expect(server.head).toBeNull();
  });

  it("bounds the rescans rather than re-reading the vault forever", async () => {
    vault.set("busy.md", "v0");
    let version = 0;
    vault.beforeRead = (path) => {
      if (path === "busy.md") vault.set("busy.md", `v${++version}`, 1_754_000_000_000 + version);
    };

    await expect(engine.sync()).rejects.toThrow();
    // 4 scans at most (the first plus MAX_RESCAN_ATTEMPTS), each reading the file twice.
    expect(vault.reads.filter((p) => p === "busy.md").length).toBeLessThanOrEqual(8);
  });

  it("treats a file that grew past the size limit as a rescan, then reports it skipped", async () => {
    engine = makeEngine({ maxBlobBytes: 16 });
    vault.set("small.md", "tiny");
    vault.set("other.md", "o");
    vault.beforeRead = (path, count) => {
      if (path === "small.md" && count === 2) {
        vault.set("small.md", "x".repeat(64), 1_754_000_100_000);
      }
    };

    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(res.skipped.map((s) => s.path)).toEqual(["small.md"]);
    expect(Object.keys(plainFiles(server.manifests.get(server.head!)!))).toEqual(["other.md"]);
  });

  it("does not spend the head-race budget on a rescan", async () => {
    // One rescan plus two lost races still has a third commit attempt left. Sharing a single
    // counter used to turn this into "another device keeps committing", which was not true.
    vault.set("a.md", "one");
    vault.beforeRead = (path, count) => {
      if (path === "a.md" && count === 2) vault.set("a.md", "two", 1_754_000_100_000);
    };
    server.failCommitsWith = [
      new StaleHeadError("head moved", null),
      new StaleHeadError("head moved", null),
    ];

    const res = await engine.sync();
    expect(res.status).toBe("committed");
  });
});
