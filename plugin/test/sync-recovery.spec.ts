import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LogSyncPlugin, {
  RECOVERY_LOG_FAILED_NOTICE,
  RECOVERY_LOG_FAILED_STATUS,
  RECOVERY_PAUSED_STATUS,
  RESUME_AFTER_LOG_FAILURE_DESC,
  RESUME_AUTOMATIC_DESC,
  RESUME_AUTOMATIC_LABEL,
  recoveryCooldownNotice,
  type Settings,
} from "../src/main";
import {
  DIAGNOSTIC_SCHEMA,
  TRACE_LIMIT,
  cooldownMs,
  parseRecord,
  type DiagnosticRecord,
} from "../src/sync-diagnostics";
import {
  type FakeElement,
  LifecycleApp,
  Modal,
  Notice,
  Platform,
  requestUrlMock,
} from "./obsidian-fake";

/**
 * Sync recovery after an interrupted pass, driven through the real plugin, scheduler and engine.
 *
 * PIN (lead assignment 2026-09-25, docs/260925-fix-IPHONE_SYNC_RECOVERY_PLAN.md): every
 * scheduled pass persists an active marker before it does any work and clears it only once it
 * settles. A pass that settled (result or error) is never reported as interrupted. A recovery
 * record that cannot be read or written stops automatic sync and says so.
 *
 * PIN (owner 2026-10-13, docs/261013-fix-AUTO_CONTINUE_AFTER_INTERRUPTED_SYNC.md): a load
 * that finds a marker left behind counts it once into a persisted streak. One or two in a row
 * continue automatically and silently. The third holds ALL automatic sync — startup, timer,
 * mobile resume and file events — for a cooldown (15 minutes doubling to 4 hours) that ends by
 * itself, across rebuilds and restarts. Manual Sync now runs through it (consent-gated), and
 * any settled pass resets the streak. Resume is an optional override, never required.
 *
 * All fixtures are synthetic: file names, server and token below are made up.
 */

// --- environment ------------------------------------------------------------------------

interface FakeTimer {
  id: number;
  fn: () => void;
  ms: number;
  kind: "interval" | "timeout";
  cleared: boolean;
}

let windowTimers: FakeTimer[] = [];
let nextTimerId = 1;

function installGlobals(): void {
  windowTimers = [];
  const make =
    (kind: FakeTimer["kind"]) =>
    (fn: () => void, ms: number): number => {
      const id = nextTimerId++;
      windowTimers.push({ id, fn, ms, kind, cleared: false });
      return id;
    };
  const clear = (id: number): void => {
    const timer = windowTimers.find((t) => t.id === id);
    if (timer !== undefined) timer.cleared = true;
  };
  // A one-shot timeout is recorded AND runs on vitest's fake clock, so a test advancing time
  // sees it fire exactly as the app would; intervals stay manual (tests fire them by hand).
  const timeout = (fn: () => void, ms: number): number => {
    const id = make("timeout")(fn, ms);
    const timer = windowTimers.find((t) => t.id === id)!;
    globalThis.setTimeout(() => {
      if (!timer.cleared) fn();
    }, ms);
    return id;
  };
  const win = {
    setInterval: make("interval"),
    clearInterval: clear,
    setTimeout: timeout,
    clearTimeout: clear,
  };
  Object.assign(globalThis, { window: win, document: { visibilityState: "visible" } });
}

/**
 * This test's server. Each test gets its own host, because `requestUrlMock` is one global: a
 * pass a previous test left running would otherwise carry on against whichever server the
 * newest `boot()` installed — committing there, so this test's device found a head it never
 * wrote and failed its pass (the 1.1.7 Release run). The URL is the only thing a request
 * carries that says which device sent it, so it is what the fence checks.
 */
let SERVER = "https://synthetic-vault-0.example.workers.dev";
let testSerial = 0;
/** Which test each server host belonged to, so a stray request names the test that leaked. */
const serverOwners = new Map<string, string>();

/**
 * Requests that reached this test from a pass started in an earlier one. Each is answered
 * with a promise that never settles, as for a killed process, so the stray pass stops where
 * it is and touches nothing here; `afterEach` then fails the run naming the test it came from.
 */
let strays: string[] = [];

function stray(url: string): Promise<never> {
  const host = /^https:\/\/[^/]+/.exec(url)?.[0] ?? url;
  strays.push(`${serverOwners.get(host) ?? host} -> ${url.slice(host.length)}`);
  return new Promise<never>(() => {});
}
const TOKEN = "synthetic-access-token-0123";
const RECORD_PATH = ".obsidian/plugins/cloudflare-rdo-sync/sync-recovery.json";
const UNREADABLE_PATH = ".obsidian/plugins/cloudflare-rdo-sync/sync-recovery.unreadable.txt";
const PATHS = ["alpha-note.md", "beta-note.md", "gamma/delta-note.md"];
const DEBOUNCE_MS = 5000;
const INTERVAL_MINUTES = 3;

const text = (path: string, version = 1) => new TextEncoder().encode(`${path} v${version}\n`);

interface CountingVault {
  lists: number;
  reads: string[];
  content: Map<string, Uint8Array>;
}

/** A synthetic vault that records every listing and read a pass makes. */
function countingVault(app: LifecycleApp): CountingVault {
  const vault: CountingVault = {
    lists: 0,
    reads: [],
    content: new Map(PATHS.map((p) => [p, text(p)])),
  };
  app.vault.adapter = {
    list: async (dir: string) => {
      vault.lists++;
      if (dir !== "" && dir !== "/") return { files: [], folders: [] };
      return { files: [...vault.content.keys()], folders: [] };
    },
    stat: async (path: string) => {
      const bytes = vault.content.get(path);
      return bytes === undefined ? null : { type: "file", size: bytes.byteLength, mtime: 1 };
    },
    readBinary: async (path: string) => {
      vault.reads.push(path);
      return vault.content.get(path)!.slice().buffer;
    },
  } as never;
  return vault;
}

interface ServerControl {
  /** While set, `/api/head` waits on it: the pass is "running" for as long as the test likes. */
  hold: Promise<void> | null;
  /** Called with the recovery record as it stood when each head request arrived. */
  onHead: ((record: string | undefined) => void) | null;
  headStatus: number;
  /** While set, `/api/commit` waits on it: a pass is held mid-commit. */
  commitHold: Promise<void> | null;
}

/**
 * Serves only this device's own commits, so a pass never has anything to pull. It starts at
 * the head the launch last synced: a reload is the same device against the same vault, so a
 * relaunch after a commit must not find the server rolled back to a head it moved past.
 */
function steadyServer(app: LifecycleApp, startHead: string): ServerControl {
  const control: ServerControl = { hold: null, onHead: null, headStatus: 200, commitHold: null };
  let head = startHead;
  let commits = 0;
  const own = `${SERVER}/`;
  requestUrlMock.impl = async (req) => {
    const url = (req as { url: string }).url;
    if (!url.startsWith(own)) return await stray(url);
    if (url.endsWith("/api/head")) {
      control.onHead?.(app.vault.configFiles.get(RECORD_PATH));
      if (control.hold !== null) await control.hold;
      if (control.headStatus !== 200) {
        return { status: control.headStatus, text: "{}", json: { error: { code: "x", message: `down at ${SERVER}` } } };
      }
      return { status: 200, text: "", json: { head } };
    }
    if (url.endsWith("/api/settings")) {
      return { status: 404, text: "{}", json: { error: { code: "not_found", message: "none" } } };
    }
    if (url.endsWith("/api/blobs/check")) return { status: 200, text: "", json: { missing: [] } };
    if (url.endsWith("/api/commit")) {
      if (control.commitHold !== null) await control.commitHold;
      head = `01NEXT${++commits}`;
      return { status: 200, text: "", json: { head } };
    }
    throw new Error(`unexpected request: ${url}`);
  };
  return control;
}

/** Requests this test's devices made; a stray from an earlier test is not one of them. */
const ownCalls = () =>
  requestUrlMock.calls.filter((c) => (c as { url: string }).url.startsWith(`${SERVER}/`));
const headCalls = () => ownCalls().filter((c) => (c as { url: string }).url.endsWith("/api/head")).length;
const commitCalls = () => ownCalls().filter((c) => (c as { url: string }).url.endsWith("/api/commit")).length;

function settings(over: Partial<Settings> = {}): Partial<Settings> {
  return {
    serverUrl: SERVER,
    accessToken: TOKEN,
    encryptionMode: "plaintext",
    firstSyncAcknowledged: true,
    retryAttempts: 0,
    syncSettings: false,
    debounceSeconds: DEBOUNCE_MS / 1000,
    intervalMinutes: INTERVAL_MINUTES,
    resumeSyncMinutes: 1,
    syncOnStartup: true,
    mobileStatusBar: false,
    logNoteFolder: "",
    ...over,
  };
}

function data(over: Partial<Settings> = {}, extra: Record<string, unknown> = {}): unknown {
  return {
    settings: settings(over),
    state: { lastSyncedHead: "01HEAD", files: {}, keyId: null, lines: {} },
    stateServerUrl: SERVER,
    ...extra,
  };
}

