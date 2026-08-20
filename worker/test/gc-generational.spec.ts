import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { runGc } from "../src/gc";
import { ADMIN, BASE, authed, commit, makeManifest, mintToken, putBlob, ulid } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
/**
 * How far ahead of the real clock a sweep in this file runs. Retention age comes from R2's
 * own upload time, so a sweep timed at exactly `Date.now()` would find every object in this
 * test younger than itself and refuse to delete any of it — the in-flight commit guard doing
 * its job. The generational layout is built from indexed times relative to this same value.
 */
const MINUTE = 60 * 1000;

/**
 * A moment inside a named generation, rather than an offset from the sweep's clock.
 *
 * Which generation a snapshot falls in is epoch arithmetic, so "three days ago" and "four
 * days ago" are *usually* different days and *sometimes* the same week — and a test written
 * as an offset would assert a grouping that depends on what time of day it runs. These place
 * a snapshot in a stated bucket, so what each test is claiming is visible in the call.
 */
function inDay(now: number, daysAgo: number, seconds: number): number {
  return (Math.floor(now / DAY) - daysAgo) * DAY + seconds * 1000;
}

function inWeek(now: number, weeksAgo: number, dayOfWeek: number, seconds: number): number {
  return (Math.floor(now / WEEK) - weeksAgo) * WEEK + dayOfWeek * DAY + seconds * 1000;
}

let token: string;

beforeEach(async () => {
  ({ token } = await mintToken("generational-tester"));
});

/**
 * One snapshot per entry, committed in order, each holding exactly the blobs named.
 *
 * Every commit lands in R2 within the same millisecond, so the indexed upload time is
 * rewritten afterwards: retention buckets snapshots by *when they were uploaded*, and a test
 * that could not place them across days and weeks could only ever exercise one bucket.
 * Nothing else is faked — the manifests, the index rows and the blobs are the real ones the
 * commit path wrote.
 */
async function chain(
  snapshots: Array<{ blobs: string[]; uploadedAt: number }>
): Promise<string[]> {
  const ids: string[] = [];
  let parent: string | null = null;
  for (const [i, snapshot] of snapshots.entries()) {
    const files: Record<string, { h: string }> = {};
    for (const [j, h] of snapshot.blobs.entries()) files[`file-${j}.md`] = { h };
    const manifest = makeManifest({ id: ulid(Date.now() + i), parent, files });
    const res = await commit(token, manifest, parent);
    if (res.status !== 200) throw new Error(`commit failed: ${res.status} ${await res.text()}`);
    ids.push(manifest.id);
    parent = manifest.id;
  }
  await runInDurableObject(env.VAULT_LOCK.getByName("default"), (_instance, state) => {
    for (const [i, id] of ids.entries()) {
      state.storage.sql.exec(
        "UPDATE manifest_index SET uploaded_at = ? WHERE id = ?",
        snapshots[i].uploadedAt,
        id
      );
    }
  });
  return ids;
}

async function indexRows(): Promise<Array<{ id: string; parent: string | null }>> {
  return runInDurableObject(env.VAULT_LOCK.getByName("default"), (_instance, state) =>
    state.storage.sql
      .exec<{ id: string; parent: string | null }>(
        "SELECT id, parent FROM manifest_index ORDER BY uploaded_at"
      )
      .toArray()
  );
}

async function splices(): Promise<Array<{ survivor: string; parent: string; spliced: number }>> {
  return runInDurableObject(env.VAULT_LOCK.getByName("default"), (_instance, state) =>
    state.storage.sql
      .exec<{ survivor_id: string; splice_parent: string; spliced: number }>(
        "SELECT survivor_id, splice_parent, spliced FROM manifest_splices ORDER BY survivor_id"
      )
      .toArray()
      .map((r) => ({ survivor: r.survivor_id, parent: r.splice_parent, spliced: r.spliced }))
  );
}

async function stored(id: string): Promise<boolean> {
  return (await env.VAULT.head(`manifests/${id}.json`)) !== null;
}

