/**
 * Turning an unmergeable pair into a decision.
 *
 * A sync pass never asks: it parks the losing version beside the winner and moves on, so
 * nothing is destroyed while nobody is watching. This module is the second half — what
 * happens when a person finally looks at the pair and picks a side. Everything here is pure;
 * the file operations are returned, not performed, so the rules are testable without a vault.
 */

import { ELISION, diffLines, type DiffRow } from "./merge";
import type { ConflictInfo } from "./sync";

/** Newline, spelled so no source escape can be flattened into a literal control byte. */
const NL = String.fromCharCode(10);

export type ConflictChoice = "keep-mine" | "keep-theirs" | "keep-both" | "combine";

export const CONFLICT_CHOICES: readonly ConflictChoice[] = [
  "keep-mine",
  "keep-theirs",
  "keep-both",
  "combine",
];

/**
 * File operations that carry out a choice, applied in order: promotions, writes, removals.
 *
 * Keeping a side is a move, never a re-write of its text. Reading one file and writing its
 * characters back would corrupt every binary conflict — attachments are exactly the files
 * that cannot merge — and "keep the other version" of a PNG used to fail with "is not text".
 */
export interface ResolveOps {
  /** The bytes at `from` become the file at `to`. Content is never inspected. */
  promotes: Array<{ from: string; to: string }>;
  /** New content. Only `combine` produces any: it is the one choice that invents text. */
  writes: Array<{ path: string; text: string }>;
  removes: string[];
}

function noOps(): ResolveOps {
  return { promotes: [], writes: [], removes: [] };
}

/**
 * Which side a user is most likely to want, and the one the UI preselects: the newer edit.
 * Ties go to the remote, because a tie means the two files claim the same mtime and the remote
 * one is the version this device has *not* seen before.
 */
export function latestSide(info: ConflictInfo): "mine" | "theirs" {
  return info.ours.mtime > info.theirs.mtime ? "mine" : "theirs";
}

/**
 * Where each side of the pair physically sits.
 *
 * `kept` names the side that won the canonical path, so it is also the answer to "which file
 * holds which version". The common case is ours at the note's own path with theirs parked
 * beside it — but an attachment resolved by last-writer-wins is the exact mirror, THEIRS at
 * the canonical path and OURS in the `.conflict-…` copy. Assuming the common layout inverted
 * every button on those: "keep this device" deleted this device's only copy.
 */
export function conflictSides(info: ConflictInfo): { mine: string; theirs: string } {
  const copy = requireCopy(info);
  return info.kept === "theirs"
    ? { mine: copy, theirs: info.path }
    : { mine: info.path, theirs: copy };
}

/**
 * Why this conflict cannot be resolved from the review window, or null when it can.
 *
 * Both reasons mean the same thing to the user — there is no second file on this disk to
 * choose between — and both are honest answers rather than buttons whose only outcome is an
 * error notice.
 */
export function unresolvableReason(info: ConflictInfo): string | null {
  if (info.snapshotOnly === true) {
    return (
      "Push-only mode never writes to this vault, so the other version was preserved in the " +
      "snapshot instead of being saved beside yours. Switch to two-way sync, or take it out " +
      "of Snapshot history."
    );
  }
  if (info.copy === null) {
    return (
      "The losing version was overwritten by the conflict handling setting, so there is " +
      "nothing left to choose. The remote side stays in snapshot history; a local-only " +
      "edit does not."
    );
  }
  return null;
}

/** Whether both versions are on this disk, which is what makes a choice possible. */
export function isResolvable(info: ConflictInfo): boolean {
  return unresolvableReason(info) === null;
}

/**
 * The pair's files that are no longer in the vault, in the order the window names them.
 *
 * A conflict outlives the pass that recorded it, and either side can leave in between: the
 * note deleted by hand, the copy resolved on another device, either one renamed. Asking is
 * the only way to know — the recorded entry cannot.
 */
