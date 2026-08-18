import type { SyncResult } from "./sync";

/**
 * What a sync-status notice is *about*. Categories are the mechanism, not the setting: the
 * user picks a `NoticeLevel` and the table below turns it into these.
 *
 * The line this draws is deliberate and load-bearing: these govern notices the plugin raises
 * **on its own initiative** — a timer fired, a pass finished, something failed. A notice that
 * is the direct answer to a click ("copied", "set the server URL first", "connection OK")
 * is never governed by any of this, because a control that responds to nothing reads as
 * broken, not as quiet.
 *
 * A watched *decision* — the mass-change guard, the continuity gate, first-sync consent — is
 * not a notice at all. Those are modals that ask a question, and silence never applies to
 * them: a question nobody sees is a sync that stops forever without saying why.
 */
export const NOTICE_CATEGORIES = ["pass", "changes", "conflicts", "problems"] as const;

export type NoticeCategory = (typeof NOTICE_CATEGORIES)[number];

/** Which categories reach the screen. Derived from a level; never stored. */
export interface NoticePolicy {
  /** A pass ran: the finished-pass summary, "up to date" included. */
  pass: boolean;
  /** Files changed on this device without the user asking — pulls, and applied shared settings. */
  changes: boolean;
  /** Content that could not be merged. Both versions are on disk and someone has to choose. */
  conflicts: boolean;
  /** Errors, halts, skipped files, and a pass that stopped to ask something. */
  problems: boolean;
}

/**
 * How much sync says, **loudest first**.
 *
 * A ladder rather than one switch per category, because notice severity is ordered and
 * independent booleans pretend it is not. Four of those gave sixteen states, and most were
 * nonsense: "every pass but never problems" is a stream of `up to date` toasts from a sync
 * that has silently broken, which is the exact failure this whole area exists to prevent. The
 * states anyone actually wants sit on a line — everything, only what moved, only what is
 * wrong, nothing — which is why logging systems converge on levels.
 *
 * The order is depended on: `migrateLegacyNoticeLevel` picks the first entry that still says
 * everything the old booleans asked for, which is what makes the migration round *up*.
 *
 * Device-local on purpose, unlike the vault-wide policy in `settings-doc.ts`: "be quiet on my
 * phone, tell me everything on my desktop" is the ordinary case, and a shared value makes it
 * unexpressible. It also means two devices cannot fight over it mid-pass.
 */
export const NOTICE_LEVELS = ["all", "activity", "problems", "silent"] as const;

export type NoticeLevel = (typeof NOTICE_LEVELS)[number];

/**
 * What a fresh install gets.
 *
 * `activity` rather than `all`: a pass that found nothing to do is the overwhelmingly common
 * case — the timer fires every few minutes forever — and a toast saying so teaches people to
 * dismiss this plugin's notices without reading them, which is exactly the habit that has to
 * survive for the failure notices to be worth raising. `all` stays one step away for anyone who
 * wants the heartbeat.
 *
 * This is **not** the migration's answer for an existing device: `migrateLegacyNoticeLevel`
 * hardcodes its own mapping, so a device that really was at `all` stays there. Sharing this
 * constant with it would round every upgrading device quietly *down*, which is the one direction
 * the migration promises never to go.
 */
export const DEFAULT_NOTICE_LEVEL: NoticeLevel = "activity";

/**
 * Whether a fresh install opens with `syncing…`.
 *
 * Off, because at `activity` the summary already speaks for every pass that did anything, so on
 * a working vault the opener's usual companion is a summary immediately after it — two toasts
 * for one uneventful pass. It earns its place on a slow link or a first sync, which is why it is
 * a switch and not a deletion.
 */
export const DEFAULT_NOTICE_START = false;

export function isNoticeLevel(value: unknown): value is NoticeLevel {
  return typeof value === "string" && (NOTICE_LEVELS as readonly string[]).includes(value);
}

/**
 * Level → categories.
 *
 * `all` and `activity` are deliberately identical here, and that is not a mistake to tidy
 * away: they differ only in whether a pass that moved **nothing** still speaks, which is a
 * question about one notice's content rather than about which categories exist. It is
 * answered at the bottom of `announcePass`, where the result is in hand.
 *
 * `silent` is a real row rather than a computed state. The previous design had four toggles
 * and no way to say "quiet" except reaching all four, so the page had to *detect* silence and
 * warn about it; a named option carries the warning as its own description instead.
 */
const LEVEL_POLICY: Record<NoticeLevel, NoticePolicy> = {
  all: { pass: true, changes: true, conflicts: true, problems: true },
  activity: { pass: true, changes: true, conflicts: true, problems: true },
  problems: { pass: false, changes: false, conflicts: true, problems: true },
  silent: { pass: false, changes: false, conflicts: false, problems: false },
};

/** Copied, so a caller cannot edit the table every other caller reads. */
export function policyForLevel(level: NoticeLevel): NoticePolicy {
  return { ...LEVEL_POLICY[level] };
}

/** Whether a notice in this category reaches the screen at this level. */
export function noticeAllowed(level: NoticeLevel, category: NoticeCategory): boolean {
  return LEVEL_POLICY[level][category];
}

