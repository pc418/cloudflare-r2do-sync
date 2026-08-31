/**
 * The whole tool surface.
 *
 * Contracts deliberately mirror Claude Code's native tools — the shapes models are most
 * trained on — because that, plus paging and line anchors, is what makes a remote tool feel
 * native. The transport is irrelevant to the model.
 *
 * `delete` and `move` act on **single files only** — there are no folder operations of any
 * kind. That is what keeps the deny surface honest: file globs remain the whole of it, and
 * both tools pass through the same `view.scope()` gate as every other write, source *and*
 * destination.
 *
 * Deliberately absent: anything that runs a command, any editor/cursor tool (structurally
 * impossible remotely), and any folder-level operation.
 */
import { globToRegExp } from "../../plugin/src/paths";
import type { FileEntry } from "../../plugin/src/types";
import type { SearchIndex } from "./index-store";
import { BLOB_BUDGET, CONTEXT_DEFAULT, CONTEXT_MAX, search } from "./search";
import { VaultError, type VaultView } from "./vault";
import type { WriteOp } from "./write";

export interface ToolContext {
  view: VaultView;
  /** Queues a write for the current batch and resolves when that batch is committed. */
  enqueue: (op: WriteOp) => Promise<{ head: string; summary: string }>;
  /** False on a read-only deployment: the write tools are then not even advertised. */
  writable: boolean;
  /**
   * The SQLite-backed search index. Optional: absent, or merely behind, `search` falls back to
   * the bounded scan. It is a cache of content that already exists in R2 and is never the only
   * copy of anything.
   */
  index?: SearchIndex;
}

/**
 * Hints are declared explicitly on every tool because their defaults are the *pessimistic*
 * reading — an omitted `destructiveHint` means "assume destructive". Silence would describe
 * `search` as a tool that might delete something.
 */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
}

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });

/** A tool that reads the vault and cannot change it. */
const READS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
/** A tool that changes the vault. `destructiveHint` distinguishes adding from replacing. */
const WRITES = (destructive: boolean): ToolAnnotations => ({
  readOnlyHint: false,
  destructiveHint: destructive,
  idempotentHint: false,
  openWorldHint: false,
});

/**
 * The fallback for a client that drops `initialize.instructions`, proven to exist: a captured
 * deferred-harness session showed no instructions block at all — not even the static preamble
 * every build has served, which is what makes the verdict timing-independent. A tool
 * description is the only carrier such a client cannot discard.
 *
 * On `list` and `search` alone (the entry points into an unread vault), never as a first
 * sentence (that slot is the tool's own contract). Conditional phrasing because most vaults
 * have no `AGENT.md`; static text because a vault-dependent descriptor would put a snapshot
 * read inside `tools/list`. The supersession clause exists because a client caches
 * `initialize` while the note can be rewritten mid-session — and it is scoped to *vault*
 * conventions so a synced note never reads as authority over the chat.
 */
const AGENT_NOTE_POINTER =
  " If the vault has a root note `AGENT.md`, read it first — it carries the owner's conventions, replacing any vault conventions you were given earlier.";

/**
 * Every description's **first sentence** carries that tool's load-bearing contract.
 *
 * Not a style rule. A deferred-tools client (Claude Code's own MCP loading) shows the model
 * tool names and one-line blurbs, and fetches the full description and schema only if the model
 * explicitly asks — so until it does, the first sentence *is* the description. Measured in a
 * real session: with the contracts sitting in sentence two, the model planned a `write` over an
 * existing note not knowing overwrites are version-bound, did not know `edit` refuses an
 * ambiguous match, and had no reason to prefer `list`/`recent` because it could not see they
 * download nothing. A test pins each first sentence so a rewrite cannot quietly demote one.
 */
