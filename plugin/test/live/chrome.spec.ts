// Group 10 — Global chrome and commands. The ribbon icon and status bar are the only sync
// affordances that are not on the settings page (the status bar does not even exist on
// mobile, where the ribbon is everything), and the eight command-palette commands are the
// hotkey-bindable entry points into actions the settings page also offers as buttons. None of
// that is exercised by plugin/test/*.spec.ts against FakeServer — this proves each one reaches
// the real plugin logic against a real Worker, not just that `addCommand`/`addRibbonIcon` was
// called with a plausible-looking callback.
//
// `LogSyncPlugin` types against the REAL obsidian `Plugin`/`Modal` here (test/live/tsconfig.json
// deliberately does not alias "obsidian" — see its own comment), even though at runtime it is
// built against the fake. So: reach the fake Plugin's recording surface through
// `harness.recorded` (never cast `harness.plugin` directly), and never use a modal class
// exported from src/main.ts (`DeviceSetupModal`, `ApplySetupModal`, `PasteSetupModal`, …) as a
// type or in `instanceof` — those type against the real `Modal` and lack `contentEl.log`. Take
// whatever is on top of `Modal.shown` (the fake, imported from `../obsidian-fake`) instead.
import { afterEach, describe, expect, it } from "vitest";
import { LiveHarness, liveConfig, type LiveConfig } from "./harness";
import { Modal } from "../obsidian-fake";
import { SETUP_ACTION, encodeSetupPayload, encodeSetupUri, type SetupPayload } from "../../src/setup-link";
import type { ConflictInfo } from "../../src/sync";

const config = liveConfig("chrome");

// ---------------------------------------------------------------------------------------------
// Helpers built on `harness.waitFor`/`harness.opens` (see harness.ts): a fixed sleep is a guess
// about a network round trip, and polling a REMOTE endpoint in a tight loop is worse than a
// guess — it floods the same origin the plugin's own in-flight commit is using, competing for
// connections and slowing the very thing being awaited. So state that lives in the plugin
// (status text, notices, `Modal.shown`) is polled locally at no network cost; the server is
// asked exactly once, after the plugin itself reports the pass finished.
// ---------------------------------------------------------------------------------------------

function statusText(harness: LiveHarness): string {
  return harness.recorded.statusBarItems[0]?.text ?? "";
}

const SETTLED = /^Sync: (synced|failed|HALTED|not configured)/;

/** Waits for a pass to leave "syncing…"/progress text and land on a phase that does not change again. */
async function waitForSettled(harness: LiveHarness): Promise<void> {
  await harness.waitFor(() => SETTLED.test(statusText(harness)), {
    timeout: 30_000,
    label: "status bar to settle after a pass",
  });
}

