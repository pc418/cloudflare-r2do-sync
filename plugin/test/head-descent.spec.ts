import { describe, it, expect, beforeEach } from "vitest";
import { StaleHeadError } from "../src/api";
import { sha256Hex } from "../src/hash";
import {
  SyncEngine,
  type ContinuityDecision,
  type ContinuitySummary,
  type SyncApiLike,
} from "../src/sync";
import type { Manifest } from "../src/types";
import { VaultCrypto } from "../src/crypto";
import { FakeServer, FakeStore, FakeVault } from "./fakes";

let vault: FakeVault;
let server: FakeServer;
let store: FakeStore;
let now: number;
/** Every continuity question a pass raised, in order. */
let asked: ContinuitySummary[];
/** Manifest ids actually fetched, so the cost of the check is assertable and not assumed. */
let fetched: string[];
/** Runs just before a commit reaches the fake server; used to lose the head race on purpose. */
let beforeCommit: (() => void) | null;

/** The fake server behind a recording facade. Nothing else about its behaviour changes. */
function recordingApi(): SyncApiLike {
  return {
    getHead: () => server.getHead(),
    getManifest: async (id) => {
      fetched.push(id);
      return await server.getManifest(id);
    },
    getBlob: (hash) => server.getBlob(hash),
    checkBlobs: (hashes) => server.checkBlobs(hashes),
    putBlob: (hash, bytes) => server.putBlob(hash, bytes),
    commit: (manifest, expectedHead, opts) => {
      beforeCommit?.();
      return server.commit(manifest, expectedHead, opts);
    },
  };
}

function makeEngine(
  overrides: Partial<ConstructorParameters<typeof SyncEngine>[0]> = {},
  answer: ContinuityDecision | null = "continue"
) {
  return new SyncEngine({
    vault,
    api: recordingApi(),
    store,
    deviceName: "test-device",
    maxBlobBytes: 1024,
    now: () => now,
    ...(answer === null
      ? {}
      : {
          decideContinuity: async (summary) => {
            asked.push(summary);
            return answer;
          },
        }),
    ...overrides,
  });
}

beforeEach(() => {
  vault = new FakeVault();
  server = new FakeServer();
  store = new FakeStore();
  now = 1_754_000_000_000;
  asked = [];
  fetched = [];
  beforeCommit = null;
});

/**
 * A snapshot published by some other device, layered onto `parent` — which may be null, which
 * is what "Rebuild remote history" publishes and what a replaced history looks like.
 */
async function otherDeviceCommit(
  parent: string | null,
  files: Record<string, string>
): Promise<string> {
  const entries: Record<string, { h: string; size: number; mtime: number }> = {};
  for (const [path, content] of Object.entries(files)) {
    const bytes = new TextEncoder().encode(content);
    const h = await sha256Hex(bytes);
    server.blobs.set(h, bytes);
    entries[path] = { h, size: bytes.byteLength, mtime: now };
  }
  const id = `01OTHER${String(server.manifests.size).padStart(19, "0")}`;
  const manifest: Manifest = {
    v: 1,
    id,
    parent,
    device: "other-device",
    createdAt: new Date(now).toISOString(),
    files: entries,
  };
  server.manifests.set(id, manifest);
  server.head = id;
  return id;
}

/** This device's first published snapshot, and the head it leaves behind. */
async function firstSync(engine: SyncEngine): Promise<string> {
  vault.set("a.md", "ours");
  expect((await engine.sync()).status).toBe("committed");
  fetched.length = 0;
  return server.head!;
}

