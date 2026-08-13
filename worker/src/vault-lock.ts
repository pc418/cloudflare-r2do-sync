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

export interface GcPlan {
  head: string | null;
  retainedIds: string[];
  liveHashes: string[];
  retainedEtags: Array<{ id: string; etag: string }>;
}

/** How far the one-time reference-index migration got, and whether it is finished. */
export interface GcIndexProgress {
  done: boolean;
  /** Manifests whose delta this call recorded. */
  indexed: number;
  /** The link the next call resumes from, or null once the walk is complete. */
  cursor: string | null;
}

/** One link of the manifest chain, with everything the index stores about it. */
interface ChainLink {
  id: string;
  parent: string | null;
  uploadedAt: number;
  etag: string;
  hashes: Set<string>;
}

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

/**
 * Durable Object SQL refuses a statement with more than 100 bound parameters, so a batch is
 * sized in parameters and the row count falls out of how many columns it writes.
 */
const MAX_SQL_PARAMS = 100;

/**
 * Manifests one `advanceGcIndex` call will read before handing control back. Deliberately
 * modest: this is a once-per-vault migration, an incomplete index costs only retention (GC
 * declines to delete rather than deleting wrongly), and a bound that no invocation can
 * exceed is worth more than finishing in one go.
 */
const DEFAULT_GC_INDEX_CHUNK = 25;

