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

    const history = (await engine.listHistory(10)).rows;

    expect(history.map((h) => h.id)).toEqual([heads[2], heads[1], heads[0]]);
    expect(history.map((h) => h.fileCount)).toEqual([1, 2, 1]);
    expect(history[0].device).toBe("test-device");
    expect(history[0].readable).toBe(true);
  });

  it("stops at the requested limit rather than walking the whole chain", async () => {
    const engine = makeEngine();
    await threeCommits(engine);

    expect((await engine.listHistory(2)).rows).toHaveLength(2);
  });

  it("returns nothing for an empty remote", async () => {
    expect((await makeEngine().listHistory(10)).rows).toEqual([]);
  });

  it("stops cleanly when an ancestor has been garbage-collected", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    server.manifests.delete(heads[0]);

    const history = (await engine.listHistory(10)).rows;

    expect(history.map((h) => h.id)).toEqual([heads[2], heads[1]]);
  });

  it("stops on a chain that loops instead of listing the same snapshots to the limit", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    // The server now refuses to re-issue a manifest id, so this is corruption that predates
    // the rule; the walk must still terminate on what it can read.
    const root = server.manifests.get(heads[0])!;
    server.manifests.set(heads[0], { ...root, parent: heads[2] });

    const history = (await engine.listHistory(10)).rows;

    expect(history.map((h) => h.id)).toEqual([heads[2], heads[1], heads[0]]);
  });

  it("marks snapshots it cannot decrypt instead of throwing", async () => {
    const engine = makeEngine();
    vault.set("a.md", "one");
    await engine.sync();
    server.seedRemoteEncryptedCommit({ keyId: "not-our-key" });

    const history = (await engine.listHistory(10)).rows;

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

    const history = (await engine.listHistory(10, { changes: true })).rows;

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

    const changes = (await engine.listHistory(10, { changes: true })).rows[0].changes;
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

    const changes = (await engine.listHistory(10, { changes: true })).rows[0].changes;
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

    const changes = (await engine.listHistory(10, { changes: true })).rows[0].changes;
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

    const changes = (await engine.listHistory(10, { changes: true })).rows[0].changes;
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

    const changes = (await engine.listHistory(10, { changes: true })).rows[0].changes;
    if (changes === undefined || "unknown" in changes) throw new Error("expected a diff");
    expect(changes.files[0].lines).toBe(2);
    expect(changes.linesUnknown).toBe(0);
  });

  it("treats the vault's first snapshot as all additions, not as unknown", async () => {
    const engine = makeEngine();
    const heads = await edits(engine);

    const history = (await engine.listHistory(10, { changes: true })).rows;
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

    const history = (await engine.listHistory(1, { changes: true })).rows;

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
    expect((await engine.listHistory(1)).rows[0].changes).toBeUndefined();
  });

  it("says the parent is missing rather than reporting an empty diff", async () => {
    const engine = makeEngine();
    const heads = await edits(engine);
    server.manifests.delete(heads[0]);

    const history = (await engine.listHistory(10, { changes: true })).rows;

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

    const history = (await engine.listHistory(10, { changes: true })).rows;

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

    const history = (await engine.listHistory(10, { changes: true })).rows;

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

  it("writes to a destination this device does not sync, because the user chose it", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);

    // A restore is not a sync. The sync policy decides what gets published automatically; it
    // has no business deciding where its owner may put a file they asked for by name.
    const out = await engine.restoreFile(heads[0], "a.md", { destination: ".obsidian/chosen.md" });

    expect(out).toEqual({ kind: "written", path: ".obsidian/chosen.md", requested: ".obsidian/chosen.md" });
    expect(vault.text(".obsidian/chosen.md")).toBe("one");
  });

  it("restores a config file the remote carries, in place", async () => {
    const engine = makeEngine({ excludes: [] });
    vault.set("a.md", "one");
    await engine.sync();
    // Carried through snapshots by a device that does sync the config folder. This device does
    // not, which used to make the only copy visible in history and impossible to get back.
    await server.seedRemoteCommit({ "a.md": "one", ".obsidian/app.json": "{\"theme\":\"moonstone\"}" });
    await engine.sync();

    const out = await engine.restoreFile(server.head!, ".obsidian/app.json");

    expect(out.kind).toBe("written");
    expect(vault.text(".obsidian/app.json")).toBe("{\"theme\":\"moonstone\"}");
  });

  it("restores third-party plugin code to a path the user picked", async () => {
    const engine = makeEngine({ excludes: [] });
    vault.set("a.md", "one");
    await engine.sync();
    await server.seedRemoteCommit({ "a.md": "one", ".obsidian/plugins/other/main.js": "console.log(1)" });
    await engine.sync();

    // Hard-skipped for *sync* because nobody should publish executable config by accident.
    // Recovering a copy of it on request is a different act, and the user names the target.
    const out = await engine.restoreFile(server.head!, ".obsidian/plugins/other/main.js", {
      destination: "recovered-main.js.txt",
    });

    expect(out.kind).toBe("written");
    expect(vault.text("recovered-main.js.txt")).toBe("console.log(1)");
  });

  it("numbers a copy beside an occupied destination this device does not sync", async () => {
    const engine = makeEngine({ excludes: [] });
    vault.set("a.md", "one");
    await engine.sync();
    await server.seedRemoteCommit({ "a.md": "one", ".obsidian/app.json": "{\"from\":\"remote\"}" });
    await engine.sync();
    vault.set(".obsidian/app.json", "{\"from\":\"local\"}");

    // Numbering used to be filtered by the sync policy, so every candidate beside an unsynced
    // destination was skipped and the restore claimed all copies were taken with (2) free.
    const out = await engine.restoreFile(server.head!, ".obsidian/app.json");

    expect(out.kind).toBe("copied");
    expect(out.path).toBe(".obsidian/app (2).json");
    expect(vault.text(".obsidian/app (2).json")).toBe("{\"from\":\"remote\"}");
    // And the file that was already there is untouched.
    expect(vault.text(".obsidian/app.json")).toBe("{\"from\":\"local\"}");
  });

  it("closes the plugin folder under any spelling a case-insensitive vault accepts", async () => {
    const engine = makeEngine();

    // macOS and Windows vaults are case-insensitive by default, so this names the live
    // credential file. A case-sensitive guard would wave it straight through to an overwrite.
    for (const spelling of [
      ".obsidian/plugins/cloudflare-rdo-sync/data.json",
      ".obsidian/plugins/CLOUDFLARE-RDO-SYNC/data.json",
      ".obsidian/plugins/Cloudflare-Rdo-Sync/data.json",
      ".obsidian/plugins/obsidian-log-sync/data.json",
    ]) {
      expect(engine.restoreDestinationBlock(spelling), spelling).not.toBeNull();
    }
    expect(engine.restoreDestinationBlock(".obsidian/plugins/other/data.json")).toBeNull();
    expect(engine.restoreDestinationBlock("notes/a.md")).toBeNull();
  });

  it("suggests a destination outside the folder it may not write to", async () => {
    const engine = makeEngine({ excludes: [] });
    vault.set("a.md", "one");
    await engine.sync();
    await server.seedRemoteCommit({
      "a.md": "one",
      ".obsidian/plugins/obsidian-log-sync/data.json": "secret",
    });
    await engine.sync();

    const seen = await engine.inspectRestore(
      server.head!,
      ".obsidian/plugins/obsidian-log-sync/data.json"
    );

    // The copy path of a file inside that folder is still inside it, so the offer has to leave.
    expect(engine.restoreDestinationBlock(seen.suggestion)).toBeNull();
    expect(seen.suggestion).not.toContain("plugins/");
  });

  it("leaves a restored unsynced file alone on the next pass rather than deleting it", async () => {
    const engine = makeEngine({ excludes: [] });
    vault.set("a.md", "one");
    await engine.sync();
    await server.seedRemoteCommit({ "a.md": "one", ".obsidian/app.json": "{}" });
    await engine.sync();

    await engine.restoreFile(server.head!, ".obsidian/app.json");
    expect(vault.text(".obsidian/app.json")).toBe("{}");

    // The obvious worry about writing onto a path the device does not scan: that the next pass
    // treats it as a stray local file. It does not — an unscanned path is not in the local
    // inventory, so there is no deletion to plan.
    vault.set("b.md", "two", 1_754_000_400_000);
    await engine.sync();

    expect(vault.text(".obsidian/app.json")).toBe("{}");
    expect(vault.removes).not.toContain(".obsidian/app.json");
  });

  it("says a restored file is not synced, so nobody assumes it was published", async () => {
    const engine = makeEngine({ excludes: [".private/**"] });

    expect(engine.syncsPath("notes/a.md")).toBe(true);
    // Both the config folder this device does not sync and the user's own exclude are paths a
    // restore will now happily write to, and both need the caveat afterwards.
    expect(engine.syncsPath(".obsidian/app.json")).toBe(false);
    expect(engine.syncsPath(".private/secret.md")).toBe(false);
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

  it("refuses to write into this plugin's own folder, wherever the bytes came from", async () => {
    const engine = makeEngine({ excludes: [] });
    vault.set("a.md", "one");
    await engine.sync();
    await server.seedRemoteCommit({
      "a.md": "one",
      ".obsidian/plugins/obsidian-log-sync/data.json": "secret",
    });
    await engine.sync();

    // The one destination that stays closed, and not as policy: that folder holds this device's
    // access token and master key, and the running plugin rewrites `data.json` from memory on
    // its next save. A restore there either reports success over bytes about to be discarded or
    // swaps this device's identity mid-session. Both are the ambiguous success this refuses.
    await expect(
      engine.restoreFile(server.head!, ".obsidian/plugins/obsidian-log-sync/data.json")
    ).rejects.toThrow(/this plugin's own folder/);

    // Closed as a *destination*, so choosing it for unrelated bytes is refused too.
    await expect(
      engine.restoreFile(server.head!, "a.md", {
        destination: ".obsidian/plugins/obsidian-log-sync/data.json",
      })
    ).rejects.toThrow(/this plugin's own folder/);

    // But the bytes themselves are readable and can be recovered somewhere else.
    const out = await engine.restoreFile(server.head!, ".obsidian/plugins/obsidian-log-sync/data.json", {
      destination: "recovered-data.json.txt",
    });
    expect(out.kind).toBe("written");
    expect(vault.text("recovered-data.json.txt")).toBe("secret");
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

    const history = (await engine.listHistory(10)).rows;
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
    const walked = (await engine.listHistory(10, { changes: true })).rows;

    // A different route to the same answer, or it is not a fast path — it is a second
    // implementation of history with its own opinions.
    server.serveHistoryIndex = true;
    const indexed = (await makeEngine().listHistory(10, { changes: true })).rows;

    expect(indexed).toEqual(walked);
  });

  it("asks for the chain once and never walks it", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    server.serveHistoryIndex = true;

    const fresh = makeEngine();
    server.manifestFetches.length = 0;
    const history = (await fresh.listHistory(10, { changes: true })).rows;

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

    const first = (await engine.listHistory(10, { changes: true })).rows;
    server.manifestFetches.length = 0;
    const second = (await engine.listHistory(10, { changes: true })).rows;

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
    const parent = (await engine.listHistory(10)).rows[1].id;
    server.manifestFetches.length = 0;

    const history = (await engine.listHistory(10, { changes: true })).rows;

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

    const history = (await makeEngine().listHistory(10, { changes: true })).rows;

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

    const history = (await makeEngine().listHistory(10, { changes: true })).rows;

    expect(history.map((h) => h.id)).toEqual([heads[2], heads[1], heads[0]]);
  });

  it("stops at a snapshot the index lists but the bucket no longer holds", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    server.serveHistoryIndex = true;
    server.manifests.delete(heads[0]);

    const history = (await makeEngine().listHistory(10, { changes: true })).rows;

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
    const history = (await other.listHistory(10, { changes: true })).rows;

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

  /** A row whose parent has been collected, so the chain continues at `spliceParent`. */
  const spliced = (id: string, parent: string, spliceParent: string, pruned = 1) => ({
    ...row(id, parent),
    spliceParent,
    pruned,
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

  it("joins the chain on the link the server says continues it", () => {
    // B's own parent X was collected; the listing continues at A. Following `parent` here
    // would reject a perfectly good page — and worse, a client that did follow it would be
    // looking for a snapshot that no longer exists.
    const page = parseHistoryPage({
      complete: true,
      entries: [spliced("B", "X", "A", 3), row("A", null)],
    });
    expect(page.entries.map((e) => e.id)).toEqual(["B", "A"]);
    expect(page.entries[0]).toEqual(
      expect.objectContaining({ parent: "X", spliceParent: "A", pruned: 3 })
    );
    // An older server sends neither field, and that is a chain with no gaps in it.
    expect(parseHistoryPage({ complete: true, entries: [row("A", null)] }).entries[0]).toEqual(
      expect.objectContaining({ spliceParent: null, pruned: null })
    );
  });

  it("refuses a skip that does not describe one", () => {
    // Half a description is not a smaller claim, it is an incoherent one: a link with no
    // count, or a count with no link, cannot both be true of the same snapshot.
    expect(() =>
      parseHistoryPage({
        complete: true,
        entries: [{ ...row("B", "X"), spliceParent: "A" }, row("A", null)],
      })
    ).toThrow(/together/);
    expect(() =>
      parseHistoryPage({ complete: true, entries: [{ ...row("A", null), pruned: 2 }] })
    ).toThrow(/together/);
    for (const bad of [0, -1, 1.5, "1"]) {
      expect(() =>
        parseHistoryPage({
          complete: true,
          entries: [{ ...row("B", "X"), spliceParent: "A", pruned: bad }, row("A", null)],
        })
      ).toThrow(/bad pruned/);
    }
    // A snapshot cannot be reached by skipping over its own history.
    expect(() =>
      parseHistoryPage({ complete: true, entries: [spliced("A", "X", "A")] })
    ).toThrow(/twice/);
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

// Generational retention means a listing can step over commits that have been collected. The
// snapshots at both ends are still real and still decrypt, so the diff between them is a true
// one over a wider interval — which is a different thing from a diff that cannot be computed,
// and has to be shown as what it is.
describe("SyncEngine.listHistory across collected commits", () => {
  /** Thin the middle snapshot the way a sweep would: gone from storage, skipped by the index. */
  function thinMiddle(heads: string[]): void {
    server.serveHistoryIndex = true;
    server.splices.set(heads[2], { spliceParent: heads[0], pruned: 1 });
    server.manifests.delete(heads[1]);
  }

  it("diffs across the gap and says how many syncs it covers", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    thinMiddle(heads);

    const history = (await makeEngine().listHistory(10, { changes: true })).rows;

    expect(history.map((h) => h.id)).toEqual([heads[2], heads[0]]);
    const changes = history[0].changes;
    if (changes === undefined || "unknown" in changes) throw new Error("expected a real diff");
    // From "a.md = one" straight to "a.md = three": one modified file, and b.md never appears
    // because it was added and removed inside the stretch that was collected.
    expect(changes.files.map((f) => f.path)).toEqual(["a.md"]);
    expect(changes.modified).toBe(1);
    expect(changes.spans).toBe(2);
    // The snapshot on the far side of the gap is an ordinary row diffed against its own
    // parent, and carries no span: it covers exactly the one sync it always did.
    const oldest = history[1].changes;
    if (oldest === undefined || "unknown" in oldest) throw new Error("expected a real diff");
    expect(oldest.initial).toBe(true);
    expect(oldest.spans).toBeUndefined();
  });

  it("rebuilds a cached row when the snapshot it was compared against is collected", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    server.serveHistoryIndex = true;

    const before = (await engine.listHistory(10, { changes: true })).rows;
    expect(before.map((h) => h.id)).toEqual([heads[2], heads[1], heads[0]]);
    const firstRow = before[0].changes;
    if (firstRow === undefined || "unknown" in firstRow) throw new Error("expected a real diff");
    expect(firstRow.spans).toBeUndefined();

    // The same engine, after a sweep moved the link its top row was diffed against. A cache
    // keyed by id alone would keep answering with the old, narrower diff.
    thinMiddle(heads);
    const after = (await engine.listHistory(10, { changes: true })).rows;
    const changes = after[0].changes;
    if (changes === undefined || "unknown" in changes) throw new Error("expected a real diff");
    expect(changes.spans).toBe(2);
    expect(changes.files.map((f) => f.path)).toEqual(["a.md"]);
  });

  it("still reports an unknown diff when the snapshot it would compare against is gone", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    server.serveHistoryIndex = true;
    // A server that says the chain continues at a snapshot it does not actually have. The
    // row is real, the comparison is not available, and inventing an empty diff for it would
    // claim the sync changed nothing.
    server.splices.set(heads[2], { spliceParent: heads[0], pruned: 1 });
    server.manifests.delete(heads[1]);
    server.manifests.delete(heads[0]);

    const history = (await makeEngine().listHistory(10, { changes: true })).rows;
    expect(history.map((h) => h.id)).toEqual([heads[2]]);
    expect(history[0].changes).toEqual({ unknown: "parent-missing" });
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

    const history = (await makeEngine().listHistory(10, { changes: true })).rows;

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

    const history = (await makeEngine().listHistory(10, { changes: true })).rows;

    expect(history[0].device).toBe("real-device");
    expect(history[0].createdAt).not.toBe("1999-01-01T00:00:00.000Z");
  });
});

// Grouping the listing by calendar bucket. `historyLimit` counts rows, and on a vault that
// commits a dozen times a day forty sync rows is about three days — against a server retaining
// ninety plus a weekly tier forever. Grouping changes the unit and costs one boundary manifest
// per bucket instead of one per sync.
describe("SyncEngine.listHistory grouped by calendar bucket", () => {
  /** A local wall-clock instant, so the buckets are the same ones in every timezone. */
  function at(y: number, m: number, d: number, h = 12): number {
    return new Date(y, m - 1, d, h).getTime();
  }

  /** Three commits, placed on the days a test wants them, with the index serving the chain. */
  async function commitsOn(days: number[]): Promise<string[]> {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    server.serveHistoryIndex = true;
    // heads[0] is the oldest; the days list is given newest-first to read like the window.
    heads.forEach((id, i) => server.uploadedAt.set(id, days[heads.length - 1 - i]));
    return heads;
  }

  it("collapses a day to its newest snapshot, diffed against the day before", async () => {
    const heads = await commitsOn([at(2026, 8, 20), at(2026, 8, 19), at(2026, 8, 19)]);

    const listing = await makeEngine().listHistory(10, { changes: true, granularity: "day" });

    // Two buckets: the 20th holds heads[2]; the 19th holds heads[1] and heads[0], and is
    // represented by its newest.
    expect(listing.rows.map((r) => r.id)).toEqual([heads[2], heads[1]]);
    expect(listing.granularity).toBe("day");
    expect(listing.rows[0].group?.syncs).toBe(1);
    expect(listing.rows[1].group?.syncs).toBe(2);
    // The 19th's row covers both of its syncs and is an initial diff, because nothing older
    // exists — not "unknown", which would claim we could not tell.
    const oldest = listing.rows[1].changes;
    if (oldest === undefined || "unknown" in oldest) throw new Error("expected a real diff");
    expect(oldest.initial).toBe(true);
    expect(oldest.spans).toBe(2);
  });

  it("fetches one boundary manifest per bucket, not one per sync", async () => {
    const heads = await commitsOn([at(2026, 8, 20), at(2026, 8, 19), at(2026, 8, 19)]);

    const fresh = makeEngine();
    server.manifestFetches.length = 0;
    await fresh.listHistory(10, { changes: true, granularity: "day" });

    // heads[0] is inside the older bucket and never becomes a boundary, so it is never fetched.
    expect([...server.manifestFetches].sort()).toEqual([heads[1], heads[2]].sort());
  });

  it("keeps the pick's own parent, so the manifest cross-check still applies", async () => {
    const heads = await commitsOn([at(2026, 8, 20), at(2026, 8, 19), at(2026, 8, 19)]);

    const listing = await makeEngine().listHistory(10, { changes: true, granularity: "day" });

    // The row stands for a bucket, but `parent` is still the snapshot's authenticated link —
    // never the older bucket's pick, which nothing authenticates.
    expect(listing.rows[0].parent).toBe(heads[1]);
  });

  it("groups by week, holding a Sunday in the week that began on Monday", async () => {
    // 2026-08-17 is a Monday and the 23rd the Sunday closing that week.
    const heads = await commitsOn([at(2026, 8, 24), at(2026, 8, 23), at(2026, 8, 17)]);

    const listing = await makeEngine().listHistory(10, { changes: true, granularity: "week" });

    expect(listing.rows.map((r) => r.id)).toEqual([heads[2], heads[1]]);
    expect(listing.rows[1].group?.syncs).toBe(2);
    expect(listing.rows[1].group?.start).toBe(at(2026, 8, 17, 0));
  });

  it("shares a fetched diff between a grouped row and a sync row over the same pair", async () => {
    // One commit per day, so every bucket holds exactly one sync and each day row describes
    // precisely the same two snapshots its sync row does.
    const heads = await commitsOn([at(2026, 8, 20), at(2026, 8, 19), at(2026, 8, 18)]);
    const engine = makeEngine();
    await engine.listHistory(10, { changes: true, granularity: "sync" });

    server.manifestFetches.length = 0;
    const grouped = await engine.listHistory(10, { changes: true, granularity: "day" });

    expect(grouped.rows.map((r) => r.id)).toEqual([heads[2], heads[1], heads[0]]);
    // Nothing refetched: the cache is keyed by the pair a diff describes, which both views agree
    // on here. The bucket label is attached afterwards rather than baked into the cached row.
    expect(server.manifestFetches).toEqual([]);
    expect(grouped.rows[0].group?.granularity).toBe("day");
  });

  it("does not hand a grouped label to a sync listing built from the same cache", async () => {
    await commitsOn([at(2026, 8, 20), at(2026, 8, 19), at(2026, 8, 18)]);
    const engine = makeEngine();
    await engine.listHistory(10, { changes: true, granularity: "day" });

    const flat = await engine.listHistory(10, { changes: true, granularity: "sync" });

    // A row that says "Thursday" in a list of individual syncs would be a lie about what it is.
    expect(flat.rows.every((r) => r.group === undefined)).toBe(true);
  });

  it("lists every sync when asked to, exactly as it always did", async () => {
    const heads = await commitsOn([at(2026, 8, 20), at(2026, 8, 19), at(2026, 8, 19)]);

    const listing = await makeEngine().listHistory(10, { changes: true });

    expect(listing.rows.map((r) => r.id)).toEqual([heads[2], heads[1], heads[0]]);
    expect(listing.granularity).toBe("sync");
    expect(listing.rows.every((r) => r.group === undefined)).toBe(true);
  });

  it("falls back to every sync, and says why, when the index cannot answer", async () => {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    server.serveHistoryIndex = false;

    const listing = await makeEngine().listHistory(10, { changes: true, granularity: "day" });

    // Grouping the walk would save nothing — it fetches every manifest to learn each parent —
    // so the honest answer is flat rows plus a stated reason, never a quietly shorter list.
    expect(listing.rows.map((r) => r.id)).toEqual([heads[2], heads[1], heads[0]]);
    expect(listing.granularity).toBe("sync");
    expect(listing.fallback).toBe("no-index");
  });

  it("groups a thinned chain instead of falling back — what every swept vault looks like", async () => {
    const heads = await commitsOn([at(2026, 8, 20), at(2026, 8, 19), at(2026, 8, 18)]);
    // A sweep collected everything before the oldest retained snapshot. Its manifest still
    // names that parent, so the chain never reaches a null link — the index simply stops. This
    // is the steady state of any vault that has ever been collected, and reading it as "the
    // index is incomplete" made the grouped path fall back to the walk on every such vault,
    // which is what "Group by does nothing" looked like from the outside.
    const oldest = server.manifests.get(heads[0])!;
    server.manifests.set(heads[0], { ...oldest, parent: "01COLLECTEDBYASWEEPXXXXXXX" });

    const listing = await makeEngine().listHistory(40, { changes: true, granularity: "day" });

    expect(listing.granularity).toBe("day");
    expect(listing.fallback).toBeUndefined();
    expect(listing.rows.map((r) => r.id)).toEqual([heads[2], heads[1], heads[0]]);
    // Everything retained is on screen, so nothing is offered that cannot be fetched.
    expect(listing.more).toBe(false);
    // The oldest bucket has nothing readable behind it, so its diff is initial rather than
    // a false "changes unknown" — the snapshots behind it are gone, not unreadable.
    const first = listing.rows[2].changes;
    if (first === undefined || "unknown" in first) throw new Error("expected a real diff");
    expect(first.initial).toBe(true);
  });

  it("walks rather than believing a page that a splice into nothing produced", async () => {
    const heads = await commitsOn([at(2026, 8, 20), at(2026, 8, 19), at(2026, 8, 18)]);
    // A splice only ever names a survivor, so one pointing at a snapshot the index does not
    // have is corruption — not the ordinary dangling `parent` at the end of retained history.
    // Treating it as the end would let a grouped listing present a truncated chain as whole.
    server.splices.set(heads[1], { spliceParent: "01GONEXXXXXXXXXXXXXXXXXXXX", pruned: 1 });

    const listing = await makeEngine().listHistory(40, { changes: true, granularity: "day" });

    expect(listing.fallback).toBe("no-index");
    expect(listing.granularity).toBe("sync");
    expect(heads[2]).not.toBe(heads[0]);
  });

  it("calls an empty vault empty rather than an index that could not answer", async () => {
    server.serveHistoryIndex = true;

    const listing = await makeEngine().listHistory(10, { changes: true, granularity: "day" });

    // A complete, empty page is a vault with no snapshots. Sending it to the walk instead
    // would report a missing index for a chain that is simply empty.
    expect(listing.rows).toEqual([]);
    expect(listing.fallback).toBeUndefined();
    expect(listing.more).toBe(false);
  });

  it("reports nothing older when the whole chain fits", async () => {
    await commitsOn([at(2026, 8, 20), at(2026, 8, 19), at(2026, 8, 18)]);

    expect((await makeEngine().listHistory(10, { granularity: "day" })).more).toBe(false);
  });

  it("says older snapshots exist when the limit cut the list", async () => {
    await commitsOn([at(2026, 8, 20), at(2026, 8, 19), at(2026, 8, 18)]);

    const listing = await makeEngine().listHistory(2, { changes: true, granularity: "day" });

    expect(listing.rows).toHaveLength(2);
    // Without this a list cut by a limit reads as the end of the vault's history.
    expect(listing.more).toBe(true);
  });
});

// Paging the chain. A grouped row can hold a whole day's commits, so forty of them on a busy
// vault reaches past the server's page cap — and a listing that stopped there would show a
// fraction of what was asked for while looking complete.
describe("SyncEngine.listHistory paging the chain", () => {
  /** More commits than one page holds, each its own day so every one is its own bucket. */
  async function manyCommits(count: number): Promise<string[]> {
    const engine = makeEngine();
    const heads: string[] = [];
    for (let i = 0; i < count; i++) {
      vault.set("a.md", `v${i}`, 1_754_000_000_000 + i * 1000);
      await engine.sync();
      heads.push(server.head!);
    }
    server.serveHistoryIndex = true;
    heads.forEach((id, i) => server.uploadedAt.set(id, new Date(2026, 7, 1 + i, 12).getTime()));
    return heads;
  }

  it("asks once when a flat listing fits in a page", async () => {
    await manyCommits(3);
    server.historyCursors.length = 0;

    await makeEngine().listHistory(10, { changes: true });

    // No cursor, one request: a flat listing asks for its limit and is done, as it always was.
    expect(server.historyCursors).toEqual([undefined]);
  });

  it("continues past the first page from the row it already holds", async () => {
    const heads = await manyCommits(5);
    server.historyCursors.length = 0;

    // A server whose pages hold two rows, and five buckets wanted: the listing has to page.
    server.maxHistoryPage = 2;
    const listing = await makeEngine().listHistory(5, { changes: true, granularity: "day" });

    expect(listing.rows.map((r) => r.id)).toEqual([...heads].reverse());
    expect(listing.more).toBe(false);
  });

  it("stops and says so when the server ignores the cursor", async () => {
    await manyCommits(5);
    server.maxHistoryPage = 2;
    server.ignoreCursor = true;

    const listing = await makeEngine().listHistory(40, { changes: true, granularity: "day" });

    // An older Worker answering the head page again is a capability gap, not a corrupt chain,
    // and reporting it as corruption would tell the user their history is broken when it is not.
    expect(listing.fallback).toBe("no-cursor");
    expect(listing.rows.length).toBeGreaterThan(0);
  });

  it("hands a listing left short by an index hole to the walk", async () => {
    const heads = await manyCommits(5);
    server.maxHistoryPage = 2;
    // The index stops partway down the chain. The first page is fine, a continuation is not.
    server.unindexed.add(heads[1]);

    const listing = await makeEngine().listHistory(40, { changes: true, granularity: "day" });

    // Serving the prefix would show fewer snapshots than exist while looking like a complete
    // grouped listing. The walk reaches them, and the listing says grouping was not available.
    expect(listing.fallback).toBe("no-index");
    expect(listing.granularity).toBe("sync");
    expect(listing.rows.length).toBeGreaterThan(2);
  });

  it("falls back when the cursor row itself is collected between two pages", async () => {
    const heads = await manyCommits(5);
    server.maxHistoryPage = 2;
    // A sweep collects the row page two would continue from, after page one named it. The
    // server answers that with an *empty* page marked incomplete — a hole in the index, not
    // the end of the vault's history, and reading it as the latter hides everything behind it.
    let call = 0;
    server.beforeHistory = () => {
      if (++call === 2) server.unindexed.add(heads[3]);
    };

    const listing = await makeEngine().listHistory(40, { changes: true, granularity: "day" });

    expect(listing.fallback).toBe("no-index");
    expect(listing.rows.length).toBeGreaterThan(2);
  });

  it("keeps an indexed listing holding exactly the rows it will show", async () => {
    const heads = await manyCommits(5);
    server.maxHistoryPage = 2;
    // The hole sits immediately past the third bucket, which is exactly the limit — so it
    // hides nothing this list would draw, and re-walking every manifest to reach it buys
    // nothing. An off-by-one here silently degrades a perfectly good grouped listing.
    server.unindexed.add(heads[0]);

    const listing = await makeEngine().listHistory(3, { changes: true, granularity: "day" });

    expect(listing.granularity).toBe("day");
    expect(listing.fallback).toBeUndefined();
    expect(listing.rows).toHaveLength(3);
    // The hole is still real, so the list does not pretend to be the end of history.
    expect(listing.more).toBe(true);
  });

  it("keeps the indexed listing when the hole is past everything it would show", async () => {
    const heads = await manyCommits(5);
    server.maxHistoryPage = 2;
    server.unindexed.add(heads[0]);

    // Two buckets wanted, and the hole is at the far end of the chain — past the end of the
    // list either way, so re-walking every manifest to reach it would buy nothing.
    const listing = await makeEngine().listHistory(2, { changes: true, granularity: "day" });

    expect(listing.granularity).toBe("day");
    expect(listing.fallback).toBeUndefined();
    expect(listing.more).toBe(true);
  });

  it("throws when two pages do not join up", async () => {
    const heads = await manyCommits(4);
    server.maxHistoryPage = 2;
    // A server answering a continuation with a snapshot that is not the one it was asked for,
    // and not the head either. A listing built over that seam would diff two snapshots with
    // history between them and present it as one step.
    const real = server.getHistory.bind(server);
    let call = 0;
    server.getHistory = async (limit: number, opts: { before?: string } = {}) => {
      const page = await real(limit, opts);
      if (call++ > 0 && page !== null && page.entries.length > 0) {
        page.entries[0] = { ...page.entries[0], id: heads[0] };
      }
      return page;
    };

    await expect(
      makeEngine().listHistory(40, { changes: true, granularity: "day" })
    ).rejects.toThrow(/starts at/);
  });
});

// A date range. Paging back until the range is covered is what makes "what did I do in July"
// answerable on a vault whose July is far past the first page.
describe("SyncEngine.listHistory over a date range", () => {
  function at(y: number, m: number, d: number, h = 12): number {
    return new Date(y, m - 1, d, h).getTime();
  }

  async function commitsOn(days: number[]): Promise<string[]> {
    const engine = makeEngine();
    const heads = await threeCommits(engine);
    server.serveHistoryIndex = true;
    heads.forEach((id, i) => server.uploadedAt.set(id, days[heads.length - 1 - i]));
    return heads;
  }

  it("shows only the syncs inside the range", async () => {
    const heads = await commitsOn([at(2026, 8, 20), at(2026, 8, 19), at(2026, 8, 18)]);

    const listing = await makeEngine().listHistory(10, {
      changes: true,
      from: at(2026, 8, 19, 0),
      to: at(2026, 8, 20, 0),
    });

    expect(listing.rows.map((r) => r.id)).toEqual([heads[1]]);
  });

  it("still diffs the oldest row in range against the snapshot before it", async () => {
    const heads = await commitsOn([at(2026, 8, 20), at(2026, 8, 19), at(2026, 8, 18)]);

    const listing = await makeEngine().listHistory(10, {
      changes: true,
      from: at(2026, 8, 19, 0),
      to: at(2026, 8, 20, 0),
    });

    // The comparison reaches outside the range on purpose: "what changed on the first day you
    // asked about" is unanswerable otherwise, and an initial diff there would be a lie.
    const changes = listing.rows[0].changes;
    if (changes === undefined || "unknown" in changes) throw new Error("expected a real diff");
    expect(changes.initial).toBe(false);
    expect(heads[0]).not.toBe(heads[1]);
  });

  it("places a grouped row by its bucket rather than by its newest sync", async () => {
    const heads = await commitsOn([at(2026, 8, 20, 23), at(2026, 8, 19), at(2026, 8, 18)]);

    const listing = await makeEngine().listHistory(10, {
      changes: true,
      granularity: "day",
      from: at(2026, 8, 20, 0),
    });

    // The 20th's bucket starts at local midnight, which is what "from the 20th" has to mean.
    expect(listing.rows.map((r) => r.id)).toEqual([heads[2]]);
  });

  it("pages past newer snapshots to reach a range that ends in the past", async () => {
    const heads = await commitsOn([at(2026, 8, 20), at(2026, 8, 19), at(2026, 8, 18)]);
    // Pages that hold one row, so the range's snapshots are two pages behind the head.
    server.maxHistoryPage = 1;

    const listing = await makeEngine().listHistory(10, {
      changes: true,
      to: at(2026, 8, 19, 0),
    });

    // Stopping on the raw row count would page once, filter its single newer row away, and
    // report the range as empty while the snapshot it asked for sat one page further back.
    expect(listing.rows.map((r) => r.id)).toEqual([heads[0]]);
  });

  it("does not offer older snapshots once the walk is past the range's start", async () => {
    await commitsOn([at(2026, 8, 20), at(2026, 8, 19), at(2026, 8, 18)]);
    server.maxHistoryPage = 1;

    const listing = await makeEngine().listHistory(10, {
      changes: true,
      from: at(2026, 8, 20, 0),
    });

    // The chain does continue, but nothing older belongs in this list, so saying "older
    // snapshots exist past this list" would send the user after rows the range excludes.
    expect(listing.rows).toHaveLength(1);
    expect(listing.more).toBe(false);
  });

  it("never shows a snapshot outside the range when it had to walk", async () => {
    const heads = await commitsOn([at(2026, 8, 20), at(2026, 8, 19), at(2026, 8, 18)]);
    server.serveHistoryIndex = false;

    const listing = await makeEngine().listHistory(10, {
      changes: true,
      from: at(2026, 8, 19, 0),
    });

    // The walk has no upload times and reaches back only `limit` snapshots, so it cannot answer
    // a date question — but it must not answer a different one either. Out-of-range rows stay
    // off the screen, and the listing says the dates were never really searched.
    expect(listing.fallback).toBe("no-range");
    expect(listing.rows.map((r) => r.id)).not.toContain(heads[0]);
  });

  it("does not claim a range is empty when the dates were never searched", async () => {
    await commitsOn([at(2026, 8, 20), at(2026, 8, 19), at(2026, 8, 18)]);
    server.serveHistoryIndex = false;

    const listing = await makeEngine().listHistory(10, {
      changes: true,
      from: at(2020, 1, 1),
      to: at(2020, 2, 1),
    });

    // Empty, but for a reason the caller has to be able to tell apart from "your vault holds
    // nothing from then" — which would be a false statement about the user's own history.
    expect(listing.rows).toEqual([]);
    expect(listing.fallback).toBe("no-range");
  });

  it("says nothing is in an empty range rather than showing the newest history", async () => {
    await commitsOn([at(2026, 8, 20), at(2026, 8, 19), at(2026, 8, 18)]);

    const listing = await makeEngine().listHistory(10, {
      changes: true,
      from: at(2026, 9, 1, 0),
    });

    expect(listing.rows).toEqual([]);
  });
});
