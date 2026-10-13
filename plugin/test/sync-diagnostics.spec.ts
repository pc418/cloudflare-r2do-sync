import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api";
import { SyncEngine, type SyncCheckpoint, type SyncResult } from "../src/sync";
import {
  COOLDOWN_MAX_MS,
  DIAGNOSTIC_SCHEMA,
  DiagnosticWriteError,
  SyncDiagnostics,
  TRACE_LIMIT,
  cooldownMs,
  errorKind,
  parseRecord,
  type DiagnosticRecord,
  type DiagnosticStorage,
} from "../src/sync-diagnostics";
import { FakeServer, FakeStore, FakeVault } from "./fakes";
import {
  SyncDiagnostics as SyncDiagnostics116,
  parseRecord as parseRecord116,
} from "./fixtures/sync-diagnostics-1.1.6";

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
  async readBinary(path: string) {
    return Uint8Array.from(new TextEncoder().encode(await this.read(path))).buffer;
  }
  async write(path: string, data: string) {
    if (this.gated) await new Promise<void>((resolve) => this.#gates.push(resolve));
    if (this.failWrite) throw this.failWrite;
    this.files.set(path, data);
    this.writes.push(data);
  }
  async writeBinary(path: string, data: ArrayBuffer) {
    await this.write(path, new TextDecoder().decode(data));
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

  it("does not turn a failed marker write into a phantom interrupted pass on resume", async () => {
    const { diagnostics, storage } = make();
    await diagnostics.load();
    storage.failWrite = new Error("disk full");
    await expect(diagnostics.beginPass()).rejects.toBeInstanceOf(DiagnosticWriteError);
    storage.failWrite = null;
    expect(await diagnostics.resume()).toBe(true);
    expect(storage.record().active).toBeNull();
    const next = make(storage);
    expect(await next.diagnostics.load()).toEqual({ coolingDown: false, failure: null });
  });

  it("keeps the cooldown when a resume cannot be persisted", async () => {
    const storage = new MemoryStorage();
    storage.files.set(
      PATH,
      JSON.stringify({
        schema: DIAGNOSTIC_SCHEMA, pluginVersion: "1.1.2", platform: "ios-mobile",
        active: { startedAt: 1, phase: "merge", phaseAt: 2 }, paused: null, streak: 2,
        cooldown: null, lastCompleted: null, lastFailed: null, trace: [],
      })
    );
    const { diagnostics, failures } = make(storage);
    expect(await diagnostics.load()).toEqual({ coolingDown: true, failure: null });
    expect(storage.record().lastInterrupted?.pass.phase).toBe("merge");
    expect(storage.record().streak).toBe(3);
    expect(storage.record().pluginVersion).toBe("1.1.3");

    storage.failWrite = new Error("read-only");
    expect(await diagnostics.resume()).toBe(false);
    expect(diagnostics.coolingDown).toBe(true);
    expect(storage.record().cooldown).not.toBeNull();
    expect(storage.record().streak).toBe(3);
    expect(failures).toEqual(["write"]);

    storage.failWrite = null;
    expect(await diagnostics.resume()).toBe(true);
    expect(diagnostics.blocksAutomatic).toBe(false);
    expect(storage.record().cooldown).toBeNull();
    expect(storage.record().streak).toBe(0);
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
    await expect(diagnostics.beginPass()).rejects.toBeInstanceOf(DiagnosticWriteError);
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

// --- interruption streak and cooldown -------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;

/** One plugin load on `storage`, with a clock the test moves. A fresh instance per load. */
function launch(storage: MemoryStorage, clock: { now: number }) {
  const cooldowns: [number, number][] = [];
  const failures: string[] = [];
  const diagnostics = new SyncDiagnostics({
    storage,
    path: PATH,
    pluginVersion: "1.1.7",
    platform: "ios-mobile",
    now: () => clock.now,
    onFailure: (f) => failures.push(f),
    onCooldown: (streak, waitMs) => cooldowns.push([streak, waitMs]),
  });
  return { diagnostics, cooldowns, failures };
}

/** A launch that starts a pass and is killed before it settles: the marker stays on disk. */
async function killedPass(storage: MemoryStorage, clock: { now: number }): Promise<void> {
  const { diagnostics } = launch(storage, clock);
  await diagnostics.load();
  await diagnostics.beginPass();
  diagnostics.retire();
}

/** A record as 1.1.4–1.1.6 wrote it (no streak, cooldown or lastInterrupted), plus overrides. */
function legacyRecord(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: DIAGNOSTIC_SCHEMA, pluginVersion: "1.1.6", platform: "ios-mobile",
    active: null, paused: null, lastCompleted: null, lastFailed: null,
    trace: [{ at: 1, event: "plugin-load" }],
    ...over,
  });
}

describe("interruption streak", () => {
  it("waits 15 minutes on the third interruption, doubling to a 4-hour cap", () => {
    expect([0, 1, 2].map(cooldownMs)).toEqual([0, 0, 0]);
    expect([3, 4, 5, 6, 7, 8, 40].map(cooldownMs)).toEqual([
      15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 4 * HOUR, 4 * HOUR, 4 * HOUR,
    ]);
    expect(COOLDOWN_MAX_MS).toBe(4 * HOUR);
  });

  // PIN: owner 2026-10-13 — an interrupted sync continues automatically; the settings Resume button is never required (docs/261013-fix-AUTO_CONTINUE_AFTER_INTERRUPTED_SYNC.md)
  it("counts each interruption once across reloads, continues twice, then cools down and ends by itself", async () => {
    const storage = new MemoryStorage();
    const clock = { now: 1_000_000 };

    await killedPass(storage, clock);
    let load = launch(storage, clock);
    expect(await load.diagnostics.load()).toEqual({ coolingDown: false, failure: null });
    expect(storage.record().streak).toBe(1);
    expect(storage.record().active).toBeNull();
    expect(storage.record().cooldown).toBeNull();
    expect(storage.record().trace.at(-1)?.event).toBe("plugin-load");
    expect(load.diagnostics.blocksAutomatic).toBe(false);

    // A reload with no new pass finds nothing left to count.
    load = launch(storage, clock);
    await load.diagnostics.load();
    expect(storage.record().streak).toBe(1);
    expect(load.diagnostics.blocksAutomatic).toBe(false);

    await killedPass(storage, clock);
    load = launch(storage, clock);
    await load.diagnostics.load();
    expect(storage.record().streak).toBe(2);
    expect(storage.record().cooldown).toBeNull();
    expect(load.cooldowns).toEqual([]);
    expect(load.diagnostics.blocksAutomatic).toBe(false);

    await killedPass(storage, clock);
    clock.now = 2_000_000;
    load = launch(storage, clock);
    expect(await load.diagnostics.load()).toEqual({ coolingDown: true, failure: null });
    expect(storage.record().streak).toBe(3);
    expect(storage.record().cooldown).toEqual({ since: 2_000_000, until: 2_000_000 + 15 * MIN });
    expect(storage.record().trace.at(-1)?.event).toBe("recovery-paused");
    expect(load.cooldowns).toEqual([[3, 15 * MIN]]);
    expect(load.diagnostics.blocksAutomatic).toBe(true);

    // Reloading inside the cooldown neither counts again nor announces it again.
    clock.now += 10 * MIN;
    load = launch(storage, clock);
    expect(await load.diagnostics.load()).toEqual({ coolingDown: true, failure: null });
    expect(storage.record().streak).toBe(3);
    expect(load.cooldowns).toEqual([]);

    // The deadline is measured from the load that found the interruption, on the injected clock.
    clock.now = 2_000_000 + 15 * MIN - 1;
    expect(load.diagnostics.blocksAutomatic).toBe(true);
    clock.now = 2_000_000 + 15 * MIN;
    expect(load.diagnostics.blocksAutomatic).toBe(false);
    expect(load.diagnostics.coolingDown).toBe(false);

    // The one pass after expiry is killed too: the next load applies the next, longer wait.
    await load.diagnostics.beginPass();
    load.diagnostics.retire();
    clock.now = 3_000_000;
    load = launch(storage, clock);
    await load.diagnostics.load();
    expect(storage.record().streak).toBe(4);
    expect(storage.record().cooldown).toEqual({ since: 3_000_000, until: 3_000_000 + 30 * MIN });
    expect(load.cooldowns).toEqual([[4, 30 * MIN]]);
  });

  it("caps the wait at 4 hours, and never honours a stored deadline past the cap", async () => {
    const storage = new MemoryStorage();
    storage.files.set(PATH, legacyRecord({ streak: 7, active: { startedAt: 5, phase: "upload", phaseAt: 6 } }));
    const clock = { now: 10 * HOUR };
    const { diagnostics, cooldowns } = launch(storage, clock);
    await diagnostics.load();
    expect(cooldowns).toEqual([[8, 4 * HOUR]]);
    clock.now = 14 * HOUR - 1;
    expect(diagnostics.blocksAutomatic).toBe(true);
    clock.now = 14 * HOUR;
    expect(diagnostics.blocksAutomatic).toBe(false);

    // A stored deadline beyond the cap. (Its own storage: the expiry above persists itself.)
    const capped = new MemoryStorage();
    capped.files.set(PATH, legacyRecord({ streak: 9, cooldown: { since: HOUR, until: 100 * HOUR } }));
    const stored = launch(capped, clock);
    clock.now = 5 * HOUR - 1;
    await stored.diagnostics.load();
    expect(stored.diagnostics.cooldownRemainingMs).toBe(1);
    clock.now = 5 * HOUR;
    expect(stored.diagnostics.coolingDown).toBe(false);
  });

  it("never revives an expired cooldown when the clock is set back, and persists its end", async () => {
    const storage = new MemoryStorage();
    storage.files.set(PATH, legacyRecord({ streak: 3, cooldown: { since: HOUR, until: HOUR + 15 * MIN } }));
    const clock = { now: HOUR + 5 * MIN };
    const { diagnostics } = launch(storage, clock);
    await diagnostics.load();
    expect(diagnostics.coolingDown).toBe(true);

    // Forward past the deadline, then back inside it: expiry is irreversible.
    clock.now = HOUR + 1 * HOUR;
    expect(diagnostics.blocksAutomatic).toBe(false);
    clock.now = HOUR + 5 * MIN;
    expect(diagnostics.coolingDown).toBe(false);
    expect(diagnostics.blocksAutomatic).toBe(false);

    // The next write persists the end, so a reload under the stepped-back clock stays clear.
    await diagnostics.finishPass(await diagnostics.beginPass(), { result: RESULT });
    expect(storage.record().cooldown).toBeNull();
    const next = launch(storage, clock);
    expect(await next.diagnostics.load()).toEqual({ coolingDown: false, failure: null });
  });

  it("persists a cooldown's end at once, so a reload under a clock set back into it stays clear", async () => {
    const storage = new MemoryStorage();
    storage.files.set(PATH, legacyRecord({ streak: 3, cooldown: { since: HOUR, until: HOUR + 15 * MIN } }));
    const clock = { now: HOUR + 5 * MIN };
    const first = launch(storage, clock);
    await first.diagnostics.load();
    expect(first.diagnostics.coolingDown).toBe(true);

    clock.now = HOUR + 20 * MIN;
    expect(first.diagnostics.blocksAutomatic).toBe(false);
    await flush();
    expect(storage.record().cooldown).toBeNull();
    expect(storage.record().streak).toBe(3); // nothing settled; only the wait ended

    // Unloaded with no pass and no Resume, the clock set back into the old window, reloaded.
    first.diagnostics.retire();
    clock.now = HOUR + 5 * MIN;
    const reloaded = launch(storage, clock);
    expect(await reloaded.diagnostics.load()).toEqual({ coolingDown: false, failure: null });
  });

  it("persists an end found at load, and keeps memory cleared when that write fails", async () => {
    const storage = new MemoryStorage();
    storage.files.set(PATH, legacyRecord({ streak: 3, cooldown: { since: HOUR, until: HOUR + 15 * MIN } }));
    const clock = { now: 2 * HOUR };
    await launch(storage, clock).diagnostics.load();
    await flush();
    expect(storage.record().cooldown).toBeNull();

    storage.files.set(PATH, legacyRecord({ streak: 3, cooldown: { since: HOUR, until: HOUR + 15 * MIN } }));
    storage.failWrite = new Error("read-only");
    const failing = launch(storage, clock);
    expect(await failing.diagnostics.load()).toEqual({ coolingDown: false, failure: null });
    await flush();
    expect(failing.failures).toEqual(["write"]);
    clock.now = HOUR + 5 * MIN;
    expect(failing.diagnostics.coolingDown).toBe(false);
  });

  it("ends a cooldown when the clock reads before it began, and a later forward step does not revive it", async () => {
    const storage = new MemoryStorage();
    storage.files.set(PATH, legacyRecord({ streak: 3, cooldown: { since: HOUR, until: HOUR + 15 * MIN } }));
    const clock = { now: HOUR - 5_000 };
    const { diagnostics } = launch(storage, clock);
    expect(await diagnostics.load()).toEqual({ coolingDown: false, failure: null });
    clock.now = HOUR + MIN;
    expect(diagnostics.coolingDown).toBe(false);
    expect(diagnostics.cooldownRemainingMs).toBe(0);
  });

  it("lets a backward step inside a live cooldown lengthen it by no more than the step (stated limitation)", async () => {
    const storage = new MemoryStorage();
    storage.files.set(PATH, legacyRecord({ streak: 3, cooldown: { since: HOUR, until: HOUR + 15 * MIN } }));
    const clock = { now: HOUR + 10 * MIN };
    const { diagnostics } = launch(storage, clock);
    await diagnostics.load();
    expect(diagnostics.cooldownRemainingMs).toBe(5 * MIN);
    clock.now = HOUR + 2 * MIN; // stepped back 8 minutes, still after `since`
    expect(diagnostics.cooldownRemainingMs).toBe(13 * MIN);
  });

  it.each([
    ["completed", { result: RESULT }],
    ["failed", { error: new ApiError("synthetic", 500) }],
  ] as const)("a %s pass resets the streak and ends the cooldown in the write that clears its marker", async (_kind, outcome) => {
    const storage = new MemoryStorage();
    storage.files.set(PATH, legacyRecord({ streak: 2, active: { startedAt: 5, phase: "scan", phaseAt: 6 } }));
    const clock = { now: HOUR };
    const { diagnostics } = launch(storage, clock);
    await diagnostics.load();
    expect(diagnostics.coolingDown).toBe(true);

    // A manual pass runs through the cooldown; starting it changes nothing.
    const pass = await diagnostics.beginPass();
    expect(storage.record().streak).toBe(3);
    expect(storage.record().cooldown).not.toBeNull();
    const writes = storage.writes.length;
    await diagnostics.finishPass(pass, outcome);

    expect(storage.writes.length).toBe(writes + 1);
    const settled = storage.record();
    expect(settled.active).toBeNull();
    expect(settled.streak).toBe(0);
    expect(settled.cooldown).toBeNull();
    expect(settled.lastInterrupted?.pass.phase).toBe("scan");
    expect(diagnostics.blocksAutomatic).toBe(false);

    const next = launch(storage, clock);
    expect(await next.diagnostics.load()).toEqual({ coolingDown: false, failure: null });
  });

  it("does not let a stale pass reset the streak", async () => {
    const storage = new MemoryStorage();
    storage.files.set(PATH, legacyRecord({ streak: 2, active: { startedAt: 5, phase: "scan", phaseAt: 6 } }));
    const clock = { now: HOUR };
    const { diagnostics } = launch(storage, clock);
    await diagnostics.load();
    const old = await diagnostics.beginPass();
    const current = await diagnostics.beginPass();
    await diagnostics.finishPass(old, { result: RESULT });
    expect(storage.record().streak).toBe(3);
    expect(diagnostics.coolingDown).toBe(true);
    await diagnostics.finishPass(current, { result: RESULT });
    expect(storage.record().streak).toBe(0);
  });

  it("lifts a 1.1.4–1.1.6 pause as one interruption already counted", async () => {
    const interrupted = { startedAt: 5, phase: "merge", phaseAt: 6 };
    const storage = new MemoryStorage();
    storage.files.set(PATH, legacyRecord({ paused: { since: 7, interrupted } }));
    const { diagnostics, cooldowns } = launch(storage, { now: HOUR });
    expect(await diagnostics.load()).toEqual({ coolingDown: false, failure: null });
    const lifted = storage.record();
    expect(lifted.paused).toBeNull();
    expect(lifted.streak).toBe(1);
    expect(lifted.cooldown).toBeNull();
    expect(lifted.lastInterrupted).toEqual({ detectedAt: 7, pass: interrupted });
    expect(lifted.trace.at(-1)?.event).toBe("plugin-load");
    expect(cooldowns).toEqual([]);
    expect(diagnostics.blocksAutomatic).toBe(false);
  });

  it("counts a 1.1.4–1.1.6 pause with an active marker as two, still without a cooldown", async () => {
    const storage = new MemoryStorage();
    storage.files.set(PATH, legacyRecord({
      paused: { since: 7, interrupted: { startedAt: 5, phase: "merge", phaseAt: 6 } },
      active: { startedAt: 8, phase: "upload", phaseAt: 9 },
    }));
    const { diagnostics, cooldowns } = launch(storage, { now: HOUR });
    await diagnostics.load();
    const lifted = storage.record();
    expect(lifted.paused).toBeNull();
    expect(lifted.active).toBeNull();
    expect(lifted.streak).toBe(2);
    expect(lifted.cooldown).toBeNull();
    expect(lifted.lastInterrupted).toEqual({ detectedAt: HOUR, pass: { startedAt: 8, phase: "upload", phaseAt: 9 } });
    expect(cooldowns).toEqual([]);
    expect(diagnostics.blocksAutomatic).toBe(false);
  });

  it.each([[-1], [1.5], ["2"], [null], [Number.MAX_SAFE_INTEGER + 1]])(
    "treats a present but invalid streak (%s) as unreadable, never as a legacy record",
    async (streak) => {
      const raw = legacyRecord({ streak, paused: { since: 7, interrupted: { startedAt: 5, phase: "merge", phaseAt: 6 } } });
      expect(parseRecord(raw)).toBeNull();
      const storage = new MemoryStorage();
      storage.files.set(PATH, raw);
      const { diagnostics, failures } = launch(storage, { now: HOUR });
      expect(await diagnostics.load()).toEqual({ coolingDown: false, failure: "parse" });
      expect(diagnostics.blocksAutomatic).toBe(true);
      expect(failures).toEqual(["parse"]);
      expect(storage.files.get(PATH)).toBe(raw);
    }
  );

  // Rolling back to 1.1.6 must not find an unreadable record: that stops automatic sync there
  // and refuses Sync now until Resume sets the record aside (sol review, 2026-10-13).
  it("writes records that 1.1.6 still reads: after a continued interruption, a legacy lift, a cooldown and a reset", async () => {
    const written: [string, string][] = [];
    const clock = { now: HOUR };
    const capture = (label: string, storage: MemoryStorage) => written.push([label, storage.files.get(PATH)!]);

    const continued = new MemoryStorage();
    await killedPass(continued, clock);
    await launch(continued, clock).diagnostics.load();
    expect(continued.record().streak).toBe(1);
    capture("streak 1", continued);

    const legacy = new MemoryStorage();
    legacy.files.set(PATH, legacyRecord({
      paused: { since: 7, interrupted: { startedAt: 5, phase: "merge", phaseAt: 6 } },
      active: { startedAt: 8, phase: "upload", phaseAt: 9 },
    }));
    await launch(legacy, clock).diagnostics.load();
    expect(legacy.record().streak).toBe(2);
    capture("legacy migration", legacy);

    const cooling = new MemoryStorage();
    cooling.files.set(PATH, legacyRecord({ streak: 2, active: { startedAt: 5, phase: "scan", phaseAt: 6 } }));
    const { diagnostics } = launch(cooling, clock);
    await diagnostics.load();
    expect(diagnostics.coolingDown).toBe(true);
    capture("cooldown", cooling);
    const pass = await diagnostics.beginPass();
    await diagnostics.checkpoint(pass, "save");
    capture("a pass running in a cooldown", cooling);
    await diagnostics.finishPass(pass, { result: RESULT });
    capture("reset", cooling);
    expect(await diagnostics.resume()).toBe(true);
    capture("resumed", cooling);

    for (const [label, raw] of written) {
      expect(parseRecord116(raw), label).not.toBeNull();
      // And the 1.1.6 load itself, which is what a rolled-back device runs. (A record with a
      // running pass's marker is paused there, as 1.1.6 pauses any interruption; readable is
      // the property that matters.)
      const storage = new MemoryStorage();
      storage.files.set(PATH, raw);
      const rolledBack = new SyncDiagnostics116({ storage, path: PATH, pluginVersion: "1.1.6", platform: "ios-mobile" });
      expect((await rolledBack.load()).failure, label).toBeNull();
    }
  });

  it("does not count an interruption it could not persist, and counts it once when it can", async () => {
    const storage = new MemoryStorage();
    storage.files.set(PATH, legacyRecord({ streak: 2, active: { startedAt: 5, phase: "scan", phaseAt: 6 } }));
    const raw = storage.files.get(PATH);
    storage.failWrite = new Error("read-only");
    const { diagnostics, cooldowns, failures } = launch(storage, { now: HOUR });
    expect((await diagnostics.load()).failure).toBe("write");
    expect(diagnostics.blocksAutomatic).toBe(true);
    expect(failures).toEqual(["write"]);
    expect(cooldowns).toEqual([]);
    expect(storage.files.get(PATH)).toBe(raw);

    storage.failWrite = null;
    expect(await diagnostics.resume()).toBe(false); // the recovered cooldown is shown first
    expect(storage.record().streak).toBe(3);
    expect(cooldowns).toEqual([[3, 15 * MIN]]);
    expect(diagnostics.coolingDown).toBe(true);
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
