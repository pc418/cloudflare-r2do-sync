// Group 5 — How and when it syncs: direction, timing, and the two knobs that decide how hard
// a pass works. The directional tests are the reason this group exists: a stubbed FakeServer
// suite cannot catch "pull-only quietly published a local edit" or "push-only deleted a file
// it never even looked at", because a stub has no real head to accidentally move. Everything
// here is verified against the server itself (GET /api/head, GET /api/manifests/:id,
// GET /api/settings) — a notice is evidence of nothing.
import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { Platform } from "../obsidian-fake";
import { DEFAULT_LANES, MAX_LANES } from "../../src/pool";
import { MAX_RETRY_ATTEMPTS } from "../../src/main";
import { LiveHarness, liveConfig, vaultRoot, type LiveConfig, type StartOptions } from "./harness";

const config = liveConfig("schedule");

// The sandbox is a persistent, real deployment reused across runs of this file (and across a
// prior interrupted run of this exact suite). A fixed literal like "base" or "from remote"
// would collide with what an earlier run already committed at the same path, so a pass that
// only republishes it looks like a no-op ("unchanged") instead of a fresh commit — and a test
// asserting "the head moved" would fail for a reason that has nothing to do with the plugin.
const RUN = Math.random().toString(36).slice(2, 10);

/** A second local directory against the SAME sandbox — a stand-in for another device. */
function altConfig(suffix: string): LiveConfig {
  return { ...config!, root: path.join(vaultRoot(), `schedule-${suffix}`) };
}

interface RawManifest {
  v: number;
  files?: Record<string, unknown>;
}

interface RawSettingsDoc {
  v: number;
  plain?: Record<string, unknown>;
}

async function fetchJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** GET /api/head straight from the server — proves what was actually published, not what a
 *  notice claims happened. */
async function serverHead(c: LiveConfig): Promise<string | null> {
  return (await fetchJson<{ head: string | null }>(`${c.url}/api/head`, c.token)).head;
}

async function serverManifest(c: LiveConfig, id: string): Promise<RawManifest> {
  return fetchJson<RawManifest>(`${c.url}/api/manifests/${id}`, c.token);
}

async function serverSettings(c: LiveConfig): Promise<RawSettingsDoc> {
  return fetchJson<RawSettingsDoc>(`${c.url}/api/settings`, c.token);
}

/**
 * Drains the async chain `saveSettings()` starts (persist, timer restart, engine rebuild).
 * The fake input's "blur" event fires that chain fire-and-forget (`void commit()`), so a test
 * that immediately depends on the rebuilt engine — not just the settings value, which updates
 * synchronously, before `saveSettings()`'s first `await` — needs to give it real event-loop
 * turns first. `harness.waitFor` needs a condition to poll; nothing public exposes "the engine
 * finished rebuilding", so this drains blind instead. Kept local to this file.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * `plugin.intervals` is the fake `Plugin` base class's registration log. The harness's own
 * `RecordedPlugin` narrowing (see harness.ts) does not expose it — no other group needed it —
 * so this group casts it directly, the same way harness.ts casts its own `recorded` surface.
 */
function intervalsOf(h: LiveHarness): unknown[] {
  return (h.plugin as unknown as { intervals: unknown[] }).intervals;
}

