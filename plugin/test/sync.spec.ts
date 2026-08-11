import { describe, it, expect, beforeEach } from "vitest";
import { SyncEngine } from "../src/sync";
import { StaleHeadError } from "../src/api";
import { FakeServer, FakeStore, FakeVault } from "./fakes";
import type { FileEntry, Manifest, ManifestV1, ManifestV2 } from "../src/types";
import { VaultCrypto } from "../src/crypto";
import { sha256Hex } from "../src/hash";
import { conflictPath } from "../src/merge";
import { isResolvable } from "../src/conflict-resolve";

let vault: FakeVault;
let server: FakeServer;
let store: FakeStore;
let engine: SyncEngine;
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
  engine = makeEngine();
});

const hex = (s: string) => sha256Hex(new TextEncoder().encode(s));

/** Narrow to a plaintext snapshot. Cases using this run with encryption off. */
function plainFiles(m: Manifest): ManifestV1["files"] {
  if (m.v !== 1) throw new Error(`expected a plaintext manifest, got v${m.v}`);
  return m.files;
}

describe("SyncEngine.sync — happy paths", () => {
  it("first push uploads every file and advances head", async () => {
    vault.set("daily/2026-08-03.md", "# today\n");
    vault.set("notes/idea.md", "spark");

    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(res.uploaded).toBe(2);
    expect(server.head).not.toBeNull();
    const m = server.manifests.get(server.head!)!;
    expect(Object.keys(plainFiles(m)).sort()).toEqual(["daily/2026-08-03.md", "notes/idea.md"]);
    expect(m.parent).toBeNull();
    expect(m.device).toBe("test-device");
  });

  it("persists state so a second push is a no-op", async () => {
    vault.set("a.md", "one");
    await engine.sync();
    const headAfterFirst = server.head;

    const res = await engine.sync();
    expect(res.status).toBe("unchanged");
    expect(server.head).toBe(headAfterFirst);
    expect(server.uploads.length).toBe(1);
  });

  it("uploads only the changed file on modification", async () => {
    vault.set("a.md", "one");
    vault.set("b.md", "two");
    await engine.sync();
    server.uploads.length = 0;

    vault.set("a.md", "one edited", now + 1000);
    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(server.uploads).toEqual([await hex("one edited")]);
  });

  it("deletion removes the path from the next snapshot", async () => {
    vault.set("a.md", "one");
    vault.set("gone.md", "bye");
    await engine.sync();

    vault.delete("gone.md");
    await engine.sync();

    const m = server.manifests.get(server.head!)!;
    expect(Object.keys(plainFiles(m))).toEqual(["a.md"]);
  });

  it("rename re-uses the existing blob (no upload)", async () => {
    vault.set("old.md", "same bytes");
    await engine.sync();
    server.uploads.length = 0;

    vault.rename("old.md", "new.md");
    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(server.uploads).toEqual([]);
    const m = server.manifests.get(server.head!)!;
    expect(Object.keys(plainFiles(m))).toEqual(["new.md"]);
  });

  it("chains each commit onto the previous head", async () => {
    vault.set("a.md", "one");
    await engine.sync();
    const first = server.head!;

    vault.set("a.md", "two", now + 1000);
    await engine.sync();

    expect(server.manifests.get(server.head!)!.parent).toBe(first);
  });

  it("hashes every scanned file so metadata-preserving edits cannot be missed", async () => {
    vault.set("a.md", "one");
    vault.set("b.md", "two");
    await engine.sync();
    vault.reads.length = 0;

    vault.set("a.md", "one changed", now + 5000);
    await engine.sync();

    // Every file is read to build metadata; the missing changed blob is then re-read and
    // revalidated for upload instead of retaining whole-vault bytes in memory.
    expect(vault.reads.sort()).toEqual(["a.md", "a.md", "b.md"]);
  });

  it("re-reads and revalidates a missing blob instead of uploading retained scan bytes", async () => {
    vault.set("a.md", "one");
    const realRead = vault.read.bind(vault);
    let reads = 0;
    vault.read = async (path) => {
      const bytes = await realRead(path);
      if (++reads === 2) return new TextEncoder().encode("changed during sync");
      return bytes;
    };

    // The revalidation exists so bytes that do not match the snapshot are never published. It
    // does not end the pass: the engine rescans and publishes what the file actually holds.
    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(reads).toBe(4);
    expect(server.uploads).toEqual([await hex("one")]);
    const m = server.manifests.get(server.head!)!;
    expect(plainFiles(m)["a.md"].h).toBe(await hex("one"));
  });

  it("publishes a same-size edit even when its mtime is unchanged", async () => {
    vault.set("a.md", "one", now);
    await engine.sync();

    vault.set("a.md", "two", now);
    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(plainFiles(server.manifests.get(server.head!)!)["a.md"].h).toBe(await hex("two"));
  });
});

describe("SyncEngine.sync — what a pass asks the server about", () => {
  it("asks only about the blobs the commit adds to its parent", async () => {
    vault.set("a.md", "one");
    vault.set("b.md", "two");
    await engine.sync();
    server.checked.length = 0;

    vault.set("b.md", "two changed", now + 1);
    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(server.checked).toEqual([[await hex("two changed")]]);
  });

  it("asks about nothing at all when only deletions are published", async () => {
    vault.set("a.md", "one");
    vault.set("b.md", "two");
    await engine.sync();
    server.checked.length = 0;

    vault.delete("b.md");
    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(server.checked).toEqual([[]]);
  });

  it("asks about every blob on a first push, which has no parent to inherit from", async () => {
    vault.set("a.md", "one");
    vault.set("b.md", "two");

    await engine.sync();

    expect(server.checked).toEqual([[await hex("one"), await hex("two")]]);
  });

  it("re-uploads a carried blob the server lost, because commit still verifies", async () => {
    vault.set("a.md", "one");
    vault.set("b.md", "two");
    await engine.sync();
    // The pre-check no longer covers carried blobs, so this is the only thing standing
    // between a lost blob and a manifest that references nothing.
    server.blobs.delete(await hex("one"));
    server.checked.length = 0;

    vault.set("b.md", "two changed", now + 1);
    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(server.checked).toEqual([[await hex("two changed")]]);
    expect(server.uploads).toContain(await hex("one"));
    expect(server.blobs.has(await hex("one"))).toBe(true);
  });
});

