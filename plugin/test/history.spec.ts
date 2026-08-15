import { describe, it, expect, beforeEach } from "vitest";
import { SyncEngine } from "../src/sync";
import { FakeServer, FakeStore, FakeVault } from "./fakes";
import { ApiError } from "../src/api";
import { VaultCrypto } from "../src/crypto";
import { parseHistoryPage } from "../src/types";

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

  it("stops on a chain that loops instead of listing the same snapshots to the limit", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    // The server now refuses to re-issue a manifest id, so this is corruption that predates
    // the rule; the walk must still terminate on what it can read.
    const root = server.manifests.get(heads[0])!;
    server.manifests.set(heads[0], { ...root, parent: heads[2] });

    const history = await engine.listHistory(10);

    expect(history.map((h) => h.id)).toEqual([heads[2], heads[1], heads[0]]);
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

describe("SyncEngine.listHistory with changes", () => {
  /** `a.md` grows by two lines, `b.md` arrives, `c.md` goes. */
  async function edits(engine: SyncEngine): Promise<string[]> {
    const heads: string[] = [];
    vault.set("a.md", ["one", "two"].join("\n"));
    vault.set("c.md", "doomed");
    await engine.sync();
    heads.push(server.head!);

    vault.set("a.md", ["one", "two", "three", "four"].join("\n"), 1_754_000_100_000);
    vault.set("b.md", "bee", 1_754_000_200_000);
    vault.delete("c.md");
    await engine.sync();
    heads.push(server.head!);
    return heads;
  }

  it("says what each snapshot added, removed and modified", async () => {
    const engine = makeEngine();
    const heads = await edits(engine);

    const history = await engine.listHistory(10, { changes: true });

    const changes = history[0].changes;
    if (changes === undefined || "unknown" in changes) throw new Error("expected a diff");
    expect(history[0].id).toBe(heads[1]);
    expect(changes.added).toBe(1);
    expect(changes.removed).toBe(1);
    expect(changes.modified).toBe(1);
    expect(changes.files.map((f) => [f.path, f.kind])).toEqual([
      // Most recently edited first: b.md (200000) then a.md (100000) then the removed c.md.
      ["b.md", "added"],
      ["a.md", "modified"],
      ["c.md", "removed"],
    ]);
  });

  it("splits the line counts by sign instead of letting files cancel out", async () => {
    const engine = makeEngine();
    await edits(engine);

    const changes = (await engine.listHistory(10, { changes: true }))[0].changes;
    if (changes === undefined || "unknown" in changes) throw new Error("expected a diff");

    // a.md +2, b.md +1 arriving, c.md -1 leaving.
    expect(changes.linesAdded).toBe(3);
    expect(changes.linesRemoved).toBe(1);
    expect(changes.linesUnknown).toBe(0);
    expect(changes.files.find((f) => f.path === "a.md")?.lines).toBe(2);
    expect(changes.files.find((f) => f.path === "c.md")?.lines).toBe(-1);
  });

  it("counts a binary file as unattributable rather than as zero lines", async () => {
    const engine = makeEngine();
    vault.set("a.md", "text");
    await engine.sync();
    vault.set("shot.png", new Uint8Array([0x89, 0x00, 0x01]), 1_754_000_100_000);
    await engine.sync();

    const changes = (await engine.listHistory(10, { changes: true }))[0].changes;
    if (changes === undefined || "unknown" in changes) throw new Error("expected a diff");
    expect(changes.added).toBe(1);
    expect(changes.linesUnknown).toBe(1);
    expect(changes.linesAdded).toBe(0);
    expect(changes.files[0].lines).toBeNull();
    // Bytes still work, which is what makes the figure useful for pre-`lines` history.
    expect(changes.bytes).toBe(3);
  });

  it("calls a modified file unattributable when one side has no count", async () => {
    const engine = makeEngine();
    // A snapshot from before `lines` existed: seven lines, no recorded count.
    const legacy = await server.seedRemoteCommit({
      "old.md": ["1", "2", "3", "4", "5", "6", "7"].join("\n"),
    });
    const manifest = server.manifests.get(legacy)!;
    if (manifest.v !== 1) throw new Error("expected plaintext manifest");
    expect(manifest.files["old.md"].lines).toBeUndefined();
    await engine.sync();
    vault.set("old.md", ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n"), 1_754_000_100_000);
    await engine.sync();

    const changes = (await engine.listHistory(10, { changes: true }))[0].changes;
    if (changes === undefined || "unknown" in changes) throw new Error("expected a diff");
    const change = changes.files.find((f) => f.path === "old.md")!;
    // Reporting +10 here would be a fabricated figure: the true delta is +3, and this device
    // has no way to know that. Unknown is the only honest answer.
    expect(change.kind).toBe("modified");
    expect(change.lines).toBeNull();
    expect(changes.linesUnknown).toBe(1);
    expect(changes.linesAdded).toBe(0);
  });

  it("calls a text file turned binary, and the reverse, unattributable", async () => {
    const engine = makeEngine();
    vault.set("a.md", ["1", "2", "3", "4"].join("\n"));
    vault.set("b.md", new Uint8Array([0x00, 0x01, 0x02]));
    await engine.sync();
    // a.md becomes binary; b.md becomes text. Neither delta can be attributed.
    vault.set("a.md", new Uint8Array([0x00, 0xff]), 1_754_000_100_000);
    vault.set("b.md", ["x", "y"].join("\n"), 1_754_000_100_000);
    await engine.sync();

    const changes = (await engine.listHistory(10, { changes: true }))[0].changes;
    if (changes === undefined || "unknown" in changes) throw new Error("expected a diff");
    expect(changes.files.map((f) => f.lines)).toEqual([null, null]);
    expect(changes.linesUnknown).toBe(2);
    expect(changes.linesAdded).toBe(0);
    expect(changes.linesRemoved).toBe(0);
  });

  it("counts a modification when both sides carry a count", async () => {
    const engine = makeEngine();
    vault.set("a.md", ["1", "2", "3"].join("\n"));
    await engine.sync();
    vault.set("a.md", ["1", "2", "3", "4", "5"].join("\n"), 1_754_000_100_000);
    await engine.sync();

    const changes = (await engine.listHistory(10, { changes: true }))[0].changes;
    if (changes === undefined || "unknown" in changes) throw new Error("expected a diff");
    expect(changes.files[0].lines).toBe(2);
    expect(changes.linesUnknown).toBe(0);
  });

  it("treats the vault's first snapshot as all additions, not as unknown", async () => {
    const engine = makeEngine();
    const heads = await edits(engine);

    const history = await engine.listHistory(10, { changes: true });
    const oldest = history[history.length - 1];

    expect(oldest.id).toBe(heads[0]);
    const changes = oldest.changes;
    if (changes === undefined || "unknown" in changes) throw new Error("expected a diff");
    expect(changes.initial).toBe(true);
    expect(changes.added).toBe(2);
    expect(changes.removed).toBe(0);
  });

  it("diffs the oldest listed snapshot by reading one manifest past the limit", async () => {
    const engine = makeEngine();
    await edits(engine);

    const history = await engine.listHistory(1, { changes: true });

    expect(history).toHaveLength(1);
    const changes = history[0].changes;
    if (changes === undefined || "unknown" in changes) throw new Error("expected a diff");
    expect(changes.initial).toBe(false);
    expect(changes.modified).toBe(1);
  });

  it("costs no extra fetch when diffs were not asked for", async () => {
    const engine = makeEngine();
    await edits(engine);
    const before = server.manifestFetches.length;

    await engine.listHistory(1);

    expect(server.manifestFetches.length - before).toBe(1);
    expect((await engine.listHistory(1))[0].changes).toBeUndefined();
  });

  it("says the parent is missing rather than reporting an empty diff", async () => {
    const engine = makeEngine();
    const heads = await edits(engine);
    server.manifests.delete(heads[0]);

    const history = await engine.listHistory(10, { changes: true });

    expect(history.map((h) => h.id)).toEqual([heads[1]]);
    expect(history[0].changes).toEqual({ unknown: "parent-missing" });
  });

  it("propagates a server failure instead of calling it retention", async () => {
    const engine = makeEngine();
    const heads = await edits(engine);
    // A 503 says nothing about whether the vault still holds that snapshot. Reporting it as
    // "no longer retained" turns an actionable error into a false fact about the user's history.
    server.failManifest.set(heads[0], new ApiError("upstream is busy", 503, "server_error"));

    await expect(engine.listHistory(10, { changes: true })).rejects.toThrow(/busy/);
  });

  it("propagates a failure on the extra parent fetch the diff needs", async () => {
    const engine = makeEngine();
    const heads = await edits(engine);
    server.failManifest.set(heads[0], new ApiError("rate limited", 429, "rate_limited"));

    // The limit-1 walk never lists heads[0]; it reads it only to diff the row above.
    await expect(engine.listHistory(1, { changes: true })).rejects.toThrow(/rate limited/);
  });

  it("propagates a transport failure rather than reporting an empty history", async () => {
    const engine = makeEngine();
    const heads = await edits(engine);
    server.failManifest.set(heads[1], new Error("network unreachable"));

    await expect(engine.listHistory(10)).rejects.toThrow(/network unreachable/);
  });

  it("refuses to call a head that 404s an empty vault", async () => {
    const engine = makeEngine();
    const heads = await edits(engine);
    // The server's own pointer names a snapshot it no longer has. Saying "no snapshots yet"
    // would tell the user their vault is new.
    server.manifests.delete(heads[1]);

    await expect(engine.listHistory(10, { changes: true })).rejects.toThrow(/unknown manifest/);
  });

  it("marks a snapshot it cannot decrypt, and the child that has nothing to compare to", async () => {
    const engine = makeEngine();
    vault.set("a.md", "one");
    await engine.sync();
    server.seedRemoteEncryptedCommit({ keyId: "not-our-key" });
    // A readable snapshot on top, whose parent is the unreadable one.
    await server.seedRemoteCommit({ "a.md": "one", "later.md": "later" });

    const history = await engine.listHistory(10, { changes: true });

    expect(history[0].changes).toEqual({ unknown: "parent-unreadable" });
    expect(history[1].changes).toEqual({ unknown: "unreadable" });
  });

  it("reports no changes as an empty diff, not as unknown", async () => {
    const engine = makeEngine();
    vault.set("a.md", "one");
    await engine.sync();
    const first = server.head!;
    // A second snapshot holding exactly the same files, as a forced push would produce.
    await server.seedRemoteCommit({ "a.md": "one" });

    const history = await engine.listHistory(10, { changes: true });

    expect(history[0].parent).toBe(first);
    const changes = history[0].changes;
    if (changes === undefined || "unknown" in changes) throw new Error("expected a diff");
    expect(changes.files).toEqual([]);
    expect(changes.added + changes.removed + changes.modified).toBe(0);
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

  it("writes a numbered copy instead of overwriting live content", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);

    const out = await engine.restoreFile(heads[0], "a.md");

    expect(out).toEqual({ kind: "copied", path: "a (2).md", requested: "a.md" });
    // The live file is what matters here: restoring must never be the reason work vanishes.
    expect(vault.text("a.md")).toBe("three");
    expect(vault.text("a (2).md")).toBe("one");
  });

  it("writes nothing when the live file is already that content", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    vault.writes.length = 0;

    const out = await engine.restoreFile(heads[2], "a.md");

    expect(out).toEqual({ kind: "identical", path: "a.md", requested: "a.md" });
    expect(vault.writes).toEqual([]);
    expect(server.downloads).toEqual([]);
  });

  it("writes in place when nothing is at the path", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);

    const out = await engine.restoreFile(heads[1], "b.md");

    expect(out).toEqual({ kind: "written", path: "b.md", requested: "b.md" });
    expect(vault.text("b.md")).toBe("bee");
  });

  it("restores to a destination the caller chose", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);

    const out = await engine.restoreFile(heads[0], "a.md", { destination: "old/a.md" });

    expect(out).toEqual({ kind: "written", path: "old/a.md", requested: "old/a.md" });
    expect(vault.text("old/a.md")).toBe("one");
    expect(vault.text("a.md")).toBe("three");
  });

  it("steps past a numbered copy that is already taken by other content", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    vault.set("a (2).md", "something else entirely");

    const out = await engine.restoreFile(heads[0], "a.md");

    expect(out.path).toBe("a (3).md");
    expect(vault.text("a (2).md")).toBe("something else entirely");
    expect(vault.text("a (3).md")).toBe("one");
  });

  it("stops at a numbered copy that already holds exactly this content", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    await engine.restoreFile(heads[0], "a.md");
    vault.writes.length = 0;

    // Clicking Restore twice must not litter the vault with identical copies.
    const out = await engine.restoreFile(heads[0], "a.md");

    expect(out).toEqual({ kind: "identical", path: "a (2).md", requested: "a.md" });
    expect(vault.writes).toEqual([]);
  });

  it("refuses a chosen destination this device would never sync", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);

    await expect(
      engine.restoreFile(heads[0], "a.md", { destination: ".obsidian/sneaky.md" })
    ).rejects.toThrow(/not synced/);
    expect(vault.files.has(".obsidian/sneaky.md")).toBe(false);
  });

  it("refuses an overwrite that does not name the version it replaces", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);

    // Unbounded approval is the bug: it applies to whatever happens to be there on arrival.
    await expect(engine.restoreFile(heads[0], "a.md", { overwrite: true })).rejects.toThrow(
      /must name the version it replaces/
    );
    expect(vault.text("a.md")).toBe("three");
  });

  it("refuses an overwrite whose file changed since it was approved", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    const approved = await engine.inspectRestore(heads[0], "a.md");
    // The confirmation sits open while the note is edited — by the user, another plugin, or a
    // filesystem process. That edit must survive the click.
    vault.set("a.md", "written while the dialog was open", 1_754_000_400_000);

    await expect(
      engine.restoreFile(heads[0], "a.md", {
        overwrite: true,
        expectedHash: approved.currentHash,
      })
    ).rejects.toThrow(/changed while the restore was being confirmed/);
    expect(vault.text("a.md")).toBe("written while the dialog was open");
  });

  it("overwrites when the file is still the version that was approved", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    const approved = await engine.inspectRestore(heads[0], "a.md");

    const out = await engine.restoreFile(heads[0], "a.md", {
      overwrite: true,
      expectedHash: approved.currentHash,
    });

    expect(out.kind).toBe("replaced");
    expect(vault.text("a.md")).toBe("one");
  });

  it("refuses an in-place write when a file appeared where none was inspected", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    const approved = await engine.inspectRestore(heads[1], "b.md");
    expect(approved.currentHash).toBeNull();
    vault.set("b.md", "created after the decision", 1_754_000_400_000);

    await expect(
      engine.restoreFile(heads[1], "b.md", { expectedHash: approved.currentHash })
    ).rejects.toThrow(/changed while the restore was being confirmed/);
    expect(vault.text("b.md")).toBe("created after the decision");
  });

  it("refuses to write a copy onto a destination taken while the blob downloaded", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    // The free path is chosen before the fetch; the fetch is the window this exploits.
    server.beforeGetBlob = () => {
      vault.set("a (2).md", "someone else got there first", 1_754_000_400_000);
    };

    await expect(engine.restoreFile(heads[0], "a.md")).rejects.toThrow(
      /changed while the restore was being confirmed/
    );
    expect(vault.text("a (2).md")).toBe("someone else got there first");
  });

  it("settles as identical when the destination became the wanted content mid-flight", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    const wanted = "one";
    server.beforeGetBlob = () => {
      vault.set("a (2).md", wanted, 1_754_000_400_000);
    };

    const out = await engine.restoreFile(heads[0], "a.md");

    // Nothing to do and nothing lost — an error here would be noise, not safety.
    expect(out).toEqual({ kind: "identical", path: "a (2).md", requested: "a.md" });
  });

  it("refuses a chosen destination that is not a valid vault path", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);

    await expect(
      engine.restoreFile(heads[0], "a.md", { destination: "../escape.md" })
    ).rejects.toThrow(/not a valid vault path/);
  });
});