export function missingSides(info: ConflictInfo, present: ReadonlySet<string>): string[] {
  if (info.copy === null) return [];
  const sides = conflictSides(info);
  return [sides.mine, sides.theirs].filter((path) => !present.has(path));
}

/**
 * Why one choice cannot be carried out against the vault as it is now, or null when it can.
 *
 * The window used to offer all four buttons whenever the *copy* was still there, because that
 * is all `pruneResolved` checks. In the ordinary layout `sides.mine` IS the note's own path,
 * so a note deleted after the conflict was recorded left three buttons whose only outcome was
 * "…is gone" — and the entry could never clear, because pruning never looked at that side. A
 * button that can only fail is worse than one that is visibly unavailable.
 */
export function choiceBlockedReason(
  info: ConflictInfo,
  choice: ConflictChoice,
  present: ReadonlySet<string>
): string | null {
  const unresolvable = unresolvableReason(info);
  if (unresolvable !== null) return unresolvable;
  const missing = pathsRequired(info, choice).filter((path) => !present.has(path));
  if (missing.length === 0) return null;
  return missing.length === 1
    ? `${missing[0]} is no longer in the vault.`
    : `Neither ${missing[0]} nor ${missing[1]} is in the vault any more.`;
}

/**
 * The conflicts still worth listing, given what the vault currently holds.
 *
 * The outstanding list survives restarts, and every one of the ways a pair leaves disk is
 * invisible to it: resolved on another device and the deletion pulled here, the note renamed,
 * the copy deleted by hand. Without this the window offers buttons for files that left weeks
 * ago and every click fails with "it was already resolved" — which is true, and useless.
 * Entries that never had a copy are kept: they are a record, not an offer.
 */
export function pruneResolved(
  conflicts: readonly ConflictInfo[],
  present: ReadonlySet<string>
): ConflictInfo[] {
  return conflicts.filter((info) => {
    const copy = info.copy;
    if (copy === null || !isResolvable(info)) return true;
    return present.has(copy);
  });
}

/**
 * The operations for a choice.
 *
 * Callers must pass the text they actually read from disk at decision time, not what the pass
 * recorded: minutes may have passed and the user may have edited either file. Only `combine`
 * uses the text at all — keeping one side moves files, so it works on any content.
 */
export function planResolution(
  info: ConflictInfo,
  texts: { mine: string | null; theirs: string | null },
  choice: ConflictChoice
): ResolveOps {
  const copy = requireCopy(info);
  const sides = conflictSides(info);

  switch (choice) {
    case "keep-both":
      return noOps();
    case "keep-mine":
    case "keep-theirs": {
      const winner = choice === "keep-mine" ? sides.mine : sides.theirs;
      const ops = noOps();
      // When the winner already sits at the canonical path the only work is dropping the
      // copy; otherwise the parked version is promoted onto the path it lost.
      if (winner !== info.path) ops.promotes.push({ from: winner, to: info.path });
      ops.removes.push(copy);
      return ops;
    }
    case "combine": {
      if (texts.mine === null || texts.theirs === null) {
        throw new Error(
          `cannot combine "${info.path}": one side is not text, so there are no lines to merge. ` +
            "Keep one side, or keep both as separate files."
        );
      }
      const combined = combineText(info, texts.mine, texts.theirs);
      if (combined === null) {
        throw new Error(
          `"${info.path}" is too large to combine. Keep one side, or keep both as separate files.`
        );
      }
      const ops = noOps();
      ops.writes.push({ path: info.path, text: combined });
      ops.removes.push(copy);
      return ops;
    }
  }
}

/**
 * The operations for a choice, checked against what is actually on disk right now.
 *
 * A conflict may have been parked minutes or days ago, and this is the last chance to notice
 * that the world moved on. Every missing file stops the resolution rather than half-applying
 * it - overwriting an edit made in that window is exactly the loss the whole conflict
 * mechanism exists to prevent. Only the files a choice actually needs are required: promoting
 * a parked copy onto a note that has since been deleted is a restore, not a hazard.
 */
