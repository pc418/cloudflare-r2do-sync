/**
 * The OAuth front door.
 *
 * What these assert, in one line: a client that cannot send a header can still arrive at the
 * *same* bearer, and cannot arrive anywhere without typing it. Everything else here is the
 * machinery that makes those two true.
 */
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

const BEARER = "test-mcp-bearer";
const ORIGIN = "https://agent.test";
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
/** RFC 7636 wants 43-128 unreserved characters. Anything shorter is now refused. */
const VERIFIER = "verifier-that-is-long-enough-to-satisfy-rfc7636-abc";
const OTHER_VERIFIER = "a-different-verifier-also-long-enough-for-rfc7636-xy";

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let raw = "";
  for (const byte of view) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const challengeFor = async (verifier: string): Promise<string> =>
  b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));

const form = (path: string, fields: Record<string, string>) =>
  SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });

const authorizeUrl = (challenge: string, over: Record<string, string> = {}) => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: "mcp-test",
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "opaque-state",
    ...over,
  });
  return `${ORIGIN}/oauth/authorize?${params.toString()}`;
};

/** Walks the flow the way a client does, and returns the code it was handed. */
async function codeFor(verifier: string): Promise<string> {
  const challenge = await challengeFor(verifier);
  const page = await SELF.fetch(authorizeUrl(challenge));
  expect(page.status).toBe(200);

  const granted = await form("/oauth/authorize", {
    response_type: "code",
    client_id: "mcp-test",
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "opaque-state",
    token: BEARER,
  });
  expect(granted.status).toBe(302);
  const back = new URL(granted.headers.get("location") ?? "");
  expect(back.searchParams.get("state")).toBe("opaque-state");
  const code = back.searchParams.get("code");
  expect(code).not.toBeNull();
  return code ?? "";
}

