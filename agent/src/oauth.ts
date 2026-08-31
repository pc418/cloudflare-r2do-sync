/**
 * OAuth 2.1, in front of the same static bearer.
 *
 * **Why this exists at all.** The credential this server actually checks is one header:
 * `Authorization: Bearer <64 hex>`. Codex and Claude Code can send it. ChatGPT cannot — its
 * developer-mode app form offers OAuth, No Authentication and Mixed, and has no field for a
 * custom header — and neither can a Claude account without the gated request-headers beta. So
 * the choice was between an OAuth front door and putting the secret in the URL path.
 *
 * What this is: the discovery, registration, authorize and token endpoints those clients
 * expect, ending in a handoff of **the same bearer** as the access token. `/mcp` is untouched
 * and still validates exactly one thing, so there is no second authentication path to keep
 * correct — a client that can send the header still may, and gets the identical result.
 *
 * **The gate is the token itself.** `/authorize` renders a consent screen that asks for it and
 * compares in constant time. This is the one decision not to relax: every naive shim of this
 * shape auto-approves `/authorize`, which converts a bearer-protected server into an open one
 * for anyone who learns the hostname. Nothing here is a user database; the secret is the whole
 * of the authorization.
 *
 * State: none. Authorization codes are HMAC-signed with a key derived from the bearer and
 * expire in five minutes, so no KV or DO row is needed to issue or verify one. A code is
 * therefore replayable within its window by whoever holds it — which is why PKCE S256 is
 * *required* rather than merely supported: the code alone is useless without the verifier.
 */
import type { AgentEnv } from "./env";
import { tokensMatch } from "./bearer";
import { readBounded } from "./mcp";

/** Five minutes, the ceiling OAuth 2.1 recommends for an authorization code. */
const CODE_TTL_SECONDS = 300;

/**
 * The largest form or registration body these routes will read.
 *
 * They are unauthenticated by necessity — discovery and registration happen before anyone has
 * proved anything — so they get the same treatment `/mcp` gets, one size down. A token request
 * is a few hundred bytes.
 */
const MAX_OAUTH_BODY_BYTES = 64 * 1024;

/**
 * Hosts whose `https` redirect URIs are accepted.
 *
 * A redirect URI is where an authorization code is delivered, so an open list would let anyone
 * who completes the consent screen route the code somewhere else. The consent screen already
 * requires the bearer, so this is defence in depth rather than the primary control — but it is
 * the difference between "you must know the secret" and "you must know the secret *and* be one
 * of these clients".
 */
const REDIRECT_HOSTS = [
  "chatgpt.com",
  "www.chatgpt.com",
  "openai.com",
  "platform.openai.com",
  "claude.ai",
  "www.claude.ai",
  "claude.com",
];

/**
 * Loopback, which RFC 8252 permits over plain http because the response never leaves the
 * machine. This is what lets the flow be exercised with the MCP Inspector — and a client
 * running on the owner's own desktop has nowhere else to put its callback.
 */
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1"];

/**
 * RFC 7636 §4.1: 43-128 characters from the unreserved set, for both the verifier and the
 * challenge derived from it.
 *
 * Checked on the *verifier* before it is hashed, which is the part that matters. An absent
 * `code_verifier` otherwise reads as `""` and hashes to a real digest — so a flow whose
 * challenge was `S256("")` redeems with no proof of possession at all, and PKCE is advertised
 * in the metadata while being absent in fact. A legitimate client never does this, which is
 * exactly why it must be refused: the flows that would are the tampered ones.
 */
const PKCE_SYNTAX = /^[A-Za-z0-9\-._~]{43,128}$/;

const encoder = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let raw = "";
  for (const byte of view) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/**
 * The signing key for authorization codes.
 *
 * Derived from the bearer with a domain string rather than being the bearer, so the value that
 * signs codes is not the value handed to clients. HMAC never reveals its key, so this is
 * hygiene rather than a fix — but the two uses have different lifetimes and should not come to
 * share a secret by accident.
 */
