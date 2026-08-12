import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { ULID_RE, canonicalJson, manifestHashes, validateManifest, type Manifest } from "./manifest";
import { missingBlobs } from "./blobs";

export type CommitResult =
  | { ok: true; head: string }
  | { ok: false; code: "stale_head"; head: string | null }
  | { ok: false; code: "missing_blob"; hashes: string[] }
  | { ok: false; code: "duplicate_manifest_id"; message: string }
  | { ok: false; code: "gc_busy"; message: string }
  | { ok: false; code: "invalid_manifest"; message: string };

/**
 * The authoritative head plus permission to delete, or the reason permission was refused.
 * GC gets both from one call on purpose: the head it walks and the exclusion that makes the
 * walk still true when it deletes must come from the same instant.
 */
export type GcLeaseResult =
  | { ok: true; head: string | null; leaseId: string; expiresAt: number }
  | { ok: false; reason: "commit_in_flight" | "already_leased" };

/**
 * What an access token is allowed to do. `sync` is everything an ordinary device needs;
 * `reroot` is separate because it is the only operation that makes remote content stop
 * existing, and a stolen token should not carry the power to destroy history with it.
 */
export const ALL_SCOPES = ["sync", "reroot"] as const;
export type TokenScope = (typeof ALL_SCOPES)[number];

export function isTokenScope(value: unknown): value is TokenScope {
  return typeof value === "string" && (ALL_SCOPES as readonly string[]).includes(value);
}

/**
 * `undefined` means the caller did not ask, which keeps the historical full authority. An
 * empty list is NOT the same thing and never becomes full — the route rejects it, and this
 * returns it unchanged so a direct RPC caller gets what it asked for rather than a surprise.
 */
function normalizeScopes(scopes: readonly TokenScope[] | undefined): TokenScope[] {
  if (scopes === undefined) return [...ALL_SCOPES];
  return ALL_SCOPES.filter((s) => scopes.includes(s));
}