describe("SyncEngine.inspectRestore", () => {
  it("reports an absent file, with a copy suggestion named for the snapshot", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    const seen = await engine.inspectRestore(heads[1], "b.md");

    expect(seen.current).toBe("absent");
    expect(seen.unsyncedEdits).toBe(false);
    expect(seen.suggestion).toMatch(/^b \(restored \d{4}-\d{2}-\d{2}\)\.md$/);
  });

  it("reports identical content without proposing anything be written", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);

    expect((await engine.inspectRestore(heads[2], "a.md")).current).toBe("identical");
  });

  it("says the live file is safe when its bytes are the ones last synced", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    const seen = await engine.inspectRestore(heads[0], "a.md");

    expect(seen.current).toBe("differs");
    // "three" is the published head, so replacing it loses nothing permanently.
    expect(seen.unsyncedEdits).toBe(false);
  });

  it("flags a live file edited since the last pass as the only copy there is", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    vault.set("a.md", "written just now, never synced", 1_754_000_300_000);

    const seen = await engine.inspectRestore(heads[0], "a.md");

    expect(seen.current).toBe("differs");
    expect(seen.unsyncedEdits).toBe(true);
  });

  it("refuses a path the snapshot never held", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);

    await expect(engine.inspectRestore(heads[2], "b.md")).rejects.toThrow(/not in snapshot/);
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

