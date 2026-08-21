// Group 8 — Notices. This group is about what the user is TOLD, so every assertion here reads
// the actual Notice text a real pass produced against the real Worker, never just "a request
// was sent." See docs/260814-eval-LIVE_UI_TEST_PLAN.md, "Group 8 — Notices".
//
// `announcePass()` (src/notify.ts) used to speak unconditionally for an *interactive* pass, so
// `activity` could only be shown silent on a pass nobody asked for. That exception is gone — the
// `syncing…` opener is its own switch now and covers the same ground at the moment someone is
// actually wondering whether their tap registered — so `activity` means changed-something for
// manual and background passes alike. The background path below is kept anyway: it is what the
// plan's table asks for, and an unattended full-scan pass is the case a manual `syncNow()` cannot
// stand in for. It is reached through `#autoSync()`, fired by `syncOnStartup` on
// `workspace.onLayoutReady()`, driven directly with `holdLayout: true` + `fireLayoutReady()`.
//
// `syncSettings` (shared settings between devices) defaults to true, and every test in this
// file talks to the same sandbox Worker under the same device name ("live-harness"). Left on,
// the first test to run publishes its own notice preferences to `settings/policy.json`, and
// every later test's fresh harness pulls that doc *before* its own pass and silently overwrites
// the very settings under test — confirmed live, back when they were shared: a test that asked
// for pass notices got its pass reported with them flipped back off mid-`syncNow()`, changing
// which branch of `#notify` fired. `noticeLevel` is device-local now, which removes that
// mechanism, but the harnesses keep `syncSettings: false` because the rest of the reasoning
// below still holds. Group 8 does not test settings sharing (that is Group 2's
// "Sync settings between devices" row), so every harness here sets `syncSettings: false` to
// keep its toggles its own, per the "a group establishes what it needs, inside itself" rule.
//
// A second wrinkle from the same cause: `LiveHarness.start()` wipes only the *local* directory
// (per its own doc comment), never the remote head. Every test in this file shares one head on
// this group's sandbox, and files earlier tests (or earlier runs of this file) published stay
// there. A fresh, empty-local harness therefore does a real *pull* of that leftover content on
// its first pass — which is itself a notice-worthy change, confirmed live (`R2DO Sync changed
// N local file(s)`, the `changes` notice `#notify` fires for an unasked-for pull even when the
// pass summary is off). Tests that need a clean "nothing changed" baseline run one throwaway
// priming `syncNow()` first to absorb whatever the head already carries, then take their
// "before" snapshot — the same pattern the "only changed" test below uses explicitly with two
// consecutive passes, just spelled out once here since it recurs.
import { afterEach, describe, expect, it } from "vitest";
import { LiveHarness, liveConfig, type LiveConfig } from "./harness";

const config = liveConfig("notices");

/**
 * Every completed pass — success or error — ends in exactly one `#persist()` call (src/main.ts
 * `#report`/`#reportError`), which the fake `Plugin.saveData` records into `recorded.saves`. A
 * background pass fired through `fireLayoutReady()` returns nothing a test can await, and a
 * silent pass (the whole point of the "only changed" test) leaves no Notice to poll for either.
 * `saves.length` growing is the one side effect guaranteed on every path, notice or no notice,
 * so it is the completion signal used here instead of reaching into plugin internals.
 */
