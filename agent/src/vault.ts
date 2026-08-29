/**
 * The agent's view of the vault: one snapshot at a time, read-only, no file replica.
 *
 * Everything here goes through the *existing* sync Worker's public `/api/*` as an ordinary
 * device. The crypto and manifest codec are the plugin's own modules, imported unmodified —
 * never reimplemented, because a second implementation of the HKDF domains or the AAD layout
 * is how compatibility bugs are born.
 */
import { SyncApi, type HttpClient } from "../../plugin/src/api";
import { VaultCrypto, manifestAad } from "../../plugin/src/crypto";
import { sha256Hex } from "../../plugin/src/hash";
import { alwaysSkip } from "../../plugin/src/paths";
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
  /** Visible paths only — see `hidden`. */
  files: Record<string, FileEntry>;
  /** How many paths the snapshot carried that this reader refuses to expose. */
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

    // Defence in depth, and the reason it is not merely tidy: `paths.ts` hard-skips
    // credential-bearing plugin state, so those paths are not synced — but excluded remote
    // paths are *carried* through snapshots, so anything a past device published stays in the
    // path map forever. This agent holds the master key; letting it read back a `data.json`
    // holding another device's access token and master key would hand the whole vault to
    // whatever the model is asked to summarise. The sync policy governs writing; this is the
    // reading side of the same concern, and it is applied before anything is offered.
    const files: Record<string, FileEntry> = Object.create(null) as Record<string, FileEntry>;
    let hidden = 0;
    for (const [path, entry] of Object.entries(all)) {
      if (alwaysSkip(path, this.#configDir)) hidden++;
      else files[path] = entry;
    }

    this.#cached = { head, files, hidden };
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