/** GET /api/head with the group's own access token — the one number that proves a pass published. */
async function fetchHead(cfg: LiveConfig): Promise<string | null> {
  const res = await fetch(`${cfg.url}/api/head`, { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (!res.ok) throw new Error(`GET /api/head failed with ${res.status}`);
  return ((await res.json()) as { head: string | null }).head;
}

/**
 * Content that has never been published before, for a test whose assertion is "the head must
 * move". The sandbox vault is shared across runs of this same file (not just within one run —
 * see harness.ts), so a fixed string committed by an earlier run makes this pass's content
 * identical to what the remote already holds, and an identical push is correctly `unchanged`:
 * a stale assertion here reads as a broken pass when the real bug (if any) is nothing of the
 * kind.
 */
function unique(label: string): string {
  return `${label} ${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** A modal's Setting row by name — the modal equivalent of `LiveHarness.row()`. */
function modalRow(modal: Modal, name: string) {
  const log = modal.contentEl.log;
  const at = log.settings.findIndex((s) => s.name === name);
  if (at === -1) {
    throw new Error(`modal has no row named "${name}"; has: ${log.settings.map((s) => s.name).join(", ")}`);
  }
  return log.rows[at];
}

describe.skipIf(config === null)("Global chrome and commands", () => {
  let harness: LiveHarness | null = null;
  afterEach(async () => {
    await harness?.dispose();
    harness = null;
  });

  // -- ribbon and status bar --------------------------------------------------------------------

  it("ribbon icon click runs a real sync pass, proven by the remote head moving", async () => {
    // The ribbon is the ONLY sync control on mobile — there is no status bar there. If its
    // onClick were wired to the wrong method (or nothing), a phone user would tap it forever
    // and nothing would ever leave the device. "A notice appeared" cannot catch that; only the
    // server's own head advancing can.
    harness = await LiveHarness.start(config!, { files: { "ribbon-note.md": unique("ribbon click test") } });
    expect(harness.recorded.ribbonIcons).toHaveLength(1);
    const before = await fetchHead(config!);

    harness.recorded.ribbonIcons[0]!.onClick();
    await waitForSettled(harness);

    expect(statusText(harness)).toMatch(/^Sync: synced /);
    expect(await fetchHead(config!)).not.toBe(before);
  });

  it("status bar click runs a real pass, and its text tracks the pass instead of sitting still", async () => {
    // A status bar stuck on "never synced" while a pass is actually running (or one that jumps
    // straight from "never synced" to "synced" without ever showing work happened) both read as
    // "nothing happened" to someone watching it — the exact ambiguity `#renderStatus` exists to
    // remove. Sampling on an interval is how a test catches a state that is real but transient;
    // this samples only the plugin's own in-memory text, so it costs the pass nothing.
    harness = await LiveHarness.start(config!, { files: { "statusbar-note.md": "status bar click test" } });
    const item = harness.recorded.statusBarItems[0]!;
    const initial = item.text;
    const samples: string[] = [initial];

    item.clickHandler?.();
    await harness.waitFor(
      () => {
        samples.push(item.text);
        return /^Sync: (synced|failed|HALTED)/.test(item.text);
      },
      { timeout: 30_000, label: "status bar to settle after a click" }
    );

    const settled = item.text;
    expect(settled).toMatch(/^Sync: synced /);
    expect(settled).not.toBe(initial);
    // Somewhere between the click and settling, the text names actual work in progress
    // ("syncing…", or "uploading N/M" once progress callbacks start firing).
    expect(samples.some((t) => /syncing|uploading|pulling/i.test(t))).toBe(true);
  });

  // -- the eight commands, by id -----------------------------------------------------------------

  it('"sync-now" runs the same pass as the ribbon and status bar, reached through the command palette', async () => {
    // The settings tab, the ribbon, the status bar and this command all end up calling the same
    // `syncNow()` — but a command is registered by id text, and a typo in that id (or a
    // callback that silently does nothing) would still show up fine in a code review. Only
    // driving it exactly the way the command palette does (`runCommand`) catches that.
    harness = await LiveHarness.start(config!, { files: { "sync-now-note.md": unique("sync-now command test") } });
    const before = await fetchHead(config!);

    harness.recorded.runCommand("sync-now");
    await waitForSettled(harness);

    expect(await fetchHead(config!)).not.toBe(before);
  });

  it('"sync-preview" opens the same dry-run window as the Preview button, and changes nothing', async () => {
    // Preview's whole contract is "nothing is changed" (docs/…SNAPSHOT_HISTORY…: "a dry run
    // that writes is not a dry run"). Reached via `void this.previewSync()`, same as the
    // settings-page button — this proves the command side of that wiring specifically.
    harness = await LiveHarness.start(config!, { files: { "preview-note.md": "would be pushed" } });
    const before = await fetchHead(config!);

    const modal = await harness.opens(() => harness!.recorded.runCommand("sync-preview"));

    expect(modal.contentEl.log.headings[0]).toBe("Sync preview");
    expect(await fetchHead(config!)).toBe(before);
  });

  it('"sync-history" opens the snapshot browser, listing the snapshot a prior pass just made', async () => {
    harness = await LiveHarness.start(config!, { files: { "history-note.md": "history command test" } });
    harness.recorded.runCommand("sync-now");
    await waitForSettled(harness);

    const modal = await harness.opens(() => harness!.recorded.runCommand("sync-history"));

    expect(modal.contentEl.log.headings[0]).toBe("Snapshot history");
    // `onOpen` is async (it fetches the list), so the rows populate after the modal is already
    // on top — checking too early would be a false negative here, not a pass.
    // Snapshot rows only. The Group by and Between controls render synchronously, so waiting
    // on `settings.length` would be satisfied before the list had loaded anything at all.
    await harness.waitFor(
      () =>
        LiveHarness.historyRows(modal.contentEl.log).length > 0 ||
        modal.contentEl.log.paragraphs.some((p) => /no snapshots/i.test(p)),
      { label: "history list to finish loading" }
    );
    expect(LiveHarness.historyRows(modal.contentEl.log).length).toBeGreaterThan(0);
  });

  it('"sync-export-log" writes a report note to disk, same as the Export button', async () => {
    harness = await LiveHarness.start(config!, { files: { "export-note.md": "export command test" } });
    harness.recorded.runCommand("sync-now");
    await waitForSettled(harness);

    harness.recorded.runCommand("sync-export-log");

    await harness.waitFor(
      async () => (await harness!.files()).some((f) => /^r2do-sync-report-.*\.md$/.test(f)),
      { label: "report note to appear on disk" }
    );
    const report = (await harness.files()).find((f) => /^r2do-sync-report-.*\.md$/.test(f))!;
    const content = await harness.read(report);
    // Not empty, and not an error page — `formatLogNote` names the pass that just ran.
    expect(content.length).toBeGreaterThan(0);
  });

  it('"sync-review-conflicts" with nothing recorded shows a notice, never an empty window', async () => {
    // This is the one behavioural difference from its settings-page twin: the "Review N" button
    // is simply `disabled` when there is nothing to show, so it can never be clicked into an
    // empty window in the first place. A *command* has no disabled state — it always runs — so
    // main.ts has to make the same decision explicitly (the id === "sync-review-conflicts"
    // callback checks `lastConflicts.length` itself). An empty `ConflictReportModal` popping up
    // here would be that check missing.
    harness = await LiveHarness.start(config!);

    harness.recorded.runCommand("sync-review-conflicts");

    expect(harness.notices().at(-1)).toMatch(/no conflicts recorded/i);
    expect(Modal.shown).toHaveLength(0);
  });

  it('"sync-review-conflicts" with a recorded conflict opens the review window, same as "Review N"', async () => {
    const conflict: ConflictInfo = {
      path: "conflict-note.md",
      // `copy: null` — the losing version was overwritten by conflict handling, so the entry is
      // a record, not an offer: `pruneResolved` keeps entries like this regardless of what is on
      // disk (see conflict-resolve.ts), which is exactly why seeding it needs no real conflict.
      copy: null,
      kept: "ours",
      ours: { mtime: Date.now(), size: 10 },
      theirs: { mtime: Date.now() - 1000, size: 12 },
    };
    harness = await LiveHarness.start(config!, { persisted: { lastConflicts: [conflict] } });

    const modal = await harness.opens(() => harness!.recorded.runCommand("sync-review-conflicts"));

    expect(modal.contentEl.log.headings[0]).toMatch(/1 conflict/);
    expect(harness.notices().some((n) => /no conflicts recorded/i.test(n))).toBe(false);
  });

  it('"sync-reset" clears a halted engine and attempts a fresh pass', async () => {
    // A stale-key mismatch is the one halt this suite can force deterministically and locally:
    // `#sync()` computes `keyChanged` from the cached state before it touches the network (see
    // sync.ts), so seeding a `keyId` that disagrees with this (plaintext) device's own halts
    // immediately, with nothing to set up server-side. Once halted, `engine.sync()` takes a
    // short-circuit branch that returns the CACHED reason without re-running `#sync()` at all
    // (sync.ts: `if (this.status.phase === "halted") return this.#result(...)`) — so the only
    // way to see the engine actually try again is for `reset()` to run first. That the reason
    // recurs is expected (the underlying cause is still there); what this proves is that the
    // command cleared the flag and re-entered the engine rather than doing nothing.
    harness = await LiveHarness.start(config!, {
      persisted: { state: { lastSyncedHead: "01FAKEHEADFORCHROMEHALTTEST", files: {}, keyId: "stale-key-id" } },
    });

    harness.recorded.runCommand("sync-now");
    await harness.waitFor(() => statusText(harness!) === "Sync: HALTED", { label: "engine to halt" });
    expect(harness.notices().some((n) => /halted:.*last synced snapshot/i.test(n))).toBe(true);
    const noticesBeforeReset = harness.notices().length;

    harness.recorded.runCommand("sync-reset");

    expect(harness.notices().at(noticesBeforeReset)).toMatch(/halt cleared, retrying/i);
    // A second, freshly-generated "halted" notice — not just the "cleared" one — is the
    // evidence a new pass actually ran through the engine rather than the reset being a no-op.
    await harness.waitFor(
      () => harness!.notices().slice(noticesBeforeReset + 1).some((n) => /R2DO Sync halted:/.test(n)),
      { label: "a second halted notice from the retried pass" }
    );
  });

  it('"sync-setup-qr" opens the device-setup window with name and token fields, same as "Set up device"', async () => {
    harness = await LiveHarness.start(config!);

    const modal = await harness.opens(() => harness!.recorded.runCommand("sync-setup-qr"));

    expect(modal.contentEl.log.headings[0]).toBe("Set up another device");
    const names = modal.contentEl.log.settings.map((s) => s.name);
    expect(names).toContain("New device name");
    expect(names).toContain("Token");
  });

  it(
    '"sync-apply-setup-link" pastes through to the apply window naming the same server, ' +
      "and Cancel leaves every setting untouched",
    async () => {
      harness = await LiveHarness.start(config!);
      const before = {
        serverUrl: harness.plugin.settings.serverUrl,
        accessToken: harness.plugin.settings.accessToken,
        deviceName: harness.plugin.settings.deviceName,
      };

      const paste = await harness.opens(() => harness!.recorded.runCommand("sync-apply-setup-link"));
      expect(paste.contentEl.log.headings[0]).toBe("Apply a setup link");

      // The harness vault is plaintext (see harness.ts) — this device's own setup link
      // reflects that: no key, no vaultSalt, exactly what DeviceSetupModal would export.
      const payload: SetupPayload = {
        v: 2,
        url: config!.url,
        name: "second-device",
        token: config!.token,
        mode: "plaintext",
      };
      modalRow(paste, "Setup link").texts[0]!.change(encodeSetupUri(payload));
      const apply = await harness.opens(() => harness!.modalButton("Continue").click());

      expect(apply.contentEl.log.headings[0]).toBe("Apply R2DO Sync setup?");
      expect(apply.contentEl.log.paragraphs.some((p) => p.includes(config!.url))).toBe(true);

      harness.modalButton("Cancel").click();

      expect(harness.plugin.settings.serverUrl).toBe(before.serverUrl);
      expect(harness.plugin.settings.accessToken).toBe(before.accessToken);
      expect(harness.plugin.settings.deviceName).toBe(before.deviceName);
    }
  );

  // -- the protocol handler ----------------------------------------------------------------------

  it("obsidian://r2do-setup opens the apply window, and never applies the payload on its own", async () => {
    // The security property: a phone's camera app hands this straight to Obsidian with no
    // human step in between (see setup-link.ts's own doc comment), so if the handler applied
    // the payload itself, ANY link — including one from a photo of someone else's QR code —
    // would silently repoint this device's sync at a stranger's vault, no confirmation at all.
    // The handler must only ever open `ApplySetupModal`; applying is `Apply`'s job alone.
    harness = await LiveHarness.start(config!);
    const before = {
      serverUrl: harness.plugin.settings.serverUrl,
      accessToken: harness.plugin.settings.accessToken,
      deviceName: harness.plugin.settings.deviceName,
    };
    const handler = harness.recorded.protocolHandlers.get(SETUP_ACTION);
    expect(handler).toBeDefined();

    // Same server, a plainly bogus token: the point is that applying it must be visible and
    // deliberate, not that the resulting connection test succeeds.
    const payload: SetupPayload = {
      v: 2,
      url: config!.url,
      name: "protocol-device",
      token: "0".repeat(64),
      mode: "plaintext",
    };
    const modal = await harness.opens(() => handler!({ d: encodeSetupPayload(payload) }));

    expect(modal.contentEl.log.headings[0]).toBe("Apply R2DO Sync setup?");
    // The load-bearing assertion: dispatching the link changed NOTHING yet.
    expect(harness.plugin.settings.serverUrl).toBe(before.serverUrl);
    expect(harness.plugin.settings.accessToken).toBe(before.accessToken);
    expect(harness.plugin.settings.deviceName).toBe(before.deviceName);

    // Only pressing Apply in the modal may apply it — proven by driving that far too.
    await harness.modalButton("Apply").click();
    expect(harness.plugin.settings.deviceName).toBe("protocol-device");
    expect(harness.plugin.settings.accessToken).toBe("0".repeat(64));
  });

  it("a malformed setup link is rejected with a notice, opening no window at all", async () => {
    harness = await LiveHarness.start(config!);
    const handler = harness.recorded.protocolHandlers.get(SETUP_ACTION)!;

    handler({ d: "not-a-real-payload" });

    expect(Modal.shown).toHaveLength(0);
    expect(harness.notices().at(-1)).toMatch(/setup link rejected/i);
  });
});
