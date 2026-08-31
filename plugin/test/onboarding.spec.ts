import { describe, expect, it } from "vitest";
import { ApiError, type SyncApi } from "../src/api";
import {
  VaultCrypto,
  generateMasterKey,
  generateVaultSalt,
  parseMasterKey,
} from "../src/crypto";
import { joinPayload, probeRemote, proveMasterKey, probeSummary } from "../src/onboarding";
import { buildManifest, type Manifest } from "../src/types";

// The spec for these tests is a real dead config found on disk: an agent-Worker URL, a token
// matching no live credential, and a freshly minted key that opened nothing — all accepted
// silently at entry time. Every refusal path below asserts that nothing would have been saved.

const SALT = generateVaultSalt();
const CREDS = { url: "https://v.example.workers.dev", token: "t" };

async function encryptedManifest(keyText: string, id = "01J0AAAAAAAAAAAAAAAAAAAAAA"): Promise<Manifest> {
  const crypto = await VaultCrypto.fromText(keyText);
  return buildManifest({
    id,
    parent: null,
    device: "other",
    createdAt: new Date(0).toISOString(),
    files: { "note.md": { h: "a".repeat(64), size: 3, mtime: 0 } },
    blobs: ["a".repeat(64)],
    crypto,
  });
}

function fakeApi(over: Partial<Record<keyof SyncApi, unknown>>): SyncApi {
  return {
    getHead: () => Promise.resolve(null),
    getManifest: () => Promise.reject(new Error("unexpected getManifest")),
    getSettingsDoc: () => Promise.reject(new ApiError("no doc", 404, "not_found")),
    ...over,
  } as unknown as SyncApi;
}

describe("probeRemote", () => {
  it("calls an empty vault empty, and asks for no key", async () => {
    const probe = await probeRemote(fakeApi({ getHead: () => Promise.resolve(null) }), CREDS);
    expect(probe.kind).toBe("empty");
    expect(probe.head).toBeNull();
    expect(probe.manifest).toBeNull();
    expect(probeSummary(probe)).toContain("empty");
  });

  it("reads a v1 head as an existing plaintext vault", async () => {
    const manifest = await buildManifest({
      id: "01J0BBBBBBBBBBBBBBBBBBBBBB",
      parent: null,
      device: "other",
      createdAt: new Date(0).toISOString(),
      files: {},
      blobs: [],
      crypto: null,
    });
    const probe = await probeRemote(
      fakeApi({ getHead: () => Promise.resolve(manifest.id), getManifest: () => Promise.resolve(manifest) }),
      CREDS
    );
    expect(probe.kind).toBe("plaintext");
    expect(probeSummary(probe)).toContain("not encrypted");
  });

  it("reads a v3 head as an existing encrypted vault", async () => {
    const manifest = await encryptedManifest(generateMasterKey());
    const probe = await probeRemote(
      fakeApi({ getHead: () => Promise.resolve(manifest.id), getManifest: () => Promise.resolve(manifest) }),
      CREDS
    );
    expect(probe.kind).toBe("encrypted");
    expect(probe.manifest).toBe(manifest);
    expect(probeSummary(probe)).toContain("master key");
  });

  it("propagates a failure instead of reporting an empty vault", async () => {
    // The dangerous misreading: "I could not tell" answered as "empty" is what leads to
    // minting a key over somebody's existing snapshots.
    await expect(
      probeRemote(
        fakeApi({ getHead: () => Promise.reject(new ApiError("unauthorized", 401, "unauthorized")) }),
        CREDS
      )
    ).rejects.toThrow(/unauthorized/);
  });

  it("adopts the published salt, and treats only a 404 as no document", async () => {
    const withDoc = await probeRemote(
      fakeApi({
        getSettingsDoc: () => Promise.resolve({ v: 1, updatedAt: 1, device: "d", vaultSalt: SALT, plain: {} }),
      }),
      CREDS
    );
    expect(withDoc.vaultSalt).toBe(SALT);

    const noDoc = await probeRemote(fakeApi({}), CREDS);
    expect(noDoc.vaultSalt).toBeNull();

    await expect(
      probeRemote(
        fakeApi({ getSettingsDoc: () => Promise.reject(new ApiError("boom", 500, "server")) }),
        CREDS
      )
    ).rejects.toThrow(/boom/);
  });
});

