// Group 9 — Troubleshooting. The whole point of this group is that the report note is a real
// file: a wrong-folder bug here means a user believes they have logs when Export silently wrote
// nothing, or wrote it somewhere they will never find, or the trimming setting they set never
// actually shrank what got exported.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOG_ENTRIES_RANGE } from "../../src/log";
import { LiveHarness, liveConfig } from "./harness";

const config = liveConfig("troubleshooting");

/**
 * Every `LiveHarness.start()` is a brand-new device with no sync memory at all — `persisted`
 * is fresh, so there is no last-synced-head for any path. A fixed filename reused across
 * process runs would therefore hit a path the *previous* run already published to this
 * group's shared remote, with no common ancestor recorded locally: a guaranteed, spurious
 * merge conflict that has nothing to do with what this file is testing. One nonce per test
 * run keeps every seeded path unique to this run instead.
 */
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Writes a file straight to disk, skipping the vault "modify" event `harness.write` fires.
 * `harness.start()` defaults `debounceSeconds` to its maximum precisely so that event cannot
 * start a background pass mid-test, but this file wants to control exactly when each pass
 * happens regardless of what any test sets that setting to. `syncNow({ fullScan: true })` —
 * what every explicit `syncNow()` call in this file uses — walks the real directory regardless
 * of what fired, so the seeded file is picked up without the event.
 */
async function seed(harness: LiveHarness, rel: string, contents: string): Promise<void> {
  const full = path.resolve(harness.config.root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents);
}

/** Content that cannot already exist on the shared sandbox head from an earlier run of this suite. */
function uniqueContent(label: string): string {
  return `${label} ${Date.now()} ${Math.random().toString(36).slice(2)}`;
}

/**
 * The snapshot id `describePass` names for the most recent "committed" pass, among notices
 * added since `since`. Requires `verboseSyncNotice: true` — only the verbose line names the
 * head (`log.ts`'s `describePass`) — which is what lets a test tie an exported log row back to
 * the *specific* pass that produced it, instead of just trusting that some pass ran recently.
 */
function headSince(harness: LiveHarness, since: number): string {
  const added = harness.notices().slice(since);
  for (let i = added.length - 1; i >= 0; i--) {
    const m = /snapshot (\S+)/.exec(added[i]);
    if (m) return m[1];
  }
  throw new Error(`no committed-pass notice among: ${JSON.stringify(added)}`);
}

/**
 * Clicks Export and waits for its notice. Unlike "Test connection" (`onClick(async () =>
 * {...})`, a real awaitable promise), Export's handler is `onClick(() => void
 * this.plugin.exportLog())` — deliberate fire-and-forget, the same idiom the ribbon icon and
 * `sync-now` use. `ButtonComponent.click()` therefore resolves with `undefined` the instant it
 * is called, before the write has happened at all, so `await button.click()` proves nothing:
 * this polls for the notice `exportLog` always ends with instead.
 */
