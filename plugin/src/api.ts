import { parseManifest, parseHistoryPage, type Manifest, type HistoryPage } from "./types";
import type { SettingsDoc } from "./settings-doc";
import { normalizeServerUrl } from "./setup-link";
import { exactArrayBuffer } from "./buffer";

export interface HttpRequest {
  method: string;
  headers: Record<string, string>;
  body?: string | ArrayBuffer;
}

export interface HttpResponse {
  status: number;
  headers?: Record<string, string>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type HttpClient = (url: string, req: HttpRequest) => Promise<HttpResponse>;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code = "unknown",
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class TransportError extends ApiError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 0, "transport");
    this.name = "TransportError";
    if (options !== undefined && "cause" in options) this.cause = options.cause;
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

const MAX_CHECK_BODY_BYTES = 7 * 1024 * 1024;
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
    this.#sleep =
      opts.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  async #request(path: string, req: Partial<HttpRequest> = {}): Promise<HttpResponse> {
    let res: HttpResponse;
    try {
      res = await this.#http(`${this.#baseUrl}${path}`, {
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TransportError(message, { cause: error });
    }
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
    return new ApiError(message, res.status, code, retryAfterMs(res));
  }

  async getHead(): Promise<string | null> {
    const res = await this.#request("/api/head");
    return ((await res.json()) as { head: string | null }).head;
  }

  /**
   * The snapshot chain in one request, or null when the server is too old to answer.
   *
   * Everything here is already in the clear on a manifest envelope, so this reveals nothing a
   * walk would not — it removes the walk. Null rather than a throw for 404: an older Worker
   * simply has no such route, and that is a reason to fall back, not to fail the window.
   */
  async getHistory(limit: number): Promise<HistoryPage | null> {
    let res: HttpResponse;
    try {
      res = await this.#request(`/api/history?limit=${encodeURIComponent(String(limit))}`);
    } catch (e) {
      // Only "no such route" is evidence about the server's age. Anything else — 401, 429,
      // 5xx, transport — is this request failing, and quietly walking 41 manifests instead
      // would hide a real fault behind ten seconds of work.
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
    return parseHistoryPage(await res.json());
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
    const body = JSON.stringify({ hashes });
    const bodyBytes = new TextEncoder().encode(body).byteLength;
    if (bodyBytes > MAX_CHECK_BODY_BYTES) {
      throw new Error(
        `blob inventory check body is ${bodyBytes} bytes, exceeding ${MAX_CHECK_BODY_BYTES}`
      );
    }
    const res = await this.#request("/api/blobs/check", {
      method: "POST",
      body,
    });
    return ((await res.json()) as { missing: string[] }).missing;
  }

  async putBlob(hash: string, bytes: Uint8Array): Promise<void> {
    await this.#request(`/api/blobs/${hash}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: exactArrayBuffer(bytes),
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

function retryAfterMs(res: HttpResponse): number | undefined {
  if (res.status !== 429 || res.headers === undefined) return undefined;
  const entry = Object.entries(res.headers).find(([name]) => name.toLowerCase() === "retry-after");
  const raw = entry?.[1]?.trim();
  if (raw === undefined || raw === "") return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - Date.now());
}