describe("SyncEngine.sync — filtering and limits", () => {
  it("excludes configured globs", async () => {
    vault.set("a.md", "keep");
    vault.set(".obsidian/workspace.json", "{}");
    vault.set(".obsidian/plugins/x/main.js", "code");

    await engine.sync();

    const m = server.manifests.get(server.head!)!;
    expect(Object.keys(plainFiles(m))).toEqual(["a.md"]);
  });

  it("tracks only allow-listed paths when onlyPaths is non-empty", async () => {
    vault.set("daily/today.md", "keep");
    vault.set("notes/private.md", "leave local only");

    const res = await makeEngine({ onlyPaths: ["daily/**"] }).sync();

    expect(res.status).toBe("committed");
    expect(Object.keys(plainFiles(server.manifests.get(server.head!)!))).toEqual(["daily/today.md"]);
    expect(vault.text("notes/private.md")).toBe("leave local only");
  });

  it("carries remote paths outside the allow-list without materialising them", async () => {
    await server.seedRemoteCommit({ "daily/today.md": "remote", "archive/old.md": "carry" });
    const limited = makeEngine({ onlyPaths: ["daily/**"] });

    await limited.sync();

    expect(vault.text("daily/today.md")).toBe("remote");
    expect(vault.files.has("archive/old.md")).toBe(false);
    expect(plainFiles(server.manifests.get(server.head!)!)["archive/old.md"]).toBeDefined();
  });

  it("keeps an exact allow-listed spelling canonical when a remote case collision is normalized", async () => {
    await server.seedRemoteCommit({ "Note.md": "outside allow-list", "note.md": "allowed" });

    await makeEngine({ onlyPaths: ["note.md"] }).sync();

    expect(vault.text("note.md")).toBe("allowed");
    expect(vault.files.has("Note.md")).toBe(false);
    const files = plainFiles(server.manifests.get(server.head!)!);
    expect(files["note.md"]).toBeDefined();
    expect(Object.keys(files).some((path) => path.startsWith("Note.conflict-other-device-"))).toBe(
      true
    );
  });

  it("keeps .obsidian configuration local unless config sync is explicitly enabled", async () => {
    vault.set(".obsidian/app.json", "{}");
    vault.set("note.md", "note");

    await makeEngine({ excludes: [] }).sync();

    expect(Object.keys(plainFiles(server.manifests.get(server.head!)!))).toEqual(["note.md"]);
  });

  it("syncs ordinary config when enabled but still hard-skips credentials and workspaces", async () => {
    vault.set(".obsidian/app.json", "{}");
    vault.set(".obsidian/hotkeys.json", "{}");
    vault.set(".obsidian/workspace.json", "secret layout");
    vault.set(".obsidian/plugins/cloudflare-rdo-sync/data.json", "credentials");
    vault.set(".obsidian/plugins/obsidian-log-sync/data.json", "legacy credentials");

    await makeEngine({ excludes: [], syncConfigDir: true }).sync();

    expect(Object.keys(plainFiles(server.manifests.get(server.head!)!))).toEqual([
      ".obsidian/app.json",
      ".obsidian/hotkeys.json",
    ]);
  });

  it("hard-skips credentials in a renamed configuration directory", async () => {
    // A vault that overrode its config folder keeps `data.json` — access token and master key
    // in plaintext — outside `.obsidian`. Without the real name the engine would upload it.
    vault.set("note.md", "ordinary content still syncs");
    vault.set(".config-obsidian/app.json", "{}");
    vault.set(".config-obsidian/workspace.json", "secret layout");
    vault.set(".config-obsidian/plugins/cloudflare-rdo-sync/data.json", "credentials");
    vault.set(".config-obsidian/plugins/obsidian-log-sync/data.json", "legacy credentials");

    await makeEngine({ excludes: [], syncConfigDir: true, configDir: ".config-obsidian" }).sync();

    expect(Object.keys(plainFiles(server.manifests.get(server.head!)!))).toEqual([
      ".config-obsidian/app.json",
      "note.md",
    ]);
  });

  it("refuses a configDir that cannot name a directory", async () => {
    // Silently falling back would leave the credential paths above unprotected.
    for (const bad of ["", "   ", "a/b"]) {
      expect(() => makeEngine({ configDir: bad })).toThrow(/configDir/);
    }
  });

  it("lets explicit excludes override config-directory opt-in", async () => {
    vault.set(".obsidian/app.json", "{}");
    vault.set(".obsidian/hotkeys.json", "{}");

    await makeEngine({
      excludes: [".obsidian/hotkeys.json"],
      syncConfigDir: true,
    }).sync();

    expect(Object.keys(plainFiles(server.manifests.get(server.head!)!))).toEqual([
      ".obsidian/app.json",
    ]);
  });

  it("skips oversized files loudly but still syncs the rest", async () => {
    vault.set("big.bin", new Uint8Array(2048));
    vault.set("small.md", "fine");

    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(res.skipped).toEqual([{ path: "big.bin", reason: "exceeds 1024 byte limit" }]);
    const m = server.manifests.get(server.head!)!;
    expect(Object.keys(plainFiles(m))).toEqual(["small.md"]);
  });

  it("normalizes non-finite stats and enforces the size limit against bytes read", async () => {
    vault.set("android.md", "actual bytes");
    vault.set("large.bin", new Uint8Array(2048));
    const realList = vault.list.bind(vault);
    vault.list = async () => (await realList()).map((file) => ({
      ...file,
      size: Number.NaN,
      mtime: file.path === "android.md" ? Number.POSITIVE_INFINITY : Number.NaN,
    }));

    const res = await engine.sync();

    expect(res.skipped).toEqual([{ path: "large.bin", reason: "exceeds 1024 byte limit" }]);
    const files = plainFiles(server.manifests.get(server.head!)!);
    expect(files["android.md"]).toMatchObject({ size: 12, mtime: 0 });
    expect(Number.isFinite(files["android.md"].size)).toBe(true);
    expect(Number.isFinite(files["android.md"].mtime)).toBe(true);
    expect(files["large.bin"]).toBeUndefined();
  });

  it("skips paths the server would reject, but still commits the valid ones", async () => {
    vault.set("bad\\path.md", "x");
    vault.set("good.md", "y");

    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(res.skipped).toEqual([{ path: "bad\\path.md", reason: "backslash in path" }]);
    expect(Object.keys(plainFiles(server.manifests.get(server.head!)!))).toEqual(["good.md"]);
  });

  it("reports unchanged (never a false commit) when every file is skipped", async () => {
    vault.set("bad\\path.md", "x");
    const res = await engine.sync();
    expect(res.status).toBe("unchanged");
    expect(res.skipped[0].path).toBe("bad\\path.md");
    expect(server.head).toBeNull();
  });
});