async function clickExportAndWait(harness: LiveHarness): Promise<string> {
  const since = harness.notices().length;
  harness.button("Sync log", "Export").click();
  const start = Date.now();
  for (;;) {
    const added = harness.notices().slice(since);
    if (added.length > 0) return added[added.length - 1];
    if (Date.now() - start > 5000) throw new Error("Export produced no notice within 5s");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(config === null)("Troubleshooting", () => {
  let harness: LiveHarness | null = null;
  afterEach(async () => {
    await harness?.dispose();
    harness = null;
  });

  it("Export writes a report note on disk, under the folder just configured, describing the pass that ran", async () => {
    harness = await LiveHarness.start(config!, {
      persisted: { settings: { verboseSyncNotice: true } },
    });
    harness.render();

    // "Report folder | Set to a new folder | The folder is created on the next export" — driven
    // through the real field and a real blur, not pre-seeded into settings, so this proves the
    // control itself is wired, not just that #ensureLogFolder works in isolation.
    const folderField = harness.row("Report folder").texts[0];
    folderField.change("reports/happy");
    folderField.inputEl.fire("blur");
    expect(harness.plugin.settings.logNoteFolder).toBe("reports/happy");

    await seed(harness, `export-happy-${RUN}.md`, uniqueContent("export-happy"));
    const before = harness.notices().length;
    await harness.plugin.syncNow();
    const head = headSince(harness, before);

    const notice = await clickExportAndWait(harness);

    const files = await harness.files();
    const report = files.find((f) => /^reports\/happy\/r2do-sync-report-\d{6}-\d{4}\.md$/.test(f));
    if (report === undefined) {
      throw new Error(`no report note under reports/happy; vault has: ${files.join(", ")}; notice: ${notice}`);
    }
    const body = await harness.read(report);
    expect(body).toContain("# R2DO Sync — recent sync passes");
    // Not just "a" table — the row names the exact snapshot this pass just produced, so a
    // stale, empty or unrelated log would fail this even though a file exists on disk.
    expect(body).toContain(head);
    expect(notice).toBe(`R2DO Sync: wrote ${report}`);
  });

  it("Export refuses when the report folder path is a file, and writes nothing anywhere", async () => {
    harness = await LiveHarness.start(config!, {
      files: { "blocked.md": "do not touch" },
    });
    harness.render();

    const folderField = harness.row("Report folder").texts[0];
    folderField.change("blocked.md");
    folderField.inputEl.fire("blur");

    const before = await harness.files();
    const notice = await clickExportAndWait(harness);
    const after = await harness.files();

    // Not "the report landed somewhere else" — nothing landed anywhere, and the file the
    // folder setting collided with is exactly as it was before the click.
    expect(after).toEqual(before);
    expect(await harness.read("blocked.md")).toBe("do not touch");
    expect(notice).toMatch(/could not write the report/i);
    expect(notice).toMatch(/file, not a folder/i);
  });

  it("Sync log length, set to the minimum, drops older passes from the exported note", async () => {
    harness = await LiveHarness.start(config!, {
      persisted: { settings: { verboseSyncNotice: true, logNoteFolder: "reports/trim" } },
    });
    harness.render();

    await seed(harness, `trim-a-${RUN}.md`, uniqueContent("trim-a"));
    let before = harness.notices().length;
    await harness.plugin.syncNow();
    const headA = headSince(harness, before);

    await seed(harness, `trim-b-${RUN}.md`, uniqueContent("trim-b"));
    before = harness.notices().length;
    await harness.plugin.syncNow();
    const headB = headSince(harness, before);
    expect(headB).not.toBe(headA);

    // Field commit happens between the two passes kept and the one that survives, exactly like
    // a user would hit it: the two earlier passes were logged under the *old*, larger limit.
    const lengthField = harness.row("Sync log length").texts[0];
    lengthField.change(String(LOG_ENTRIES_RANGE.min));
    lengthField.inputEl.fire("blur");
    expect(harness.plugin.settings.logEntries).toBe(LOG_ENTRIES_RANGE.min);

    await seed(harness, `trim-c-${RUN}.md`, uniqueContent("trim-c"));
    before = harness.notices().length;
    await harness.plugin.syncNow();
    const headC = headSince(harness, before);
    expect(headC).not.toBe(headA);
    expect(headC).not.toBe(headB);

    const exportNotice = await clickExportAndWait(harness);
    const files = await harness.files();
    const report = files.find((f) => /^reports\/trim\/r2do-sync-report-\d{6}-\d{4}\.md$/.test(f));
    if (report === undefined) {
      throw new Error(`no report note under reports/trim; vault has: ${files.join(", ")}; notice: ${exportNotice}`);
    }
    const body = await harness.read(report);

    // The setting alone proves nothing about the log it governs — this checks the row count
    // and which head survived, not merely that `settings.logEntries` holds 1.
    expect(body).toContain("Newest first, 1 pass(es) kept.");
    expect(body).toContain(headC);
    expect(body).not.toContain(headA);
    expect(body).not.toContain(headB);
  });
});