// Listing history from the server's index instead of walking it.
//
// The walk is a linked list over the network: a parent is unknowable until its child has been
// fetched AND decrypted, so N snapshots cost N sequential round trips carrying the whole
// encrypted path map. Measured on the real vault that is 12.7 MiB over 41 round trips to draw
// a list of dates. Given the chain up front the same rows cost bounded-parallel fetches, and on
// a second open, almost nothing.
describe("SyncEngine.listHistory over the server index", () => {
  it("produces exactly what the walk produces", async () => {
    const engine = makeEngine();
    await threeCommits(engine);
    const walked = await engine.listHistory(10, { changes: true });

    // A different route to the same answer, or it is not a fast path — it is a second
    // implementation of history with its own opinions.
    server.serveHistoryIndex = true;
    const indexed = await makeEngine().listHistory(10, { changes: true });

    expect(indexed).toEqual(walked);
  });

  it("asks for the chain once and never walks it", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    server.serveHistoryIndex = true;

    const fresh = makeEngine();
    server.manifestFetches.length = 0;
    const history = await fresh.listHistory(10, { changes: true });

    expect(history.map((h) => h.id)).toEqual([heads[2], heads[1], heads[0]]);
    expect(server.historyRequests).toEqual([10]);
    // Every manifest still needed, but asked for as a set rather than one at a time — which
    // is the whole difference, and is only possible because the chain arrived first.
    expect([...server.manifestFetches].sort()).toEqual([...heads].sort());
  });

  it("reopens without refetching what it already built", async () => {
    const engine = makeEngine();
    await threeCommits(engine);
    server.serveHistoryIndex = true;

    const first = await engine.listHistory(10, { changes: true });
    server.manifestFetches.length = 0;
    const second = await engine.listHistory(10, { changes: true });

    // A manifest id is permanent and one-use and its parent link never moves, so a row that
    // has been built can never be wrong. Nothing to invalidate, nothing to refetch.
    expect(second).toEqual(first);
    expect(server.manifestFetches).toEqual([]);
  });

  it("fetches only the snapshots made since it was last open", async () => {
    const engine = makeEngine();
    await threeCommits(engine);
    server.serveHistoryIndex = true;
    await engine.listHistory(10, { changes: true });

    vault.set("c.md", "sea", 1_754_000_300_000);
    await engine.sync();
    const newest = server.head!;
    const parent = (await engine.listHistory(10))[1].id;
    server.manifestFetches.length = 0;

    const history = await engine.listHistory(10, { changes: true });

    expect(history[0].id).toBe(newest);
    expect(history[0].changes).toEqual(expect.objectContaining({ added: 1, removed: 0 }));
    // The new snapshot, plus its parent — whose path map the diff needs and which the cached
    // row does not carry. Two, not four.
    expect([...server.manifestFetches].sort()).toEqual([newest, parent].sort());
  });

  it("falls back to the walk against a Worker that has no such route", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    server.serveHistoryIndex = false;

    const history = await makeEngine().listHistory(10, { changes: true });

    expect(history.map((h) => h.id)).toEqual([heads[2], heads[1], heads[0]]);
  });

  it("falls back rather than showing less history than the vault has", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    server.serveHistoryIndex = true;
    // The oldest snapshot predates the server's index. Listing the two it can reach would be
    // a quiet claim that the vault has two snapshots, which is a lie about the user's own
    // history — worse than being slow.
    server.unindexed.add(heads[0]);

    const history = await makeEngine().listHistory(10, { changes: true });

    expect(history.map((h) => h.id)).toEqual([heads[2], heads[1], heads[0]]);
  });

  it("stops at a snapshot the index lists but the bucket no longer holds", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    server.serveHistoryIndex = true;
    server.manifests.delete(heads[0]);

    const history = await makeEngine().listHistory(10, { changes: true });

    // Retention trimmed it. The readable prefix is still shown, and the row that lost its
    // parent says so rather than reporting a diff against nothing.
    expect(history.map((h) => h.id)).toEqual([heads[2], heads[1]]);
    expect(history[1].changes).toEqual({ unknown: "parent-missing" });
  });

  it("propagates a transport failure instead of calling it retention", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    server.serveHistoryIndex = true;
    server.failManifest.set(heads[1], new ApiError("service unavailable", 503, "unavailable"));

    // Only a typed 404 is evidence about history. Reporting a 503 as "no longer retained"
    // turns a retryable error into a false fact about the user's snapshots.
    await expect(makeEngine().listHistory(10, { changes: true })).rejects.toThrow(/unavailable/);
  });

  it("marks a snapshot this device's key cannot open, without hiding the rest", async () => {
    const engine = makeEngine({ crypto: await VaultCrypto.fromText("A".repeat(43) + "=") });
    vault.set("a.md", "one");
    await engine.sync();
    server.serveHistoryIndex = true;

    const other = makeEngine({ crypto: await VaultCrypto.fromText("B".repeat(43) + "=") });
    const history = await other.listHistory(10, { changes: true });

    expect(history).toHaveLength(1);
    expect(history[0].readable).toBe(false);
    expect(history[0].fileCount).toBeNull();
    expect(history[0].changes).toEqual({ unknown: "unreadable" });
    // Still named, because the envelope is not encrypted and the row is what tells the user
    // which device wrote a snapshot they cannot read.
    expect(history[0].device).toBe("test-device");
  });
});

