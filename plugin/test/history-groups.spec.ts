// Grouping a chain page into calendar buckets. Pure and local-time — every timestamp here is
// built from local components on purpose, so the suite says the same thing in every timezone.
import { describe, expect, it } from "vitest";
import { groupHistory, countGroups } from "../src/history-groups";
import type { HistoryEntry } from "../src/types";

/** A local wall-clock time, as ms. Never a UTC string: the buckets are the user's calendar. */
function at(y: number, m: number, d: number, h = 12, min = 0): number {
  return new Date(y, m - 1, d, h, min).getTime();
}

/**
 * A chain of entries, newest first, from a list of upload times. Each one's parent is the next,
 * so the page is a real chain and the last entry ends it.
 */
function chain(
  times: number[],
  over: Array<Partial<HistoryEntry>> = []
): HistoryEntry[] {
  return times.map((uploadedAt, i) => ({
    id: `id${i}`,
    parent: i + 1 < times.length ? `id${i + 1}` : null,
    uploadedAt,
    device: "laptop",
    createdAt: new Date(uploadedAt).toISOString(),
    spliceParent: null,
    pruned: null,
    ...over[i],
  }));
}

const ENDS = { chainEnds: true };

describe("groupHistory", () => {
  it("cuts a bucket when the local day changes", () => {
    const entries = chain([
      at(2026, 8, 20, 9),
      at(2026, 8, 19, 23, 59),
      at(2026, 8, 19, 0, 1),
      at(2026, 8, 18, 12),
    ]);

    const groups = groupHistory(entries, "day", ENDS);
    expect(groups.map((g) => g.group.syncs)).toEqual([1, 2, 1]);
    expect(groups.map((g) => g.pick.id)).toEqual(["id0", "id1", "id3"]);
    // Local midnight of each bucket, not a UTC one.
    expect(groups.map((g) => g.group.start)).toEqual([
      at(2026, 8, 20, 0),
      at(2026, 8, 19, 0),
      at(2026, 8, 18, 0),
    ]);
  });

  it("diffs each bucket against the older bucket's pick, leaving no snapshot uncounted", () => {
    const entries = chain([at(2026, 8, 20, 9), at(2026, 8, 19, 18), at(2026, 8, 19, 8)]);

    const groups = groupHistory(entries, "day", ENDS);
    expect(groups.map((g) => g.compareTo)).toEqual(["id1", null]);
    // The 20th's row covers one sync; the 19th's covers both of its own.
    expect(groups.map((g) => g.spans)).toEqual([1, 2]);
  });

  it("counts commits a sweep collected inside a bucket's span", () => {
    const entries = chain(
      [at(2026, 8, 20, 9), at(2026, 8, 19, 18), at(2026, 8, 18, 8)],
      [{}, { spliceParent: "id2", pruned: 4 }, {}]
    );

    // The 19th's listed snapshot stands for itself plus four collected commits, so the day
    // covers five syncs even though the index lists one.
    const groups = groupHistory(entries, "day", ENDS);
    expect(groups.map((g) => g.spans)).toEqual([1, 5, 1]);
    expect(groups[1].compareTo).toBe("id2");
  });

  it("starts a week on Monday and holds a Sunday in the week before", () => {
    // 2026-08-17 is a Monday; the 23rd is the Sunday that closes the same week.
    const entries = chain([
      at(2026, 8, 24, 9),
      at(2026, 8, 23, 9),
      at(2026, 8, 17, 9),
      at(2026, 8, 16, 9),
    ]);

    const groups = groupHistory(entries, "week", ENDS);
    expect(groups.map((g) => g.group.start)).toEqual([
      at(2026, 8, 24, 0),
      at(2026, 8, 17, 0),
      at(2026, 8, 10, 0),
    ]);
    expect(groups.map((g) => g.group.syncs)).toEqual([1, 2, 1]);
  });

  it("drops the trailing bucket when the page ran out of rows, not out of chain", () => {
    // The oldest listed snapshot still names a parent, so older members of the 18th are on a
    // page nobody fetched. Diffing that bucket would describe part of a day as all of it.
    const entries = chain([at(2026, 8, 20, 9), at(2026, 8, 19, 9), at(2026, 8, 18, 9)]);
    entries[entries.length - 1].parent = "older";

    const groups = groupHistory(entries, "day", { chainEnds: false });
    expect(groups.map((g) => g.pick.id)).toEqual(["id0", "id1"]);
    // The bucket is dropped from the output but still counted as what the kept row diffs
    // against — otherwise the 19th would compare against nothing and read as initial.
    expect(groups[1].compareTo).toBe("id2");
  });

  it("keeps the oldest bucket of a swept vault, whose chain never reaches a null parent", () => {
    // Every vault that has ever been collected looks like this: the oldest snapshot it still
    // keeps names the parent a sweep took away. Testing for a null parent here instead of
    // trusting the caller dropped that bucket forever — which is what "Group by does nothing"
    // looked like, because the fallback it triggered served a flat list instead.
    const entries = chain([at(2026, 8, 20, 9), at(2026, 8, 19, 9)]);
    entries[entries.length - 1].parent = "01COLLECTEDBYASWEEP";

    const groups = groupHistory(entries, "day", { chainEnds: true });
    expect(groups.map((g) => g.pick.id)).toEqual(["id0", "id1"]);
    // Nothing older is reachable, so the oldest bucket is an initial diff — the snapshots
    // behind it are gone, not merely unfetched.
    expect(groups[1].compareTo).toBeNull();
  });

  it("keeps the trailing bucket once the chain really ends", () => {
    const entries = chain([at(2026, 8, 20, 9), at(2026, 8, 19, 9)]);

    const groups = groupHistory(entries, "day", ENDS);
    expect(groups.map((g) => g.pick.id)).toEqual(["id0", "id1"]);
    // Nothing older exists, so the oldest bucket is an initial diff rather than an unknown one.
    expect(groups[1].compareTo).toBeNull();
  });

  it("treats a page that stopped short as having no whole bucket at all", () => {
    const entries = chain([at(2026, 8, 20, 9), at(2026, 8, 20, 8)]);
    entries[entries.length - 1].parent = "older";

    // One partial bucket and no way to complete it from this page. Returning it would show a
    // fraction of today's changes as today's changes.
    expect(groupHistory(entries, "day", { chainEnds: false })).toEqual([]);
    expect(countGroups(entries, "day", { chainEnds: false })).toBe(0);
  });

  it("keeps buckets contiguous when a device's clock is skewed", () => {
    // id1 was committed between id0 and id2 but stamped a day earlier. Sorting by time would
    // reorder the chain and diff two snapshots that are not ancestor and descendant.
    const entries = chain([at(2026, 8, 20, 9), at(2026, 8, 19, 9), at(2026, 8, 20, 7)]);

    const groups = groupHistory(entries, "day", ENDS);
    // Three buckets, because the day changed twice along the walk. Every one is a contiguous
    // run of the chain, and every compareTo is a genuine ancestor of its pick.
    expect(groups.map((g) => g.pick.id)).toEqual(["id0", "id1", "id2"]);
    expect(groups.map((g) => g.compareTo)).toEqual(["id1", "id2", null]);
  });

  it("lists the devices that committed in a bucket, newest first and deduped", () => {
    const entries = chain(
      [at(2026, 8, 20, 12), at(2026, 8, 20, 10), at(2026, 8, 20, 8)],
      [{ device: "phone" }, { device: "laptop" }, { device: "phone" }]
    );

    expect(groupHistory(entries, "day", ENDS)[0].group.devices).toEqual(["phone", "laptop"]);
  });

  it("omits a device nothing recorded rather than inventing one", () => {
    const entries = chain([at(2026, 8, 20, 12)], [{ device: null }]);
    expect(groupHistory(entries, "day", ENDS)[0].group.devices).toEqual([]);
  });

  it("has nothing to group in an empty page", () => {
    expect(groupHistory([], "day", ENDS)).toEqual([]);
    expect(groupHistory([], "week", { chainEnds: false })).toEqual([]);
  });

  it("keeps the pick's own parent untouched, so the manifest cross-check still applies", () => {
    const entries = chain([at(2026, 8, 20, 12), at(2026, 8, 20, 9), at(2026, 8, 19, 9)]);

    // The pick stands for a bucket, but it is still a snapshot whose envelope authenticates its
    // parent link. Rewriting that to mean "previous row" would put a false claim about the
    // chain into a field everything downstream treats as authenticated.
    const groups = groupHistory(entries, "day", ENDS);
    expect(groups[0].pick.parent).toBe("id1");
    expect(groups[0].compareTo).toBe("id2");
  });
});