export const TOOLS: ToolDescriptor[] = [
  {
    name: "search",
    title: "Search notes",
    description:
      "Search note text case-insensitively: a substring by default, or a regular expression with `regex: true`. No matches is not proof of absence — the scan is budgeted, and the result says when it could not cover everything." +
      AGENT_NOTE_POINTER,
    inputSchema: {
      type: "object",
      properties: {
        query: str("Text to look for."),
        regex: {
          type: "boolean",
          description:
            "Treat the query as a regular expression (default false). Slower: regular expressions cannot use the index, so the search always falls back to the budgeted scan.",
        },
        context: int(
          `Lines of context either side of each match, like grep -C (default ${CONTEXT_DEFAULT}, cap ${CONTEXT_MAX}). Use 0 for matched lines only — the right choice when harvesting paths or matching structure, where context is noise.`
        ),
        folder: str("Restrict to a folder, subfolders included, e.g. \"Projects\"."),
        glob: str("Optional path glob, e.g. \"Daily/**\" or \"**/*.md\". ANDed with folder when both are given."),
        max_results: int("Maximum hits to return (default 20, cap 100)."),
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: READS,
  },
  {
    name: "read",
    title: "Read a note",
    description:
      "Read one note, returning its text with line numbers added for reference — they are display only and are not part of the note.",
    inputSchema: {
      type: "object",
      properties: {
        path: str("Exact vault path, case-sensitive, e.g. \"Projects/Roadmap.md\"."),
        offset: int("1-based line to start at (default 1)."),
        limit: int("Lines to return (default 400, cap 2000)."),
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: READS,
  },
  {
    name: "list",
    title: "List notes",
    description:
      "List note paths with sizes and modification times, downloading no note content." +
      AGENT_NOTE_POINTER,
    inputSchema: {
      type: "object",
      properties: {
        folder: str("Folder to list, subfolders included, e.g. \"Daily\"."),
        glob: str("Optional path glob, e.g. \"**/*.md\". ANDed with folder when both are given."),
        max_results: int("Maximum paths to return (default 200, cap 1000)."),
      },
      additionalProperties: false,
    },
    annotations: READS,
  },
  {
    name: "recent",
    title: "Recently modified notes",
    description:
      "List notes modified within the last N days, newest first, downloading no note content.",
    inputSchema: {
      type: "object",
      properties: {
        days: int("How many days back to look (default 7)."),
        max_results: int("Maximum paths to return (default 100, cap 1000)."),
      },
      additionalProperties: false,
    },
    annotations: READS,
  },
  {
    name: "append",
    title: "Append to a note",
    description:
      "Append text at the very end of a note, creating it if missing; to insert mid-note use `edit`.",
    inputSchema: {
      type: "object",
      properties: {
        path: str("Exact vault path. Created if missing — a typo makes a new note rather than failing."),
        text: str("Text to append. A newline is inserted first if the note does not end with one."),
      },
      required: ["path", "text"],
      additionalProperties: false,
    },
    annotations: WRITES(false),
  },
  {
    name: "edit",
    title: "Edit a note",
    description:
      "Replace one occurrence of a string in a note, failing unless that string appears exactly once. Include enough context to make the match unique.",
    inputSchema: {
      type: "object",
      properties: {
        path: str("Exact vault path."),
        replace_all: {
          type: "boolean",
          description:
            "Replace every occurrence instead of requiring exactly one (default false). Text that appears nowhere still fails.",
        },
        old_text: str("Exact text to replace, as it appears in the note — without `read`'s line-number prefix. Must appear exactly once unless replace_all is set."),
        new_text: str("Replacement text."),
      },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
    annotations: WRITES(true),
  },
  {
    name: "write",
    title: "Create or replace a note",
    description:
      "Create a note, or replace an existing one entirely and without warning. For a partial change prefer `append` or `edit`.",
    inputSchema: {
      type: "object",
      properties: {
        path: str("Exact vault path."),
        content: str("The note's full new content."),
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    annotations: WRITES(true),
  },
  {
    name: "delete",
    title: "Delete a note",
    description:
      "Delete one note permanently; only a missing note is an error. Folders are never deleted, and a folder path is not a valid argument.",
    inputSchema: {
      type: "object",
      properties: {
        path: str("Exact vault path of the note to delete."),
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: WRITES(true),
  },
  {
    name: "move",
    title: "Move or rename a note",
    description:
      "Move one note to a path that does not already exist, which is how a rename is done. Refuses rather than replacing the destination; delete it first if that is what you want. Folders are implicit in the path — no folder is created or removed.",
    inputSchema: {
      type: "object",
      properties: {
        from: str("Exact vault path of the note to move."),
        to: str("New vault path. Must not already exist."),
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    // Not destructive: nothing is replaced or lost, because an occupied destination is refused
    // rather than overwritten. That refusal is what earns the softer hint.
    annotations: WRITES(false),
  },
];

const asString = (args: Record<string, unknown>, key: string, required = true): string => {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) throw new VaultError(`"${key}" is required`);
    return "";
  }
  if (typeof value !== "string") throw new VaultError(`"${key}" must be a string`);
  return value;
};

const asInt = (args: Record<string, unknown>, key: string, fallback: number): number => {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new VaultError(`"${key}" must be a number`);
  return Math.floor(n);
};

const optional = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key];
  return typeof value === "string" && value !== "" ? value : undefined;
};

const asBool = (args: Record<string, unknown>, key: string): boolean => {
  const value = args[key];
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  // Clients have been seen sending JSON-schema booleans as strings. Accepting the two literals
  // is cheap; accepting anything truthy would turn "false" into true, which is the wrong way
  // for a flag that widens `edit` from one occurrence to all of them.
  if (value === "true") return true;
  if (value === "false") return false;
  throw new VaultError(`"${key}" must be true or false`);
};

/** Builds the write op for a tool call, so the dispatch stays one line per tool. */
function writeOp(name: string, args: Record<string, unknown>): WriteOp {
  switch (name) {
    case "append":
      return { kind: "append", path: asString(args, "path"), text: asString(args, "text") };
    case "edit":
      return {
        kind: "edit",
        path: asString(args, "path"),
        oldText: asString(args, "old_text"),
        newText: asString(args, "new_text"),
        replaceAll: asBool(args, "replace_all"),
      };
    case "write":
      return { kind: "write", path: asString(args, "path"), content: asString(args, "content") };
    case "delete":
      return { kind: "delete", path: asString(args, "path") };
    default:
      return { kind: "move", from: asString(args, "from"), to: asString(args, "to") };
  }
}

function entryOf(files: Record<string, FileEntry>, path: string): FileEntry {
  const entry = files[path];
  if (entry !== undefined) return entry;
  const near = Object.keys(files).filter((p) => p.toLowerCase().includes(path.toLowerCase())).slice(0, 5);
  throw new VaultError(
    near.length === 0
      ? `no note at "${path}"`
      : `no note at "${path}". Did you mean: ${near.join(", ")}?`
  );
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  switch (name) {
    case "search": {
      const { files, head, policy } = await ctx.view.snapshot();
      const query = asString(args, "query");
      const folder = optional(args, "folder");
      const glob = optional(args, "glob");
      const maxResults = asInt(args, "max_results", 20);
      // DO SQLite has `LIKE` and no regular expressions, so the index cannot answer this mode
      // at all — it is the scan or nothing. Stated in the field description rather than left
      // for the caller to infer from a slow call.
      const regex = asBool(args, "regex");
      // Clamped rather than refused: an out-of-range number is a preference, not a mistake
      // worth failing a search over.
      const context = asInt(args, "context", CONTEXT_DEFAULT);

      // The index answers the whole vault with no network; the scan sees only a budget's
      // worth. Prefer the index, but only while it describes exactly this head — a stale one
      // would answer confidently about notes that have since changed.
      // Head AND policy: `files` is a function of both, so the index must be keyed on both.
      const key = `${head}|${policy}`;
      let result;
      if (!regex && ctx.index !== undefined && ctx.index.isCurrent(key)) {
        result = ctx.index.query(query, {
          folder,
          glob: glob === undefined ? null : globToRegExp(glob),
          maxResults,
          context,
        });
      } else {
        result = await search(ctx.view, files, query, { folder, glob, maxResults, regex, context });
        // Advance the index on the way out, so repeated questions converge on the complete
        // answer instead of paying for the scan forever — but out of what the scan LEFT.
        // Two separately-reasonable budgets in one invocation is how the limit gets blown.
        if (ctx.index !== undefined) {
          await ctx.index.catchUp(ctx.view, key, files, { budget: BLOB_BUDGET - result.spent });
        }
      }
      if (result.hits.length === 0) {
        const where =
          result.source === "index"
            ? `No matches across all ${result.scanned} indexed note(s).`
            : `No matches in ${result.scanned} of ${result.candidates} candidate notes.${
                result.more
                  ? " The scan hit its budget before covering the whole vault — narrow it with folder or glob."
                  : ""
              }`;
        return where;
      }
      const body = result.hits
        .map((hit) => `${hit.path}:${hit.line}\n${hit.context.map((l) => `    ${l}`).join("\n")}`)
        .join("\n\n");
      const note =
        result.source === "index"
          ? `\n\n(searched all ${result.scanned} indexed notes${result.more ? "; more matches exist than were returned — raise max_results" : ""})`
          : result.more
            ? `\n\n(scanned ${result.scanned} of ${result.candidates} candidate notes before hitting the budget — there may be more)`
            : `\n\n(scanned ${result.scanned} notes)`;
      return `${result.hits.length} match(es):\n\n${body}${note}`;
    }

    case "read": {
      const { files } = await ctx.view.snapshot();
      const path = asString(args, "path");
      const entry = entryOf(files, path);
      const bytes = await ctx.view.read(entry);
      // A note is text or it is not; guessing and returning mojibake is worse than refusing.
      if (bytes.includes(0)) {
        return `"${path}" is binary (${entry.size} bytes) and cannot be shown as text.`;
      }
      const lines = new TextDecoder().decode(bytes).split("\n");
      const offset = Math.max(1, asInt(args, "offset", 1));
      const limit = Math.max(1, Math.min(asInt(args, "limit", 400), 2000));
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const width = String(offset + slice.length - 1).length;
      const body = slice.map((l, i) => `${String(offset + i).padStart(width)}  ${l}`).join("\n");
      const truncated = offset - 1 + slice.length < lines.length;
      return [
        `${path} (${lines.length} lines)`,
        body,
        truncated ? `... ${lines.length - (offset - 1 + slice.length)} more line(s); read again with offset ${offset + slice.length}` : "",
      ]
        .filter((s) => s !== "")
        .join("\n");
    }

    case "list": {
      const { files, hidden } = await ctx.view.snapshot();
      const folder = optional(args, "folder")?.replace(/\/+$/, "");
      const glob = optional(args, "glob");
      const max = Math.max(1, Math.min(asInt(args, "max_results", 200), 1000));
      const re = glob === undefined ? null : globToRegExp(glob);
      const matched = Object.keys(files)
        .filter((p) => (folder === undefined || folder === "" ? true : p.startsWith(`${folder}/`)))
        .filter((p) => (re === null ? true : re.test(p)))
        .sort();
      const shown = matched.slice(0, max);
      const rows = shown
        .map((p) => `${p}  (${files[p].size} B, ${new Date(files[p].mtime).toISOString().slice(0, 10)})`)
        .join("\n");
      return [
        `${matched.length} note(s)${matched.length > shown.length ? `, showing ${shown.length}` : ""}`,
        rows,
        matched.length > shown.length ? `... ${matched.length - shown.length} more; raise max_results or narrow the folder` : "",
        hidden > 0 ? `(${hidden} path(s) this vault never syncs are not listed)` : "",
      ]
        .filter((s) => s !== "")
        .join("\n");
    }

    case "recent": {
      const { files } = await ctx.view.snapshot();
      const days = Math.max(1, asInt(args, "days", 7));
      const max = Math.max(1, Math.min(asInt(args, "max_results", 100), 1000));
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const recent = Object.keys(files)
        .filter((p) => files[p].mtime >= cutoff)
        .sort((a, b) => files[b].mtime - files[a].mtime)
        .slice(0, max);
      if (recent.length === 0) return `No notes modified in the last ${days} day(s).`;
      const rows = recent
        .map((p) => `${new Date(files[p].mtime).toISOString().slice(0, 16).replace("T", " ")}  ${p}`)
        .join("\n");
      return `${recent.length} note(s) modified in the last ${days} day(s):\n${rows}`;
    }

    case "append":
    case "edit":
    case "write":
    case "delete":
    case "move": {
      if (!ctx.writable) {
        throw new VaultError("this connector is read-only; it cannot change the vault");
      }
      const { summary } = await ctx.enqueue(writeOp(name, args));
      return summary;
    }

    default:
      throw new VaultError(`unknown tool "${name}"`);
  }
}
