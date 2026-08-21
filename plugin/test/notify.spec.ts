import { describe, it, expect } from "vitest";
import {
  DEFAULT_NOTICE_LEVEL,
  DEFAULT_NOTICE_START,
  DEFAULT_ALWAYS_REPORT_MANUAL,
  LEGACY_NOTICE_KEYS,
  NOTICE_CATEGORIES,
  NOTICE_LEVELS,
  SHORT_SNAPSHOT_LENGTH,
  announcePass,
  announceStart,
  conflictReport,
  isNoticeLevel,
  migrateLegacyNoticeLevel,
  noticeAllowed,
  passNoticeLevel,
  passChangedSomething,
  policyForLevel,
  resolveNoticeLevel,
  resolveNoticeStart,
  shortSnapshot,
  type NoticeCategory,
  type NoticeLevel,
} from "../src/notify";
import type { SyncResult } from "../src/sync";

const base = {
  uploaded: 0,
  skipped: [],
  pushedChanges: [],
  pulledChanges: [],
  pulled: 0,
  merged: 0,
  conflicts: [],
  conflictDetails: [],
  currentHead: null,
};

const change = (
  path: string,
  action: "add" | "update" | "delete" | "merge",
  lines: number | null
) => ({ path, action, lines });

const committed = (over: Partial<SyncResult> = {}): SyncResult =>
  ({ status: "committed", head: "01SNAPSHOT", ...base, ...over }) as SyncResult;

describe("passChangedSomething", () => {
  it("is false for a pass that moved nothing", () => {
    expect(passChangedSomething({ status: "unchanged", ...base })).toBe(false);
  });

  it("is true for either direction on its own", () => {
    expect(passChangedSomething(committed({ pushedChanges: [change("a.md", "add", 3)] }))).toBe(true);
    expect(passChangedSomething(committed({ pulledChanges: [change("a.md", "add", 3)] }))).toBe(true);
  });
});

describe("the ladder", () => {
  it("is ordered loudest first, which the migration depends on", () => {
    expect([...NOTICE_LEVELS]).toEqual(["all", "activity", "problems", "silent"]);
  });

  it("never gains a category as it gets quieter", () => {
    // The defining property of a ladder as opposed to four independent switches: no level may
    // speak about something a louder one keeps quiet. If this fails, the dropdown is lying
    // about "each level also says everything the ones below it would".
    for (let i = 1; i < NOTICE_LEVELS.length; i++) {
      const louder = policyForLevel(NOTICE_LEVELS[i - 1]);
      const quieter = policyForLevel(NOTICE_LEVELS[i]);
      for (const category of NOTICE_CATEGORIES) {
        if (quieter[category]) expect(louder[category], `${NOTICE_LEVELS[i]}/${category}`).toBe(true);
      }
    }
  });

  it("says nothing at all at the silent end", () => {
    // No separate master switch exists any more, so this row IS the silence and has to mean it.
    const policy = policyForLevel("silent");
    for (const category of NOTICE_CATEGORIES) expect(policy[category], category).toBe(false);
  });

  it("keeps conflicts and problems at the problems level, and drops the rest", () => {
    expect(policyForLevel("problems")).toEqual({
      pass: false,
      changes: false,
      conflicts: true,
      problems: true,
    });
  });

  it("hands out a copy, so one caller cannot edit the table another reads", () => {
    const policy = policyForLevel("all");
    policy.problems = false;
    expect(policyForLevel("all").problems).toBe(true);
  });

  it("recognises exactly the four levels", () => {
    for (const level of NOTICE_LEVELS) expect(isNoticeLevel(level)).toBe(true);
    for (const bogus of ["", "ALL", "quiet", "none", 0, null, undefined, {}]) {
      expect(isNoticeLevel(bogus), JSON.stringify(bogus)).toBe(false);
    }
  });

  it("ships as activity, one rung below the loudest", () => {
    // A no-op pass is the overwhelmingly common case — the timer fires every few minutes
    // forever — and a toast saying so trains people to dismiss this plugin's notices without
    // reading them, which is the habit that has to survive for a failure notice to be worth
    // raising.
    expect(DEFAULT_NOTICE_LEVEL).toBe("activity");
  });

  it("keeps the migration's answer independent of the shipped default", () => {
    // Sharing the constant would round every upgrading device quietly DOWN to the new default,
    // which is the one direction the migration promises never to go.
    expect(migrateLegacyNoticeLevel({ notifyOnSync: true, notifyOnlyChanged: false })).toBe("all");
    expect(DEFAULT_NOTICE_LEVEL).not.toBe("all");
  });
});

