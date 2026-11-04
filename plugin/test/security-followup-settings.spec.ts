// Security follow-up (2026-11-03), unit B: what a sync-token holder or a hostile server can
// make this device believe about its encryption change and its shared settings.
//
// Every test drives the real plugin through `onload()` against an HTTP-level fake server, and
// asserts only what survives: settings, what `saveData()` wrote, what was committed or written
// into the vault, and what the user was told.
import { beforeEach, describe, expect, it } from "vitest";
import LogSyncPlugin, { DEFAULT_SETTINGS, type Settings } from "../src/main";
import {
  VaultCrypto,
  generateMasterKey,
  generateVaultSalt,
  settingsAad,
} from "../src/crypto";
import { sha256Hex } from "../src/hash";
import { buildManifest, type FileEntry, type Manifest } from "../src/types";
import type { SettingsDoc } from "../src/settings-doc";
import { type FakeElement, LifecycleApp, Modal, Notice, TFolder, requestUrlMock } from "./obsidian-fake";

// --- environment ------------------------------------------------------------------------

function installGlobals(): void {
  let id = 1;
  const timer = () => id++;
  Object.assign(globalThis, {
    window: { setInterval: timer, clearInterval: () => {}, setTimeout: timer, clearTimeout: () => {} },
    document: { visibilityState: "visible" },
  });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Bounded wait on a real signal; a pass runs WebCrypto on real macrotasks. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeEach(() => {
  installGlobals();
  Notice.shown.length = 0;
  Modal.shown.length = 0;
  requestUrlMock.impl = null;
  requestUrlMock.calls.length = 0;
});

// --- a server, over requestUrl ------------------------------------------------------------

interface Server {
  head: string | null;
  manifests: Map<string, Manifest>;
  blobs: Map<string, Uint8Array>;
  commits: Manifest[];
  /** What GET /api/settings answers; null is a 404. */
  settings: SettingsDoc | null;
  settingsPuts: SettingsDoc[];
  requests: string[];
  /** The server keeps the next commit but the answer never arrives. */
  loseCommitResponse?: boolean;
}

function serve(server: Server): Server {
  const json = (status: number, value: unknown) => ({
    status,
    text: JSON.stringify(value),
    json: value,
    headers: {},
  });
  const missing = () => json(404, { error: { code: "not_found", message: "none" } });
  requestUrlMock.impl = async (req) => {
    const r = req as { url: string; method?: string; body?: string | ArrayBuffer };
    const path = new URL(r.url).pathname;
    const method = r.method ?? "GET";
    server.requests.push(`${method} ${path}`);
    if (path === "/api/head") return json(200, { head: server.head });
    if (path === "/api/settings") {
      if (method === "PUT") {
        const doc = JSON.parse(r.body as string) as SettingsDoc;
        const current = server.settings?.rev ?? 0;
        if (doc.rev !== undefined && doc.rev !== current + 1) {
          return json(409, { error: { code: "stale_revision", message: "stale" }, rev: current });
        }
        server.settings = { ...doc, rev: current + 1 };
        server.settingsPuts.push(doc);
        return json(200, { rev: current + 1 });
      }
      return server.settings === null ? missing() : json(200, server.settings);
    }
    if (path.startsWith("/api/manifests/")) {
      const m = server.manifests.get(path.slice("/api/manifests/".length));
      return m === undefined ? missing() : json(200, m);
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
      if (bytes === undefined) return missing();
      return { status: 200, text: "", json: null, headers: {}, arrayBuffer: bytes.slice().buffer };
    }
    if (path === "/api/commit") {
      const { manifest, expectedHead } = JSON.parse(r.body as string) as {
        manifest: Manifest;
        expectedHead: string | null;
      };
      if (expectedHead !== server.head) {
        return json(409, { error: { code: "stale_head", message: "stale" }, head: server.head });
      }
      server.manifests.set(manifest.id, manifest);
      server.commits.push(manifest);
      server.head = manifest.id;
      if (server.loseCommitResponse === true) {
        server.loseCommitResponse = false;
        return json(502, { error: { code: "bad_gateway", message: "upstream reset" } });
      }
      return json(200, { head: manifest.id });
    }
    throw new Error(`unexpected request ${method} ${path}`);
  };
  return server;
}

function newServer(over: Partial<Server> = {}): Server {
  return serve({
    head: null,
    manifests: new Map(),
    blobs: new Map(),
    commits: [],
    settings: null,
    settingsPuts: [],
    requests: [],
    ...over,
  });
}

// --- the plugin ---------------------------------------------------------------------------

const SERVER = "https://vault.example.workers.dev";
const SALT = "c2FsdHNhbHRzYWx0c2FsdA==";
const NOTE = "note.md";
const NOTE_BYTES = new TextEncoder().encode("the note's real content\n");

interface Persisted {
  settings: Partial<Settings>;
  state?: unknown;
  stateServerUrl?: string;
  sharedSettings?: unknown;
  pendingEncryptionTransition?: unknown;
}

/** A vault holding one real note, so a migration's convergence preflight has a file to see. */
function vaultWithNote(app: LifecycleApp): void {
  app.vault.adapter = {
    list: async (folder: string) => ({ files: folder === "" ? [NOTE] : [], folders: [] }),
    stat: async (path: string) =>
      path === NOTE ? { type: "file", size: NOTE_BYTES.byteLength, mtime: 1 } : null,
    readBinary: async () => NOTE_BYTES.slice().buffer,
  } as never;
}

function emptyVault(app: LifecycleApp): void {
  app.vault.adapter = {
    list: async () => ({ files: [], folders: [] }),
    stat: async () => null,
  } as never;
}

async function boot(
  data: Persisted,
  vault: (app: LifecycleApp) => void = vaultWithNote
): Promise<{ plugin: LogSyncPlugin; app: LifecycleApp }> {
  const app = new LifecycleApp();
  vault(app);
  const plugin = new LogSyncPlugin(app as never, {
    id: "cloudflare-rdo-sync",
    name: "R2DO Sync",
  } as never);
  (plugin as unknown as { persisted: unknown }).persisted = JSON.parse(JSON.stringify(data));
  await plugin.onload();
  return { plugin, app };
}

function saves(plugin: LogSyncPlugin): Persisted[] {
  return (plugin as unknown as { saves: Persisted[] }).saves;
}

/** What the next save writes, which is the only record that survives a reload. */
async function flushToDisk(plugin: LogSyncPlugin): Promise<Persisted> {
  await plugin.saveSettings();
  return saves(plugin).at(-1)!;
}

const baseSettings = (over: Partial<Settings> = {}): Partial<Settings> => ({
  ...DEFAULT_SETTINGS,
  serverUrl: SERVER,
  accessToken: "access-token",
  deviceName: "laptop",
  firstSyncAcknowledged: true,
  syncOnStartup: false,
  retryAttempts: 0,
  ...over,
});

// --- B1: encryption change completion evidence --------------------------------------------

/** The note as an encrypted snapshot entry under `crypto`, with its ciphertext blob. */
async function encryptedEntry(crypto: VaultCrypto): Promise<{ entry: FileEntry; blob: Uint8Array }> {
  const h = await sha256Hex(NOTE_BYTES);
  const blob = await crypto.encryptBlob(h, NOTE_BYTES);
  return { entry: { h, size: NOTE_BYTES.byteLength, mtime: 1, c: await sha256Hex(blob) }, blob };
}

async function snapshot(
  crypto: VaultCrypto | null,
  id: string,
  parent: string | null,
  files: Record<string, FileEntry>
): Promise<Manifest> {
  const blobs = [...new Set(Object.values(files).map((e) => e.c ?? e.h))];
  return buildManifest({
    crypto,
    parent,
    files,
    blobs,
    id,
    device: "laptop",
    createdAt: "2026-11-03T10:00:00.000Z",
  });
}

const SOURCE = "01SOURCE0000000000000000AA";
const CHILD = "01CHILD00000000000000000AA";

interface Rekey {
  oldKey: string;
  newKey: string;
  oldCrypto: VaultCrypto;
  newCrypto: VaultCrypto;
  source: Manifest;
  sourceFiles: Record<string, FileEntry>;
  server: Server;
  data: Persisted;
}

/**
 * A device synced at SOURCE under `oldKey`, with a persisted pending change to `target` — the
 * state a process killed during the migration leaves on disk.
 */
async function interrupted(target: "rekey" | "plaintext"): Promise<Rekey> {
  const oldKey = generateMasterKey();
  const newKey = generateMasterKey();
  const oldCrypto = await VaultCrypto.fromText(oldKey);
  const newCrypto = await VaultCrypto.fromText(newKey);
  const { entry, blob } = await encryptedEntry(oldCrypto);
  const sourceFiles = { [NOTE]: entry };
  const source = await snapshot(oldCrypto, SOURCE, null, sourceFiles);
  const server = newServer({
    head: SOURCE,
    manifests: new Map([[SOURCE, source]]),
    blobs: new Map([[entry.c!, blob]]),
  });
  const pending =
    target === "rekey"
      ? { mode: "encrypted", key: newKey, backedUp: true, vaultSalt: SALT }
      : { mode: "plaintext", key: "", backedUp: true, vaultSalt: "" };
  const data: Persisted = {
    settings: baseSettings({
      encryptionMode: "encrypted",
      masterKey: oldKey,
      masterKeyBackedUp: true,
      vaultSalt: SALT,
      syncSettings: false,
    }),
    state: { lastSyncedHead: SOURCE, files: sourceFiles, keyId: oldCrypto.keyId, lines: {} },
    stateServerUrl: SERVER,
    pendingEncryptionTransition: pending,
  };
  return { oldKey, newKey, oldCrypto, newCrypto, source, sourceFiles, server, data };
}

/** The same snapshot under a different clear keyId, which no AAD-bound envelope survives. */
function relabel(manifest: Manifest, keyId: string): Manifest {
  if (manifest.v === 1) throw new Error("a plaintext snapshot has no keyId to relabel");
  return { ...manifest, keyId };
}

/** Puts `head` on the server as its head. */
function publish(server: Server, head: Manifest): void {
  server.manifests.set(head.id, head);
  server.head = head.id;
}

const commitsAttempted = (server: Server) =>
  server.requests.filter((r) => r === "POST /api/commit").length;

describe("B1: an interrupted encryption change resumes only on proof", () => {
  it("refuses a head whose clear keyId claims the new key but does not authenticate under it", async () => {
    const r = await interrupted("rekey");
    // Ciphertext a key-less token holder can lift from history, under a header naming the new
    // key and the right parent. Only the AAD can tell.
    const forged = relabel(await snapshot(r.oldCrypto, CHILD, SOURCE, r.sourceFiles), r.newCrypto.keyId);
    publish(r.server, forged);

    const { plugin } = await boot(r.data);

    expect(plugin.settings.masterKey).toBe(r.oldKey);
    expect(plugin.settings.encryptionMode).toBe("encrypted");
    const saved = await flushToDisk(plugin);
    expect(saved.settings.masterKey).toBe(r.oldKey);
    expect(saved.pendingEncryptionTransition).toEqual(r.data.pendingEncryptionTransition);
    expect(saved.state).toEqual(r.data.state);
    expect(commitsAttempted(r.server)).toBe(0);
    expect(Notice.shown.some((n) => /could not confirm that the interrupted encryption change/.test(n))).toBe(true);
  });

  it("keeps the change when a real migration commit is relabelled to claim the old key", async () => {
    const r = await interrupted("rekey");
    // The migration did land, but the server relabels it as the old key. Read as "not
    // started", the retry fails its head check and used to drop the pending change — and with
    // it the only copy of the new key on this device.
    const landed = await snapshot(r.newCrypto, CHILD, SOURCE, {
      [NOTE]: (await encryptedEntry(r.newCrypto)).entry,
    });
    publish(r.server, relabel(landed, r.oldCrypto.keyId));

    const { plugin } = await boot(r.data);

    const saved = await flushToDisk(plugin);
    expect(saved.settings.masterKey).toBe(r.oldKey);
    expect(saved.pendingEncryptionTransition).toEqual(r.data.pendingEncryptionTransition);
    expect(commitsAttempted(r.server)).toBe(0);
  });

  it("refuses a plaintext child that does not carry exactly the source's content", async () => {
    const r = await interrupted("plaintext");
    // Anyone with the sync token can commit a v1 child naming SOURCE. A clear v1 is no proof
    // that this device's own disable-encryption change published it.
    const other = new TextEncoder().encode("planted\n");
    publish(
      r.server,
      await snapshot(null, CHILD, SOURCE, {
        "planted.md": { h: await sha256Hex(other), size: other.byteLength, mtime: 1 },
      })
    );

    const { plugin } = await boot(r.data);

    expect(plugin.settings.encryptionMode).toBe("encrypted");
    const saved = await flushToDisk(plugin);
    expect(saved.settings.masterKey).toBe(r.oldKey);
    expect(saved.pendingEncryptionTransition).toEqual(r.data.pendingEncryptionTransition);
  });

  it("completes when the head is the migration's own authenticated child (crash after commit)", async () => {
    const r = await interrupted("rekey");
    publish(
      r.server,
      await snapshot(r.newCrypto, CHILD, SOURCE, { [NOTE]: (await encryptedEntry(r.newCrypto)).entry })
    );

    const { plugin } = await boot(r.data);

    expect(plugin.settings.masterKey).toBe(r.newKey);
    const saved = await flushToDisk(plugin);
    expect(saved.settings.masterKey).toBe(r.newKey);
    expect(saved.pendingEncryptionTransition).toBeNull();
    // The cached state was built under the old key, so the next pass pulls under the new one.
    expect(saved.state).toBeNull();
  });

  it("completes a plaintext change whose child carries exactly the source's content", async () => {
    const r = await interrupted("plaintext");
    const { h, size, mtime } = r.sourceFiles[NOTE];
    publish(r.server, await snapshot(null, CHILD, SOURCE, { [NOTE]: { h, size, mtime } }));

    const { plugin } = await boot(r.data);

    expect(plugin.settings.encryptionMode).toBe("plaintext");
    expect(plugin.settings.masterKey).toBe("");
    expect((await flushToDisk(plugin)).pendingEncryptionTransition).toBeNull();
  });

  it("re-runs a migration interrupted before its commit, after a reload", async () => {
    const r = await interrupted("rekey");

    const { plugin } = await boot(r.data);
    await until(() => plugin.settings.masterKey === r.newKey, "the resumed migration to finish");

    expect(r.server.commits).toHaveLength(1);
    const committed = r.server.commits[0];
    expect(committed.v).toBe(3);
    expect(committed.parent).toBe(SOURCE);
    expect(committed.v === 3 && committed.keyId).toBe(r.newCrypto.keyId);
    expect((await flushToDisk(plugin)).pendingEncryptionTransition).toBeNull();
  });

  it("still disables encryption when the user asks, migrating the vault to plaintext", async () => {
    const r = await interrupted("plaintext");
    delete r.data.pendingEncryptionTransition;
    const { plugin } = await boot(r.data);

    plugin.requestEncryptionTarget("plaintext", "", "");
    await until(() => plugin.settings.encryptionMode === "plaintext", "the plaintext migration");

    expect(plugin.settings.masterKey).toBe("");
    expect(r.server.commits).toHaveLength(1);
    const committed = r.server.commits[0];
    expect(committed.v).toBe(1);
    expect(committed.parent).toBe(SOURCE);
    expect(committed.v === 1 && Object.keys(committed.files)).toEqual([NOTE]);
    expect((await flushToDisk(plugin)).pendingEncryptionTransition).toBeNull();
  });

  it("finishes a key change whose commit landed although its response was lost", async () => {
    const r = await interrupted("rekey");
    delete r.data.pendingEncryptionTransition;
    const { plugin } = await boot(r.data);
    r.server.loseCommitResponse = true;

    plugin.requestEncryptionTarget("encrypted", r.newKey, SALT);
    const backup = Modal.shown.at(-1) as unknown as { opts: { onSaved: () => Promise<void> } };
    await backup.opts.onSaved();

    // The remote is under the new key now; keeping the old one would strand this device.
    expect(r.server.commits).toHaveLength(1);
    expect(plugin.settings.masterKey).toBe(r.newKey);
    expect((await flushToDisk(plugin)).pendingEncryptionTransition).toBeNull();
  });

  it("cancels a key change that failed before anything was committed", async () => {
    const r = await interrupted("rekey");
    delete r.data.pendingEncryptionTransition;
    // The vault on disk is not the snapshot it last synced, so the preflight refuses.
    const { plugin } = await boot(r.data, (app) => {
      vaultWithNote(app);
      (app.vault.adapter as { readBinary: unknown }).readBinary = async () =>
        new TextEncoder().encode("edited since\n").buffer;
    });

    plugin.requestEncryptionTarget("encrypted", r.newKey, SALT);
    const backup = Modal.shown.at(-1) as unknown as { opts: { onSaved: () => Promise<void> } };
    await expect(backup.opts.onSaved()).rejects.toThrow(/sync under the current encryption mode first/);

    expect(r.server.commits).toHaveLength(0);
    expect(plugin.settings.masterKey).toBe(r.oldKey);
    expect((await flushToDisk(plugin)).pendingEncryptionTransition).toBeNull();
  });

  it("a device with no snapshot does not adopt a key on a forged clear keyId", async () => {
    const theirKey = generateMasterKey();
    const typedKey = generateMasterKey();
    const theirCrypto = await VaultCrypto.fromText(theirKey);
    const typedCrypto = await VaultCrypto.fromText(typedKey);
    const forged = relabel(
      await snapshot(theirCrypto, SOURCE, null, { [NOTE]: (await encryptedEntry(theirCrypto)).entry }),
      typedCrypto.keyId
    );
    const server = newServer();
    publish(server, forged);
    const { plugin } = await boot({
      settings: baseSettings({
        encryptionMode: "encrypted",
        masterKey: theirKey,
        masterKeyBackedUp: true,
        vaultSalt: SALT,
        syncSettings: false,
      }),
      state: null,
      stateServerUrl: SERVER,
    });

    plugin.requestEncryptionTarget("encrypted", typedKey, SALT);
    const backup = Modal.shown.at(-1) as unknown as { opts: { onSaved: () => Promise<void> } };
    await expect(backup.opts.onSaved()).rejects.toThrow(/does not decrypt under it/);

    expect(plugin.settings.masterKey).toBe(theirKey);
    expect((await flushToDisk(plugin)).settings.masterKey).toBe(theirKey);
  });

  it("a device with no snapshot still adopts the key its vault's head authenticates under", async () => {
    const key = generateMasterKey();
    const crypto = await VaultCrypto.fromText(key);
    const server = newServer();
    publish(server, await snapshot(crypto, SOURCE, null, { [NOTE]: (await encryptedEntry(crypto)).entry }));
    const { plugin } = await boot({
      settings: baseSettings({ encryptionMode: "plaintext", masterKey: "", syncSettings: false }),
      state: null,
      stateServerUrl: SERVER,
    });

    plugin.requestEncryptionTarget("encrypted", key, SALT);
    const backup = Modal.shown.at(-1) as unknown as { opts: { onSaved: () => Promise<void> } };
    await backup.opts.onSaved();

    expect(plugin.settings.encryptionMode).toBe("encrypted");
    expect(plugin.settings.masterKey).toBe(key);
  });
});

// --- B2/B3: shared settings document -------------------------------------------------------

async function settingsDoc(
  v: 1 | 2 | 3,
  crypto: VaultCrypto | null,
  rev: number,
  plain: Record<string, unknown>,
  vaultSalt?: string
): Promise<SettingsDoc> {
  const envelope = { updatedAt: 1000 + rev, device: "desktop", rev, ...(vaultSalt === undefined ? {} : { vaultSalt }) };
  if (v === 1) return { v: 1, ...envelope, plain };
  const keyId = crypto!.keyId;
  const aad = v === 3 ? settingsAad({ v: 3, rev, device: envelope.device, keyId, vaultSalt }) : undefined;
  return { v, ...envelope, keyId, enc: await crypto!.encryptSettingsJson(plain, aad) };
}

async function encryptedDevice(over: Partial<Persisted> = {}) {
  const key = generateMasterKey();
  const crypto = await VaultCrypto.fromText(key);
  const data: Persisted = {
    settings: baseSettings({ encryptionMode: "encrypted", masterKey: key, masterKeyBackedUp: true, vaultSalt: SALT }),
    state: null,
    stateServerUrl: SERVER,
    sharedSettings: null,
    ...over,
  };
  return { key, crypto, data };
}

const ignoredWarnings = () => Notice.shown.filter((n) => /ignored shared settings/.test(n)).length;

describe("B2: once authenticated v3 settings are absorbed, older formats never apply", () => {
  it("refuses replayed v2 and v1 documents across a reload, warning once", async () => {
    const { crypto, data } = await encryptedDevice();
    const server = newServer({ settings: await settingsDoc(2, crypto, 1, { historyLimit: 11 }) });
    const first = await boot(data, emptyVault);

    // A legacy v2 document is still accepted while nothing better has been seen.
    await first.plugin.syncNow();
    expect(first.plugin.settings.historyLimit).toBe(11);
    expect(first.plugin.settings.authenticatedSettingsEndpoint).toBe("");

    server.settings = await settingsDoc(3, crypto, 2, { historyLimit: 22 });
    await first.plugin.syncNow();
    expect(first.plugin.settings.historyLimit).toBe(22);

    // A reload from what was saved.
    const second = await boot(saves(first.plugin).at(-1)!, emptyVault);
    Notice.shown.length = 0;
    server.settings = await settingsDoc(2, crypto, 3, { historyLimit: 33 });
    await second.plugin.syncNow();
    expect(second.plugin.settings.historyLimit).toBe(22);

    server.settings = await settingsDoc(1, null, 4, { historyLimit: 44 });
    await second.plugin.syncNow();
    expect(second.plugin.settings.historyLimit).toBe(22);

    server.settings = await settingsDoc(2, crypto, 5, { historyLimit: 55 });
    await second.plugin.syncNow();
    expect(second.plugin.settings.historyLimit).toBe(22);
    expect((await flushToDisk(second.plugin)).settings.historyLimit).toBe(22);
    expect(ignoredWarnings()).toBe(1);
  });

  it("puts the latch on disk before the accepted settings take effect", async () => {
    const { crypto, data } = await encryptedDevice();
    newServer({ settings: await settingsDoc(3, crypto, 1, { historyLimit: 22 }) });
    const { plugin } = await boot(data, emptyVault);

    await plugin.syncNow();

    const written = saves(plugin);
    const latched = written.findIndex((s) => s.settings.authenticatedSettingsEndpoint === SERVER);
    const applied = written.findIndex((s) => s.settings.historyLimit === 22);
    expect(latched).toBeGreaterThanOrEqual(0);
    expect(written[latched].settings.historyLimit).toBe(DEFAULT_SETTINGS.historyLimit);
    expect(applied).toBeGreaterThan(latched);
  });

  it("does not latch on a v3 document that fails authentication or validation", async () => {
    const { crypto, data } = await encryptedDevice();
    const tampered = { ...(await settingsDoc(3, crypto, 1, { historyLimit: 11 })), rev: 7 };
    const server = newServer({ settings: tampered });
    const { plugin } = await boot(data, emptyVault);

    await plugin.syncNow();
    expect(plugin.settings.authenticatedSettingsEndpoint).toBe("");

    server.settings = await settingsDoc(3, crypto, 2, { historyLimit: "eleven" });
    await plugin.syncNow();
    expect(plugin.settings.authenticatedSettingsEndpoint).toBe("");
    expect(plugin.settings.historyLimit).toBe(DEFAULT_SETTINGS.historyLimit);

    // Not latched, so a legacy document is still honoured.
    server.settings = await settingsDoc(2, crypto, 3, { historyLimit: 13 });
    await plugin.syncNow();
    expect(plugin.settings.historyLimit).toBe(13);
    expect((await flushToDisk(plugin)).settings.authenticatedSettingsEndpoint).toBe("");
  });

  it("latches when this device publishes v3 itself, and never shares the latch", async () => {
    const { crypto, data } = await encryptedDevice();
    const server = newServer();
    const { plugin } = await boot(data, emptyVault);

    await plugin.syncNow();
    expect(server.settingsPuts).toHaveLength(1);
    const put = server.settingsPuts[0];
    expect(put.v).toBe(3);

    server.settings = await settingsDoc(2, crypto, 2, { historyLimit: 99 });
    await plugin.syncNow();
    expect(plugin.settings.historyLimit).toBe(DEFAULT_SETTINGS.historyLimit);

    expect(plugin.settings.authenticatedSettingsEndpoint).toBe(SERVER);
    if (put.v === 1) throw new Error("an encrypted device published a plaintext document");
    const shared = await crypto.decryptSettingsJson<Record<string, unknown>>(
      put.enc,
      settingsAad({ v: 3, rev: put.rev!, device: put.device, keyId: crypto.keyId, vaultSalt: put.vaultSalt })
    );
    expect(shared).not.toHaveProperty("authenticatedSettingsEndpoint");
    expect(Object.keys(shared)).not.toContain("masterKey");
  });
});

describe("B3: the vault salt is adopted only from a document that opens", () => {
  it("keeps the stored salt when a v3 document's salt is swapped under fixed ciphertext", async () => {
    const { crypto, data } = await encryptedDevice();
    const published = generateVaultSalt();
    const doc = await settingsDoc(3, crypto, 1, { historyLimit: 11 }, published);
    newServer({ settings: { ...doc, vaultSalt: generateVaultSalt() } });
    const { plugin } = await boot(data, emptyVault);

    await plugin.syncNow();

    expect(plugin.settings.vaultSalt).toBe(SALT);
    const saved = await flushToDisk(plugin);
    expect(saved.settings.vaultSalt).toBe(SALT);
    expect(saved.settings.masterKey).toBe(data.settings.masterKey);
    expect(plugin.settings.historyLimit).toBe(DEFAULT_SETTINGS.historyLimit);
  });

  it("keeps the stored salt for a same-revision document whose salt was swapped", async () => {
    const { crypto, data } = await encryptedDevice({
      sharedSettings: { rev: { updatedAt: 1001, device: "desktop", rev: 1 }, fingerprint: "x" },
    });
    const doc = await settingsDoc(3, crypto, 1, { historyLimit: 11 }, generateVaultSalt());
    newServer({ settings: { ...doc, vaultSalt: generateVaultSalt() } });
    const { plugin } = await boot(data, emptyVault);

    await plugin.syncNow();

    expect((await flushToDisk(plugin)).settings.vaultSalt).toBe(SALT);
  });

  it("keeps the stored salt when a v2 document is under a different key", async () => {
    const { data } = await encryptedDevice();
    const stranger = await VaultCrypto.fromText(generateMasterKey());
    newServer({ settings: await settingsDoc(2, stranger, 1, { historyLimit: 11 }, generateVaultSalt()) });
    const { plugin } = await boot(data, emptyVault);

    await plugin.syncNow();

    expect((await flushToDisk(plugin)).settings.vaultSalt).toBe(SALT);
  });

  it("adopts the salt of an authentic document", async () => {
    const { crypto, data } = await encryptedDevice();
    const published = generateVaultSalt();
    newServer({ settings: await settingsDoc(3, crypto, 1, { historyLimit: 11 }, published) });
    const { plugin } = await boot(data, emptyVault);

    await plugin.syncNow();

    expect(plugin.settings.historyLimit).toBe(11);
    expect((await flushToDisk(plugin)).settings.vaultSalt).toBe(published);
  });
});

// --- B4: the report folder is a shared setting, checked where it becomes a path ------------

describe("B4: the report folder", () => {
  async function exportWith(folder: string) {
    const { plugin, app } = await boot(
      { settings: baseSettings({ encryptionMode: "plaintext", syncSettings: false, logNoteFolder: folder }) },
      emptyVault
    );
    const created: string[] = [];
    const folders: string[] = [];
    Object.assign(app.vault, {
      getAbstractFileByPath: (path: string) => (folders.includes(path) ? new TFolder() : null),
      createFolder: async (path: string) => {
        folders.push(path);
      },
      create: async (path: string) => {
        created.push(path);
      },
    });
    Notice.shown.length = 0;
    await plugin.exportLog();
    return { created, folders };
  }

  it.each(["../outside", "notes/../../outside", ".Obsidian/plugins", ".obsidian", "OBSIDIAN/../.obsidian/snippets"])(
    "writes no report into %s",
    async (folder) => {
      const { created, folders } = await exportWith(folder);
      expect(created).toEqual([]);
      expect(folders).toEqual([]);
      expect(Notice.shown.some((n) => /could not write the report/.test(n))).toBe(true);
    }
  );

  it("still writes the report into an ordinary folder, and at the root when empty", async () => {
    const ordinary = await exportWith("Logs/sync");
    expect(ordinary.folders).toEqual(["Logs/sync"]);
    expect(ordinary.created).toHaveLength(1);
    expect(ordinary.created[0]).toMatch(/^Logs\/sync\/r2do-sync-report-.*\.md$/);

    const root = await exportWith("");
    expect(root.created).toHaveLength(1);
    expect(root.created[0]).toMatch(/^r2do-sync-report-.*\.md$/);
  });
});

// --- B5: the first-sync consent names where the vault is going -----------------------------

describe("B5: first-sync consent after a setup link", () => {
  it("names the link's server by origin, as text, without its token or query", async () => {
    const { plugin } = await boot({
      settings: baseSettings({ encryptionMode: "plaintext", syncSettings: false }),
      state: { lastSyncedHead: "01HEAD", files: {}, keyId: null, lines: {} },
      stateServerUrl: SERVER,
    });
    requestUrlMock.impl = async () => ({ status: 200, text: '{"head":null}', json: { head: null }, headers: {} });
    Modal.shown.length = 0;

    await plugin.applySetup({
      v: 2,
      url: "https://other.example.net/<b>vault</b>?token=QUERY-SECRET#frag",
      token: "LINK-TOKEN-SECRET",
      name: "phone",
      mode: "plaintext",
    });
    await until(() => Modal.shown.length > 0, "the first-sync consent");

    const modal = Modal.shown.at(-1) as unknown as { opts: { body: readonly string[] } };
    const body = modal.opts.body.join("\n");
    expect(body).toContain("https://other.example.net");
    expect(body).not.toContain("vault.example.workers.dev");
    expect(body).not.toContain("SECRET");
    expect(body).not.toContain("<b>");
    // Rendered as the text of a paragraph, so even a hostile name could not become markup.
    const content = (Modal.shown.at(-1) as unknown as { contentEl: FakeElement }).contentEl;
    expect(content.children.some((el) => el.tag === "p" && el.text.includes("https://other.example.net"))).toBe(true);
  });
});