describe("SyncEngine.sync — direction modes", () => {
  it("pull-only applies and records a remote head but never commits", async () => {
    const remoteHead = await server.seedRemoteCommit({ "remote.md": "theirs" });
    const pullOnly = makeEngine({ mode: "pull-only" });
    const manifestCount = server.manifests.size;

    const res = await pullOnly.sync();

    expect(res).toMatchObject({ status: "pulled", head: remoteHead, pulled: 1, uploaded: 0 });
    expect(vault.text("remote.md")).toBe("theirs");
    expect(server.head).toBe(remoteHead);
    expect(server.manifests.size).toBe(manifestCount);
    expect(store.state).toMatchObject({ lastSyncedHead: remoteHead });
  });

  it("pull-only leaves local edits divergent and does not publish them", async () => {
    await server.seedRemoteCommit({ "a.md": "base" });
    const pullOnly = makeEngine({ mode: "pull-only" });
    await pullOnly.sync();
    const remoteHead = server.head;
    vault.set("a.md", "local edit", now + 1);

    const res = await pullOnly.sync();

    expect(res.status).toBe("unchanged");
    expect(server.head).toBe(remoteHead);
    expect(vault.text("a.md")).toBe("local edit");
  });

  it("pull-only with no remote head never creates one", async () => {
    vault.set("local.md", "local only");
    const res = await makeEngine({ mode: "pull-only" }).sync();
    expect(res.status).toBe("unchanged");
    expect(server.head).toBeNull();
    expect(server.uploads).toEqual([]);
  });

  it("push-only preserves a racing remote edit as a snapshot conflict without disk writes", async () => {
    vault.set("a.md", "base");
    const pushOnly = makeEngine({ mode: "push-only" });
    await pushOnly.sync();
    await server.seedRemoteCommit({ "a.md": "remote edit" });
    vault.set("a.md", "local edit", now + 1);
    vault.writes.length = 0;
    vault.removes.length = 0;

    const res = await pushOnly.sync();

    expect(res.status).toBe("committed");
    expect(vault.text("a.md")).toBe("local edit");
    expect(vault.writes).toEqual([]);
    expect(vault.removes).toEqual([]);
    const files = plainFiles(server.manifests.get(server.head!)!);
    expect(files["a.md"].h).toBe(await hex("local edit"));
    const conflict = Object.keys(files).find((path) => path.startsWith("a.conflict-other-device-"));
    expect(conflict).toBeDefined();
    expect(server.blobs.get(files[conflict!].h)).toEqual(new TextEncoder().encode("remote edit"));
    expect(res.conflicts).toContain(conflict);
  });

  // Push-only never writes to the vault, so its parked version is a manifest entry and not a
  // file here. Reported without that mark, the review window offered "keep the other version"
  // for something that was never on this disk, and every button could only fail.
  it("marks a push-only conflict as living in the snapshot rather than on disk", async () => {
    vault.set("a.md", "base");
    const pushOnly = makeEngine({ mode: "push-only" });
    await pushOnly.sync();
    await server.seedRemoteCommit({ "a.md": "remote edit" });
    vault.set("a.md", "local edit", now + 1);

    const res = await pushOnly.sync();

    expect(res.conflictDetails).toHaveLength(1);
    expect(res.conflictDetails[0].snapshotOnly).toBe(true);
    expect(isResolvable(res.conflictDetails[0])).toBe(false);
  });

  it("leaves an ordinary two-way conflict resolvable, because both versions are real files", async () => {
    vault.set("a.md", "base");
    const engine = makeEngine();
    await engine.sync();
    await server.seedRemoteCommit({ "a.md": "remote edit" });
    vault.set("a.md", "local edit", now + 1);

    const res = await engine.sync();

    expect(res.conflictDetails).toHaveLength(1);
    expect(res.conflictDetails[0].snapshotOnly).toBeUndefined();
    expect(isResolvable(res.conflictDetails[0])).toBe(true);
  });

  it("push-only keeps a manifest-only conflict copy on the next unchanged pass", async () => {
    vault.set("a.md", "base");
    const pushOnly = makeEngine({ mode: "push-only" });
    await pushOnly.sync();
    await server.seedRemoteCommit({ "a.md": "remote edit" });
    vault.set("a.md", "local edit", now + 1);

    await pushOnly.sync();
    const conflict = Object.keys(plainFiles(server.manifests.get(server.head!)!)).find((path) =>
      path.startsWith("a.conflict-other-device-")
    );
    expect(conflict).toBeDefined();
    const settledHead = server.head;
    vault.writes.length = 0;
    vault.removes.length = 0;

    const second = await makeEngine({ mode: "push-only" }).sync();

    expect(second.status).toBe("unchanged");
    expect(server.head).toBe(settledHead);
    expect(plainFiles(server.manifests.get(server.head!)!)[conflict!]).toBeDefined();
    expect(vault.files.has(conflict!)).toBe(false);
    expect(vault.writes).toEqual([]);
    expect(vault.removes).toEqual([]);
  });

  it("push-only propagates a local deletion but preserves a changed remote version as a conflict", async () => {
    vault.set("a.md", "base");
    const pushOnly = makeEngine({ mode: "push-only" });
    await pushOnly.sync();
    await server.seedRemoteCommit({ "a.md": "remote edit" });
    vault.delete("a.md");

    const res = await pushOnly.sync();

    expect(res.status).toBe("committed");
    const files = plainFiles(server.manifests.get(server.head!)!);
    expect(files["a.md"]).toBeUndefined();
    expect(Object.keys(files).some((path) => path.startsWith("a.conflict-other-device-"))).toBe(true);
    expect(vault.writes).toEqual([]);
  });

  it("push-only carries paths outside onlyPaths and never writes them locally", async () => {
    vault.set("daily/local.md", "ours");
    const pushOnly = makeEngine({ mode: "push-only", onlyPaths: ["daily/**"] });
    await pushOnly.sync();
    await server.seedRemoteCommit({
      "daily/local.md": "remote edit",
      "archive/remote.md": "carry",
    });
    vault.writes.length = 0;

    await pushOnly.sync();

    expect(vault.writes).toEqual([]);
    expect(vault.files.has("archive/remote.md")).toBe(false);
    expect(plainFiles(server.manifests.get(server.head!)!)["archive/remote.md"]).toBeDefined();
  });
});

