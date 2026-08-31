/**
 * The agent's view of the vault: one snapshot at a time, read-only, no file replica.
 *
 * Everything here goes through the *existing* sync Worker's public `/api/*` as an ordinary
 * device. The crypto and manifest codec are the plugin's own modules, imported unmodified —
 * never reimplemented, because a second implementation of the HKDF domains or the AAD layout
 * is how compatibility bugs are born.
 */
import { SyncApi, ApiError, type HttpClient } from "../../plugin/src/api";
import { VaultCrypto, manifestAad, settingsAad } from "../../plugin/src/crypto";
import { sha256Hex } from "../../plugin/src/hash";
import { makeScopeFilter, parseGlobs } from "../../plugin/src/paths";
import { isSettingsDoc } from "../../plugin/src/settings-doc";
import { blobKey, parseFileEntries, type FileEntry, type Manifest } from "../../plugin/src/types";

/**
 * `HttpClient` over the platform `fetch`. The plugin's own adapter wraps Obsidian's
 * `requestUrl` instead, purely to bypass CORS on mobile; off-device there is nothing to
 * bypass. `HttpResponse` was deliberately shaped as a structural subset of the WHATWG
 * `Response`, so this is nearly a passthrough — only `headers` has to be flattened.
 */
export const fetchHttp: HttpClient = async (url, req) => {
  const res = await fetch(url, {
    method: req.method,
    headers: req.headers,
    body: req.body as BodyInit | undefined,
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    status: res.status,
    headers,
    text: () => res.text(),
    json: () => res.json(),
    arrayBuffer: () => res.arrayBuffer(),
  };
};

/** A failure worth reporting to the model in words, rather than a stack trace. */
export class VaultError extends Error {}

/**
 * Reads one glob list out of the shared policy, failing closed.
 *
 * Absent is a real answer — an unset field means no rule. A field that is *present but not
 * text* is a document this agent does not understand, and quietly reading it as "no excludes"
 * would widen scope to the whole vault at exactly the moment the policy stopped making sense.
 */
function globList(value: unknown, field: string): string[] {
  // Only `undefined` is absence. An explicit `null` is a value this agent does not understand,
  // and reading it as "no rule" is the same widening as reading an array that way.
  if (value === undefined) return [];
  if (typeof value !== "string") {
    throw new VaultError(
      `the shared settings' "${field}" is not text, so this vault's policy cannot be read — refusing to fall back to no restrictions`
    );
  }
  return parseGlobs(value);
}

export interface Snapshot {
  head: string;
  /**
   * Identifies the shared policy this view was filtered with. Part of the cache key and of
   * the search index's freshness check: `files` depends on the policy as much as on the head.
   */
  policy: string;
  /**
   * The exact predicate that produced `files`, carried so a caller gates on the same policy
   * this snapshot was filtered with.
   *
   * A second `scope()` call is a second read of the settings document, and the vault can
   * change between the two: a path hidden when `files` was built but permitted a moment later
   * passes the gate while sitting absent from the visible map — which reads as "this note does
   * not exist" and replaces carried content with nothing. One policy per attempt, or none.
   */
  inScope: (path: string) => boolean;
  /** In-scope paths: what the tools may see. */
  files: Record<string, FileEntry>;
  /**
   * The COMPLETE path map, filtered by nothing.
   *
   * A child manifest must be built from this, never from `files`. Excluded and hard-skipped
   * paths are deliberately *carried* through snapshots, so a commit assembled from the visible
   * subset would silently delete every one of them — the agent would quietly destroy exactly
   * the content the vault takes most care to preserve.
   */
  all: Record<string, FileEntry>;
  /** How many carried paths are withheld from the tools. */
  hidden: number;
}

/**
 * Reads one vault, caching the decrypted path map for the head it belongs to.
 *
 * The cache lives in the isolate, not in a Durable Object. It is a pure optimisation —
 * correctness never depends on a hit — and a search→read→read burst is one conversation
 * turn, which lands in one isolate in practice. A DO would add a migration, a binding and a
 * round trip to cache something we can recompute from one request. When P3's search index
 * arrives it will be genuinely stateful and can bring the DO with it. (Deviation from §1 of
 * the design doc, recorded there.)
 */
export class VaultView {
  readonly #api: SyncApi;
  /**
   * A *separate* client on a *separate* credential, absent on a read-only deployment.
   *
   * Not a flag on the read client: the two tokens carry different scopes and stay
   * independently revocable, and if the write token is absent there is no object here capable
   * of issuing a write at all. A leaked read token cannot be escalated into a commit, and the
   * refusal happens here rather than in a policy check somebody can forget to call.
   */
  readonly #writeApi: SyncApi | null;
  readonly #crypto: VaultCrypto;
  readonly #configDir: string;
  #cached: Snapshot | null = null;

  /**
   * The shared policy, cached by the revision it came from.
   *
   * Keyed by `rev` rather than held forever: a policy is edited on a phone and published
   * without any snapshot being committed, so a cache that only ever refreshed when the head
   * moved would keep exposing a folder the owner had just excluded — indefinitely, since the
   * Durable Object outlives the request.
   */
  #policy: { rev: number; fingerprint: string; scope: (path: string) => boolean } | null = null;

  constructor(opts: {
    api: SyncApi;
    writeApi?: SyncApi | null;
    crypto: VaultCrypto;
    configDir?: string;
  }) {
    this.#api = opts.api;
    this.#writeApi = opts.writeApi ?? null;
    this.#crypto = opts.crypto;
    this.#configDir = opts.configDir ?? ".obsidian";
  }

  get configDir(): string {
    return this.#configDir;
  }

  get writable(): boolean {
    return this.#writeApi !== null;
  }

  #mutator(): SyncApi {
    if (this.#writeApi === null) {
      throw new VaultError("this connector holds no write credential for the vault");
    }
    return this.#writeApi;
  }

  /**
   * The vault's own scope rules, from the shared settings document.
   *
   * This is not decoration. `alwaysSkip` covers plugin state and config; it says nothing about
   * the *user's* excludes, and this vault's excludes are what keep a credentials folder — real keys
   * and credentials — out of what devices sync. Excluded paths are carried in snapshots
   * forever, so without this the agent would read them out of the path map and hand them to
   * whatever the model was asked to summarise.
   *
   * A 404 means no policy has been published, which is a real state (a fresh vault), and the
   * hard skips still apply. Any *other* failure is not evidence of an absent policy — treating
   * a 401 or a 5xx as "no excludes" would open the vault wide exactly when something is wrong —
   * so it propagates.
   */
  async scope(): Promise<(path: string) => boolean> {
    return (await this.#policyNow()).scope;
  }

  /**
   * Reads the shared settings document and returns the current policy.
   *
   * The document is fetched every time — one request — because the alternative is answering
   * with an exclusion list the owner has already changed. Decryption and glob parsing are
   * skipped when the revision is one already seen.
   *
   * A 404 means no policy has been published, which is a real state (a fresh vault), and the
   * hard skips still apply. Any *other* failure is not evidence of an absent policy — treating
   * a 401 or a 5xx as "no excludes" would open the vault wide exactly when something is wrong —
   * so it propagates.
   */
  async #policyNow(): Promise<{ rev: number; fingerprint: string; scope: (path: string) => boolean }> {
    let raw: unknown;
    try {
      raw = await this.#api.getSettingsDoc();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) raw = null;
      else throw error;
    }

    if (raw === null || raw === undefined) {
      const fingerprint = `none:${this.#configDir}`;
      if (this.#policy?.fingerprint !== fingerprint) {
        this.#policy = {
          rev: 0,
          fingerprint,
          scope: makeScopeFilter({
            excludes: [],
            onlyPaths: [],
            syncConfigDir: false,
            configDir: this.#configDir,
          }),
        };
      }
      return this.#policy;
    }

    if (!isSettingsDoc(raw)) throw new VaultError("the shared settings document is malformed");
    const rev = raw.rev ?? 0;
    const fingerprint = `${rev}:${raw.updatedAt}:${this.#configDir}`;
    if (this.#policy?.fingerprint === fingerprint) return this.#policy;

    let plain: Record<string, unknown>;
    if (raw.v === 2 || raw.v === 3) {
      if (this.#crypto.keyId !== raw.keyId) {
        throw new VaultError(
          "the shared settings were written with a different master key than this agent holds"
        );
      }
      plain = await this.#crypto.decryptSettingsJson<Record<string, unknown>>(
        raw.enc,
        raw.v === 3
          ? settingsAad({ v: 3, rev, device: raw.device, keyId: raw.keyId, vaultSalt: raw.vaultSalt })
          : undefined
      );
    } else {
      plain = raw.plain;
    }

    const scope = makeScopeFilter({
      excludes: globList(plain.excludes, "excludes"),
      onlyPaths: globList(plain.onlyPaths, "onlyPaths"),
      syncConfigDir: false,
      configDir: this.#configDir,
    });
    this.#policy = { rev, fingerprint, scope };
    return this.#policy;
  }

  /** The key this vault is read and written under. `null` would mean a plaintext vault. */
  get crypto(): VaultCrypto {
    return this.#crypto;
  }

  /**
   * The current head's path map. One manifest fetch per head, then cached.
   *
   * `fresh` skips the *cached head id* as well as the map — a write must absorb the head as
   * it is right now, not the one this isolate happened to see a minute ago.
   */
  async snapshot(opts: { fresh?: boolean } = {}): Promise<Snapshot> {
    const [head, policy] = await Promise.all([this.#api.getHead(), this.#policyNow()]);
    if (head === null) throw new VaultError("this vault is empty — nothing has been synced to it yet");
    // Keyed by the policy too: the visible half of a snapshot is a function of both, and a
    // policy can change while the head stands still.
    if (this.#cached?.head === head && this.#cached.policy === policy.fingerprint && opts.fresh !== true) {
      return this.#cached;
    }

    const manifest = await this.#api.getManifest(head);
    const all = await this.#decryptPathMap(manifest);
    const inScope = policy.scope;

    // The reading side of the sync policy. `all` keeps everything, because a commit must carry
    // it; `files` is what the tools may look at.
    const files: Record<string, FileEntry> = Object.create(null) as Record<string, FileEntry>;
    let hidden = 0;
    for (const [path, entry] of Object.entries(all)) {
      if (inScope(path)) files[path] = entry;
      else hidden++;
    }

    this.#cached = { head, policy: policy.fingerprint, inScope, files, all, hidden };
    return this.#cached;
  }

  /** The plaintext bytes of one entry. */
  async read(entry: FileEntry): Promise<Uint8Array> {
    const stored = await this.#api.getBlob(blobKey(entry));
    // `c` present means the vault is encrypted and `stored` is ciphertext. Its key is derived
    // from the expected plaintext hash, so a substituted blob fails the GCM tag rather than
    // returning content that is merely wrong.
    return entry.c === undefined ? stored : this.#crypto.decryptBlob(entry.h, stored);
  }

  /**
   * Uploads one file's bytes, returning the ciphertext hash the entry must carry as `c` (or
   * `undefined` for a plaintext vault, where the blob key is the plaintext hash).
   *
   * Blob encryption is deterministic — the key comes from the plaintext hash and the IV is
   * fixed — so re-storing identical content yields an identical ciphertext and the server's
   * conditional put deduplicates it. That is why the agent can re-upload freely on a CAS retry.
   */
  async store(plainHash: string, bytes: Uint8Array): Promise<string | undefined> {
    const cipher = await this.#crypto.encryptBlob(plainHash, bytes);
    const c = await sha256Hex(cipher);
    await this.#mutator().putBlob(c, cipher);
    return c;
  }

  /** Publishes a manifest against the head it was built on. Throws `StaleHeadError` if it moved. */
  async commit(manifest: Manifest, expectedHead: string | null): Promise<string> {
    const head = await this.#mutator().commit(manifest, expectedHead);
    // The map just changed, so the cached one describes a snapshot that is no longer current.
    this.#cached = null;
    return head;
  }

  async #decryptPathMap(manifest: Manifest): Promise<Record<string, FileEntry>> {
    if (manifest.v === 1) return manifest.files;
    // v2 authenticates only the ciphertext; v3 authenticates the envelope it arrived in, so a
    // spliced header fails here instead of being read as genuine content.
    const files = parseFileEntries(
      await this.#crypto.decryptJson(
        manifest.enc,
        manifest.v === 3 ? manifestAad(manifest) : undefined
      )
    );
    if (manifest.v === 3) {
      const inner = new Set(Object.values(files).map(blobKey));
      const outer = new Set(manifest.blobs);
      if (inner.size !== outer.size || [...inner].some((hash) => !outer.has(hash))) {
        throw new VaultError(
          `snapshot ${manifest.id} lists ${outer.size} blob(s) but its entries reference ${inner.size}`
        );
      }
    }
    return files;
  }
}
