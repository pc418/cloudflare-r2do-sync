// Group 3 — Encryption (destructive; runs on its own dedicated sandbox — see harness.ts's
// `liveConfig`). This group guards whether a vault stays readable, so every migration here is
// proven by a ROUND TRIP (a second device, holding only the new key, reading back the exact
// original bytes) rather than by trusting a moved head or a success notice.
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveMasterKeyFromPassphrase, generateMasterKey } from "../../src/crypto";
import { Modal, Plugin, type FakeElement } from "../obsidian-fake";
import { LiveHarness, liveConfig, vaultRoot, type LiveConfig } from "./harness";
import path from "node:path";

const config = liveConfig("encryption");

/** Vault-relative content this group publishes and later reads back byte-for-byte. */
const SEED_FILES: Record<string, string> = {
  "note.md": "hello from the encryption suite\n",
  "notes/nested.md": "a second file, in a subfolder\n",
};

async function fetchHead(): Promise<string | null> {
  const res = await fetch(`${config!.url}/api/head`, {
    headers: { authorization: `Bearer ${config!.token}` },
  });
  if (!res.ok) throw new Error(`GET /api/head failed: ${res.status}`);
  return ((await res.json()) as { head: string | null }).head;
}

interface ManifestShape {
  v: number;
  files?: Record<string, unknown>;
}

async function fetchManifest(id: string): Promise<ManifestShape> {
  const res = await fetch(`${config!.url}/api/manifests/${id}`, {
    headers: { authorization: `Bearer ${config!.token}` },
  });
  if (!res.ok) throw new Error(`GET /api/manifests/${id} failed: ${res.status}`);
  return (await res.json()) as ManifestShape;
}

/**
 * The secret textarea `secretField()` (main.ts) draws directly into a modal's content — not
 * through a `Setting`, so it will not show up in `content.log.rows`. Mirrors `linkField()` in
 * device-setup.spec.ts, the offline test for the sibling export this modal shares a pattern with.
 */
function secretValue(content: FakeElement): string | undefined {
  return content.children.flatMap((c) => [c, ...c.children]).find((c) => c.tag === "textarea")?.value;
}

/** A never-configured device: `encryptionMode: "encrypted"` with no key, exactly what
 *  `DEFAULT_SETTINGS` ships. Reaching this deliberately (rather than the harness's plaintext
 *  default) is the only way to exercise `rebuild()`'s automatic key-generation branch. */
function freshInstallHarness(files?: Record<string, string>): Promise<LiveHarness> {
  return LiveHarness.start(config!, {
    files,
    persisted: { settings: { encryptionMode: "encrypted", masterKey: "", masterKeyBackedUp: false } },
  });
}

/**
 * Proves a re-key by having a SECOND, independent device — its own directory, holding only the
 * new key — pull the vault and read back the exact bytes. A moved head or a "migrated N files"
 * notice both prove a write happened; neither proves the result is still readable.
 */
async function assertRoundTrip(
  key: string,
  vaultSalt: string,
  files: Record<string, string>,
  label: string
): Promise<void> {
  const verifyConfig: LiveConfig = { ...config!, root: path.join(vaultRoot(), `encryption-verify-${label}`) };
  const fresh = await LiveHarness.start(verifyConfig, {
    persisted: { settings: { encryptionMode: "encrypted", masterKey: key, masterKeyBackedUp: true, vaultSalt } },
  });
  try {
    await fresh.plugin.syncNow();
    for (const [rel, contents] of Object.entries(files)) {
      expect(await fresh.read(rel)).toBe(contents);
    }
  } finally {
    await fresh.dispose();
  }
}

// Carried from the "Generate" test into the "Vault master key" (REKEY) tests: this group's
// rows are a narrative — encrypt, then re-key an already-encrypted, already-synced vault — and
// the plan's own wording ("Enter a different key on a vault with a synced snapshot") only makes
// sense once something upstream has actually encrypted and synced. `KEY1`/`SALT1` are that state.
let KEY1 = "";
let SALT1 = "";