/**
 * The per-category booleans this replaced in 0.7.2. Read once on load and then deleted, so a
 * stale value cannot be picked up again by anything written later.
 */
export const LEGACY_NOTICE_KEYS = [
  "notifyOnSync",
  "notifyOnlyChanged",
  "notifyOnChanges",
  "notifyOnConflicts",
  "notifyOnProblems",
] as const;

type LegacyNoticeKey = (typeof LEGACY_NOTICE_KEYS)[number];

/**
 * What each legacy key meant when it was *absent*.
 *
 * Absent is not false. A partially written or hand-edited `data.json` can carry some of these
 * and not others, and reading a missing key as `false` would migrate a device into silence it
 * never asked for — the one direction this migration must never go.
 */
const LEGACY_DEFAULTS: Record<LegacyNoticeKey, boolean> = {
  notifyOnSync: true,
  notifyOnlyChanged: false,
  notifyOnChanges: true,
  notifyOnConflicts: true,
  notifyOnProblems: true,
};

function legacyValue(saved: Record<string, unknown>, key: LegacyNoticeKey): boolean {
  const value = saved[key];
  return typeof value === "boolean" ? value : LEGACY_DEFAULTS[key];
}

function hasLegacyNoticeKeys(saved: Record<string, unknown>): boolean {
  return LEGACY_NOTICE_KEYS.some((key) => key in saved);
}

/**
 * The level that says everything the old booleans asked for, and possibly a little more.
 *
 * **Rounds up, never down.** Sixteen boolean combinations map onto four levels, so most
 * migrations cannot be exact; the choice is which way to be wrong. Landing a device on a
 * quieter level than it chose would suppress notices it had switched on — invisibly, on
 * upgrade, with a failure the likeliest thing lost. Landing it louder is at worst a toast
 * they did not ask for, next to a setting that explains itself.
 *
 * Returns null when there is nothing to migrate, so the caller can tell "no legacy keys" from
 * "legacy keys meaning silence".
 */
export function migrateLegacyNoticeLevel(
  saved: Record<string, unknown> | null | undefined
): NoticeLevel | null {
  if (saved === null || saved === undefined) return null;
  if (!hasLegacyNoticeKeys(saved)) return null;
  const on = (key: LegacyNoticeKey): boolean => legacyValue(saved, key);
  // Pass notices were on, so the level is one of the two that keeps them.
  if (on("notifyOnSync")) return on("notifyOnlyChanged") ? "activity" : "all";
  // Pass notices were off. Incoming changes are only announced by the two loud levels, so
  // wanting them at all rounds up to the quieter of those.
  if (on("notifyOnChanges")) return "activity";
  if (on("notifyOnConflicts") || on("notifyOnProblems")) return "problems";
  return "silent";
}

/**
 * The level a saved settings object should load with.
 *
 * A stored level wins over the legacy keys, because a device that has already migrated may
 * still be carrying them in a `data.json` written before they were dropped.
 *
 * An unrecognised stored value falls back to the default rather than throwing. This is the
 * one place that is right: the value decides how chatty a toast is, a newer build may know
 * levels this one does not, and halting sync over an unreadable *display* preference would
 * turn a cosmetic problem into a data one.
 */
export function resolveNoticeLevel(
  saved: Record<string, unknown> | null | undefined
): NoticeLevel {
  const stored = saved?.noticeLevel;
  if (isNoticeLevel(stored)) return stored;
  return migrateLegacyNoticeLevel(saved) ?? DEFAULT_NOTICE_LEVEL;
}

/**
 * Whether this device announces the start of a sync the user asked for.
 *
 * Migrated **exactly**, not rounded up like the level: `notifyOnSync` governed both ends of a
 * pass, so someone who turned it off had no opener and must not acquire one on upgrade. The
 * level cannot be exact because sixteen states do not fit in four; this can be, so it is.
 *
 * The last two branches are not the same answer twice. A settings object carrying *any* legacy
 * notice key came off the old build, where the opener was on unless `notifyOnSync` said
 * otherwise — so an absent `notifyOnSync` there means the old default, not the new one. Only a
 * settings object with no legacy key at all is a fresh install, and only that gets
 * `DEFAULT_NOTICE_START`. Collapsing the two would hand every upgrading device the *new*
 * default and silently drop an opener the old build was showing them.
 */
export function resolveNoticeStart(saved: Record<string, unknown> | null | undefined): boolean {
  const stored = saved?.notifyOnStart;
  if (typeof stored === "boolean") return stored;
  if (saved !== null && saved !== undefined && hasLegacyNoticeKeys(saved)) {
    return legacyValue(saved, "notifyOnSync");
  }
  return DEFAULT_NOTICE_START;
}

/** Did this pass actually move a file, in either direction? */
export function passChangedSomething(result: SyncResult): boolean {
  return result.pushedChanges.length > 0 || result.pulledChanges.length > 0;
}