interface Device {
  plugin: LogSyncPlugin;
  app: LifecycleApp;
  vault: CountingVault;
  server: ServerControl;
}

/**
 * One launch of the plugin. `disk` is this plugin's folder as the launch finds it; `dataJson`
 * is what `loadData()` returns. A reload passes the previous launch's own map (same disk); a
 * killed process is modelled by copying it at the moment of death.
 */
function boot(dataJson: unknown, disk = new Map<string, string>(), manifest: Record<string, unknown> = {}): Device {
  const app = new LifecycleApp();
  app.vault.configFiles = disk;
  const plugin = new LogSyncPlugin(app as never, {
    id: "cloudflare-rdo-sync",
    name: "R2DO Sync",
    version: "1.1.3",
    ...manifest,
  } as never);
  (plugin as unknown as { persisted: unknown }).persisted = dataJson;
  const vault = countingVault(app);
  const synced = (dataJson as { state?: { lastSyncedHead?: string | null } } | null)?.state?.lastSyncedHead;
  const server = steadyServer(app, synced ?? "01HEAD");
  return { plugin, app, vault, server };
}

/** What `saveData()` last wrote, i.e. the `data.json` the next launch loads. */
function dataJsonOf(device: Device): unknown {
  return JSON.parse(JSON.stringify((device.plugin as unknown as { persisted: unknown }).persisted));
}

function record(disk: Map<string, string>): DiagnosticRecord {
  const raw = disk.get(RECORD_PATH);
  expect(raw).toBeDefined();
  return JSON.parse(raw!) as DiagnosticRecord;
}

/** The record, or null before its first write — for polling. */
function recordOrNull(disk: Map<string, string>): DiagnosticRecord | null {
  const raw = disk.get(RECORD_PATH);
  return raw === undefined ? null : (JSON.parse(raw) as DiagnosticRecord);
}

type StoredRecord = Omit<DiagnosticRecord, "streak" | "cooldown" | "lastInterrupted"> &
  Partial<Pick<DiagnosticRecord, "streak" | "cooldown" | "lastInterrupted">>;

/** A record as 1.1.4–1.1.6 wrote it — no streak — unless `over` adds the newer fields. */
function storedRecovery(over: Partial<DiagnosticRecord> = {}): StoredRecord {
  return {
    schema: DIAGNOSTIC_SCHEMA,
    pluginVersion: "1.1.4",
    platform: "ios-mobile",
    active: null,
    paused: null,
    lastCompleted: null,
    lastFailed: null,
    trace: [{ at: 10, event: "head" }],
    ...over,
  };
}

function statusText(device: Device): string {
  return (device.plugin as unknown as { statusBarItems: FakeElement[] }).statusBarItems[0].text;
}

async function elapse(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(1);
}

/** The real `setTimeout`, captured before any test fakes it. */
const realSetTimeout = globalThis.setTimeout;

/** How long `until` waits in real time before it calls a condition unreachable. */
const UNTIL_BUDGET_MS = 15_000;
// Every test here may wait out a full `until` budget, so the test timeout sits explicitly
// above it rather than leaving the budget to squeeze in under vitest's 5 s default.
vi.setConfig({ testTimeout: 2 * UNTIL_BUDGET_MS });

/**
 * Waits for a condition the app reaches on its own time. Fake time advances at most 200 ms (a
 * debounce or retry timer is never fired by accident); real time is yielded as well, for up
 * to `UNTIL_BUDGET_MS`, because a pass awaits real macrotasks — WebCrypto digests — that no
 * fake-timer tick can hurry. A slow runner needs more of them, which is why no assertion that
 * a pass ran may follow a fixed number of ticks (AGENTS.md, "UI and testing gotchas").
 *
 * A pass a test starts must also have settled by the time the test ends: `headCalls()`
 * reaching a count says the pass has begun, not that it is over.
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  const started = performance.now();
  for (let fakeMs = 0; !condition() && performance.now() - started < UNTIL_BUDGET_MS; fakeMs++) {
    await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
    await vi.advanceTimersByTimeAsync(fakeMs < 200 ? 1 : 0);
  }
  if (!condition()) throw new Error(`timed out waiting for ${what}`);
}

/**
 * Passes that completed successfully on `device`, read from the record writes it made: each
 * is the write that took the active marker away with `pass-complete`. A pass that failed is
 * not counted, so waiting on this also asserts the pass succeeded.
 */
function completedPasses(device: Device): number {
  let completed = 0;
  let wasActive = false;
  for (const write of device.app.vault.configWrites) {
    const parsed = parseRecord(write.data);
    if (parsed === null) continue;
    if (wasActive && parsed.active === null && parsed.trace.at(-1)?.event === "pass-complete") completed++;
    wasActive = parsed.active !== null;
  }
  return completed;
}

function layoutReady(app: LifecycleApp): void {
  app.workspace.fireLayoutReady();
}

/** Every automatic source there is: startup, the periodic timer, mobile resume, file events. */
async function fireEveryAutomaticSource(device: Device): Promise<void> {
  const { plugin, app } = device;
  // The vault-load burst, then layout-ready (which runs startup sync when it is on).
  for (const path of PATHS) app.vault.fire("create", { path });
  layoutReady(app);
  await elapse(DEBOUNCE_MS * 2);
  const tick = windowTimers.find(
    (t) => t.kind === "interval" && !t.cleared && t.ms === INTERVAL_MINUTES * 60_000
  );
  expect(tick).toBeDefined();
  tick!.fn();
  const resume = (plugin as unknown as { domEvents: { type: string; handler: () => void }[] })
    .domEvents.find((e) => e.type === "visibilitychange");
  expect(resume).toBeDefined();
  resume!.handler();
  device.vault.content.set(PATHS[0], text(PATHS[0], 2));
  app.vault.fire("modify", { path: PATHS[0] });
  app.vault.fire("create", { path: "new-note.md" });
  app.vault.fire("rename", { path: PATHS[1] }, "old-name.md");
  await elapse(DEBOUNCE_MS * 4);
}

/**
 * Lets a loaded `device` start its startup pass, and kills the process while the pass waits on
 * the server. Asserts the pass got that far: automatic sync was not held.
 */
async function killMidPass(device: Device): Promise<{ disk: Map<string, string>; dataJson: unknown }> {
  device.server.hold = new Promise<void>(() => {});
  layoutReady(device.app);
  await until(() => headCalls() === 1, "the startup pass to reach the server");
  // The process dies here: whatever is on disk now is what the next launch finds. No
  // onunload, no settle. The held request is never released, as for a killed process: a
  // released dead pass would carry on through the global `requestUrlMock`, which the next
  // `boot()` points at the new device's server, and commit there (seen on the CI runner).
  const disk = new Map(device.app.vault.configFiles);
  const dataJson = dataJsonOf(device);
  expect(record(disk).active).not.toBeNull();
  device.plugin.onunload();
  await elapse(10);
  requestUrlMock.calls.length = 0;
  Notice.shown.length = 0;
  return { disk, dataJson };
}

/** Launches, starts the startup pass and kills the process while the pass waits on the server. */
async function launchAndKillMidPass(): Promise<{ disk: Map<string, string>; dataJson: unknown }> {
  const first = boot(data());
  await first.plugin.onload();
  return await killMidPass(first);
}

const INTERRUPTED = { startedAt: 8, phase: "scan" as const, phaseAt: 9 };

/** A launch that finds a third interruption in a row on disk, so it starts a cooldown. */
async function launchCoolingDown(
  over: Partial<Settings> = {},
  extra: Record<string, unknown> = {}
): Promise<{ device: Device; disk: Map<string, string> }> {
  const disk = new Map([[RECORD_PATH, JSON.stringify(storedRecovery({ streak: 2, active: INTERRUPTED }))]]);
  const device = boot(data(over, extra), disk);
  await device.plugin.onload();
  expect(record(disk).streak).toBe(3);
  return { device, disk };
}

/** Every notice about passes that did not finish (the cooldown notice is the only one). */
const cooldownNotices = () => Notice.shown.filter((n) => n.includes("did not finish"));

/** Fake `Date` too, so advancing timers moves the clock the cooldown is measured on. */
function fakeClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
}

/** The newest launch's status refresh (earlier launches' intervals are never cleared here). */
const statusRefresh = (): FakeTimer => {
  const timer = [...windowTimers].reverse().find((t) => t.kind === "interval" && !t.cleared && t.ms === 30_000);
  expect(timer).toBeDefined();
  return timer!;
};

beforeEach(() => {
  installGlobals();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  Notice.shown.length = 0;
  Modal.shown.length = 0;
  SERVER = `https://synthetic-vault-${++testSerial}.example.workers.dev`;
  serverOwners.set(SERVER, expect.getState().currentTestName ?? SERVER);
  strays = [];
  // Until this test boots a device, every request is a stray.
  requestUrlMock.impl = async (req) => await stray((req as { url: string }).url);
  requestUrlMock.calls.length = 0;
  Platform.isMobile = true;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Platform.isMobile = false;
  // A pass an earlier test left running reached this one. It was stopped at the fence, so
  // nothing here was affected — but the test named here ended before its pass did, and must
  // wait for it to settle. Checked last, so the teardown above still runs.
  if (strays.length > 0) throw new Error(`a pass outlived its test and reached this one: ${strays.join("; ")}`);
});