describe("SyncEngine.sync — pull", () => {
  it("parks a case-variant remote path instead of overwriting a local path", async () => {
    vault.set("Note.md", "local");
    await server.seedRemoteCommit({ "note.md": "remote" });

    const res = await engine.sync();

    expect(vault.text("Note.md")).toBe("local");
    expect(vault.files.has("note.md")).toBe(false);
    const copy = res.conflicts.find((path) => path.startsWith("note.conflict-other-device-"));
    expect(copy).toBeDefined();
    expect(vault.text(copy!)).toBe("remote");
    expect(vault.writes).not.toContain("note.md");
    expect(
      new Set(vault.writes.map((path) => path.normalize("NFC").toLowerCase())).size
    ).toBe(vault.writes.length);
  });

  it("protects an untracked local case variant when only the remote spelling is allowed", async () => {
    vault.set("Note.md", "local outside policy");
    await server.seedRemoteCommit({ "note.md": "remote allowed spelling" });

    const res = await makeEngine({ onlyPaths: ["note.md"] }).sync();

    expect(vault.text("Note.md")).toBe("local outside policy");
    expect(vault.files.has("note.md")).toBe(false);
    expect(vault.writes).toEqual([]);
    const files = plainFiles(server.manifests.get(server.head!)!);
    expect(files["note.md"]).toBeUndefined();
    expect(Object.keys(files).some((path) => path.startsWith("note.conflict-other-device-"))).toBe(
      true
    );
    expect(res.conflicts).toHaveLength(1);
  });

  it("materializes case-folding remote collisions without overwriting either file", async () => {
    const run = async (remote: Record<string, string>) => {
      vault = new FakeVault();
      server = new FakeServer();
      store = new FakeStore();
      engine = makeEngine();
      const occupied = conflictPath("note.md", "other-device", now);
      const occupiedCaseVariant = occupied.toUpperCase();
      vault.set(occupiedCaseVariant, "existing conflict");
      await server.seedRemoteCommit(remote);

      const res = await engine.sync();
      const copy = res.conflicts[0];
      return {
        res,
        copy,
        occupiedCaseVariant,
        paths: [...vault.files.keys()].sort(),
        writes: [...vault.writes],
        canonical: vault.text("Note.md"),
        loser: vault.text(copy),
        occupied: vault.text(occupiedCaseVariant),
      };
    };

    const forward = await run({ "Note.md": "winner", "note.md": "loser" });
    const reverse = await run({ "note.md": "loser", "Note.md": "winner" });

    for (const result of [forward, reverse]) {
      expect(result.res.conflicts).toHaveLength(1);
      expect(result.copy).toMatch(/^note\.conflict-other-device-\d{6}-\d{4}-2\.md$/);
      expect(result.canonical).toBe("winner");
      expect(result.loser).toBe("loser");
      expect(result.occupied).toBe("existing conflict");
      expect(new Set(result.writes.map((path) => path.normalize("NFC").toLowerCase())).size)
        .toBe(result.writes.length);
    }
    expect(reverse.paths).toEqual(forward.paths);
    expect(reverse.copy).toBe(forward.copy);
  });

  it("writes a file another device added, without committing anything of its own", async () => {
    vault.set("a.md", "mine");
    await engine.sync();

    const remoteHead = await server.seedRemoteCommit({
      "a.md": "mine",
      "theirs.md": "from other device",
    });

    const res = await engine.sync();

    expect(res).toMatchObject({ status: "pulled", head: remoteHead, pulled: 1 });
    expect(vault.text("theirs.md")).toBe("from other device");
    expect(server.head).toBe(remoteHead); // no new manifest: we had nothing to add
    expect(server.manifests.size).toBe(2);
  });

  it("records the pulled head so the next sync is a no-op", async () => {
    vault.set("a.md", "mine");
    await engine.sync();
    await server.seedRemoteCommit({ "a.md": "mine", "theirs.md": "x" });
    await engine.sync();

    expect((await engine.sync()).status).toBe("unchanged");
  });

  it("adopts an existing remote vault on a fresh device and adds its own files", async () => {
    await server.seedRemoteCommit({ "existing.md": "from elsewhere" });
    vault.set("local.md", "new device content");

    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(res.pulled).toBe(1);
    expect(vault.text("existing.md")).toBe("from elsewhere");
    expect(Object.keys(plainFiles(server.manifests.get(server.head!)!)).sort()).toEqual([
      "existing.md",
      "local.md",
    ]);
  });

  it("adopts an empty remote snapshot as parent (the deployed initial state)", async () => {
    const initial = await server.seedRemoteCommit({});
    vault.set("first.md", "hello");

    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(server.manifests.get(server.head!)!.parent).toBe(initial);
  });

  it("deletes locally what the remote deleted", async () => {
    vault.set("a.md", "one");
    vault.set("b.md", "two");
    await engine.sync();

    await server.seedRemoteCommit({ "a.md": "one" });
    const res = await engine.sync();

    expect(res.status).toBe("pulled");
    expect(vault.removes).toEqual(["b.md"]);
    expect(vault.files.has("b.md")).toBe(false);
  });

  it("keeps our edit when the remote deleted the file, and re-publishes it", async () => {
    vault.set("a.md", "one");
    vault.set("b.md", "two");
    await engine.sync();

    await server.seedRemoteCommit({ "a.md": "one" });
    vault.set("b.md", "two, still working on it", now + 1000);
    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(vault.text("b.md")).toBe("two, still working on it");
    expect(Object.keys(plainFiles(server.manifests.get(server.head!)!)).sort()).toEqual([
      "a.md",
      "b.md",
    ]);
  });

  it("restores a file we deleted that the remote had edited", async () => {
    vault.set("a.md", "one");
    await engine.sync();

    await server.seedRemoteCommit({ "a.md": "one, improved elsewhere" });
    vault.delete("a.md");
    const res = await engine.sync();

    expect(res.status).toBe("pulled");
    expect(vault.text("a.md")).toBe("one, improved elsewhere");
  });

  it("carries a remote path this device excludes instead of deleting it", async () => {
    await server.seedRemoteCommit({ ".obsidian/app.json": "{}", "a.md": "one" });
    vault.set("local.md", "written here");

    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(vault.files.has(".obsidian/app.json")).toBe(false); // never written locally
    expect(Object.keys(plainFiles(server.manifests.get(server.head!)!)).sort()).toEqual([
      ".obsidian/app.json",
      "a.md",
      "local.md",
    ]);
  });

  it("round-trips a root __proto__ path without corrupting the path map", async () => {
    await server.seedRemoteCommit({ ["__proto__"]: "prototype note" });

    const res = await engine.sync();

    expect(res.status).toBe("pulled");
    expect(vault.text("__proto__")).toBe("prototype note");
    expect(Object.hasOwn(store.state!.files, "__proto__")).toBe(true);
  });

  it("verifies pulled bytes against the manifest hash", async () => {
    await server.seedRemoteCommit({ "a.md": "honest content" });
    const hash = await hex("honest content");
    server.blobs.set(hash, new TextEncoder().encode("tampered by the server"));

    await expect(engine.sync()).rejects.toThrow(/refusing to write/);
    expect(vault.files.has("a.md")).toBe(false);
  });
});

