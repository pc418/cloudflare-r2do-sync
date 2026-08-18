import { describe, it, expect } from "vitest";
import {
  LOG_ENTRIES_RANGE,
  MAX_LOG_ENTRIES,
  appendLog,
  entryFromError,
  entryFromResult,
  describePass,
  formatLogNote,
  relativeTime,
  summarise,
} from "../src/log";
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
};

describe("relativeTime", () => {
  const now = 1_754_000_000_000;

  it("collapses the last minute to 'just now'", () => {
    expect(relativeTime(now, now)).toBe("just now");
    expect(relativeTime(now - 59_000, now)).toBe("just now");
  });

  it("steps up through minutes, hours and days", () => {
    expect(relativeTime(now - 60_000, now)).toBe("1m ago");
    expect(relativeTime(now - 59 * 60_000, now)).toBe("59m ago");
    expect(relativeTime(now - 60 * 60_000, now)).toBe("1h ago");
    expect(relativeTime(now - 23 * 3_600_000, now)).toBe("23h ago");
    expect(relativeTime(now - 24 * 3_600_000, now)).toBe("1d ago");
    expect(relativeTime(now - 400 * 86_400_000, now)).toBe("400d ago");
  });

  it("treats a future timestamp as now rather than printing negative time", () => {
    // Clock skew between devices is normal; "-3m ago" would read as a bug.
    expect(relativeTime(now + 5_000, now)).toBe("just now");
  });
});

describe("appendLog", () => {
  const entry = (at: number) => entryFromResult({ status: "unchanged", ...base }, at);

  it("keeps newest first", () => {
    const log = appendLog(appendLog([], entry(1)), entry(2));
    expect(log.map((e) => e.at)).toEqual([2, 1]);
  });

  it("caps the history so data.json cannot grow without bound", () => {
    let log: ReturnType<typeof entry>[] = [];
    for (let i = 0; i < MAX_LOG_ENTRIES + 20; i++) log = appendLog(log, entry(i));
    expect(log).toHaveLength(MAX_LOG_ENTRIES);
    expect(log[0].at).toBe(MAX_LOG_ENTRIES + 19);
  });

  it("tolerates a missing prior log, as on first run", () => {
    expect(appendLog(undefined, entry(1))).toHaveLength(1);
  });

  it("honours a configured retention, and trims an over-long log immediately", () => {
    let log: ReturnType<typeof entry>[] = [];
    for (let i = 0; i < 30; i++) log = appendLog(log, entry(i), 10);
    expect(log).toHaveLength(10);
    expect(log[0].at).toBe(29);

    // Lowering the setting must take effect on the next pass, not only as entries age out.
    expect(appendLog(log, entry(99), 3).map((e) => e.at)).toEqual([99, 29, 28]);
  });

  it("clamps a nonsensical retention rather than losing the log or growing forever", () => {
    const log = [entry(1), entry(2)];
    expect(appendLog(log, entry(3), 0)).toHaveLength(1);
    expect(appendLog(log, entry(3), -5)).toHaveLength(1);
    expect(appendLog(log, entry(3), LOG_ENTRIES_RANGE.max + 1_000)).toHaveLength(3);
  });
});

describe("entryFromResult", () => {
  it("records the counts that matter for later debugging", () => {
    const res: SyncResult = {
      status: "committed",
      head: "01ABC",
      uploaded: 3,
      skipped: [{ path: "big.bin", reason: "too large" }],
      pushedChanges: [],
      pulledChanges: [],
      pulled: 2,
      merged: 1,
      conflicts: ["a.conflict-phone-260803-1200.md"],
      conflictDetails: [
        {
          path: "a.md",
          copy: "a.conflict-phone-260803-1200.md",
          kept: "ours" as const,
          ours: { mtime: 1, size: 10 },
          theirs: { mtime: 2, size: 20 },
        },
      ],
    };
    const e = entryFromResult(res, 1_754_000_000_000);
    expect(e).toMatchObject({
      at: 1_754_000_000_000,
      status: "committed",
      uploaded: 3,
      pulled: 2,
      merged: 1,
      conflicts: 1,
      skipped: 1,
    });
    expect(e.detail).toContain("01ABC");
  });

  it("keeps the halt reason, which is the whole point of looking at the log", () => {
    const e = entryFromResult({ status: "halted", reason: "key mismatch", ...base }, 1);
    expect(e.status).toBe("halted");
    expect(e.detail).toBe("key mismatch");
  });

  it("summarises a pending decision with its numbers", () => {
    const e = entryFromResult(
      {
        status: "needs-decision",
        summary: {
          deletes: ["a.md", "b.md", "c.md"],
          overwrites: [],
          localFileCount: 4,
          percent: 75,
          threshold: 50,
        },
        ...base,
      },
      1
    );
    expect(e.status).toBe("needs-decision");
    expect(e.detail).toContain("75%");
    expect(e.detail).toContain("3");
  });

  it("records both heads when the remote's ancestry could not be confirmed", () => {
    // The pair of ids is the whole diagnostic value: without them, "could not confirm" is a
    // sentence nobody can act on days later.
    const e = entryFromResult(
      {
        status: "needs-continuity",
        continuity: {
          head: "01NEW",
          lastHead: "01OURS",
          reason: "truncated",
          walked: 4,
          alreadyApplied: 0,
        },
        ...base,
      },
      1
    );
    expect(e.status).toBe("needs-continuity");
    expect(e.detail).toContain("01NEW");
    expect(e.detail).toContain("01OURS");
    expect(e.detail).toContain("truncated");
  });
});

