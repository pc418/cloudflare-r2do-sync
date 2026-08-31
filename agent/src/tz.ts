/**
 * The vault's timezone: one IANA zone name, and the arithmetic that needs it.
 *
 * Everything a model reads out of this agent is a date — a `list` row, a `recent` stamp, the
 * boundary a range means — and a date without a clock behind it is a guess. The zone is
 * deploy-time configuration (`AGENT_TZ`), read from the owner's own machine at deploy, because
 * the agent runs on a colo that has no idea where the vault lives.
 *
 * **A zone name, never a fixed offset.** `Intl` applies the right offset per instant, so
 * PST/PDT is automatic and no code here knows a transition rule.
 *
 * **Fails soft to UTC.** This is display preference, not policy: an unknown name degrades to
 * today's behaviour rather than taking the connector down. The deploy is where a typo is
 * refused, while a human is still watching.
 */

export const UTC = "UTC";

/** Civil (wall-clock) fields in some zone. Months are 1-based, the way the strings read. */
export interface Civil {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * A validated zone name, or `UTC`.
 *
 * `Intl.DateTimeFormat` throws `RangeError` on a name its data does not carry, which is the
 * only check worth making — there is no list to compare against that would not go stale.
 */
export function resolveZone(name: string | undefined | null): string {
  const zone = (name ?? "").trim();
  if (zone === "") return UTC;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
  } catch {
    return UTC;
  }
  return zone;
}

/**
 * One formatter per zone, for the life of the isolate.
 *
 * Construction is the expensive part of `Intl`, and every tool call formats at least one date.
 * The map is bounded by the number of zones in play, which is one.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(zone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      // `hour12: false` is the one that yields "24" at midnight in some engines.
      hourCycle: "h23",
    });
    FORMATTERS.set(zone, f);
  }
  return f;
}

/** What the wall clock in `zone` reads at `at`. */
export function civilIn(zone: string, at: number): Civil {
  const parts = formatter(zone).formatToParts(at);
  const field = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  return {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    hour: field("hour"),
    minute: field("minute"),
    second: field("second"),
  };
}

/**
 * The zone's offset from UTC at a given instant, in milliseconds.
 *
 * Derived from the civil fields rather than parsed out of a `timeZoneName: "longOffset"`
 * string: the parts are needed for rendering anyway, so this is one formatter and no locale
 * string to parse.
 */
function offsetAt(zone: string, at: number): number {
  const c = civilIn(zone, at);
  const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  // `at` may carry milliseconds the civil fields do not; drop them from both sides.
  return asUtc - Math.floor(at / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `zone` reads the given civil time.
 *
 * JS has no such primitive, so: guess by reading the civil time as UTC and subtracting the
 * offset in force there, then correct once. **Two lookups converge**, because the second uses
 * the offset actually in force at the guessed instant — which is what a DST edge changes.
 *
 * A civil time a spring-forward skipped does not exist. The second pass then lands on the
 * instant just after the jump, which keeps the mapping monotonic; no caller here can tell.
 */
export function instantOf(zone: string, civil: Partial<Civil> & { year: number; month: number; day: number }): number {
  const naive = Date.UTC(
    civil.year,
    civil.month - 1,
    civil.day,
    civil.hour ?? 0,
    civil.minute ?? 0,
    civil.second ?? 0
  );
  const first = naive - offsetAt(zone, naive);
  return naive - offsetAt(zone, first);
}

/** Midnight starting the given calendar day in `zone`. */
export function localMidnight(zone: string, year: number, month: number, day: number): number {
  return instantOf(zone, { year, month, day });
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** `2026-08-31`, in `zone`. */
export function formatDay(zone: string, at: number): string {
  const c = civilIn(zone, at);
  return `${pad(c.year, 4)}-${pad(c.month)}-${pad(c.day)}`;
}

/** `2026-08-31 14:05`, in `zone`. */
export function formatMinute(zone: string, at: number): string {
  const c = civilIn(zone, at);
  return `${formatDay(zone, at)} ${pad(c.hour)}:${pad(c.minute)}`;
}

/** Which day of the week a calendar date falls on, Sunday 0 — a property of the date alone. */
export function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** The calendar date `back` days before the given one. Civil arithmetic, no zone involved. */
export function daysBefore(
  year: number,
  month: number,
  day: number,
  back: number
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day) - back * 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