describe("noticeAllowed", () => {
  const categories: NoticeCategory[] = [...NOTICE_CATEGORIES];

  it("lets every category through at the loudest level", () => {
    for (const category of categories) expect(noticeAllowed("all", category)).toBe(true);
  });

  it("blocks every category at the quietest", () => {
    for (const category of categories) expect(noticeAllowed("silent", category)).toBe(false);
  });
});

describe("announcePass", () => {
  const idle = { status: "unchanged", ...base } as SyncResult;
  const moved = committed({ pushedChanges: [change("a.md", "add", 3)] });

  it("says nothing about passes below the two loud levels", () => {
    for (const level of ["problems", "silent"] as const) {
      for (const result of [idle, moved]) {
        expect(announcePass({ level, result }), level).toBe(false);
      }
    }
  });

  it("announces every pass at All, including one that did nothing", () => {
    expect(announcePass({ level: "all", result: idle })).toBe(true);
  });

  it("is Activity that drops the no-op, and only that", () => {
    // The entire difference between the two loud levels. If this stops holding they are the
    // same rung with two names.
    expect(announcePass({ level: "activity", result: idle })).toBe(false);
    expect(announcePass({ level: "activity", result: moved })).toBe(true);
  });

  it("means changed-something at Activity with NO exception for a manual sync", () => {
    // There used to be one: a pass the user started spoke even when it found nothing, because
    // a tap with no reply reads like a tap that missed. `announceStart` is a switch of its own
    // now and fires on exactly those passes, at the moment someone is actually wondering — so
    // the exception only survived as "only passes that changed something, except the ones you
    // are most likely to be watching". It takes no `interactive` argument at all, which is the
    // strongest form this can be pinned in.
    expect(announcePass({ level: "activity", result: idle })).toBe(false);
  });

  it("leaves a halt to its own sticky notice", () => {
    const halted = { status: "halted", reason: "key mismatch", ...base } as SyncResult;
    expect(announcePass({ level: "all", result: halted })).toBe(false);
  });

  it("leaves an unanswered question to its own notice too", () => {
    // The summary line would read "up to date" directly above a notice saying the pass was
    // paused and nothing was done. Both cannot be true, and only one of them is.
    const pending = [
      {
        status: "needs-decision",
        summary: { deletes: [], overwrites: [], localFileCount: 1, percent: 100, threshold: 50 },
        ...base,
      },
      {
        status: "needs-continuity",
        continuity: {
          head: "01NEW",
          lastHead: "01OURS",
          reason: "replaced",
          walked: 1,
          alreadyApplied: 0,
        },
        ...base,
      },
    ] as SyncResult[];
    for (const result of pending) {
      expect(announcePass({ level: "all", result })).toBe(false);
    }
  });

  it("keeps a moved-files pass quiet at Silent", () => {
    // `passChangedSomething` short-circuits to true further down, so this pins that the level
    // check really is first and not merely one clause among several.
    const result = committed({ pushedChanges: [change("a.md", "add", 3)] });
    expect(announcePass({ level: "silent", result })).toBe(false);
  });
});

describe("announceStart", () => {
  // Between the tap and the summary there is nothing on screen at all, and on a phone there
  // is no status bar to fall back on — a first sync leaves that gap open for minutes, which
  // reads exactly like a tap that missed.
  it("answers a sync the user started", () => {
    expect(announceStart({ enabled: true, interactive: true, alwaysManual: false })).toBe(true);
  });

  it("stays quiet for a timer, which has nobody to reassure", () => {
    expect(announceStart({ enabled: true, interactive: false, alwaysManual: false })).toBe(false);
  });

  it("obeys its own switch when the manual override is off", () => {
    expect(announceStart({ enabled: false, interactive: true, alwaysManual: false })).toBe(false);
  });

  it("opens for a hand-started pass under the override, switch or no switch", () => {
    // The override promises a reply at both ends of a pass the user asked for. Leaving the
    // opener behind would make it a promise about the half nobody is waiting through.
    expect(announceStart({ enabled: false, interactive: true, alwaysManual: true })).toBe(true);
  });

  it("still has nobody to reassure on a timer, override or not", () => {
    // The override is about answering a click. A background pass was not clicked.
    expect(announceStart({ enabled: false, interactive: false, alwaysManual: true })).toBe(false);
  });
});