describe("SyncEngine.sync — three-way merge", () => {
  it("merges an append from them with an edit from us", async () => {
    vault.set("log.md", "# log\n- one\n");
    await engine.sync();

    await server.seedRemoteCommit({ "log.md": "# log\n- one\n- from the other device\n" });
    vault.set("log.md", "# log\n- one, corrected\n", now + 1000);

    const res = await engine.sync();

    expect(res).toMatchObject({ status: "committed", merged: 1, conflicts: [] });
    expect(vault.text("log.md")).toBe("# log\n- one, corrected\n- from the other device\n");
  });

  it("keeps both entries when both devices appended to the same log — no conflict copy", async () => {
    vault.set("log.md", "# log\n");
    await engine.sync();

    await server.seedRemoteCommit({ "log.md": "# log\n- 09:00 from the phone\n" });
    vault.set("log.md", "# log\n- 14:00 from here\n", now + 1000);

    const res = await engine.sync();

    expect(res).toMatchObject({ status: "committed", merged: 1, conflicts: [] });
    expect(vault.text("log.md")).toBe("# log\n- 09:00 from the phone\n- 14:00 from here\n");
  });

  it("keeps both versions when the same line changed on both sides", async () => {
    vault.set("note.md", "original\n");
    await engine.sync();

    await server.seedRemoteCommit({ "note.md": "their rewrite\n" });
    vault.set("note.md", "our rewrite\n", now + 1000);

    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(res.merged).toBe(0);
    expect(res.conflicts).toHaveLength(1);
    const copy = res.conflicts[0];
    expect(copy).toMatch(/^note\.conflict-other-device-\d{6}-\d{4}\.md$/);
    expect(vault.text("note.md")).toBe("our rewrite\n"); // ours stays put
    expect(vault.text(copy)).toBe("their rewrite\n"); // theirs survives beside it
    // Both are published, so the other device sees the conflict too.
    expect(Object.keys(plainFiles(server.manifests.get(server.head!)!)).sort()).toEqual(
      ["note.md", copy].sort()
    );
  });

  it("never writes conflict markers into a note", async () => {
    vault.set("note.md", "original\n");
    await engine.sync();
    await server.seedRemoteCommit({ "note.md": "theirs\n" });
    vault.set("note.md", "ours\n", now + 1000);

    await engine.sync();

    for (const [, file] of vault.files) {
      expect(new TextDecoder().decode(file.data)).not.toContain("<<<<<<<");
    }
  });

  it("gives an attachment to the newest writer and preserves the loser", async () => {
    vault.set("img.png", "v1");
    await engine.sync();

    await server.seedRemoteCommit({ "img.png": "THEIRS" }); // seeded mtime is the baseline
    vault.set("img.png", "OURS", now - 5000); // ours is older, so theirs wins

    const res = await engine.sync();

    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]).toMatch(/^img\.conflict-test-device-\d{6}-\d{4}\.png$/);
    expect(vault.text("img.png")).toBe("THEIRS");
    expect(vault.text(res.conflicts[0])).toBe("OURS");
  });

  it("falls back to a conflict copy when the base version is gone", async () => {
    vault.set("note.md", "line one\nline two\n");
    await engine.sync();
    // Simulate GC: the ancestor blob no longer exists, so diff3 has no base to work from.
    server.blobs.delete(await hex("line one\nline two\n"));

    await server.seedRemoteCommit({ "note.md": "line one\nline two\ntheirs\n" });
    vault.set("note.md", "line one\nline two\nours\n", now + 1000);

    const res = await engine.sync();

    expect(res.conflicts).toHaveLength(1);
    expect(vault.text("note.md")).toBe("line one\nline two\nours\n");
  });

  it("does not overwrite an existing conflict copy from the same minute", async () => {
    vault.set("note.md", "base\n");
    await engine.sync();
    await server.seedRemoteCommit({ "note.md": "theirs\n" });
    vault.set("note.md", "ours\n", now + 1000);
    const occupied = conflictPath("note.md", "other-device", now);
    vault.set(occupied, "older conflict\n");

    const res = await engine.sync();

    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]).not.toBe(occupied);
    expect(vault.text(occupied)).toBe("older conflict\n");
    expect(vault.text(res.conflicts[0])).toBe("theirs\n");
  });
});