describe("proveMasterKey", () => {
  it("accepts the key the vault was written with", async () => {
    const key = generateMasterKey();
    const manifest = await encryptedManifest(key);
    await expect(proveMasterKey(manifest, key)).resolves.toBeUndefined();
  });

  it("refuses a well-formed key that opens nothing", async () => {
    // Exactly what the old flow minted: parses perfectly, belongs to no vault.
    const manifest = await encryptedManifest(generateMasterKey());
    await expect(proveMasterKey(manifest, generateMasterKey())).rejects.toThrow(
      /does not belong to this vault/
    );
  });

  it("refuses an unreadable key without reaching the ciphertext", async () => {
    const manifest = await encryptedManifest(generateMasterKey());
    await expect(proveMasterKey(manifest, "not-a-key")).rejects.toThrow(/not readable/);
  });

  it("refuses a v3 manifest whose envelope was tampered with", async () => {
    // v3 authenticates its envelope, so a spliced header must fail the tag rather than being
    // read as genuine. The keyId still matches here, so this reaches the decrypt.
    const key = generateMasterKey();
    const manifest = await encryptedManifest(key);
    expect(manifest.v).toBe(3);
    const spliced = { ...manifest, device: "someone-else" } as Manifest;
    await expect(proveMasterKey(spliced, key)).rejects.toThrow(/did not open/);
  });

  it("says so rather than pretending, on a plaintext vault", async () => {
    const manifest = await buildManifest({
      id: "01J0CCCCCCCCCCCCCCCCCCCCCC",
      parent: null,
      device: "other",
      createdAt: new Date(0).toISOString(),
      files: {},
      blobs: [],
      crypto: null,
    });
    await expect(proveMasterKey(manifest, generateMasterKey())).rejects.toThrow(/plaintext/);
  });

  it("proves the key by real decryption, not by keyId alone", async () => {
    // A keyId is 8 derived bytes. Asserting only on it would accept a manifest whose
    // ciphertext was written by a different key, which is the failure this whole form exists
    // to prevent — so the decrypt has to be what decides.
    const key = generateMasterKey();
    const manifest = await encryptedManifest(key);
    const other = await encryptedManifest(generateMasterKey(), "01J0DDDDDDDDDDDDDDDDDDDDDD");
    const forged = { ...manifest, enc: (other as { enc: unknown }).enc } as Manifest;
    await expect(proveMasterKey(forged, key)).rejects.toThrow(/did not open/);
  });
});

describe("joinPayload", () => {
  const common = { url: "https://v.example.workers.dev", token: "t", name: "laptop" };

  it("prefers the vault's published salt over this device's provisional one", async () => {
    const key = generateMasterKey();
    const payload = joinPayload({
      ...common,
      kind: "encrypted",
      key,
      publishedSalt: SALT,
      provisionalSalt: generateVaultSalt(),
    });
    expect(payload.mode).toBe("encrypted");
    expect(payload).toMatchObject({ vaultSalt: SALT, key });
    // The key survives verbatim: applySetup stores it, and a trimmed-to-nothing key would
    // otherwise be saved as a configured-looking device that opens nothing.
    expect(parseMasterKey(payload.mode === "encrypted" ? payload.key : "")).toHaveLength(32);
  });

  it("falls back to the provisional salt when nothing is published", () => {
    const provisional = generateVaultSalt();
    const payload = joinPayload({
      ...common,
      kind: "encrypted",
      key: generateMasterKey(),
      publishedSalt: null,
      provisionalSalt: provisional,
    });
    expect(payload).toMatchObject({ vaultSalt: provisional });
  });

  it("carries no key or salt for a plaintext vault", () => {
    const payload = joinPayload({
      ...common,
      kind: "plaintext",
      publishedSalt: SALT,
      provisionalSalt: generateVaultSalt(),
    });
    expect(payload.mode).toBe("plaintext");
    expect(payload).not.toHaveProperty("key");
    expect(payload).not.toHaveProperty("vaultSalt");
  });

  it("refuses to build an encrypted join with no key", () => {
    expect(() =>
      joinPayload({
        ...common,
        kind: "encrypted",
        key: "   ",
        publishedSalt: SALT,
        provisionalSalt: generateVaultSalt(),
      })
    ).toThrow(/needs its master key/);
  });
});

// --- the form's wiring: what actually reaches the settings store ------------------------
//
// The unit tests above prove the decisions. These prove the consequence, which is the part
// the dead config on disk actually documents: a refused join must leave the store untouched
// and must never mint a key.
import { App } from "./obsidian-fake";
import { DEFAULT_SETTINGS, LogSyncSettingTab, type Settings } from "../src/main";

