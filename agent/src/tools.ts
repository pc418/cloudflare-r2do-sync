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
import { daysBefore, formatDay, formatMinute, civilIn, localMidnight, instantOf, UTC, weekdayOf } from "./tz";
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
  /**
   * The vault's timezone, an IANA name. Every rendered date and every day boundary uses it.
   *
   * Optional because absent means UTC — the same fail-soft the binding has, so a fixture that
   * does not care about zones reads exactly as it did before this existed.
   */
  tz?: string;
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
 * The fallback for a client that drops `initialize.instructions`.
 *
 * Claude Desktop does, measured 2026-08-31: no server instructions block reaches the model at
 * any point, and the conventions arrive only through tool descriptions. (Claude Code delivers
 * them fine — clients differ, so the surviving channel is the one to design for.)
 *
 * On **every** tool, not the two entry points it started on. That guess was wrong: a session
 * can open with `recent`, `read` or `append` just as easily as with `search`, and a pointer the
 * model never loads is no pointer. Nine copies is the price of the only channel that survives,
 * which is exactly why it is this short: the supersession clause was traded for brevity
 * (owner, 2026-08-31) — "first" carries the priority, and a vault with no `AGENTS.md` pays one
 * cheap filesystem-shaped "no note" answer for it.
 *
 * Never in the first 80 characters — that budget belongs to the tool's own contract. Static
 * text, because a vault-dependent descriptor would put a snapshot read inside `tools/list`.
 * The supersession clause exists because a client caches `initialize` while the note can be
 * rewritten mid-session, and it is scoped to *vault* conventions so a synced note never reads
 * as authority over the chat.
 */
const AGENT_NOTE_POINTER =
  " Read `AGENTS.md` first.";

/**
 * Ordered by how often a tool is reached for, and every contract inside 80 characters.
 *
 * **The order** is orientation first (`search`, `recent`, `read`, `list`), then mutation by
 * blast radius (`append`, `edit`, `write`, `move`, `delete`). Frequency is not the criterion —
 * first-glance value is: `recent` answers "what has this person been working on", which is the
 * question that comes *before* knowing what to search for, while `delete`/`move`/`append` are
 * reached for only once the model already knows what it is doing.
 *
 * It is `tools/list` order, which some clients honour and the two we have measured (Claude
 * Code, Claude Desktop) both discard in favour of alphabetical. It costs nothing and is right
 * wherever it is read, so it stays — but **do not rely on it to put anything in front of a
 * model**. Under an alphabetical sort the only lever left is the description itself, which is
 * why `recent` leads with why you would reach for it rather than with what it returns.
 *
 * **The 80 characters is the real constraint.** A deferred-tools client lists each tool as one
 * truncated line and fetches the full description only if the model asks — Claude Desktop cuts
 * at roughly 80 characters, mid-word. Measured before this rule existed: with contracts sitting
 * in sentence two, a model planned a `write` over an existing note not knowing overwrites were
 * version-bound, did not know `edit` refuses an ambiguous match, and had no reason to prefer
 * `list`/`recent` because it could not see they download nothing. Moving them to sentence one
 * was not enough — `edit` still arrived as "…failing unless that string appear…", cut mid-word,
 * while a test that capped the *sentence* at 200 characters passed throughout. The test now
 * asserts the contract survives an 80-character truncation, which is what the model actually
 * receives.
 */
