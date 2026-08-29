/**
 * The whole tool surface.
 *
 * Contracts deliberately mirror Claude Code's native tools — the shapes models are most
 * trained on — because that, plus paging and line anchors, is what makes a remote tool feel
 * native. The transport is irrelevant to the model.
 *
 * Deliberately absent: `delete` and `move` (where unattended accidents live), anything that
 * runs a command, and any editor/cursor tool (structurally impossible remotely).
 */
import { globToRegExp } from "../../plugin/src/paths";
import type { FileEntry } from "../../plugin/src/types";
import { search } from "./search";
import { VaultError, type VaultView } from "./vault";
import type { WriteOp } from "./write";

export interface ToolContext {
  view: VaultView;
  /** Queues a write for the current batch and resolves when that batch is committed. */
  enqueue: (op: WriteOp) => Promise<{ head: string; summary: string }>;
  /** False on a read-only deployment: the write tools are then not even advertised. */
  writable: boolean;
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

export const TOOLS: ToolDescriptor[] = [
  {
    name: "search",
    title: "Search notes",
    description:
      "Search the vault's note text for a substring (case-insensitive). Returns path:line hits with surrounding context. Scans newest notes first within a fixed budget and reports when it could not scan everything.",
    inputSchema: {
      type: "object",
      properties: {
        query: str("Text to look for. Case-insensitive substring, not a regular expression."),
        folder: str("Optional folder to restrict the search to, e.g. \"Projects\"."),
        glob: str("Optional path glob, e.g. \"Daily/**\" or \"**/*.md\"."),
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
      "Read one note by its exact vault path. Returns line-numbered text. Use offset and limit to page through a long note.",
    inputSchema: {
      type: "object",
      properties: {
        path: str("Exact vault path, e.g. \"Projects/Roadmap.md\"."),
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
      "List note paths with their sizes and modification times. Costs no note downloads. Use it to find exact paths before reading.",
    inputSchema: {
      type: "object",
      properties: {
        folder: str("Optional folder to list, e.g. \"Daily\"."),
        glob: str("Optional path glob, e.g. \"**/*.md\"."),
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
      "List notes modified within the last N days, newest first. Reads only snapshot metadata, so it costs no note downloads.",
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
      "Append text to a note, creating it if it does not exist. This is the capture tool — use it for quick notes, journal entries and additions.",
    inputSchema: {
      type: "object",
      properties: {
        path: str("Exact vault path. Created if missing."),
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
      "Replace one unique occurrence of a string in a note. Fails if the string appears zero or several times, so include enough surrounding context to make it unique.",
    inputSchema: {
      type: "object",
      properties: {
        path: str("Exact vault path."),
        old_text: str("Exact text to replace. Must appear exactly once in the note."),
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
      "Create a note, or replace one entirely. To replace an existing note you must pass expected_hash from a prior read, so an overwrite is bound to the version you actually saw.",
    inputSchema: {
      type: "object",
      properties: {
        path: str("Exact vault path."),
        content: str("The note's full new content."),
        expected_hash: str("The hash reported by `read`. Required when replacing an existing note."),
      },
      required: ["path", "content"],
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

/** `head at kmnpqrs` — every result that touched a head names it, so a session is auditable. */
const shortSnapshot = (head: string): string => head.slice(-8).toLowerCase();

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
      const { files, head } = await ctx.view.snapshot();
      const result = await search(ctx.view, files, asString(args, "query"), {
        folder: optional(args, "folder"),
        glob: optional(args, "glob"),
        maxResults: asInt(args, "max_results", 20),
      });
      if (result.hits.length === 0) {
        return `No matches in ${result.scanned} of ${result.candidates} candidate notes.${
          result.more ? " The scan hit its budget before covering the whole vault — narrow it with folder or glob." : ""
        }\nhead at ${shortSnapshot(head)}`;
      }
      const body = result.hits
        .map((hit) => `${hit.path}:${hit.line}\n${hit.context.map((l) => `    ${l}`).join("\n")}`)
        .join("\n\n");
      const note = result.more
        ? `\n\n(scanned ${result.scanned} of ${result.candidates} candidate notes before hitting the budget — there may be more)`
        : `\n\n(scanned ${result.scanned} notes)`;
      return `${result.hits.length} match(es):\n\n${body}${note}\nhead at ${shortSnapshot(head)}`;
    }

    case "read": {
      const { files, head } = await ctx.view.snapshot();
      const path = asString(args, "path");
      const entry = entryOf(files, path);
      const bytes = await ctx.view.read(entry);
      // A note is text or it is not; guessing and returning mojibake is worse than refusing.
      if (bytes.includes(0)) {
        return `"${path}" is binary (${entry.size} bytes) and cannot be shown as text.\nhead at ${shortSnapshot(head)}`;
      }
      const lines = new TextDecoder().decode(bytes).split("\n");
      const offset = Math.max(1, asInt(args, "offset", 1));
      const limit = Math.max(1, Math.min(asInt(args, "limit", 400), 2000));
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const width = String(offset + slice.length - 1).length;
      const body = slice.map((l, i) => `${String(offset + i).padStart(width)}  ${l}`).join("\n");
      const truncated = offset - 1 + slice.length < lines.length;
      return [
        `${path} (${lines.length} lines, hash ${entry.h.slice(0, 12)})`,
        body,
        truncated ? `... ${lines.length - (offset - 1 + slice.length)} more line(s); read again with offset ${offset + slice.length}` : "",
        `head at ${shortSnapshot(head)}`,
      ]
        .filter((s) => s !== "")
        .join("\n");
    }

    case "list": {
      const { files, head, hidden } = await ctx.view.snapshot();
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
        `head at ${shortSnapshot(head)}`,
      ]
        .filter((s) => s !== "")
        .join("\n");
    }

    case "recent": {
      const { files, head } = await ctx.view.snapshot();
      const days = Math.max(1, asInt(args, "days", 7));
      const max = Math.max(1, Math.min(asInt(args, "max_results", 100), 1000));
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const recent = Object.keys(files)
        .filter((p) => files[p].mtime >= cutoff)
        .sort((a, b) => files[b].mtime - files[a].mtime)
        .slice(0, max);
      if (recent.length === 0) return `No notes modified in the last ${days} day(s).\nhead at ${shortSnapshot(head)}`;
      const rows = recent
        .map((p) => `${new Date(files[p].mtime).toISOString().slice(0, 16).replace("T", " ")}  ${p}`)
        .join("\n");
      return `${recent.length} note(s) modified in the last ${days} day(s):\n${rows}\nhead at ${shortSnapshot(head)}`;
    }

    case "append":
    case "edit":
    case "write": {
      if (!ctx.writable) {
        throw new VaultError("this connector is read-only; it cannot change the vault");
      }
      const path = asString(args, "path");
      let op: WriteOp;
      if (name === "append") op = { kind: "append", path, text: asString(args, "text") };
      else if (name === "edit") {
        op = {
          kind: "edit",
          path,
          oldText: asString(args, "old_text"),
          newText: asString(args, "new_text"),
        };
      } else {
        op = {
          kind: "write",
          path,
          content: asString(args, "content"),
          expectedHash: optional(args, "expected_hash"),
        };
      }
      const { head, summary } = await ctx.enqueue(op);
      return `${summary}\nhead at ${shortSnapshot(head)}`;
    }

    default:
      throw new VaultError(`unknown tool "${name}"`);
  }
}