describe("passNoticeLevel", () => {
  it("leaves an unattended pass to the stored level", () => {
    for (const level of NOTICE_LEVELS) {
      expect(passNoticeLevel({ level, interactive: false, alwaysManual: true }), level).toBe(level);
    }
  });

  it("leaves every pass to the stored level once the override is off", () => {
    for (const level of NOTICE_LEVELS) {
      expect(passNoticeLevel({ level, interactive: true, alwaysManual: false }), level).toBe(level);
    }
  });

  it("reports a hand-started pass at the top of the ladder", () => {
    for (const level of NOTICE_LEVELS) {
      expect(passNoticeLevel({ level, interactive: true, alwaysManual: true }), level).toBe("all");
    }
  });

  it("can only ever make a pass louder", () => {
    // The override raises notices; nothing about it may take one away. `all` being the first
    // rung is what guarantees that, so pin the two together rather than trusting the ordering
    // to stay this way by accident.
    expect(NOTICE_LEVELS[0]).toBe("all");
    for (const level of NOTICE_LEVELS) {
      const raised = passNoticeLevel({ level, interactive: true, alwaysManual: true });
      for (const category of NOTICE_CATEGORIES) {
        if (noticeAllowed(level, category)) {
          expect(noticeAllowed(raised, category), `${level}/${category}`).toBe(true);
        }
      }
    }
  });

  it("is on by default, because the ladder is about sync nobody asked for", () => {
    expect(DEFAULT_ALWAYS_REPORT_MANUAL).toBe(true);
  });
});

describe("conflictReport", () => {
  it("opens the window for a watched pass and points a background one at the command", () => {
    for (const level of ["all", "activity", "problems"] as const) {
      expect(conflictReport({ level, interactive: true }), level).toBe("modal");
      expect(conflictReport({ level, interactive: false }), level).toBe("notice");
    }
  });

  it("silences the WINDOW too, not just the notice", () => {
    // The bug this exists to stop: the conflict setting used to suppress the notice and then
    // open a modal anyway, so asking for less interruption produced more.
    expect(conflictReport({ level: "silent", interactive: true })).toBe("none");
    expect(conflictReport({ level: "silent", interactive: false })).toBe("none");
  });

  it("survives at the Problems level, where pass notices do not", () => {
    // The point of that rung: everything routine goes quiet and the things needing a human
    // stay loud. A conflict is the clearest case of the latter.
    expect(noticeAllowed("problems", "pass")).toBe(false);
    expect(conflictReport({ level: "problems", interactive: true })).toBe("modal");
  });
});

