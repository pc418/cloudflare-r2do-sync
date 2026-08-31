/**
 * Streamable HTTP MCP, hand-rolled.
 *
 * Cloudflare's `McpAgent` is deprecated and feature-frozen, and `createMcpHandler` would drag
 * in three pinned peer dependencies plus a hostname allowlist to serve a surface this small.
 * Dispatch for five methods is cheaper than the deprecation we would inherit, and it leaves
 * every header ours.
 *
 * Two decisions worth not re-litigating:
 *
 * - **Always `application/json`, never SSE.** The transport lets the *server* choose per
 *   request, and nothing here streams. This is the shape Anthropic's own stateless sample uses.
 * - **`Accept` is never checked.** The reference SDK answers 406 when `Accept` omits
 *   `text/event-stream`, and that is the single most reported interop failure with real
 *   clients. A server that never streams has nothing to negotiate.
 *
 * Sessions are likewise absent: no `Mcp-Session-Id` is issued, so there is none for a client
 * to echo and none to validate.
 */
import { TOOLS, type ToolDescriptor } from "./tools";

/** Newest first. `initialize` echoes the client's version when we know it. */
export const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const PREFERRED_VERSION = "2025-11-25";

export const SERVER_INFO = {
  name: "obsidian-vault-agent",
  title: "Obsidian vault",
  version: "1.0.0",
};

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type Id = string | number;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const ok = (id: Id, result: unknown): Response => json({ jsonrpc: "2.0", id, result });

/**
 * HTTP stays 200 for a JSON-RPC error that carries an id: the transport succeeded and the
 * envelope is the answer. Only a body we could not parse into a message at all is a 400.
 */
const fail = (id: Id | null, code: number, message: string, status = 200): Response =>
  json({ jsonrpc: "2.0", id, error: { code, message } }, status);

export interface McpHandlers {
  /** Runs one tool and returns its text. Throwing is turned into a tool-level error. */
  call: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Whether this deployment advertises the write tools. */
  writable: () => Promise<boolean>;
  /**
   * The owner's standing instructions from the vault, appended to the static preamble.
   *
   * Returns "" when there are none. It must not reject — see `initialize`.
   */
  instructions: () => Promise<string>;
}

/** What every client is told, before anything the vault has to say. */
export const STATIC_INSTRUCTIONS =
  "Notes from an Obsidian vault, end-to-end encrypted. Some tools: `recent`, `list`, `search`, `read`. Case-sensitive. `delete` and `move` act on single files only. Folders derived by paths.";

/**
 * A bound on the owner's own instructions, which ride in every context window.
 *
 * Smaller than `MAX_RESULT_CHARS` on purpose: a tool result is fetched once and read once,
 * while this is carried for the whole conversation.
 */
export const MAX_INSTRUCTION_CHARS = 8_000;

/**
 * A self-imposed bound on one tool result, not a documented client limit — Anthropic
 * publishes none for connectors, and the figures that circulate belong to a different
 * surface. It exists so a `read` of a pathological note degrades into a stated truncation
 * rather than an oversized response the client handles however it likes.
 */
const MAX_RESULT_CHARS = 120_000;

export async function handleMcp(request: Request, handlers: McpHandlers): Promise<Response> {
  // Both are optional in the spec, and the spec itself sanctions refusing them: this server
  // offers no server-initiated stream and holds no session to tear down.
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
  }

  let message: unknown;
  try {
    message = await request.json();
  } catch {
    return fail(null, PARSE_ERROR, "request body is not JSON", 400);
  }

  const msg = message as { jsonrpc?: unknown; method?: unknown; id?: Id | null; params?: unknown };
  if (msg === null || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return fail(msg?.id ?? null, INVALID_REQUEST, "not a JSON-RPC 2.0 request", 400);
  }

  // A notification has no id and MUST NOT be answered with a JSON-RPC response.
  if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202 });
  const id = msg.id;
  const params = (msg.params ?? {}) as Record<string, unknown>;

  try {
    switch (msg.method) {
      case "initialize": {
        const asked = params.protocolVersion;
        return ok(id, {
          // The rule is: echo the requested version when we support it, otherwise answer with
          // one we do. Echoing is what keeps an older client working.
          protocolVersion:
            typeof asked === "string" && SUPPORTED_VERSIONS.includes(asked) ? asked : PREFERRED_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: await instructionsFor(handlers),
        });
      }

      case "ping":
        return ok(id, {});

      case "tools/list": {
        const writable = await handlers.writable();
        const tools = TOOLS.filter((t) => writable || t.annotations.readOnlyHint).map(descriptorFor);
        return ok(id, { tools });
      }

      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string") {
          return fail(id, INVALID_PARAMS, "params.name must be a string");
        }
        if (!TOOLS.some((t) => t.name === name)) {
          return fail(id, INVALID_PARAMS, `Unknown tool: ${name}`);
        }
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        try {
          const text = await handlers.call(name, args);
          return ok(id, { content: [{ type: "text", text: clamp(text) }] });
        } catch (error) {
          // The tool ran and failed. That is not a protocol fault: the model should see why
          // and is often able to fix it (a wrong path, a non-unique edit anchor). A JSON-RPC
          // error would be terminal to the client and tell the model nothing.
          return ok(id, {
            content: [{ type: "text", text: clamp(messageOf(error)) }],
            isError: true,
          });
        }
      }

      default:
        return fail(id, METHOD_NOT_FOUND, `method not found: ${msg.method}`);
    }
  } catch (error) {
    return fail(id, INTERNAL_ERROR, messageOf(error));
  }
}

function descriptorFor(tool: ToolDescriptor): Record<string, unknown> {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  };
}

/**
 * The static preamble plus whatever the vault's own instructions note says.
 *
 * **Fail-soft, deliberately, and the opposite of every other rule here.** A missing preference
 * is an inconvenience; a rejected `initialize` stops the connector attaching at all, and the
 * very next tool call surfaces the real error anyway. So any failure serves the static string.
 */
async function instructionsFor(handlers: McpHandlers): Promise<string> {
  let owner: string;
  try {
    owner = await handlers.instructions();
  } catch {
    return STATIC_INSTRUCTIONS;
  }
  const body = owner.trim();
  if (body === "") return STATIC_INSTRUCTIONS;
  const bounded =
    body.length <= MAX_INSTRUCTION_CHARS
      ? body
      : `${body.slice(0, MAX_INSTRUCTION_CHARS)}\n\n[AGENTS.md is longer than ${MAX_INSTRUCTION_CHARS} characters and was cut here — shorten it so the rest is not lost]`;
  return `${STATIC_INSTRUCTIONS}\n\n## Owner instructions (AGENTS.md in this vault)\n\n${bounded}`;
}

function clamp(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n\n[cut short here — ask for less: a narrower folder or glob, fewer lines, or a smaller max_results]`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
