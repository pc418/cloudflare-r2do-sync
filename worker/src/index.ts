import { Hono } from "hono";
import type { Context } from "hono";
import { VaultLock } from "./vault-lock";
import { checkBlobs, getBlob, putBlob } from "./blobs";
import { runGc } from "./gc";
import { ULID_RE } from "./manifest";
import {
  MAX_SETTINGS_BYTES,
  SETTINGS_KEY,
  type SettingsDoc,
  settingsDocSchema,
} from "./settings";

export { VaultLock };

export interface Env {
  VAULT: R2Bucket;
  VAULT_LOCK: DurableObjectNamespace<VaultLock>;
  ADMIN_TOKEN: string;
}

type AppEnv = { Bindings: Env; Variables: { tokenId: string } };

const app = new Hono<AppEnv>();

const errJson = (code: string, message: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message },
  ...extra,
});

function bearer(c: Context<AppEnv>): string | null {
  const h = c.req.header("authorization");
  return h?.startsWith("Bearer ") ? h.slice("Bearer ".length) : null;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.byteLength !== eb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ea, eb);
}

const vault = (env: Env) => env.VAULT_LOCK.getByName("default");

const SETTINGS_PUT_ATTEMPTS = 5;

type SettingsPutResult =
  | { ok: true }
  | { ok: false; code: "vault_salt_conflict" | "write_contended" };

/**
 * Keep ordinary settings last-writer-wins while making vaultSalt write-once.
 * Conditional R2 writes close the read/write race between concurrent devices.
 */
async function putSettings(env: Env, incoming: SettingsDoc): Promise<SettingsPutResult> {
  for (let attempt = 0; attempt < SETTINGS_PUT_ATTEMPTS; attempt++) {
    const existingObj = await env.VAULT.get(SETTINGS_KEY);
    let existing: SettingsDoc | null = null;
    if (existingObj !== null) {
      const stored = settingsDocSchema.safeParse(await existingObj.json());
      if (!stored.success) throw new Error("stored shared settings document is invalid");
      existing = stored.data;
    }

    if (
      existing?.vaultSalt !== undefined &&
      incoming.vaultSalt !== undefined &&
      incoming.vaultSalt !== existing.vaultSalt
    ) {
      return { ok: false, code: "vault_salt_conflict" };
    }

    const next =
      existing?.vaultSalt !== undefined && incoming.vaultSalt === undefined
        ? { ...incoming, vaultSalt: existing.vaultSalt }
        : incoming;
    const written = await env.VAULT.put(SETTINGS_KEY, JSON.stringify(next), {
      httpMetadata: { contentType: "application/json" },
      onlyIf:
        existingObj === null
          ? { etagDoesNotMatch: "*" }
          : { etagMatches: existingObj.etag },
    });
    if (written !== null) return { ok: true };
  }
  return { ok: false, code: "write_contended" };
}

app.get("/health", (c) => c.json({ ok: true }));

// --- admin routes -----------------------------------------------------------

const adminAuth = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  const token = bearer(c);
  if (token === null) return c.json(errJson("unauthorized", "missing bearer token"), 401);
  if (!timingSafeEqualStr(token, c.env.ADMIN_TOKEN)) {
    // A valid *access* token on an admin route is a role violation, not a bad login.
    const tokenId = await vault(c.env).verifyToken(token);
    if (tokenId !== null) return c.json(errJson("forbidden", "access tokens cannot administer tokens"), 403);
    return c.json(errJson("unauthorized", "invalid token"), 401);
  }
  await next();
};

app.get("/api/tokens", adminAuth, async (c) => {
  return c.json({ tokens: await vault(c.env).listTokens() });
});

app.post("/api/tokens", adminAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(errJson("bad_json", "request body must be JSON"), 400);
  }
  const name = (body as { name?: unknown })?.name;
  if (typeof name !== "string" || name.length === 0 || name.length > 64) {
    return c.json(errJson("invalid_name", "name must be a 1-64 char string"), 422);
  }
  const token = await vault(c.env).mintToken(name);
  return c.json(token, 201);
});

app.delete("/api/tokens/:id", adminAuth, async (c) => {
  const revoked = await vault(c.env).revokeToken(c.req.param("id") ?? "");
  if (!revoked) return c.json(errJson("not_found", "no active token with that id"), 404);
  return c.body(null, 204);
});

// --- vault routes (access token) ----------------------------------------------------------