async function codeKey(bearer: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(`obsidian-agent/oauth-code ${bearer}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function signCode(bearer: string, payload: string): Promise<string> {
  return b64url(await crypto.subtle.sign("HMAC", await codeKey(bearer), encoder.encode(payload)));
}

async function s256(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", encoder.encode(verifier)));
}

/**
 * Discovery is fetched by a browser in some clients, so these routes answer preflight and
 * carry permissive CORS. They expose no secret: each is a constant document, or a flow that
 * ends at the consent screen.
 */
export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version",
  // Without this a browser client cannot read the challenge that tells it where to sign in.
  "access-control-expose-headers": "www-authenticate",
};

/**
 * The same headers on an MCP response.
 *
 * A browser-based client preflights `/mcp` before it may attach the Authorization header, and a
 * preflight carries no credential by definition — so the answer has to come before the bearer
 * check, or the real request is never sent and the 401 that would have named the authorization
 * server is unreadable. Nothing is granted by this: there are no cookies anywhere in this
 * Worker, so a wildcard origin lets a page do exactly what it could already do with a bearer it
 * does not have.
 */
export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...headers },
  });

const oauthError = (error: string, description: string, status = 400): Response =>
  json({ error, error_description: description }, status);

/**
 * The 401 `/mcp` answers, carrying the pointer a client follows to find this authorization
 * server (RFC 9728, and the MCP authorization spec from 2025-06-18 on).
 *
 * Without `resource_metadata` a client that *could* do OAuth has no way to learn where to
 * start, and reports a bad token instead of offering to sign in.
 */
export function unauthorized(request: Request): Response {
  const base = new URL(request.url).origin;
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": `Bearer realm="mcp", resource_metadata="${base}/.well-known/oauth-protected-resource"`,
      ...CORS,
    },
  });
}

export function redirectAllowed(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  // A fragment is forbidden on a redirect URI, and embedded credentials would send the code to
  // whatever the authority resolves to rather than to the host that was checked.
  if (parsed.hash !== "" || parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.protocol === "http:") return LOOPBACK_HOSTS.includes(parsed.hostname);
  if (parsed.protocol !== "https:") return false;
  return REDIRECT_HOSTS.includes(parsed.hostname);
}

interface CodePayload {
  /** `code_challenge`, S256. */
  cc: string;
  /** `redirect_uri`, re-checked at the token endpoint. */
  ru: string;
  /** Absolute expiry, epoch seconds. */
  exp: number;
}

async function issueCode(bearer: string, payload: CodePayload): Promise<string> {
  const body = b64url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await signCode(bearer, body)}`;
}

async function readCode(bearer: string, code: string): Promise<CodePayload | null> {
  const dot = code.indexOf(".");
  if (dot <= 0) return null;
  const body = code.slice(0, dot);
  const signature = code.slice(dot + 1);
  if (!tokensMatch(signature, await signCode(bearer, body))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const { cc, ru, exp } = parsed as Partial<CodePayload>;
  if (typeof cc !== "string" || typeof ru !== "string" || typeof exp !== "number") return null;
  if (exp < Math.floor(Date.now() / 1000)) return null;
  return { cc, ru, exp };
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * The consent screen.
 *
 * Deliberately says nothing about what is behind it. The rest of this Worker goes out of its
 * way not to confirm to a stranger that the hostname fronts a vault master key — `/health`
 * answers `{ok:true}` and nothing else, and the script name carries a random suffix — and a
 * page announcing the vault would undo that for the one route a browser can reach.
 */
function consentPage(params: URLSearchParams, error?: string): Response {
  const hidden = [...params.entries()]
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n  ");

  return new Response(
    `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize this connector</title>
<style>
 body{font:16px/1.5 ui-sans-serif,system-ui,sans-serif;max-width:26rem;margin:12vh auto;padding:0 1.5rem}
 input[type=password]{width:100%;padding:.6rem;font:inherit;font-family:ui-monospace,monospace;box-sizing:border-box}
 button{margin-top:1rem;padding:.6rem 1.2rem;font:inherit;cursor:pointer}
 .err{color:#b00020}
</style>
<h1>Authorize this connector</h1>
<p>Paste the connector token to allow this client access.</p>
${error === undefined ? "" : `<p class="err">${escapeHtml(error)}</p>`}
<form method="POST">
  ${hidden}
  <input type="password" name="token" autocomplete="off" autofocus placeholder="64 hex characters">
  <button type="submit">Authorize</button>
</form>`,
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // The page carries the secret in a form field: nothing may frame it, and nothing it
        // loads or posts to may be off-origin.
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
      },
    }
  );
}

/**
 * The whole OAuth surface. Returns `null` for anything that is not one of these routes, so the
 * caller falls through to the MCP handler unchanged.
 */
export async function handleOAuth(request: Request, env: AgentEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/.well-known/oauth-") && !path.startsWith("/oauth/")) return null;

  // A bearer that is absent or empty means the deployment is misconfigured. `/mcp` already
  // refuses everything in that state, and a flow ending in a token nobody can use would be
  // worse than a plain refusal.
  const bearer = env.MCP_BEARER;
  if (bearer === undefined || bearer === "") {
    return oauthError("server_error", "this deployment has no connector token", 503);
  }

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const base = url.origin;

  // RFC 9728 — which authorization server protects this resource. Both spellings: clients
  // written before the path-insertion rule ask for the bare one.
  if (
    path === "/.well-known/oauth-protected-resource" ||
    path === "/.well-known/oauth-protected-resource/mcp"
  ) {
    return json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp", "offline_access"],
    });
  }

  // RFC 8414 — authorization server metadata. `openid-configuration` is deliberately not
  // served: this is not an OpenID provider, and an incomplete OIDC document breaks a strict
  // client harder than a 404 does.
  if (
    path === "/.well-known/oauth-authorization-server" ||
    path === "/.well-known/oauth-authorization-server/mcp"
  ) {
    return json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      // `offline_access` is advertised so a client asks for a refresh token. Without one it
      // treats the connection as expiring and drops it, though this token never expires.
      scopes_supported: ["mcp", "offline_access"],
    });
  }

  if (path === "/oauth/register") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    // RFC 7591. This server is single-tenant: there is one credential and it is not issued
    // here, so a client id is a formality and registration checks only the thing that matters
    // — where a code would be delivered.
    const body = await readBounded(request, MAX_OAUTH_BODY_BYTES);
    if (body === null) return oauthError("invalid_request", "registration body is too large", 413);
    const uris = redirectUrisOf(body);
    if (uris === null) {
      return oauthError(
        "invalid_client_metadata",
        "redirect_uris must be a non-empty array of strings"
      );
    }
    const rejected = uris.filter((uri) => !redirectAllowed(uri));
    if (rejected.length > 0) return oauthError("invalid_redirect_uri", rejected.join(", "));
    return json(
      {
        client_id: `mcp-${b64url(crypto.getRandomValues(new Uint8Array(12)))}`,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201
    );
  }

  if (path === "/oauth/authorize") {
    if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed("GET, POST");

    let params: URLSearchParams;
    if (request.method === "POST") {
      const body = await readBounded(request, MAX_OAUTH_BODY_BYTES);
      if (body === null) return oauthError("invalid_request", "form body is too large", 413);
      params = new URLSearchParams(body);
    } else {
      params = url.searchParams;
    }

    const redirectUri = params.get("redirect_uri") ?? "";
    const challenge = params.get("code_challenge") ?? "";
    const state = params.get("state") ?? "";

    // Both failures are answered here rather than by redirecting with an error, because the
    // redirect target is precisely what is in question.
    if (!redirectAllowed(redirectUri)) {
      return oauthError("invalid_request", "redirect_uri is missing or not an accepted address");
    }
    if (params.get("code_challenge_method") !== "S256" || !PKCE_SYNTAX.test(challenge)) {
      return oauthError("invalid_request", "PKCE with code_challenge_method=S256 is required");
    }

    if (request.method === "GET") return consentPage(params);

    const presented = (params.get("token") ?? "").trim();
    if (!tokensMatch(presented, bearer)) {
      params.delete("token");
      return consentPage(params, "That token was not accepted.");
    }

    const code = await issueCode(bearer, {
      cc: challenge,
      ru: redirectUri,
      exp: Math.floor(Date.now() / 1000) + CODE_TTL_SECONDS,
    });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    if (state !== "") back.searchParams.set("state", state);
    return new Response(null, {
      status: 302,
      headers: { location: back.toString(), "cache-control": "no-store" },
    });
  }

  if (path === "/oauth/token") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const body = await readBounded(request, MAX_OAUTH_BODY_BYTES);
    if (body === null) return oauthError("invalid_request", "form body is too large", 413);
    const form = new URLSearchParams(body);
    const grant = form.get("grant_type");

    if (grant === "refresh_token") {
      // The refresh token *is* the bearer, so refreshing is a no-op that keeps a client which
      // insists on expiry from dropping the connection.
      if (!tokensMatch(form.get("refresh_token") ?? "", bearer)) {
        return oauthError("invalid_grant", "unknown refresh token");
      }
      return tokenResponse(bearer);
    }

    if (grant !== "authorization_code") {
      return oauthError(
        "unsupported_grant_type",
        "only authorization_code and refresh_token are accepted"
      );
    }

    const payload = await readCode(bearer, form.get("code") ?? "");
    if (payload === null) {
      return oauthError("invalid_grant", "the authorization code is invalid or expired");
    }
    if (payload.ru !== form.get("redirect_uri")) {
      return oauthError("invalid_grant", "redirect_uri does not match the one the code was issued for");
    }
    const verifier = form.get("code_verifier") ?? "";
    if (!PKCE_SYNTAX.test(verifier) || !tokensMatch(await s256(verifier), payload.cc)) {
      return oauthError("invalid_grant", "code_verifier does not match the code_challenge");
    }
    return tokenResponse(bearer);
  }

  // An unknown `/oauth/*` or `/.well-known/oauth-*` path. Answered here rather than falling
  // through, so a typo in a discovery URL reads as a missing route and not as a missing tool.
  return json({ error: "not found" }, 404);
}

