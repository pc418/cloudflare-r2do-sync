import { Hono } from "hono";
import type { Context } from "hono";
import { ALL_SCOPES, VaultLock, isTokenScope, type TokenScope } from "./vault-lock";
import { MAX_CHECK_BODY_BYTES, checkBlobs, getBlob, putBlob } from "./blobs";
import { gcRetention, runGc } from "./gc";
import { ULID_RE } from "./manifest";
import { logPhase } from "./timing";
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
  /** Retention window, as deployed. Strings because they arrive as plain-text bindings. */
  GC_KEEP_DAYS: string;
  GC_KEEP_COUNT: string;
}

type AppEnv = { Bindings: Env; Variables: { tokenId: string; scopes: TokenScope[] } };

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
  | { ok: true; rev: number }
  | { ok: false; code: "vault_salt_conflict" | "write_contended" }
  | { ok: false; code: "stale_revision"; rev: number };

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

    // Compare-and-set on the revision. A client that sends one is saying which document it
    // is replacing, so a replayed or stale payload is refused instead of overwriting a
    // newer policy. A client that sends none predates the rule and is stamped in sequence.
    const currentRev = existing?.rev ?? 0;
    if (incoming.rev !== undefined && incoming.rev !== currentRev + 1) {
      return { ok: false, code: "stale_revision", rev: currentRev };
    }
    const rev = currentRev + 1;

    const next = {
      ...incoming,
      rev,
      ...(existing?.vaultSalt !== undefined && incoming.vaultSalt === undefined
        ? { vaultSalt: existing.vaultSalt }
        : {}),
    };
    const written = await env.VAULT.put(SETTINGS_KEY, JSON.stringify(next), {
      httpMetadata: { contentType: "application/json" },
      onlyIf:
        existingObj === null
          ? { etagDoesNotMatch: "*" }
          : { etagMatches: existingObj.etag },
    });
    if (written !== null) return { ok: true, rev };
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
    const verified = await vault(c.env).verifyToken(token);
    if (verified !== null) return c.json(errJson("forbidden", "access tokens cannot administer tokens"), 403);
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
  const { name, scopes, expiresAt } = (body ?? {}) as {
    name?: unknown;
    scopes?: unknown;
    expiresAt?: unknown;
  };
  if (typeof name !== "string" || name.length === 0 || name.length > 64) {
    return c.json(errJson("invalid_name", "name must be a 1-64 char string"), 422);
  }
  if (scopes !== undefined) {
    if (!Array.isArray(scopes) || !scopes.every(isTokenScope)) {
      return c.json(
        errJson("invalid_scopes", `scopes must be an array drawn from ${ALL_SCOPES.join(", ")}`),
        422
      );
    }
    // An empty array reads as "no authority" and used to be silently upgraded to full. A
    // token that cannot sync cannot do anything, so refuse rather than mint a useless or
    // surprisingly powerful credential.
    if (!scopes.includes("sync")) {
      return c.json(errJson("invalid_scopes", 'scopes must include "sync"'), 422);
    }
  }
  if (expiresAt !== undefined && expiresAt !== null) {
    if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) {
      return c.json(errJson("invalid_expiry", "expiresAt must be an ISO date string or null"), 422);
    }
  }
  const token = await vault(c.env).mintToken(name, { scopes, expiresAt: expiresAt ?? null });
  return c.json(token, 201);
});

app.delete("/api/tokens/:id", adminAuth, async (c) => {
  const revoked = await vault(c.env).revokeToken(c.req.param("id") ?? "");
  if (!revoked) return c.json(errJson("not_found", "no active token with that id"), 404);
  return c.body(null, 204);
});

/**
 * Runs the sweep the daily cron runs, on demand. Cloudflare has no way to fire a deployed
 * Worker's Cron Trigger — `--test-scheduled` is a local dev server only — so without this
 * the only way to see GC work against a real vault is to wait for 04:00 and read logs after
 * the fact. Admin-only, and no new authority: the admin token already mints access tokens,
 * and this is the same `runGc` the schedule calls, under the same fenced lease.
 */
app.post("/api/gc", adminAuth, async (c) => {
  const manifests = indexChunkOf(c);
  if (manifests === undefined) {
    return c.json(errJson("invalid_manifests", "manifests must be an integer from 1 to 1000"), 422);
  }
  // Named separately from any other 500: "this deployment's retention vars are unusable" is an
  // operator's own misconfiguration and should say so rather than read as a Worker fault.
  try {
    gcRetention(c.env);
  } catch (error) {
    return c.json(
      errJson("gc_misconfigured", error instanceof Error ? error.message : String(error)),
      500
    );
  }
  const report = await runGc(c.env, manifests === null ? {} : { indexChunk: manifests });
  console.log(JSON.stringify({ event: "gc_report", trigger: "manual", ...report }));
  return c.json(report);
});

/**
 * Advances the one-time reference-index migration without running a sweep. Separate from
 * `/api/gc` because the migration is the expensive half and is bounded per call: an operator
 * can drive it to completion at whatever chunk size this Worker's CPU budget actually allows.
 */
app.post("/api/gc/index", adminAuth, async (c) => {
  const manifests = indexChunkOf(c);
  if (manifests === undefined) {
    return c.json(errJson("invalid_manifests", "manifests must be an integer from 1 to 1000"), 422);
  }
  const progress = await vault(c.env).advanceGcIndex(
    manifests === null ? {} : { maxManifests: manifests }
  );
  return c.json(progress);
});