async function blobExists(hash: string): Promise<boolean> {
  return (await env.VAULT.head(`blobs/${hash}`)) !== null;
}

/** The retained set as the plan itself sees it, without running a sweep. */
async function plan(opts: { keepCount: number; keepDays: number; dailyDays: number; now: number }) {
  return env.VAULT_LOCK.getByName("default").getGcPlan({
    keepCount: opts.keepCount,
    ageCutoff: opts.now - opts.keepDays * DAY,
    dailyCutoff: opts.now - opts.dailyDays * DAY,
  });
}

describe("generational selection", () => {
  it("keeps every snapshot in the dense window and the newest of each older day", async () => {
    const now = Date.now() + MINUTE;
    const blobs = await Promise.all(
      Array.from({ length: 6 }, (_, i) => putBlob(token, `content-${i}`))
    );
    // Two snapshots in each of two older days, then two inside the dense window.
    const uploads = [
      inDay(now, 3, 1),
      inDay(now, 3, 2),
      inDay(now, 2, 1),
      inDay(now, 2, 2),
      now - 2000,
      now - 1000,
    ];
    const ids = await chain(uploads.map((uploadedAt, i) => ({ blobs: [blobs[i]], uploadedAt })));

    const report = await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 30 });

    expect(report.skipped).toBeNull();
    // Both of today's (dense), plus the later snapshot of each older day.
    expect(report.retainedManifests).toBe(4);
    expect(report.thinnedManifests).toBe(2);
    expect(report.deletedManifests).toBe(2);
    expect(await stored(ids[0])).toBe(false);
    expect(await stored(ids[1])).toBe(true);
    expect(await stored(ids[2])).toBe(false);
    expect(await stored(ids[3])).toBe(true);
    expect(await stored(ids[4])).toBe(true);
    expect(await stored(ids[5])).toBe(true);
  });

  it("keeps one snapshot per week once the daily tier has passed", async () => {
    const now = Date.now() + MINUTE;
    const blobs = await Promise.all(
      Array.from({ length: 5 }, (_, i) => putBlob(token, `weekly-${i}`))
    );
    // Three in one old week, one in the week after it, one today.
    const uploads = [
      inWeek(now, 5, 1, 1),
      inWeek(now, 5, 3, 1),
      inWeek(now, 5, 5, 1),
      inWeek(now, 4, 2, 1),
      now - 1000,
    ];
    const ids = await chain(uploads.map((uploadedAt, i) => ({ blobs: [blobs[i]], uploadedAt })));

    const report = await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 14 });

    expect(report.skipped).toBeNull();
    expect(await stored(ids[4])).toBe(true);
    expect(await stored(ids[3])).toBe(true);
    // Only the newest of the crowded week survives it.
    expect(await stored(ids[2])).toBe(true);
    expect(await stored(ids[1])).toBe(false);
    expect(await stored(ids[0])).toBe(false);
  });

  it("settles: a second sweep with the same window changes nothing", async () => {
    const now = Date.now() + MINUTE;
    const blobs = await Promise.all(
      Array.from({ length: 5 }, (_, i) => putBlob(token, `settle-${i}`))
    );
    const uploads = [
      inDay(now, 5, 1),
      inDay(now, 5, 2),
      inDay(now, 5, 3),
      inDay(now, 4, 1),
      now - 1000,
    ];
    await chain(uploads.map((uploadedAt, i) => ({ blobs: [blobs[i]], uploadedAt })));

    const first = await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 30 });
    expect(first.deletedManifests).toBe(2);
    const retainedAfterFirst = first.retainedManifests;

    const second = await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 30 });
    expect(second.retainedManifests).toBe(retainedAfterFirst);
    expect(second.thinnedManifests).toBe(0);
    expect(second.deletedManifests).toBe(0);
    expect(second.splicesApplied).toBe(0);
  });

  it("collects blobs only the thinned snapshots held, and keeps shared ones", async () => {
    const now = Date.now() + MINUTE;
    const shared = await putBlob(token, "shared-content");
    const onlyThinned = await putBlob(token, "only-in-the-middle");
    const newest = await putBlob(token, "newest-content");
    await chain([
      { blobs: [shared], uploadedAt: inWeek(now, 2, 1, 1) },
      { blobs: [shared, onlyThinned], uploadedAt: inWeek(now, 2, 1, 2) },
      { blobs: [shared], uploadedAt: inWeek(now, 2, 4, 1) },
      { blobs: [shared, newest], uploadedAt: now - 1000 },
    ]);

    // Daily tier: the second snapshot is the newest of its day, so the first is thinned. Its
    // blob is shared, and must survive on the strength of the snapshots that remain.
    const report = await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 30 });
    expect(report.deletedManifests).toBe(1);
    expect(await blobExists(shared)).toBe(true);
    expect(await blobExists(onlyThinned)).toBe(true);

    // Weekly tier: those two days collapse into one week, and the later day wins it. The
    // snapshot holding `onlyThinned` is the one that goes.
    const second = await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 1 });
    expect(second.deletedManifests).toBe(1);
    // Held by nothing that survives, so it goes; the shared blob stays because the head has it.
    expect(await blobExists(onlyThinned)).toBe(false);
    expect(await blobExists(shared)).toBe(true);
    expect(await blobExists(newest)).toBe(true);
  });
});

