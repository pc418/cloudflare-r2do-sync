import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LogSyncPlugin, {
  RECOVERY_LOG_FAILED_NOTICE,
  RECOVERY_PAUSED_NOTICE,
  RECOVERY_PAUSED_STATUS,
  RESUME_AFTER_LOG_FAILURE_DESC,
  RESUME_AUTOMATIC_DESC,
  RESUME_AUTOMATIC_LABEL,
  type Settings,
} from "../src/main";
import { DIAGNOSTIC_SCHEMA, TRACE_LIMIT, parseRecord, type DiagnosticRecord } from "../src/sync-diagnostics";
import {
  type FakeElement,
  LifecycleApp,
  Modal,
  Notice,
  Platform,
  requestUrlMock,
} from "./obsidian-fake";

/**
 * The sync recovery pause, driven through the real plugin, scheduler and engine.
 *
 * PIN (lead assignment 2026-09-25, docs/260925-fix-IPHONE_SYNC_RECOVERY_PLAN.md): every
 * scheduled pass persists an active marker before it does any work and clears it only once it
 * settles. A load that finds a marker left behind pauses ALL automatic sync — startup, timer,
 * mobile resume and file events — until an explicit resume, across rebuilds and restarts.
 * Manual Sync now still runs one consent-gated pass and does not unpause. A pass that settled
 * (result or error) is never reported as interrupted. A recovery record that cannot be read or
 * written stops automatic sync and says so.
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
  const win = {
    setInterval: make("interval"),
    clearInterval: clear,
    setTimeout: make("timeout"),
    clearTimeout: clear,
  };
  Object.assign(globalThis, { window: win, document: { visibilityState: "visible" } });
}

const SERVER = "https://synthetic-vault.example.workers.dev";
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
}

/** Serves only this device's own commits, so a pass never has anything to pull. */
function steadyServer(app: LifecycleApp): ServerControl {
  const control: ServerControl = { hold: null, onHead: null, headStatus: 200 };
  let head = "01HEAD";
  let commits = 0;
  requestUrlMock.impl = async (req) => {
    const url = (req as { url: string }).url;
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
      head = `01NEXT${++commits}`;
      return { status: 200, text: "", json: { head } };
    }
    throw new Error(`unexpected request: ${url}`);
  };
  return control;
}

const headCalls = () =>
  requestUrlMock.calls.filter((c) => (c as { url: string }).url.endsWith("/api/head")).length;

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
  const server = steadyServer(app);
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

function storedRecovery(over: Partial<DiagnosticRecord> = {}): DiagnosticRecord {
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

/** Waits (bounded) for an asynchronous condition the scheduler reaches on its own time. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await vi.advanceTimersByTimeAsync(1);
  if (!condition()) throw new Error(`timed out waiting for ${what}`);
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

/** Launches, starts the startup pass and kills the process while the pass waits on the server. */
async function launchAndKillMidPass(): Promise<{ disk: Map<string, string>; dataJson: unknown }> {
  const first = boot(data());
  first.server.hold = new Promise<void>(() => {});
  await first.plugin.onload();
  layoutReady(first.app);
  await until(() => headCalls() === 1, "the startup pass to reach the server");
  // The process dies here: whatever is on disk now is what the next launch finds. No
  // onunload, no settle. The held request is never released, as for a killed process: a
  // released dead pass would carry on through the global `requestUrlMock`, which the next
  // `boot()` points at the new device's server, and commit there (seen on the CI runner).
  const disk = new Map(first.app.vault.configFiles);
  const dataJson = dataJsonOf(first);
  expect(record(disk).active).not.toBeNull();
  first.plugin.onunload();
  await elapse(10);
  requestUrlMock.calls.length = 0;
  Notice.shown.length = 0;
  return { disk, dataJson };
}

beforeEach(() => {
  installGlobals();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  Notice.shown.length = 0;
  Modal.shown.length = 0;
  requestUrlMock.impl = null;
  requestUrlMock.calls.length = 0;
  Platform.isMobile = true;
});

afterEach(() => {
  vi.useRealTimers();
  Platform.isMobile = false;
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

    device.vault.content.set(PATHS[0], text(PATHS[0], 2));
    device.app.vault.fire("modify", { path: PATHS[0] });
    await elapse(DEBOUNCE_MS * 2);
    expect(headCalls()).toBe(1);
    expect(starts()).toBe(1);

    windowTimers.find((t) => t.kind === "interval" && t.ms === INTERVAL_MINUTES * 60_000)!.fn();
    await elapse(10);
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
    expect(Notice.shown).not.toContain(RECOVERY_PAUSED_NOTICE);
    expect(next.plugin.automaticSyncPaused).toBe(false);
    layoutReady(next.app);
    await elapse(10);
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
    await until(() => device.app.vault.configWrites.length > 0, "a record write");
    expect(device.app.vault.configWrites.every((w) => w.path === ".obsidian/plugins/renamed-folder/sync-recovery.json")).toBe(true);
  });
});