// --- marking ----------------------------------------------------------------------------

describe("active marker around every scheduled pass", () => {
  it("is on disk before the pass makes its first request, and cleared as completed once it settles", async () => {
    const device = boot(data());
    const seen: (string | undefined)[] = [];
    device.server.onHead = (raw) => seen.push(raw);
    await device.plugin.onload();
    expect(device.app.vault.configWrites).toEqual([]); // an absent record is normal: no write

    layoutReady(device.app);
    await until(
      () => recordOrNull(device.app.vault.configFiles)?.lastCompleted != null,
      "the pass to settle"
    );

    // Before heavy work: the first request found the marker already persisted.
    expect(seen).toHaveLength(1);
    const atHead = JSON.parse(seen[0]!) as DiagnosticRecord;
    expect(atHead.active).not.toBeNull();
    expect(atHead.active!.phase).toBe("head");

    const done = record(device.app.vault.configFiles);
    expect(done.schema).toBe(DIAGNOSTIC_SCHEMA);
    expect(done.pluginVersion).toBe("1.1.3");
    expect(done.platform).toMatch(/-mobile$/);
    expect(done.active).toBeNull();
    expect(done.paused).toBeNull();
    expect(done.streak).toBe(0);
    expect(done.cooldown).toBeNull();
    expect(done.lastCompleted?.status).toBe("committed");
    expect(done.lastFailed).toBeNull();
    expect(done.trace.map((t) => t.event)).toEqual([
      "plugin-load",
      "pass-start",
      "head",
      "scan",
      "upload",
      "commit",
      "save",
      "pass-complete",
    ]);
    // The data file is not where this lives.
    expect(JSON.stringify(dataJsonOf(device))).not.toContain(DIAGNOSTIC_SCHEMA);
  });

  it("marks passes from file events, the timer, manual sync and retries alike", async () => {
    const device = boot(data({ syncOnStartup: false, retryAttempts: 1 }));
    await device.plugin.onload();
    layoutReady(device.app);
    const starts = () =>
      device.app.vault.configWrites.filter((w) =>
        (JSON.parse(w.data) as DiagnosticRecord).trace.at(-1)?.event === "pass-start"
      ).length;

    // Each trigger waits for the previous pass to settle: a request made while one is in
    // flight is answered by that pass (the scheduler coalesces), not by a pass of its own.
    device.vault.content.set(PATHS[0], text(PATHS[0], 2));
    device.app.vault.fire("modify", { path: PATHS[0] });
    await elapse(DEBOUNCE_MS * 2);
    await until(() => completedPasses(device) === 1, "the file-event pass to complete");
    expect(headCalls()).toBe(1);
    expect(starts()).toBe(1);

    windowTimers.find((t) => t.kind === "interval" && t.ms === INTERVAL_MINUTES * 60_000)!.fn();
    await until(() => completedPasses(device) === 2, "the timer pass to complete");
    expect(headCalls()).toBe(2);
    expect(starts()).toBe(2);

    await device.plugin.syncNow();
    expect(headCalls()).toBe(3);
    expect(starts()).toBe(3);

    // A retryable failure, then success: each attempt is its own marked pass.
    device.server.headStatus = 503;
    const retried = device.plugin.syncNow();
    await until(() => headCalls() === 4, "the failing attempt");
    device.server.headStatus = 200;
    await elapse(2000);
    await retried;
    expect(headCalls()).toBe(5);
    expect(starts()).toBe(5);
    const final = record(device.app.vault.configFiles);
    expect(final.active).toBeNull();
    expect(final.lastFailed?.error).toBe("http-503");
    // The retried attempt found nothing new to publish, and settled as such.
    expect(final.lastCompleted?.status).toBe("unchanged");
  });

  it("records a pass that failed as failed, not as interrupted, and the next launch runs normally", async () => {
    const device = boot(data());
    device.server.headStatus = 500;
    await device.plugin.onload();
    layoutReady(device.app);
    await until(
      () => recordOrNull(device.app.vault.configFiles)?.lastFailed != null,
      "the failure to be recorded"
    );

    const failed = record(device.app.vault.configFiles);
    expect(failed.active).toBeNull();
    expect(failed.lastFailed?.error).toBe("http-500");
    expect(failed.trace.at(-1)?.event).toBe("pass-failed");
    // No raw error message or URL reaches the record.
    expect(device.app.vault.configFiles.get(RECORD_PATH)).not.toContain(SERVER);
    expect(device.app.vault.configFiles.get(RECORD_PATH)).not.toContain("down at");

    device.plugin.onunload();
    requestUrlMock.calls.length = 0;
    const next = boot(dataJsonOf(device), device.app.vault.configFiles);
    await next.plugin.onload();
    expect(cooldownNotices()).toEqual([]);
    expect(record(next.app.vault.configFiles).streak).toBe(0);
    expect(next.plugin.automaticSyncPaused).toBe(false);
    layoutReady(next.app);
    await until(() => completedPasses(next) === 1, "the startup pass to complete");
    expect(headCalls()).toBe(1);
  });

  it("keeps the record free of file names, the server URL and the access token", async () => {
    const device = boot(data());
    await device.plugin.onload();
    layoutReady(device.app);
    await until(() => recordOrNull(device.app.vault.configFiles)?.lastCompleted != null, "the pass");
    for (const write of device.app.vault.configWrites) {
      for (const secret of [...PATHS, "alpha", SERVER, "example.workers.dev", TOKEN, "01HEAD", "01NEXT"]) {
        expect(write.data).not.toContain(secret);
      }
    }
  });

  it("uses manifest.dir when Obsidian supplies it", async () => {
    const device = boot(data(), new Map(), { dir: ".obsidian/plugins/renamed-folder" });
    await device.plugin.onload();
    layoutReady(device.app);
    await until(() => completedPasses(device) === 1, "the startup pass to complete");
    expect(device.app.vault.configWrites.every((w) => w.path === ".obsidian/plugins/renamed-folder/sync-recovery.json")).toBe(true);
  });
});

// --- interrupted passes: continue, then cool down ----------------------------------------