describe.skipIf(config === null)("How and when it syncs", () => {
  let harnesses: LiveHarness[] = [];

  /** Starts a harness and registers it for teardown, so a multi-device test never leaks one. */
  async function open(c: LiveConfig, options?: StartOptions): Promise<LiveHarness> {
    const h = await LiveHarness.start(c, options);
    harnesses.push(h);
    return h;
  }

  afterEach(async () => {
    for (const h of harnesses) await h.dispose();
    harnesses = [];
    Platform.isMobile = false;
  });

  it("Pull-only applies a remote change but never publishes a local edit", async () => {
    const c = config!;

    // The device under test publishes a baseline, so it and the "other device" below share
    // an ancestor to three-way merge against.
    const device = await open(c, { files: { "shared.md": `base ${RUN}` } });
    await device.plugin.syncNow();
    const baseHead = await serverHead(c);
    expect(baseHead).not.toBeNull();

    // A second device, over its own directory, adds a file the device under test has never
    // seen. It does not touch shared.md, so the merge below has nothing to reconcile — the
    // point of this test is direction, not merge behaviour (sync.spec.ts covers that).
    const editor = await open(altConfig("pull-remote"), {
      persisted: { settings: { deviceName: "remote-editor" } },
    });
    await editor.plugin.syncNow(); // pulls shared.md
    await editor.write("remote-new.md", `from remote ${RUN}`);
    await editor.plugin.syncNow(); // publishes remote-new.md
    const remoteHead = await serverHead(c);
    expect(remoteHead).not.toBeNull();
    expect(remoteHead).not.toBe(baseHead);

    // Switch direction through the real control, then make an unpublished local edit.
    device.render();
    await device.row("Sync direction").dropdowns[0].change("pull-only");
    expect(device.plugin.settings.syncMode).toBe("pull-only");
    await device.write("shared.md", `local-edit ${RUN}`);

    await device.plugin.syncNow();

    // The remote addition was applied locally...
    expect(await device.read("remote-new.md")).toBe(`from remote ${RUN}`);
    // ...the local edit survives on disk (pull-only does not overwrite a pure local change)...
    expect(await device.read("shared.md")).toBe(`local-edit ${RUN}`);
    // ...but it was never published: pull-only never commits, so the head is exactly where
    // the editor left it — not a new snapshot carrying the local edit.
    expect(await serverHead(c)).toBe(remoteHead);
    const manifest = await serverManifest(c, remoteHead!);
    expect(manifest.files?.["remote-new.md"]).toBeDefined();
  });

  it("Push-only publishes a local file without pulling or deleting a remote-only file", async () => {
    const c = config!;

    // Seed the remote with a file the push-only device never had locally.
    const seed = await open(altConfig("push-seed"), {
      files: { "remote-only-push.md": `seeded from another device ${RUN}` },
      persisted: { settings: { deviceName: "seed-device" } },
    });
    await seed.plugin.syncNow();
    const seededHead = await serverHead(c);
    expect(seededHead).not.toBeNull();

    const pushDevice = await open(c, {
      files: { "pushdevice-local.md": `only on the push-only device ${RUN}` },
    });
    pushDevice.render();
    // The dropdown's stored VALUE is "push-only"; "Push-only (backup)" is only its label.
    await pushDevice.row("Sync direction").dropdowns[0].change("push-only");
    expect(pushDevice.plugin.settings.syncMode).toBe("push-only");

    await pushDevice.plugin.syncNow();

    // Never pulled: the remote-only file must not land on this device's disk.
    expect(await pushDevice.files()).toEqual(["pushdevice-local.md"]);

    // Published, and the remote-only file is still there — push-only never writes local
    // files, but that must not mean it silently drops what it did not touch.
    const newHead = await serverHead(c);
    expect(newHead).not.toBeNull();
    expect(newHead).not.toBe(seededHead);
    const manifest = await serverManifest(c, newHead!);
    expect(manifest.files?.["pushdevice-local.md"]).toBeDefined();
    expect(manifest.files?.["remote-only-push.md"]).toBeDefined();
  });

  it("Debounce (seconds) accepts its full range, refuses outside it, and stores a number", async () => {
    const harness = await open(config!);
    harness.render();
    const field = harness.row("Debounce (seconds)").texts[0];

    field.change("0");
    field.inputEl.fire("blur");
    expect(harness.plugin.settings.debounceSeconds).toBe(0);
    expect(typeof harness.plugin.settings.debounceSeconds).toBe("number");

    field.change("3600");
    field.inputEl.fire("blur");
    expect(harness.plugin.settings.debounceSeconds).toBe(3600);

    // Out of range is REFUSED, not rounded to the boundary — main.ts's `#number` control
    // documents this explicitly ("refused rather than rounded"). A value sliding to the
    // nearest bound would look identical to acceptance from the notice alone.
    field.change("3601");
    field.inputEl.fire("blur");
    expect(harness.plugin.settings.debounceSeconds).toBe(3600);
    expect(harness.notices().at(-1)).toMatch(/Debounce \(seconds\)/);

    field.change("-1");
    field.inputEl.fire("blur");
    expect(harness.plugin.settings.debounceSeconds).toBe(3600);
  });

  it("Periodic sync (minutes) accepts its range, registers an interval, and 0 clears it", async () => {
    const harness = await open(config!);
    harness.render();
    const field = harness.row("Periodic sync (minutes)").texts[0];

    field.change("1441");
    field.inputEl.fire("blur");
    expect(harness.plugin.settings.intervalMinutes).toBe(0); // unchanged: harness default is 0
    field.change("-1");
    field.inputEl.fire("blur");
    expect(harness.plugin.settings.intervalMinutes).toBe(0);

    // `plugin.intervals` only ever grows (registration is logged, never unregistered), so it
    // alone cannot prove the OLD timer was torn down when the interval changes. Wrap the
    // harness's own `window.clearInterval` to catch the call directly.
    const win = globalThis as unknown as { window: { clearInterval: (id: NodeJS.Timeout) => void } };
    const originalClear = win.window.clearInterval;
    let cleared = 0;
    win.window.clearInterval = (id) => {
      cleared++;
      originalClear(id);
    };

    // The 30-second status-bar refresh registers unconditionally at onload, so the baseline
    // is 1, not 0 — asserted against a captured baseline rather than a literal.
    const baseline = intervalsOf(harness).length;
    field.change("1");
    field.inputEl.fire("blur");
    expect(harness.plugin.settings.intervalMinutes).toBe(1);
    // `#restartAutoSyncTimer` runs after an `await` inside `saveSettings()`, which the fake
    // input's fire-and-forget "blur" event does not wait for — poll rather than assert
    // immediately, or this races the plugin's own async settings save.
    await harness.waitFor(() => intervalsOf(harness).length === baseline + 1);

    field.change("0");
    field.inputEl.fire("blur");
    expect(harness.plugin.settings.intervalMinutes).toBe(0);
    await harness.waitFor(() => cleared === 1); // the old timer was cleared, not abandoned
    expect(intervalsOf(harness)).toHaveLength(baseline + 1); // and no replacement registered
  });

  it("Sync on startup runs a pass after layout-ready, never before", async () => {
    const harness = await open(config!, {
      holdLayout: true,
      persisted: { settings: { syncOnStartup: true } },
    });

    // onload() has already run. If a pass ran before layout-ready, this is where it would show.
    expect(harness.http.calls).toBe(0);

    harness.app.workspace.fireLayoutReady();
    await harness.waitFor(() => harness.http.calls > 0, { label: "the startup pass to start" });
    await harness.waitFor(() => harness.notices().some((n) => /R2DO Sync/.test(n)), {
      label: "the startup pass to finish",
    });
  });

  it("Sync hotkey row renders on desktop and disappears on mobile", async () => {
    const harness = await open(config!);

    harness.render();
    expect(() => harness.row("Sync hotkey")).not.toThrow();

    Platform.isMobile = true;
    harness.render();
    expect(() => harness.row("Sync hotkey")).toThrow();
  });

  it("Parallel lanes clamps to its range and never reaches the shared settings document", async () => {
    const c = config!;
    // syncSettings is off by default in this harness (every other test in this file relies on
    // that, to avoid a previous test's published policy silently overwriting this one's mid
    // pass) — this is the one test that is actually about the shared document, so it turns
    // the real control back on.
    const harness = await open(c, { persisted: { settings: { syncSettings: true } } });
    harness.render();
    const field = harness.row("Parallel lanes").texts[0];

    field.change("0");
    field.inputEl.fire("blur");
    expect(harness.plugin.settings.lanes).toBe(DEFAULT_LANES);
    expect(harness.notices().at(-1)).toMatch(/Parallel lanes/);

    field.change(String(MAX_LANES + 1));
    field.inputEl.fire("blur");
    expect(harness.plugin.settings.lanes).toBe(DEFAULT_LANES);

    field.change(String(MAX_LANES));
    field.inputEl.fire("blur");
    expect(harness.plugin.settings.lanes).toBe(MAX_LANES);
    expect(typeof harness.plugin.settings.lanes).toBe("number");

    // `saveSettings()`'s engine rebuild runs after an `await`, which the fake input's
    // fire-and-forget "blur" event does not wait for — settle before syncing, or `syncNow()`
    // can race a scheduler that has been retired but not yet rebuilt.
    await settle();

    // A real pass pushes the shared document now that syncSettings is on. Lanes must never be
    // in it: `settings-doc.ts` excludes it by name because a phone and a desktop want
    // different widths, and it is worth proving that promise against a real published doc
    // rather than only against `extractSharedSettings`'s own unit test.
    await harness.plugin.syncNow();
    const doc = await serverSettings(c);
    expect(doc.plain).toBeDefined();
    expect(doc.plain).not.toHaveProperty("lanes");
    // Sanity: a populated document, not one that trivially lacks "lanes" because it lacks
    // everything.
    expect(typeof doc.plain?.debounceSeconds).toBe("number");
  });

  it("Automatic retries accepts 0..max, and 0 means exactly one attempt on a transport failure", async () => {
    const harness = await open(config!);
    harness.render();
    const field = harness.row("Automatic retries").texts[0];

    field.change("-1");
    field.inputEl.fire("blur");
    expect(harness.plugin.settings.retryAttempts).toBe(3); // shipped default, unchanged
    field.change(String(MAX_RETRY_ATTEMPTS + 1));
    field.inputEl.fire("blur");
    expect(harness.plugin.settings.retryAttempts).toBe(3);

    field.change("0");
    field.inputEl.fire("blur");
    expect(harness.plugin.settings.retryAttempts).toBe(0);
    expect(typeof harness.plugin.settings.retryAttempts).toBe("number");

    field.change(String(MAX_RETRY_ATTEMPTS));
    field.inputEl.fire("blur");
    expect(harness.plugin.settings.retryAttempts).toBe(MAX_RETRY_ATTEMPTS);

    // Precision test for 0: an unreachable host fails every request, so the pass's own first
    // call (GET /api/head) throws immediately. With retryAttempts 0 the scheduler's retry
    // budget is empty, so it must give up after that one call rather than falling back to its
    // own built-in default of three.
    const unreachable = await open(altConfig("retries-unreachable"), {
      persisted: { settings: { serverUrl: "http://127.0.0.1:1", retryAttempts: 0 } },
    });
    await unreachable.plugin.syncNow();
    expect(unreachable.http.calls).toBe(1);
  });
});
