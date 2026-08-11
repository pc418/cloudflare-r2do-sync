import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { manifestHashes, validateManifest, type Manifest } from "./manifest";
import { missingBlobs } from "./blobs";

export type CommitResult =
  | { ok: true; head: string }
  | { ok: false; code: "stale_head"; head: string | null }
  | { ok: false; code: "missing_blob"; hashes: string[] }
  | { ok: false; code: "invalid_manifest"; message: string };

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class VaultLock extends DurableObject<Env> {
  // Serializes commits: DO input gates do NOT close during external I/O (R2 awaits),
  // so CAS must be protected by an explicit in-instance queue.
  #commitChain: Promise<unknown> = Promise.resolve();

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
      `);
    });
  }

  #storedHead(): string | null {
    const rows = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'head'")
      .toArray();
    return rows[0]?.value ?? null;
  }

  async getHead(): Promise<string | null> {
    return this.#storedHead();
  }

  async mintToken(name: string): Promise<{ id: string; token: string }> {
    const id = crypto.randomUUID();
    const raw = new Uint8Array(32);
    crypto.getRandomValues(raw);
    const token = [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
    this.ctx.storage.sql.exec(
      "INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)",
      id,
      name,
      await sha256hex(token),
      new Date().toISOString()
    );
    return { id, token }; // raw token is returned exactly once, only its hash is stored
  }

  /** Active tokens, oldest first. Token material is never stored in the clear, so it
   *  cannot be listed — this exists so rotation can revoke what it did not mint. */
  async listTokens(): Promise<{ id: string; name: string; createdAt: string }[]> {
    return this.ctx.storage.sql
      .exec<{ id: string; name: string; created_at: string }>(
        "SELECT id, name, created_at FROM devices WHERE revoked_at IS NULL ORDER BY created_at, id"
      )
      .toArray()
      .map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at }));
  }

  async revokeToken(id: string): Promise<boolean> {
    const cursor = this.ctx.storage.sql.exec(
      "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      new Date().toISOString(),
      id
    );
    return cursor.rowsWritten > 0;
  }

  /** Returns the row id for a valid, unrevoked access token; null otherwise. */
  async verifyToken(token: string): Promise<string | null> {
    const rows = this.ctx.storage.sql
      .exec<{ id: string }>(
        "SELECT id FROM devices WHERE token_hash = ? AND revoked_at IS NULL",
        await sha256hex(token)
      )
      .toArray();
    return rows[0]?.id ?? null;
  }

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

    const head = this.#storedHead();
    if (head === manifest.id) {
      // The preceding attempt may have advanced durable DO state and then failed while
      // writing the R2 disaster-recovery mirror. A retry is not complete until it repairs
      // that final step too.
      await this.#writeHeadMirror(head);
      return { ok: true, head };
    }
    if (head !== expectedHead) return { ok: false, code: "stale_head", head };

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

    await this.env.VAULT.put(`manifests/${manifest.id}.json`, JSON.stringify(manifest), {
      httpMetadata: { contentType: "application/json" },
    });
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('head', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      manifest.id
    );
    // Mirror for disaster recovery / S3-tool reads. If this throws, the commit is
    // already durable in DO storage; the client's retry hits the idempotent path
    // above and re-attempts the mirror.
    await this.#writeHeadMirror(manifest.id);
    return { ok: true, head: manifest.id };
  }

  async #writeHeadMirror(head: string): Promise<void> {
    await this.env.VAULT.put("head.json", JSON.stringify({ head }), {
      httpMetadata: { contentType: "application/json" },
    });
  }
}
