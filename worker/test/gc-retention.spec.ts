import { SELF, env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { gcRetention, runGc } from "../src/gc";
import type { Manifest } from "../src/manifest";
import { ADMIN, BASE, authed, commit, mintToken, sha256hex, ulid } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

let token: string;
const deployed = {
  days: env.GC_KEEP_DAYS,
  count: env.GC_KEEP_COUNT,
  daily: env.GC_DAILY_DAYS,
};

beforeEach(async () => {
  ({ token } = await mintToken("retention-tester"));
});

afterEach(() => {
  // These bindings are shared with the worker `SELF` runs, so a test that rewrites them has
  // to put the deployed values back or it silently reconfigures every test after it.
  env.GC_KEEP_DAYS = deployed.days;
  env.GC_KEEP_COUNT = deployed.count;
  env.GC_DAILY_DAYS = deployed.daily;
});

async function seedBlob(content: string): Promise<string> {
  const h = await sha256hex(content);
  await env.VAULT.put(`blobs/${h}`, content);
  return h;
}

function manifest(id: string, parent: string | null, createdAt: number, hash: string): Manifest {
  return {
    v: 1,
    id,
    parent,
    device: "retention-test",
    createdAt: new Date(createdAt).toISOString(),
    files: { "note.md": { h: hash, size: 1, mtime: createdAt } },
  };
}

/**
 * A two-snapshot chain whose older half is collectable only under a narrow window.
 *
 * Retention age comes from R2's upload time, never from a manifest's own `createdAt`, so the
 * sweeps below run at a logical `NOW` well past the moment these objects were written.
 */
async function twoSnapshots(): Promise<{ old: string; head: string }> {
  const oldHash = await seedBlob("old");
  const newHash = await seedBlob("new");
  const t = Date.now();
  const old = manifest(ulid(t - 1000), null, t - 1000, oldHash);
  const head = manifest(ulid(t), old.id, t, newHash);
  for (const [m, parent] of [
    [old, null],
    [head, old.id],
  ] as const) {
    const res = await commit(token, m, parent);
    if (res.status !== 200) throw new Error(`commit failed: ${res.status} ${await res.text()}`);
  }
  return { old: old.id, head: head.id };
}

describe("gcRetention", () => {
  it("reads the deployed window rather than a compiled-in default", () => {
    expect(
      gcRetention({ GC_KEEP_DAYS: "7", GC_KEEP_COUNT: "3", GC_DAILY_DAYS: "30" })
    ).toEqual({ keepDays: 7, keepCount: 3, dailyDays: 30 });
    // What this deployment actually ships, so a change to wrangler.jsonc is a visible edit here.
    expect(gcRetention(env)).toEqual({ keepDays: 14, keepCount: 100, dailyDays: 90 });
  });

  it("refuses a missing or nonsensical window instead of guessing one", () => {
    for (const bad of ["", "   ", "0", "-1", "1.5", "thirty", "1e3"]) {
      expect(() =>
        gcRetention({ GC_KEEP_DAYS: bad, GC_KEEP_COUNT: "50", GC_DAILY_DAYS: "90" })
      ).toThrow(/GC_KEEP_DAYS/);
      expect(() =>
        gcRetention({ GC_KEEP_DAYS: "30", GC_KEEP_COUNT: "50", GC_DAILY_DAYS: bad })
      ).toThrow(/GC_DAILY_DAYS/);
    }
    expect(() =>
      gcRetention({ GC_KEEP_DAYS: "3651", GC_KEEP_COUNT: "50", GC_DAILY_DAYS: "3651" })
    ).toThrow(/1 to 3650/);
    expect(() =>
      gcRetention({ GC_KEEP_COUNT: "10001", GC_KEEP_DAYS: "30", GC_DAILY_DAYS: "90" })
    ).toThrow(/1 to 10000/);
    expect(() =>
      gcRetention({
        GC_KEEP_DAYS: undefined as unknown as string,
        GC_KEEP_COUNT: "50",
        GC_DAILY_DAYS: "90",
      })
    ).toThrow(/GC_KEEP_DAYS is not configured/);
    expect(() =>
      gcRetention({
        GC_KEEP_DAYS: "30",
        GC_KEEP_COUNT: "50",
        GC_DAILY_DAYS: undefined as unknown as string,
      })
    ).toThrow(/GC_DAILY_DAYS is not configured/);
  });

  it("refuses a daily tier that ends before the dense window it follows", () => {
    expect(() =>
      gcRetention({ GC_KEEP_DAYS: "30", GC_KEEP_COUNT: "50", GC_DAILY_DAYS: "29" })
    ).toThrow(/GC_DAILY_DAYS \(29\) must be at least GC_KEEP_DAYS \(30\)/);
    // Equal is a deployment with no daily tier at all — weekly straight after the dense
    // window — which is a choice, not a mistake.
    expect(
      gcRetention({ GC_KEEP_DAYS: "30", GC_KEEP_COUNT: "50", GC_DAILY_DAYS: "30" })
    ).toEqual({ keepDays: 30, keepCount: 50, dailyDays: 30 });
  });
});

describe("runGc retention configuration", () => {
  it("applies the deployed window with no options at all", async () => {
    const now = Date.now() + 10 * DAY;
    const { old } = await twoSnapshots();

    // 90/500 as deployed: a ten-day-old snapshot is well inside the window.
    const kept = await runGc(env, { now, minAgeMs: 0 });
    expect(kept.skipped).toBeNull();
    expect(kept.retention).toEqual({ keepDays: 14, keepCount: 100, dailyDays: 90 });
    expect(kept.deletedManifests).toBe(0);
    expect(await env.VAULT.head(`manifests/${old}.json`)).not.toBeNull();

    // Narrow the deployment's own configuration and the same sweep collects it.
    env.GC_KEEP_DAYS = "1";
    env.GC_KEEP_COUNT = "1";
    const swept = await runGc(env, { now, minAgeMs: 0 });
    expect(swept.retention).toEqual({ keepDays: 1, keepCount: 1, dailyDays: 90 });
    expect(swept.deletedManifests).toBe(1);
    expect(await env.VAULT.head(`manifests/${old}.json`)).toBeNull();
  });

  it("stops before planning when the window is unusable", async () => {
    const now = Date.now() + 10 * DAY;
    const { old } = await twoSnapshots();
    env.GC_KEEP_DAYS = "0";

    await expect(runGc(env, { now, minAgeMs: 0 })).rejects.toThrow(/GC_KEEP_DAYS must be/);
    // Nothing was deleted on the way to that error, and no lease was left held.
    expect(await env.VAULT.head(`manifests/${old}.json`)).not.toBeNull();
    env.GC_KEEP_DAYS = deployed.days;
    expect((await runGc(env, { now, minAgeMs: 0 })).skipped).toBeNull();
  });

  it("an explicit option still overrides the deployed window", async () => {
    const now = Date.now() + 10 * DAY;
    await twoSnapshots();
    const report = await runGc(env, { now, minAgeMs: 0, keepDays: 1, keepCount: 1 });
    expect(report.retention).toEqual({ keepDays: 1, keepCount: 1, dailyDays: 90 });
    expect(report.deletedManifests).toBe(1);
  });
});

describe("POST /api/gc", () => {
  it("names a misconfigured window rather than failing as a Worker fault", async () => {
    env.GC_KEEP_COUNT = "nope";
    const res = await SELF.fetch(`${BASE}/api/gc`, authed(ADMIN, { method: "POST" }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("gc_misconfigured");
    expect(body.error.message).toMatch(/GC_KEEP_COUNT must be an integer/);
  });

  it("reports the window it applied", async () => {
    await twoSnapshots();
    const res = await SELF.fetch(`${BASE}/api/gc`, authed(ADMIN, { method: "POST" }));
    expect(res.status).toBe(200);
    const report = (await res.json()) as {
      retention: { keepDays: number; keepCount: number; dailyDays: number };
    };
    expect(report.retention).toEqual({ keepDays: 14, keepCount: 100, dailyDays: 90 });
  });
});