const accessAuth = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  const token = bearer(c);
  if (token === null) return c.json(errJson("unauthorized", "missing bearer token"), 401);
  const tokenId = await vault(c.env).verifyToken(token);
  if (tokenId === null) return c.json(errJson("unauthorized", "invalid or revoked token"), 401);
  c.set("tokenId", tokenId);
  await next();
};

app.get("/api/head", accessAuth, async (c) => {
  return c.json({ head: await vault(c.env).getHead() });
});

app.get("/api/manifests/:id", accessAuth, async (c) => {
  const id = c.req.param("id") ?? "";
  if (!ULID_RE.test(id)) return c.json(errJson("bad_id", "manifest id must be a ULID"), 422);
  const obj = await c.env.VAULT.get(`manifests/${id}.json`);
  if (obj === null) return c.json(errJson("not_found", "unknown manifest"), 404);
  return new Response(obj.body, { headers: { "content-type": "application/json" } });
});

app.get("/api/settings", accessAuth, async (c) => {
  const obj = await c.env.VAULT.get(SETTINGS_KEY);
  if (obj === null) return c.json(errJson("not_found", "no shared settings document"), 404);
  return new Response(obj.body, { headers: { "content-type": "application/json" } });
});

app.put("/api/settings", accessAuth, async (c) => {
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_SETTINGS_BYTES) {
    return c.json(errJson("too_large", `settings document exceeds ${MAX_SETTINGS_BYTES} bytes`), 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json(errJson("bad_json", "request body must be JSON"), 400);
  }
  const parsed = settingsDocSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json(errJson("invalid_settings", `${issue.path.join(".") || "document"}: ${issue.message}`), 422);
  }
  const result = await putSettings(c.env, parsed.data);
  if (!result.ok) {
    if (result.code === "vault_salt_conflict") {
      return c.json(
        errJson("vault_salt_conflict", "vaultSalt is already established and cannot be changed"),
        409
      );
    }
    return c.json(errJson("write_contended", "settings changed repeatedly; retry the request"), 503);
  }
  return c.json({ ok: true });
});

app.post("/api/blobs/check", accessAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(errJson("bad_json", "request body must be JSON"), 400);
  }
  const result = await checkBlobs(c.env, (body as { hashes?: unknown })?.hashes);
  if (!result.ok) return c.json(errJson("invalid_hashes", result.message), 422);
  return c.json({ missing: result.missing });
});

app.put("/api/blobs/:hash", accessAuth, async (c) => {
  const result = await putBlob(c.env, c.req.param("hash") ?? "", c.req.raw);
  if (!result.ok) {
    const status = result.code === "too_large" ? 413 : result.code === "length_required" ? 411 : 422;
    return c.json(errJson(result.code, result.message), status);
  }
  return c.json({ existed: result.existed }, result.existed ? 200 : 201);
});

app.get("/api/blobs/:hash", accessAuth, async (c) => {
  const obj = await getBlob(c.env, c.req.param("hash") ?? "");
  if (obj === null) return c.json(errJson("not_found", "unknown blob"), 404);
  return new Response(obj.body, { headers: { "content-type": "application/octet-stream" } });
});

app.post("/api/commit", accessAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(errJson("bad_json", "request body must be JSON"), 400);
  }
  const { manifest, expectedHead, reroot } = (body ?? {}) as {
    manifest?: unknown;
    expectedHead?: unknown;
    reroot?: unknown;
  };
  if (expectedHead !== null && typeof expectedHead !== "string") {
    return c.json(errJson("invalid_expected_head", "expectedHead must be a string or explicit null"), 422);
  }
  // Discarding every earlier snapshot is not something a client should be able to ask for by
  // accident, so it is an explicit boolean rather than an inference from `parent: null`.
  if (reroot !== undefined && typeof reroot !== "boolean") {
    return c.json(errJson("invalid_reroot", "reroot must be a boolean"), 422);
  }
  const result = await vault(c.env).commit(manifest, expectedHead, { reroot: reroot === true });
  if (result.ok) return c.json({ head: result.head });
  switch (result.code) {
    case "stale_head":
      return c.json(errJson("stale_head", "head moved; pull, merge, and re-commit", { head: result.head }), 409);
    case "missing_blob":
      return c.json(errJson("missing_blob", "upload missing blobs first", { hashes: result.hashes }), 422);
    case "invalid_manifest":
      return c.json(errJson("invalid_manifest", result.message), 422);
  }
});

app.notFound((c) => c.json(errJson("not_found", "no such route"), 404));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const report = await runGc(env);
    console.log("gc report", JSON.stringify(report));
  },
};
