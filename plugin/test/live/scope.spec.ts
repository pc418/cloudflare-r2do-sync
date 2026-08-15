// Group 4 — What syncs. docs/260814-eval-LIVE_UI_TEST_PLAN.md is the spec.
//
// The whole point of this group: an out-of-scope path (excluded, or outside an allow-list)
// must never be confused with a path the user deleted. `paths.ts`/`sync.ts` call this
// "carrying" — a scope-excluded path keeps whatever entry its parent snapshot had, untouched,
// forever, until something back in scope changes it. Get the carry wrong and a glob edit
// silently deletes another device's files. So every assertion here reads the *published
// manifest* (or the disk), never a notice — a notice can lie about what shipped; the manifest
// cannot.
import { afterEach, describe, expect, it } from "vitest";
import { Modal } from "../obsidian-fake";
import { LiveHarness, liveConfig, type LiveConfig } from "./harness";

const config = liveConfig("scope");

/** v1 (plaintext) manifest shape actually returned by this sandbox — see worker/src/manifest.ts. */
interface RemoteFileEntry {
  h: string;
  size: number;
  mtime: number;
  lines?: number;
}
interface ManifestV1 {
  v: number;
  files: Record<string, RemoteFileEntry>;
}

async function remoteFiles(cfg: LiveConfig): Promise<Record<string, RemoteFileEntry>> {
  const headRes = await fetch(`${cfg.url}/api/head`, {
    headers: { authorization: `Bearer ${cfg.token}` },
  });
  if (!headRes.ok) throw new Error(`GET /api/head: ${headRes.status} ${await headRes.text()}`);
  const head = ((await headRes.json()) as { head: string | null }).head;
  if (head === null) throw new Error("remote vault has no head yet — nothing was ever committed");

  const manifestRes = await fetch(`${cfg.url}/api/manifests/${head}`, {
    headers: { authorization: `Bearer ${cfg.token}` },
  });
  if (!manifestRes.ok) {
    throw new Error(`GET /api/manifests/${head}: ${manifestRes.status} ${await manifestRes.text()}`);
  }
  const manifest = (await manifestRes.json()) as ManifestV1;
  if (manifest.v !== 1) throw new Error(`expected a plaintext (v1) manifest, got v${manifest.v}`);
  return manifest.files;
}