describe("a pass that never settled", () => {
  it("words the cooldown exactly as the owner wrote it, for every wait it can give", () => {
    expect([3, 4, 5, 6, 7, 12].map((n) => recoveryCooldownNotice(n, cooldownMs(n)))).toEqual([
      "R2DO Sync: the last 3 syncs did not finish, so automatic sync waits 15 minutes before trying again. Sync now still runs one right away.",
      "R2DO Sync: the last 4 syncs did not finish, so automatic sync waits 30 minutes before trying again. Sync now still runs one right away.",
      "R2DO Sync: the last 5 syncs did not finish, so automatic sync waits 1 hour before trying again. Sync now still runs one right away.",
      "R2DO Sync: the last 6 syncs did not finish, so automatic sync waits 2 hours before trying again. Sync now still runs one right away.",
      "R2DO Sync: the last 7 syncs did not finish, so automatic sync waits 4 hours before trying again. Sync now still runs one right away.",
      "R2DO Sync: the last 12 syncs did not finish, so automatic sync waits 4 hours before trying again. Sync now still runs one right away.",
    ]);
    expect(RECOVERY_PAUSED_STATUS).toBe("automatic sync waiting");
    expect(RESUME_AUTOMATIC_DESC).toBe(
      "Several syncs in a row did not finish, so automatic sync is waiting before it tries again. Resume lets startup, timer and file-change sync run now."
    );
    expect(RESUME_AUTOMATIC_LABEL).toBe("Resume automatic sync");
  });

  // PIN: owner 2026-10-13 — an interrupted sync continues automatically; the settings Resume button is never required (docs/261013-fix-AUTO_CONTINUE_AFTER_INTERRUPTED_SYNC.md)
  it("continues after one and two interruptions, waits after the third, and the wait ends by itself", async () => {
    fakeClock();
    let { disk, dataJson } = await launchAndKillMidPass();

    // First interruption: counted and persisted before any trigger exists, silent, not held —
    // the startup pass runs (and is killed again, inside `killMidPass`).
    let device = boot(dataJson, disk);
    await device.plugin.onload();
    expect(record(disk).streak).toBe(1);
    expect(record(disk).active).toBeNull();
    expect(record(disk).cooldown).toBeNull();
    expect(record(disk).trace.at(-1)?.event).toBe("plugin-load");
    expect(cooldownNotices()).toEqual([]);
    expect(device.plugin.automaticSyncPaused).toBe(false);
    expect(statusText(device)).not.toContain(RECOVERY_PAUSED_STATUS);
    ({ disk, dataJson } = await killMidPass(device));

    // Second in a row: the same.
    device = boot(dataJson, disk);
    await device.plugin.onload();
    expect(record(disk).streak).toBe(2);
    expect(record(disk).cooldown).toBeNull();
    expect(cooldownNotices()).toEqual([]);
    expect(device.plugin.automaticSyncPaused).toBe(false);
    ({ disk, dataJson } = await killMidPass(device));

    // Third in a row: a 15-minute cooldown, announced once, holding every automatic source.
    device = boot(dataJson, disk);
    await device.plugin.onload();
    const third = record(disk);
    expect(third.streak).toBe(3);
    expect(third.cooldown).not.toBeNull();
    expect(third.cooldown!.until - third.cooldown!.since).toBe(15 * 60_000);
    expect(third.trace.at(-1)?.event).toBe("recovery-paused");
    expect(cooldownNotices()).toEqual([
      "R2DO Sync: the last 3 syncs did not finish, so automatic sync waits 15 minutes before trying again. Sync now still runs one right away.",
    ]);
    expect(statusText(device)).toContain(RECOVERY_PAUSED_STATUS);
    await fireEveryAutomaticSource(device);
    expect(headCalls()).toBe(0);
    expect(ownCalls()).toEqual([]);
    expect(device.vault.reads).toEqual([]);
    expect(device.vault.lists).toBe(0);

    // From here nothing is fired by hand: only the clock and its timers advance. One
    // millisecond short of the deadline it still holds.
    await vi.advanceTimersByTimeAsync(third.cooldown!.until - Date.now() - 1);
    expect(headCalls()).toBe(0);
    expect(device.plugin.automaticSyncPaused).toBe(true);

    // At the deadline the pass the refused requests are owed runs by itself, settles, and
    // resets the streak. No Resume, no trigger.
    await until(() => record(disk).lastCompleted !== null && record(disk).active === null, "the owed pass");
    expect(headCalls()).toBe(1);
    expect(record(disk).streak).toBe(0);
    expect(record(disk).cooldown).toBeNull();
    expect(record(disk).trace.some((t) => t.event === "resumed")).toBe(false);
    expect(statusText(device)).not.toContain(RECOVERY_PAUSED_STATUS);
    // Owed once, run once.
    await elapse(DEBOUNCE_MS * 4);
    expect(headCalls()).toBe(1);
  });

  it("ends by itself with periodic sync off: an edit refused while waiting syncs at the deadline", async () => {
    fakeClock();
    const { device, disk } = await launchCoolingDown({ intervalMinutes: 0, syncOnStartup: false });
    layoutReady(device.app);
    expect(windowTimers.some((t) => t.kind === "interval" && t.ms === INTERVAL_MINUTES * 60_000)).toBe(false);

    device.vault.content.set(PATHS[0], text(PATHS[0], 2));
    device.app.vault.fire("modify", { path: PATHS[0] });
    await elapse(DEBOUNCE_MS * 2);
    expect(headCalls()).toBe(0);

    await vi.advanceTimersByTimeAsync(record(disk).cooldown!.until - Date.now() - 1);
    expect(headCalls()).toBe(0);
    await until(() => headCalls() === 1, "the owed pass at the deadline");
    await until(() => record(disk).lastCompleted !== null && record(disk).active === null, "it to settle");
    expect(device.vault.reads).toContain(PATHS[0]);
    expect(record(disk).lastCompleted?.status).toBe("committed");
    expect(record(disk).streak).toBe(0);
    expect(record(disk).cooldown).toBeNull();
    await elapse(DEBOUNCE_MS * 4);
    expect(headCalls()).toBe(1);
  });

  it("runs nothing at the deadline when the cooldown refused nothing", async () => {
    fakeClock();
    const { device, disk } = await launchCoolingDown({ intervalMinutes: 0, syncOnStartup: false });
    layoutReady(device.app);
    await vi.advanceTimersByTimeAsync(record(disk).cooldown!.until - Date.now() + 60_000);
    expect(headCalls()).toBe(0);
    statusRefresh().fn();
    expect(statusText(device)).not.toContain(RECOVERY_PAUSED_STATUS);
    expect(device.plugin.automaticSyncPaused).toBe(false);

    // The next ordinary trigger is simply allowed again.
    device.app.vault.fire("modify", { path: PATHS[0] });
    await elapse(DEBOUNCE_MS * 2);
    await until(() => completedPasses(device) === 1, "the file-event pass to complete");
    expect(headCalls()).toBe(1);
  });

  it("runs the owed pass on mobile resume when the deadline passed while timers were suspended", async () => {
    fakeClock();
    const { device, disk } = await launchCoolingDown({ intervalMinutes: 0, syncOnStartup: false });
    layoutReady(device.app);
    device.app.vault.fire("modify", { path: PATHS[0] });
    await elapse(DEBOUNCE_MS * 2);
    expect(headCalls()).toBe(0);

    // Suspended: the wall clock passes the deadline, the timers do not run.
    const deadline = record(disk).cooldown!.until;
    vi.setSystemTime(deadline + 60_000);
    expect(headCalls()).toBe(0);
    const resume = (device.plugin as unknown as { domEvents: { type: string; handler: () => void }[] })
      .domEvents.find((e) => e.type === "visibilitychange");
    resume!.handler(); // syncOnStartup is off: only the owed pass may answer this
    await until(() => record(disk).lastCompleted !== null && record(disk).active === null, "the owed pass");
    expect(headCalls()).toBe(1);

    // The one-shot timer, once it does run, owes nothing more.
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(headCalls()).toBe(1);
  });

  it("persists the end of a cooldown, so a reload under a clock set back into it is not held", async () => {
    fakeClock();
    const { device, disk } = await launchCoolingDown({ intervalMinutes: 0, syncOnStartup: false });
    layoutReady(device.app);
    const cooldown = record(disk).cooldown!;
    await vi.advanceTimersByTimeAsync(cooldown.until - Date.now() + 60_000);
    statusRefresh().fn(); // the app's own status refresh is what reads the cooldown here
    await until(() => record(disk).cooldown === null, "the cooldown's end on disk");
    expect(headCalls()).toBe(0);

    // Unloaded with no pass and no Resume; the clock is set back into the old window.
    device.plugin.onunload();
    vi.setSystemTime(cooldown.since + 5 * 60_000);
    const next = boot(dataJsonOf(device), disk);
    await next.plugin.onload();
    expect(next.plugin.automaticSyncPaused).toBe(false);
    expect(statusText(next)).not.toContain(RECOVERY_PAUSED_STATUS);
    expect(record(disk).streak).toBe(3);
  });

  it("still owes a pass for an edit refused while a manual pass through the cooldown is committing", async () => {
    fakeClock();
    const { device, disk } = await launchCoolingDown({ intervalMinutes: 0, syncOnStartup: false });
    layoutReady(device.app);
    const deadline = record(disk).cooldown!.until;
    let release!: () => void;
    device.server.commitHold = new Promise<void>((resolve) => (release = resolve));
    const manual = device.plugin.syncNow();
    await until(() => commitCalls() === 1, "the manual pass to reach its commit");

    // The edit arrives while that commit is held: the cooldown still stands, so it is refused,
    // and the pass already took its journal.
    device.vault.content.set(PATHS[1], text(PATHS[1], 2));
    device.app.vault.fire("modify", { path: PATHS[1] });
    await elapse(DEBOUNCE_MS * 2);
    expect(device.plugin.automaticSyncPaused).toBe(true);
    expect(headCalls()).toBe(1);
    const readsBefore = device.vault.reads.length;

    release();
    await manual;
    expect(record(disk).cooldown).toBeNull();
    // The cooldown ended with that pass; the edit's own pass follows at once, not at the deadline.
    await until(() => headCalls() === 2, "a pass for the refused edit");
    await until(() => record(disk).active === null && commitCalls() === 2, "it to commit");
    expect(Date.now()).toBeLessThan(deadline);
    expect(device.vault.reads.slice(readsBefore)).toContain(PATHS[1]);
    expect(record(disk).lastCompleted?.status).toBe("committed");
  });

  it("keeps the owed pass across a settings rebuild that spans the deadline", async () => {
    fakeClock();
    const { device, disk } = await launchCoolingDown({ intervalMinutes: 0, syncOnStartup: false });
    layoutReady(device.app);
    device.app.vault.fire("modify", { path: PATHS[0] });
    await elapse(DEBOUNCE_MS * 2);
    expect(headCalls()).toBe(0);
    const deadline = record(disk).cooldown!.until;

    // Hold the rebuild at its first await (the data save): no scheduler exists at the deadline.
    const plugin = device.plugin as unknown as { saveData(data: unknown): Promise<void> };
    const save = plugin.saveData.bind(plugin);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    plugin.saveData = async (data) => {
      await held;
      await save(data);
    };
    const rebuilding = device.plugin.saveSettings();
    await vi.advanceTimersByTimeAsync(deadline - Date.now() + 1_000);
    expect(headCalls()).toBe(0);

    plugin.saveData = save;
    release();
    await rebuilding;
    await until(() => headCalls() === 1, "the owed pass once the rebuild completes");
    await until(() => record(disk).active === null && record(disk).lastCompleted !== null, "it to settle");
  });

  it("does not count a reload without a new pass", async () => {
    const { disk, dataJson } = await launchAndKillMidPass();
    const first = boot(dataJson, disk);
    await first.plugin.onload();
    expect(record(disk).streak).toBe(1);
    const counted = record(disk).lastInterrupted;
    first.plugin.onunload(); // before layout-ready: no pass started

    const second = boot(dataJsonOf(first), disk);
    await second.plugin.onload();
    expect(record(disk).streak).toBe(1);
    expect(record(disk).lastInterrupted).toEqual(counted);
    expect(second.plugin.automaticSyncPaused).toBe(false);
  });

  it("keeps a cooldown across a settings rebuild and a restart, without announcing it again", async () => {
    const { device, disk } = await launchCoolingDown();
    expect(cooldownNotices()).toHaveLength(1);
    const cooldown = record(disk).cooldown;
    layoutReady(device.app);
    await device.plugin.saveSettings(); // rebuilds the engine and scheduler
    await fireEveryAutomaticSource(device);
    expect(headCalls()).toBe(0);
    expect(device.plugin.automaticSyncPaused).toBe(true);

    device.plugin.onunload();
    Notice.shown.length = 0;
    const next = boot(dataJsonOf(device), disk);
    await next.plugin.onload();
    expect(cooldownNotices()).toEqual([]);
    expect(record(disk).streak).toBe(3);
    expect(record(disk).cooldown).toEqual(cooldown);
    expect(next.plugin.automaticSyncPaused).toBe(true);
    expect(statusText(next)).toContain(RECOVERY_PAUSED_STATUS);
    await fireEveryAutomaticSource(next);
    expect(headCalls()).toBe(0);
  });

  it("lets Sync now run through the cooldown and end it, and that pass sees edits made while waiting", async () => {
    const { device, disk } = await launchCoolingDown();
    await fireEveryAutomaticSource(device);
    expect(headCalls()).toBe(0);

    await device.plugin.syncNow();

    expect(headCalls()).toBe(1);
    expect(device.vault.reads).toContain(PATHS[0]);
    const after = record(disk);
    expect(after.lastCompleted?.status).toBe("committed");
    expect(after.active).toBeNull();
    expect(after.streak).toBe(0);
    expect(after.cooldown).toBeNull();
    expect(device.plugin.automaticSyncPaused).toBe(false);
    expect(statusText(device)).not.toContain(RECOVERY_PAUSED_STATUS);

    device.vault.content.set(PATHS[2], text(PATHS[2], 3));
    device.app.vault.fire("modify", { path: PATHS[2] });
    await elapse(DEBOUNCE_MS * 2);
    await until(() => completedPasses(device) === 2, "the file-event pass to complete");
    expect(headCalls()).toBe(2);
  });

  it("ends the cooldown on a pass that failed with an error, which is not an interruption", async () => {
    const { device, disk } = await launchCoolingDown();
    layoutReady(device.app);
    device.server.headStatus = 500;
    await device.plugin.syncNow();

    const failed = record(disk);
    expect(failed.lastFailed?.error).toBe("http-500");
    expect(failed.active).toBeNull();
    expect(failed.streak).toBe(0);
    expect(failed.cooldown).toBeNull();
    expect(device.plugin.automaticSyncPaused).toBe(false);

    device.server.headStatus = 200;
    device.app.vault.fire("modify", { path: PATHS[2] });
    await elapse(DEBOUNCE_MS * 2);
    await until(() => completedPasses(device) === 1, "the file-event pass to complete");
    expect(headCalls()).toBe(2);
  });

  it("makes the next wait longer when a manual pass during the cooldown is interrupted", async () => {
    const { device, disk: live } = await launchCoolingDown();
    device.server.hold = new Promise<void>(() => {});
    void device.plugin.syncNow();
    await until(() => headCalls() === 1, "the manual pass to reach the server");
    // The process dies mid-pass.
    const disk = new Map(live);
    const dataJson = dataJsonOf(device);
    expect(record(disk).active).not.toBeNull();
    device.plugin.onunload();
    await elapse(10);
    requestUrlMock.calls.length = 0;
    Notice.shown.length = 0;

    const next = boot(dataJson, disk);
    await next.plugin.onload();
    const longer = record(disk);
    expect(longer.streak).toBe(4);
    expect(longer.cooldown!.until - longer.cooldown!.since).toBe(30 * 60_000);
    expect(cooldownNotices()).toEqual([
      "R2DO Sync: the last 4 syncs did not finish, so automatic sync waits 30 minutes before trying again. Sync now still runs one right away.",
    ]);
    await fireEveryAutomaticSource(next);
    expect(headCalls()).toBe(0);
  });

  it.each([
    ["a 1.1.4–1.1.6 pause", { paused: { since: 7, interrupted: INTERRUPTED } }, 1],
    ["a 1.1.4–1.1.6 pause with an active marker", { paused: { since: 7, interrupted: INTERRUPTED }, active: INTERRUPTED }, 2],
  ] as const)("lifts %s on load and syncs automatically", async (_case, over, streak) => {
    const disk = new Map([[RECORD_PATH, JSON.stringify(storedRecovery(over))]]);
    const device = boot(data(), disk);
    await device.plugin.onload();

    const lifted = record(disk);
    expect(lifted.paused).toBeNull();
    expect(lifted.active).toBeNull();
    expect(lifted.streak).toBe(streak);
    expect(lifted.cooldown).toBeNull();
    expect(lifted.trace.at(-1)?.event).toBe("plugin-load");
    expect(cooldownNotices()).toEqual([]);
    expect(device.plugin.automaticSyncPaused).toBe(false);

    layoutReady(device.app);
    await until(() => record(disk).lastCompleted !== null, "the startup pass");
    expect(headCalls()).toBe(1);
    expect(record(disk).streak).toBe(0);
  });

  it("keeps Sync now behind first-sync consent while waiting", async () => {
    const { device } = await launchCoolingDown({ firstSyncAcknowledged: false }, { state: null });
    expect(device.plugin.automaticSyncPaused).toBe(true);

    const pass = device.plugin.syncNow();
    for (let i = 0; i < 50 && Modal.shown.length === 0; i++) await vi.advanceTimersByTimeAsync(1);
    expect(Modal.shown).toHaveLength(1);
    Modal.shown[0].close(); // "Not yet"
    await pass;

    expect(headCalls()).toBe(0);
    expect(device.plugin.settings.firstSyncAcknowledged).toBe(false);
    expect(device.plugin.automaticSyncPaused).toBe(true);
  });

  it("offers Resume as an optional override that ends the cooldown now, and persists it", async () => {
    const { device, disk } = await launchCoolingDown();
    layoutReady(device.app);
    await elapse(10);
    expect(headCalls()).toBe(0);

    // The Troubleshooting row, with the lead's wording, only while held.
    const tab = (device.plugin as unknown as { settingTabs: { display(): void; containerEl: FakeElement }[] })
      .settingTabs[0];
    tab.display();
    const rowAt = tab.containerEl.log.settings.findIndex((s) => s.name === RESUME_AUTOMATIC_LABEL);
    expect(rowAt).toBeGreaterThanOrEqual(0);
    expect(tab.containerEl.log.settings[rowAt].desc).toBe(RESUME_AUTOMATIC_DESC);
    expect(tab.containerEl.log.settings[rowAt].section).toBe("Troubleshooting");
    const button = tab.containerEl.log.rows[rowAt].buttons[0];
    expect(button.text).toBe(RESUME_AUTOMATIC_LABEL);

    await button.click();
    await elapse(10);

    expect(record(disk).streak).toBe(0);
    expect(record(disk).cooldown).toBeNull();
    expect(record(disk).trace.some((t) => t.event === "resumed")).toBe(true);
    expect(device.plugin.automaticSyncPaused).toBe(false);
    expect(statusText(device)).not.toContain(RECOVERY_PAUSED_STATUS);
    // The row is gone once it no longer applies.
    expect(tab.containerEl.log.settings.map((s) => s.name)).not.toContain(RESUME_AUTOMATIC_LABEL);
    // The startup pass the cooldown refused is answered now, not at the old deadline.
    await until(() => completedPasses(device) === 1, "the owed pass to complete");
    expect(headCalls()).toBe(1);

    // A file event now syncs, and the next launch is not held.
    device.vault.content.set(PATHS[2], text(PATHS[2], 3));
    device.app.vault.fire("modify", { path: PATHS[2] });
    await elapse(DEBOUNCE_MS * 2);
    await until(() => completedPasses(device) === 2, "the file-event pass to complete");
    expect(headCalls()).toBe(2);

    device.plugin.onunload();
    Notice.shown.length = 0;
    requestUrlMock.calls.length = 0;
    const next = boot(dataJsonOf(device), disk);
    await next.plugin.onload();
    expect(cooldownNotices()).toEqual([]);
    layoutReady(next.app);
    await until(() => completedPasses(next) === 1, "the startup pass to complete");
    expect(headCalls()).toBe(1);
  });

  it("drops the resume row and command once the cooldown expires", async () => {
    const { device, disk } = await launchCoolingDown();
    const command = (device.plugin as unknown as {
      commands: { id: string; name: string; checkCallback?: (checking: boolean) => boolean | void }[];
    }).commands.find((c) => c.id === "sync-resume-automatic");
    expect(command?.name).toBe(RESUME_AUTOMATIC_LABEL);
    expect(command!.checkCallback!(true)).toBe(true);
    const tab = (device.plugin as unknown as { settingTabs: { display(): void; containerEl: FakeElement }[] })
      .settingTabs[0];
    tab.display();
    expect(tab.containerEl.log.settings.map((s) => s.name)).toContain(RESUME_AUTOMATIC_LABEL);

    vi.spyOn(Date, "now").mockReturnValue(record(disk).cooldown!.until);
    expect(command!.checkCallback!(true)).toBe(false);
    tab.display();
    expect(tab.containerEl.log.settings.map((s) => s.name)).not.toContain(RESUME_AUTOMATIC_LABEL);
  });

  it("offers the resume command only while held", async () => {
    const { device, disk } = await launchCoolingDown();
    const command = (device.plugin as unknown as {
      commands: { id: string; name: string; checkCallback?: (checking: boolean) => boolean | void }[];
    }).commands.find((c) => c.id === "sync-resume-automatic");
    expect(command!.checkCallback!(true)).toBe(true);

    command!.checkCallback!(false);
    await until(() => record(disk).cooldown === null, "the resume to persist");
    expect(command!.checkCallback!(true)).toBe(false);
  });

  it("exports the recovery record with the sync log while waiting, without starting a pass", async () => {
    const disk = new Map([[RECORD_PATH, JSON.stringify(storedRecovery({ streak: 2, active: INTERRUPTED }))]]);
    const device = boot(data(), disk);
    const created: { path: string; body: string }[] = [];
    (device.app.vault as unknown as { create: unknown }).create = async (path: string, body: string) => {
      created.push({ path, body });
      device.app.vault.fire("create", { path });
    };
    await device.plugin.onload();
    layoutReady(device.app);

    await device.plugin.exportLog();
    await elapse(DEBOUNCE_MS * 2);

    expect(created).toHaveLength(1);
    const body = created[0].body;
    expect(body).toContain("## Sync recovery diagnostics");
    const json = body.slice(body.indexOf("```json") + 7, body.lastIndexOf("```"));
    const exported = JSON.parse(json) as DiagnosticRecord & { loggingFailure: unknown };
    expect(exported.schema).toBe(DIAGNOSTIC_SCHEMA);
    expect(exported.lastInterrupted?.pass.phase).toBe("scan");
    expect(exported.streak).toBe(3);
    expect(exported.cooldown).not.toBeNull();
    expect(exported.loggingFailure).toBeNull();
    expect(headCalls()).toBe(0);
  });
});