function tabWith(probeImpl: () => Promise<unknown>, over: Partial<Settings> = {}) {
  const settings: Settings = { ...DEFAULT_SETTINGS, serverUrl: "", accessToken: "", ...over };
  const applied: unknown[] = [];
  const plugin = {
    app: new App(),
    settings,
    encryptionEnabled: settings.encryptionMode === "encrypted",
    keyMismatch: null,
    hasSyncedSnapshot: false,
    lastConflicts: [],
    async saveSettings() {},
    async applySetup(payload: unknown, opts: unknown) {
      applied.push({ payload, opts });
    },
    apiFor: () => ({ getHead: probeImpl, getManifest: probeImpl, getSettingsDoc: probeImpl }),
  };
  const tab = new LogSyncSettingTab(plugin.app as never, plugin as never);
  return { tab, plugin, settings, applied, snapshot: JSON.stringify(settings) };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Types the three fields and presses Check. */
async function probeVia(tab: LogSyncSettingTab, url: string, token: string): Promise<void> {
  tab.display();
  const log = (tab as unknown as { containerEl: { log: { rows: { texts: { inputEl: { value: string }; onChanged?: () => void }[]; buttons: { text: string; click: () => unknown }[] }[] } } }).containerEl.log;
  const rows = log.rows;
  const set = (row: number, value: string) => {
    const t = rows[row].texts[0] as unknown as { inputEl: { value: string }; change?: (v: string) => void };
    if (typeof t.change === "function") t.change(value);
    else t.inputEl.value = value;
  };
  set(1, url);
  set(2, token);
  const check = rows
    .flatMap((r) => r.buttons)
    .find((b) => b.text === "Check" || b.text === "Check again");
  // Not optional: a test whose button was never found would "pass" having exercised nothing.
  if (check === undefined) throw new Error("no Check button on the setup form");
  check.click();
  await flush();
}

describe("the setup form's effect on the settings store", () => {
  it("saves nothing when the server cannot be read", async () => {
    // The live failure: a URL pointing at the wrong Worker. It answers, just not to these
    // routes, and the old page accepted it in silence.
    const { tab, settings, applied, snapshot } = tabWith(() =>
      Promise.reject(new ApiError("not found", 404, "not_found"))
    );
    await probeVia(tab, "https://wrong.example.workers.dev", "token");

    // The refusal is on screen, which proves the probe ran and failed rather than never
    // having been reached.
    const said = (tab as unknown as { containerEl: { log: { paragraphs: string[] } } }).containerEl.log.paragraphs.join(" ");
    expect(said).toContain("Could not read that vault");
    expect(said).toContain("Nothing has been saved");
    expect(JSON.stringify(settings)).toBe(snapshot);
    expect(applied).toEqual([]);
    expect(settings.masterKey).toBe("");
  });

  it("mints no key while the probe has not answered", async () => {
    const { tab, settings, applied } = tabWith(() =>
      Promise.reject(new ApiError("unauthorized", 401, "unauthorized"))
    );
    await probeVia(tab, "https://v.example.workers.dev", "dead-token");
    expect(settings.masterKey).toBe("");
    expect(settings.encryptionMode).toBe(DEFAULT_SETTINGS.encryptionMode);
    expect(applied).toEqual([]);
  });
});

describe("the probe is bound to the credentials it inspected", () => {
  it("drops a reply that arrives after the credentials changed", async () => {
    // The reviewed hazard: an "empty vault" answer about vault A landing after the user has
    // retyped the URL for encrypted vault B would offer "Create this vault" and mint a key
    // over B's snapshots.
    let release: (v: string | null) => void = () => {};
    const slow = new Promise<string | null>((r) => {
      release = r;
    });
    const { tab, settings, applied } = tabWith(() => slow);
    tab.display();
    const rows = (tab as unknown as { containerEl: { log: { rows: { texts: { change: (v: string) => void }[]; buttons: { text: string; click: () => unknown }[] }[] } } }).containerEl.log.rows;
    rows[1].texts[0].change("https://a.example.workers.dev");
    rows[2].texts[0].change("token-a");
    const check = rows.flatMap((r) => r.buttons).find((b) => b.text === "Check");
    if (check === undefined) throw new Error("no Check button");
    check.click();

    // The user retypes while the request is still out.
    rows[1].texts[0].change("https://b.example.workers.dev");
    release(null); // vault A answers "empty"
    await flush();

    // No "Create this vault" button, because that answer was about a URL no longer typed.
    const names = (tab as unknown as { containerEl: { log: { rows: { buttons: { text: string }[] }[] } } }).containerEl.log.rows
      .flatMap((r) => r.buttons)
      .map((b) => b.text);
    expect(names).not.toContain("Create this vault");
    expect(settings.masterKey).toBe("");
    expect(applied).toEqual([]);
  });
});