describe.skipIf(config === null)("What syncs", () => {
  let harness: LiveHarness | null = null;
  afterEach(async () => {
    await harness?.dispose();
    harness = null;
  });

  it("the allow-list hint tracks every keystroke; the setting itself commits only on blur", async () => {
    // Regression target: `#renderScope` keeps a draft separate from `settings.onlyPaths` so a
    // half-typed glob is never live. If the draft and the stored setting were the same
    // variable, either the hint would go stale mid-type, or a half-finished glob would start
    // silently dropping files from every other tab's re-render before Enter/blur.
    harness = await LiveHarness.start(config!, {
      files: { "notes/a.md": "keep", "outside/b.md": "skip" },
    });
    harness.render();
    const field = harness.row("Only sync matching paths").texts[0];
    const hintBefore = harness.tab.containerEl.byClass("r2do-hint")[0]?.text;
    expect(hintBefore).toMatch(/No allow-list: 2 of 2 files/);

    field.change("notes/**");

    // Live while typing — no blur fired yet.
    const hintAfter = harness.tab.containerEl.byClass("r2do-hint")[0]?.text;
    expect(hintAfter).toMatch(/Allow-list matches 1 of 2 files/);
    // The setting itself must not have moved: a keystroke is not a commit.
    expect(harness.plugin.settings.onlyPaths).toBe("");

    field.inputEl.fire("blur");
    expect(harness.plugin.settings.onlyPaths).toBe("notes/**");
  });

  it("an allow-list glob carries a previously-synced path forward instead of deleting it", async () => {
    // This is the failure mode the plan calls out by name: confusing "not in my scope" with
    // "the user deleted this" would let a glob edit on one device delete another device's
    // files out from under it. Prove the carry with a real commit that has to move something
    // (edit a.md) so `#carry` actually runs, rather than a no-op pass that proves nothing.
    harness = await LiveHarness.start(config!, {
      // Disables the mass-change guard: this suite's remote head accumulates paths from every
      // test in this file, so a fresh device's first sync here routinely looks like a large
      // local change relative to that history. The guard itself is Group 7's to test.
      persisted: { settings: { protectPercent: 100 } },
      files: { "scope-only/notes/a.md": "v1", "scope-only/outside/b.md": "original" },
    });
    await harness.plugin.syncNow();
    const afterFirstSync = await remoteFiles(config!);
    expect(afterFirstSync["scope-only/notes/a.md"]).toBeDefined();
    const outsideBefore = afterFirstSync["scope-only/outside/b.md"];
    expect(outsideBefore).toBeDefined();

    harness.render();
    const field = harness.row("Only sync matching paths").texts[0];
    field.change("scope-only/notes/**");
    field.inputEl.fire("blur");
    expect(harness.plugin.settings.onlyPaths).toBe("scope-only/notes/**");

    await harness.write("scope-only/notes/a.md", "v2");
    await harness.plugin.syncNow();

    const afterSecondSync = await remoteFiles(config!);
    // In scope and changed: published with the new content.
    expect(afterSecondSync["scope-only/notes/a.md"]?.h).toBeDefined();
    expect(afterSecondSync["scope-only/notes/a.md"]?.h).not.toBe(afterFirstSync["scope-only/notes/a.md"]?.h);
    // Out of scope now, but it was on the remote before: carried byte-for-byte, not deleted.
    expect(afterSecondSync["scope-only/outside/b.md"]).toEqual(outsideBefore);
    // And never touched on disk either — the exclusion is a publishing rule, not a local one.
    await expect(harness.read("scope-only/outside/b.md")).resolves.toBe("original");
  });

  it("an exclude glob keeps a matching file off the manifest without touching it on disk", async () => {
    harness = await LiveHarness.start(config!, {
      persisted: { settings: { protectPercent: 100, excludes: "scope-exclude/drafts/**" } },
      files: {
        "scope-exclude/published/keep.md": "keep me",
        "scope-exclude/drafts/wip.md": "not yet",
      },
    });
    await harness.plugin.syncNow();

    const files = await remoteFiles(config!);
    expect(files["scope-exclude/published/keep.md"]).toBeDefined();
    expect(files["scope-exclude/drafts/wip.md"]).toBeUndefined();
    await expect(harness.read("scope-exclude/drafts/wip.md")).resolves.toBe("not yet");
  });

  it("turning on config-dir sync snaps the toggle back off and asks for the SYNC CONFIG phrase; cancelling leaves it off", async () => {
    harness = await LiveHarness.start(config!);
    harness.render();
    const toggle = harness.row("Sync Obsidian configuration directory").toggles[0];
    expect(toggle.getValue()).toBe(false);

    toggle.change(true);

    // Reset immediately, synchronously with the click — the real toggle must never show "on"
    // before consent is given, even for the instant before the modal paints.
    expect(toggle.getValue()).toBe(false);
    expect(harness.plugin.settings.syncConfigDir).toBe(false);
    const modal = harness.top();
    expect(modal.contentEl.log.headings).toContain("Sync Obsidian configuration files?");

    harness.modalButton("Cancel").click();

    expect(harness.plugin.settings.syncConfigDir).toBe(false);
  });

  it("typing SYNC CONFIG enables the toggle, and a following pass carries .obsidian/** except the hard-skipped credential and workspace files", async () => {
    // The one test in this group that can leak a secret if it regresses: `data.json` under
    // this plugin's own plugin-dir holds the access token and (when encryption is on) the
    // vault master key in plaintext. `alwaysSkip` must refuse it even with the toggle ON —
    // proving that against the real manifest is the point, not trusting the setting flipped.
    harness = await LiveHarness.start(config!, {
      persisted: { settings: { protectPercent: 100 } },
      files: {
        "scope-config/notes/keep.md": "keep",
        ".obsidian/app.json": '{"ok":true}',
        ".obsidian/workspace.json": '{"main":{}}',
        ".obsidian/plugins/cloudflare-rdo-sync/data.json": '{"accessToken":"should-never-leave-this-device"}',
      },
    });
    harness.render();
    const toggle = harness.row("Sync Obsidian configuration directory").toggles[0];
    toggle.change(true);
    await harness.confirm("SYNC CONFIG", "Confirm");

    expect(harness.plugin.settings.syncConfigDir).toBe(true);
    harness.render();
    expect(harness.row("Sync Obsidian configuration directory").toggles[0].getValue()).toBe(true);

    await harness.plugin.syncNow();
    const files = await remoteFiles(config!);
    expect(files["scope-config/notes/keep.md"]).toBeDefined();
    expect(files[".obsidian/app.json"]).toBeDefined();
    expect(files[".obsidian/workspace.json"]).toBeUndefined();
    expect(files[".obsidian/plugins/cloudflare-rdo-sync/data.json"]).toBeUndefined();
  });

  it("turning config-dir sync off is immediate — no confirmation for reducing what syncs", async () => {
    harness = await LiveHarness.start(config!, {
      persisted: { settings: { syncConfigDir: true } },
    });
    harness.render();
    const toggle = harness.row("Sync Obsidian configuration directory").toggles[0];
    const shownBefore = Modal.shown.length;

    toggle.change(false);

    expect(Modal.shown.length).toBe(shownBefore);
    expect(harness.plugin.settings.syncConfigDir).toBe(false);
  });
});