// --- unload / rebuild ownership ---------------------------------------------------------

describe("marker ownership across unload", () => {
  it("does not clear the marker on unload, and a finishing old instance cannot overwrite the reload", async () => {
    // A pass started by hand, so the test holds its promise and can await its real end.
    const first = boot(data({ syncOnStartup: false }));
    let release!: () => void;
    first.server.hold = new Promise<void>((resolve) => (release = resolve));
    await first.plugin.onload();
    layoutReady(first.app);
    const retiredPass = first.plugin.syncNow();
    await until(() => headCalls() === 1, "the pass to reach the server");

    first.plugin.onunload();
    expect(record(first.app.vault.configFiles).active).not.toBeNull();

    // Plugin reload in the same process: the same disk. The marker is counted, not cleared.
    const disk = first.app.vault.configFiles;
    const second = boot(dataJsonOf(first), disk);
    await second.plugin.onload();
    expect(record(disk).streak).toBe(1);
    expect(record(disk).active).toBeNull();
    const writesBefore = second.app.vault.configWrites.length;
    const countedRecord = disk.get(RECORD_PATH);

    // The old instance's pass now settles — awaited to its real end, WebCrypto and its final
    // write attempt included. It must not write over the new instance's record, and in
    // particular must not reset the streak it never owned.
    release();
    await retiredPass;
    expect(first.app.vault.configWrites.at(-1)?.data).not.toContain("pass-complete");
    expect(disk.get(RECORD_PATH)).toBe(countedRecord);
    expect(second.app.vault.configWrites.length).toBe(writesBefore);
    expect(record(disk).streak).toBe(1);
  });
});