export const TOOLS: ToolDescriptor[] = [
  {
    name: "search",
    title: "Search notes",
    description:
      "Substring by default, or pass `regex: true`. Case-insensitive." +
      AGENT_NOTE_POINTER,
    inputSchema: {
      type: "object",
      properties: {
        query: str("Text to search."),
        regex: {
          type: "boolean",
          description:
            "Parse regex (default false). Budgeted.",
        },
        context: int(
          `Lines of context either side, like grep -C (default ${CONTEXT_DEFAULT}; cap ${CONTEXT_MAX}).`
        ),
        folder: str("In folder, recursive, e.g. \"Projects\"."),
        glob: str("Optional path glob, e.g. \"Daily/**\" or \"**/*.md\". Could pass with folder."),
        max_results: int("Maximum hits to return (default 20, cap 100)."),
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: READS,
  },
  {
    name: "recent",
    title: "Recently modified notes",
    description:
      "List notes changed in N days, newest first." +
      AGENT_NOTE_POINTER,
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
    name: "read",
    title: "Read a note",
    description:
      "Line numbers are display only. Pass offset and limit for sections." +
      AGENT_NOTE_POINTER,
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
      "List note paths, sizes and times." +
      AGENT_NOTE_POINTER,
    inputSchema: {
      type: "object",
      properties: {
        sort: {
          type: "string",
          enum: ["path", "modified", "size"],
          description:
            "Order (default \"path\"). Path A-Z, modified newest first, size largest first. Keeps sorted first-N.",
        },
        modified_after: str(
          "At or after. ISO 8601 or \"last tuesday\". Vault-local midnight."
        ),
        modified_before: str(
          "Strictly before, exclusive. ISO 8601 or \"last tuesday\". Vault-local."
        ),
        folder: str("Folder to list, subfolders included, e.g. \"Daily\"."),
        glob: str("Optional path glob, e.g. \"**/*.md\". ANDed with folder when both are given."),
        max_results: int("Maximum paths to return (default 200, cap 1000)."),
      },
      additionalProperties: false,
    },
    annotations: READS,
  },
  {
    name: "append",
    title: "Append to a note",
    description:
      "Creating if missing." +
      AGENT_NOTE_POINTER,
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
      "Replace one string in a note; fails unless it appears exactly once. Include enough context to make the match unique, or pass replace_all." +
      AGENT_NOTE_POINTER,
    inputSchema: {
      type: "object",
      properties: {
        path: str("Exact vault path."),
        replace_all: {
          type: "boolean",
          description:
            "Replace every occurrence (default false).",
        },
        old_text: str("Exact text to replace. Pass `replace_all` for multiple occurrences."),
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
      "Create a note, or overwrite if exists." +
      AGENT_NOTE_POINTER,
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
    name: "move",
    title: "Move or rename a note",
    description:
      "Folders are derived from path. Cannot overwrite." +
      AGENT_NOTE_POINTER,
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
  {
    name: "delete",
    title: "Delete a note",
    description:
      "Delete a note. Folders are derived from path." +
      AGENT_NOTE_POINTER,
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

/** Sunday-first, matching `Date.getUTCDay()`. */
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * `last tuesday` → that day's midnight in the vault's zone, or null if the text is not that
 * shape.
 *
 * Weekday grammar only. A model frequently does not know today's date, so asking it to compute
 * `2026-08-25` invites an answer it cannot check; naming the weekday moves the arithmetic to
 * the side that owns a clock. Wider grammars ("3 days ago", "last month") are deliberately
 * absent — ISO 8601 already covers anything precise, and each extra form is another way to be
 * ambiguous about a boundary.
 *
 * **Never today**: on a Tuesday, `last tuesday` is seven days back, not this morning.
 *
 * Which weekday it *is* is read in the zone too, not in UTC — for most of the day those are
 * different answers, and the one the owner means is the one on their own wall.
 */
export function lastWeekday(text: string, now: number, zone: string = UTC): number | null {
  const m = /^last\s+(\w+)$/.exec(text.trim().toLowerCase());
  if (m === null) return null;
  const target = WEEKDAYS.indexOf(m[1]);
  if (target === -1) return null;
  const today = civilIn(zone, now);
  const back = ((weekdayOf(today.year, today.month, today.day) - target + 6) % 7) + 1;
  // Step by calendar days and *then* resolve to an instant. Subtracting 24h from a timestamp
  // lands an hour out either side of a DST transition; a date has no such problem.
  const day = daysBefore(today.year, today.month, today.day, back);
  return localMidnight(zone, day.year, day.month, day.day);
}

/** A date or datetime carrying no offset of its own — the shapes that mean *local*. */
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * A bound from the arguments, or null.
 *
 * Three readings, in order: `last <weekday>`; a bare date or naive datetime, which means that
 * time on the vault's own clock; anything else, which `Date.parse` handles and which therefore
 * keeps whatever offset it stated. So `2026-08-01` is that calendar day where the owner is,
 * while `2026-08-01T12:00:00Z` is the instant it names, everywhere.
 */
function when(args: Record<string, unknown>, key: string, zone: string): number | null {
  const raw = optional(args, key);
  if (raw === undefined) return null;
  const weekday = lastWeekday(raw, Date.now(), zone);
  if (weekday !== null) return weekday;
  const naive = NAIVE.exec(raw.trim());
  if (naive !== null) {
    return instantOf(zone, {
      year: Number(naive[1]),
      month: Number(naive[2]),
      day: Number(naive[3]),
      hour: naive[4] === undefined ? 0 : Number(naive[4]),
      minute: naive[5] === undefined ? 0 : Number(naive[5]),
      second: naive[6] === undefined ? 0 : Number(naive[6]),
    });
  }
  const at = Date.parse(raw);
  if (Number.isNaN(at)) {
    throw new VaultError(
      `"${key}" is not a date I can read: "${raw}". Use ISO 8601 ("2026-08-01", "2026-08-01T12:00:00Z") or "last tuesday".`
    );
  }
  return at;
}

/**
 * Comparators for `list`, with **direction baked into the key**.
 *
 * `ls` priors: paths A-Z, `-t` newest first, `-S` largest first. A separate `order` flag would
 * be the speculative knob the simplicity rule bans — reversing at most 1,000 returned rows is
 * the caller's own business. Path is the tie-break everywhere, so the order is total and a
 * listing never shuffles between identical calls.
 */
const SORTS: Record<string, (files: Record<string, FileEntry>) => (a: string, b: string) => number> = {
  path: () => (a, b) => a.localeCompare(b),
  modified: (files) => (a, b) => files[b].mtime - files[a].mtime || a.localeCompare(b),
  size: (files) => (a, b) => files[b].size - files[a].size || a.localeCompare(b),
};

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
            ? `No match in all ${result.scanned} searched.`
            : `No match in ${result.scanned}/${result.candidates} searched${
                result.more ? ", budget hit — no answer, not no match" : ""
              }.`;
        return where;
      }
      const body = result.hits
        .map((hit) => `${hit.path}:${hit.line}\n${hit.context.map((l) => `    ${l}`).join("\n")}`)
        .join("\n\n");
      const note =
        result.source === "index"
          ? `\n\n(all ${result.scanned} searched${result.more ? "; more matches than returned — raise max_results" : ""})`
          : result.more
            ? `\n\n(${result.scanned}/${result.candidates} searched, budget hit)`
            : `\n\n(${result.scanned} searched)`;
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
      const sort = optional(args, "sort") ?? "path";
      if (!Object.hasOwn(SORTS, sort)) {
        throw new VaultError(`"sort" must be one of ${Object.keys(SORTS).join(", ")}`);
      }
      // Half-open [after, before): `after` inclusive, `before` exclusive, so consecutive
      // ranges tile with no overlap and no gap.
      const zone = ctx.tz ?? UTC;
      const after = when(args, "modified_after", zone);
      const before = when(args, "modified_before", zone);
      const matched = Object.keys(files)
        .filter((p) => (folder === undefined || folder === "" ? true : p.startsWith(`${folder}/`)))
        .filter((p) => (re === null ? true : re.test(p)))
        .filter((p) => (after === null ? true : files[p].mtime >= after))
        .filter((p) => (before === null ? true : files[p].mtime < before))
        .sort(SORTS[sort](files));
      // After the sort, never before: a cut listing is then a meaningful top-N rather than an
      // arbitrary slice that happened to be alphabetically first.
      const shown = matched.slice(0, max);
      const rows = shown
        .map((p) => `${p}  (${files[p].size} B, ${formatDay(zone, files[p].mtime)})`)
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
      // A rolling now-N*24h window, deliberately: "the last 7 days" is a duration, not seven
      // calendar days. Only the stamps below are rendered on the vault's clock.
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const matched = Object.keys(files)
        .filter((p) => files[p].mtime >= cutoff)
        .sort((a, b) => files[b].mtime - files[a].mtime);
      if (matched.length === 0) return `No notes modified in the last ${days} day(s).`;
      // The count is of what MATCHED, never of what fitted. Reporting the truncated length as
      // the total is a listing lying about its own coverage, to a reader with no other source.
      const shown = matched.slice(0, max);
      const rows = shown
        .map((p) => `${formatMinute(ctx.tz ?? UTC, files[p].mtime)}  ${p}`)
        .join("\n");
      return [
        `${matched.length} note(s) modified in the last ${days} day(s)${matched.length > shown.length ? `, showing ${shown.length}` : ""}:`,
        rows,
        matched.length > shown.length ? `... ${matched.length - shown.length} more; raise max_results` : "",
      ]
        .filter((line) => line !== "")
        .join("\n");
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
