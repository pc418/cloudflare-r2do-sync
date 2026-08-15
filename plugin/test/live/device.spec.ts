// Group 2 — This device. Setup-link export/import is the one path a person uses maybe twice
// ever (new phone, new laptop) and never rehearses — a wiring bug here strands a real device.
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateMasterKey, generateVaultSalt } from "../../src/crypto";
import { normalizeServerUrl, parseSetupText } from "../../src/setup-link";
import { Modal, type FakeElement, type Setting } from "../obsidian-fake";
import { LiveHarness, liveConfig } from "./harness";

const config = liveConfig("device");

interface SettingsDocShape {
  v: number;
  rev?: number;
  updatedAt: number;
  device: string;
  /** Present on v1 (plaintext) documents only — the harness default this file runs against. */
  plain?: { logNoteFolder?: string };
}

async function fetchSettingsDoc(): Promise<SettingsDocShape | null> {
  const res = await fetch(`${config!.url}/api/settings`, {
    headers: { authorization: `Bearer ${config!.token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /api/settings failed: ${res.status}`);
  return (await res.json()) as SettingsDocShape;
}

/**
 * `renderQr` draws the code through `document.createElementNS`, which the harness's real-timer
 * stub (`installTimers` in harness.ts) does not provide — it only carries `visibilityState`,
 * all the lifecycle code it exists for touches. Must run AFTER `LiveHarness.start()`, which
 * reinstalls a bare `document` on every call; none of these tests read `visibilityState`, so
 * replacing it outright here is safe. Kept local rather than added to the shared harness,
 * per instructions not to touch shared test code.
 */
function stubQrDocument(): void {
  Object.assign(globalThis, {
    document: {
      createElementNS: (_ns: string, tagName: string) => ({
        tagName,
        setAttribute() {},
        appendChild() {},
      }),
    },
  });
}

/** A row inside a modal's body, the way `harness.row()` finds one on the settings tab. */
function modalRow(modal: Modal, name: string): Setting {
  const log = modal.contentEl.log;
  const at = log.settings.findIndex((s) => s.name === name);
  if (at === -1) {
    throw new Error(`no modal row named "${name}"; rendered: ${log.settings.map((s) => s.name).join(", ")}`);
  }
  return log.rows[at];
}

/** Depth-first search for a node of a given tag — the QR's outer `<svg>`, drawn via `appendChild`. */
function findByTag(el: FakeElement, tag: string): FakeElement | undefined {
  for (const child of el.children) {
    if (child.tag === tag) return child;
    const nested = findByTag(child, tag);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

describe.skipIf(config === null)("This device", () => {
  let harness: LiveHarness | null = null;
  afterEach(async () => {
    await harness?.dispose();
    harness = null;
    vi.unstubAllGlobals();
  });

  it('Device name: type + blur updates settings.deviceName with no HTTP', async () => {
    harness = await LiveHarness.start(config!);
    harness.render();
    const before = harness.http.calls;
    const field = harness.row("Device name").texts[0];

    field.change("workshop-laptop");
    field.inputEl.fire("blur");

    expect(harness.plugin.settings.deviceName).toBe("workshop-laptop");
    // A device name is recorded in commits; it must never itself cost a round trip.
    expect(harness.http.calls).toBe(before);
  });

  it('has no "Set up another device" row at all when unconfigured — the page swaps to first-run instead', async () => {
    // FINDING vs. plan: the plan describes this as "button disabled, description says why".
    // In fact `LogSyncSettingTab.display()` swaps the whole page for `#renderFirstRun()` and
    // returns before ever calling `#renderThisDevice()` (main.ts, the `fresh` branch around
    // line 4414-4428) — there is no "Set up another device" row to be disabled. The real
    // behaviour is arguably better (no dead-end button), but it is not what the plan says, so
    // this asserts what actually renders: the first-run panel's own hand-in route.
    harness = await LiveHarness.start(config!, {
      persisted: { settings: { serverUrl: "", accessToken: "" } },
    });
    const log = harness.render();

    expect(log.headings).toContain("Set up sync");
    expect(log.settings.some((s) => s.name === "Set up another device")).toBe(false);
    const join = harness.row("Join a vault that already syncs");
    expect(join.rendered.desc).toMatch(/master key/i);
    expect(harness.button("Join a vault that already syncs").disabled).toBe(false);
  });

  it('Set up device is disabled and explains why when the key is not backed up', async () => {
    // Distinct from the unconfigured case: this exercises the OTHER guard in the same
    // ternary (`encryptionEnabled && !masterKeyBackedUp`), which a single "blocked" test
    // covering only the first branch would never touch.
    harness = await LiveHarness.start(config!, {
      persisted: {
        settings: {
          encryptionMode: "encrypted",
          masterKey: generateMasterKey(),
          masterKeyBackedUp: false,
          vaultSalt: generateVaultSalt(),
        },
      },
    });
    harness.render();

    const button = harness.button("Set up another device");
    expect(button.disabled).toBe(true);
    expect(harness.row("Set up another device").rendered.desc).toMatch(/back up the vault master key/i);
  });

  it('Set up device opens DeviceSetupModal with name and token fields when ready', async () => {
    harness = await LiveHarness.start(config!);
    harness.render();

    harness.button("Set up another device").click();

    const modal = harness.top();
    expect(modal.contentEl.texts().join(" ")).toMatch(/set up another device/i);
    expect(modalRow(modal, "New device name").texts[0].getValue()).toBe("phone");
    expect(modalRow(modal, "Token").texts[0].getValue()).toBe(config!.token);
  });

  it('Show QR draws the code and populates a read-only setup-link field', async () => {
    harness = await LiveHarness.start(config!);
    harness.render();
    harness.button("Set up another device").click();
    stubQrDocument();

    harness.modalButton("Show QR").click();

    const modal = harness.top();
    // "A node is appended" — the QR itself, not just the field beside it.
    expect(findByTag(modal.contentEl, "svg")).toBeDefined();
    const field = modal.contentEl.byClass("r2do-secret").at(-1);
    expect(field).toBeDefined();
    expect(field!.readOnly).toBe(true);
    const payload = parseSetupText(field!.value);
    expect(normalizeServerUrl(payload.url)).toBe(normalizeServerUrl(config!.url));
  });

  it('Copy setup link parses back to this device\'s server/token/mode, and offers the field selected when the clipboard refuses', async () => {
    harness = await LiveHarness.start(config!);
    harness.render();
    harness.button("Set up another device").click();
    // Deterministic failure rather than trusting Node's ambient (and version-dependent)
    // `navigator.clipboard` to already be absent — the fallback path must be provably reached,
    // not incidentally exercised.
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: () => Promise.reject(new Error("clipboard unavailable in this sandbox")),
      },
    });

    await harness.modalButton("Copy setup link").click();

    const modal = harness.top();
    const field = modal.contentEl.byClass("r2do-secret").at(-1);
    expect(field).toBeDefined();
    const payload = parseSetupText(field!.value);
    expect(normalizeServerUrl(payload.url)).toBe(normalizeServerUrl(config!.url));
    expect(payload.token).toBe(config!.token);
    expect(payload.mode).toBe("plaintext"); // harness default; Group 3 covers encrypted mode
    // The dead-end this test exists to catch: a clipboard failure that leaves the user with
    // no way to get the secret out except retyping it by hand.
    expect(field!.selected).toBe(true);
  });

  it('Paste link + Continue opens ApplySetupModal naming the same server; Cancel leaves every setting untouched', async () => {
    harness = await LiveHarness.start(config!);
    const originalServerUrl = harness.plugin.settings.serverUrl;
    const originalToken = harness.plugin.settings.accessToken;
    const originalDeviceName = harness.plugin.settings.deviceName;
    harness.render();

    // Build a real link the way a person would, on this same device.
    harness.button("Set up another device").click();
    await harness.modalButton("Copy setup link").click();
    const linkField = harness.top().contentEl.byClass("r2do-secret").at(-1);
    expect(linkField).toBeDefined();
    const uri = linkField!.value;
    harness.top().close();

    harness.render();
    harness.button("Apply a setup link").click();
    modalRow(harness.top(), "Setup link").texts[0].change(uri);
    harness.modalButton("Continue").click();

    const applyModal = harness.top();
    expect(applyModal.contentEl.texts().join(" ")).toMatch(new RegExp(`Server: ${config!.url}`));

    harness.modalButton("Cancel").click();

    expect(harness.plugin.settings.serverUrl).toBe(originalServerUrl);
    expect(harness.plugin.settings.accessToken).toBe(originalToken);
    expect(harness.plugin.settings.deviceName).toBe(originalDeviceName);
  });

  it('Apply replaces serverUrl/accessToken/deviceName, resets sync state, and a pass runs', async () => {
    harness = await LiveHarness.start(config!, { files: { "welcome.md": "hello from the device group\n" } });
    harness.render();

    // A distinct device name proves the payload's own value flowed through, not a leftover.
    harness.button("Set up another device").click();
    modalRow(harness.top(), "New device name").texts[0].change("second-device");
    await harness.modalButton("Copy setup link").click();
    const uri = harness.top().contentEl.byClass("r2do-secret").at(-1)!.value;
    harness.top().close();

    harness.render();
    harness.button("Apply a setup link").click();
    modalRow(harness.top(), "Setup link").texts[0].change(uri);
    harness.modalButton("Continue").click();

    await harness.modalButton("Apply").click();

    expect(harness.plugin.settings.serverUrl).toBe(normalizeServerUrl(config!.url));
    expect(harness.plugin.settings.accessToken).toBe(config!.token);
    expect(harness.plugin.settings.deviceName).toBe("second-device");
    // `applySetup` drops the cached head synchronously, before its own first `await` — this
    // device owes a fresh reconciliation with whatever the payload's vault actually holds.
    expect(harness.plugin.hasSyncedSnapshot).toBe(false);

    // `applySetup` re-arms first-sync consent for the "new" vault and fires its own pass in
    // the background (`void this.syncNow()`), which — by the time the Apply click above has
    // resolved — has already reached that gate and opened its confirmation modal, all inside
    // the same synchronous stretch of async-function execution (no macrotask crossed yet).
    const gate = harness.top();
    expect(gate.contentEl.texts().join(" ")).toMatch(/back up this vault before the first sync/i);
    // Awaited: the confirmation's own promise chain is what flips `firstSyncAcknowledged`
    // and clears `#firstSyncModalOpen` — racing ahead without awaiting it left both still
    // stale when the join below ran, so the join read "no one answered" and bailed out
    // instead of running the pass.
    await harness.modalButton("I have a backup — sync").click();

    // Join (or, if it already finished, immediately settle) the pass applySetup started.
    await harness.plugin.syncNow();

    expect(harness.plugin.hasSyncedSnapshot).toBe(true);
    const headRes = await fetch(`${config!.url}/api/head`, {
      headers: { authorization: `Bearer ${config!.token}` },
    });
    const headBody = (await headRes.json()) as { head: string | null };
    expect(headBody.head).not.toBeNull();
  });

  it('Sync settings between devices: toggling on publishes settings/policy.json after a pass', async () => {
    harness = await LiveHarness.start(config!, {
      files: { "shared-settings-probe.md": "x\n" },
    });
    harness.render();

    const toggle = harness.row("Sync settings between devices").toggles[0];
    await toggle.change(true);
    expect(harness.plugin.settings.syncSettings).toBe(true);

    // A device turning this on for the first time has no local memory of the shared doc, so
    // `#pullSharedSettings` (main.ts) unconditionally ADOPTS whatever is already published —
    // its "already caught up" shortcut only fires once `#sharedSettings` is non-null. Catch
    // this device up first, the way a real one would, before proving the actual publish path;
    // otherwise a field changed below is just overwritten by the pull and nothing publishes.
    await harness.plugin.syncNow();
    const baseline = await fetchSettingsDoc();
    expect(baseline).not.toBeNull();

    // Now this device's cache matches the published rev, so a local edit is a genuine delta —
    // `syncSettings` itself is deliberately excluded from `SharedSettings` (settings-doc.ts:
    // "turning it off must stick locally"), so the toggle alone would never publish anything.
    const probe = `probe-${String(Date.now())}`;
    harness.plugin.settings.logNoteFolder = probe;
    await harness.plugin.syncNow();

    const after = await fetchSettingsDoc();
    expect(after).not.toBeNull();
    expect(after!.rev ?? 0).toBeGreaterThan(baseline!.rev ?? 0);
    expect(after!.plain?.logNoteFolder).toBe(probe);
  });
});