describe("discovery", () => {
  it("names this resource and this origin as its authorization server", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const res = await SELF.fetch(`${ORIGIN}${path}`);
      expect(res.status).toBe(200);
      const body = await res.json<{ resource: string; authorization_servers: string[] }>();
      expect(body.resource).toBe(`${ORIGIN}/mcp`);
      expect(body.authorization_servers).toEqual([ORIGIN]);
    }
  });

  it("advertises PKCE S256, dynamic registration and offline_access", async () => {
    const res = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
    const body = await res.json<{
      issuer: string;
      registration_endpoint: string;
      code_challenge_methods_supported: string[];
      scopes_supported: string[];
    }>();
    expect(body.issuer).toBe(ORIGIN);
    expect(body.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    // Without this a client treats the connection as expiring and drops it.
    expect(body.scopes_supported).toContain("offline_access");
  });

  it("does not claim to be an OpenID provider", async () => {
    // Serving a partial OIDC document breaks a strict client harder than a 404 does.
    expect((await SELF.fetch(`${ORIGIN}/.well-known/openid-configuration`)).status).toBe(404);
  });

  it("points an unauthenticated MCP caller at the metadata document", async () => {
    const res = await SELF.fetch(`${ORIGIN}/mcp`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`
    );
  });

  it("answers the /mcp preflight before the bearer check, and exposes the challenge", async () => {
    // A preflight carries no credential by definition, so a 401 here means a browser client
    // never sends the real request and never reads the challenge naming this server.
    const pre = await SELF.fetch(`${ORIGIN}/mcp`, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");

    const denied = await SELF.fetch(`${ORIGIN}/mcp`, { method: "POST", body: "{}" });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("access-control-allow-origin")).toBe("*");
    expect(denied.headers.get("access-control-expose-headers")).toContain("www-authenticate");
  });

  it("answers CORS preflight, because some clients discover from a browser", async () => {
    const res = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`, {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("registration", () => {
  const register = (redirect_uris: string[]) =>
    SELF.fetch(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "test", redirect_uris }),
    });

  it("issues a client id for a known client's redirect", async () => {
    const res = await register([REDIRECT]);
    expect(res.status).toBe(201);
    const body = await res.json<{ client_id: string; token_endpoint_auth_method: string }>();
    expect(body.client_id).toMatch(/^mcp-/);
    expect(body.token_endpoint_auth_method).toBe("none");
  });

  it("accepts a loopback redirect, which is the only way to exercise this locally", async () => {
    expect((await register(["http://127.0.0.1:6274/oauth/callback"])).status).toBe(201);
  });

  it("refuses a redirect that would deliver the code somewhere else", async () => {
    for (const uri of [
      "https://evil.example/cb",
      "http://chatgpt.com/cb", // plain http off-loopback
      "https://chatgpt.com.evil.example/cb",
      "https://user:pass@chatgpt.com/cb",
      "not a url",
    ]) {
      const res = await register([uri]);
      expect(res.status, uri).toBe(400);
      expect((await res.json<{ error: string }>()).error).toBe("invalid_redirect_uri");
    }
  });

  it("refuses a registration with no usable callback", async () => {
    // A 201 with an empty `redirect_uris` tells a client it registered, and it then fails
    // somewhere less informative. RFC 7591 requires them for the authorization-code grant.
    for (const body of ["not json", "[]", '{"client_name":"x"}', '{"redirect_uris":[]}', '{"redirect_uris":[42]}']) {
      const res = await SELF.fetch(`${ORIGIN}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status, body).toBe(400);
      expect((await res.json<{ error: string }>()).error).toBe("invalid_client_metadata");
    }
  });

  it("refuses an oversized registration body", async () => {
    const res = await SELF.fetch(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(70 * 1024),
    });
    expect(res.status).toBe(413);
  });
});

describe("authorize", () => {
  it("renders a consent screen that asks for the token", async () => {
    const res = await SELF.fetch(authorizeUrl(await challengeFor(VERIFIER)));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('name="token"');
    // Never states what is behind it: /health and the random script suffix exist so a
    // stranger who finds the hostname learns nothing, and this is the one browsable route.
    expect(html.toLowerCase()).not.toContain("vault");
    expect(html.toLowerCase()).not.toContain("obsidian");
    expect(html).not.toContain(BEARER);
  });

  it("requires PKCE S256", async () => {
    const challenge = await challengeFor(VERIFIER);
    const broken: Record<string, string>[] = [{ code_challenge: "" }, { code_challenge_method: "plain" }];
    for (const over of broken) {
      const res = await SELF.fetch(authorizeUrl(challenge, over));
      expect(res.status).toBe(400);
    }
  });

  it("refuses an unknown redirect_uri rather than redirecting to it", async () => {
    const res = await SELF.fetch(
      authorizeUrl(await challengeFor(VERIFIER), {
        redirect_uri: "https://evil.example/cb",
      })
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("does not auto-approve: a wrong token gets the form back, not a code", async () => {
    const challenge = await challengeFor(VERIFIER);
    const res = await form("/oauth/authorize", {
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "opaque-state",
      token: "not-the-token",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("not accepted");
    // The rejected value must not come back in a hidden field on the re-render.
    expect(html).not.toContain("not-the-token");
  });
});

describe("token", () => {
  const exchange = (fields: Record<string, string>) => form("/oauth/token", fields);

  it("hands back the same bearer the MCP endpoint validates", async () => {
    const verifier = VERIFIER;
    const code = await codeFor(verifier);
    const res = await exchange({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: "mcp-test",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json<{ access_token: string; token_type: string; refresh_token: string }>();
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token).toBe(BEARER);
    expect(body.refresh_token).toBe(BEARER);
  });

  it("the token it issues actually works on /mcp", async () => {
    const verifier = VERIFIER;
    const code = await codeFor(verifier);
    const granted = await exchange({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    const { access_token } = await granted.json<{ access_token: string }>();

    const res = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("refuses a code redeemed with the wrong verifier", async () => {
    const code = await codeFor(VERIFIER);
    const res = await exchange({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: OTHER_VERIFIER,
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe("invalid_grant");
  });

  it("refuses a code redeemed with NO verifier, which is what a stateless code rests on", async () => {
    // The omission, not a substitution. An absent `code_verifier` reads as "" and hashes to a
    // real digest, so without a syntax check a flow whose challenge was S256("") redeems with
    // no proof of possession at all — PKCE advertised in the metadata and absent in fact.
    const code = await codeFor(VERIFIER);
    const omitted: Record<string, string>[] = [
      { grant_type: "authorization_code", code, redirect_uri: REDIRECT },
      { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: "" },
    ];
    for (const fields of omitted) {
      const res = await exchange(fields);
      expect(res.status).toBe(400);
      expect((await res.json<{ error: string }>()).error).toBe("invalid_grant");
    }
  });

  it("cannot redeem a code whose challenge was S256 of the empty string", async () => {
    // The degenerate flow the verifier syntax check exists for. `S256("")` is 43 legal
    // characters, so it passes as a challenge — but the only verifier that hashes to it is
    // `""`, which is now refused, so the code is simply unspendable. That is the whole hole:
    // without the check, omitting `code_verifier` would have redeemed it.
    const code = await codeFor("");
    const res = await exchange({ grant_type: "authorization_code", code, redirect_uri: REDIRECT });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe("invalid_grant");
  });

  it("refuses a malformed challenge at /authorize, before a code exists", async () => {
    for (const challenge of ["", "short", "a".repeat(200), `${"a".repeat(42)}/+=`]) {
      expect((await SELF.fetch(authorizeUrl(challenge))).status, challenge.slice(0, 12)).toBe(400);
    }
  });

  it("refuses a code redeemed against a different redirect_uri", async () => {
    const verifier = VERIFIER;
    const code = await codeFor(verifier);
    const res = await exchange({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_verifier: verifier,
    });
    expect((await res.json<{ error: string }>()).error).toBe("invalid_grant");
  });

  it("refuses a forged or tampered code", async () => {
    const verifier = VERIFIER;
    const code = await codeFor(verifier);
    const [payload, signature] = code.split(".");
    // A payload swapped for one the holder wrote, keeping a signature that was valid for the
    // original. This is the whole reason the code is signed.
    const forged = b64url(
      new TextEncoder().encode(
        JSON.stringify({ cc: await challengeFor("mine"), ru: REDIRECT, exp: 4_102_444_800 })
      )
    );
    for (const bad of [`${forged}.${signature ?? ""}`, `${payload ?? ""}.aaaa`, "garbage", ""]) {
      const res = await exchange({
        grant_type: "authorization_code",
        code: bad,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      });
      expect(res.status, bad.slice(0, 16)).toBe(400);
      expect((await res.json<{ error: string }>()).error).toBe("invalid_grant");
    }
  });

  it("refreshes only for the real token", async () => {
    const good = await exchange({ grant_type: "refresh_token", refresh_token: BEARER });
    expect((await good.json<{ access_token: string }>()).access_token).toBe(BEARER);

    const bad = await exchange({ grant_type: "refresh_token", refresh_token: "nope" });
    expect(bad.status).toBe(400);
    expect((await bad.json<{ error: string }>()).error).toBe("invalid_grant");
  });

  it("rejects an unsupported grant and a GET", async () => {
    const res = await exchange({ grant_type: "client_credentials" });
    expect((await res.json<{ error: string }>()).error).toBe("unsupported_grant_type");
    expect((await SELF.fetch(`${ORIGIN}/oauth/token`)).status).toBe(405);
  });
});

describe("routing", () => {
  it("404s an unknown OAuth path instead of falling through to the MCP handler", async () => {
    const res = await SELF.fetch(`${ORIGIN}/oauth/userinfo`);
    expect(res.status).toBe(404);
  });

  it("leaves every other path exactly as it was", async () => {
    expect((await SELF.fetch(`${ORIGIN}/health`)).status).toBe(200);
    expect((await SELF.fetch(`${ORIGIN}/nope`)).status).toBe(404);
  });
});