describe("head-descent verification", () => {
  it("confirms the ordinary one-commit gap without a single extra request", async () => {
    const engine = makeEngine();
    const ours = await firstSync(engine);
    const head = await otherDeviceCommit(ours, { "a.md": "ours", "theirs.md": "hi" });

    const result = await engine.sync();

    // Everything the remote had, we now have, and we added nothing — hence "pulled".
    expect(result.status).toBe("pulled");
    expect(asked).toEqual([]);
    // The head manifest is fetched for the merge regardless, and its own parent link is the
    // whole answer. Anything beyond this one id would be cost the common case must not pay.
    expect(fetched).toEqual([head]);
    expect(vault.text("theirs.md")).toBe("hi");
  });

  it("walks past intermediate snapshots to find this device's own", async () => {
    const engine = makeEngine();
    const ours = await firstSync(engine);
    const mid = await otherDeviceCommit(ours, { "a.md": "ours", "b.md": "one" });
    const head = await otherDeviceCommit(mid, { "a.md": "ours", "b.md": "two" });

    const result = await engine.sync();

    expect(result.status).toBe("pulled");
    expect(asked).toEqual([]);
    expect(fetched).toEqual([head, mid]);
    expect(vault.text("b.md")).toBe("two");
  });

  it("asks when the remote's history no longer contains this device's snapshot", async () => {
    const engine = makeEngine({}, "stop");
    const ours = await firstSync(engine);
    const rebuilt = await otherDeviceCommit(null, { "a.md": "ours", "elsewhere.md": "not ours" });

    const result = await engine.sync();

    expect(result.status).toBe("needs-continuity");
    if (result.status !== "needs-continuity") throw new Error("unreachable");
    expect(result.continuity).toEqual({
      head: rebuilt,
      lastHead: ours,
      reason: "replaced",
      walked: 1,
      alreadyApplied: 0,
    });
    expect(asked).toEqual([result.continuity]);
    // Stopping is inert: nothing written here, nothing removed, nothing published.
    expect(vault.writes).toEqual([]);
    expect(vault.removes).toEqual([]);
    expect(server.head).toBe(rebuilt);
    expect(store.state?.lastSyncedHead).toBe(ours);
  });

  it("merges the unverifiable remote once someone says so", async () => {
    const engine = makeEngine({}, "continue");
    await firstSync(engine);
    await otherDeviceCommit(null, { "a.md": "ours", "elsewhere.md": "not ours" });

    const result = await engine.sync();

    expect(asked).toHaveLength(1);
    expect(result.status).toBe("pulled");
    expect(vault.text("elsewhere.md")).toBe("not ours");
    // Our own file survives: continuing is an ordinary merge, not a takeover.
    expect(vault.text("a.md")).toBe("ours");
  });

  it("reports a collected ancestor as truncated, not as a replaced history", async () => {
    const engine = makeEngine({}, "stop");
    const ours = await firstSync(engine);
    const mid = await otherDeviceCommit(ours, { "a.md": "ours", "b.md": "one" });
    const head = await otherDeviceCommit(mid, { "a.md": "ours", "b.md": "two" });
    // What retention does to a device that has been away longer than the server keeps history.
    server.manifests.delete(mid);

    const result = await engine.sync();

    expect(result.status).toBe("needs-continuity");
    expect(asked[0]).toEqual({
      head,
      lastHead: ours,
      reason: "truncated",
      walked: 1,
      alreadyApplied: 0,
    });
  });

  it("stops walking rather than downloading an unbounded chain", async () => {
    const engine = makeEngine({}, "stop");
    const ours = await firstSync(engine);
    let parent: string | null = null;
    for (let i = 0; i < 260; i++) parent = await otherDeviceCommit(parent, { "far.md": String(i) });

    const result = await engine.sync();

    expect(result.status).toBe("needs-continuity");
    expect(asked[0].reason).toBe("limit");
    expect(asked[0].lastHead).toBe(ours);
    expect(asked[0].walked).toBe(250);
    // The bound is a bound: the head plus 249 ancestors, and not one manifest more.
    expect(fetched).toHaveLength(250);
  });

  it("fails loud on a chain that loops instead of asking a question about it", async () => {
    const engine = makeEngine();
    const ours = await firstSync(engine);
    const a = await otherDeviceCommit(ours, { "a.md": "ours" });
    const b = await otherDeviceCommit(a, { "a.md": "ours" });
    // Manifest ids are one-use, so this cannot happen unless the remote is corrupt.
    server.manifests.get(a)!.parent = b;

    await expect(engine.sync()).rejects.toThrow(/loops back to/);
    expect(asked).toEqual([]);
  });

  it("never answers itself when nobody is watching", async () => {
    // No `decideContinuity` at all: an unattended pass, or one whose plugin generation was
    // retired mid-flight. The safe non-answer is to change nothing.
    const engine = makeEngine({}, null);
    await firstSync(engine);
    await otherDeviceCommit(null, { "a.md": "ours", "elsewhere.md": "not ours" });

    const result = await engine.sync();

    expect(result.status).toBe("needs-continuity");
    expect(vault.writes).toEqual([]);
  });

  it("re-raises on the next pass instead of sticking like a halt", async () => {
    const engine = makeEngine({}, "stop");
    await firstSync(engine);
    await otherDeviceCommit(null, { "a.md": "ours", "elsewhere.md": "not ours" });

    expect((await engine.sync()).status).toBe("needs-continuity");
    expect(engine.status.phase).toBe("idle");
    expect((await engine.sync()).status).toBe("needs-continuity");
    expect(asked).toHaveLength(2);
  });

  it("does not ask a first sync, which has no checkpoint to verify against", async () => {
    const engine = makeEngine({}, "stop");
    await otherDeviceCommit(null, { "theirs.md": "hi" });
    vault.set("a.md", "ours");

    expect((await engine.sync()).status).toBe("committed");
    expect(asked).toEqual([]);
  });

  it("skips the check for an operation previewed against a named head", async () => {
    const engine = makeEngine({}, "stop");
    await firstSync(engine);
    const rebuilt = await otherDeviceCommit(null, { "a.md": "ours", "elsewhere.md": "not ours" });

    // A forced push is pinned to the head the operator was shown and merges nothing from it,
    // so the question this check raises is one they have already answered.
    expect((await engine.sync({ keepLocal: true, previewedHead: rebuilt })).status).toBe(
      "committed"
    );
    expect(asked).toEqual([]);
  });

  it("warns in the preview, which is where a cautious user looks first", async () => {
    const engine = makeEngine({}, "stop");
    const ours = await firstSync(engine);
    const rebuilt = await otherDeviceCommit(null, { "a.md": "ours", "elsewhere.md": "not ours" });

    const preview = await engine.preview();

    expect(preview.continuity).toEqual({
      head: rebuilt,
      lastHead: ours,
      reason: "replaced",
      walked: 1,
      alreadyApplied: 0,
    });
    // Still a full preview: the caveat is added to the plan, not substituted for it.
    expect(preview.pull.map((a) => a.path)).toContain("elsewhere.md");
  });

  it("leaves the preview's caveat unset when the ancestry checks out", async () => {
    const engine = makeEngine();
    const ours = await firstSync(engine);
    await otherDeviceCommit(ours, { "a.md": "ours", "theirs.md": "hi" });

    expect((await engine.preview()).continuity).toBeUndefined();
  });

  it("checks again after losing the head race, against what it just absorbed", async () => {
    const engine = makeEngine({}, "stop");
    const ours = await firstSync(engine);
    const child = await otherDeviceCommit(ours, { "a.md": "ours", "b.md": "one" });
    // Staged, not published: the pass has to see `child` first and only meet the replacement
    // when it loses the race, which is where the second check has to happen.
    const rebuilt = await otherDeviceCommit(null, { "a.md": "ours", "elsewhere.md": "not ours" });
    server.head = child;
    beforeCommit = () => {
      beforeCommit = null;
      server.head = rebuilt;
      throw new StaleHeadError("head moved", rebuilt);
    };
    vault.set("c.md", "mine");

    const result = await engine.sync();

    expect(result.status).toBe("needs-continuity");
    expect(asked).toHaveLength(1);
    expect(asked[0].lastHead).toBe(child);
    expect(asked[0].reason).toBe("replaced");

    // This is the one path where stopping is NOT inert: `child` was verified and applied
    // before the race was lost. The result has to say so, the question has to say so, and
    // persisted state has to name the snapshot the vault actually holds — otherwise the next
    // pass reads the file it just pulled as new local work and pushes it back.
    expect(result.pulled).toBe(1);
    expect(asked[0].alreadyApplied).toBe(1);
    expect(vault.text("b.md")).toBe("one");
    expect(store.state?.lastSyncedHead).toBe(child);
    expect(Object.keys(store.state?.files ?? {}).sort()).toEqual(["a.md", "b.md"]);
  });
});