export function planResolutionOnDisk(
  info: ConflictInfo,
  choice: ConflictChoice,
  disk: { present: ReadonlySet<string>; mine: string | null; theirs: string | null }
): ResolveOps {
  const copy = requireCopy(info);
  if (!disk.present.has(copy)) {
    throw new Error(
      `${copy} is gone - it was already resolved, renamed or deleted. Nothing changed.`
    );
  }
  for (const path of pathsRequired(info, choice)) {
    if (path !== copy && !disk.present.has(path)) {
      throw new Error(`${path} is gone. Nothing changed; ${copy} still holds one side.`);
    }
  }
  return planResolution(info, { mine: disk.mine, theirs: disk.theirs }, choice);
}

/**
 * The files a choice needs to be on disk for its outcome to be true.
 *
 * `keep-both` performs no operation, but it still *claims* both versions survive. With only
 * one of them left it reported success, dropped the conflict from the outstanding list, and
 * kept one file — an answer that was wrong in the one direction this whole feature exists to
 * prevent. Doing nothing is only "keeping both" when there are both.
 */
/** Also used by `choiceBlockedReason` above, to decide what a button can promise. */
function pathsRequired(info: ConflictInfo, choice: ConflictChoice): string[] {
  const sides = conflictSides(info);
  switch (choice) {
    case "keep-both":
    case "combine":
      return [sides.mine, sides.theirs];
    case "keep-mine":
      return [sides.mine];
    case "keep-theirs":
      return [sides.theirs];
  }
}

function requireCopy(info: ConflictInfo): string {
  const reason = unresolvableReason(info);
  if (reason !== null) throw new Error(`"${info.path}" cannot be resolved here. ${reason}`);
  // `unresolvableReason` returning null is exactly the proof that `copy` is a string.
  return info.copy!;
}

/** Marker labels. Recognisable as conflict markers, but naming the sides rather than commits. */
const MINE_MARKER = "<<<<<<<";
const SPLIT_MARKER = "=======";
const THEIRS_MARKER = ">>>>>>>";

/**
 * Both versions in one file, for editing by hand later.
 *
 * Only the differing regions are wrapped in markers — lines the two versions agree on appear
 * once — so the result is a note a person can actually work through rather than two documents
 * stapled together. Ordinary sync never writes markers into a note; this is the one place that
 * does, and only because the user asked for it on this file.
 *
 * Returns null when the pair is too large to diff, the same refusal the merge makes.
 */
export function combineText(info: ConflictInfo, mine: string, theirs: string): string | null {
  const diff = diffLines(mine, theirs, { context: Number.MAX_SAFE_INTEGER, maxRows: Infinity });
  if (diff === null) return null;

  const newer = latestSide(info);
  const mineLabel = `${MINE_MARKER} this device${newer === "mine" ? " (newer)" : ""}`;
  const theirsLabel = `${THEIRS_MARKER} other device${newer === "theirs" ? " (newer)" : ""}`;

  const out: string[] = [];
  let pending: { mine: string[]; theirs: string[] } | null = null;
  const flush = () => {
    if (pending === null) return;
    out.push(mineLabel, ...pending.mine, SPLIT_MARKER, ...pending.theirs, theirsLabel);
    pending = null;
  };

  for (const row of diff.rows) {
    if (row.kind === "same") {
      flush();
      // An elision cannot appear: context is unbounded here, so every identical line is present.
      if (row.text !== ELISION) out.push(row.text);
      continue;
    }
    pending ??= { mine: [], theirs: [] };
    if (row.kind === "ours") pending.mine.push(row.text);
    else pending.theirs.push(row.text);
  }
  flush();
  return out.join(NL);
}

/** The diff a conflict view shows, or null when the pair cannot be diffed for display. */
export function conflictDiff(
  mine: string,
  theirs: string
): { rows: DiffRow[]; truncated: number } | null {
  return diffLines(mine, theirs);
}