/** A row written before scopes existed carries none; it predates the split, so it has all. */
function parseScopes(stored: string | null): TokenScope[] {
  if (stored === null || stored.trim() === "") return [...ALL_SCOPES];
  return ALL_SCOPES.filter((s) => stored.split(",").includes(s));
}

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class VaultLock extends DurableObject<Env> {
  // Serializes commits: DO input gates do NOT close during external I/O (R2 awaits),
  // so CAS must be protected by an explicit in-instance queue.
  #commitChain: Promise<unknown> = Promise.resolve();
  /**
   * Non-zero while a commit is between verifying its blobs and advancing the head. GC may
   * not delete during that window: the commit has already been told its blobs exist.
   * Incremented and read with no `await` in between, which is what makes it a real mutex —
   * the DO is single-threaded between suspension points even though its input gate opens
   * across R2 I/O.
   */
  #commitInFlight = 0;
  /** Set once the durable ID registry is known to be populated, to skip the SQL read. */
  #registryReady = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Not awaitable in a constructor. A rejection here aborts the Durable Object, which is
    // the intended failure mode, so the drop is explicit rather than accidental.
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        -- Table name predates the rename to "access tokens"; renaming it would be a
        -- storage migration for a cosmetic gain, so the rows stay where they are.
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          revoked_at TEXT
        );
        -- Every manifest ID this vault has EVER issued. Rows are never deleted, including
        -- when GC removes the object: an ID whose manifest is gone must still be refused,
        -- or a writer could re-create it pointing back into retained history and close the
        -- chain into a cycle that a walk cannot terminate.
        CREATE TABLE IF NOT EXISTS manifest_ids (
          id TEXT PRIMARY KEY,
          first_seen TEXT NOT NULL
        );
      `);
      this.#addTokenColumns();
    });
  }

  /**
   * Adds the columns that carry a token's authority, for vaults created before they
   * existed. `ADD COLUMN ... DEFAULT` backfills existing rows, and the default is *full*
   * authority on purpose: an already-issued token belongs to a device that is syncing right
   * now, and silently demoting it would break that vault at its next reroot. Restricted
   * tokens are opt-in at mint time.
   */
  #addTokenColumns(): void {
    const columns = new Set(
      this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(devices)")
        .toArray()
        .map((row) => row.name)
    );
    if (!columns.has("scopes")) {
      this.ctx.storage.sql.exec(
        `ALTER TABLE devices ADD COLUMN scopes TEXT NOT NULL DEFAULT '${[...ALL_SCOPES].join(",")}'`
      );
    }
    if (!columns.has("expires_at")) {
      this.ctx.storage.sql.exec("ALTER TABLE devices ADD COLUMN expires_at TEXT");
    }
  }

  #meta(key: string): string | null {
    const rows = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
      .toArray();
    return rows[0]?.value ?? null;
  }

  #setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value
    );
  }

  #storedHead(): string | null {
    return this.#meta("head");
  }

  async getHead(): Promise<string | null> {
    return this.#storedHead();
  }

  /**
   * `scopes` narrows what the token may do; `expiresAt` (ISO) makes it stop working on its
   * own. Both default to the historical behaviour — full authority, no expiry — so that
   * minting from an older admin client is unchanged.
   */
  async mintToken(
    name: string,
    opts: { scopes?: readonly TokenScope[]; expiresAt?: string | null } = {}
  ): Promise<{ id: string; token: string; scopes: TokenScope[]; expiresAt: string | null }> {
    const scopes = normalizeScopes(opts.scopes);
    const expiresAt = opts.expiresAt ?? null;
    const id = crypto.randomUUID();
    const raw = new Uint8Array(32);
    crypto.getRandomValues(raw);
    const token = [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
    this.ctx.storage.sql.exec(
      "INSERT INTO devices (id, name, token_hash, created_at, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      name,
      await sha256hex(token),
      new Date().toISOString(),
      scopes.join(","),
      expiresAt
    );
    return { id, token, scopes, expiresAt }; // raw token is returned once; only its hash is stored
  }

  /** Active tokens, oldest first. Token material is never stored in the clear, so it
   *  cannot be listed — this exists so rotation can revoke what it did not mint. */
  async listTokens(): Promise<
    { id: string; name: string; createdAt: string; scopes: TokenScope[]; expiresAt: string | null }[]
  > {
    return this.ctx.storage.sql
      .exec<{
        id: string;
        name: string;
        created_at: string;
        scopes: string | null;
        expires_at: string | null;
      }>(
        "SELECT id, name, created_at, scopes, expires_at FROM devices WHERE revoked_at IS NULL ORDER BY created_at, id"
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        scopes: parseScopes(row.scopes),
        expiresAt: row.expires_at,
      }));
  }

  async revokeToken(id: string): Promise<boolean> {
    const cursor = this.ctx.storage.sql.exec(
      "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      new Date().toISOString(),
      id
    );
    return cursor.rowsWritten > 0;
  }

  /**
   * Identifies a valid, unrevoked, unexpired access token and says what it may do.
   * Returns null for anything else — an expired token is no more usable than a revoked one.
   */
  async verifyToken(token: string): Promise<{ id: string; scopes: TokenScope[] } | null> {
    const rows = this.ctx.storage.sql
      .exec<{ id: string; scopes: string | null; expires_at: string | null }>(
        "SELECT id, scopes, expires_at FROM devices WHERE token_hash = ? AND revoked_at IS NULL",
        await sha256hex(token)
      )
      .toArray();
    const row = rows[0];
    if (row === undefined) return null;
    if (row.expires_at !== null && Date.parse(row.expires_at) <= Date.now()) return null;
    return { id: row.id, scopes: parseScopes(row.scopes) };
  }

  // --- manifest ID registry ---------------------------------------------------------------

  #idRegistered(id: string): boolean {
    return (
      this.ctx.storage.sql.exec("SELECT id FROM manifest_ids WHERE id = ?", id).toArray().length > 0
    );
  }

  #registerId(id: string): void {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO manifest_ids (id, first_seen) VALUES (?, ?)",
      id,
      new Date().toISOString()
    );
  }

  /**
   * Seeds the registry from the manifests already in the bucket, once, for vaults that
   * predate it. Runs inside the serialized commit path, so it cannot interleave with another
   * commit, and a failure here fails that commit loudly instead of leaving the registry
   * half-populated and quietly permitting reuse of the IDs it never read.
   */
  async #ensureIdRegistry(): Promise<void> {
    if (this.#registryReady) return;
    if (this.#meta("manifest_ids_backfilled") === "1") {
      this.#registryReady = true;
      return;
    }
    let cursor: string | undefined;
    do {
      const page = await this.env.VAULT.list({ prefix: "manifests/", cursor });
      for (const o of page.objects) {
        const id = o.key.slice("manifests/".length).replace(/\.json$/, "");
        if (ULID_RE.test(id)) this.#registerId(id);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
    const head = this.#storedHead();
    if (head !== null) this.#registerId(head);
    this.#setMeta("manifest_ids_backfilled", "1");
    this.#registryReady = true;
  }

  // --- GC lease ---------------------------------------------------------------------------

  #gcLeaseUntil(): number {
    return Number(this.#meta("gc_lease_until") ?? "0");
  }

  /**
   * Grants GC exclusive use of the delete phase and hands back the head it may treat as
   * live. Refused while a commit is mid-flight, because that commit has already verified
   * its blobs against a bucket GC is about to prune.
   *
   * The lease is durable and expires on its own: a scheduled run killed mid-sweep must not
   * be able to block every commit until someone notices.
   */
  async acquireGcLease(opts: { nowMs: number; ttlMs: number }): Promise<GcLeaseResult> {
    if (this.#commitInFlight > 0) return { ok: false, reason: "commit_in_flight" };
    if (this.#gcLeaseUntil() > opts.nowMs) return { ok: false, reason: "already_leased" };
    const leaseId = crypto.randomUUID();
    const expiresAt = opts.nowMs + opts.ttlMs;
    this.#setMeta("gc_lease_id", leaseId);
    this.#setMeta("gc_lease_until", String(expiresAt));
    return { ok: true, head: this.#storedHead(), leaseId, expiresAt };
  }

  /**
   * Extends the lease, but only while this caller demonstrably still owns it.
   *
   * This is the fencing check, and both halves matter. A sweep that ran past its TTL has
   * already stopped excluding commits, so one may have landed and made its live set stale —
   * it must not keep deleting against that set, and `false` here is how it finds out. And if
   * another sweep has since taken the lease, the id no longer matches, so the lapsed sweep
   * cannot renew (or release) what is now someone else's.
   */
  async renewGcLease(leaseId: string, opts: { nowMs: number; ttlMs: number }): Promise<boolean> {
    if (this.#meta("gc_lease_id") !== leaseId) return false;
    if (this.#gcLeaseUntil() <= opts.nowMs) return false;
    this.#setMeta("gc_lease_until", String(opts.nowMs + opts.ttlMs));
    return true;
  }

  /**
   * Releases the lease. With a `leaseId` this is ownership-checked, so a sweep whose lease
   * lapsed cannot clear the one a later sweep is holding. Without one it force-clears, which
   * only tests do.
   */
  async releaseGcLease(leaseId?: string): Promise<void> {
    if (leaseId !== undefined && this.#meta("gc_lease_id") !== leaseId) return;
    this.#setMeta("gc_lease_until", "0");
    this.#setMeta("gc_lease_id", "");
  }

  /**
   * Test seam. Awaited between blob verification and the manifest write so a spec can
   * interleave GC with a commit that has already been told its blobs exist — the exact
   * window the lease closes. Production never assigns it; see gc-commit-race.spec.ts.
   */
  testHookAfterVerify?: () => Promise<void>;

  /**
   * `reroot` is the one sanctioned way to commit a snapshot whose parent is NOT the current
   * head: a new root (`parent: null`) that orphans the entire existing chain, which the next
   * GC then deletes. It stays compare-and-set — `expectedHead` must still name the head this
   * caller saw — so a device committing concurrently loses the race rather than its work.
   */
  async commit(
    manifestData: unknown,
    expectedHead: string | null,
    opts: { reroot?: boolean } = {}
  ): Promise<CommitResult> {
    const run = this.#commitChain.then(() =>
      this.#commitSerialized(manifestData, expectedHead, opts.reroot === true)
    );
    this.#commitChain = run.catch(() => {});
    return run;
  }

  async #commitSerialized(
    manifestData: unknown,
    expectedHead: string | null,
    reroot: boolean
  ): Promise<CommitResult> {
    const v = validateManifest(manifestData);
    if (!v.ok) return { ok: false, code: "invalid_manifest", message: v.message };
    const manifest = v.manifest;
    // Checked independently of the parent/head rule, not as an exception to it. Folded
    // together, a reroot whose parent happened to equal `expectedHead` passed as an ordinary
    // child: the client was told its commit succeeded while the history it asked to discard
    // stayed exactly where it was. A request this destructive must never quietly do
    // something else instead.
    if (reroot && manifest.parent !== null) {
      return { ok: false, code: "invalid_manifest", message: "a reroot manifest must have parent null" };
    }
    // Otherwise a snapshot is a child of the head its author saw. A reroot is the one
    // manifest exempt from that, and only by being a root; it stays compare-and-set on
    // `expectedHead` below.
    if (!reroot && manifest.parent !== expectedHead) {
      return { ok: false, code: "invalid_manifest", message: "manifest.parent must equal expectedHead" };
    }

    // Everything from here relies on the bucket not being pruned underneath it — the
    // registry backfill above all, because it lists R2 and then records completion
    // permanently. A manifest GC deleted mid-listing would be missed forever and its id
    // handed back out. So the exclusion is taken BEFORE the backfill, not after it.
    if (this.#gcLeaseUntil() > Date.now()) {
      return { ok: false, code: "gc_busy", message: "garbage collection is running; retry shortly" };
    }
    this.#commitInFlight++;
    try {
      return await this.#commitExclusive(manifest, expectedHead);
    } finally {
      this.#commitInFlight--;
    }
  }

  /** Registry backfill through head advancement, with GC excluded for the whole of it. */
  async #commitExclusive(manifest: Manifest, expectedHead: string | null): Promise<CommitResult> {
    await this.#ensureIdRegistry();

    const head = this.#storedHead();
    if (head === manifest.id) {
      // The preceding attempt may have advanced durable DO state and then failed while
      // writing the R2 disaster-recovery mirror. A retry is not complete until it repairs
      // that final step too — but only a retry of the SAME snapshot. Re-using the head's ID
      // for different content is an overwrite of published history, not a retry.
      const stored = await this.env.VAULT.get(`manifests/${head}.json`);
      if (stored === null) {
        return {
          ok: false,
          code: "invalid_manifest",
          message: `stored head manifest ${head} is missing; refusing to overwrite it`,
        };
      }
      if (canonicalJson(await stored.json()) !== canonicalJson(manifest)) {
        return {
          ok: false,
          code: "duplicate_manifest_id",
          message: `manifest id ${manifest.id} is the current head and holds different content`,
        };
      }
      await this.#writeHeadMirror(head);
      return { ok: true, head };
    }
    if (head !== expectedHead) return { ok: false, code: "stale_head", head };

    // Past the head-retry case, a known ID can only be an attempt to overwrite a snapshot
    // that already exists — or to re-create one GC has deleted, whose ID other retained
    // manifests may still name as a parent. Either forms a chain no walk can terminate.
    if (this.#idRegistered(manifest.id)) {
      return {
        ok: false,
        code: "duplicate_manifest_id",
        message: `manifest id ${manifest.id} has already been used by this vault`,
      };
    }

    return await this.#commitVerified(manifest);
  }

  /** The critical section: blob liveness through head advancement. GC is excluded. */
  async #commitVerified(manifest: Manifest): Promise<CommitResult> {
    // Verify only blobs that are new relative to the parent snapshot.
    let parentHashes = new Set<string>();
    if (manifest.parent !== null) {
      const obj = await this.env.VAULT.get(`manifests/${manifest.parent}.json`);
      if (obj === null) {
        return { ok: false, code: "invalid_manifest", message: `parent manifest ${manifest.parent} not found` };
      }
      const parent: Manifest = await obj.json();
      parentHashes = new Set(manifestHashes(parent));
    }
    // Normally a handful, so this normally heads them individually — but a first sync and a
    // reroot both parent onto nothing and verify the whole snapshot, which is the shape that
    // exceeded the Worker CPU limit on /api/blobs/check. Same policy, one implementation.
    const newHashes = [...new Set(manifestHashes(manifest))].filter((h) => !parentHashes.has(h));
    const missing = await missingBlobs(this.env, newHashes);
    if (missing.length > 0) return { ok: false, code: "missing_blob", hashes: missing };

    await this.testHookAfterVerify?.();

    await this.env.VAULT.put(`manifests/${manifest.id}.json`, JSON.stringify(manifest), {
      httpMetadata: { contentType: "application/json" },
    });
    this.#registerId(manifest.id);
    this.#setMeta("head", manifest.id);
    // Mirror for disaster recovery / S3-tool reads. If this throws, the commit is
    // already durable in DO storage; the client's retry hits the idempotent path
    // above and re-attempts the mirror. GC never treats the mirror as a root, so a
    // mirror stuck one snapshot behind cannot make it delete the real head.
    await this.#writeHeadMirror(manifest.id);
    return { ok: true, head: manifest.id };
  }

  async #writeHeadMirror(head: string): Promise<void> {
    await this.env.VAULT.put("head.json", JSON.stringify({ head }), {
      httpMetadata: { contentType: "application/json" },
    });
  }
}