describe("SyncEngine.sync — divergence safety (never clobber)", () => {
  it("re-pulls and retries when the head moves mid-commit", async () => {
    vault.set("a.md", "one");
    server.failNextCommitWith = new StaleHeadError("head moved", null);

    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(Object.keys(plainFiles(server.manifests.get(server.head!)!))).toEqual(["a.md"]);
  });

  it("absorbs a snapshot that landed between our pull and our commit", async () => {
    vault.set("a.md", "one");
    await engine.sync();
    vault.set("a.md", "one, edited", now + 1000);

    // The other device commits exactly once, while our commit is in flight.
    const realCommit = server.commit.bind(server);
    let raced = false;
    server.commit = async (m, e) => {
      if (!raced) {
        raced = true;
        await server.seedRemoteCommit({ "a.md": "one", "theirs.md": "sneaked in" });
        throw new StaleHeadError("head moved", server.head);
      }
      return realCommit(m, e);
    };

    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(vault.text("theirs.md")).toBe("sneaked in");
    expect(Object.keys(plainFiles(server.manifests.get(server.head!)!)).sort()).toEqual([
      "a.md",
      "theirs.md",
    ]);
  });

  it("uses the last absorbed remote as the base after a stale-head retry", async () => {
    vault.set("a.md", "base");
    await engine.sync();
    await server.seedRemoteCommit({ "a.md": "remote one" });
    vault.set("ours.md", "local addition", now + 1000);

    const realCommit = server.commit.bind(server);
    let raced = false;
    server.commit = async (manifest, expectedHead) => {
      if (!raced) {
        raced = true;
        await server.seedRemoteCommit({ "a.md": "remote two" });
        throw new StaleHeadError("head moved", server.head);
      }
      return realCommit(manifest, expectedHead);
    };

    const res = await engine.sync();

    expect(res).toMatchObject({ status: "committed", conflicts: [] });
    expect(vault.text("a.md")).toBe("remote two");
    expect(Object.keys(plainFiles(server.manifests.get(server.head!)!)).sort()).toEqual([
      "a.md",
      "ours.md",
    ]);
  });

  it("halts instead of looping when the head never settles", async () => {
    vault.set("a.md", "one");
    server.commit = async () => {
      throw new StaleHeadError("head moved", "01SOMEONEELSE");
    };

    const res = await engine.sync();

    expect(res).toMatchObject({ status: "halted", reason: expect.stringMatching(/gave up/) });
    expect(server.head).toBeNull();
  });
});

describe("SyncEngine.sync — error propagation", () => {
  it("recovers from a missing_blob race by re-uploading once", async () => {
    vault.set("a.md", "content");
    const h = await hex("content");
    // Server claims the blob exists, then rejects the commit — a GC/race scenario.
    server.blobs.set(h, new TextEncoder().encode("content"));
    const original = server.commit.bind(server);
    let calls = 0;
    server.commit = async (m, e) => {
      calls++;
      if (calls === 1) {
        server.blobs.delete(h);
        const { MissingBlobError } = await import("../src/api");
        throw new MissingBlobError("missing", [h]);
      }
      return original(m, e);
    };

    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(server.uploads).toContain(h);
    expect(calls).toBe(2);
  });

  it("routes a stale head from the missing-blob retry through the normal merge loop", async () => {
    vault.set("ours.md", "local");
    const h = await hex("local");
    server.blobs.set(h, new TextEncoder().encode("local"));
    const realCommit = server.commit.bind(server);
    let calls = 0;
    server.commit = async (manifest, expectedHead) => {
      calls++;
      if (calls === 1) {
        server.blobs.delete(h);
        const { MissingBlobError } = await import("../src/api");
        throw new MissingBlobError("missing", [h]);
      }
      if (calls === 2) {
        await server.seedRemoteCommit({ "theirs.md": "remote" });
        throw new StaleHeadError("head moved", server.head);
      }
      return realCommit(manifest, expectedHead);
    };

    const res = await engine.sync();

    expect(res.status).toBe("committed");
    expect(vault.text("theirs.md")).toBe("remote");
    expect(calls).toBe(3);
  });

  it("propagates unexpected API failures instead of reporting success", async () => {
    vault.set("a.md", "one");
    server.failNextCommitWith = new Error("network exploded");

    await expect(engine.sync()).rejects.toThrow(/network exploded/);
    expect(engine.status.phase).toBe("error");
  });

  it("does not persist state when the commit fails", async () => {
    vault.set("a.md", "one");
    server.failNextCommitWith = new Error("boom");
    await engine.sync().catch(() => {});

    expect(store.state).toBeNull();
  });
});

