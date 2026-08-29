/**
 * The agent Worker: a remote MCP server that reads (and optionally captures into) one vault.
 *
 * It is a *separate script* from the sync Worker on purpose. The sync Worker keeps its
 * property of never seeing plaintext; only this one holds the master key. Deleting this script
 * and revoking one token kills the whole feature, and a bug in MCP handling cannot reach
 * commit serialisation.
 */
import { handleMcp } from "./mcp";
import type { AgentEnv } from "./env";

export { AgentState } from "./agent-state";

/**
 * Constant-time compare, so a wrong bearer cannot be discovered a byte at a time.
 *
 * `crypto.subtle.timingSafeEqual` needs equal lengths, and comparing lengths first leaks only
 * the length — which a token's own format already tells an attacker.
 */
function tokensMatch(presented: string, expected: string): boolean {
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

const unauthorized = (): Response =>
  new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="mcp"' },
  });

export default {
  async fetch(request: Request, env: AgentEnv): Promise<Response> {
    const url = new URL(request.url);

    // Unauthenticated, and deliberately says nothing about the vault: it exists so a deploy
    // can be smoke-tested the same way the sync Worker's is.
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "obsidian-vault-agent" });
    }

    if (url.pathname !== "/mcp" && url.pathname !== "/admin/index") {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    // Before anything is parsed. "None" is never acceptable on this endpoint — it fronts a
    // process holding the vault's master key.
    const header = request.headers.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (env.MCP_BEARER === undefined || env.MCP_BEARER === "") return unauthorized();
    if (presented === "" || !tokensMatch(presented, env.MCP_BEARER)) return unauthorized();

    // One instance, so the decrypted path map is shared across a burst and writes serialise.
    const state = env.AGENT.getByName("default");

    /**
     * Drop or inspect the search index. Behind the same bearer as the tools, which is not a
     * widening: that bearer already commands every tool. The index holds nothing that is not
     * in R2, so dropping it costs a rebuild and loses nothing.
     */
    if (url.pathname === "/admin/index") {
      if (request.method === "GET") return Response.json(await state.indexStatus());
      if (request.method === "DELETE") return Response.json(await state.dropIndex());
      return new Response("method not allowed", { status: 405, headers: { allow: "GET, DELETE" } });
    }

    return handleMcp(request, {
      call: (name, args) => state.call(name, args),
      writable: () => state.writable(),
    });
  },
};