describe.skipIf(config === null)("Encryption", () => {
  let harness: LiveHarness | null = null;
  afterEach(async () => {
    await harness?.dispose();
    harness = null;
  });

  // Beyond the plan's literal "click Generate": this is the one flow where the plan's hard
  // rule ("the key must be persisted before the backup window opens") is mechanically
  // guaranteed — `rebuild()` awaits `#persist()` before calling `#promptBackupKey()`. The
  // settings-page "Generate" button (next test) does NOT share this guarantee: it hands the
  // candidate key straight to `BackupKeyModal` without writing it first, because nothing has
  // been encrypted with it yet either way. See FINDINGS in the final report.
  it("a brand-new install writes the generated key to disk before the backup window can show it", async () => {
    // Plain `vi.spyOn` (no `mockImplementation`) calls through to the real method while
    // recording `invocationCallOrder` — comparing those orders proves the write happened
    // before the window opened, without taking an unbound reference to either method.
    const saveSpy = vi.spyOn(Plugin.prototype, "saveData");
    const openSpy = vi.spyOn(Modal.prototype, "open");
    try {
      harness = await freshInstallHarness();
      const key = harness.plugin.settings.masterKey;
      expect(key).not.toBe("");
      const modal = harness.top();
      // The modal that auto-opened is showing exactly the key that was just written to disk.
      expect(secretValue(modal.contentEl)).toBe(key);

      const saveIndex = saveSpy.mock.calls.findIndex(
        (args) => (args[0] as { settings?: { masterKey?: string } }).settings?.masterKey === key
      );
      const openIndex = openSpy.mock.contexts.findIndex((ctx) => ctx === modal);
      expect(saveIndex).toBeGreaterThanOrEqual(0);
      expect(openIndex).toBeGreaterThanOrEqual(0);
      expect(saveSpy.mock.invocationCallOrder[saveIndex]).toBeLessThan(
        openSpy.mock.invocationCallOrder[openIndex]
      );
    } finally {
      saveSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it("dismissing the backup window without acknowledging leaves encryption blocked and the head unmoved", async () => {
    const headBefore = await fetchHead();
    harness = await freshInstallHarness();

    harness.top().close();

    expect(harness.plugin.settings.masterKeyBackedUp).toBe(false);
    expect(await fetchHead()).toBe(headBefore);
  });

  it('"Back up now" reopens the backup window for the same unacknowledged key, not a new one', async () => {
    harness = await freshInstallHarness();
    harness.top().close(); // dismissed, per the previous test — still blocked, key still on disk
    const key = harness.plugin.settings.masterKey;

    harness.render();
    const button = harness.button("Key backup required", "Back up now");
    expect(button.disabled).toBe(false);
    const modal = await harness.opens(() => button.click());

    expect(modal.contentEl.log.headings).toContain("Back up the vault master key");
    expect(secretValue(modal.contentEl)).toBe(key);
  });

  it('Generate: encrypting an already-synced plaintext vault asks first, then runs the real migration', async () => {
    // Deliberately syncs plaintext BEFORE encrypting, rather than encrypting a never-synced
    // device: this sandbox is reused across runs of this file (nothing purges it between
    // them), so a bare "never synced" assumption only held on the very first run — the second
    // run found SEED_FILES already published by the first, and a brand-new random key handed
    // to a never-synced device that then discovers a non-empty, differently-keyed remote is
    // exactly the mismatch `#applyEncryptionTarget` correctly refuses. Converging on plaintext
    // first (a no-op push on an empty remote, a harmless no-op merge on a repeat run) makes
    // this test idempotent AND exercises the "Encrypt this vault now?" gate — the OTHER half
    // of the same title ternary the "Replace the vault master key?" tests below exercise.
    harness = await LiveHarness.start(config!, { files: SEED_FILES }); // plaintext default
    const h = harness;
    await h.plugin.syncNow();
    expect(h.plugin.hasSyncedSnapshot).toBe(true);
    h.render();

    const confirmModal = await h.opens(() => h.button("Vault master key", "Generate").click());
    expect(confirmModal.contentEl.log.headings).toContain("Encrypt this vault now?");
    const backupModal = await h.opens(() => h.confirm("REKEY", "Confirm"));
    const shownKey = secretValue(backupModal.contentEl);
    expect(shownKey).toBeTruthy();

    // A synced vault's "I saved it" IS the migration (one CAS commit), unlike the never-synced
    // case where it only activates the mode locally — there is nothing further to publish.
    await h.modalButton("I saved it").click();
    expect(h.plugin.settings.masterKeyBackedUp).toBe(true);
    expect(h.plugin.settings.masterKey).toBe(shownKey);
    expect(h.plugin.encryptionEnabled).toBe(true);
    expect(h.notices().at(-1)).toMatch(/migrated \d+ file/i);

    const head = await fetchHead();
    expect(head).not.toBeNull();
    const manifest = await fetchManifest(head!);
    expect(manifest.v).toBe(3); // v3: encrypted AND envelope-authenticated

    KEY1 = shownKey!;
    SALT1 = h.plugin.settings.vaultSalt;
    expect(SALT1).not.toBe("");
  });

  it("entering a different key on a synced, already-encrypted vault asks to replace the master key", async () => {
    harness = await LiveHarness.start(config!, {
      persisted: { settings: { encryptionMode: "encrypted", masterKey: KEY1, masterKeyBackedUp: true, vaultSalt: SALT1 } },
    });
    const h = harness;
    await h.plugin.syncNow(); // converge: pull KEY1's snapshot so hasSyncedSnapshot is true
    expect(h.plugin.hasSyncedSnapshot).toBe(true);
    h.render();

    const field = h.row("Vault master key").texts[0];
    field.change(generateMasterKey());
    const modal = await h.opens(() => field.inputEl.fire("blur"));

    expect(modal.contentEl.log.headings).toContain("Replace the vault master key?");
    const confirmButton = harness.modalButton("Confirm");
    expect(confirmButton.disabled).toBe(true); // REKEY not typed yet

    await harness.modalButton("Cancel").click();
  });

  it("mistyping REKEY leaves the confirm button disabled and publishes nothing", async () => {
    harness = await LiveHarness.start(config!, {
      persisted: { settings: { encryptionMode: "encrypted", masterKey: KEY1, masterKeyBackedUp: true, vaultSalt: SALT1 } },
    });
    const h = harness;
    await h.plugin.syncNow();
    const headBefore = await fetchHead();
    h.render();

    const field = h.row("Vault master key").texts[0];
    field.change(generateMasterKey());
    await h.opens(() => field.inputEl.fire("blur"));

    await harness.confirm("rekey", "Confirm"); // wrong case
    // The guard is in the handler, not just the disabled attribute (the fake ignores
    // `disabled` on click), so a real assertion has to check both.
    expect(harness.modalButton("Confirm").disabled).toBe(true);
    expect(await fetchHead()).toBe(headBefore);
  });

  it("typing REKEY replaces the master key; a fresh device with the new key reads the same bytes back", async () => {
    harness = await LiveHarness.start(config!, {
      persisted: { settings: { encryptionMode: "encrypted", masterKey: KEY1, masterKeyBackedUp: true, vaultSalt: SALT1 } },
    });
    const h = harness;
    await h.plugin.syncNow();
    const headBefore = await fetchHead();
    h.render();

    const KEY2 = generateMasterKey();
    const field = h.row("Vault master key").texts[0];
    field.change(KEY2);
    await h.opens(() => field.inputEl.fire("blur"));

    // REKEY confirmed → BackupKeyModal for the new key. `opens` covers the fact that the
    // window comes from inside `onConfirm`, not from the click's own return.
    await h.opens(() => h.confirm("REKEY", "Confirm"));
    // "I saved it" runs the actual migration (every blob re-encrypted, one CAS commit).
    await harness.modalButton("I saved it").click();

    expect(harness.notices().at(-1)).toMatch(/migrated \d+ file/i);
    const headAfter = await fetchHead();
    expect(headAfter).not.toBe(headBefore);

    await assertRoundTrip(KEY2, SALT1, SEED_FILES, "rekey");
    KEY1 = KEY2; // this device's key is now the vault's key — later tests build on it
  });

  it("a mismatched passphrase confirmation is refused inline, with no key change", async () => {
    harness = await LiveHarness.start(config!); // plaintext default; no key to protect
    const h = harness;
    h.render();

    const modal = await h.opens(() => h.button("Vault master key", "Set from passphrase").click());
    const rows = modal.contentEl.log.rows;
    rows[0].texts[0].change("correct horse battery staple");
    rows[1].texts[0].change("not the same phrase");
    await harness.modalButton("Derive key").click();

    expect(harness.notices().at(-1)).toContain("do not match");
    expect(Modal.shown.at(-1)).toBe(modal); // refused inline, not dismissed
    expect(harness.plugin.settings.masterKey).toBe("");
  });

  it("a matching passphrase derives a key and re-keys the vault the same way, round-tripping the new key", async () => {
    harness = await LiveHarness.start(config!, {
      persisted: { settings: { encryptionMode: "encrypted", masterKey: KEY1, masterKeyBackedUp: true, vaultSalt: SALT1 } },
    });
    const h = harness;
    await h.plugin.syncNow();
    const headBefore = await fetchHead();
    h.render();

    const modal = await h.opens(() => h.button("Vault master key", "Set from passphrase").click());
    const rows = modal.contentEl.log.rows;
    const passphrase = "a long unique passphrase nobody would guess offline";
    rows[0].texts[0].change(passphrase); // passphrase
    rows[1].texts[0].change(passphrase); // confirmation — matches
    // Salt field (rows[2]) is left at its prefilled value (the vault's existing SALT1): a
    // changed salt is a separately-guarded shared-settings conflict, not what this row tests.
    const confirmModal = await h.opens(() => h.modalButton("Derive key").click());

    // Derivation succeeded and handed off to the same REKEY gate the manual-key path uses.
    expect(confirmModal.contentEl.log.headings).toContain("Replace the vault master key?");
    await h.opens(() => h.confirm("REKEY", "Confirm"));
    await harness.modalButton("I saved it").click();

    expect(harness.notices().at(-1)).toMatch(/migrated \d+ file/i);
    expect(await fetchHead()).not.toBe(headBefore);

    const KEY3 = await deriveMasterKeyFromPassphrase(passphrase, SALT1);
    await assertRoundTrip(KEY3, SALT1, SEED_FILES, "passphrase");
    KEY1 = KEY3;
  });

  it("Use plaintext, confirmed with REKEY, transforms the snapshot to a legible plaintext manifest", async () => {
    // Builds on KEY1/SALT1 rather than a fresh random key: the vault's remote head is already
    // encrypted under KEY1 (the passphrase test above left it there), and a device that shows
    // up with an unrelated brand-new key fails the same mode/key check `migrateEncryption`
    // itself enforces — it just fails silently inside `syncNow()`'s catch-and-report instead of
    // throwing at the test. Converging with the vault's actual current key first is required,
    // not optional, exactly like every other REKEY test in this file.
    harness = await LiveHarness.start(config!, {
      persisted: { settings: { encryptionMode: "encrypted", masterKey: KEY1, masterKeyBackedUp: true, vaultSalt: SALT1 } },
    });
    const h = harness;
    await h.plugin.syncNow();
    expect(h.plugin.hasSyncedSnapshot).toBe(true);
    const headBefore = await fetchHead();

    h.render();
    const modal = await h.opens(() => h.button("Turn off encryption", "Use plaintext").click());
    expect(modal.contentEl.log.headings).toContain("Turn off encryption?");
    // Unlike the encrypted-target branch (which routes through `BackupKeyModal`, whose "I saved
    // it" click is properly awaited), the plaintext target calls `#applyEncryptionTarget`
    // fire-and-forget (`void ...catch(...)`) straight from `onConfirm` — so the confirm click
    // itself resolves before the migration finishes, and only polling the actual head proves it.
    await h.confirm("REKEY", "Confirm");
    await h.waitFor(async () => (await fetchHead()) !== headBefore, {
      label: "the plaintext migration to publish a new head",
    });

    const head = await fetchHead();
    expect(head).not.toBeNull();
    expect(head).not.toBe(headBefore);
    const manifest = await fetchManifest(head!);
    // The real acceptance test: paths are readable in the manifest itself, not just "mode
    // says plaintext" — a mode flag can be wrong without anyone re-checking the bytes on R2.
    expect(manifest.v).toBe(1);
    expect(Object.keys(manifest.files ?? {})).toEqual(expect.arrayContaining(Object.keys(SEED_FILES)));
  });
});