/** `null` when unspecified, `undefined` when present but not a usable count. */
function indexChunkOf(c: Context<AppEnv>): number | null | undefined {
  const raw = c.req.query("manifests");
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 1000) return undefined;
  return value;
}

// --- vault routes (access token) ----------------------------------------------------------

const accessAuth = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  const startedAt = performance.now();
  const token = bearer(c);
  if (token === null) return c.json(errJson("unauthorized", "missing bearer token"), 401);
  const verified = await vault(c.env).verifyToken(token);
  logPhase("auth_rpc", startedAt, { authorized: verified !== null });
  if (verified === null) {
    return c.json(errJson("unauthorized", "invalid, revoked, or expired token"), 401);
  }
  // Every vault route needs `sync`. Without this the scope split was decorative: a token
  // issued for something else still read and wrote the whole vault, because only the reroot
  // branch ever looked at scopes.
  if (!verified.scopes.includes("sync")) {
    return c.json(errJson("forbidden", "this access token may not read or write the vault"), 403);
  }
  c.set("tokenId", verified.id);
  c.set("scopes", verified.scopes);
  await next();
};

app.get("/api/head", accessAuth, async (c) => {
  return c.json({ head: await vault(c.env).getHead() });
});

/**
 * The snapshot chain, so a client does not have to discover it one manifest at a time.
 *
 * Everything returned is already in the clear on a manifest envelope — id, parent, device,
 * createdAt — so this exposes nothing an access token could not read anyway, and the encrypted
 * path map is neither read nor readable here. What it removes is the round trips: the client's
 * own walk cannot know a parent without first downloading and decrypting its child.
 */
app.get("/api/history", accessAuth, async (c) => {
  const raw = c.req.query("limit");
  const limit = raw === undefined ? 50 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return c.json(errJson("invalid_limit", "limit must be an integer from 1 to 500"), 422);
  }
  return c.json(await vault(c.env).listHistory(limit));
});

app.post("/api/history/index", adminAuth, async (c) => {
  const manifests = indexChunkOf(c);
  if (manifests === undefined) {
    return c.json(errJson("invalid_manifests", "manifests must be an integer from 1 to 1000"), 422);
  }
  const progress = await vault(c.env).advanceHistoryDetail(
    manifests === null ? {} : { maxManifests: manifests }
  );
  return c.json(progress);
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
    if (result.code === "stale_revision") {
      return c.json(
        errJson("stale_revision", "settings moved; re-read them and write again", { rev: result.rev }),
        409
      );
    }
    return c.json(errJson("write_contended", "settings changed repeatedly; retry the request"), 503);
  }
  return c.json({ ok: true, rev: result.rev });
});

app.post("/api/blobs/check", accessAuth, async (c) => {
  const declaredLength = Number(c.req.header("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CHECK_BODY_BYTES) {
    return c.json(errJson("too_large", `request exceeds ${MAX_CHECK_BODY_BYTES} bytes`), 413);
  }
  let body: unknown;
  try {
    const raw = await c.req.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_CHECK_BODY_BYTES) {
      return c.json(errJson("too_large", `request exceeds ${MAX_CHECK_BODY_BYTES} bytes`), 413);
    }
    body = JSON.parse(raw) as unknown;
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
  const startedAt = performance.now();
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
  // Rerooting is the only operation that makes remote content stop existing, so it is the
  // one thing a token can be issued without. Checked before the DO is asked to do anything.
  if (reroot === true && !c.get("scopes").includes("reroot")) {
    return c.json(
      errJson("forbidden", "this access token may sync but not rebuild remote history"),
      403
    );
  }
  const result = await vault(c.env).commit(manifest, expectedHead, { reroot: reroot === true });
  logPhase("commit", startedAt, { ok: result.ok });
  if (result.ok) return c.json({ head: result.head });
  switch (result.code) {
    case "stale_head":
      return c.json(errJson("stale_head", "head moved; pull, merge, and re-commit", { head: result.head }), 409);
    case "missing_blob":
      return c.json(errJson("missing_blob", "upload missing blobs first", { hashes: result.hashes }), 422);
    case "duplicate_manifest_id":
      // 409, not 422: the body is well-formed, it collides with history that already exists.
      return c.json(errJson("duplicate_manifest_id", result.message), 409);
    case "gc_busy":
      // Transient and entirely the server's doing, so it is advertised as retryable rather
      // than surfaced to the user as a failed sync.
      return c.json(errJson("gc_busy", result.message), 503, { "retry-after": "5" });
    case "invalid_manifest":
      return c.json(errJson("invalid_manifest", result.message), 422);
  }
});

app.notFound((c) => c.json(errJson("not_found", "no such route"), 404));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    try {
      const report = await runGc(env);
      console.log(JSON.stringify({ event: "gc_report", ...report }));
    } catch (error) {
      // Nobody is watching a cron's stack trace. Emit the same structured shape the reports
      // use so a failed nightly sweep is greppable next to the ones that worked, then rethrow
      // so the invocation itself is still recorded as an error.
      console.error(
        JSON.stringify({
          event: "gc_failed",
          message: error instanceof Error ? error.message : String(error),
        })
      );
      throw error;
    }
  },
};
