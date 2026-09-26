import { TFile, type App } from "obsidian";
import {
  DEFAULT_CONFIG_DIR,
  isConfigPath,
  makeScopeFilter,
  pathError,
  type ScopeRules,
} from "./paths";

/**
 * Markdown strictly larger than this is renamed to `.txt`: 1.5 MiB.
 *
 * Obsidian's metadata indexer parses every Markdown file it sees, and a single very large note
 * (a pasted log, a transcript backup) was shown to exhaust a mobile worker's heap on its own.
 * A `.txt` file keeps its bytes and still syncs, but is not parsed as Markdown.
 */
export const LARGE_MARKDOWN_BYTES = 1_572_864;

const MARKDOWN_EXTENSION = /\.(md|markdown)$/i;

/** The final extension, or "" when the basename has none. A leading dot names the file. */
function finalExtensionAt(path: string): number {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot <= slash + 1 ? -1 : dot;
}

/** Whether the final extension is `.md` or `.markdown`, in any letter case. */
export function isMarkdownPath(path: string): boolean {
  const dot = finalExtensionAt(path);
  return dot >= 0 && MARKDOWN_EXTENSION.test(path.slice(dot));
}

/** `a/Note.MD` → `a/Note.txt`. Only the final extension is replaced. */
export function textTargetPath(path: string): string {
  const dot = finalExtensionAt(path);
  if (dot < 0 || !isMarkdownPath(path)) throw new Error(`not a Markdown path: ${path}`);
  return `${path.slice(0, dot)}.txt`;
}

/**
 * Whether a reported size is over the threshold. A size that is not a finite, non-negative
 * number is not evidence either way, so it throws rather than being read as small or large.
 */
export function exceedsLargeMarkdown(size: unknown): boolean {
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
    throw new Error(`file size is unreadable (${String(size)})`);
  }
  return size > LARGE_MARKDOWN_BYTES;
}

/**
 * Whether a path is an ordinary, visible vault file this device syncs.
 *
 * Narrower than the sync scope on purpose: configuration directories (active and default) are
 * skipped even when configuration sync is on, and so is anything under a hidden segment —
 * Obsidian does not index those, so there is nothing to relieve there.
 */
export function makeMaintainable(rules: ScopeRules): (path: string) => boolean {
  const inScope = makeScopeFilter(rules);
  const configDir = rules.configDir ?? DEFAULT_CONFIG_DIR;
  return (path) =>
    !path.split("/").some((segment) => segment.startsWith(".")) &&
    !isConfigPath(path, configDir) &&
    !isConfigPath(path, DEFAULT_CONFIG_DIR) &&
    inScope(path);
}

/** The filesystem slice a rename needs. Obsidian's implementation is `obsidianRenameFs`. */
export interface RenameFs {
  stat(path: string): Promise<{ type: string; size: unknown } | null>;
  list(folder: string): Promise<{ files: string[]; folders: string[] }>;
  /** A real move that keeps the bytes. Must refuse to overwrite an existing destination. */
  rename(from: string, to: string): Promise<void>;
}

export interface RenameFailure {
  path: string;
  target: string;
  reason: string;
}

export interface RenameOutcome {
  renamed: { from: string; to: string }[];
  failed: RenameFailure[];
  /** Why the run stopped before finishing, or null when every candidate was considered. */
  stopped: string | null;
  /** Candidates never looked at because the run stopped. Owed to a later run. */
  notAttempted: string[];
}

