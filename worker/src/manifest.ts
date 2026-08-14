import { z } from "zod";

export const HASH_RE = /^[0-9a-f]{64}$/;
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const KEY_ID_RE = /^[0-9a-f]{16}$/;

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_PATH_BYTES = 1024;
const MAX_FILES = 100_000;
/** Encrypted path map, base64. Generous vs. a 100k-file vault, far under the body cap. */
const MAX_ENC_CHARS = 32 * 1024 * 1024;

/** Returns a human-readable reason the vault path is invalid, or null if valid. */
export function pathError(path: string): string | null {
  if (path.length === 0) return "empty path";
  if (new TextEncoder().encode(path).length > MAX_PATH_BYTES) return "path exceeds 1024 bytes";
  if (path.startsWith("/")) return "absolute path";
  if (path.includes("\\")) return "backslash in path";
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(path)) return "control character in path";
  if (path !== path.normalize("NFC")) return "path not NFC-normalized";
  for (const seg of path.split("/")) {
    if (seg === "") return "empty path segment";
    if (seg === "." || seg === "..") return "dot segment in path";
    if (seg !== seg.trim() || seg.endsWith(".")) return "segment has leading/trailing space or trailing dot";
  }
  return null;
}

export const fileEntrySchema = z
  .object({
    h: z.string().regex(HASH_RE, "h must be a lowercase sha256 hex digest"),
    size: z.number().int().nonnegative(),
    mtime: z.number().int().nonnegative(),
    // Lines of text the file held, so the client's history browser can diff two snapshots
    // without downloading both versions. Optional: every snapshot older than the field lacks
    // it. Only a plaintext vault sends it here at all — an encrypted one keeps it inside
    // `enc`, where the server never sees it, and a plaintext vault has already disclosed
    // every path and content hash, so a line count discloses nothing further.
    lines: z.number().int().nonnegative().optional(),
  })
  .strict();

const common = {
  id: z.string().regex(ULID_RE, "id must be a ULID"),
  parent: z.string().regex(ULID_RE, "parent must be a ULID").nullable(),
  device: z.string().min(1).max(64),
  createdAt: z.string().datetime(),
};

/** v1: plaintext snapshot — paths and content hashes are readable by the server. */
export const manifestV1Schema = z
  .object({ v: z.literal(1), ...common, files: z.record(z.string(), fileEntrySchema) })
  .strict();

export const encPayloadSchema = z
  .object({
    alg: z.literal("AES-GCM"),
    // 96-bit IV, base64 — exactly 16 chars. Anything else is a client bug, not a variant.
    iv: z.string().length(16).regex(B64_RE, "iv must be base64"),
    data: z.string().min(1).max(MAX_ENC_CHARS).regex(B64_RE, "data must be base64"),
  })
  .strict();

/**
 * v2: end-to-end encrypted snapshot. The server sees only the blob key list (needed to
 * verify existence at commit and to trace liveness in GC) and an opaque ciphertext holding
 * the path→entry map. Paths, file contents, and plaintext hashes never reach the server.
 */
const encryptedShape = {
  ...common,
  keyId: z.string().regex(KEY_ID_RE, "keyId must be 16 lowercase hex chars"),
  blobs: z.array(z.string().regex(HASH_RE, "blob must be a sha256 hex digest")).max(MAX_FILES),
  enc: encPayloadSchema,
};

export const manifestV2Schema = z.object({ v: z.literal(2), ...encryptedShape }).strict();

/**
 * v3 is v2 on the wire. The difference is invisible here and deliberately so: the client
 * additionally authenticates this envelope as AES-GCM associated data, so the fields the
 * server reads (id, parent, device, createdAt, keyId, blobs) can no longer be swapped around
 * a valid ciphertext by whoever holds an access token. The server cannot check that — it has
 * no key — which is exactly why the version exists: a client must know to verify it.
 */
export const manifestV3Schema = z.object({ v: z.literal(3), ...encryptedShape }).strict();

export const manifestSchema = z.discriminatedUnion("v", [
  manifestV1Schema,
  manifestV2Schema,
  manifestV3Schema,
]);

export type ManifestV1 = z.infer<typeof manifestV1Schema>;
export type ManifestV2 = z.infer<typeof manifestV2Schema>;
export type ManifestV3 = z.infer<typeof manifestV3Schema>;
export type Manifest = ManifestV1 | ManifestV2 | ManifestV3;

/** R2 blob keys referenced by a snapshot, whichever version it is. */
export function manifestHashes(m: Manifest): string[] {
  return m.v === 1 ? Object.values(m.files).map((f) => f.h) : m.blobs;
}

/**
 * Deterministic serialization, used to decide whether re-committing the current head is a
 * genuine retry or a different snapshot wearing an ID that is already taken. Object keys are
 * sorted so a client that reorders its JSON still compares equal; array order is data (the
 * blob list) and is preserved.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

/** True when the snapshot holds no files — the only remote state a fresh device may adopt. */
export function isEmptyManifest(m: Manifest): boolean {
  return m.v === 1 ? Object.keys(m.files).length === 0 : m.blobs.length === 0;
}

export type ManifestValidation =
  | { ok: true; manifest: Manifest }
  | { ok: false; message: string };

export function validateManifest(data: unknown): ManifestValidation {
  const parsed = manifestSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: `${issue.path.join(".") || "manifest"}: ${issue.message}` };
  }
  let m: Manifest = parsed.data;

  if (m.v === 1) {
    // Zod 3 builds record outputs with `{}` and assigning the special `__proto__` key then
    // changes that object's prototype instead of creating a file entry. Rebuild from the
    // already schema-checked input into a null-prototype path map, validating every raw own
    // key again so the recovered special entry cannot bypass fileEntrySchema.
    const rawFiles = (data as { files: Record<string, unknown> }).files;
    const files = Object.create(null) as ManifestV1["files"];
    for (const path of Object.keys(rawFiles)) {
      const entry = fileEntrySchema.safeParse(rawFiles[path]);
      if (!entry.success) {
        const issue = entry.error.issues[0];
        return {
          ok: false,
          message: `files.${path}.${issue.path.join(".")}: ${issue.message}`,
        };
      }
      files[path] = entry.data;
    }
    m = { ...m, files };
  }

  if (m.v === 2 || m.v === 3) {
    // Duplicates would still work (callers dedupe), but they signal a broken client and
    // inflate the commit body, so reject rather than paper over.
    if (new Set(m.blobs).size !== m.blobs.length) {
      return { ok: false, message: "blobs contains duplicate hashes" };
    }
    return { ok: true, manifest: m };
  }

  const paths = Object.keys(m.files);
  if (paths.length > MAX_FILES) return { ok: false, message: `manifest exceeds ${MAX_FILES} files` };
  for (const p of paths) {
    const err = pathError(p);
    if (err) return { ok: false, message: `invalid path "${p}": ${err}` };
  }
  return { ok: true, manifest: m };
}