/**
 * Whether a finished pass puts its summary on screen.
 *
 * A halt, a pending decision, a conflict and a skipped file each carry their own message under
 * `problems`/`conflicts`, so this governs only the per-pass summary.
 *
 * **`activity` means changed something, with no exception for a pass the user started.** There
 * used to be one: a manual sync spoke even when it found nothing, because a tap with no reply
 * is indistinguishable from a tap that missed, and on a phone there is no status bar to fall
 * back on. That reasoning was sound while the *only* way to acknowledge a tap was the summary.
 * It is not any more — `announceStart` is a switch of its own now, it fires on exactly the
 * passes this exception was protecting, and it fires at the *start*, which is when someone is
 * actually wondering whether the tap registered. Keeping both meant "only passes that changed
 * something" quietly did not apply to the passes a user is most likely to watch.
 */
export function announcePass(opts: {
  level: NoticeLevel;
  result: SyncResult;
}): boolean {
  if (!noticeAllowed(opts.level, "pass")) return false;
  // A pass that stopped to ask something did not finish, so the per-pass summary would be a
  // false statement — "up to date" printed above a notice explaining that nothing was done.
  if (
    opts.result.status === "halted" ||
    opts.result.status === "needs-decision" ||
    opts.result.status === "needs-continuity"
  ) {
    return false;
  }
  if (passChangedSomething(opts.result)) return true;
  // The whole difference between the two loud levels: a pass that moved nothing.
  return opts.level === "all";
}

/**
 * Whether a pass says anything as it *begins*.
 *
 * Only a pass the user started. A first sync, or one over a slow link, leaves minutes between
 * the tap and the summary, which reads exactly like a tap that missed. A timer firing in the
 * background has nobody to reassure, so it stays quiet and reports only what it did.
 *
 * Its own switch rather than a rung of the ladder, and that placement is the argument: this is
 * the answer to a click, which is the one thing the categories above deliberately never
 * govern. How chatty background sync should be says nothing about whether a tap should be
 * acknowledged — someone can reasonably want silence from the timer and a reply from the
 * button.
 */
export function announceStart(opts: { enabled: boolean; interactive: boolean }): boolean {
  return opts.enabled && opts.interactive;
}

/**
 * How a pass should report the conflicts it produced.
 *
 * `"modal"` opens the review window, `"notice"` points at the review command, `"none"` says
 * nothing. A watched pass gets the window because someone is there to read it; a background one
 * gets the notice, because there may be nobody to dismiss a modal.
 *
 * The window is governed by the same category as the notice, and that is the point of having
 * this function at all: auto-opening a window is a *larger* interruption than the notice beside
 * it, so a device that asked not to be told about conflicts must not be handed one instead.
 *
 * What is never governed is the record. Both callers keep the conflict list first, so the files
 * are still on disk and "Review and resolve conflicts" — a command the user runs deliberately —
 * still lists them. Silence loses the prompt, never the evidence.
 */
export function conflictReport(opts: {
  level: NoticeLevel;
  interactive: boolean;
}): "modal" | "notice" | "none" {
  if (!noticeAllowed(opts.level, "conflicts")) return "none";
  return opts.interactive ? "modal" : "notice";
}

/**
 * Characters of a snapshot id kept for display.
 *
 * Seven, matching git's habit of showing an abbreviated digest rather than the whole thing —
 * but taken from the OTHER end, and that difference matters. Git's ids are content hashes, so
 * every slice is equally random and a prefix is as good as anything. Ours are ULIDs
 * (`ulid.ts`): ten characters of millisecond timestamp followed by sixteen of randomness. Each
 * character carries five bits, so a seven-character *prefix* pins the top 35 bits of the
 * timestamp and leaves the low fifteen free — it is constant for 2^15 ms, about **33 seconds**,
 * and what it encodes is a clock reading the notice's own arrival time already gave you.
 * (Verified against the generator, not derived on paper: at eight characters the window is
 * 1,024 ms, so this gets worse as the prefix gets shorter, which is the opposite of git.)
 *
 * The suffix is the entropy, so it is the part that actually identifies the snapshot.
 */
export const SHORT_SNAPSHOT_LENGTH = 7;

/**
 * How a snapshot id is shown to a person. **Every** surface, unconditionally.
 *
 * There was a setting for this and it is gone. Two arguments retired it. An id abbreviated in
 * a notice and spelled in full in the dialog two taps later does not read as one thoughtful
 * choice per surface, it reads as two different identifiers — and the reader's job is to match
 * them up. And a *preference* implies the long form buys something; it does not, because the
 * full id is never typed or pasted anywhere by hand. The one place it is genuinely needed is
 * the exported sync log, which is a file rather than a screen and keeps all 26 (`formatLogNote`).
 *
 * Shortening is display only and never round-trips: nothing is ever looked up by the value this
 * returns — `GET /api/manifests/:id` wants the whole thing — so an unlucky collision would be
 * cosmetic rather than a wrong snapshot.
 */
export function shortSnapshot(id: string): string {
  if (id.length <= SHORT_SNAPSHOT_LENGTH) return id;
  return id.slice(-SHORT_SNAPSHOT_LENGTH);
}
