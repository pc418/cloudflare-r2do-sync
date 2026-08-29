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
import { makeScopeFilter, parseGlobs, type ScopeRules } from "../../plugin/src/paths";
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

export interface Snapshot {
  head: string;
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

  /** Cached shared policy. `null` until first load; the inner value is null when none exists. */
  #scope: ((path: string) => boolean) | null = null;

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

  /**
   * The vault's own scope rules, from the shared settings document.
   *
   * This is not decoration. `alwaysSkip` covers plugin state and config; it says nothing about
   * the *user's* excludes, and this vault's excludes are what keep a credentials folder — real API keys
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
    if (this.#scope !== null) return this.#scope;

    let rules: ScopeRules = { excludes: [], onlyPaths: [], syncConfigDir: false, configDir: this.#configDir };
    let raw: unknown;
    try {
      raw = await this.#api.getSettingsDoc();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) raw = null;
      else throw error;
    }

    if (raw !== null && raw !== undefined) {
      if (!isSettingsDoc(raw)) throw new VaultError("the shared settings document is malformed");
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
            ? settingsAad({ v: 3, rev: raw.rev ?? 0, device: raw.device, keyId: raw.keyId, vaultSalt: raw.vaultSalt })
            : undefined
        );
      } else {
        plain = raw.plain;
      }
      rules = {
        excludes: parseGlobs(typeof plain.excludes === "string" ? plain.excludes : ""),
        onlyPaths: parseGlobs(typeof plain.onlyPaths === "string" ? plain.onlyPaths : ""),
        syncConfigDir: false,
        configDir: this.#configDir,
      };
    }

    // The engine's own predicate, not a second implementation: it already composes
    // `alwaysSkip`, `pathError`, the config-directory rule, the excludes and the allow-list.
    this.#scope = makeScopeFilter(rules);
    return this.#scope;
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
    const head = await this.#api.getHead();
    if (head === null) throw new VaultError("this vault has no snapshots yet");
    if (this.#cached?.head === head && opts.fresh !== true) return this.#cached;

    const manifest = await this.#api.getManifest(head);
    const all = await this.#decryptPathMap(manifest);
    const inScope = await this.scope();

    // The reading side of the sync policy. `all` keeps everything, because a commit must carry
    // it; `files` is what the tools may look at.
    const files: Record<string, FileEntry> = Object.create(null) as Record<string, FileEntry>;
    let hidden = 0;
    for (const [path, entry] of Object.entries(all)) {
      if (inScope(path)) files[path] = entry;
      else hidden++;
    }

    this.#cached = { head, files, all, hidden };
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