describe("head-descent verification on an encrypted vault", () => {
  const KEY = new Uint8Array(32).fill(7);

  /** Three genuine v3 snapshots from this device, newest last. */
  async function threeSnapshots(
    engine: SyncEngine
  ): Promise<{ h1: string; h2: string; h3: string }> {
    vault.set("a.md", "one");
    await engine.sync();
    const h1 = server.head!;
    vault.set("a.md", "two", now + 1);
    await engine.sync();
    const h2 = server.head!;
    vault.set("a.md", "three", now + 2);
    await engine.sync();
    return { h1, h2, h3: server.head! };
  }

  /** A second device on the same vault key, publishing real v3 snapshots to the same server. */
  function otherDevice(crypto: VaultCrypto): { engine: SyncEngine; vault: FakeVault } {
    const otherVault = new FakeVault();
    return {
      vault: otherVault,
      engine: new SyncEngine({
        vault: otherVault,
        api: server,
        store: new FakeStore(),
        deviceName: "other-device",
        maxBlobBytes: 1024,
        now: () => now,
        crypto,
      }),
    };
  }

  it("verifies every link it follows, so a forged ancestor cannot fake continuity", async () => {
    // The attack this exists for. The server may serve any *authentic* older head it likes —
    // rolling back is free. What it must not be able to do is answer the walk's request for
    // that head's ancestor with a same-id envelope it wrote itself, pointing at the snapshot
    // this device last synced. An id check alone would accept it, report continuity, and let
    // the rollback in as ordinary remote edits.
    const crypto = await VaultCrypto.create(KEY);
    const engine = makeEngine({ crypto }, "stop");
    const { h1, h2, h3 } = await threeSnapshots(engine);

    server.head = h2;
    server.manifests.set(h1, {
      v: 1,
      id: h1,
      parent: h3,
      device: "attacker",
      createdAt: new Date(now).toISOString(),
      files: {},
    });

    const result = await engine.sync();

    expect(result.status).toBe("needs-continuity");
    expect(asked).toHaveLength(1);
    expect(asked[0].reason).toBe("unauthenticated");
    expect(asked[0].head).toBe(h2);
    expect(asked[0].lastHead).toBe(h3);
    // The rollback did not land: the newest content is still on disk.
    expect(vault.text("a.md")).toBe("three");
  });

  it("treats a v2 ancestor the same way — v2 never bound its header either", async () => {
    // Not an attack in itself: history reaching back past an encryption migration legitimately
    // does this. From such a snapshot on, the links are the server's word, so the walk stops
    // rather than finish a proof it can no longer make.
    const crypto = await VaultCrypto.create(KEY);
    const engine = makeEngine({ crypto }, "stop");
    const { h1, h2, h3 } = await threeSnapshots(engine);

    const authentic = server.manifests.get(h1)!;
    if (authentic.v !== 3) throw new Error("expected an encrypted vault to publish v3");
    // Same envelope, older version — so nothing binds `parent` to the ciphertext any more.
    server.manifests.set(h1, { ...authentic, v: 2, parent: h3 });
    server.head = h2;

    expect((await engine.sync()).status).toBe("needs-continuity");
    expect(asked[0].reason).toBe("unauthenticated");
    expect(vault.text("a.md")).toBe("three");
  });

  it("walks a genuine v3 chain without complaint", async () => {
    const crypto = await VaultCrypto.create(KEY);
    const engine = makeEngine({ crypto });
    vault.set("a.md", "ours");
    expect((await engine.sync()).status).toBe("committed");
    const ours = server.head!;

    // Two more snapshots from another device, so the walk has to authenticate an ancestor
    // rather than only reading the head's own parent link.
    const other = otherDevice(crypto);
    other.vault.set("a.md", "ours");
    await other.engine.sync();
    other.vault.set("b.md", "one", now + 1);
    await other.engine.sync();
    const head = server.head!;
    expect(head).not.toBe(ours);

    const result = await engine.sync();

    expect(asked).toEqual([]);
    expect(result.status === "committed" || result.status === "pulled").toBe(true);
    expect(vault.text("b.md")).toBe("one");
  });
});