function methodNotAllowed(allow: string): Response {
  return json({ error: "method_not_allowed" }, 405, { allow });
}

/**
 * The handoff: the access token is the bearer `/mcp` already validates.
 *
 * That is the entire point of this file. There is no second credential to store, revoke or keep
 * in step — `--rotate-bearer` remains the one operation that changes what works, and it
 * invalidates outstanding authorization codes too, because the signing key is derived from it.
 */
function tokenResponse(bearer: string): Response {
  return json(
    {
      access_token: bearer,
      token_type: "Bearer",
      // A year. The token does not expire; a client that reads a missing `expires_in` as
      // "already expired" is the only reason to state one.
      expires_in: 31_536_000,
      refresh_token: bearer,
      scope: "mcp offline_access",
    },
    200,
    { "cache-control": "no-store", pragma: "no-cache" }
  );
}

/**
 * The registered callbacks, or `null` if the body is not a registration.
 *
 * `null` rather than an empty array, so a malformed body cannot pass the allow-list check by
 * having nothing in it to reject and come back 201 with a client id and no usable callback.
 * `redirect_uris` is required by RFC 7591 for the authorization-code grant, and a client that
 * is told it registered successfully fails later, somewhere less informative.
 */
function redirectUrisOf(body: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const value = (parsed as { redirect_uris?: unknown }).redirect_uris;
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((uri): uri is string => typeof uri === "string")) return null;
  return value;
}
