// Live end-to-end harness: the real plugin, real files, a real Worker.
//
// Everything else in plugin/test/ runs against an in-memory FakeServer, which is the right
// trade for logic. It cannot answer the question this harness exists for: does pressing the
// button in the settings page do the thing, against a Worker that was actually deployed. The
// two substitutions the ordinary tests make — a stubbed `requestUrl` and a `FakeVault` — are
// exactly the two that would hide a wiring bug, so this file removes both and keeps the rest.
//
// What is still a stand-in: Obsidian itself. `../obsidian-fake` models the plugin API surface,
// so this proves the plugin's own behaviour, not Obsidian's rendering of it.
//
// Requires a deployed sandbox Worker. NEVER point it at the production URL: several groups
// force-push, reroot, and re-key the whole vault. `liveConfig()` refuses a URL that is not
// explicitly marked as the sandbox.
import { readdirSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AppWorkspace,
  Modal,
  Notice,
  TFile,
  TFolder,
  requestUrlMock,
  type ButtonComponent,
  type FakeElement,
  type RecordedEvent,
  type RenderLog,
  type Setting,
} from "../obsidian-fake";
import LogSyncPlugin from "../../src/main";

/** Where the sandbox credentials come from. Written by scripts/sandbox.mjs, never `.env`. */
export interface LiveConfig {
  url: string;
  token: string;
  /** Vault root for this run. Each group gets its own directory under ./testvault. */
  root: string;
}

/**
 * The sandbox is opt-in and self-identifying. An absent variable skips the suite; a present
 * one that does not name a sandbox Worker is a mistake worth stopping on, because the
 * difference between the two targets is somebody's real notes.
 */
export const SANDBOX_MARK = "-sandbox";

/**
 * A group's own sandbox when it has one, the shared default otherwise.
 *
 * One deployment is one vault with one head, so a group that reroots or re-keys would
 * invalidate every other group's assumptions about history. Those groups get their own Worker
 * (`node scripts/sandbox.mjs --suffix <group>`); the rest share.
 */
