// Group 6 — Conflicts. Two real devices, one real Worker, one file both of them rewrite
// differently: this is the only way to prove the review window is wired to a genuine
// unmergeable pair, not a fixture. `merge.spec.ts`/`conflict-resolve.spec.ts` already cover the
// algorithm and the resolution rules against injected states; what they cannot see is whether
// `#renderConflicts` and `ConflictReportModal` actually read what a real pass produced.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal } from "../obsidian-fake";
import type { ConflictInfo } from "../../src/sync";
import { LiveHarness, liveConfig, type LiveConfig } from "./harness";

const config = liveConfig("conflicts");
// The harness owns `config.root` outright (wiped on every `start()`), so a second device needs
// its own directory or the two would fight over one. Same Worker, same head — a different root
// is the only difference, which is exactly what makes them two devices instead of one.
const otherConfig: LiveConfig | null = config === null ? null : { ...config, root: `${config.root}-other` };

// Unique per suite run so a second run of this file never collides with conflict copies a
// previous run left in the sandbox's permanent history.
const RUN = Date.now();

describe.skipIf(config === null)("Conflicts", () => {
  let harness: LiveHarness | null = null; // device-b: the harness under test, drives the UI
  let other: LiveHarness | null = null; // device-a: exists only to publish a competing edit

  afterEach(async () => {
    await harness?.dispose();
    await other?.dispose();
    harness = null;
    other = null;
  });

  interface Fixture {
    path: string;
    base: string;
    mine: string;
    theirs: string;
  }

  /** A base + two edits to the SAME existing line, which diff3 refuses to merge (see merge.ts:
   *  "Overlapping changes to *existing* lines that are not byte-identical are a conflict, full
   *  stop"). The shared header/footer lines prove the merge is line-scoped, not whole-file. */
  function fixture(tag: string): Fixture {
    return {
      path: `conflict-${RUN}/${tag}.md`,
      base: `shared header\noriginal ${tag} line\nshared footer\n`,
      mine: `shared header\nDEVICE-B rewrote the ${tag} line\nshared footer\n`,
      theirs: `shared header\nDEVICE-A rewrote the ${tag} line\nshared footer\n`,
    };
  }

  /**
   * Manufactures a real conflict end to end: device-a publishes a base, device-b adopts it as
   * its own merge parent, device-a publishes a competing edit device-b never sees, then
   * device-b edits the same line and syncs — pulling device-a's edit, failing to merge it, and
   * parking the loser. Nothing here injects a ConflictInfo; it is whatever the real pass wrote
   * to `lastConflicts`, which is the thing this whole file exists to check is wired up.
   */
  async function manufactureConflict(f: Fixture): Promise<ConflictInfo> {
    other = await LiveHarness.start(otherConfig!, {
      files: { [f.path]: f.base },
      persisted: { settings: { deviceName: "device-a" } },
    });
    await other.plugin.syncNow(); // publish the shared base

    harness = await LiveHarness.start(config!, {
      persisted: { settings: { deviceName: "device-b" } },
    });
    await harness.plugin.syncNow(); // adopt that base as device-b's own merge parent

    await other.write(f.path, f.theirs);
    await other.plugin.syncNow(); // device-a publishes its edit; device-b hasn't pulled it yet

    await harness.write(f.path, f.mine);
    await harness.plugin.syncNow(); // device-b pulls device-a's edit: same line, two different
    // rewrites, diff3 refuses -> a real ConflictInfo lands in the live plugin's lastConflicts.

    const info = harness.plugin.lastConflicts.find((c) => c.path === f.path);
    if (info === undefined) {
      throw new Error(`fixture on ${f.path} did not produce a conflict — check the fixture`);
    }
    return info;
  }

  /**
   * Opens the review window the way the button does. The row's onClick is `() => void
   * this.plugin.openConflictReview()` — deliberately fire-and-forget, matching how Obsidian
   * itself calls a button handler — so `.click()` returns before the modal exists. Polling
   * for it is the only honest way to await a click the UI itself does not await.
   */
  async function openReview(h: LiveHarness): Promise<void> {
    h.render();
    const before = Modal.shown.length;
    h.row("Unresolved conflicts").buttons[0]!.click();
    await vi.waitFor(() => {
      expect(Modal.shown.length).toBeGreaterThan(before);
    });
  }

  // -- Conflict handling dropdown --------------------------------------------------------

  it('"Keep both" applies immediately with no confirmation', async () => {
    harness = await LiveHarness.start(config!, {
      persisted: { settings: { conflictMode: "newest" } },
    });
    harness.render();

    await harness.row("Conflict handling").dropdowns[0]!.change("keep-both");

    // The bug this catches: overwrite modes require a confirmation because they discard data,
    // but "keep both" discards nothing — gating it behind a modal too would be a workflow tax
    // with no safety benefit.
    expect(harness.plugin.settings.conflictMode).toBe("keep-both");
    expect(Modal.shown.length).toBe(0);
  });

  it('"Newest wins" asks first, and CANCEL reverts the dropdown, not just the write', async () => {
    harness = await LiveHarness.start(config!); // default conflictMode is "keep-both"
    harness.render();
    const dropdown = harness.row("Conflict handling").dropdowns[0]!;

    dropdown.change("newest");
    expect(Modal.shown.length).toBe(1);
    expect(harness.top().contentEl.log.headings).toContain("Let conflicts overwrite?");

    await harness.modalButton("Cancel").click();

    // The bug this catches: a dropdown left showing "Newest wins" after the user declined it
    // is a lie about the current setting — the control must revert, not just refuse to save.
    expect(dropdown.getValue()).toBe("keep-both");
    expect(harness.plugin.settings.conflictMode).toBe("keep-both");
  });

  it('"Newest wins" applies once the confirmation is accepted', async () => {
    harness = await LiveHarness.start(config!);
    harness.render();
    const dropdown = harness.row("Conflict handling").dropdowns[0]!;

    dropdown.change("newest");
    await harness.confirm(null, "Confirm"); // no typed phrase — a plain second-confirm button

    expect(harness.plugin.settings.conflictMode).toBe("newest");
    expect(dropdown.getValue()).toBe("newest");
  });

  // -- Unresolved conflicts / review button ----------------------------------------------

  it('reads "None" and is disabled when nothing is outstanding', async () => {
    harness = await LiveHarness.start(config!);
    const log = harness.render();

    const row = log.rows[log.settings.findIndex((s) => s.name === "Unresolved conflicts")]!;
    // The bug this catches: a "Review" button offered when there is nothing to review is a
    // dead end — clicking it would open a window that can only say "All resolved."
    expect(row.buttons[0]!.text).toBe("None");
    expect(row.buttons[0]!.disabled).toBe(true);
  });

  it("counts a real conflict and opens the review listing it, CTA on the newer side", async () => {
    const info = await manufactureConflict(fixture("list"));
    const h = harness!;

    h.render();
    const row = h.row("Unresolved conflicts");
    expect(row.buttons[0]!.text).toBe("Review 1");
    expect(row.buttons[0]!.disabled).toBe(false);

    await openReview(h);
    const modal = h.top();
    expect(modal.contentEl.log.headings).toContain("1 conflict");
    // The path is drawn as an <h4>, which the fake only records via the DOM tree, not the
    // paragraph/heading logs — walk the tree the way a person reading the window would.
    expect(modal.contentEl.texts()).toContain(info.path);

    // device-b wrote its edit strictly after device-a's edit was already published (the sync
    // in between is what guarantees the ordering), so device-b's copy is always the newer
    // side — the CTA (first, prominent button) must track that, not always say "This device".
    const keepRow = modal.contentEl.log.rows.find((r) => r.rendered.name === "Keep")!;
    expect(keepRow.buttons[0]!.text).toBe("This device");
    expect(keepRow.buttons[0]!.cta).toBe(true);
  });

  // -- Resolving a conflict, one choice per test ------------------------------------------

  it('"This device" keeps the local edit and removes the parked copy', async () => {
    const f = fixture("this-device");
    const info = await manufactureConflict(f);
    const h = harness!;
    await openReview(h);

    await h.modalButton("This device").click();

    expect(await h.read(info.path)).toBe(f.mine);
    expect(await h.files()).not.toContain(info.copy);
    // The count is what the settings row's "Review N" reads — a resolve that doesn't shrink
    // this list would leave the button lying about how many conflicts are left.
    expect(h.plugin.lastConflicts.length).toBe(0);
    expect(h.notices().at(-1)).toMatch(/resolved/i);
  });

  it('"Other device" keeps the remote edit and removes the parked copy', async () => {
    const f = fixture("other-device");
    const info = await manufactureConflict(f);
    const h = harness!;
    await openReview(h);

    await h.modalButton("Other device").click();

    expect(await h.read(info.path)).toBe(f.theirs);
    expect(await h.files()).not.toContain(info.copy);
    expect(h.plugin.lastConflicts.length).toBe(0);
  });

  it('"Both files" leaves both versions untouched, one under the .conflict-… copy', async () => {
    const f = fixture("both-files");
    const info = await manufactureConflict(f);
    const h = harness!;
    await openReview(h);

    await h.modalButton("Both files").click();

    // planResolution's "keep-both" case is a genuine no-op (see conflict-resolve.ts): the
    // bug this catches is a resolution that "keeps both" by silently rewriting one side's
    // bytes in the process, which would corrupt an attachment even though it reports success.
    expect(await h.read(info.path)).toBe(f.mine);
    expect(info.copy).not.toBeNull();
    expect(await h.read(info.copy!)).toBe(f.theirs);
    expect(await h.files()).toContain(info.copy);
    expect(h.plugin.lastConflicts.length).toBe(0);
  });

  it('"Combine into one" writes a single file containing content from both sides', async () => {
    const f = fixture("combine");
    const info = await manufactureConflict(f);
    const h = harness!;
    await openReview(h);

    await h.modalButton("Combine into one").click();

    const combined = await h.read(info.path);
    // Markers plus both sides' differing lines, not a copy of either side alone.
    expect(combined).toContain("<<<<<<<");
    expect(combined).toContain("=======");
    expect(combined).toContain(">>>>>>>");
    expect(combined).toContain("DEVICE-B rewrote the combine line");
    expect(combined).toContain("DEVICE-A rewrote the combine line");
    // Lines both sides agreed on appear once each, not duplicated per side.
    expect(combined.match(/shared header/g)).toHaveLength(1);
    expect(combined.match(/shared footer/g)).toHaveLength(1);
    expect(await h.files()).not.toContain(info.copy);
    expect(h.plugin.lastConflicts.length).toBe(0);
  });
});