export interface RenameOptions {
  rules: ScopeRules;
  /** Checked before each file; a non-null answer stops the run and names why. */
  shouldStop?: () => string | null;
  /** Called after each successful rename, before the next file is considered. */
  onRenamed?: (from: string, to: string) => void;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function foldKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Renames every candidate that is oversized, eligible Markdown to `.txt`, one at a time.
 *
 * Source metadata and target absence are read immediately before each rename. A target that
 * exists — as a file or a folder, or under another letter case — is refused and reported, never
 * overwritten, numbered or deduplicated. A failure does not undo earlier renames, and does not
 * stop later ones: the outcome lists both, so nobody is told everything was converted.
 */
export async function renameLargeMarkdown(
  candidates: Iterable<string>,
  fs: RenameFs,
  opts: RenameOptions
): Promise<RenameOutcome> {
  const eligible = makeMaintainable(opts.rules);
  const outcome: RenameOutcome = { renamed: [], failed: [], stopped: null, notAttempted: [] };
  const queue = [...new Set(candidates)]
    .filter((path) => isMarkdownPath(path) && eligible(path))
    .sort();
  for (let i = 0; i < queue.length; i++) {
    const path = queue[i];
    const stop = opts.shouldStop?.() ?? null;
    if (stop !== null) {
      outcome.stopped = stop;
      outcome.notAttempted = queue.slice(i);
      break;
    }
    const target = textTargetPath(path);
    const fail = (reason: string): void => {
      outcome.failed.push({ path, target, reason });
    };
    try {
      const stat = await fs.stat(path);
      // Gone or replaced by a folder since it was listed: nothing of ours to convert.
      if (stat === null || stat.type !== "file") continue;
      if (!exceedsLargeMarkdown(stat.size)) continue;
      if (pathError(target) !== null || !eligible(target)) {
        fail("the .txt name would be outside what this device syncs");
        continue;
      }
      if ((await fs.stat(target)) !== null) {
        fail("a file or folder already exists there");
        continue;
      }
      const listed = await fs.list(parentOf(target));
      const want = foldKey(nameOf(target));
      const clash = [...listed.files, ...listed.folders].find((p) => foldKey(nameOf(p)) === want);
      if (clash !== undefined) {
        fail(`"${clash}" already exists with different letter case`);
        continue;
      }
      await fs.rename(path, target);
      outcome.renamed.push({ from: path, to: target });
      opts.onRenamed?.(path, target);
    } catch (e) {
      fail(errorText(e));
    }
  }
  return outcome;
}

/**
 * Obsidian's implementation: metadata from the data adapter, the move through `Vault.rename`
 * so Obsidian's own file tree follows it. Not `FileManager.renameFile`, which would also
 * rewrite links in other notes — edits nobody asked for.
 *
 * `vaultRenames` receives each destination just before `Vault.rename` runs, and loses it again
 * if the rename throws, so a caller can recognise the vault event that rename fires.
 */
export function obsidianRenameFs(app: App, vaultRenames?: Map<string, string>): RenameFs {
  return {
    stat: async (path) => await app.vault.adapter.stat(path),
    list: async (folder) => await app.vault.adapter.list(folder),
    rename: async (from, to) => {
      const file = app.vault.getAbstractFileByPath(from);
      if (!(file instanceof TFile)) {
        // Not in Obsidian's tree yet: a file a pull has only just written. It is moved on disk
        // and Obsidian discovers it under the new name, never having indexed it as Markdown.
        await app.vault.adapter.rename(from, to);
        return;
      }
      vaultRenames?.set(to, from);
      try {
        await app.vault.rename(file, to);
      } catch (e) {
        vaultRenames?.delete(to);
        throw e;
      }
    },
  };
}

const LISTED_NAMES = 3;

/** "2 Markdown files to .txt (a.md → a.txt, b.md → b.txt)". Paths only, never contents. */
export function describeRenamed(renamed: readonly { from: string; to: string }[]): string {
  const n = renamed.length;
  const shown = renamed.slice(0, LISTED_NAMES).map((r) => `${r.from} → ${r.to}`);
  const more = n > LISTED_NAMES ? `, +${n - LISTED_NAMES} more` : "";
  return `${n} Markdown file${n === 1 ? "" : "s"} to .txt (${shown.join(", ")}${more})`;
}

/** Every refusal by name, plus why a stopped run left files untouched. */
export function describeProblems(outcome: RenameOutcome): string {
  const parts = outcome.failed.map((f) => `${f.path} → ${f.target}: ${f.reason}`);
  if (outcome.stopped !== null && outcome.notAttempted.length > 0) {
    const n = outcome.notAttempted.length;
    parts.push(`stopped with ${n} file${n === 1 ? "" : "s"} not checked: ${outcome.stopped}`);
  }
  return parts.join("; ");
}