// A listing is a chain, and the client checks that it is one. A page whose parent links do not
// join up would have the engine diff two snapshots that are not parent and child — a wrong
// answer presented as a fact about the user's own history.
describe("parseHistoryPage", () => {
  const row = (id: string, parent: string | null) => ({
    id,
    parent,
    uploadedAt: 1,
    device: "d",
    createdAt: "2026-08-15T00:00:00.000Z",
  });

  it("accepts a well-formed chain", () => {
    const page = parseHistoryPage({ complete: true, entries: [row("B", "A"), row("A", null)] });
    expect(page.entries.map((e) => e.id)).toEqual(["B", "A"]);
    expect(page.complete).toBe(true);
  });

  it("accepts rows the server has not described yet", () => {
    const page = parseHistoryPage({
      complete: true,
      entries: [{ id: "A", parent: null, uploadedAt: 1, device: null, createdAt: null }],
    });
    expect(page.entries[0]).toEqual(expect.objectContaining({ device: null, createdAt: null }));
  });

  it("refuses a listing whose links do not join up", () => {
    expect(() => parseHistoryPage({ complete: true, entries: [row("B", "A"), row("C", null)] })).toThrow(
      /does not follow/
    );
  });

  it("refuses a repeated id, which cannot be a chain", () => {
    // A manifest id is used once, ever. A repeat means a loop, and a walk that trusted it
    // would list the same snapshots until it hit the limit.
    expect(() => parseHistoryPage({ complete: true, entries: [row("A", "A")] })).toThrow(/twice/);
  });

  it("refuses a page that is missing its completeness answer", () => {
    // Defaulting it to true would turn "I could not reach the rest" into "there is no rest".
    expect(() => parseHistoryPage({ entries: [] })).toThrow(/complete is missing/);
  });

  it("refuses malformed rows rather than passing them through", () => {
    for (const bad of [
      { complete: true, entries: [{ ...row("A", null), id: "" }] },
      { complete: true, entries: [{ ...row("A", null), uploadedAt: "soon" }] },
      { complete: true, entries: [{ ...row("A", null), parent: 7 }] },
      { complete: true, entries: [{ ...row("A", null), device: 7 }] },
      { complete: true, entries: ["nope"] },
      { complete: true },
      null,
    ]) {
      expect(() => parseHistoryPage(bad)).toThrow(/invalid history/);
    }
  });
});