function setDifference(from: ReadonlySet<string>, without: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const value of from) {
    if (!without.has(value)) out.push(value);
  }
  return out;
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
        CREATE TABLE IF NOT EXISTS manifest_index (
          id TEXT PRIMARY KEY,
          parent TEXT,
          uploaded_at INTEGER NOT NULL,
          etag TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS manifest_blob_deltas (
          manifest_id TEXT NOT NULL,
          hash TEXT NOT NULL,
          delta INTEGER NOT NULL CHECK(delta IN (-1, 1)),
          PRIMARY KEY (manifest_id, hash)
        );
        CREATE INDEX IF NOT EXISTS idx_manifest_blob_deltas_manifest
          ON manifest_blob_deltas(manifest_id);
        CREATE TABLE IF NOT EXISTS current_blob_refs (
          hash TEXT PRIMARY KEY
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

  // --- GC reference index ---------------------------------------------------------------

  #gcIndexReady(): boolean {
    return this.#meta("gc_index_backfilled") === "1";
  }

  #resetGcIndex(): void {
    this.ctx.storage.sql.exec("DELETE FROM manifest_blob_deltas");
    this.ctx.storage.sql.exec("DELETE FROM manifest_index");
    this.ctx.storage.sql.exec("DELETE FROM current_blob_refs");
    this.#setMeta("gc_index_cursor", "");
  }

  #writeIndexRow(link: { id: string; parent: string | null; uploadedAt: number; etag: string }): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO manifest_index (id, parent, uploaded_at, etag) VALUES (?, ?, ?, ?)",
      link.id,
      link.parent,
      link.uploadedAt,
      link.etag
    );
  }

  /**
   * The cheap half of index initialization, and the only half a commit is allowed to do.
   *
   * A vault with no head has no chain to translate, so its index is complete the moment it is
   * empty, and every commit from then on maintains it for the cost of one snapshot diff. A
   * vault that already has history is the opposite case: indexing it means downloading and
   * parsing every manifest still on the chain — tens of megabytes on a real vault, and
   * nowhere near what a request's CPU budget affords. That backfill belongs to the scheduled
   * GC run, the one caller that can afford it, so this leaves the index uninitialized and
   * `#recordGcIndex` stands aside until GC has built it.
   */
  #ensureGcIndexForNewVault(): void {
    if (this.#gcIndexReady()) return;
    if (this.#storedHead() !== null) return;
    this.ctx.storage.transactionSync(() => {
      this.#resetGcIndex();
      this.#setMeta("gc_index_backfilled", "1");
    });
  }

  #finishGcIndex(): void {
    this.#setMeta("gc_index_cursor", "");
    this.#setMeta("gc_index_backfilled", "1");
  }

  #isIndexed(id: string): boolean {
    return (
      this.ctx.storage.sql.exec("SELECT id FROM manifest_index WHERE id = ?", id).toArray().length >
      0
    );
  }

  async #readChainLink(id: string): Promise<ChainLink | null> {
    const object = await this.env.VAULT.get(`manifests/${id}.json`);
    if (object === null) return null;
    const parsed = validateManifest(await object.json());
    if (!parsed.ok) throw new Error(`stored manifest ${id} is invalid: ${parsed.message}`);
    if (parsed.manifest.id !== id) {
      throw new Error(`stored manifest ${id} identifies itself as ${parsed.manifest.id}`);
    }
    return {
      id,
      parent: parsed.manifest.parent,
      uploadedAt: object.uploaded.getTime(),
      etag: object.etag,
      hashes: new Set(manifestHashes(parsed.manifest)),
    };
  }

  /**
   * The manifest the next delta is measured from: the head on a fresh start, wherever the
   * previous call stopped on a resume. Null once there is nothing left to index.
   */
  async #startOrResumeGcIndex(): Promise<ChainLink | null> {
    const cursor = this.#meta("gc_index_cursor");
    if (cursor !== null && cursor !== "") {
      const resumed = await this.#readChainLink(cursor);
      // The cursor names a manifest already recorded as retained, and GC will not delete
      // while the index is incomplete, so its disappearance is corruption rather than a race.
      if (resumed === null) throw new Error(`gc index cursor ${cursor} vanished from R2`);
      return resumed;
    }

    // Completion is the only thing recorded, so an abandoned earlier attempt leaves rows with
    // no flag and no cursor. Start from empty rather than layering onto a half-written index.
    this.ctx.storage.transactionSync(() => this.#resetGcIndex());
    const head = this.#storedHead();
    if (head === null) {
      this.ctx.storage.transactionSync(() => this.#finishGcIndex());
      return null;
    }
    const link = await this.#readChainLink(head);
    if (link === null) throw new Error(`head manifest ${head} is missing`);
    this.ctx.storage.transactionSync(() => {
      this.#writeIndexRow(link);
      // The head's own set is the live set every older delta is replayed against.
      this.#insertBatched(
        (values) => `INSERT INTO current_blob_refs (hash) VALUES ${values}`,
        [...link.hashes].map((hash) => [hash])
      );
      this.#setMeta("gc_index_cursor", link.id);
    });
    return link;
  }

  /**
   * Advances the one-time migration for vaults deployed before commit-side reference
   * indexing by at most `maxManifests` links, and says whether it is finished.
   *
   * Bounded and resumable on purpose. The walk costs one R2 `GET` and one JSON parse per
   * manifest — 104 manifests and 35.6 MB on the vault this was written for — while a request
   * on the free plan gets 10 ms of CPU and Cron Triggers are documented only as 15 minutes of
   * *wall* time, which is not a promise about CPU. So no invocation is assumed to finish it.
   * Each step commits its rows and its cursor in one transaction, which makes an invocation
   * killed mid-walk indistinguishable from one that stopped at its bound: the next call
   * resumes from the last committed link instead of starting over.
   */
  async advanceGcIndex(opts: { maxManifests?: number } = {}): Promise<GcIndexProgress> {
    if (this.#gcIndexReady()) return { done: true, indexed: 0, cursor: null };
    const max = Math.max(1, opts.maxManifests ?? DEFAULT_GC_INDEX_CHUNK);
    const run = this.#commitChain.then(async (): Promise<GcIndexProgress> => {
      if (this.#gcIndexReady()) return { done: true, indexed: 0, cursor: null };
      // The same fence a commit takes: GC cannot acquire a deletion lease, and no commit can
      // advance the head, while the authoritative chain is being translated into SQLite.
      this.#commitInFlight++;
      try {
        return await this.#advanceGcIndex(max);
      } finally {
        this.#commitInFlight--;
      }
    });
    this.#commitChain = run.catch(() => {});
    return run;
  }

  async #advanceGcIndex(maxManifests: number): Promise<GcIndexProgress> {
    const start = await this.#startOrResumeGcIndex();
    if (start === null) return { done: true, indexed: 0, cursor: null };
    // Annotated because the loop reassigns it from a value derived from itself, which TS
    // otherwise refuses to infer.
    let child: ChainLink = start;

    for (let indexed = 0; ; ) {
      const older = child;
      const parentId = older.parent;
      // Either the real root or the point an earlier GC trimmed. Both mean this link has no
      // indexed parent, so everything it names counts as an addition and the walk is over.
      const parent = parentId === null ? null : await this.#readParentLink(parentId);
      if (parent === null) {
        this.ctx.storage.transactionSync(() => {
          this.#writeBlobDeltas(older.id, [...older.hashes], []);
          this.#finishGcIndex();
        });
        return { done: true, indexed: indexed + 1, cursor: null };
      }
      this.ctx.storage.transactionSync(() => {
        this.#writeIndexRow(parent);
        this.#writeBlobDeltas(
          older.id,
          setDifference(older.hashes, parent.hashes),
          setDifference(parent.hashes, older.hashes)
        );
        this.#setMeta("gc_index_cursor", parent.id);
      });
      child = parent;
      if (++indexed >= maxManifests) return { done: false, indexed, cursor: parent.id };
    }
  }

  async #readParentLink(parentId: string): Promise<ChainLink | null> {
    // A parent already in the index means the chain loops back into itself. Checked against a
    // stored row rather than an in-memory visited set, because this walk spans invocations.
    if (this.#isIndexed(parentId)) throw new Error(`manifest chain cycles at ${parentId}`);
    return this.#readChainLink(parentId);
  }

  /**
   * As many rows per statement as the parameter cap allows. At snapshot scale the per-row
   * alternative is thousands of boundary crossings, which is real CPU inside a request that
   * has ten milliseconds of it.
   */
  #insertBatched(statement: (values: string) => string, rows: readonly unknown[][]): void {
    if (rows.length === 0) return;
    const width = rows[0].length;
    const perStatement = Math.max(1, Math.floor(MAX_SQL_PARAMS / width));
    const row = `(${new Array<string>(width).fill("?").join(", ")})`;
    for (let i = 0; i < rows.length; i += perStatement) {
      const slice = rows.slice(i, i + perStatement);
      this.ctx.storage.sql.exec(statement(new Array<string>(slice.length).fill(row).join(", ")), ...slice.flat());
    }
  }

  /** Records `manifestId`'s reference delta against its parent. */
  #writeBlobDeltas(manifestId: string, added: readonly string[], removed: readonly string[]): void {
    this.#insertBatched(
      (values) => `INSERT INTO manifest_blob_deltas (manifest_id, hash, delta) VALUES ${values}`,
      [
        ...added.map((hash) => [manifestId, hash, 1]),
        ...removed.map((hash) => [manifestId, hash, -1]),
      ]
    );
  }

  #dropCurrentBlobRefs(hashes: readonly string[]): void {
    for (let i = 0; i < hashes.length; i += MAX_SQL_PARAMS) {
      const slice = hashes.slice(i, i + MAX_SQL_PARAMS);
      this.ctx.storage.sql.exec(
        `DELETE FROM current_blob_refs WHERE hash IN (${new Array<string>(slice.length).fill("?").join(", ")})`,
        ...slice
      );
    }
  }

  /** Builds the retained union from indexed deltas only; no R2 manifest download occurs. */
  async getGcPlan(opts: { keepCount: number; ageCutoff: number }): Promise<GcPlan> {
    if (!this.#gcIndexReady()) throw new Error("GC reference index is not initialized");
    const head = this.#storedHead();
    if (head === null) return { head: null, retainedIds: [], liveHashes: [], retainedEtags: [] };

    const retainedIds: string[] = [];
    const retainedEtags: Array<{ id: string; etag: string }> = [];
    const liveHashes = new Set(
      this.ctx.storage.sql.exec<{ hash: string }>("SELECT hash FROM current_blob_refs").toArray().map((r) => r.hash)
    );
    let cursor: string | null = head;
    let depth = 0;
    let childToInvert: string | null = null;
    const visited = new Set<string>();
    while (cursor !== null) {
      if (visited.has(cursor)) throw new Error(`manifest index cycles at ${cursor}`);
      visited.add(cursor);
      const row: { id: string; parent: string | null; uploaded_at: number; etag: string } | undefined =
        this.ctx.storage.sql
        .exec<{ id: string; parent: string | null; uploaded_at: number; etag: string }>(
          "SELECT id, parent, uploaded_at, etag FROM manifest_index WHERE id = ?",
          cursor
        )
        .toArray()[0];
      if (row === undefined) {
        if (depth === 0) throw new Error(`head manifest ${cursor} is missing from the GC index`);
        break;
      }
      if (depth >= opts.keepCount && row.uploaded_at < opts.ageCutoff) break;
      if (childToInvert !== null) {
        const removed = this.ctx.storage.sql
          .exec<{ hash: string }>(
            "SELECT hash FROM manifest_blob_deltas WHERE manifest_id = ? AND delta = -1",
            childToInvert
          )
          .toArray();
        for (const { hash } of removed) liveHashes.add(hash);
      }
      retainedIds.push(row.id);
      retainedEtags.push({ id: row.id, etag: row.etag });
      childToInvert = row.id;
      cursor = row.parent;
      depth++;
    }
    return { head, retainedIds, liveHashes: [...liveHashes], retainedEtags };
  }

  /** Prunes only the disposable GC index. The permanent manifest ID registry is untouched. */
  async pruneGcIndex(
    leaseId: string,
    expectedHead: string,
    manifestIds: readonly string[]
  ): Promise<boolean> {
    if (this.#meta("gc_lease_id") !== leaseId || this.#gcLeaseUntil() <= Date.now()) return false;
    if (this.#storedHead() !== expectedHead) return false;
    this.ctx.storage.transactionSync(() => {
      for (const id of manifestIds) {
        this.ctx.storage.sql.exec("DELETE FROM manifest_blob_deltas WHERE manifest_id = ?", id);
        this.ctx.storage.sql.exec("DELETE FROM manifest_index WHERE id = ?", id);
      }
    });
    return true;
  }

  #recordGcIndex(
    manifest: Manifest,
    parentHashes: ReadonlySet<string>,
    uploadedAt: number,
    etag: string
  ): void {
    // A vault whose pre-index history has not been translated yet has no consistent index to
    // extend, and extending it anyway would leave `current_blob_refs` missing every hash this
    // snapshot inherited — a live set that GC would delete against. The scheduled backfill
    // reads this manifest off the head chain instead.
    if (!this.#gcIndexReady()) return;
    const next = new Set(manifestHashes(manifest));
    this.ctx.storage.sql.exec(
      "INSERT INTO manifest_index (id, parent, uploaded_at, etag) VALUES (?, ?, ?, ?)",
      manifest.id,
      manifest.parent,
      uploadedAt,
      etag
    );
    // A new root replaces the live set outright instead of differing from a parent.
    if (manifest.parent === null) this.ctx.storage.sql.exec("DELETE FROM current_blob_refs");
    const added = setDifference(next, parentHashes);
    const removed = setDifference(parentHashes, next);
    this.#writeBlobDeltas(manifest.id, added, removed);
    this.#insertBatched(
      (values) => `INSERT OR IGNORE INTO current_blob_refs (hash) VALUES ${values}`,
      added.map((hash) => [hash])
    );
    this.#dropCurrentBlobRefs(removed);
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
    this.#ensureGcIndexForNewVault();

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

    const stored = await this.env.VAULT.put(`manifests/${manifest.id}.json`, JSON.stringify(manifest), {
      httpMetadata: { contentType: "application/json" },
    });
    this.ctx.storage.transactionSync(() => {
      this.#recordGcIndex(manifest, parentHashes, stored.uploaded.getTime(), stored.etag);
      this.#registerId(manifest.id);
      this.#setMeta("head", manifest.id);
    });
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