export function liveConfig(group: string): LiveConfig | null {
  const key = `_${group.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const url = (process.env[`R2DO_LIVE_URL${key}`] ?? process.env.R2DO_LIVE_URL)?.trim();
  const token = (process.env[`R2DO_LIVE_TOKEN${key}`] ?? process.env.R2DO_LIVE_TOKEN)?.trim();
  if (!url || !token) return null;

  const host = new URL(url).hostname;
  const script = host.slice(0, host.indexOf("."));
  // The sandbox and the real Worker share a configured name and differ only by this marker,
  // which `scripts/sandbox.mjs` puts on every throwaway it deploys. Matching on the marker
  // rather than on the product name means a rename cannot quietly re-point the suite.
  const isSandbox =
    host.endsWith(".workers.dev") &&
    (script.endsWith(SANDBOX_MARK) || script.includes(`${SANDBOX_MARK}-`));
  if (!isSandbox) {
    throw new Error(
      `R2DO_LIVE_URL must be a sandbox Worker — its name must carry "${SANDBOX_MARK}" — not ${host}.\n` +
        "These tests force-push, reroot and re-key the whole vault they run against."
    );
  }
  return { url, token, root: path.join(vaultRoot(), group) };
}

export function vaultRoot(): string {
  return process.env.R2DO_LIVE_VAULT?.trim() || path.resolve(import.meta.dirname, "../../../testvault");
}

// ---------------------------------------------------------------------------
// Real files
// ---------------------------------------------------------------------------

interface AdapterStat {
  type: "file" | "folder";
  size: number;
  mtime: number;
  ctime: number;
}

/**
 * `DataAdapter` over a real directory. Vault-relative POSIX paths in, real files out.
 *
 * The plugin reaches the filesystem through exactly fourteen calls (`ObsidianVault`), so this
 * models those and refuses everything else rather than growing a plausible-looking shim for
 * surfaces nothing exercises.
 */
export class DiskAdapter {
  constructor(readonly root: string) {}

  #real(rel: string): string {
    const full = path.resolve(this.root, rel);
    const inside = full === this.root || full.startsWith(this.root + path.sep);
    if (!inside) throw new Error(`path escapes the vault: ${rel}`);
    return full;
  }

  async list(folder: string): Promise<{ files: string[]; folders: string[] }> {
    const entries = await readdir(this.#real(folder), { withFileTypes: true });
    const files: string[] = [];
    const folders: string[] = [];
    for (const entry of entries) {
      const rel = folder === "" ? entry.name : `${folder}/${entry.name}`;
      if (entry.isDirectory()) folders.push(rel);
      else if (entry.isFile()) files.push(rel);
      // Anything else (symlink, socket) is not a vault file. Obsidian does not list them
      // either, and inventing an answer here would make the walk lie about the vault.
    }
    return { files, folders };
  }

  async stat(rel: string): Promise<AdapterStat | null> {
    try {
      const s = await stat(this.#real(rel));
      return {
        type: s.isDirectory() ? "folder" : "file",
        size: s.size,
        mtime: Math.floor(s.mtimeMs),
        ctime: Math.floor(s.birthtimeMs || s.ctimeMs),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async readBinary(rel: string): Promise<ArrayBuffer> {
    const buf = await readFile(this.#real(rel));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }

  async writeBinary(rel: string, data: ArrayBuffer): Promise<void> {
    await writeFile(this.#real(rel), Buffer.from(data));
  }

  async mkdir(rel: string): Promise<void> {
    await mkdir(this.#real(rel), { recursive: true });
  }

  /**
   * False on purpose, exercising the fallback: the system trash is unavailable on mobile and
   * on desktops without a desktop session, so `trashLocal` is the path that has to work.
   */
  async trashSystem(): Promise<boolean> {
    return false;
  }

  /** Obsidian's local trash: `.trash/` inside the vault, which the default excludes skip. */
  async trashLocal(rel: string): Promise<void> {
    const target = path.posix.join(".trash", rel);
    await mkdir(path.dirname(this.#real(target)), { recursive: true });
    await rename(this.#real(rel), this.#real(target));
  }
}

/** The `Vault` surface the plugin touches, over a real directory. */
export class DiskVault {
  configDir = ".obsidian";
  readonly events: RecordedEvent[] = [];
  readonly adapter: DiskAdapter;

  constructor(readonly root: string) {
    this.adapter = new DiskAdapter(root);
  }

  on(name: string, handler: (...args: unknown[]) => unknown): RecordedEvent {
    const event = { target: "vault", name, handler };
    this.events.push(event);
    return event;
  }
  off(): void {}

  /** Test helper: fire a vault event the way the app would, to feed the dirty-path journal. */
  fire(name: string, ...args: unknown[]): void {
    for (const event of this.events.filter((e) => e.name === name)) event.handler(...args);
  }

  /** Used by the settings page's match counts, so it has to be the real listing. */
  getFiles(): { path: string }[] {
    return walkSync(this.root).map((p) => ({ path: p }));
  }

  async create(rel: string, contents: string): Promise<TFile> {
    const full = path.resolve(this.root, rel);
    // `create` fails on an existing path in Obsidian; the report writer relies on the throw.
    if (await exists(full)) throw new Error(`file already exists: ${rel}`);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents);
    return Object.assign(new TFile(), { path: rel });
  }

  async createFolder(rel: string): Promise<TFolder> {
    await mkdir(path.resolve(this.root, rel), { recursive: true });
    return Object.assign(new TFolder(), { path: rel });
  }

  getAbstractFileByPath(rel: string): TFile | TFolder | null {
    const full = path.resolve(this.root, rel);
    const s = statSyncOrNull(full);
    if (s === null) return null;
    const node = s.isDirectory() ? new TFolder() : new TFile();
    return Object.assign(node, { path: rel });
  }
}

export class LiveApp {
  readonly vault: DiskVault;
  readonly workspace = new AppWorkspace();
  constructor(root: string) {
    this.vault = new DiskVault(root);
  }
}

// ---------------------------------------------------------------------------
// Real network
// ---------------------------------------------------------------------------

/**
 * `requestUrl` over Node's fetch. Obsidian's version returns a settled response whose body is
 * already read and whose `json` throws on a non-JSON body, so this does the same: a lazily
 * parsing getter, not an eager parse that would turn every blob download into a syntax error.
 */
export function installLiveHttp(): { calls: number } {
  const counter = { calls: 0 };
  requestUrlMock.impl = async (req: unknown) => {
    const { url, method, headers, body } = req as {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string | ArrayBuffer;
    };
    counter.calls += 1;
    const res = await fetch(url, { method: method ?? "GET", headers, body: body as BodyInit });
    const buffer = await res.arrayBuffer();
    const text = new TextDecoder().decode(buffer);
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      text,
      arrayBuffer: buffer,
      get json(): unknown {
        return JSON.parse(text) as unknown;
      },
    };
  };
  return counter;
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

/** What the fake `Plugin` base class records, exposed through `harness.recorded`. */
export interface RecordedPlugin {
  settingTabs: { containerEl: FakeElement; display(): void; hide(): void }[];
  commands: {
    id: string;
    name: string;
    callback?: () => unknown;
    checkCallback?: (checking: boolean) => boolean | void;
  }[];
  ribbonIcons: { icon: string; title: string; onClick: () => unknown }[];
  statusBarItems: FakeElement[];
  /** Grows only — the fake never removes on clear, so "still scheduled" needs the id itself. */
  intervals: unknown[];
  protocolHandlers: Map<string, (params: Record<string, string>) => unknown>;
  persisted: unknown;
  saves: unknown[];
  runCommand(id: string): unknown;
}

export interface StartOptions {
  /** Seed files written into the vault before onload, as path → contents. */
  files?: Record<string, string>;
  /** Persisted `data.json`. Merged over the credentials, so a test can override anything. */
  persisted?: Record<string, unknown>;
  /** Skip `onLayoutReady`, for tests that assert what has *not* run yet. */
  holdLayout?: boolean;
}

export class LiveHarness {
  readonly app: LiveApp;
  readonly plugin: LogSyncPlugin;
  readonly http: { calls: number };

  private constructor(
    readonly config: LiveConfig,
    app: LiveApp,
    plugin: LogSyncPlugin,
    http: { calls: number }
  ) {
    this.app = app;
    this.plugin = plugin;
    this.http = http;
  }

  static async start(config: LiveConfig, options: StartOptions = {}): Promise<LiveHarness> {
    // A group owns its directory outright. Reusing one across runs would make a failure
    // depend on the previous run's leftovers, which is the opposite of what this proves.
    await rm(config.root, { recursive: true, force: true });
    await mkdir(config.root, { recursive: true });
    for (const [rel, contents] of Object.entries(options.files ?? {})) {
      const full = path.resolve(config.root, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, contents);
    }

    Modal.shown.length = 0;
    Notice.shown.length = 0;
    requestUrlMock.calls.length = 0;
    const http = installLiveHttp();
    installTimers();

    const app = new LiveApp(config.root);
    const plugin = new LogSyncPlugin(app as never, { id: "cloudflare-rdo-sync", version: "live" } as never);
    (plugin as unknown as RecordedPlugin).persisted = {
      settings: {
        serverUrl: config.url,
        accessToken: config.token,
        deviceName: "live-harness",
        // Nothing syncs unless a test asks it to. Real timers are running (the plugin does
        // real waits, so fake ones would hang it), which means a periodic pass left enabled
        // would land in the middle of some other group's assertions against a shared head.
        // Groups that are *about* these settings override them.
        syncOnStartup: false,
        intervalMinutes: 0,
        // The MAXIMUM, not zero. Zero is "no delay" — every `harness.write` fires a vault
        // event, and the journal would start a real pass immediately, republishing or
        // reverting the file the test just staged, mid-assertion. The point is that no pass
        // runs unless a test asks for one, and the way to say that is a delay no test reaches.
        debounceSeconds: 3600,
        // The shipped defaults are `encrypted` with an empty key and an unacknowledged
        // first-sync gate — correct for a real device, and unusable for a test vault: no
        // group could publish anything. Plaintext is also the more demanding choice here,
        // because a plaintext vault's `FileEntry` reaches the server in the clear against a
        // `.strict()` schema, which is exactly the surface where an added field breaks sync.
        // The encryption group overrides all three and drives the real transitions.
        encryptionMode: "plaintext",
        masterKeyBackedUp: true,
        firstSyncAcknowledged: true,
        // Off, or a group cannot test its own toggles. Shared settings are published to the
        // vault and pulled back mid-pass, and every group shares one head under one device
        // name — so with this on, the previous test's published `notifyOnSync` (or conflict
        // mode, or protect percent) silently overwrites the value the current test just set,
        // in the middle of the very sync it is asserting about. The "This device" group turns
        // it back on deliberately, which is the only place it is the subject rather than a
        // confounder.
        syncSettings: false,
        ...((options.persisted?.settings as Record<string, unknown>) ?? {}),
      },
      ...Object.fromEntries(Object.entries(options.persisted ?? {}).filter(([k]) => k !== "settings")),
    };

    await plugin.onload();
    if (options.holdLayout !== true) app.workspace.fireLayoutReady();
    return new LiveHarness(config, app, plugin, http);
  }

  // -- settings page ---------------------------------------------------------

  /**
   * The fake `Plugin`'s recording surface. `LogSyncPlugin` extends the *real* `obsidian`
   * Plugin as far as the type checker is concerned — the substitution is a vitest alias, not
   * a type-level one — so these members do not exist on its declared type. Narrowed once
   * here, the way `plugin/test/lifecycle.spec.ts` does it, rather than in every spec.
   */
  get recorded(): RecordedPlugin {
    return this.plugin as unknown as RecordedPlugin;
  }

  get tab(): { containerEl: FakeElement; display(): void; hide(): void } {
    const tab = this.recorded.settingTabs[0];
    if (tab === undefined) throw new Error("the plugin registered no settings tab");
    return tab;
  }

  /** Renders the settings page and returns what it drew. */
  render(): RenderLog {
    this.tab.display();
    return this.tab.containerEl.log;
  }

  row(name: string): Setting {
    const log = this.tab.containerEl.log;
    const at = log.settings.findIndex((s) => s.name === name);
    if (at === -1) {
      throw new Error(`no settings row named "${name}"; rendered: ${log.settings.map((s) => s.name).join(", ")}`);
    }
    return log.rows[at];
  }

  /** The button on a row, by row name and (when a row has several) its label. */
  button(rowName: string, label?: string): ButtonComponent {
    const buttons = this.row(rowName).buttons;
    const found = label === undefined ? buttons[0] : buttons.find((b) => b.text === label);
    if (found === undefined) {
      throw new Error(`row "${rowName}" has no button ${label ?? "(any)"}; has: ${buttons.map((b) => b.text).join(", ")}`);
    }
    return found;
  }

  // -- modals ----------------------------------------------------------------

  /**
   * Waits for a condition instead of sleeping through one.
   *
   * A fixed delay is a guess about a network round trip, and the guess is wrong under load —
   * which reads as flakiness in the plugin rather than in the test.
   */
  async waitFor(
    predicate: () => boolean | Promise<boolean>,
    { timeout = 20_000, label = "condition" }: { timeout?: number; label?: string } = {}
  ): Promise<void> {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new Error(`timed out after ${timeout}ms waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /**
   * Runs something that should raise a window, and returns that window once it is drawn.
   *
   * Several of the plugin's buttons are wired fire-and-forget (`() => void this.plugin.x()`),
   * so awaiting the click resolves before anything opens — and the ones that do await still
   * compute a preview over the network first. Both cases are the same wait.
   */
  async opens(action: () => unknown, { timeout = 20_000 }: { timeout?: number } = {}): Promise<Modal> {
    const before = Modal.shown.length;
    await action();
    await this.waitFor(() => Modal.shown.length > before, { timeout, label: "a window to open" });
    return Modal.shown[Modal.shown.length - 1];
  }

  /**
   * Blob GETs so far. The restore invariants are as much about cost as correctness — content
   * already identical must be recognised without downloading it — and total request count
   * cannot say that, because inspecting a snapshot legitimately costs a manifest fetch.
   */
  blobReads(): number {
    return requestUrlMock.calls.filter((call) => {
      const { url, method } = (call ?? {}) as { url?: string; method?: string };
      return (method ?? "GET").toUpperCase() === "GET" && (url ?? "").includes("/api/blobs/");
    }).length;
  }

  /** The window on top, which is the one a person would be answering. */
  top<T extends Modal = Modal>(): T {
    const modal = Modal.shown.at(-1);
    if (modal === undefined) throw new Error("no modal was opened");
    return modal as T;
  }

  /** A modal's button by label, wherever in its body it was drawn. */
  modalButton(label: string): ButtonComponent {
    const log = this.top().contentEl.log;
    for (const row of [...log.rows].reverse()) {
      const found = row.buttons.find((b) => b.text === label);
      if (found !== undefined) return found;
    }
    throw new Error(`no modal button labelled "${label}"`);
  }

  /** Types the confirmation phrase a guarded action requires, then confirms it. */
  async confirm(phrase: string | null, label: string): Promise<void> {
    const modal = this.top();
    if (phrase !== null) {
      const field = modal.contentEl.log.rows.flatMap((r) => r.texts).at(-1);
      if (field === undefined) throw new Error("the confirmation asked for no phrase");
      // `change` is what typing is: it fires the handler that re-enables the confirm button.
      field.change(phrase);
    }
    await this.modalButton(label).click();
  }

  // -- observation -----------------------------------------------------------

  notices(): string[] {
    return [...Notice.shown];
  }

  /** Every file in the vault, vault-relative, sorted — the same order the engine walks. */
  async files(): Promise<string[]> {
    return walkSync(this.config.root).sort((a, b) => a.localeCompare(b));
  }

  async read(rel: string): Promise<string> {
    return readFile(path.resolve(this.config.root, rel), "utf8");
  }

  async write(rel: string, contents: string): Promise<void> {
    const full = path.resolve(this.config.root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents);
    // What Obsidian would have told the plugin. Without it the dirty-path journal never
    // learns about the edit, and the next pass is an audit for the wrong reason.
    this.app.vault.fire("modify", { path: rel });
  }

  /** Deletes a file the way the app would report it, journal event included. */
  async remove(rel: string): Promise<void> {
    await rm(path.resolve(this.config.root, rel));
    this.app.vault.fire("delete", { path: rel });
  }

  async dispose(): Promise<void> {
    // `Plugin.onunload` is declared `void` on the base class, which is all the checker sees,
    // but this plugin's is async and drains in-flight work. Dropping the promise would let a
    // pass keep running into the next test.
    await Promise.resolve(this.plugin.onunload() as unknown);
    // Obsidian clears what a plugin registered when it unloads; nothing here does, and a
    // 30-second status refresh left running keeps the vitest process alive after the run.
    for (const id of intervals) clearInterval(id);
    intervals.length = 0;
    requestUrlMock.impl = null;
  }
}

// ---------------------------------------------------------------------------

/** Interval ids the plugin registered through `window`, so dispose can stop them. */
const intervals: NodeJS.Timeout[] = [];

/**
 * `window` and `document`, which the plugin uses for its status-bar refresh, its debounce and
 * its mobile-resume check. Real timers, deliberately: a live pass does real waits (the minimum
 * "syncing…" notice among them), and a fake clock nobody advances would hang the suite rather
 * than speed it up.
 */
function installTimers(): void {
  Object.assign(globalThis, {
    window: {
      setInterval: (fn: () => void, ms: number): NodeJS.Timeout => {
        const id = setInterval(fn, ms);
        intervals.push(id);
        return id;
      },
      clearInterval: (id: NodeJS.Timeout) => {
        clearInterval(id);
      },
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: NodeJS.Timeout) => {
        clearTimeout(id);
      },
    },
    document: { visibilityState: "visible" },
  });
}

function statSyncOrNull(full: string): { isDirectory(): boolean } | null {
  try {
    return statSync(full);
  } catch {
    return null;
  }
}

function walkSync(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkSync(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

async function exists(full: string): Promise<boolean> {
  try {
    await stat(full);
    return true;
  } catch {
    return false;
  }
}
