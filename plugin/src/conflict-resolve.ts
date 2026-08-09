/**
 * Turning an unmergeable pair into a decision.
 *
 * A sync pass never asks: it parks the remote version beside ours as a conflict copy and moves
 * on, so nothing is destroyed while nobody is watching. This module is the second half — what
 * happens when a person finally looks at the pair and picks a side. Everything here is pure; the
 * file operations are returned, not performed, so the rules are testable without a vault.
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

/** File operations that carry out a choice. Applied in order: writes, then removes. */
export interface ResolveOps {
  writes: Array<{ path: string; text: string }>;
  removes: string[];
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
 * Whether this conflict can still be resolved. An overwrite mode (`newest`/`largest`) already
 * discarded the loser, so there is no second version left to choose — saying so is the honest
 * answer, and the reason those modes ask for a second confirmation before they can be enabled.
 */
export function isResolvable(info: ConflictInfo): boolean {
  return info.copy !== null;
}

/**
 * The operations for a choice.
 *
 * `mine` is whatever sits at the canonical path and `theirs` is the parked copy — which is the
 * layout every `keep-both` conflict leaves behind, whichever side won the path. Callers must
 * pass the text they actually read from disk at decision time, not what the pass recorded:
 * minutes may have passed and the user may have edited either file.
 */
export function planResolution(
  info: ConflictInfo,
  texts: { mine: string | null; theirs: string | null },
  choice: ConflictChoice
): ResolveOps {
  const copy = info.copy;
  if (copy === null) {
    throw new Error(
      `"${info.path}" has no second version to choose from: an overwrite conflict mode ` +
        "discarded it. The remote side is still in snapshot history."
    );
  }
  switch (choice) {
    case "keep-both":
      return { writes: [], removes: [] };
    case "keep-mine":
      return { writes: [], removes: [copy] };
    case "keep-theirs": {
      if (texts.theirs === null) {
        throw new Error(`cannot keep the other version of "${info.path}": ${copy} is not text`);
      }
      return { writes: [{ path: info.path, text: texts.theirs }], removes: [copy] };
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
      return { writes: [{ path: info.path, text: combined }], removes: [copy] };
    }
  }
}

/**
 * The operations for a choice, checked against what is actually on disk right now.
 *
 * A conflict may have been parked minutes or days ago, and this is the only chance to notice that
 * the world moved on: the copy already resolved by hand, the note renamed, either side deleted.
 * Every one of those stops the resolution rather than half-applying it - overwriting an edit made
 * in that window is exactly the loss the whole conflict mechanism exists to prevent.
 */
export function planResolutionOnDisk(
  info: ConflictInfo,
  choice: ConflictChoice,
  disk: { present: ReadonlySet<string>; mine: string | null; theirs: string | null }
): ResolveOps {
  if (info.copy === null) {
    throw new Error(
      `"${info.path}" has no second version to choose from: an overwrite conflict mode ` +
        "discarded it. The remote side is still in snapshot history."
    );
  }
  if (!disk.present.has(info.copy)) {
    throw new Error(
      `${info.copy} is gone - it was already resolved, renamed or deleted. Nothing changed.`
    );
  }
  if (choice !== "keep-both" && !disk.present.has(info.path)) {
    throw new Error(`${info.path} is gone. Nothing changed; ${info.copy} still holds one side.`);
  }
  return planResolution(info, { mine: disk.mine, theirs: disk.theirs }, choice);
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
