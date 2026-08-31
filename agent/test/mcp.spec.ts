import { describe, it, expect } from "vitest";
import {
  handleMcp,
  MAX_INSTRUCTION_CHARS,
  PREFERRED_VERSION,
  STATIC_INSTRUCTIONS,
  SUPPORTED_VERSIONS,
  type McpHandlers,
} from "../src/mcp";

const rpc = async (
  body: unknown,
  handlers: Partial<McpHandlers> = {},
  init: RequestInit = {}
): Promise<Response> =>
  handleMcp(
    new Request("https://agent.test/mcp", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    }),
    {
      call: handlers.call ?? (async () => "ok"),
      writable: handlers.writable ?? (async () => false),
      instructions: handlers.instructions ?? (async () => ""),
    }
  );

const req = (method: string, params?: unknown, id: string | number = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

describe("initialize", () => {
  it("echoes a protocol version it supports", async () => {
    for (const version of SUPPORTED_VERSIONS) {
      const res = await rpc(req("initialize", { protocolVersion: version, capabilities: {} }));
      const body = await res.json<{ result: { protocolVersion: string } }>();
      expect(body.result.protocolVersion).toBe(version);
    }
  });

  it("answers with its own version when the client asks for one it does not know", async () => {
    const res = await rpc(req("initialize", { protocolVersion: "1999-01-01" }));
    const body = await res.json<{ result: { protocolVersion: string; serverInfo: { name: string } } }>();
    expect(body.result.protocolVersion).toBe(PREFERRED_VERSION);
    expect(body.result.serverInfo.name).toBe("obsidian-vault-agent");
  });

  it("declares the tools capability", async () => {
    const res = await rpc(req("initialize", {}));
    const body = await res.json<{ result: { capabilities: Record<string, unknown> } }>();
    expect(body.result.capabilities).toMatchObject({ tools: { listChanged: false } });
  });
});

describe("transport", () => {
  it("answers JSON, never SSE", async () => {
    const res = await rpc(req("ping"));
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  // Answering 406 when `Accept` omits text/event-stream is the single most reported MCP
  // interop failure. A server that never streams has nothing to negotiate, so it must not care.
  it("serves a client that accepts only JSON", async () => {
    const res = await rpc(req("ping"), {}, { headers: { accept: "application/json" } });
    expect(res.status).toBe(200);
  });

  it("serves a client that sends no Accept header at all", async () => {
    const res = await rpc(req("ping"));
    expect(res.status).toBe(200);
  });

  it("refuses GET and DELETE with 405, which the spec sanctions", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await handleMcp(new Request("https://agent.test/mcp", { method }), {
        call: async () => "",
        writable: async () => false,
        instructions: async () => "",
      });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  it("answers a notification with 202 and no body, never a JSON-RPC response", async () => {
    const res = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("responds to ping with an empty result", async () => {
    const body = await (await rpc(req("ping"))).json<{ result: unknown }>();
    expect(body.result).toEqual({});
  });
});

describe("errors", () => {
  it("400s a body that is not JSON, as a parse error", async () => {
    const res = await rpc("{not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: -32700 } });
  });

  it("400s a message that is not JSON-RPC 2.0", async () => {
    const res = await rpc({ id: 1, method: "ping" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: -32600 } });
  });

  it("reports an unknown method as -32601, over HTTP 200", async () => {
    const res = await rpc(req("resources/list"));
    // The transport succeeded; the envelope carries the failure.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ error: { code: -32601 } });
  });

  it("reports an unknown tool as -32602", async () => {
    const res = await rpc(req("tools/call", { name: "rm_rf", arguments: {} }));
    expect(await res.json()).toMatchObject({ error: { code: -32602, message: /Unknown tool/ } });
  });

  it("reports a missing tool name as -32602", async () => {
    expect(await (await rpc(req("tools/call", { arguments: {} }))).json()).toMatchObject({
      error: { code: -32602 },
    });
  });

  // The dividing line: a tool that RAN and failed is a result the model can act on, not a
  // protocol fault. A JSON-RPC error would be terminal to the client and teach the model nothing.
  it("returns a tool failure as isError, not as a JSON-RPC error", async () => {
    const res = await rpc(req("tools/call", { name: "read", arguments: { path: "nope.md" } }), {
      call: async () => {
        throw new Error('no note at "nope.md"');
      },
    });
    const body = await res.json<{ result: { isError: boolean; content: { text: string }[] }; error?: unknown }>();
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("no note at");
  });

  it("preserves the request id on every answer", async () => {
    const body = await (await rpc(req("ping", undefined, "abc-123"))).json<{ id: string }>();
    expect(body.id).toBe("abc-123");
  });
});

describe("tools/list", () => {
  it("advertises only the read tools on a read-only deployment", async () => {
    const res = await rpc(req("tools/list"), { writable: async () => false });
    const body = await res.json<{ result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } }>();
    expect(body.result.tools.map((t) => t.name)).toEqual(["search", "recent", "read", "list"]);
    expect(body.result.tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });

  it("advertises the write tools once a write credential exists", async () => {
    const res = await rpc(req("tools/list"), { writable: async () => true });
    const body = await res.json<{ result: { tools: { name: string; title: string }[] } }>();
    expect(body.result.tools.map((t) => t.name)).toEqual([
      "search",
      "recent",
      "read",
      "list",
      "append",
      "edit",
      "write",
      "move",
      "delete",
    ]);
    for (const tool of body.result.tools) expect(tool.title).toBeTruthy();
  });

  it("refuses a write tool call that is not advertised", async () => {
    // The gate is the tool itself, not merely the listing: a client may call anything.
    const res = await rpc(req("tools/call", { name: "append", arguments: { path: "a.md", text: "x" } }), {
      writable: async () => false,
      call: async () => {
        throw new Error("this connector is read-only; it cannot change the vault");
      },
    });
    const body = await res.json<{ result: { isError: boolean } }>();
    expect(body.result.isError).toBe(true);
  });
});

describe("owner instructions from the vault", () => {
  const initialize = async (handlers: Partial<McpHandlers>): Promise<string> => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, handlers);
    const body = (await res.json()) as { result: { instructions: string } };
    return body.result.instructions;
  };

  it("serves the static string alone when the vault has no AGENTS.md", async () => {
    // Byte-identical to what every client got before this feature existed.
    expect(await initialize({ instructions: async () => "" })).toBe(STATIC_INSTRUCTIONS);
  });

  it("appends the note's body under a heading that says where it came from", async () => {
    const text = await initialize({
      instructions: async () => "Daily notes live in Daily/YYYY-MM-DD.md. Read Inbox.md first.",
    });
    expect(text.startsWith(STATIC_INSTRUCTIONS)).toBe(true);
    expect(text).toContain("## Owner instructions (AGENTS.md in this vault)");
    expect(text).toContain("Daily notes live in Daily/YYYY-MM-DD.md");
  });

  it("treats a whitespace-only note as no instructions", async () => {
    expect(await initialize({ instructions: async () => "   \n\n  " })).toBe(STATIC_INSTRUCTIONS);
  });

  it("clamps a pathological note rather than flooding every context window", async () => {
    const text = await initialize({
      instructions: async () => "x".repeat(MAX_INSTRUCTION_CHARS + 500),
    });
    // The notice has to say what to DO, not just that a limit exists — the agent can edit
    // AGENTS.md itself on a writable deployment, so "shorten it" is an action it can take.
    expect(text).toContain("was cut here — shorten it");
    expect(text.length).toBeLessThan(MAX_INSTRUCTION_CHARS + STATIC_INSTRUCTIONS.length + 300);
    expect(text).not.toContain("x".repeat(MAX_INSTRUCTION_CHARS + 1));
  });

  it("still answers initialize when the vault cannot be read", async () => {
    // Fail-soft is the contract here, and the opposite of every other rule in this agent. A
    // missing preference is an inconvenience; a rejected initialize stops the connector
    // attaching at all, and the next tool call surfaces the real error anyway. Pinned so
    // nobody "fixes" it closed.
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, {
      instructions: () => Promise.reject(new Error("vault unreachable")),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { instructions: string } };
    expect(body.result.instructions).toBe(STATIC_INSTRUCTIONS);
  });
});
