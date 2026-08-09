import { describe, it, expect } from "vitest";
import {
  LOG_ENTRIES_RANGE,
  MAX_LOG_ENTRIES,
  appendLog,
  entryFromError,
  entryFromResult,
  announcePass,
  describePass,
  formatLogNote,
  passChangedSomething,
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

describe("passChangedSomething", () => {
  it("is false for a pass that moved nothing", () => {
    expect(passChangedSomething({ status: "unchanged", ...base })).toBe(false);
  });

  it("is true for either direction on its own", () => {
    expect(passChangedSomething(committed({ pushedChanges: [change("a.md", "add", 3)] }))).toBe(true);
    expect(passChangedSomething(committed({ pulledChanges: [change("a.md", "add", 3)] }))).toBe(true);
  });
});

describe("announcePass", () => {
  const idle = { status: "unchanged", ...base } as SyncResult;
  const moved = committed({ pushedChanges: [change("a.md", "add", 3)] });

  it("says nothing at all when notices are switched off", () => {
    for (const result of [idle, moved]) {
      expect(
        announcePass({ notifyOnSync: false, onlyChanged: false, interactive: true, result })
      ).toBe(false);
    }
  });

  it("announces every pass by default, including one that did nothing unattended", () => {
    expect(
      announcePass({ notifyOnSync: true, onlyChanged: false, interactive: false, result: idle })
    ).toBe(true);
  });

  it("stays quiet on an unattended no-op once the user asks for changes only", () => {
    expect(
      announcePass({ notifyOnSync: true, onlyChanged: true, interactive: false, result: idle })
    ).toBe(false);
    expect(
      announcePass({ notifyOnSync: true, onlyChanged: true, interactive: false, result: moved })
    ).toBe(true);
  });

  it("still answers a pass the user started, even asking for changes only", () => {
    // A tap with no reply is indistinguishable from a tap that missed, and on a phone there is
    // no status bar to fall back on.
    expect(
      announcePass({ notifyOnSync: true, onlyChanged: true, interactive: true, result: idle })
    ).toBe(true);
  });

  it("leaves a halt to its own sticky notice", () => {
    const halted = { status: "halted", reason: "key mismatch", ...base } as SyncResult;
    expect(
      announcePass({ notifyOnSync: true, onlyChanged: false, interactive: true, result: halted })
    ).toBe(false);
  });
});

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
    expect(line).toContain("2 files, +35 lines");
    expect(line).toContain("1 file, -7 lines");
    expect(line).not.toContain("a.md");
  });

  it("reports a net zero rather than pretending nothing happened", () => {
    // Five lines swapped for five is the honest limit of a cached count; the file count carries
    // the fact that work happened.
    const line = describePass(
      committed({ pushedChanges: [change("a.md", "update", 0)] }),
      { verbose: false }
    );
    expect(line).toContain("1 file, 0 lines");
  });

  it("drops the line clause when nothing could be counted, and flags a partial count", () => {
    expect(
      describePass(committed({ pushedChanges: [change("img.png", "add", null)] }), {
        verbose: false,
      })
    ).toBe("^ 1 file");

    expect(
      describePass(
        committed({ pushedChanges: [change("a.md", "add", 4), change("img.png", "add", null)] }),
        { verbose: false }
      )
    ).toContain("2 files, +4 lines (1 not counted)");
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
    expect(lines[lines.length - 1]).toBe("snapshot 01SNAPSHOT");
  });

  it("omits the count for a file it could not attribute rather than printing (0)", () => {
    const text = describePass(committed({ pushedChanges: [change("img.png", "add", null)] }), {
      verbose: true,
    });
    expect(text).toContain("  + img.png");
    expect(text).not.toContain("img.png (");
  });

  it("caps the verbose list so a first sync cannot fill the screen", () => {
    const many = Array.from({ length: 25 }, (_, i) => change(`n${i}.md`, "add", 1));
    const text = describePass(committed({ pushedChanges: many }), { verbose: true });
    const named = text.split(String.fromCharCode(10)).filter((l) => l.startsWith("  + "));
    expect(named).toHaveLength(10);
    expect(text).toContain("... 15 more");
    expect(text).toContain("25 files, +25 lines");
  });
});