describe("splices", () => {
  it("redirects the survivor's link and records how many commits it skips", async () => {
    const now = Date.now() + MINUTE;
    const blobs = await Promise.all(
      Array.from({ length: 4 }, (_, i) => putBlob(token, `splice-${i}`))
    );
    const ids = await chain([
      { blobs: [blobs[0]], uploadedAt: now - 6 * DAY - 3000 },
      { blobs: [blobs[1]], uploadedAt: now - 5 * DAY - 2000 },
      { blobs: [blobs[2]], uploadedAt: now - 5 * DAY - 1000 },
      { blobs: [blobs[3]], uploadedAt: now - 1000 },
    ]);

    const report = await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 30 });
    expect(report.splicesApplied).toBe(1);

    // ids[1] was the older half of a shared day; the head now reaches ids[2] and ids[2]
    // reaches ids[0] across it.
    expect(await splices()).toEqual([{ survivor: ids[2], parent: ids[0], spliced: 1 }]);
    expect((await indexRows()).map((r) => r.id)).toEqual([ids[0], ids[2], ids[3]]);
    // The manifest's own parent link is untouched: it is what a client authenticates.
    const manifest = (await (await env.VAULT.get(`manifests/${ids[2]}.json`))!.json()) as {
      parent: string;
    };
    expect(manifest.parent).toBe(ids[1]);
  });

  it("accumulates the count when a spliced link is spliced again", async () => {
    const now = Date.now() + MINUTE;
    const blobs = await Promise.all(
      Array.from({ length: 5 }, (_, i) => putBlob(token, `respliced-${i}`))
    );
    const ids = await chain([
      { blobs: [blobs[0]], uploadedAt: inWeek(now, 4, 1, 1) },
      { blobs: [blobs[1]], uploadedAt: inWeek(now, 2, 1, 1) },
      { blobs: [blobs[2]], uploadedAt: inWeek(now, 2, 1, 2) },
      { blobs: [blobs[3]], uploadedAt: inWeek(now, 2, 4, 1) },
      { blobs: [blobs[4]], uploadedAt: now - 1000 },
    ]);

    // Day tier: the older of the shared day goes, so ids[2] skips ids[1].
    await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 30 });
    expect(await splices()).toEqual([{ survivor: ids[2], parent: ids[0], spliced: 1 }]);

    // Weekly tier: ids[2] and ids[3] are now in one week, so ids[2] goes and ids[3] takes
    // over the link — inheriting the commit ids[2] was already hiding, plus ids[2] itself.
    await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 1 });
    expect(await splices()).toEqual([{ survivor: ids[3], parent: ids[0], spliced: 2 }]);
    expect(await stored(ids[2])).toBe(false);
  });

  it("keeps the retained union exact across a splice", async () => {
    const now = Date.now() + MINUTE;
    const [a, b, c, d] = await Promise.all(
      ["union-a", "union-b", "union-c", "union-d"].map((s) => putBlob(token, s))
    );
    const ids = await chain([
      { blobs: [a], uploadedAt: inDay(now, 6, 1) },
      { blobs: [a, b], uploadedAt: inDay(now, 5, 1) },
      { blobs: [a, c], uploadedAt: inDay(now, 5, 2) },
      { blobs: [a, d], uploadedAt: now - 1000 },
    ]);
    await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 30 });

    // ids[1] is gone. What survives holds a, c and d — and the plan, walking the spliced
    // link with its recomposed delta, must say exactly that and not one hash more.
    const after = await plan({ keepCount: 1, keepDays: 1, dailyDays: 30, now });
    expect(after.retainedIds.sort()).toEqual([ids[0], ids[2], ids[3]].sort());
    expect([...after.liveHashes].sort()).toEqual([a, c, d].sort());
    expect(await blobExists(b)).toBe(false);
  });

  it("rebuilds the index across a gap after a reset, instead of dropping the history", async () => {
    const now = Date.now() + MINUTE;
    const blobs = await Promise.all(
      Array.from({ length: 4 }, (_, i) => putBlob(token, `rebuild-${i}`))
    );
    const ids = await chain([
      { blobs: [blobs[0]], uploadedAt: inDay(now, 6, 1) },
      { blobs: [blobs[1]], uploadedAt: inDay(now, 5, 1) },
      { blobs: [blobs[2]], uploadedAt: inDay(now, 5, 2) },
      { blobs: [blobs[3]], uploadedAt: now - 1000 },
    ]);
    await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 30 });

    // Wipe the disposable index the way divergence recovery would, leaving only the splice
    // record and the manifests themselves.
    await runInDurableObject(env.VAULT_LOCK.getByName("default"), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM manifest_blob_deltas");
      state.storage.sql.exec("DELETE FROM manifest_index");
      state.storage.sql.exec("DELETE FROM current_blob_refs");
      state.storage.sql.exec("UPDATE meta SET value = '' WHERE key = 'gc_index_backfilled'");
      state.storage.sql.exec("UPDATE meta SET value = '' WHERE key = 'gc_index_cursor'");
    });

    // The rebuild must walk the spliced link to reach ids[0]; a rebuild that stopped at the
    // gap would leave it unindexed, and this sweep would delete it as unreferenced.
    let report = await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 30 });
    while (report.skipped === "index_backfilling") {
      report = await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 30 });
    }
    expect(report.skipped).toBeNull();
    expect(report.deletedManifests).toBe(0);
    expect(await stored(ids[0])).toBe(true);
    expect(await stored(ids[2])).toBe(true);
    expect(await stored(ids[3])).toBe(true);
    expect([...(await indexRows())].map((r) => r.id)).toEqual([ids[0], ids[2], ids[3]]);
  });

  it("refuses to rebuild when a spliced-to snapshot is missing from R2", async () => {
    const now = Date.now() + MINUTE;
    const blobs = await Promise.all(
      Array.from({ length: 4 }, (_, i) => putBlob(token, `missing-${i}`))
    );
    const ids = await chain([
      { blobs: [blobs[0]], uploadedAt: inDay(now, 6, 1) },
      { blobs: [blobs[1]], uploadedAt: inDay(now, 5, 1) },
      { blobs: [blobs[2]], uploadedAt: inDay(now, 5, 2) },
      { blobs: [blobs[3]], uploadedAt: now - 1000 },
    ]);
    await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 30 });

    await runInDurableObject(env.VAULT_LOCK.getByName("default"), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM manifest_blob_deltas");
      state.storage.sql.exec("DELETE FROM manifest_index");
      state.storage.sql.exec("DELETE FROM current_blob_refs");
      state.storage.sql.exec("UPDATE meta SET value = '' WHERE key = 'gc_index_backfilled'");
      state.storage.sql.exec("UPDATE meta SET value = '' WHERE key = 'gc_index_cursor'");
    });
    // Storage loses the snapshot the splice names. Finishing the walk here would quietly
    // shorten history and hand the next sweep a licence to delete the rest of it.
    await env.VAULT.delete(`manifests/${ids[0]}.json`);

    await expect(
      runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 30 })
    ).rejects.toThrow(/splice parent .* is missing from R2/);
    expect(await stored(ids[2])).toBe(true);
    expect(await stored(ids[3])).toBe(true);
  });
});

