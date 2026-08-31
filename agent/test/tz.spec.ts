import { describe, it, expect } from "vitest";
import {
  civilIn,
  daysBefore,
  formatDay,
  formatMinute,
  instantOf,
  localMidnight,
  resolveZone,
  weekdayOf,
} from "../src/tz";

/**
 * 2026's US transitions: DST begins Sunday 8 March, ends Sunday 1 November — both at 02:00
 * local. Every zone assertion below is anchored on one of those, because a zone that is only
 * ever exercised mid-season is indistinguishable from a fixed offset.
 */
const LA = "America/Los_Angeles";
const at = (iso: string) => Date.parse(iso);

describe("resolveZone", () => {
  it("fails soft to UTC rather than taking the connector down", () => {
    expect(resolveZone(undefined)).toBe("UTC");
    expect(resolveZone("")).toBe("UTC");
    expect(resolveZone("   ")).toBe("UTC");
    // A typo reaches here only if the deploy's own check was bypassed; UTC is today's behaviour.
    expect(resolveZone("America/Atlantis")).toBe("UTC");
    expect(resolveZone("GMT+7")).toBe("UTC");
  });

  it("accepts an IANA name, trimmed", () => {
    expect(resolveZone(LA)).toBe(LA);
    expect(resolveZone(`  ${LA}  `)).toBe(LA);
    expect(resolveZone("Asia/Tokyo")).toBe("Asia/Tokyo");
  });
});

describe("local midnight", () => {
  // The zone name, not an offset, is what makes these two lines differ by an hour.
  it("follows the offset in force on that day", () => {
    expect(localMidnight(LA, 2026, 3, 7)).toBe(at("2026-03-07T08:00:00Z")); // PST, UTC-8
    expect(localMidnight(LA, 2026, 3, 9)).toBe(at("2026-03-09T07:00:00Z")); // PDT, UTC-7
  });

  it("is right on the transition days themselves, where the offset changes at 02:00", () => {
    // Midnight on the spring-forward day is still PST — the jump is two hours later.
    expect(localMidnight(LA, 2026, 3, 8)).toBe(at("2026-03-08T08:00:00Z"));
    // And midnight on the fall-back day is still PDT.
    expect(localMidnight(LA, 2026, 11, 1)).toBe(at("2026-11-01T07:00:00Z"));
    expect(localMidnight(LA, 2026, 11, 2)).toBe(at("2026-11-02T08:00:00Z"));
  });

  it("keeps consecutive days tiling across a transition, 23h and 25h long", () => {
    const spring = localMidnight(LA, 2026, 3, 9) - localMidnight(LA, 2026, 3, 8);
    const fall = localMidnight(LA, 2026, 11, 2) - localMidnight(LA, 2026, 11, 1);
    expect(spring).toBe(23 * 3_600_000);
    expect(fall).toBe(25 * 3_600_000);
  });

  it("resolves a naive datetime in the zone, and UTC when the zone is UTC", () => {
    expect(instantOf(LA, { year: 2026, month: 8, day: 1, hour: 12 })).toBe(at("2026-08-01T19:00:00Z"));
    expect(instantOf("UTC", { year: 2026, month: 8, day: 1, hour: 12 })).toBe(at("2026-08-01T12:00:00Z"));
  });
});

describe("rendering", () => {
  it("shows the day the wall clock was on, which is not always the UTC one", () => {
    // 05:00 UTC on the 31st is 22:00 on the 30th in California.
    expect(formatDay(LA, at("2026-08-31T05:00:00Z"))).toBe("2026-08-30");
    expect(formatDay("UTC", at("2026-08-31T05:00:00Z"))).toBe("2026-08-31");
    expect(formatMinute(LA, at("2026-08-31T05:07:00Z"))).toBe("2026-08-30 22:07");
    expect(formatMinute("Asia/Tokyo", at("2026-08-31T05:07:00Z"))).toBe("2026-08-31 14:07");
  });

  // `hour12: false` reads midnight as "24" in some engines, which would render tomorrow's
  // date beside hour 24 and look like a bug in the clock rather than in the formatter.
  it("renders midnight as 00, not 24", () => {
    expect(formatMinute("UTC", at("2026-08-31T00:00:00Z"))).toBe("2026-08-31 00:00");
    expect(civilIn("UTC", at("2026-08-31T00:30:00Z")).hour).toBe(0);
  });
});

describe("calendar arithmetic", () => {
  it("steps by days without touching a clock", () => {
    // 8 March is the 23-hour day; stepping by dates cannot land an hour out.
    expect(daysBefore(2026, 3, 9, 2)).toEqual({ year: 2026, month: 3, day: 7 });
    expect(daysBefore(2026, 1, 1, 1)).toEqual({ year: 2025, month: 12, day: 31 });
  });

  it("knows the weekday of a date", () => {
    expect(weekdayOf(2026, 8, 31)).toBe(1); // Monday
    expect(weekdayOf(2026, 3, 8)).toBe(0); // Sunday, the spring-forward day
  });
});