describe("entryFromError", () => {
  it("records the message and marks the pass failed", () => {
    const e = entryFromError(new Error("network down"), 42);
    expect(e).toMatchObject({ at: 42, status: "error", detail: "network down" });
  });

  it("survives a thrown non-Error", () => {
    expect(entryFromError("weird", 1).detail).toBe("weird");
  });
});

describe("summarise", () => {
  it("describes an idle vault plainly", () => {
    expect(summarise({ status: "unchanged", ...base })).toBe("up to date");
  });

  it("mentions every kind of work done in one line", () => {
    const s = summarise({
      status: "committed",
      head: "01ABC",
      uploaded: 2,
      skipped: [],
      pushedChanges: [],
      pulledChanges: [],
      pulled: 3,
      merged: 1,
      conflicts: ["x.md"],
      conflictDetails: [
        { path: "x.md", copy: "x.md", kept: "ours" as const, ours: { mtime: 1, size: 1 }, theirs: { mtime: 2, size: 2 } },
      ],
    });
    expect(s).toContain("2 uploaded");
    expect(s).toContain("3 pulled");
    expect(s).toContain("1 merged");
    expect(s).toContain("1 conflict");
  });
});

describe("formatLogNote", () => {
  it("renders a markdown table newest first", () => {
    const log = [
      entryFromResult({ status: "committed", head: "01B", ...base, uploaded: 1 }, 1_754_000_060_000),
      entryFromResult({ status: "unchanged", ...base }, 1_754_000_000_000),
    ];
    const note = formatLogNote(log, 1_754_000_120_000);

    expect(note).toContain("| Time |");
    const rows = note.split("\n").filter((l) => l.startsWith("| 2"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("committed");
    expect(rows[1]).toContain("unchanged");
  });

  it("escapes pipes so one error message cannot break the table", () => {
    const log = [entryFromError(new Error("bad | pipe"), 1_754_000_000_000)];
    const note = formatLogNote(log, 1_754_000_000_000);
    expect(note).toContain("bad \\| pipe");
  });

  it("says so plainly when there is nothing recorded yet", () => {
    expect(formatLogNote([], 1)).toContain("No sync passes recorded");
  });
});

const change = (
  path: string,
  action: "add" | "update" | "delete" | "merge",
  lines: number | null
) => ({ path, action, lines });

const committed = (over: Partial<SyncResult> = {}): SyncResult =>
  ({ status: "committed", head: "01SNAPSHOT", ...base, ...over }) as SyncResult;

describe("describePass", () => {
  it("says so plainly when nothing moved", () => {
    expect(describePass({ status: "unchanged", ...base }, { verbose: false })).toBe("up to date");
  });

  it("counts files and net lines per direction on one line", () => {
    const line = describePass(
      committed({
        pushedChanges: [change("a.md", "add", 12), change("b.md", "update", 23)],
        pulledChanges: [change("c.md", "update", -7)],
      }),
      { verbose: false }
    );
    // One file added, so +1/-0; lines split by sign across the group rather than netted.
    expect(line).toContain("^ +1/-0 files, +35/-0 lines");
    // Pulled side changed a file's contents only, so there is NO file clause at all — a note
    // you edited is not a file you gained, and "+0/-0 files" would be noise on every edit.
    expect(line).toContain("v +0/-7 lines");
    expect(line).not.toContain("v +0/-0 files");
    expect(line).not.toContain("a.md");
  });

  it("splits lines by direction instead of letting two files cancel out", () => {
    // The whole reason for a pair rather than a net: +40 and -40 in one pass is not "no
    // change", and reporting it as 0 was the old format's worst answer.
    const line = describePass(
      committed({
        pushedChanges: [change("grew.md", "update", 40), change("shrank.md", "update", -40)],
      }),
      { verbose: false }
    );
    expect(line).toContain("+40/-40 lines");
    expect(line).not.toContain("+0/-0");
  });

  it("groups thousands, because a first sync reports five figures", () => {
    const line = describePass(
      committed({ pushedChanges: [change("a.md", "add", 21_430)] }),
      { verbose: false }
    );
    expect(line).toContain("+21,430/-0 lines");
  });

  it("reports a net zero rather than pretending nothing happened", () => {
    // Five lines swapped for five is the honest limit of a cached count, and an update is not
    // a file gained — so the pass reports a zero line pair rather than vanishing.
    const line = describePass(
      committed({ pushedChanges: [change("a.md", "update", 0)] }),
      { verbose: false }
    );
    expect(line).toContain("^ +0/-0 lines");
  });

  it("drops the line clause when nothing could be counted, and flags a partial count", () => {
    // Binary: no lines to pair, but a file did arrive, so the file pair carries it.
    expect(
      describePass(committed({ pushedChanges: [change("img.png", "add", null)] }), { verbose: false })
    ).toContain("^ +1/-0 files");

    expect(
      describePass(
        committed({ pushedChanges: [change("a.md", "add", 4), change("img.png", "add", null)] }),
        { verbose: false }
      )
    ).toContain("+2/-0 files, +4/-0 lines (1 not counted)");
  });

  it("stays a single line when not verbose, with nothing appended to explain itself", () => {
    // A legend was tried here and removed: the pairs read as what they are, and a fixed extra
    // line on every pass forever is exactly the noise short ids were meant to buy back.
    const moved = describePass(committed({ pushedChanges: [change("a.md", "add", 1)] }), { verbose: false });
    expect(moved.split(String.fromCharCode(10))).toHaveLength(1);
  });

  it("appends conflicts and skips, which are not file movements", () => {
    const line = describePass(
      committed({
        pushedChanges: [change("a.md", "add", 1)],
        skipped: [{ path: "big.bin", reason: "too large" }],
        conflictDetails: [
          {
            path: "x.md",
            copy: "x.copy.md",
            kept: "ours" as const,
            ours: { mtime: 1, size: 1 },
            theirs: { mtime: 2, size: 2 },
          },
        ],
      }),
      { verbose: false }
    );
    expect(line).toContain("1 conflict");
    expect(line).toContain("1 skipped");
  });

  it("names every changed file when verbose, with its own net count and the snapshot id", () => {
    const text = describePass(
      committed({
        pushedChanges: [change("new.md", "add", 12), change("gone.md", "delete", -4)],
        pulledChanges: [change("merged.md", "merge", 2)],
      }),
      { verbose: true }
    );
    const lines = text.split(String.fromCharCode(10));
    expect(lines).toContain("  + new.md (+12)");
    expect(lines).toContain("  - gone.md (-4)");
    expect(lines).toContain("  >< merged.md (+2)");
    // The fixture id is a 10-character stand-in, so it is abbreviated like a real one would
    // be — every id on screen is the 7-character form now, with no setting behind it.
    expect(lines.at(-1)).toBe("snapshot NAPSHOT");
  });

  // A realistic id: 10 characters of ULID timestamp then 16 of randomness.
  const longId = "01K2QWERTYABCDEFGHJKMNPQRS";
  const withLongId = (): SyncResult =>
    ({
      ...committed({ pushedChanges: [change("a.md", "add", 1)] }),
      head: longId,
    }) as SyncResult;

  it("abbreviates the snapshot id, and nothing else on the line", () => {
    const lines = describePass(withLongId(), { verbose: true }).split(
      String.fromCharCode(10)
    );
    expect(lines.at(-1)).toBe("snapshot KMNPQRS");
    // The file line is untouched: shortening is about the id, not about trimming the notice.
    expect(lines).toContain("  + a.md (+1)");
  });

  it("takes no option for it, so no caller can print the full 26 on screen", () => {
    // `describePass` used to carry a `shortIds` flag through from a setting. The whole point of
    // dropping it is that no surface can disagree with another about what a snapshot is called.
    expect(describePass(withLongId(), { verbose: true })).not.toContain(longId);
  });

  it("writes a zero net delta as 0, never as -0", () => {
    // `-0` reports a file that shrank. Zero here is a real answer — five lines swapped for
    // five — and the settings copy promises it reads as 0.
    const text = describePass(committed({ pushedChanges: [change("a.md", "update", 0)] }), { verbose: true });
    expect(text).toContain("  ~ a.md (0)");
    expect(text).not.toContain("-0)");
  });

  it("omits the count for a file it could not attribute rather than printing (0)", () => {
    const text = describePass(committed({ pushedChanges: [change("img.png", "add", null)] }), { verbose: true });
    expect(text).toContain("  + img.png");
    expect(text).not.toContain("img.png (");
  });

  it("caps the verbose list so a first sync cannot fill the screen", () => {
    const many = Array.from({ length: 25 }, (_, i) => change(`n${i}.md`, "add", 1));
    const text = describePass(committed({ pushedChanges: many }), { verbose: true });
    const named = text.split(String.fromCharCode(10)).filter((l) => l.startsWith("  + "));
    expect(named).toHaveLength(10);
    expect(text).toContain("... 15 more");
    expect(text).toContain("+25/-0 files, +25/-0 lines");
  });
});