describe("SyncEngine.sync — encrypted", () => {
  const KEY_A = new Uint8Array(32).fill(3);
  const KEY_B = new Uint8Array(32).fill(4);

  let crypto_: VaultCrypto;
  let encEngine: SyncEngine;

  function encManifest(m: Manifest): ManifestV2 {
    if (m.v !== 2) throw new Error(`expected an encrypted manifest, got v${m.v}`);
    return m;
  }

  const headManifest = () => encManifest(server.manifests.get(server.head!)!);

  beforeEach(async () => {
    crypto_ = await VaultCrypto.create(KEY_A);
    encEngine = makeEngine({ crypto: crypto_ });
  });

  it("commits a v2 snapshot whose encrypted map round-trips", async () => {
    vault.set("daily/2026-08-03.md", "# today\n");
    vault.set("notes/idea.md", "spark");

    const res = await encEngine.sync();
    expect(res.status).toBe("committed");

    const m = headManifest();
    expect(m.keyId).toBe(crypto_.keyId);
    expect(m.blobs).toHaveLength(2);

    const files = await crypto_.decryptJson<Record<string, FileEntry>>(m.enc);
    expect(Object.keys(files).sort()).toEqual(["daily/2026-08-03.md", "notes/idea.md"]);
    expect(files["notes/idea.md"].h).toBe(await hex("spark"));
  });

  it("uploads ciphertext, never plaintext, and stores it under the ciphertext hash", async () => {
    vault.set("secret.md", "PATIENT NAME: confidential");
    await encEngine.sync();

    const plainHash = await hex("PATIENT NAME: confidential");
    expect(server.blobs.has(plainHash)).toBe(false);

    const m = headManifest();
    const files = await crypto_.decryptJson<Record<string, FileEntry>>(m.enc);
    const entry = files["secret.md"];
    expect(entry.h).toBe(plainHash);
    expect(entry.c).toBeDefined();
    expect(m.blobs).toEqual([entry.c]);
    expect(server.blobs.has(entry.c!)).toBe(true);
  });

  it("leaks neither paths nor plaintext hashes in the committed manifest", async () => {
    vault.set("private/therapy.md", "session notes");
    await encEngine.sync();

    const wire = JSON.stringify(headManifest());
    expect(wire).not.toContain("therapy");
    expect(wire).not.toContain("private");
    expect(wire).not.toContain(await hex("session notes"));
  });

  it("still deduplicates identical content across paths", async () => {
    vault.set("a.md", "same bytes");
    vault.set("copy/a.md", "same bytes");

    const res = await encEngine.sync();
    expect(res.status).toBe("committed");
    expect(res.uploaded).toBe(1);
    expect(headManifest().blobs).toHaveLength(1);
  });

  it("still uploads nothing on rename", async () => {
    vault.set("a.md", "unchanged content");
    await encEngine.sync();
    server.uploads.length = 0;

    vault.rename("a.md", "renamed.md");
    const res = await encEngine.sync();

    expect(res.status).toBe("committed");
    expect(server.uploads).toEqual([]);
    const files = await crypto_.decryptJson<Record<string, FileEntry>>(headManifest().enc);
    expect(Object.keys(files)).toEqual(["renamed.md"]);
  });

  it("is a no-op on the second push and incremental on an edit", async () => {
    vault.set("a.md", "one");
    vault.set("b.md", "two");
    await encEngine.sync();
    server.uploads.length = 0;

    expect((await encEngine.sync()).status).toBe("unchanged");

    vault.set("a.md", "one edited", now + 1000);
    const res = await encEngine.sync();
    expect(res.status).toBe("committed");
    expect(res.uploaded).toBe(1);
    expect(server.uploads).toHaveLength(1);
  });

  it("re-encrypts on demand when a cached blob has gone missing server-side", async () => {
    vault.set("a.md", "one");
    vault.set("b.md", "two");
    await encEngine.sync();

    // "a.md" is unchanged, so its bytes are not in this pass's cache: the recovery path
    // must re-read the file and re-derive the same ciphertext.
    const files = await crypto_.decryptJson<Record<string, FileEntry>>(headManifest().enc);
    const cA = files["a.md"].c!;
    server.blobs.delete(cA);
    server.uploads.length = 0;

    vault.set("b.md", "two edited", now + 1000);
    const res = await encEngine.sync();

    expect(res.status).toBe("committed");
    expect(server.uploads).toContain(cA);
    expect(server.blobs.has(cA)).toBe(true);
  });

  it("refuses an ordinary sync when the master key changes", async () => {
    vault.set("a.md", "one");
    await encEngine.sync();
    const oldHead = server.head;

    const rekeyed = makeEngine({ crypto: await VaultCrypto.create(KEY_B) });
    const res = await rekeyed.sync();

    expect(res).toMatchObject({ status: "halted", reason: expect.stringMatching(/explicit migration/) });
    expect(server.head).toBe(oldHead);
  });

  it("explicitly re-keys every entry, including a remote-only excluded file", async () => {
    const old = makeEngine({ crypto: crypto_, excludes: [] });
    vault.set("a.md", "one");
    vault.set("private/remote.md", "must survive");
    await old.sync();
    const oldHead = server.head!;
    vault.delete("private/remote.md");

    const target = await VaultCrypto.create(KEY_B);
    const source = makeEngine({ crypto: crypto_, excludes: ["private/**"] });
    const res = await source.migrateEncryption(target);

    expect(res).toMatchObject({ uploaded: 2 });
    expect(server.head).not.toBe(oldHead);
    const migrated = encManifest(server.manifests.get(server.head!)!);
    expect(migrated.parent).toBe(oldHead);
    expect(migrated.keyId).toBe(target.keyId);
    const files = await target.decryptJson<Record<string, FileEntry>>(migrated.enc);
    expect(Object.keys(files).sort()).toEqual(["a.md", "private/remote.md"]);
    expect(vault.writes).toEqual([]);
    expect(vault.removes).toEqual([]);
  });

  it("refuses a re-key when the remote advanced under the previous key", async () => {
    vault.set("a.md", "one");
    await encEngine.sync();
    const advanced = server.seedRemoteEncryptedCommit({ keyId: crypto_.keyId });

    const rekeyed = makeEngine({ crypto: await VaultCrypto.create(KEY_B) });
    const res = await rekeyed.sync();

    expect(res).toMatchObject({
      status: "halted",
      reason: expect.stringMatching(/explicit migration/),
    });
    expect(server.head).toBe(advanced);
    expect(vault.text("a.md")).toBe("one");
  });

  it("migrates a non-empty plaintext head to encrypted v2 without touching local files", async () => {
    vault.set("a.md", "one");
    await engine.sync(); // plaintext first
    expect(server.blobs.has(await hex("one"))).toBe(true);
    const oldHead = server.head!;

    const target = crypto_;
    server.uploads.length = 0;
    const res = await engine.migrateEncryption(target);

    expect(res.uploaded).toBe(1);
    const m = headManifest();
    expect(m.v).toBe(2);
    expect(m.parent).toBe(oldHead);
    expect(server.uploads).toEqual(m.blobs);
    expect(m.blobs).not.toContain(await hex("one"));
    expect(vault.writes).toEqual([]);
    expect(vault.removes).toEqual([]);
    expect(store.state).toMatchObject({ lastSyncedHead: server.head, keyId: target.keyId });
  });

  it("migrates a non-empty encrypted head to plaintext v1", async () => {
    vault.set("a.md", "one");
    await encEngine.sync();
    const oldHead = server.head!;
    server.uploads.length = 0;

    const res = await encEngine.migrateEncryption(null);

    expect(res.uploaded).toBe(1);
    const m = server.manifests.get(server.head!)!;
    expect(m.v).toBe(1);
    if (m.v !== 1) throw new Error("expected plaintext migration");
    expect(m.parent).toBe(oldHead);
    expect(m.files["a.md"].c).toBeUndefined();
    expect(server.blobs.get(m.files["a.md"].h)).toEqual(new TextEncoder().encode("one"));
    expect(store.state).toMatchObject({ lastSyncedHead: server.head, keyId: null });
    expect(vault.writes).toEqual([]);
    expect(vault.removes).toEqual([]);
  });

  it("refuses migration until the source vault is converged and clean", async () => {
    vault.set("a.md", "one");
    await encEngine.sync();
    const oldHead = server.head;
    vault.set("a.md", "local edit", now + 1);

    await expect(encEngine.migrateEncryption(await VaultCrypto.create(KEY_B))).rejects.toThrow(
      /sync under the current encryption mode first/
    );
    expect(server.head).toBe(oldHead);
  });

  it("aborts migration on a stale CAS without advancing local state", async () => {
    vault.set("a.md", "one");
    await encEngine.sync();
    const oldHead = server.head;
    const oldState = structuredClone(store.state);
    server.failNextCommitWith = new StaleHeadError("head moved", "01RACE");

    await expect(encEngine.migrateEncryption(await VaultCrypto.create(KEY_B))).rejects.toThrow(
      /remote head changed during encryption migration/
    );
    expect(server.head).toBe(oldHead);
    expect(store.state).toEqual(oldState);
  });

  it("adopts an empty plaintext head — the live migration path", async () => {
    await server.seedRemoteCommit({});
    vault.set("a.md", "first encrypted note");

    const res = await encEngine.sync();

    expect(res.status).toBe("committed");
    expect(headManifest().v).toBe(2);
    expect(headManifest().parent).not.toBeNull();
  });

  it("halts when the remote is encrypted with a different master key", async () => {
    const other = await VaultCrypto.create(KEY_B);
    server.seedRemoteEncryptedCommit({ keyId: other.keyId });
    vault.set("a.md", "one");

    const res = await encEngine.sync();

    expect(res).toMatchObject({ status: "halted", reason: expect.stringMatching(/different master key/) });
    expect(encEngine.status.phase).toBe("halted");
  });

  it("halts when the remote is encrypted and this device has no key", async () => {
    server.seedRemoteEncryptedCommit({ keyId: crypto_.keyId });
    vault.set("a.md", "one");

    const res = await engine.sync();

    expect(res).toMatchObject({ status: "halted", reason: expect.stringMatching(/no vault master key/) });
  });

  it("halts when the remote holds unencrypted files and this device encrypts", async () => {
    await server.seedRemoteCommit({ "theirs.md": "plaintext" });
    vault.set("a.md", "one");

    const res = await encEngine.sync();

    expect(res).toMatchObject({ status: "halted", reason: expect.stringMatching(/unencrypted/) });
  });

  describe("two encrypted devices", () => {
    let phoneVault: FakeVault;
    let phone: SyncEngine;

    beforeEach(() => {
      phoneVault = new FakeVault();
      phone = new SyncEngine({
        vault: phoneVault,
        api: server,
        store: new FakeStore(),
        deviceName: "phone",
        excludes: [".obsidian/**"],
        maxBlobBytes: 1024,
        now: () => now,
        crypto: crypto_,
      });
    });

    it("pulls and decrypts another device's snapshot", async () => {
      vault.set("daily/log.md", "# log\n- one\n");
      vault.set("attach.bin", new Uint8Array([0, 1, 2, 250]));
      await encEngine.sync();

      const res = await phone.sync();

      expect(res).toMatchObject({ status: "pulled", pulled: 2 });
      expect(phoneVault.text("daily/log.md")).toBe("# log\n- one\n");
      expect([...phoneVault.files.get("attach.bin")!.data]).toEqual([0, 1, 2, 250]);
    });

    it("merges concurrent edits across two encrypted devices", async () => {
      vault.set("daily/log.md", "# log\n- one\n");
      await encEngine.sync();
      await phone.sync();

      phoneVault.set("daily/log.md", "# log\n- one\n- from the phone\n", now + 1000);
      expect((await phone.sync()).status).toBe("committed");

      vault.set("daily/log.md", "# log\n- one, corrected\n", now + 2000);
      const res = await encEngine.sync();

      expect(res).toMatchObject({ status: "committed", merged: 1, conflicts: [] });
      expect(vault.text("daily/log.md")).toBe("# log\n- one, corrected\n- from the phone\n");

      // …and the phone converges on the same content next time it syncs.
      expect((await phone.sync()).status).toBe("pulled");
      expect(phoneVault.text("daily/log.md")).toBe("# log\n- one, corrected\n- from the phone\n");
    });

    it("keeps both sides of an unmergeable conflict, still encrypted", async () => {
      vault.set("note.md", "original\n");
      await encEngine.sync();
      await phone.sync();

      phoneVault.set("note.md", "phone rewrite\n", now + 1000);
      await phone.sync();
      vault.set("note.md", "desktop rewrite\n", now + 2000);

      const res = await encEngine.sync();

      expect(res.conflicts).toHaveLength(1);
      expect(vault.text("note.md")).toBe("desktop rewrite\n");
      expect(vault.text(res.conflicts[0])).toBe("phone rewrite\n");
      // The server still sees nothing but ciphertext blobs.
      const wire = JSON.stringify(headManifest());
      expect(wire).not.toContain("conflict");
      expect(wire).not.toContain("note");
    });
  });
});