describe("migrateLegacyNoticeLevel", () => {
  it("has nothing to say about settings that never had the old keys", () => {
    expect(migrateLegacyNoticeLevel(null)).toBeNull();
    expect(migrateLegacyNoticeLevel(undefined)).toBeNull();
    expect(migrateLegacyNoticeLevel({ verboseSyncNotice: true })).toBeNull();
  });

  it("maps the old shipped defaults to the loudest level, not the new default", () => {
    expect(
      migrateLegacyNoticeLevel({
        notifyOnSync: true,
        notifyOnlyChanged: false,
        notifyOnChanges: true,
        notifyOnConflicts: true,
        notifyOnProblems: true,
      })
    ).toBe("all");
  });

  it("reads the old changes-only narrowing as Activity", () => {
    expect(migrateLegacyNoticeLevel({ notifyOnSync: true, notifyOnlyChanged: true })).toBe(
      "activity"
    );
  });

  it("rounds up rather than down when the old state does not fit a rung", () => {
    // Sixteen combinations do not fit four levels, so most migrations must be wrong in one
    // direction. Quieter would suppress notices the user had switched ON, invisibly and on
    // upgrade, with a failure the likeliest thing lost. Louder is at worst one extra toast.
    expect(
      migrateLegacyNoticeLevel({
        notifyOnSync: false,
        notifyOnChanges: true,
        notifyOnConflicts: false,
        notifyOnProblems: false,
      })
    ).toBe("activity");
    expect(
      migrateLegacyNoticeLevel({
        notifyOnSync: false,
        notifyOnChanges: false,
        notifyOnConflicts: false,
        notifyOnProblems: true,
      })
    ).toBe("problems");
    expect(
      migrateLegacyNoticeLevel({
        notifyOnSync: false,
        notifyOnChanges: false,
        notifyOnConflicts: true,
        notifyOnProblems: false,
      })
    ).toBe("problems");
  });

  it("preserves a deliberate silence exactly", () => {
    expect(
      migrateLegacyNoticeLevel({
        notifyOnSync: false,
        notifyOnlyChanged: false,
        notifyOnChanges: false,
        notifyOnConflicts: false,
        notifyOnProblems: false,
      })
    ).toBe("silent");
  });

  it("treats a missing key as its old default, never as off", () => {
    // A partially written or hand-edited data.json is the case. Reading absent as `false`
    // would migrate a device into silence it never asked for — the one direction this must
    // never go — and the only visible symptom would be failures that stopped being reported.
    expect(migrateLegacyNoticeLevel({ notifyOnlyChanged: false })).toBe("all");
    expect(migrateLegacyNoticeLevel({ notifyOnSync: false })).toBe("activity");
    expect(migrateLegacyNoticeLevel({ notifyOnSync: false, notifyOnChanges: false })).toBe(
      "problems"
    );
  });

  it("ignores a value of the wrong type the same way", () => {
    expect(migrateLegacyNoticeLevel({ notifyOnSync: "false" })).toBe("all");
  });

  it("never returns a level outside the ladder", () => {
    for (const a of [true, false]) {
      for (const b of [true, false]) {
        for (const c of [true, false]) {
          for (const d of [true, false]) {
            for (const e of [true, false]) {
              const level = migrateLegacyNoticeLevel({
                notifyOnSync: a,
                notifyOnlyChanged: b,
                notifyOnChanges: c,
                notifyOnConflicts: d,
                notifyOnProblems: e,
              });
              expect(isNoticeLevel(level)).toBe(true);
            }
          }
        }
      }
    }
  });

  it("only ever migrates a device louder than the old booleans, never quieter", () => {
    // The migration promise, checked against every combination rather than asserted in prose:
    // whatever the old keys allowed, the new level must still allow.
    for (const a of [true, false]) {
      for (const c of [true, false]) {
        for (const d of [true, false]) {
          for (const e of [true, false]) {
            const saved = {
              notifyOnSync: a,
              notifyOnlyChanged: false,
              notifyOnChanges: c,
              notifyOnConflicts: d,
              notifyOnProblems: e,
            };
            const old = { pass: a, changes: c, conflicts: d, problems: e };
            const now = policyForLevel(migrateLegacyNoticeLevel(saved) as NoticeLevel);
            for (const category of NOTICE_CATEGORIES) {
              if (old[category]) expect(now[category], `${JSON.stringify(saved)} ${category}`).toBe(true);
            }
          }
        }
      }
    }
  });

  it("names every key it migrates", () => {
    expect([...LEGACY_NOTICE_KEYS]).toEqual([
      "notifyOnSync",
      "notifyOnlyChanged",
      "notifyOnChanges",
      "notifyOnConflicts",
      "notifyOnProblems",
    ]);
  });
});

describe("resolveNoticeLevel", () => {
  it("prefers a stored level over legacy keys still lying around", () => {
    // A device that already migrated can still be carrying the old keys in a data.json
    // written before they were dropped. Re-deriving from them would undo the user's choice
    // on every single load.
    expect(resolveNoticeLevel({ noticeLevel: "silent", notifyOnSync: true })).toBe("silent");
  });

  it("migrates when there is no stored level", () => {
    expect(resolveNoticeLevel({ notifyOnSync: false, notifyOnChanges: false })).toBe("problems");
  });

  it("falls back to the default for a fresh install", () => {
    expect(resolveNoticeLevel(null)).toBe(DEFAULT_NOTICE_LEVEL);
    expect(resolveNoticeLevel({})).toBe(DEFAULT_NOTICE_LEVEL);
  });

  it("falls back rather than throwing on an unreadable stored value", () => {
    // Deliberately not fail-loud: this decides how chatty a toast is, a newer build may know
    // levels this one does not, and halting sync over a display preference would turn a
    // cosmetic problem into a data one.
    expect(resolveNoticeLevel({ noticeLevel: "loud" })).toBe(DEFAULT_NOTICE_LEVEL);
    expect(resolveNoticeLevel({ noticeLevel: 3 })).toBe(DEFAULT_NOTICE_LEVEL);
  });

  it("prefers a garbage stored value's legacy fallback over neither", () => {
    expect(resolveNoticeLevel({ noticeLevel: "loud", notifyOnSync: false, notifyOnChanges: false })).toBe(
      "problems"
    );
  });
});