describe("history listing across collected commits", () => {
  it("serves the spliced chain to a client that asks, and stops short for one that does not", async () => {
    const now = Date.now() + MINUTE;
    const blobs = await Promise.all(
      Array.from({ length: 4 }, (_, i) => putBlob(token, `history-${i}`))
    );
    const ids = await chain([
      { blobs: [blobs[0]], uploadedAt: inDay(now, 6, 1) },
      { blobs: [blobs[1]], uploadedAt: inDay(now, 5, 1) },
      { blobs: [blobs[2]], uploadedAt: inDay(now, 5, 2) },
      { blobs: [blobs[3]], uploadedAt: now - 1000 },
    ]);
    await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 30 });

    const aware = await (
      await SELF.fetch(`${BASE}/api/history?limit=50&splices=1`, authed(token))
    ).json();
    expect(aware).toEqual({
      complete: true,
      entries: [
        expect.objectContaining({ id: ids[3], parent: ids[2], spliceParent: null, pruned: null }),
        expect.objectContaining({ id: ids[2], parent: ids[1], spliceParent: ids[0], pruned: 1 }),
        expect.objectContaining({ id: ids[0], parent: null, spliceParent: null, pruned: null }),
      ],
    });

    // An older client reads `parent` as "the next row", so it is given the chain up to the
    // gap and told the listing is short — which sends it to walk the manifests itself.
    const plain = (await (
      await SELF.fetch(`${BASE}/api/history?limit=50`, authed(token))
    ).json()) as { entries: Array<{ id: string }>; complete: boolean };
    expect(plain.complete).toBe(false);
    expect(plain.entries.map((e) => e.id)).toEqual([ids[3], ids[2]]);
  });

  it("fills in device and date on rows beyond a gap", async () => {
    const now = Date.now() + MINUTE;
    const blobs = await Promise.all(
      Array.from({ length: 4 }, (_, i) => putBlob(token, `detail-${i}`))
    );
    const ids = await chain([
      { blobs: [blobs[0]], uploadedAt: inDay(now, 6, 1) },
      { blobs: [blobs[1]], uploadedAt: inDay(now, 5, 1) },
      { blobs: [blobs[2]], uploadedAt: inDay(now, 5, 2) },
      { blobs: [blobs[3]], uploadedAt: now - 1000 },
    ]);
    await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 30 });

    // A row indexed before the clear-envelope columns existed, on the far side of the gap.
    await runInDurableObject(env.VAULT_LOCK.getByName("default"), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE manifest_index SET device = NULL, created_at = NULL WHERE id = ?",
        ids[0]
      );
    });

    const res = await SELF.fetch(
      `${BASE}/api/history/index?manifests=50`,
      authed(ADMIN, { method: "POST" })
    );
    expect(res.status).toBe(200);
    const page = (await (
      await SELF.fetch(`${BASE}/api/history?limit=50&splices=1`, authed(token))
    ).json()) as { entries: Array<{ id: string; device: string | null }> };
    expect(page.entries.find((e) => e.id === ids[0])?.device).toBe("test-token");
  });
});

