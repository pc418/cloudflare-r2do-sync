import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

const BEARER = "test-mcp-bearer";

const post = (body: unknown, token: string | null = BEARER) =>
  SELF.fetch("https://agent.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

describe("the agent Worker's edge", () => {
  it("serves an unauthenticated health check, saying nothing about the vault", async () => {
    const res = await SELF.fetch("https://agent.test/health");
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; service: string }>();
    // Bare, on purpose: this endpoint is unauthenticated, and naming the service confirmed
    // to anyone who found the hostname that it fronts a vault master key.
    expect(body).toEqual({ ok: true });
    expect(JSON.stringify(body)).not.toContain(BEARER);
  });

  it("401s with a WWW-Authenticate challenge when the bearer is missing or wrong", async () => {
    for (const token of [null, "wrong-token", ""]) {
      const res = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, token);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    }
  });

  it("rejects a bearer that is merely a prefix of the real one", async () => {
    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, BEARER.slice(0, -1))).status).toBe(401);
  });

  it("authenticates before parsing, so a bad body from a stranger is still a 401", async () => {
    const res = await SELF.fetch("https://agent.test/mcp", { method: "POST", body: "{garbage" });
    expect(res.status).toBe(401);
  });

  it("404s an unknown path", async () => {
    expect((await SELF.fetch("https://agent.test/", { method: "POST" })).status).toBe(404);
  });

  it("405s a GET on the MCP endpoint, which is a valid connector probe", async () => {
    const res = await SELF.fetch("https://agent.test/mcp", {
      headers: { authorization: `Bearer ${BEARER}` },
    });
    expect(res.status).toBe(405);
  });

  it("completes the initialize handshake", async () => {
    const res = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-ai", version: "0.1.0" } },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ result: { protocolVersion: string } }>();
    expect(body.result.protocolVersion).toBe("2025-11-25");
  });

  it("lists only read tools, because this deployment has no write credential", async () => {
    const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const body = await res.json<{ result: { tools: { name: string }[] } }>();
    expect(body.result.tools.map((t) => t.name)).toEqual(["search", "recent", "read", "list"]);
  });

  it("accepts the initialized notification with 202", async () => {
    const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
  });
});
