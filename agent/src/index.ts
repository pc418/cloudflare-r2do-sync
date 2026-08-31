/**
 * The agent Worker: a remote MCP server that reads (and optionally captures into) one vault.
 *
 * It is a *separate script* from the sync Worker on purpose. The sync Worker keeps its
 * property of never seeing plaintext; only this one holds the master key. Deleting this script
 * and revoking one token kills the whole feature, and a bug in MCP handling cannot reach
 * commit serialisation.
 */
import { handleMcp } from "./mcp";
import { handleOAuth, unauthorized, withCors, CORS } from "./oauth";
import { tokensMatch } from "./bearer";
import { resolveZone } from "./tz";
import type { AgentEnv } from "./env";

export { AgentState } from "./agent-state";

export default {
  async fetch(request: Request, env: AgentEnv): Promise<Response> {
    const url = new URL(request.url);

    // Before the routing below, because these paths are neither `/mcp` nor `/health` and
    // would otherwise 404. They are unauthenticated by necessity: a client discovers where to
    // sign in *because* it has no credential yet. Nothing here hands anything over without
    // the bearer being typed into the consent screen. Returns null for every other path.
    const oauth = await handleOAuth(request, env);
    if (oauth !== null) return oauth;

    // Unauthenticated, and deliberately says nothing at all: it exists so a deploy can be
    // smoke-tested the same way the sync Worker's is, and nothing more.
    //
    // It used to answer `service: "obsidian-vault-agent"`, which confirmed for anyone who
    // found the hostname that they had found the endpoint fronting a vault master key. The
    // smoke test only ever read `ok`, so the string bought nothing and told a scanner
    // everything. The script name carries a random suffix for the same reason.
    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    // A browser client must preflight before it may attach the Authorization header, and a
    // preflight carries no credential — so this answers before the bearer check below. It
    // grants nothing: this Worker has no cookies, so a wildcard origin lets a page do only
    // what it could already do holding a bearer it does not have.
    if (request.method === "OPTIONS" && (url.pathname === "/mcp" || url.pathname === "/admin/index")) {
      return new Response(null, { status: 204, headers: CORS });
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
    if (env.MCP_BEARER === undefined || env.MCP_BEARER === "") return unauthorized(request);
    if (presented === "" || !tokensMatch(presented, env.MCP_BEARER)) return unauthorized(request);

    // One instance, so the decrypted path map is shared across a burst and writes serialise.
    const state = env.AGENT.getByName("default");

    /**
     * Drop or inspect the search index. Behind the same bearer as the tools, which is not a
     * widening: that bearer already commands every tool. The index holds nothing that is not
     * in R2, so dropping it costs a rebuild and loses nothing.
     */
    if (url.pathname === "/admin/index") {
      if (request.method === "GET") return withCors(Response.json(await state.indexStatus()));
      if (request.method === "DELETE") return withCors(Response.json(await state.dropIndex()));
      return new Response("method not allowed", { status: 405, headers: { allow: "GET, DELETE" } });
    }

    return withCors(await handleMcp(request, {
      call: (name, args) => state.call(name, args),
      writable: () => state.writable(),
      instructions: () => state.instructions(),
      timezone: resolveZone(env.AGENT_TZ),
    }));
  },
};