describe("bounded and fenced", () => {
  it("thins in bounded steps across runs rather than all at once", async () => {
    const now = Date.now() + MINUTE;
    // Two snapshots a day for 25 days: 25 stretches to thin, past the per-run bound.
    const days = 25;
    const blobs = await Promise.all(
      Array.from({ length: days * 2 }, (_, i) => putBlob(token, `bounded-${i}`))
    );
    const snapshots = [];
    for (let d = days; d > 0; d--) {
      snapshots.push({ blobs: [blobs[snapshots.length]], uploadedAt: inDay(now, d, 1) });
      snapshots.push({ blobs: [blobs[snapshots.length]], uploadedAt: inDay(now, d, 2) });
    }
    await chain(snapshots);

    const first = await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 60 });
    // Bounded, so one sweep does not reach the settled set — and says so in its own numbers
    // rather than quietly stopping early.
    expect(first.splicesApplied).toBe(20);
    expect(first.deletedManifests).toBe(20);

    let report = first;
    for (let i = 0; i < 5 && report.deletedManifests > 0; i++) {
      report = await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 60 });
    }
    // Settled: one per day, and nothing left to do.
    expect(report.deletedManifests).toBe(0);
    expect(report.splicesApplied).toBe(0);
    expect(report.retainedManifests).toBe(days);
  });

  it("keeps committing normally once history has been thinned", async () => {
    const now = Date.now() + MINUTE;
    const blobs = await Promise.all(
      Array.from({ length: 4 }, (_, i) => putBlob(token, `after-${i}`))
    );
    const ids = await chain([
      { blobs: [blobs[0]], uploadedAt: inDay(now, 6, 1) },
      { blobs: [blobs[1]], uploadedAt: inDay(now, 5, 1) },
      { blobs: [blobs[2]], uploadedAt: inDay(now, 5, 2) },
      { blobs: [blobs[3]], uploadedAt: now - 1000 },
    ]);
    await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 30 });

    // A device syncing after the sweep parents onto the head as usual; nothing about the
    // gap further back is its concern, and the commit path must not notice one. Its blob is
    // uploaded now rather than earlier because these sweeps run with the in-flight guard
    // disabled, and an unreferenced blob is exactly what that guard protects.
    const fresh = await putBlob(token, "after-the-sweep");
    const next = makeManifest({ parent: ids[3], files: { "next.md": { h: fresh } } });
    const committed = await commit(token, next, ids[3]);
    expect(committed.status, await committed.clone().text()).toBe(200);

    const page = (await (
      await SELF.fetch(`${BASE}/api/history?limit=50&splices=1`, authed(token))
    ).json()) as { entries: Array<{ id: string }>; complete: boolean };
    expect(page.complete).toBe(true);
    expect(page.entries.map((e) => e.id)).toEqual([next.id, ids[3], ids[2], ids[0]]);

    // And the next sweep still derives the same retained set, now including the new head.
    const report = await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 30 });
    expect(report.skipped).toBeNull();
    expect(report.deletedManifests).toBe(0);
    expect(await blobExists(fresh)).toBe(true);
    expect(await blobExists(blobs[0])).toBe(true);
  });

  it("applies no splice when the head moved after the plan was built", async () => {
    const now = Date.now() + MINUTE;
    const blobs = await Promise.all(
      Array.from({ length: 5 }, (_, i) => putBlob(token, `moved-${i}`))
    );
    const ids = await chain([
      { blobs: [blobs[0]], uploadedAt: inDay(now, 6, 1) },
      { blobs: [blobs[1]], uploadedAt: inDay(now, 5, 1) },
      { blobs: [blobs[2]], uploadedAt: inDay(now, 5, 2) },
      { blobs: [blobs[3]], uploadedAt: now - 1000 },
    ]);

    const report = await runGc(env, {
      now,
      minAgeMs: 0,
      keepCount: 1,
      keepDays: 1,
      dailyDays: 30,
      testHookBeforeLease: async () => {
        const next = makeManifest({
          parent: ids[3],
          files: { "late.md": { h: blobs[4] } },
        });
        const res = await commit(token, next, ids[3]);
        if (res.status !== 200) throw new Error(`late commit failed: ${res.status}`);
      },
    });

    expect(report.skipped).toBe("head_moved");
    expect(report.splicesApplied).toBe(0);
    expect(await splices()).toEqual([]);
    // Nothing was deleted either, so the plan this run built is simply discarded.
    expect(await stored(ids[1])).toBe(true);
  });

  it("refuses to redirect a link without the lease that fenced the plan", async () => {
    const now = Date.now() + MINUTE;
    const blobs = await Promise.all(
      Array.from({ length: 2 }, (_, i) => putBlob(token, `fenced-${i}`))
    );
    const ids = await chain([
      { blobs: [blobs[0]], uploadedAt: inDay(now, 5, 1) },
      { blobs: [blobs[1]], uploadedAt: now - 1000 },
    ]);

    const applied = await env.VAULT_LOCK.getByName("default").applyGcSplices(
      "not-the-lease-this-run-holds",
      ids[1],
      [{ survivor: ids[1], spliceParent: ids[0], spliced: 1, added: [], removed: [] }]
    );
    expect(applied).toBe(false);
    expect(await splices()).toEqual([]);
  });
});

