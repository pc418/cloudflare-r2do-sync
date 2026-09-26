import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LogSyncPlugin, { type Settings } from "../src/main";
import { LARGE_MARKDOWN_BYTES } from "../src/large-markdown";
import { sha256Hex } from "../src/hash";
import { LifecycleApp, Modal, Notice, TFile, TFolder, requestUrlMock } from "./obsidian-fake";

/**
 * The oversized-Markdown rename, driven through the plugin itself: load, layout-ready, vault
 * events, the scheduler's passes, the button and its command. Assertions are on the vault's
 * files and bytes, the requests the server saw (what a commit published) and the notices —
 * never on private fields.
 *
 * PIN (owner, 2026-09-25, docs/260925-fix-LARGE_MARKDOWN_PLUGIN_WORKER.md): default on,
 * Markdown strictly over 1.5 MiB becomes .txt by a real rename published by ordinary sync;
 * the button works with the setting off and without a server; nothing overwrites.
 */

const OVER = LARGE_MARKDOWN_BYTES + 1;
const DEBOUNCE_MS = 5000;

function bytesOf(size: number, tag: string): Uint8Array {
  const bytes = new Uint8Array(size).fill(0x62);
  bytes.set(new TextEncoder().encode(tag), 0);
  return bytes;
}

// --- environment --------------------------------------------------------------------------

function installGlobals(): void {
  // The plugin's own `window` timers are never fired here: nothing in this feature uses one,
  // and the scheduler's debounce runs on the global `setTimeout` that vitest fakes.
  let id = 1;
  const win = {
    setInterval: () => id++,
    clearInterval: () => {},
    setTimeout: () => id++,
    clearTimeout: () => {},
  };
  Object.assign(globalThis, { window: win, document: { visibilityState: "visible" } });
}

/** Runs pending promise work and any due scheduler timers. */
async function elapse(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(1);
}

/** Node's `setImmediate`, which vitest is not told to fake; untyped in this project's lib. */
const realImmediate = (globalThis as unknown as { setImmediate: (cb: () => void) => void })
  .setImmediate;

/**
 * Waits for a condition a pass settles. Hashing runs on WebCrypto, which completes on the real
 * event loop rather than on faked timers, so this yields to both.
 */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !done(); i++) {
    await vi.advanceTimersByTimeAsync(1);
    await new Promise<void>((resolve) => realImmediate(resolve));
  }
  expect(done()).toBe(true);
}

// --- an in-memory vault behind Obsidian's API ---------------------------------------------

interface MemoryVault {
  files: Map<string, Uint8Array>;
  folders: Set<string>;
  /** Paths Obsidian's file tree knows about. A pull's write is on disk before it is here. */
  indexed: Set<string>;
  /** Every completed move, in order, with which API made it. */
  renames: { from: string; to: string; via: "vault" | "adapter" }[];
  /** Holds a `Vault.rename` open, so another operation can be shown to wait for it. */
  gate: ((from: string) => Promise<void>) | null;
  /** Throws from `getFiles()` this many times, for the failure path. */
  getFilesFailures: number;
  indexOnWrite: boolean;
}

