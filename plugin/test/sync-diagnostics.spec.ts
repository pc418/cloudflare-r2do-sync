import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api";
import { SyncEngine, type SyncCheckpoint, type SyncResult } from "../src/sync";
import {
  DIAGNOSTIC_SCHEMA,
  DiagnosticWriteError,
  SyncDiagnostics,
  TRACE_LIMIT,
  errorKind,
  parseRecord,
  type DiagnosticRecord,
  type DiagnosticStorage,
} from "../src/sync-diagnostics";
import { FakeServer, FakeStore, FakeVault } from "./fakes";

/**
 * The recovery record on its own. PIN (lead assignment 2026-09-25,
 * docs/260925-fix-IPHONE_SYNC_RECOVERY_PLAN.md): only the pass that set a marker clears it;
 * writes are serialised and each carries the newest state, so no stale write can land after a
 * completion; the trace is bounded and closed; and an unreadable record is never "no record".
 */

const PATH = ".obsidian/plugins/cloudflare-rdo-sync/sync-recovery.json";

class MemoryStorage implements DiagnosticStorage {
  files = new Map<string, string>();
  writes: string[] = [];
  failWrite: Error | null = null;
  /** When set, each write waits for the test to release it, in order. */
  gated = false;
  readonly #gates: (() => void)[] = [];
  async stat(path: string) {
    return this.files.has(path) ? { type: "file" } : null;
  }
  async read(path: string) {
    const data = this.files.get(path);
    if (data === undefined) throw new Error("ENOENT");
    return data;
  }
  async write(path: string, data: string) {
    if (this.gated) await new Promise<void>((resolve) => this.#gates.push(resolve));
    if (this.failWrite) throw this.failWrite;
    this.files.set(path, data);
    this.writes.push(data);
  }
  releaseAll(): void {
    this.gated = false;
    for (const release of this.#gates.splice(0)) release();
  }
  record(): DiagnosticRecord {
    return JSON.parse(this.files.get(PATH)!) as DiagnosticRecord;
  }
}

function make(storage = new MemoryStorage()) {
  let t = 1_000;
  const failures: string[] = [];
  const diagnostics = new SyncDiagnostics({
    storage,
    path: PATH,
    pluginVersion: "1.1.3",
    platform: "ios-mobile",
    now: () => ++t,
    onFailure: (f) => failures.push(f),
  });
  return { diagnostics, storage, failures };
}

const RESULT = { status: "unchanged" } as SyncResult;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SyncDiagnostics", () => {
  it("does not let a stale pass clear or advance a newer pass's marker", async () => {
    const { diagnostics, storage } = make();
    await diagnostics.load();
    const old = await diagnostics.beginPass();
    await diagnostics.finishPass(old, { result: RESULT });
    const current = await diagnostics.beginPass();

    await diagnostics.checkpoint(old, "commit");
    await diagnostics.finishPass(old, { error: new Error("late") });

    const onDisk = storage.record();
    expect(onDisk.active?.startedAt).toBe(current.startedAt);
    expect(onDisk.active?.phase).toBe("pass-start");
    expect(onDisk.lastFailed).toBeNull();
  });

  it("never lands an older state after the completion, however the writes interleave", async () => {
    const { diagnostics, storage } = make();
    await diagnostics.load();
    const pass = await diagnostics.beginPass();
    storage.gated = true;
    const a = diagnostics.checkpoint(pass, "scan");
    const b = diagnostics.checkpoint(pass, "upload");
    const c = diagnostics.finishPass(pass, { result: RESULT });
    await flush();
    storage.releaseAll();
    await Promise.all([a, b, c]);
    // Writes are bounded by the awaiting callers, and the last one is the completed state.
    expect(storage.record().active).toBeNull();
    expect(storage.record().lastCompleted?.status).toBe("unchanged");
    for (const write of storage.writes.slice(-3)) {
      expect((JSON.parse(write) as DiagnosticRecord).active).toBeNull();
    }
  });

  it("refuses to start a pass it cannot mark, and reports the failure once", async () => {
    const { diagnostics, storage, failures } = make();
    await diagnostics.load();
    storage.failWrite = new Error("disk full");
    await expect(diagnostics.beginPass()).rejects.toBeInstanceOf(DiagnosticWriteError);
    await expect(diagnostics.beginPass()).rejects.toBeInstanceOf(DiagnosticWriteError);
    expect(failures).toEqual(["write"]);
    expect(diagnostics.blocksAutomatic).toBe(true);
  });

  it("keeps the pause when a resume cannot be persisted", async () => {
    const storage = new MemoryStorage();
    storage.files.set(
      PATH,
      JSON.stringify({
        schema: DIAGNOSTIC_SCHEMA, pluginVersion: "1.1.2", platform: "ios-mobile",
        active: { startedAt: 1, phase: "merge", phaseAt: 2 }, paused: null,
        lastCompleted: null, lastFailed: null, trace: [],
      })
    );
    const { diagnostics, failures } = make(storage);
    expect(await diagnostics.load()).toEqual({ paused: true, failure: null });
    expect(storage.record().paused?.interrupted.phase).toBe("merge");
    expect(storage.record().pluginVersion).toBe("1.1.3");

    storage.failWrite = new Error("read-only");
    expect(await diagnostics.resume()).toBe(false);
    expect(diagnostics.paused).toBe(true);
    expect(storage.record().paused).not.toBeNull();
    expect(failures).toEqual(["write"]);

    storage.failWrite = null;
    expect(await diagnostics.resume()).toBe(true);
    expect(diagnostics.blocksAutomatic).toBe(false);
    expect(storage.record().paused).toBeNull();
  });

  it("writes nothing after retirement", async () => {
    const { diagnostics, storage } = make();
    await diagnostics.load();
    const pass = await diagnostics.beginPass();
    const writes = storage.writes.length;
    diagnostics.retire();
    await diagnostics.finishPass(pass, { result: RESULT });
    expect(storage.writes.length).toBe(writes);
    expect(storage.record().active).not.toBeNull();
  });

  it("bounds the trace and the stored record", async () => {
    const { diagnostics, storage } = make();
    await diagnostics.load();
    for (let i = 0; i < 40; i++) {
      const pass = await diagnostics.beginPass();
      await diagnostics.checkpoint(pass, "head");
      await diagnostics.finishPass(pass, { result: RESULT });
    }
    expect(storage.record().trace).toHaveLength(TRACE_LIMIT);
    expect(storage.files.get(PATH)!.length).toBeLessThan(4096);
  });

  it("describes errors by kind only", () => {
    expect(errorKind(new ApiError("GET https://synthetic.example/api/head failed: token abc", 502))).toBe("http-502");
    expect(errorKind(new Error("secret-note.md kept changing"))).toBe("error");
  });

  it("treats unknown fields and events as unreadable rather than as no record", () => {
    const valid = {
      schema: DIAGNOSTIC_SCHEMA, pluginVersion: "1", platform: "x", active: null, paused: null,
      lastCompleted: null, lastFailed: null, trace: [{ at: 1, event: "head" }],
    };
    expect(parseRecord(JSON.stringify(valid))).not.toBeNull();
    expect(parseRecord(JSON.stringify({ ...valid, active: { startedAt: 1, phase: "x.md", phaseAt: 1 } }))).toBeNull();
    expect(parseRecord(JSON.stringify({ ...valid, trace: "nope" }))).toBeNull();
    expect(parseRecord("")).toBeNull();
    // Fields outside the schema are dropped on the way in, not carried forward.
    const extra = parseRecord(JSON.stringify({ ...valid, url: "https://synthetic.example" }));
    expect(JSON.stringify(extra)).not.toContain("synthetic.example");
  });
});

