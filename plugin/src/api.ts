import { DEFAULT_LANES, clampLanes, mapPool } from "./pool";
import type { Manifest } from "./types";
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

const MAX_CHECK_HASHES = 1000;

interface ErrorBody {
  error?: { code?: string; message?: string };
  head?: string | null;
  hashes?: string[];
}

export class SyncApi {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #http: HttpClient;
  readonly #lanes: number;

  constructor(opts: { baseUrl: string; token: string; http: HttpClient; lanes?: number }) {
    // Keep the transport invariant at the lowest credential-bearing boundary too: callers
    // outside the settings UI must not be able to send an access token over remote HTTP.
    this.#baseUrl = normalizeServerUrl(opts.baseUrl);
    this.#token = opts.token;
    this.#http = opts.http;
    this.#lanes = clampLanes(opts.lanes ?? DEFAULT_LANES);
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
    return new ApiError(message, res.status, code);
  }

  async getHead(): Promise<string | null> {
    const res = await this.#request("/api/head");
    return ((await res.json()) as { head: string | null }).head;
  }

  async getManifest(id: string): Promise<Manifest> {
    const res = await this.#request(`/api/manifests/${id}`);
    return (await res.json()) as Manifest;
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

  async commit(manifest: Manifest, expectedHead: string | null): Promise<string> {
    const res = await this.#request("/api/commit", {
      method: "POST",
      body: JSON.stringify({ manifest, expectedHead }),
    });
    return ((await res.json()) as { head: string }).head;
  }
}