// The index is a convenience, never an authority. These are the three ways trusting it would
// have produced a confident wrong answer about the user's own history.
describe("SyncEngine.listHistory does not trust the index over the manifests", () => {
  it("propagates a head the server lists but no longer holds", async () => {
    const engine = makeEngine();
    await threeCommits(engine);
    server.serveHistoryIndex = true;
    // The listing still names the head; only the object is gone. Deleting it before capturing
    // the page would make the page incomplete and send this down the fallback walk instead —
    // which passes for the wrong reason and proves nothing about the indexed path.
    const listed = await server.getHistory(10);
    server.getHistory = async () => listed;
    server.manifests.delete(server.head!);

    // Not retention, and not an empty vault: it is a server whose own pointer names a snapshot
    // it lost. Returning [] would tell the user their history does not exist.
    await expect(makeEngine().listHistory(10, { changes: true })).rejects.toThrow(/unknown manifest/);
  });

  it("still treats a missing ANCESTOR as retention, not as a fault", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    server.serveHistoryIndex = true;
    const listed = await server.getHistory(10);
    server.getHistory = async () => listed;
    server.manifests.delete(heads[0]);

    const history = await makeEngine().listHistory(10, { changes: true });

    expect(history.map((h) => h.id)).toEqual([heads[2], heads[1]]);
    expect(history[1].changes).toEqual({ unknown: "parent-missing" });
  });

  it("refuses a listing whose parent disagrees with the snapshot itself", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    server.serveHistoryIndex = true;
    const real = await server.getHistory(10);
    // A chain the manifests contradict. `parent` is covered by `manifestAad` on a v3
    // envelope, so the fetched snapshot is the authenticated version — believing the index
    // instead would diff a snapshot against something that is not its parent, and cache it.
    server.getHistory = async () => ({
      complete: true,
      entries: real!.entries.map((e) =>
        e.id === heads[2] ? { ...e, parent: heads[0] } : e
      ),
    });

    await expect(makeEngine().listHistory(10, { changes: true })).rejects.toThrow(
      /but the snapshot itself names/
    );
  });

  it("reports the snapshot's own device and time, not the index's", async () => {
    const engine = makeEngine({ deviceName: "real-device" });
    vault.set("a.md", "one");
    await engine.sync();
    server.serveHistoryIndex = true;
    const real = await server.getHistory(10);
    server.getHistory = async () => ({
      complete: true,
      entries: real!.entries.map((e) => ({ ...e, device: "wrong", createdAt: "1999-01-01T00:00:00.000Z" })),
    });

    const history = await makeEngine().listHistory(10, { changes: true });

    expect(history[0].device).toBe("real-device");
    expect(history[0].createdAt).not.toBe("1999-01-01T00:00:00.000Z");
  });
});