// --- logging failures -------------------------------------------------------------------

describe("recovery logging failures", () => {
  // PIN: owner 2026-09-25 — never overwrite an unread recovery record (docs/260925-fix-RECOVERY_RESUME_AFTER_READ_FAILURE.md)
  it("re-reads a recovered record before Resume and preserves its history", async () => {
    const previous = storedRecovery({
      lastCompleted: { startedAt: 8, finishedAt: 11, status: "committed" },
    });
    const disk = new Map([[RECORD_PATH, JSON.stringify(previous)]]);
    const device = boot(data({ syncOnStartup: false }), disk);
    device.app.vault.configFaults.read = new Error("temporary read failure");
    await device.plugin.onload();
    layoutReady(device.app);
    expect(device.plugin.automaticSyncPaused).toBe(true);

    device.app.vault.configFaults = {};
    expect(await device.plugin.resumeAutomaticSync()).toBe(true);
    const resumed = record(disk);
    expect(resumed.lastCompleted).toEqual(previous.lastCompleted);
    expect(resumed.trace.slice(0, 1)).toEqual(previous.trace);
    expect(resumed.trace.at(-1)?.event).toBe("resumed");
    expect(resumed.pluginVersion).toBe("1.1.3");
    expect(device.plugin.automaticSyncPaused).toBe(false);
  });

  it("counts an unread active marker once it is read, and Resume then clears the logging failure", async () => {
    const interrupted = { startedAt: 8, phase: "merge" as const, phaseAt: 9 };
    const previous = storedRecovery({ active: interrupted });
    const disk = new Map([[RECORD_PATH, JSON.stringify(previous)]]);
    const device = boot(data({ syncOnStartup: false }), disk);
    device.app.vault.configFaults.read = new Error("temporary read failure");
    await device.plugin.onload();
    layoutReady(device.app);

    // One interruption is not a cooldown: there is nothing to show first, so this Resume is
    // the one that clears the failure, after the marker is counted and kept as evidence.
    device.app.vault.configFaults = {};
    expect(await device.plugin.resumeAutomaticSync()).toBe(true);
    const recovered = record(disk);
    expect(recovered.active).toBeNull();
    expect(recovered.lastInterrupted?.pass).toEqual(interrupted);
    expect(recovered.trace[0]).toEqual(previous.trace[0]);
    expect(recovered.trace.slice(-2).map((t) => t.event)).toEqual(["plugin-load", "resumed"]);
    expect(device.plugin.automaticSyncPaused).toBe(false);
    expect(cooldownNotices()).toEqual([]);
  });

  it("recovers an unread third interruption as a cooldown before a second explicit Resume", async () => {
    const previous = storedRecovery({ streak: 2, active: INTERRUPTED });
    const disk = new Map([[RECORD_PATH, JSON.stringify(previous)]]);
    const device = boot(data({ syncOnStartup: false }), disk);
    device.app.vault.configFaults.read = new Error("temporary read failure");
    await device.plugin.onload();
    layoutReady(device.app);

    device.app.vault.configFaults = {};
    expect(await device.plugin.resumeAutomaticSync()).toBe(false);
    const recovered = record(disk);
    expect(recovered.active).toBeNull();
    expect(recovered.streak).toBe(3);
    expect(recovered.cooldown).not.toBeNull();
    expect(recovered.lastInterrupted?.pass).toEqual(INTERRUPTED);
    expect(recovered.trace[0]).toEqual(previous.trace[0]);
    expect(recovered.trace.at(-1)?.event).toBe("recovery-paused");
    expect(device.plugin.recoveryPaused).toBe(true);
    expect(device.plugin.automaticSyncPaused).toBe(true);
    expect(cooldownNotices()).toEqual([recoveryCooldownNotice(3, cooldownMs(3))]);

    expect(await device.plugin.resumeAutomaticSync()).toBe(true);
    expect(record(disk).cooldown).toBeNull();
    expect(record(disk).streak).toBe(0);
    expect(record(disk).trace.some((entry) => entry.event === "recovery-paused")).toBe(true);
    expect(device.plugin.automaticSyncPaused).toBe(false);
  });

  it("re-establishes an unread stored cooldown before allowing Resume", async () => {
    const since = Date.now();
    const previous = storedRecovery({
      streak: 3,
      cooldown: { since, until: since + 15 * 60_000 },
      lastInterrupted: { detectedAt: since, pass: INTERRUPTED },
    });
    const disk = new Map([[RECORD_PATH, JSON.stringify(previous)]]);
    const device = boot(data({ syncOnStartup: false }), disk);
    device.app.vault.configFaults.read = new Error("temporary read failure");
    await device.plugin.onload();
    layoutReady(device.app);

    device.app.vault.configFaults = {};
    expect(await device.plugin.resumeAutomaticSync()).toBe(false);
    expect(record(disk).cooldown).toEqual(previous.cooldown);
    expect(record(disk).streak).toBe(3);
    expect(record(disk).trace[0]).toEqual(previous.trace[0]);
    expect(device.plugin.automaticSyncPaused).toBe(true);
    expect(await device.plugin.resumeAutomaticSync()).toBe(true);
    expect(record(disk).cooldown).toBeNull();
  });

  it("can recover a repaired parse failure without discarding its active marker", async () => {
    const disk = new Map([[RECORD_PATH, "{not json"]]);
    const device = boot(data({ syncOnStartup: false }), disk);
    await device.plugin.onload();
    layoutReady(device.app);
    const interrupted = { startedAt: 8, phase: "commit" as const, phaseAt: 9 };
    disk.set(RECORD_PATH, JSON.stringify(storedRecovery({ active: interrupted })));

    expect(await device.plugin.resumeAutomaticSync()).toBe(true);
    expect(record(disk).lastInterrupted?.pass).toEqual(interrupted);
    expect(record(disk).trace.at(-1)?.event).toBe("resumed");
    expect(disk.has(UNREADABLE_PATH)).toBe(false);
    expect(device.plugin.automaticSyncPaused).toBe(false);
  });

  it("does not count or discard a newly discovered interruption when its write fails", async () => {
    const interrupted = { startedAt: 8, phase: "merge" as const, phaseAt: 9 };
    const raw = JSON.stringify(storedRecovery({ active: interrupted }));
    const disk = new Map([[RECORD_PATH, raw]]);
    const device = boot(data({ syncOnStartup: false }), disk);
    device.app.vault.configFaults.read = new Error("temporary read failure");
    await device.plugin.onload();
    layoutReady(device.app);

    device.app.vault.configFaults = { write: new Error("temporary write failure") };
    expect(await device.plugin.resumeAutomaticSync()).toBe(false);
    expect(disk.get(RECORD_PATH)).toBe(raw);
    await device.plugin.syncNow();
    expect(headCalls()).toBe(0);
    expect(disk.get(RECORD_PATH)).toBe(raw);
    expect(device.plugin.automaticSyncPaused).toBe(true);

    device.app.vault.configFaults = {};
    expect(await device.plugin.resumeAutomaticSync()).toBe(true);
    const counted = record(disk);
    expect(counted.lastInterrupted?.pass).toEqual(interrupted);
    expect(counted.active).toBeNull();
    expect(device.plugin.automaticSyncPaused).toBe(false);
  });

  it("refuses Resume and manual Sync now while a read failure persists", async () => {
    const raw = JSON.stringify(storedRecovery());
    const disk = new Map([[RECORD_PATH, raw]]);
    const device = boot(data({ syncOnStartup: false }), disk);
    device.app.vault.configFaults.read = new Error("read unavailable");
    await device.plugin.onload();
    layoutReady(device.app);

    expect(await device.plugin.resumeAutomaticSync()).toBe(false);
    expect(disk.get(RECORD_PATH)).toBe(raw);
    expect(device.plugin.automaticSyncPaused).toBe(true);
    await device.plugin.syncNow();
    expect(headCalls()).toBe(0);
    expect(disk.get(RECORD_PATH)).toBe(raw);
    expect(Notice.shown).toContain(RECOVERY_LOG_FAILED_NOTICE);
    expect(Notice.shown.join("\n")).toContain(
      "recovery logging failed: the recovery record could not be read, so the pass did not start"
    );
  });

  it.each([
    ["unparsable JSON", "{not json"],
    ["a wrong-schema record", JSON.stringify({ ...storedRecovery(), schema: "future-schema" })],
  ])("sets aside %s before explicit Resume and allows automatic sync again", async (_case, raw) => {
    const disk = new Map([[RECORD_PATH, raw], [UNREADABLE_PATH, "older diagnostic"]]);
    const device = boot(data({ syncOnStartup: false }), disk);
    await device.plugin.onload();
    layoutReady(device.app);

    expect(await device.plugin.resumeAutomaticSync()).toBe(true);
    expect(disk.get(UNREADABLE_PATH)).toBe(raw);
    const sidecarBytes = await (device.app.vault.adapter.readBinary as (path: string) => Promise<ArrayBuffer>)(UNREADABLE_PATH);
    expect(new Uint8Array(sidecarBytes)).toEqual(new TextEncoder().encode(raw));
    expect(device.app.vault.configWrites.at(-2)?.path).toBe(UNREADABLE_PATH);
    expect(device.app.vault.configWrites.at(-1)?.path).toBe(RECORD_PATH);
    const fresh = record(disk);
    expect(parseRecord(disk.get(RECORD_PATH)!)).not.toBeNull();
    expect(fresh.active).toBeNull();
    expect(fresh.paused).toBeNull();
    expect(fresh.trace.at(-1)?.event).toBe("unreadable-set-aside");
    expect(device.plugin.automaticSyncPaused).toBe(false);

    device.app.vault.fire("modify", { path: PATHS[0] });
    await elapse(DEBOUNCE_MS * 2);
    await until(() => completedPasses(device) === 1, "the file-event pass to complete");
    expect(headCalls()).toBe(1);
  });

  it("bounds a large unreadable sidecar at 64 KiB and records the original byte length", async () => {
    const raw = "{" + "x".repeat(65_536 + 123);
    const disk = new Map([[RECORD_PATH, raw]]);
    const device = boot(data({ syncOnStartup: false }), disk);
    await device.plugin.onload();
    layoutReady(device.app);

    expect(await device.plugin.resumeAutomaticSync()).toBe(true);
    expect(disk.get(UNREADABLE_PATH)).toBe(
      `${raw.slice(0, 65_536)}\n[truncated: original length ${raw.length} bytes]\n`
    );
    expect(record(disk).trace.at(-1)?.event).toBe("unreadable-set-aside");
  });

  it("does not discard an unreadable record if the sidecar write fails", async () => {
    const raw = "{not json";
    const disk = new Map([[RECORD_PATH, raw]]);
    const device = boot(data({ syncOnStartup: false }), disk);
    await device.plugin.onload();
    layoutReady(device.app);
    device.app.vault.configFaults.writeBinary = new Error("sidecar unavailable");

    expect(await device.plugin.resumeAutomaticSync()).toBe(false);
    expect(disk.get(RECORD_PATH)).toBe(raw);
    expect(disk.has(UNREADABLE_PATH)).toBe(false);
    expect(device.app.vault.configWrites).toEqual([]);
    expect(device.plugin.automaticSyncPaused).toBe(true);
    expect(Notice.shown.filter((n) => n === RECOVERY_LOG_FAILED_NOTICE)).toHaveLength(2);

    device.app.vault.configFaults = {};
    expect(await device.plugin.resumeAutomaticSync()).toBe(true);
    expect(disk.get(UNREADABLE_PATH)).toBe(raw);
    expect(record(disk).trace.at(-1)?.event).toBe("unreadable-set-aside");
  });

  it.each([
    ["unparsable JSON", "{not json"],
    ["a wrong-schema record", JSON.stringify({ ...storedRecovery(), schema: "future-schema" })],
  ])("manual Sync now refuses %s and points to Resume", async (_case, raw) => {
    const disk = new Map([[RECORD_PATH, raw]]);
    const device = boot(data({ syncOnStartup: false }), disk);
    await device.plugin.onload();
    layoutReady(device.app);

    await device.plugin.syncNow();
    expect(headCalls()).toBe(0);
    expect(disk.get(RECORD_PATH)).toBe(raw);
    expect(disk.has(UNREADABLE_PATH)).toBe(false);
    expect(Notice.shown.join("\n")).toContain(
      "recovery logging failed: the recovery record is unreadable. Use Resume automatic sync in the Troubleshooting settings to set it aside, then sync again"
    );
  });

  it("re-reads before manual Sync now, counting a recovered interruption, and the read failure still holds automatic sync", async () => {
    const interrupted = { startedAt: 8, phase: "scan" as const, phaseAt: 9 };
    const disk = new Map([[RECORD_PATH, JSON.stringify(storedRecovery({ active: interrupted }))]]);
    const device = boot(data({ syncOnStartup: false }), disk);
    device.app.vault.configFaults.read = new Error("temporary read failure");
    await device.plugin.onload();
    layoutReady(device.app);

    device.app.vault.configFaults = {};
    await device.plugin.syncNow();
    expect(headCalls()).toBe(1);
    const after = record(disk);
    expect(after.lastInterrupted?.pass).toEqual(interrupted);
    expect(after.active).toBeNull();
    // The pass settled, so the streak it counted is reset; the logging failure is Resume's.
    expect(after.streak).toBe(0);
    expect(device.plugin.recoveryPaused).toBe(false);
    expect(device.plugin.automaticSyncPaused).toBe(true);
    expect(statusText(device)).toContain(RECOVERY_LOG_FAILED_STATUS);
    expect(cooldownNotices()).toEqual([]);
  });

  it("re-reads before manual Sync now, which runs through a recovered cooldown and ends it", async () => {
    const disk = new Map([[RECORD_PATH, JSON.stringify(storedRecovery({ streak: 2, active: INTERRUPTED }))]]);
    const device = boot(data({ syncOnStartup: false }), disk);
    device.app.vault.configFaults.read = new Error("temporary read failure");
    await device.plugin.onload();
    layoutReady(device.app);

    device.app.vault.configFaults = {};
    await device.plugin.syncNow();
    expect(headCalls()).toBe(1);
    expect(cooldownNotices()).toEqual([recoveryCooldownNotice(3, cooldownMs(3))]);
    expect(record(disk).trace.some((entry) => entry.event === "recovery-paused")).toBe(true);
    expect(record(disk).streak).toBe(0);
    expect(record(disk).cooldown).toBeNull();
    expect(device.plugin.automaticSyncPaused).toBe(false);
  });

  it("keeps a running manual pass marked if Resume follows recovery of an unread record", async () => {
    const interrupted = INTERRUPTED;
    const disk = new Map([[RECORD_PATH, JSON.stringify(storedRecovery({ streak: 2, active: interrupted }))]]);
    const device = boot(data({ syncOnStartup: false }), disk);
    device.app.vault.configFaults.read = new Error("temporary read failure");
    await device.plugin.onload();
    layoutReady(device.app);
    device.app.vault.configFaults = {};
    expect(await device.plugin.resumeAutomaticSync()).toBe(false);

    let release!: () => void;
    device.server.hold = new Promise<void>((resolve) => (release = resolve));
    const pass = device.plugin.syncNow();
    await until(() => headCalls() === 1, "the manual pass to reach the server");
    const running = record(disk).active;
    expect(running).not.toBeNull();
    expect(await device.plugin.resumeAutomaticSync()).toBe(true);
    expect(record(disk).active).toEqual(running);
    expect(record(disk).cooldown).toBeNull();
    release();
    await pass;
    expect(record(disk).active).toBeNull();
    expect(record(disk).lastCompleted).not.toBeNull();
  });

  it("does not start a pass whose marker cannot be written, and stops automatic sync visibly", async () => {
    const device = boot(data());
    device.app.vault.configFaults.write = new Error("synthetic write failure");
    await device.plugin.onload();
    layoutReady(device.app);
    await elapse(10);

    expect(headCalls()).toBe(0);
    expect(device.vault.lists).toBe(0);
    expect(Notice.shown).toContain(RECOVERY_LOG_FAILED_NOTICE);
    expect(Notice.shown.filter((n) => n === RECOVERY_LOG_FAILED_NOTICE)).toHaveLength(1);
    expect(device.plugin.automaticSyncPaused).toBe(true);
    expect(statusText(device)).toContain(RECOVERY_LOG_FAILED_STATUS);
    expect(statusText(device)).not.toContain(RECOVERY_PAUSED_STATUS);

    await fireEveryAutomaticSource(device);
    expect(headCalls()).toBe(0);

    // A manual pass is refused too while the marker cannot be written.
    await device.plugin.syncNow();
    expect(headCalls()).toBe(0);

    // Once the record can be written again, the explicit resume restores automatic sync.
    device.app.vault.configFaults = {};
    expect(await device.plugin.resumeAutomaticSync()).toBe(true);
    expect(device.plugin.automaticSyncPaused).toBe(false);
    device.app.vault.fire("modify", { path: PATHS[0] });
    await elapse(DEBOUNCE_MS * 2);
    await until(() => completedPasses(device) === 1, "the file-event pass to complete");
    expect(headCalls()).toBe(1);
  });

  // PIN: owner 2026-09-25 — a logging-only failure must offer the settings resume row, not
  // just the command palette (Codex review finding #3, docs/260925-eval-CODEX_REVIEW_1_1_4.md).
  it("offers the settings resume row after a transient write failure mid-pass, and it restores automatic sync", async () => {
    // A pass started by hand, so the test holds its promise and can await its real end.
    const device = boot(data({ syncOnStartup: false }));
    let release!: () => void;
    device.server.hold = new Promise<void>((resolve) => (release = resolve));
    await device.plugin.onload();
    layoutReady(device.app);
    const pass = device.plugin.syncNow();
    await until(() => headCalls() === 1, "the pass to reach the server");
    const marker = record(device.app.vault.configFiles).active;
    expect(marker).not.toBeNull();

    // Storage fails while the pass runs: its checkpoints and its finish cannot be written.
    // The pass itself still completes (a trace gap never fails a pass) — awaited to its end
    // while storage is still faulty, so the finish write has really been attempted and lost.
    device.app.vault.configFaults.write = new Error("synthetic transient write failure");
    release();
    await pass;
    expect(commitCalls()).toBe(1);
    expect(device.plugin.automaticSyncPaused).toBe(true);
    // What the disk holds is the stale marker from before the failure, not the settled pass.
    const stale = record(device.app.vault.configFiles);
    expect(stale.active).toEqual(marker);
    expect(stale.lastCompleted).toBeNull();
    expect(device.plugin.recoveryPaused).toBe(false);
    expect(Notice.shown.filter((n) => n === RECOVERY_LOG_FAILED_NOTICE)).toHaveLength(1);
    expect(RECOVERY_LOG_FAILED_NOTICE).toContain(RESUME_AUTOMATIC_LABEL);

    // The row is shown for this case too, with wording that names the failure, not an interruption.
    const tab = (device.plugin as unknown as { settingTabs: { display(): void; containerEl: FakeElement }[] })
      .settingTabs[0];
    tab.display();
    const rowAt = tab.containerEl.log.settings.findIndex((s) => s.name === RESUME_AUTOMATIC_LABEL);
    expect(rowAt).toBeGreaterThanOrEqual(0);
    expect(tab.containerEl.log.settings[rowAt].desc).toBe(RESUME_AFTER_LOG_FAILURE_DESC);
    expect(tab.containerEl.log.settings[rowAt].section).toBe("Troubleshooting");

    // Storage recovers; the row's button clears the failure and rewrites the record. Nothing
    // else is running, so only Resume can be what replaces the stale marker.
    device.app.vault.configFaults = {};
    await tab.containerEl.log.rows[rowAt].buttons[0].click();
    const resumed = record(device.app.vault.configFiles);
    expect(resumed.active).toBeNull();
    expect(resumed.lastCompleted?.status).toBe("committed");
    expect(resumed.trace.at(-1)?.event).toBe("resumed");
    expect(device.plugin.automaticSyncPaused).toBe(false);
    expect(tab.containerEl.log.settings.map((s) => s.name)).not.toContain(RESUME_AUTOMATIC_LABEL);

    // Automatic sync runs again. The first pass's finish write was lost to the fault, so this
    // is the first completion on record.
    device.vault.content.set(PATHS[2], text(PATHS[2], 3));
    device.app.vault.fire("modify", { path: PATHS[2] });
    await elapse(DEBOUNCE_MS * 2);
    await until(() => completedPasses(device) === 1, "the file-event pass to complete");
    expect(headCalls()).toBe(2);
  });

  it.each([
    ["unparsable", "{not json"],
    ["another schema", JSON.stringify({ schema: "something-else", active: null })],
    ["an unknown trace event", JSON.stringify({
      schema: DIAGNOSTIC_SCHEMA, pluginVersion: "1", platform: "x", active: null, paused: null,
      lastCompleted: null, lastFailed: null, trace: [{ at: 1, event: "alpha-note.md" }],
    })],
    // A present streak that is not a count is unreadable, never a 1.1.4–1.1.6 record.
    ["an invalid streak", JSON.stringify({
      ...storedRecovery({ paused: { since: 7, interrupted: INTERRUPTED } }), streak: -1,
    })],
    ["a non-integer streak", JSON.stringify({ ...storedRecovery({ active: INTERRUPTED }), streak: "2" })],
  ])("stops automatic sync when the record is %s", async (_label, content) => {
    const disk = new Map([[RECORD_PATH, content]]);
    const device = boot(data(), disk);
    await device.plugin.onload();

    expect(Notice.shown).toContain(RECOVERY_LOG_FAILED_NOTICE);
    expect(cooldownNotices()).toEqual([]);
    expect(disk.get(RECORD_PATH)).toBe(content);
    await fireEveryAutomaticSource(device);
    expect(headCalls()).toBe(0);
  });

  it("stops automatic sync when the record cannot be read", async () => {
    const device = boot(data(), new Map([[RECORD_PATH, "{}"]]));
    device.app.vault.configFaults.read = new Error("synthetic read failure");
    await device.plugin.onload();
    expect(Notice.shown).toContain(RECOVERY_LOG_FAILED_NOTICE);
    await fireEveryAutomaticSource(device);
    expect(headCalls()).toBe(0);
  });

  it("keeps the trace bounded over many passes", async () => {
    const device = boot(data({ syncOnStartup: false }));
    await device.plugin.onload();
    layoutReady(device.app);
    for (let i = 0; i < 8; i++) await device.plugin.syncNow();
    expect(headCalls()).toBe(8);
    const bounded = record(device.app.vault.configFiles);
    expect(bounded.trace).toHaveLength(TRACE_LIMIT);
    expect(bounded.trace.at(-1)?.event).toBe("pass-complete");
  });
});