describe("pruning the oldest retained snapshot", () => {
  /**
   * The tail case, which is the one place a splice has no replacement.
   *
   * Mid-chain, thinning a snapshot re-points whoever reached it at the next survivor in the
   * same plan. At the end of the chain there is no next survivor, so the plan drops the run
   * and the link simply ends — and any splice still naming the dropped snapshot has to end
   * with it. A left-behind one is invisible until an index rebuild tries to follow it, and
   * then GC refuses to run at all, for good.
   */
  async function danglingSetup(now: number): Promise<string[]> {
    const blobs = await Promise.all(
      Array.from({ length: 4 }, (_, i) => putBlob(token, `tail-${i}`))
    );
    const ids = await chain([
      // The root, alone in its day but sharing a week with the snapshot below it.
      { blobs: [blobs[0]], uploadedAt: inWeek(now, 2, 1, 1) },
      { blobs: [blobs[1]], uploadedAt: inWeek(now, 2, 5, 1) },
      { blobs: [blobs[2]], uploadedAt: inWeek(now, 2, 5, 2) },
      { blobs: [blobs[3]], uploadedAt: now - 1000 },
    ]);

    // Daily tier: the older of the shared day goes, so ids[2] is spliced onto the root.
    await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 30 });
    expect(await splices()).toEqual([{ survivor: ids[2], parent: ids[0], spliced: 1 }]);

    // Weekly tier: ids[2] claims the week, so the root is thinned — at the end of the chain,
    // with nothing older to splice onto.
    await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 1 });
    expect(await stored(ids[0])).toBe(false);
    return ids;
  }

  it("does not leave a splice naming the snapshot it just collected", async () => {
    const now = Date.now() + MINUTE;
    await danglingSetup(now);
    expect(await splices()).toEqual([]);
  });

  it("can still rebuild its index afterwards", async () => {
    const now = Date.now() + MINUTE;
    const ids = await danglingSetup(now);

    await runInDurableObject(env.VAULT_LOCK.getByName("default"), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM manifest_blob_deltas");
      state.storage.sql.exec("DELETE FROM manifest_index");
      state.storage.sql.exec("DELETE FROM current_blob_refs");
      state.storage.sql.exec("UPDATE meta SET value = '' WHERE key = 'gc_index_backfilled'");
      state.storage.sql.exec("UPDATE meta SET value = '' WHERE key = 'gc_index_cursor'");
    });

    // The oldest retained snapshot now has a parent link into collected history and no splice,
    // which is the ordinary trimmed tail this walk has always ended at.
    let report = await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 1 });
    while (report.skipped === "index_backfilling") {
      report = await runGc(env, { now, minAgeMs: 0, keepCount: 1, keepDays: 1, dailyDays: 1 });
    }
    expect(report.skipped).toBeNull();
    expect(report.deletedManifests).toBe(0);
    expect((await indexRows()).map((r) => r.id)).toEqual([ids[2], ids[3]]);
  });
});
