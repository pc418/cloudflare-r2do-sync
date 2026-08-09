import { describe, it, expect, beforeEach } from "vitest";
import { SyncEngine } from "../src/sync";
import { FakeServer, FakeStore, FakeVault } from "./fakes";
import type { ManifestV1 } from "../src/types";

/**
 * Concurrency has to be observable to be worth having, and invisible in its effects.
 * These cover both halves: work really does overlap, and nothing about the outcome —
 * snapshot contents, path order, conflict list — depends on how the lanes interleave.
 */

let vault: FakeVault;
let server: FakeServer;
let store: FakeStore;

beforeEach(() => {
  vault = new FakeVault();
  server = new FakeServer();
  store = new FakeStore();
});

function makeEngine(lanes: number) {
  return new SyncEngine({
    vault,
    api: server,
    store,
    deviceName: "test-device",
    now: () => 1_754_000_000_000,
    lanes,
  });
}

/** Wraps a method so the test can watch how many calls are in flight at once. */
function trackConcurrency<T extends object, K extends keyof T>(target: T, key: K) {
  const original = target[key] as (...args: unknown[]) => Promise<unknown>;
  const stat = { peak: 0, inFlight: 0 };
  target[key] = (async (...args: unknown[]) => {
    stat.peak = Math.max(stat.peak, ++stat.inFlight);
    try {
      // A real await point, so other lanes get a chance to start before this one finishes.
      await new Promise((r) => setTimeout(r, 1));
      return await original.apply(target, args);
    } finally {
      stat.inFlight--;
    }
  }) as T[K];
  return stat;
}

describe("lanes", () => {
  it("reads several files at once when scanning the vault", async () => {
    for (let i = 0; i < 12; i++) vault.set(`note-${i}.md`, `content ${i}`);
    const reads = trackConcurrency(vault, "read");

    await makeEngine(4).sync();

    expect(reads.peak).toBe(4);
  });

  it("uploads several blobs at once", async () => {
    for (let i = 0; i < 12; i++) vault.set(`note-${i}.md`, `content ${i}`);
    const uploads = trackConcurrency(server, "putBlob");

    await makeEngine(3).sync();

    expect(uploads.peak).toBe(3);
  });

  it("downloads several blobs at once when pulling", async () => {
    const remote: Record<string, string> = {};
    for (let i = 0; i < 12; i++) remote[`from-other-${i}.md`] = `remote ${i}`;
    await server.seedRemoteCommit(remote);
    const downloads = trackConcurrency(server, "getBlob");

    await makeEngine(4).sync();

    expect(downloads.peak).toBe(4);
    expect(vault.files.size).toBe(12);
  });

  it("lanes: 1 keeps the old strictly-serial behaviour", async () => {
    for (let i = 0; i < 6; i++) vault.set(`note-${i}.md`, `content ${i}`);
    const reads = trackConcurrency(vault, "read");

    await makeEngine(1).sync();

    expect(reads.peak).toBe(1);
  });

  it("produces a byte-identical snapshot whatever the lane count", async () => {
    // Path order feeds the manifest (and, when encrypted, the encrypted path map), so it
    // must come from the scan, not from whichever read happened to land first.
    const snapshot = async (lanes: number) => {
      vault = new FakeVault();
      server = new FakeServer();
      store = new FakeStore();
      for (let i = 0; i < 20; i++) vault.set(`note-${i}.md`, `content ${i}`);
      await makeEngine(lanes).sync();
      const m = server.manifests.get(server.head!) as ManifestV1;
      return Object.keys(m.files);
    };

    expect(await snapshot(8)).toEqual(await snapshot(1));
  });

  it("reports conflicts in plan order, not completion order", async () => {
    // Both sides edited every file, so each one becomes a conflict copy; the list a user
    // reads should be stable across runs and lane counts.
    const remote: Record<string, string> = {};
    for (let i = 0; i < 8; i++) remote[`note-${i}.png`] = `theirs ${i}`;
    await server.seedRemoteCommit(remote);
    for (let i = 0; i < 8; i++) vault.set(`note-${i}.png`, `ours ${i}`);

    const res = await makeEngine(4).sync();

    expect(res.conflicts.length).toBe(8);
    expect([...res.conflicts]).toEqual([...res.conflicts].sort());
  });

  it("a failed read aborts the pass without leaving stragglers writing", async () => {
    for (let i = 0; i < 12; i++) vault.set(`note-${i}.md`, `content ${i}`);
    let inFlight = 0;
    const realRead = vault.read.bind(vault);
    vault.read = async (path: string) => {
      inFlight++;
      try {
        await new Promise((r) => setTimeout(r, 1));
        if (path === "note-5.md") throw new Error("disk gave up");
        return await realRead(path);
      } finally {
        inFlight--;
      }
    };

    await expect(makeEngine(4).sync()).rejects.toThrow("disk gave up");
    // The pool waits for in-flight reads before rethrowing, so nothing is still running.
    expect(inFlight).toBe(0);
    expect(server.head).toBeNull();
  });
});