// --- pause ------------------------------------------------------------------------------

describe("recovery pause after a pass that never settled", () => {
  it("blocks every automatic source on the next launch, and says so", async () => {
    const { disk, dataJson } = await launchAndKillMidPass();
    const device = boot(dataJson, disk);
    await device.plugin.onload();

    // Paused before any trigger could run, persisted, and visible.
    expect(Notice.shown).toContain(RECOVERY_PAUSED_NOTICE);
    const paused = record(disk);
    expect(paused.active).toBeNull();
    expect(paused.paused?.interrupted.phase).toBe("head");
    expect(paused.trace.slice(-2).map((t) => t.event)).toEqual(["plugin-load", "recovery-paused"]);
    expect(statusText(device)).toContain(RECOVERY_PAUSED_STATUS);

    await fireEveryAutomaticSource(device);

    expect(headCalls()).toBe(0);
    expect(requestUrlMock.calls).toEqual([]);
    expect(device.vault.reads).toEqual([]);
    expect(device.vault.lists).toBe(0);
    expect(statusText(device)).toContain(RECOVERY_PAUSED_STATUS);
  });

  it("survives a settings rebuild and a second restart", async () => {
    const { disk, dataJson } = await launchAndKillMidPass();
    const second = boot(dataJson, disk);
    await second.plugin.onload();
    layoutReady(second.app);

    await second.plugin.saveSettings(); // rebuilds the engine and scheduler
    await fireEveryAutomaticSource(second);
    expect(headCalls()).toBe(0);
    expect(second.plugin.automaticSyncPaused).toBe(true);

    second.plugin.onunload();
    Notice.shown.length = 0;
    const third = boot(dataJsonOf(second), disk);
    await third.plugin.onload();
    expect(Notice.shown).toContain(RECOVERY_PAUSED_NOTICE);
    expect(third.plugin.automaticSyncPaused).toBe(true);
    await fireEveryAutomaticSource(third);
    expect(headCalls()).toBe(0);
  });

  it("lets Sync now run one pass without unpausing, and that pass still sees paused-time edits", async () => {
    const { disk, dataJson } = await launchAndKillMidPass();
    const device = boot(dataJson, disk);
    await device.plugin.onload();
    await fireEveryAutomaticSource(device);
    expect(headCalls()).toBe(0);

    await device.plugin.syncNow();

    expect(headCalls()).toBe(1);
    expect(device.vault.reads).toContain(PATHS[0]);
    const after = record(disk);
    expect(after.lastCompleted?.status).toBe("committed");
    expect(after.active).toBeNull();
    expect(after.paused).not.toBeNull();
    expect(device.plugin.automaticSyncPaused).toBe(true);
    expect(statusText(device)).toContain(RECOVERY_PAUSED_STATUS);

    // Still paused for automatic work afterwards.
    await fireEveryAutomaticSource(device);
    expect(headCalls()).toBe(1);
  });

  it("keeps Sync now behind first-sync consent while paused", async () => {
    const { disk } = await launchAndKillMidPass();
    const device = boot(
      data({ firstSyncAcknowledged: false }, { state: null }),
      disk
    );
    await device.plugin.onload();
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

  it("resumes only on the explicit action, persists it, and automatic sync runs again", async () => {
    const { disk, dataJson } = await launchAndKillMidPass();
    const device = boot(dataJson, disk);
    await device.plugin.onload();
    layoutReady(device.app);
    await elapse(10);
    expect(headCalls()).toBe(0);

    // The Troubleshooting row, with the lead's wording, only while paused.
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

    expect(record(disk).paused).toBeNull();
    expect(record(disk).trace.at(-1)?.event).toBe("resumed");
    expect(device.plugin.automaticSyncPaused).toBe(false);
    expect(statusText(device)).not.toContain(RECOVERY_PAUSED_STATUS);
    // The row is gone once it no longer applies.
    expect(tab.containerEl.log.settings.map((s) => s.name)).not.toContain(RESUME_AUTOMATIC_LABEL);

    // A file event now syncs, and the next launch is not paused.
    device.vault.content.set(PATHS[2], text(PATHS[2], 3));
    device.app.vault.fire("modify", { path: PATHS[2] });
    await elapse(DEBOUNCE_MS * 2);
    expect(headCalls()).toBe(1);
    await until(() => record(disk).lastCompleted !== null && record(disk).active === null, "the pass");

    device.plugin.onunload();
    Notice.shown.length = 0;
    requestUrlMock.calls.length = 0;
    const next = boot(dataJsonOf(device), disk);
    await next.plugin.onload();
    expect(Notice.shown).not.toContain(RECOVERY_PAUSED_NOTICE);
    layoutReady(next.app);
    await elapse(10);
    expect(headCalls()).toBe(1);
  });

  it("offers the resume command only while paused", async () => {
    const { disk, dataJson } = await launchAndKillMidPass();
    const device = boot(dataJson, disk);
    await device.plugin.onload();
    const command = (device.plugin as unknown as {
      commands: { id: string; name: string; checkCallback?: (checking: boolean) => boolean | void }[];
    }).commands.find((c) => c.id === "sync-resume-automatic");
    expect(command?.name).toBe(RESUME_AUTOMATIC_LABEL);
    expect(command!.checkCallback!(true)).toBe(true);

    command!.checkCallback!(false);
    await until(() => record(disk).paused === null, "the resume to persist");
    expect(command!.checkCallback!(true)).toBe(false);
  });

  it("exports the recovery record with the sync log while paused, without starting a pass", async () => {
    const { disk, dataJson } = await launchAndKillMidPass();
    const device = boot(dataJson, disk);
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
    expect(exported.paused?.interrupted.phase).toBe("head");
    expect(exported.loggingFailure).toBeNull();
    expect(headCalls()).toBe(0);
  });
});

// --- unload / rebuild ownership ---------------------------------------------------------

describe("marker ownership across unload", () => {
  it("does not clear the marker on unload, and a finishing old instance cannot overwrite the reload", async () => {
    const first = boot(data());
    let release!: () => void;
    first.server.hold = new Promise<void>((resolve) => (release = resolve));
    await first.plugin.onload();
    layoutReady(first.app);
    await until(() => headCalls() === 1, "the pass to reach the server");

    first.plugin.onunload();
    expect(record(first.app.vault.configFiles).active).not.toBeNull();

    // Plugin reload in the same process: the same disk.
    const disk = first.app.vault.configFiles;
    const second = boot(dataJsonOf(first), disk);
    await second.plugin.onload();
    expect(second.plugin.automaticSyncPaused).toBe(true);
    const writesBefore = second.app.vault.configWrites.length;
    const pausedRecord = disk.get(RECORD_PATH);

    // The old instance's pass now settles; it must not write over the new instance's record.
    release();
    await elapse(50);
    expect(first.app.vault.configWrites.at(-1)?.data).not.toContain("pass-complete");
    expect(disk.get(RECORD_PATH)).toBe(pausedRecord);
    expect(second.app.vault.configWrites.length).toBe(writesBefore);
    expect(record(disk).paused).not.toBeNull();
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

  it("recovers an unread active marker as a pause before a second explicit Resume", async () => {
    const interrupted = { startedAt: 8, phase: "merge" as const, phaseAt: 9 };
    const previous = storedRecovery({ active: interrupted });
    const disk = new Map([[RECORD_PATH, JSON.stringify(previous)]]);
    const device = boot(data({ syncOnStartup: false }), disk);
    device.app.vault.configFaults.read = new Error("temporary read failure");
    await device.plugin.onload();
    layoutReady(device.app);

    device.app.vault.configFaults = {};
    expect(await device.plugin.resumeAutomaticSync()).toBe(false);
    const recovered = record(disk);
    expect(recovered.active).toBeNull();
    expect(recovered.paused?.interrupted).toEqual(interrupted);
    expect(recovered.trace[0]).toEqual(previous.trace[0]);
    expect(recovered.trace.at(-1)?.event).toBe("recovery-paused");
    expect(device.plugin.recoveryPaused).toBe(true);
    expect(device.plugin.automaticSyncPaused).toBe(true);
    expect(Notice.shown).toContain(RECOVERY_PAUSED_NOTICE);

    expect(await device.plugin.resumeAutomaticSync()).toBe(true);
    expect(record(disk).paused).toBeNull();
    expect(record(disk).trace.some((entry) => entry.event === "recovery-paused")).toBe(true);
    expect(device.plugin.automaticSyncPaused).toBe(false);
  });

  it("re-establishes an unread stored pause before allowing Resume", async () => {
    const interrupted = { startedAt: 8, phase: "upload" as const, phaseAt: 9 };
    const previous = storedRecovery({ paused: { since: 10, interrupted } });
    const disk = new Map([[RECORD_PATH, JSON.stringify(previous)]]);
    const device = boot(data({ syncOnStartup: false }), disk);
    device.app.vault.configFaults.read = new Error("temporary read failure");
    await device.plugin.onload();
    layoutReady(device.app);

    device.app.vault.configFaults = {};
    expect(await device.plugin.resumeAutomaticSync()).toBe(false);
    expect(record(disk).paused).toEqual(previous.paused);
    expect(record(disk).trace[0]).toEqual(previous.trace[0]);
    expect(device.plugin.automaticSyncPaused).toBe(true);
    expect(await device.plugin.resumeAutomaticSync()).toBe(true);
    expect(record(disk).paused).toBeNull();
  });

  it("can recover a repaired parse failure without discarding its active marker", async () => {
    const disk = new Map([[RECORD_PATH, "{not json"]]);
    const device = boot(data({ syncOnStartup: false }), disk);
    await device.plugin.onload();
    layoutReady(device.app);
    const interrupted = { startedAt: 8, phase: "commit" as const, phaseAt: 9 };
    disk.set(RECORD_PATH, JSON.stringify(storedRecovery({ active: interrupted })));

    expect(await device.plugin.resumeAutomaticSync()).toBe(false);
    expect(record(disk).paused?.interrupted).toEqual(interrupted);
    expect(device.plugin.automaticSyncPaused).toBe(true);
  });

  it("does not clear a newly discovered interruption when its pause write fails", async () => {
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

    device.app.vault.configFaults = {};
    expect(await device.plugin.resumeAutomaticSync()).toBe(false);
    expect(record(disk).paused?.interrupted).toEqual(interrupted);
    expect(await device.plugin.resumeAutomaticSync()).toBe(true);
    expect(record(disk).paused).toBeNull();
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

  it("re-reads before manual Sync now, keeping a recovered interruption paused", async () => {
    const interrupted = { startedAt: 8, phase: "scan" as const, phaseAt: 9 };
    const disk = new Map([[RECORD_PATH, JSON.stringify(storedRecovery({ active: interrupted }))]]);
    const device = boot(data({ syncOnStartup: false }), disk);
    device.app.vault.configFaults.read = new Error("temporary read failure");
    await device.plugin.onload();
    layoutReady(device.app);

    device.app.vault.configFaults = {};
    await device.plugin.syncNow();
    expect(headCalls()).toBe(1);
    expect(record(disk).paused?.interrupted).toEqual(interrupted);
    expect(record(disk).active).toBeNull();
    expect(record(disk).trace.some((entry) => entry.event === "recovery-paused")).toBe(true);
    expect(device.plugin.automaticSyncPaused).toBe(true);
    expect(Notice.shown).toContain(RECOVERY_PAUSED_NOTICE);
  });

  it("keeps a running manual pass marked if Resume follows recovery of an unread record", async () => {
    const interrupted = { startedAt: 8, phase: "scan" as const, phaseAt: 9 };
    const disk = new Map([[RECORD_PATH, JSON.stringify(storedRecovery({ active: interrupted }))]]);
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
    expect(record(disk).paused).toBeNull();
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
    expect(statusText(device)).toContain(RECOVERY_PAUSED_STATUS);

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
    expect(headCalls()).toBe(1);
  });

  // PIN: owner 2026-09-25 — a logging-only failure must offer the settings resume row, not
  // just the command palette (Codex review finding #3, docs/260925-eval-CODEX_REVIEW_1_1_4.md).
  it("offers the settings resume row after a transient write failure mid-pass, and it restores automatic sync", async () => {
    const device = boot(data());
    let release!: () => void;
    device.server.hold = new Promise<void>((resolve) => (release = resolve));
    await device.plugin.onload();
    layoutReady(device.app);
    await until(() => headCalls() === 1, "the startup pass to reach the server");
    expect(record(device.app.vault.configFiles).active).not.toBeNull();

    // Storage fails while the pass runs: its checkpoints and its finish cannot be written.
    device.app.vault.configFaults.write = new Error("synthetic transient write failure");
    release();
    await until(() => device.plugin.automaticSyncPaused, "the failed checkpoint");
    for (let i = 0; i < 50; i++) await elapse(1);
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

    // Storage recovers; the row's button clears the failure and rewrites the record.
    device.app.vault.configFaults = {};
    await tab.containerEl.log.rows[rowAt].buttons[0].click();
    await until(
      () => {
        const r = recordOrNull(device.app.vault.configFiles);
        return r !== null && r.active === null && r.paused === null && r.lastCompleted !== null;
      },
      "the resumed record on disk"
    );
    expect(device.plugin.automaticSyncPaused).toBe(false);
    expect(tab.containerEl.log.settings.map((s) => s.name)).not.toContain(RESUME_AUTOMATIC_LABEL);

    // Automatic sync runs again.
    device.vault.content.set(PATHS[2], text(PATHS[2], 3));
    device.app.vault.fire("modify", { path: PATHS[2] });
    await elapse(DEBOUNCE_MS * 2);
    expect(headCalls()).toBe(2);
  });

  it.each([
    ["unparsable", "{not json"],
    ["another schema", JSON.stringify({ schema: "something-else", active: null })],
    ["an unknown trace event", JSON.stringify({
      schema: DIAGNOSTIC_SCHEMA, pluginVersion: "1", platform: "x", active: null, paused: null,
      lastCompleted: null, lastFailed: null, trace: [{ at: 1, event: "alpha-note.md" }],
    })],
  ])("stops automatic sync when the record is %s", async (_label, content) => {
    const disk = new Map([[RECORD_PATH, content]]);
    const device = boot(data(), disk);
    await device.plugin.onload();

    expect(Notice.shown).toContain(RECOVERY_LOG_FAILED_NOTICE);
    expect(Notice.shown).not.toContain(RECOVERY_PAUSED_NOTICE);
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