async function waitForPass(harness: LiveHarness, from: number, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (harness.recorded.saves.length <= from) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timed out waiting for a background pass to finish (saves stuck at ${harness.recorded.saves.length})`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(config === null)("Notices", () => {
  let harness: LiveHarness | null = null;
  afterEach(async () => {
    await harness?.dispose();
    harness = null;
  });

  it("the silent level: a real pass produces no notice at all", async () => {
    harness = await LiveHarness.start(config!, {
      files: { "off.md": "no summary wanted\n" },
      persisted: {
        settings: {
          noticeLevel: "silent",
          notifyOnStart: false,
          // The ladder on its own. `syncNow()` is a pass the user started, so the shipped
          // default would report it whatever the level says — that is the next test.
          alwaysReportManualSync: false,
          syncSettings: false,
        },
      },
    });

    // Prime: absorb whatever this shared sandbox head already carries before the pass under
    // test runs. Otherwise a pull of leftover content from an earlier test would fire the
    // floor notice on its own, and this test would be asserting nothing about the toggle.
    await harness.plugin.syncNow();
    const noticesBefore = harness.notices().length;
    const callsBefore = harness.http.calls;

    await harness.plugin.syncNow();

    // A real round trip happened — this is not a no-op stub answering in zero requests.
    expect(harness.http.calls).toBeGreaterThan(callsBefore);
    // No "syncing…" opener and no per-pass summary — the level says nothing, and (now that
    // local and remote agree) nothing pulled either, so not even a `changes` notice fires.
    expect(harness.notices().slice(noticesBefore)).toEqual([]);
  });

  it("the manual override: the same silenced vault still answers a sync you started", async () => {
    // The mirror of the test above, one setting apart — and the shipped default. Every rung of
    // the ladder reasons about sync running on its own; a person who just tapped "Sync now" is
    // waiting for an answer, and gets one.
    harness = await LiveHarness.start(config!, {
      files: { "manual.md": "summary wanted\n" },
      persisted: {
        settings: { noticeLevel: "silent", notifyOnStart: false, syncSettings: false },
      },
    });

    // Primed the same way, so what is left is a genuinely no-op pass: the case the level
    // silences hardest, and the one an override that only survived on changed files would miss.
    await harness.plugin.syncNow();
    const noticesBefore = harness.notices().length;
    const callsBefore = harness.http.calls;

    await harness.plugin.syncNow();

    expect(harness.http.calls).toBeGreaterThan(callsBefore);
    const said = harness.notices().slice(noticesBefore);
    expect(said.length).toBeGreaterThan(0);
    expect(said[0]).toMatch(/syncing/);
  });

  it("an ERROR notice survives the problems level, where the pass summary does not", async () => {
    // A second harness with a bad token produces a real 401, not a simulated one, per the
    // task's rule. This is the whole point of that rung: routine chatter goes, failures stay.
    const badConfig: LiveConfig = {
      url: config!.url,
      token: "0".repeat(64),
      root: `${config!.root}-badtoken`,
    };
    harness = await LiveHarness.start(badConfig, {
      persisted: {
        settings: {
          noticeLevel: "problems",
          notifyOnStart: false,
          alwaysReportManualSync: false,
          syncSettings: false,
          // 401 is not retryable (src/queue.ts `isRetryable`), but pin this anyway so a
          // failure surfaces as exactly one attempt rather than however many the shipped
          // default happens to be — matching the "failure fixtures use retryAttempts: 0"
          // convention the rest of the live/unit suites follow.
          retryAttempts: 0,
        },
      },
    });

    await harness.plugin.syncNow();

    const notice = harness.notices().at(-1) ?? "";
    expect(notice).toMatch(/error/i);
    expect(notice).toMatch(/R2DO Sync error/);
  });

  it("the activity level: a no-op background pass is silent, a changing one speaks", async () => {
    harness = await LiveHarness.start(config!, {
      files: { "baseline.md": "line one\nline two\n" },
      persisted: {
        settings: {
          noticeLevel: "activity",
          syncOnStartup: true,
          syncSettings: false,
        },
      },
      // Hold layout so the startup autoSync fires on our command, once per assertion, instead
      // of racing `LiveHarness.start()`.
      holdLayout: true,
    });

    // First pass: publishes the seed file. This is the vault's first sync, so it necessarily
    // changed something — `passChangedSomething()` is the one thing every speaking level
    // reports, and the notice must say so.
    let savesBefore = harness.recorded.saves.length;
    let callsBefore = harness.http.calls;
    harness.app.workspace.fireLayoutReady();
    await waitForPass(harness, savesBefore);
    expect(harness.http.calls).toBeGreaterThan(callsBefore);
    expect(harness.notices().length).toBeGreaterThan(0);
    expect(harness.notices().at(-1)).toMatch(/R2DO Sync/);
    expect(harness.notices().at(-1)).not.toMatch(/up to date/);

    // Second pass: nothing local or remote changed since the first. Genuinely no-op, run the
    // same unattended way. At `activity` this must add no notice at all.
    const noticesBefore = harness.notices().length;
    savesBefore = harness.recorded.saves.length;
    callsBefore = harness.http.calls;
    harness.app.workspace.fireLayoutReady();
    await waitForPass(harness, savesBefore);
    expect(harness.http.calls).toBeGreaterThan(callsBefore); // a real pass ran, it just found nothing
    expect(harness.notices().length).toBe(noticesBefore);
  });

  it('"List the changed files": verbose mode names the actual changed path', async () => {
    harness = await LiveHarness.start(config!, {
      persisted: {
        settings: {
          noticeLevel: "all",
          verboseSyncNotice: true,
          syncSettings: false,
        },
      },
    });

    // Prime: pull down whatever this shared sandbox head already carries, so the file added
    // below is the ONLY change the tested pass reports — otherwise leftover files from earlier
    // tests in this file show up as an unrelated pull section next to the one under test.
    await harness.plugin.syncNow();
    // Content is unique per run, not just per path: an earlier run of this same test may have
    // left a file at this exact path on the shared head, and the priming pull above already
    // absorbed it — writing identical bytes back would be a genuine no-op, not the change this
    // test means to produce (confirmed live: reused fixed content reported "up to date").
    await harness.write("verbose/target.md", `alpha\nbeta\ngamma\n<!-- ${Date.now()} -->\n`);

    await harness.plugin.syncNow();

    const notice = harness.notices().at(-1) ?? "";
    // Not "the notice got longer" — the literal path the pass moved has to be legible in it.
    expect(notice).toContain("verbose/target.md");
  });
});
