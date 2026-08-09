import { describe, it, expect } from "vitest";
import { createUlidFactory } from "../src/ulid";

describe("ulid", () => {
  it("produces 26-char Crockford base32 matching the server regex", () => {
    const ulid = createUlidFactory(() => 1_754_000_000_000);
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("is monotonic within the same millisecond", () => {
    const ulid = createUlidFactory(() => 1_754_000_000_000);
    const ids = Array.from({ length: 50 }, () => ulid());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sorts later timestamps after earlier ones", () => {
    let now = 1_754_000_000_000;
    const ulid = createUlidFactory(() => now);
    const first = ulid();
    now += 5_000;
    const second = ulid();
    expect(second > first).toBe(true);
  });
});