describe("resolveNoticeStart", () => {
  it("defaults off for a fresh install", () => {
    // At `activity` the summary already speaks for every pass that did anything, so the opener's
    // usual companion is a summary right after it — two toasts for one uneventful pass.
    expect(resolveNoticeStart(null)).toBe(DEFAULT_NOTICE_START);
    expect(resolveNoticeStart({})).toBe(DEFAULT_NOTICE_START);
    expect(DEFAULT_NOTICE_START).toBe(false);
  });

  it("gives an UPGRADING device the old default, not the new one", () => {
    // Any legacy key present means this came off the old build, where the opener was on unless
    // `notifyOnSync` said otherwise. Falling through to the new default here would silently drop
    // an opener that build was showing them — the same absent-is-not-off trap as the level.
    expect(resolveNoticeStart({ notifyOnChanges: false })).toBe(true);
    expect(resolveNoticeStart({ notifyOnlyChanged: true })).toBe(true);
  });

  it("carries the old notifyOnSync across EXACTLY, not rounded up like the level", () => {
    // `notifyOnSync` governed both ends of a pass, so someone who turned it off had no opener
    // and must not acquire one on upgrade. The level cannot be exact because sixteen states do
    // not fit in four; this can be, so it is.
    expect(resolveNoticeStart({ notifyOnSync: false })).toBe(false);
    expect(resolveNoticeStart({ notifyOnSync: true })).toBe(true);
  });

  it("means a fully silenced device stays fully silent through the upgrade", () => {
    const silenced = {
      notifyOnSync: false,
      notifyOnChanges: false,
      notifyOnConflicts: false,
      notifyOnProblems: false,
    };
    expect(resolveNoticeLevel(silenced)).toBe("silent");
    expect(resolveNoticeStart(silenced)).toBe(false);
  });

  it("prefers a stored value over the legacy one", () => {
    expect(resolveNoticeStart({ notifyOnStart: true, notifyOnSync: false })).toBe(true);
    expect(resolveNoticeStart({ notifyOnStart: false, notifyOnSync: true })).toBe(false);
  });

  it("ignores a stored value of the wrong type", () => {
    expect(resolveNoticeStart({ notifyOnStart: "yes" })).toBe(DEFAULT_NOTICE_START);
    expect(resolveNoticeStart({ notifyOnStart: "yes", notifyOnSync: true })).toBe(true);
  });
});

describe("shortSnapshot", () => {
  // A real one: 10 characters of timestamp then 16 of randomness.
  const id = "01K2QWERTY" + "ABCDEFGHJKMNPQRS";

  it("keeps the identifying end, not the clock at the front", () => {
    // The first ten characters are the creation time, so a seven-character prefix is constant
    // for ~33 seconds and says nothing the notice's own arrival time did not. This is the one
    // assertion that would fail if someone "fixed" it to slice from the front like git.
    expect(shortSnapshot(id)).toBe("kmnpqrs");
    expect(shortSnapshot(id)).toHaveLength(SHORT_SNAPSHOT_LENGTH);
    expect(id.toLowerCase().startsWith(shortSnapshot(id))).toBe(false);
  });

  it("lower-cases, so no two surfaces can disagree about how an id looks", () => {
    // Applied inside this function rather than at each call site, which is what makes it a
    // property of the id rather than of whichever window happens to be showing it. Crockford
    // base32 is case-insensitive by definition, so nothing is lost — the exported log note
    // still carries the full 26 characters as generated.
    expect(shortSnapshot(id)).toBe(shortSnapshot(id.toLowerCase()));
    expect(shortSnapshot(id)).toBe(shortSnapshot(id).toLowerCase());
  });

  it("takes no switch, because every id on screen is the short one", () => {
    // A setting used to make this conditional. An id abbreviated in a notice and spelled in
    // full in the dialog two taps later reads as two identifiers rather than one thoughtful
    // choice per surface — and the long form buys nothing, since nobody types or pastes it.
    expect(shortSnapshot.length).toBe(1);
  });

  it("leaves an id that is already short alone rather than padding or slicing it", () => {
    // Fakes and older tests use short ids; slicing one would report a suffix of something the
    // reader would recognise in full.
    expect(shortSnapshot("01SNAP")).toBe("01snap");
    expect(shortSnapshot("")).toBe("");
    expect(shortSnapshot("0123456")).toBe("0123456");
  });
});