describe("SyncEngine onCheckpoint", () => {
  function engineWith(server: FakeServer, vault: FakeVault, store: FakeStore, seen: SyncCheckpoint[], gate?: Promise<void>) {
    return new SyncEngine({
      vault,
      api: server,
      store,
      deviceName: "synthetic-device",
      now: () => 1_754_000_000_000,
      onCheckpoint: async (phase) => {
        seen.push(phase);
        if (gate) await gate;
      },
    });
  }

  it("reports coarse phases of a publish and of a pull, in order", async () => {
    const server = new FakeServer();
    const first = new FakeVault();
    first.set("one.md", "1");
    const pushSeen: SyncCheckpoint[] = [];
    await engineWith(server, first, new FakeStore(), pushSeen).sync();
    expect(pushSeen).toEqual(["head", "scan", "upload", "commit"]);

    const second = new FakeVault();
    const pullSeen: SyncCheckpoint[] = [];
    const result = await engineWith(server, second, new FakeStore(), pullSeen).sync();
    expect(result.status).toBe("pulled");
    expect(pullSeen).toEqual(["head", "remote", "scan", "merge", "scan"]);
  });

  it("awaits the hook before the first request", async () => {
    const server = new FakeServer();
    let heads = 0;
    const getHead = server.getHead.bind(server);
    server.getHead = async () => {
      heads++;
      return getHead();
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const seen: SyncCheckpoint[] = [];
    const pass = engineWith(server, new FakeVault(), new FakeStore(), seen, gate).sync();
    await flush();
    expect(seen).toEqual(["head"]);
    expect(heads).toBe(0);
    release();
    await pass;
    expect(heads).toBe(1);
  });
});