function ancestors(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

function memoryVault(
  app: LifecycleApp,
  files: Record<string, Uint8Array>,
  opts: { folders?: string[] } = {}
): MemoryVault {
  const vault: MemoryVault = {
    files: new Map(Object.entries(files)),
    folders: new Set(opts.folders ?? []),
    indexed: new Set(Object.keys(files).filter((p) => !p.split("/").some((s) => s.startsWith(".")))),
    renames: [],
    gate: null,
    getFilesFailures: 0,
    indexOnWrite: false,
  };
  for (const path of [...vault.files.keys(), ...vault.folders]) {
    for (const dir of ancestors(path)) vault.folders.add(dir);
  }
  const tfiles = new Map<string, TFile>();
  const tfile = (path: string): TFile => {
    let file = tfiles.get(path);
    if (file === undefined) {
      file = Object.assign(new TFile(), { path });
      tfiles.set(path, file);
    }
    return file;
  };
  const direct = (folder: string, of: Iterable<string>) => {
    const prefix = folder === "" ? "" : `${folder}/`;
    return [...of].filter((p) => p.startsWith(prefix) && p !== folder && !p.slice(prefix.length).includes("/"));
  };
  const occupied = (path: string) => vault.files.has(path) || vault.folders.has(path);
  const move = (from: string, to: string) => {
    const bytes = vault.files.get(from);
    if (bytes === undefined) throw new Error(`ENOENT ${from}`);
    vault.files.delete(from);
    vault.files.set(to, bytes);
  };

  app.vault.adapter = {
    list: async (folder: string) => ({
      files: direct(folder, vault.files.keys()).sort(),
      folders: direct(folder, vault.folders).sort(),
    }),
    stat: async (path: string) => {
      const bytes = vault.files.get(path);
      if (bytes !== undefined) return { type: "file", size: bytes.byteLength, mtime: 1, ctime: 1 };
      return vault.folders.has(path) ? { type: "folder", size: 0, mtime: 1, ctime: 1 } : null;
    },
    readBinary: async (path: string) => {
      const bytes = vault.files.get(path);
      if (bytes === undefined) throw new Error(`ENOENT ${path}`);
      return bytes.slice().buffer;
    },
    writeBinary: async (path: string, data: ArrayBuffer) => {
      vault.files.set(path, new Uint8Array(data));
      if (vault.indexOnWrite) vault.indexed.add(path);
    },
    mkdir: async (path: string) => {
      vault.folders.add(path);
    },
    trashSystem: async (path: string) => {
      vault.files.delete(path);
      vault.indexed.delete(path);
      return true;
    },
    // Disk-level, like the real adapter: Obsidian's tree is not told.
    rename: async (from: string, to: string) => {
      if (occupied(to)) throw new Error(`EEXIST ${to}`);
      move(from, to);
      vault.renames.push({ from, to, via: "adapter" });
    },
  } as never;

  const extra = {
    getFiles: () => {
      if (vault.getFilesFailures > 0) {
        vault.getFilesFailures--;
        throw new Error("file list unavailable");
      }
      return [...vault.indexed].filter((p) => vault.files.has(p)).map(tfile);
    },
    getAbstractFileByPath: (path: string) => {
      if (vault.indexed.has(path) && vault.files.has(path)) return tfile(path);
      return vault.folders.has(path) ? new TFolder() : null;
    },
    // Obsidian's own: refuses an occupied destination, moves the file, updates the TFile in
    // place and fires `rename` with the old path.
    rename: async (file: { path: string }, to: string) => {
      const from = file.path;
      if (vault.gate !== null) await vault.gate(from);
      if (occupied(to)) throw new Error("Destination file already exists!");
      move(from, to);
      vault.indexed.delete(from);
      vault.indexed.add(to);
      tfiles.delete(from);
      file.path = to;
      tfiles.set(to, file as TFile);
      vault.renames.push({ from, to, via: "vault" });
      app.vault.fire("rename", file, from);
    },
  };
  Object.assign(app.vault, extra);
  return vault;
}

/** Fires what Obsidian would for an edit to an indexed file. */
function edit(app: LifecycleApp, vault: MemoryVault, path: string, bytes: Uint8Array): void {
  vault.files.set(path, bytes);
  vault.indexed.add(path);
  const file = (app.vault as unknown as { getAbstractFileByPath(p: string): unknown }).getAbstractFileByPath(path);
  app.vault.fire("modify", file);
}

// --- a server -----------------------------------------------------------------------------

interface Entry {
  h: string;
  size: number;
  mtime: number;
}

interface Manifest {
  v: 1;
  id: string;
  parent: string | null;
  device: string;
  createdAt: string;
  files: Record<string, Entry>;
}

interface FakeServer {
  head: string | null;
  manifests: Map<string, Manifest>;
  blobs: Map<string, Uint8Array>;
  commits: Manifest[];
  requests: string[];
  /** Holds `/api/head` open, which holds the whole pass inside the scheduler's lane. */
  gateHead: (() => Promise<void>) | null;
}

async function entry(bytes: Uint8Array): Promise<Entry> {
  return { h: await sha256Hex(bytes), size: bytes.byteLength, mtime: 1 };
}

function fakeServer(head: string, manifests: Manifest[], blobs: Uint8Array[] = []): FakeServer {
  const server: FakeServer = {
    head,
    manifests: new Map(manifests.map((m) => [m.id, m])),
    blobs: new Map(),
    commits: [],
    requests: [],
    gateHead: null,
  };
  const ready = Promise.all(blobs.map(async (b) => server.blobs.set(await sha256Hex(b), b)));
  const json = (status: number, value: unknown) => ({
    status,
    text: JSON.stringify(value),
    json: value,
    headers: {},
  });
  requestUrlMock.impl = async (req) => {
    await ready;
    const r = req as { url: string; method?: string; body?: string | ArrayBuffer };
    const path = new URL(r.url).pathname;
    const method = r.method ?? "GET";
    server.requests.push(`${method} ${path}`);
    if (path === "/api/head") {
      if (server.gateHead !== null) await server.gateHead();
      return json(200, { head: server.head });
    }
    if (path === "/api/settings") return json(404, { error: { code: "not_found", message: "none" } });
    if (path.startsWith("/api/manifests/")) {
      const m = server.manifests.get(path.slice("/api/manifests/".length));
      return m === undefined ? json(404, { error: { code: "not_found", message: "none" } }) : json(200, m);
    }
    if (path === "/api/blobs/check") {
      const { hashes } = JSON.parse(r.body as string) as { hashes: string[] };
      return json(200, { missing: hashes.filter((h) => !server.blobs.has(h)) });
    }
    if (path.startsWith("/api/blobs/")) {
      const hash = path.slice("/api/blobs/".length);
      if (method === "PUT") {
        server.blobs.set(hash, new Uint8Array(r.body as ArrayBuffer));
        return json(200, {});
      }
      const bytes = server.blobs.get(hash);
      if (bytes === undefined) return json(404, { error: { code: "not_found", message: "none" } });
      return { status: 200, text: "", json: null, headers: {}, arrayBuffer: bytes.slice().buffer };
    }
    if (path === "/api/commit") {
      const { manifest } = JSON.parse(r.body as string) as { manifest: Manifest };
      server.manifests.set(manifest.id, manifest);
      server.commits.push(manifest);
      server.head = manifest.id;
      return json(200, { head: manifest.id });
    }
    throw new Error(`unexpected request ${method} ${path}`);
  };
  return server;
}

const headCalls = (server: FakeServer) => server.requests.filter((r) => r === "GET /api/head").length;

// --- the plugin ---------------------------------------------------------------------------

const CONFIGURED = {
  serverUrl: "https://vault.example.workers.dev",
  accessToken: "access-token",
  encryptionMode: "plaintext" as const,
};

async function syncedState(files: Record<string, Uint8Array>) {
  const entries: Record<string, Entry> = {};
  const inventory: Record<string, { path: string; size: number; mtime: number }> = {};
  for (const [path, bytes] of Object.entries(files)) {
    entries[path] = await entry(bytes);
    inventory[path] = { path, size: bytes.byteLength, mtime: 1 };
  }
  return { lastSyncedHead: "01HEAD", files: entries, keyId: null, lines: {}, inventory };
}

/** Every plugin a test built, unloaded afterwards so no pass outlives its test. */
const loaded: LogSyncPlugin[] = [];

function makePlugin(settings: Partial<Settings> | null, state: unknown = null) {
  const app = new LifecycleApp();
  const plugin = new LogSyncPlugin(app as never, { id: "cloudflare-rdo-sync", name: "R2DO Sync" } as never);
  loaded.push(plugin);
  (plugin as unknown as { persisted: unknown }).persisted =
    settings === null
      ? null
      : {
          settings: {
            ...CONFIGURED,
            firstSyncAcknowledged: true,
            syncOnStartup: false,
            syncSettings: false,
            retryAttempts: 0,
            intervalMinutes: 0,
            debounceSeconds: DEBOUNCE_MS / 1000,
            ...settings,
          },
          state,
          stateServerUrl: CONFIGURED.serverUrl,
        };
  return { plugin, app };
}

function layoutReady(app: LifecycleApp): void {
  for (const cb of app.workspace.layoutReady) cb();
}

/** A synced device whose server holds exactly its last snapshot. */
async function syncedDevice(files: Record<string, Uint8Array>, settings: Partial<Settings> = {}) {
  const state = await syncedState(files);
  const { plugin, app } = makePlugin(settings, state);
  const vault = memoryVault(app, files);
  const server = fakeServer("01HEAD", [
    { v: 1, id: "01HEAD", parent: null, device: "d", createdAt: "2026-09-25T00:00:00Z", files: state.files },
  ]);
  return { plugin, app, vault, server, state };
}

const lastSave = (plugin: LogSyncPlugin) => {
  const saves = (plugin as unknown as { saves: { state?: { files: Record<string, unknown> } }[] }).saves;
  return saves[saves.length - 1];
};

beforeEach(() => {
  installGlobals();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  Notice.shown.length = 0;
  Modal.shown.length = 0;
  requestUrlMock.impl = null;
  requestUrlMock.calls.length = 0;
});

afterEach(() => {
  for (const plugin of loaded.splice(0)) plugin.onunload();
  vi.useRealTimers();
});

// --- tests --------------------------------------------------------------------------------

describe("the setting", () => {
  it.each([
    ["absent", {}, true],
    ["not a boolean", { largeMarkdownAsText: "yes" as unknown as boolean }, true],
    ["off", { largeMarkdownAsText: false }, false],
  ])("is on by default, including when %s in data.json", async (_label, over, expected) => {
    const { plugin, app } = makePlugin(over);
    memoryVault(app, {});
    await plugin.onload();
    expect(plugin.settings.largeMarkdownAsText).toBe(expected);
  });

  it("is registered as a command named like the button", async () => {
    const { plugin, app } = makePlugin({});
    memoryVault(app, {});
    await plugin.onload();
    const commands = (plugin as unknown as { commands: { id: string; name: string }[] }).commands;
    expect(commands.find((c) => c.id === "rename-large-markdown")?.name).toBe(
      "Rename existing large Markdown"
    );
  });
});

describe("the load's sweep", () => {
  it("waits for layout-ready, renames in scope only, and starts no sync with startup sync off", async () => {
    const big = bytesOf(OVER, "big");
    const files = {
      "big.md": big,
      "notes/Loud.MD": bytesOf(OVER, "loud"),
      "edge.md": bytesOf(LARGE_MARKDOWN_BYTES, "edge"),
      "scan.pdf": bytesOf(OVER, "pdf"),
      "archive/old.md": bytesOf(OVER, "archived"),
      ".trash/gone.md": bytesOf(OVER, "trash"),
    };
    const { plugin, app, vault, server } = await syncedDevice(files, { excludes: ".trash/**\narchive/**" });
    await plugin.onload();

    // The vault-load burst: one event per existing file, and no rename for any of them.
    for (const path of vault.indexed) app.vault.fire("create", { path });
    await elapse(DEBOUNCE_MS * 2);
    expect(vault.renames).toEqual([]);

    layoutReady(app);
    await elapse(DEBOUNCE_MS * 2);

    expect(vault.renames).toEqual([
      { from: "big.md", to: "big.txt", via: "vault" },
      { from: "notes/Loud.MD", to: "notes/Loud.txt", via: "vault" },
    ]);
    expect(vault.files.get("big.txt")).toBe(big);
    expect([...vault.files.keys()].sort()).toEqual(
      [".trash/gone.md", "archive/old.md", "big.txt", "edge.md", "notes/Loud.txt", "scan.pdf"].sort()
    );
    // "Sync on startup" is off, and a rename is not a reason to override it.
    expect(server.requests).toEqual([]);
    expect(Notice.shown.join("\n")).toContain("renamed 2 Markdown files to .txt");
  });

  it("is journaled, so the next ordinary pass publishes a real move", async () => {
    const big = bytesOf(OVER, "big");
    const small = bytesOf(10, "small");
    const { plugin, app, vault, server, state } = await syncedDevice({ "big.md": big, "small.md": small });
    await plugin.onload();
    layoutReady(app);
    await elapse();
    expect(vault.files.has("big.txt")).toBe(true);

    // The rename rewrote nothing this device believes it synced: that is the pass's job.
    const saved = lastSave(plugin)?.state?.files ?? state.files;
    expect(Object.keys(saved).sort()).toEqual(["big.md", "small.md"]);
    expect(server.requests).toEqual([]);

    // An ordinary edit runs an incremental pass from the journal, not a full scan: it can only
    // see the move if the rename journaled both paths.
    edit(app, vault, "small.md", bytesOf(12, "small v2"));
    await elapse(DEBOUNCE_MS * 2);
    await until(() => server.commits.length > 0);

    expect(server.commits).toHaveLength(1);
    const published = server.commits[0].files;
    expect(Object.keys(published).sort()).toEqual(["big.txt", "small.md"]);
    expect(published["big.txt"].h).toBe(await sha256Hex(big));
    expect(server.commits[0].parent).toBe("01HEAD");
    // Listed nothing: the pass read only the paths it was told about.
    expect(server.requests).not.toContain("GET /api/manifests/01HEAD");
  });

  it("falls back to the pre-pass sweep when the startup attempt failed, and says so", async () => {
    const big = bytesOf(OVER, "big");
    const { plugin, app, vault, server } = await syncedDevice({ "big.md": big }, { syncOnStartup: true });
    vault.getFilesFailures = 1;
    await plugin.onload();
    layoutReady(app);
    await elapse(DEBOUNCE_MS);

    expect(Notice.shown.join("\n")).toContain("could not rename oversized Markdown: file list unavailable");
    // The startup pass converted it before the engine read the vault, and published the move.
    expect(vault.renames).toEqual([{ from: "big.md", to: "big.txt", via: "vault" }]);
    await until(() => server.commits.length > 0);
    expect(Object.keys(server.commits[0].files)).toEqual(["big.txt"]);
  });
});

describe("vault events", () => {
  it("renames a note that grows past the limit, then syncs it through the ordinary gates", async () => {
    const { plugin, app, vault, server } = await syncedDevice({ "grow.md": bytesOf(10, "g") });
    await plugin.onload();
    layoutReady(app);
    await elapse();
    expect(vault.renames).toEqual([]);

    const grown = bytesOf(OVER, "grown");
    edit(app, vault, "grow.md", grown);
    await elapse();
    expect(vault.renames).toEqual([{ from: "grow.md", to: "grow.txt", via: "vault" }]);

    await elapse(DEBOUNCE_MS * 2);
    await until(() => server.commits.length > 0);
    expect(server.commits).toHaveLength(1);
    expect(Object.keys(server.commits[0].files)).toEqual(["grow.txt"]);
    expect(server.commits[0].files["grow.txt"].h).toBe(await sha256Hex(grown));
  });

  it("checks only the event's path rather than scanning the vault again", async () => {
    const { plugin, app, vault } = await syncedDevice({ "a.md": bytesOf(10, "a") });
    await plugin.onload();
    layoutReady(app);
    await elapse();
    // Something the load's sweep would have caught, arriving unannounced afterwards.
    vault.files.set("sneaky.md", bytesOf(OVER, "s"));
    vault.indexed.add("sneaky.md");

    edit(app, vault, "a.md", bytesOf(11, "a2"));
    await elapse();
    expect(vault.renames).toEqual([]);
  });

  it("does nothing automatically when switched off, but the button still works", async () => {
    const big = bytesOf(OVER, "big");
    const { plugin, app, vault, server } = await syncedDevice({ "big.md": big }, { largeMarkdownAsText: false });
    await plugin.onload();
    layoutReady(app);
    edit(app, vault, "big.md", bytesOf(OVER + 1, "bigger"));
    await elapse(DEBOUNCE_MS * 2);
    await until(() => server.commits.length > 0);
    expect(vault.renames).toEqual([]);
    // The pass that edit started published the Markdown name unchanged.
    expect(Object.keys(server.commits[0].files)).toEqual(["big.md"]);

    Notice.shown.length = 0;
    await plugin.renameLargeMarkdownNow();
    expect(vault.renames).toEqual([{ from: "big.md", to: "big.txt", via: "vault" }]);
    expect(Notice.shown).toEqual([
      "R2DO Sync: looking for Markdown files larger than 1.5 MiB…",
      "R2DO Sync: renamed 1 Markdown file to .txt (big.md → big.txt)",
    ]);
  });

  it("switching it on sweeps the vault", async () => {
    const { plugin, app, vault } = await syncedDevice({ "big.md": bytesOf(OVER, "b") }, { largeMarkdownAsText: false });
    await plugin.onload();
    layoutReady(app);
    await elapse();
    expect(vault.renames).toEqual([]);

    await plugin.setLargeMarkdownAsText(true);
    await elapse();
    expect(vault.renames.map((r) => r.to)).toEqual(["big.txt"]);
  });
});

describe("after a pass", () => {
  async function pullingDevice(indexOnWrite: boolean) {
    const keep = bytesOf(20, "keep");
    const huge = bytesOf(OVER, "pulled");
    const state = await syncedState({ "keep.md": keep });
    const { plugin, app } = makePlugin({}, state);
    const vault = memoryVault(app, { "keep.md": keep });
    vault.indexOnWrite = indexOnWrite;
    const base: Manifest = {
      v: 1, id: "01HEAD", parent: null, device: "d", createdAt: "2026-09-25T00:00:00Z", files: state.files,
    };
    const remote: Manifest = {
      v: 1, id: "01REMOTE", parent: "01HEAD", device: "other", createdAt: "2026-09-25T01:00:00Z",
      files: { ...state.files, "in/huge.md": await entry(huge) },
    };
    const server = fakeServer("01REMOTE", [base, remote], [huge]);
    return { plugin, app, vault, server, huge };
  }

  it.each([
    [true, "vault"],
    [false, "adapter"],
  ] as const)(
    "renames a pulled oversized note before the next pass, which publishes the move (indexed: %s)",
    async (indexOnWrite, via) => {
      const { plugin, app, vault, server, huge } = await pullingDevice(indexOnWrite);
      await plugin.onload();
      layoutReady(app);
      await elapse();

      const pass = plugin.syncNow();
      await elapse();
      await pass;

      // Pulled, then renamed inside the same slot of the lane, with its bytes intact.
      expect(vault.renames).toEqual([{ from: "in/huge.md", to: "in/huge.txt", via }]);
      expect(vault.files.get("in/huge.txt")).toEqual(huge);
      expect(vault.files.has("in/huge.md")).toBe(false);
      // What this device synced is recorded as synced — under the name it was synced as.
      expect(Object.keys(lastSave(plugin)?.state?.files ?? {}).sort()).toEqual(["in/huge.md", "keep.md"]);
      expect(server.commits).toEqual([]);

      // A later ordinary pass was arranged, and it publishes the move against the pulled head.
      await elapse(DEBOUNCE_MS * 2);
      await until(() => server.commits.length > 0);
      expect(server.commits).toHaveLength(1);
      expect(server.commits[0].parent).toBe("01REMOTE");
      expect(Object.keys(server.commits[0].files).sort()).toEqual(["in/huge.txt", "keep.md"]);
      expect(server.commits[0].files["in/huge.txt"].h).toBe(await sha256Hex(huge));
    },
    // CPU-bound, not timer-bound: two passes hash and carry a note over 1.5 MiB. Measured 7-12 s
    // on a loaded machine against vitest's 5 s default.
    30_000
  );

  it("never renames onto a name that exists, and says which", async () => {
    const { plugin, app, vault, server } = await pullingDevice(true);
    const squatter = bytesOf(5, "mine");
    vault.files.set("in/Huge.TXT", squatter);
    vault.folders.add("in");
    await plugin.onload();
    layoutReady(app);
    await elapse();

    const pass = plugin.syncNow();
    await elapse();
    await pass;

    expect(vault.renames).toEqual([]);
    expect(vault.files.get("in/Huge.TXT")).toBe(squatter);
    expect(vault.files.has("in/huge.md")).toBe(true);
    expect(Notice.shown.join("\n")).toContain(
      'could not rename oversized Markdown: in/huge.md → in/huge.txt: "in/Huge.TXT" already exists with different letter case'
    );
    // The pass itself published this device's new local file; nothing published a rename that
    // did not happen, and no later pass was arranged for one.
    await elapse(DEBOUNCE_MS * 2);
    expect(server.commits).toHaveLength(1);
    expect(Object.keys(server.commits[0].files).sort()).toEqual(["in/Huge.TXT", "in/huge.md", "keep.md"]);
  });
});

describe("serialization with sync", () => {
  it("a pass waits for a rename in progress, and a rename waits for a pass", async () => {
    const big = bytesOf(OVER, "big");
    const { plugin, app, vault, server } = await syncedDevice({ "big.md": big, "other.md": bytesOf(OVER, "o") });
    let release = (): void => {};
    vault.gate = () => new Promise<void>((resolve) => (release = resolve));
    await plugin.onload();
    layoutReady(app); // the sweep starts and holds its first rename open
    await elapse();

    const pass = plugin.syncNow();
    await elapse();
    expect(headCalls(server)).toBe(0);

    vault.gate = null;
    release();
    await elapse();
    await pass;
    expect(headCalls(server)).toBe(1);
    expect(Object.keys(server.commits[0].files).sort()).toEqual(["big.txt", "other.txt"]);

    // The other direction: an edit and a button press while a pass is holding the lane.
    let releaseHead = (): void => {};
    server.gateHead = () => new Promise<void>((resolve) => (releaseHead = resolve));
    const second = plugin.syncNow();
    await elapse();
    edit(app, vault, "late.md", bytesOf(OVER, "late"));
    const button = plugin.renameLargeMarkdownNow();
    await elapse();
    expect(vault.files.has("late.md")).toBe(true);

    server.gateHead = null;
    releaseHead();
    await elapse();
    await second;
    await button;
    // Converted by the pass's own after-slot; the queued button then found nothing: no deadlock.
    expect(vault.files.has("late.txt")).toBe(true);
    expect(Notice.shown).toContain("R2DO Sync: no oversized Markdown files to rename");
  });

  it("a pass on a rebuilt scheduler waits for a rename started while there was none", async () => {
    // Automatic conversion off, so nothing but the button's own run is in any lane.
    const { plugin, app, vault, server } = await syncedDevice(
      { "big.md": bytesOf(OVER, "b") },
      { largeMarkdownAsText: false }
    );
    await plugin.onload();
    layoutReady(app);
    await elapse();
    let release = (): void => {};
    vault.gate = () => new Promise<void>((resolve) => (release = resolve));

    // A settings save hides the scheduler at once, so the press takes the local lane.
    const saving = plugin.saveSettings();
    const button = plugin.renameLargeMarkdownNow();
    await saving;
    await elapse();

    const pass = plugin.syncNow();
    await elapse(DEBOUNCE_MS);
    expect(headCalls(server)).toBe(0);

    vault.gate = null;
    release();
    await button;
    await pass;
    await until(() => server.commits.length > 0);
    expect(Object.keys(server.commits[0].files)).toEqual(["big.txt"]);
  });

  it("refuses the button during a whole-vault rewrite, touching nothing", async () => {
    const { plugin, app, vault } = await syncedDevice({ "big.md": bytesOf(OVER, "b") }, { largeMarkdownAsText: false });
    await plugin.onload();
    layoutReady(app);
    await elapse();
    // A restore-all whose first request never answers holds the rewrite open.
    requestUrlMock.impl = async () => await new Promise(() => {});
    await plugin.openHistory();
    const history = Modal.shown[Modal.shown.length - 1] as unknown as {
      deps: { restoreAll: (id: string) => Promise<unknown> };
    };
    void history.deps.restoreAll("01J000000000000000000000").catch(() => {});
    await elapse();
    Notice.shown.length = 0;

    await plugin.renameLargeMarkdownNow();
    expect(vault.renames).toEqual([]);
    expect(Notice.shown).toEqual([
      "R2DO Sync could not rename oversized Markdown: this vault is being rewritten. Wait for that to finish, then try again.",
    ]);

    // Automatic conversion defers too.
    await plugin.setLargeMarkdownAsText(true);
    edit(app, vault, "big.md", bytesOf(OVER + 5, "b2"));
    await elapse();
    expect(vault.renames).toEqual([]);
  });
});

describe("retirement", () => {
  it("a sweep stops at the next file once the plugin unloads, and nothing starts after", async () => {
    const { plugin, app, vault } = await syncedDevice({ "a.md": bytesOf(OVER, "a"), "b.md": bytesOf(OVER, "b") });
    let release = (): void => {};
    vault.gate = () => new Promise<void>((resolve) => (release = resolve));
    await plugin.onload();
    layoutReady(app);
    await elapse();

    plugin.onunload();
    vault.gate = null;
    release();
    await elapse();
    expect(vault.renames.map((r) => r.from)).toEqual(["a.md"]);

    edit(app, vault, "b.md", bytesOf(OVER + 1, "b2"));
    layoutReady(app);
    await plugin.renameLargeMarkdownNow();
    await elapse();
    expect(vault.renames.map((r) => r.from)).toEqual(["a.md"]);
  });

  it("a settings change stops a sweep, and the rebuilt one applies the new scope", async () => {
    const { plugin, app, vault } = await syncedDevice({
      "a.md": bytesOf(OVER, "a"),
      "keep/b.md": bytesOf(OVER, "b"),
    });
    let release = (): void => {};
    vault.gate = () => new Promise<void>((resolve) => (release = resolve));
    await plugin.onload();
    layoutReady(app);
    await elapse();

    plugin.settings.excludes = ".trash/**\nkeep/**";
    const saving = plugin.saveSettings();
    vault.gate = null;
    release();
    await elapse();
    await saving;
    await elapse();

    expect(vault.renames.map((r) => r.from)).toEqual(["a.md"]);
    expect(vault.files.has("keep/b.md")).toBe(true);
  });
});

describe("devices that have not synced", () => {
  it("the button works with no server at all, and nothing reaches the network", async () => {
    const { plugin, app } = makePlugin(null);
    const vault = memoryVault(app, { "big.md": bytesOf(OVER, "b") });
    await plugin.onload();
    layoutReady(app);
    await elapse();
    // No automatic conversion on a device that is not set up.
    expect(vault.renames).toEqual([]);

    (plugin as unknown as { runCommand(id: string): unknown }).runCommand("rename-large-markdown");
    await elapse();
    expect(vault.renames).toEqual([{ from: "big.md", to: "big.txt", via: "vault" }]);
    expect(Notice.shown).toContain("R2DO Sync: renamed 1 Markdown file to .txt (big.md → big.txt)");
    expect(requestUrlMock.calls).toEqual([]);
  });

  it("first-sync consent stays intact: nothing automatic, and the button starts no sync", async () => {
    const { plugin, app } = makePlugin({ firstSyncAcknowledged: false, syncOnStartup: true }, null);
    const vault = memoryVault(app, { "big.md": bytesOf(OVER, "b"), "n.md": bytesOf(3, "n") });
    fakeServer("01HEAD", []);
    await plugin.onload();
    layoutReady(app);
    edit(app, vault, "big.md", bytesOf(OVER + 1, "b2"));
    await elapse(DEBOUNCE_MS * 2);
    expect(vault.renames).toEqual([]);

    await plugin.renameLargeMarkdownNow();
    await elapse(DEBOUNCE_MS * 2);
    expect(vault.renames.map((r) => r.to)).toEqual(["big.txt"]);
    expect(requestUrlMock.calls).toEqual([]);
    expect(Modal.shown).toEqual([]);
    expect(plugin.settings.firstSyncAcknowledged).toBe(false);
  });
});

describe("the button's report", () => {
  it("counts what was renamed and names every refusal, never overwriting", async () => {
    const { plugin, app } = makePlugin(null);
    const squat = bytesOf(4, "mine");
    const vault = memoryVault(app, {
      "a.md": bytesOf(OVER, "a"),
      "b.md": bytesOf(OVER, "b"),
      "b.txt": squat,
      "c.md": bytesOf(OVER, "c"),
    }, { folders: ["c.txt"] });
    await plugin.onload();
    layoutReady(app);

    await plugin.renameLargeMarkdownNow();

    expect(vault.renames.map((r) => r.from)).toEqual(["a.md"]);
    expect(vault.files.get("b.txt")).toBe(squat);
    expect(vault.files.has("b.md")).toBe(true);
    expect(vault.files.has("c.md")).toBe(true);
    expect(Notice.shown).toEqual([
      "R2DO Sync: looking for Markdown files larger than 1.5 MiB…",
      "R2DO Sync: renamed 1 Markdown file to .txt (a.md → a.txt)",
      "R2DO Sync could not rename oversized Markdown: b.md → b.txt: a file or folder already " +
        "exists there; c.md → c.txt: a file or folder already exists there",
    ]);

    // Idempotent: the same press again renames nothing and reports the same refusals only.
    Notice.shown.length = 0;
    await plugin.renameLargeMarkdownNow();
    expect(vault.renames).toHaveLength(1);
    expect(Notice.shown.some((n) => n.startsWith("R2DO Sync: renamed"))).toBe(false);
  });
});
