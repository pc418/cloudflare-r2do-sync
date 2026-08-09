const MAX_PATH_BYTES = 1024;

/** This plugin's own folder inside the vault. Must never be synced — see `alwaysSkip`. */
export const PLUGIN_DIR = ".obsidian/plugins/cloudflare-rdo-sync";

/**
 * The unpublished pre-rename install can still contain `data.json` with live credentials.
 * Treat it as a self-directory forever: a renamed install must never upload the old copy.
 */
export const LEGACY_PLUGIN_DIR = ".obsidian/plugins/obsidian-log-sync";

/** Files that are noise on every platform, matched by exact segment name. */
const JUNK_NAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "thumbs.db",
  "Desktop.ini",
  "desktop.ini",
  ".localized",
]);

/** Directories whose entire contents are noise, matched by exact segment name. */
const JUNK_DIRS = new Set([".git", ".svn", ".hg", "node_modules", "__MACOSX"]);

/** macOS custom-folder-icon marker: the four letters plus a carriage return. */
function isIconMarker(segment: string): boolean {
  // Written by code point rather than an escape: the escape gets mangled into a literal
  // control byte by some editors, and a stray CR here would silently stop matching.
  return segment.length === 5 && segment.startsWith("Icon") && segment.charCodeAt(4) === 13;
}

/**
 * Paths this device refuses to sync no matter what the user's exclude globs say.
 *
 * Two kinds live here. **Junk** (OS droppings, VCS and dependency directories, Office lock
 * files) is skipped because syncing it is pointless churn. **Self-excludes** are a safety
 * rule: this plugin's own folder holds `data.json` with the access token and the vault
 * master key in plaintext, so uploading it would place the key inside the vault it
 * protects, and pulling another device's copy would silently replace this device's
 * identity mid-sync. Workspace layout files are per-device by nature and change constantly.
 *
 * Skips here are silent — unlike oversized or invalid paths, there is nothing for a user to
 * fix. Paths already on the remote are still carried into our snapshots, so a device
 * running an older version that uploaded junk does not get it deleted underneath it.
 */
export function alwaysSkip(path: string): boolean {
  for (const selfDir of [PLUGIN_DIR, LEGACY_PLUGIN_DIR]) {
    if (path === selfDir || path.startsWith(`${selfDir}/`)) return true;
  }

  const segments = path.split("/");
  if (segments.length === 2 && segments[0] === ".obsidian" && isWorkspaceFile(segments[1])) {
    return true;
  }
  return segments.some(
    (seg) => JUNK_NAMES.has(seg) || JUNK_DIRS.has(seg) || seg.startsWith("~$") || isIconMarker(seg)
  );
}

function isWorkspaceFile(name: string): boolean {
  return name === "workspace.json" || (name.startsWith("workspace-") && name.endsWith(".json"));
}

/** Mirrors the server's path rules so we skip loudly instead of eating a 422 mid-commit. */
export function pathError(path: string): string | null {
  if (path.length === 0) return "empty path";
  if (new TextEncoder().encode(path).length > MAX_PATH_BYTES) return "path exceeds 1024 bytes";
  if (path.startsWith("/")) return "absolute path";
  if (path.includes("\\")) return "backslash in path";
  if (/[\u0000-\u001f\u007f]/.test(path)) return "control character in path";
  if (path !== path.normalize("NFC")) return "path not NFC-normalized";
  for (const seg of path.split("/")) {
    if (seg === "") return "empty path segment";
    if (seg === "." || seg === "..") return "dot segment in path";
    if (seg !== seg.trim() || seg.endsWith(".")) {
      return "segment has leading/trailing space or trailing dot";
    }
  }
  return null;
}

/** Glob support limited to what vault excludes need: `**`, `*`, `?`. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

export function makeExcluder(globs: string[]): (path: string) => boolean {
  const patterns = globs.filter((g) => g.trim().length > 0).map(globToRegExp);
  return (path: string) => patterns.some((re) => re.test(path));
}

/** Obsidian's configuration directory: opt-in, and never this plugin's own folder inside it. */
export function isConfigPath(path: string): boolean {
  return path === ".obsidian" || path.startsWith(".obsidian/");
}

/** One glob per line, blank lines dropped. The stored form of every glob setting. */
export function parseGlobs(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The glob settings that decide whether a path is this device's business at all. */
export interface ScopeRules {
  excludes: string[];
  /** Allow-list; empty means the whole vault. */
  onlyPaths: string[];
  /** Whether ordinary `.obsidian/**` files are in scope. */
  syncConfigDir: boolean;
}

/**
 * Whether a path is one this device puts in its own snapshots.
 *
 * This mirrors `SyncEngine.#notScanned`, which composes the same five rules inline because its
 * snapshot loop has to distinguish a silent skip from a reported one. It lives here as a pure
 * function so the settings page can say what a glob list *would* do without running a pass —
 * a wrong glob is otherwise only discoverable from a sync's aftermath. Change one, change both.
 */
export function makeScopeFilter(rules: ScopeRules): (path: string) => boolean {
  const excluded = makeExcluder(rules.excludes);
  const only = rules.onlyPaths.filter((glob) => glob.trim().length > 0);
  const included = makeExcluder(only);
  return (path: string) =>
    !alwaysSkip(path) &&
    pathError(path) === null &&
    (rules.syncConfigDir || !isConfigPath(path)) &&
    !excluded(path) &&
    (only.length === 0 || included(path));
}

export function countInScope(paths: readonly string[], rules: ScopeRules): number {
  const inScope = makeScopeFilter(rules);
  let kept = 0;
  for (const path of paths) if (inScope(path)) kept++;
  return kept;
}
