import { DEFAULT_LANES, clampLanes, mapPool } from "./pool";
import { parseManifest, type Manifest } from "./types";
import type { SettingsDoc } from "./settings-doc";
import { normalizeServerUrl } from "./setup-link";

export interface HttpRequest {
  method: string;
  headers: Record<string, string>;
  body?: string | ArrayBuffer;
}

export interface HttpResponse {
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type HttpClient = (url: string, req: HttpRequest) => Promise<HttpResponse>;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code = "unknown"
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class AuthError extends ApiError {
  constructor(message: string, status = 401) {
    super(message, status, "unauthorized");
    this.name = "AuthError";
  }
}

export class StaleHeadError extends ApiError {
  constructor(
    message: string,
    readonly head: string | null
  ) {
    super(message, 409, "stale_head");
    this.name = "StaleHeadError";
  }
}

export class MissingBlobError extends ApiError {
  constructor(
    message: string,
    readonly hashes: string[]
  ) {
    super(message, 422, "missing_blob");
    this.name = "MissingBlobError";
  }
}

/**
 * The server refuses commits while garbage collection is deleting, so that a snapshot can
 * never be published naming a blob the sweep is about to remove. It is the server's own
 * doing and nothing happened, so it is retried rather than reported as a failed sync.
 */
export class GcBusyError extends ApiError {
  constructor(message: string) {
    super(message, 503, "gc_busy");
    this.name = "GcBusyError";
  }
}

/** The settings document moved since this device read it; `rev` is the one that won. */
export class SettingsStaleError extends ApiError {
  constructor(
    message: string,
    readonly rev: number
  ) {
    super(message, 409, "stale_revision");
    this.name = "SettingsStaleError";
  }
}

const MAX_CHECK_HASHES = 1000;
const GC_BUSY_ATTEMPTS = 4;
const GC_BUSY_DELAY_MS = 2000;

interface ErrorBody {
  error?: { code?: string; message?: string };
  head?: string | null;
  hashes?: string[];
  rev?: number;
}

export class SyncApi {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #http: HttpClient;
  readonly #lanes: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(opts: {
    baseUrl: string;
    token: string;
    http: HttpClient;
    lanes?: number;
    /** Injected so the gc_busy retry costs a test nothing. */
    sleep?: (ms: number) => Promise<void>;
  }) {
    // Keep the transport invariant at the lowest credential-bearing boundary too: callers
    // outside the settings UI must not be able to send an access token over remote HTTP.
    this.#baseUrl = normalizeServerUrl(opts.baseUrl);
    this.#token = opts.token;
    this.#http = opts.http;
    this.#lanes = clampLanes(opts.lanes ?? DEFAULT_LANES);
    this.#sleep =
      opts.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  async #request(path: string, req: Partial<HttpRequest> = {}): Promise<HttpResponse> {
    const res = await this.#http(`${this.#baseUrl}${path}`, {
      method: req.method ?? "GET",
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(req.body !== undefined && typeof req.body === "string"
          ? { "content-type": "application/json" }
          : {}),
        ...(req.headers ?? {}),
      },
      body: req.body,
    });
    if (res.status >= 200 && res.status < 300) return res;
    throw await this.#toError(res);
  }

  async #toError(res: HttpResponse): Promise<ApiError> {
    let body: ErrorBody | null;
    let raw = "";
    try {
      raw = await res.text();
      body = raw ? (JSON.parse(raw) as ErrorBody) : null;
    } catch {
      body = null; // non-JSON error page; keep the raw text for the message
    }
    const code = body?.error?.code ?? "unknown";
    const message = body?.error?.message ?? (raw || `HTTP ${res.status}`);
    if (res.status === 401 || res.status === 403) return new AuthError(message, res.status);
    if (res.status === 409 && code === "stale_head") {
      return new StaleHeadError(message, body?.head ?? null);
    }
    if (code === "missing_blob") return new MissingBlobError(message, body?.hashes ?? []);
    if (code === "gc_busy") return new GcBusyError(message);
    if (res.status === 409 && code === "stale_revision") {
      return new SettingsStaleError(message, typeof body?.rev === "number" ? body.rev : 0);
    }
    return new ApiError(message, res.status, code);
  }

  async getHead(): Promise<string | null> {
    const res = await this.#request("/api/head");
    return ((await res.json()) as { head: string | null }).head;
  }

  async getManifest(id: string): Promise<Manifest> {
    const res = await this.#request(`/api/manifests/${id}`);
    const manifest = parseManifest(await res.json());
    // The id is the only thing tying the answer to the question. Without this, a server
    // (or anything between) can serve an older snapshot for any request and the client
    // plans it as if it were the one it asked for.
    if (manifest.id !== id) {
      throw new ApiError(
        `server returned snapshot ${manifest.id} for a request for ${id}`,
        res.status,
        "manifest_mismatch"
      );
    }
    return manifest;
  }

  async checkBlobs(hashes: string[]): Promise<string[]> {
    const chunks: string[][] = [];
    for (let i = 0; i < hashes.length; i += MAX_CHECK_HASHES) {
      chunks.push(hashes.slice(i, i + MAX_CHECK_HASHES));
    }
    // Chunks are independent, so a 10k-file vault asks in parallel instead of ten round
    // trips end to end. mapPool keeps chunk order, so `missing` stays deterministic.
    const answers = await mapPool(chunks, this.#lanes, async (chunk) => {
      const res = await this.#request("/api/blobs/check", {
        method: "POST",
        body: JSON.stringify({ hashes: chunk }),
      });
      return ((await res.json()) as { missing: string[] }).missing;
    });
    return answers.flat();
  }

  async putBlob(hash: string, bytes: Uint8Array): Promise<void> {
    await this.#request(`/api/blobs/${hash}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: bytes.slice().buffer,
    });
  }

  async getBlob(hash: string): Promise<Uint8Array> {
    const res = await this.#request(`/api/blobs/${hash}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** The shared settings document, or null when none has ever been written. */
  async getSettingsDoc(): Promise<unknown> {
    try {
      const res = await this.#request("/api/settings");
      return await res.json();
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  async putSettingsDoc(doc: SettingsDoc): Promise<void> {
    await this.#request("/api/settings", { method: "PUT", body: JSON.stringify(doc) });
  }

  /**
   * `reroot` publishes a manifest with no parent as the new head, orphaning every earlier
   * snapshot. It is still compare-and-set on `expectedHead`, so a device committing at the
   * same moment loses the race instead of its work. The server refuses the combination
   * unless the flag is explicit, which is what keeps it from happening by accident.
   */
  async commit(
    manifest: Manifest,
    expectedHead: string | null,
    opts: { reroot?: boolean } = {}
  ): Promise<string> {
    const body = JSON.stringify({
      manifest,
      expectedHead,
      ...(opts.reroot === true ? { reroot: true } : {}),
    });
    // A refused commit changed nothing, and the body is byte-identical each time, so this
    // re-sends rather than rebuilding the snapshot. It gives up loudly instead of waiting
    // out an unbounded sweep.
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this.#request("/api/commit", { method: "POST", body });
        return ((await res.json()) as { head: string }).head;
      } catch (e) {
        if (!(e instanceof GcBusyError) || attempt >= GC_BUSY_ATTEMPTS) throw e;
        await this.#sleep(GC_BUSY_DELAY_MS);
      }
    }
  }
}
