import { describe, it, expect } from "vitest";
import { isEmptyManifest, manifestHashes, validateManifest, pathError } from "../src/manifest";
import { makeManifest, makeManifestV2, ulid } from "./helpers";

const HASH = "a".repeat(64);

describe("pathError", () => {
  it.each([
    ["daily/2026-08-03.md", null],
    ["note.md", null],
    ["deep/nested/dir/file.md", null],
  ])("accepts %s", (p, want) => {
    expect(pathError(p)).toBe(want);
  });

  it.each([
    ["", "empty"],
    ["/abs/path.md", "absolute"],
    ["a/../b.md", "dot"],
    ["../escape.md", "dot"],
    ["./x.md", "dot"],
    ["a//b.md", "segment"],
    ["a\\b.md", "backslash"],
    ["a/b.md\u0000", "control"],
  ])("rejects %j", (p) => {
    expect(pathError(p)).not.toBeNull();
  });

  it("rejects paths over 1024 bytes", () => {
    expect(pathError("a/".repeat(600) + "x.md")).not.toBeNull();
  });

  it("rejects non-NFC paths", () => {
    const nfd = "café.md"; // NFD é
    expect(pathError(nfd)).not.toBeNull();
    expect(pathError(nfd.normalize("NFC"))).toBeNull();
  });
});

describe("validateManifest", () => {
  it("accepts a well-formed manifest", () => {
    const m = makeManifest({ files: { "a.md": { h: HASH } } });
    const r = validateManifest(m);
    expect(r.ok).toBe(true);
  });

  it("accepts an empty vault manifest", () => {
    const r = validateManifest(makeManifest({ files: {} }));
    expect(r.ok).toBe(true);
  });

  it("preserves a root __proto__ path through validation", () => {
    const files = Object.create(null) as Record<string, { h: string }>;
    files.__proto__ = { h: HASH };
    const r = validateManifest(makeManifest({ files }));
    expect(r.ok).toBe(true);
    if (r.ok && r.manifest.v === 1) {
      expect(Object.hasOwn(r.manifest.files, "__proto__")).toBe(true);
      expect(r.manifest.files.__proto__.h).toBe(HASH);
    }
  });

  it("does not let an invalid __proto__ entry bypass the recovered-key validation", () => {
    const files = Object.create(null) as Record<string, { h: string }>;
    files.__proto__ = { h: "not-a-hash" };
    const r = validateManifest(makeManifest({ files }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("__proto__");
  });

  it("rejects wrong version, bad id, bad hash, extra keys", () => {
    const base = makeManifest({ files: { "a.md": { h: HASH } } });
    expect(validateManifest({ ...base, v: 3 }).ok).toBe(false);
    expect(validateManifest({ ...base, v: 2 }).ok).toBe(false); // v1 body labelled v2
    expect(validateManifest({ ...base, id: "not-a-ulid" }).ok).toBe(false);
    expect(
      validateManifest({ ...base, files: { "a.md": { h: "xyz", size: 1, mtime: 1 } } }).ok
    ).toBe(false);
    expect(validateManifest({ ...base, surprise: true }).ok).toBe(false);
  });

  it("accepts an optional line count, and still rejects a nonsense one", () => {
    const withCount = makeManifest({ files: { "a.md": { h: HASH } } }) as {
      files: Record<string, Record<string, unknown>>;
    };
    withCount.files["a.md"].lines = 42;
    expect(validateManifest(withCount).ok).toBe(true);

    // The count is shown to a user as fact, so a broken one is a broken commit, not a
    // field to shrug at.
    for (const bad of [-1, 1.5, "12", null]) {
      withCount.files["a.md"].lines = bad;
      expect(validateManifest(withCount).ok, `lines: ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("rejects manifests containing an invalid path", () => {
    const m = makeManifest({ files: { "../evil.md": { h: HASH } } });
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("evil.md");
  });

  it("rejects non-object input loudly", () => {
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest("hi").ok).toBe(false);
    expect(validateManifest(42).ok).toBe(false);
  });

  it("accepts a parent chain reference", () => {
    const parent = ulid();
    const r = validateManifest(makeManifest({ parent, files: {} }));
    expect(r.ok).toBe(true);
  });
});

describe("validateManifest — v2 (encrypted)", () => {
  it("accepts a well-formed encrypted manifest", () => {
    const r = validateManifest(makeManifestV2({ blobs: [HASH] }));
    expect(r.ok).toBe(true);
  });

  it("accepts an empty encrypted vault", () => {
    expect(validateManifest(makeManifestV2({ blobs: [] })).ok).toBe(true);
  });

  it("rejects a bad keyId", () => {
    expect(validateManifest(makeManifestV2({ blobs: [], keyId: "nothex" })).ok).toBe(false);
    expect(validateManifest(makeManifestV2({ blobs: [], keyId: "AABBCCDDEEFF0011" })).ok).toBe(false);
  });

  it("rejects a non-sha256 blob entry", () => {
    expect(validateManifest(makeManifestV2({ blobs: ["nope"] })).ok).toBe(false);
  });

  it("rejects duplicate blob hashes", () => {
    const r = validateManifest(makeManifestV2({ blobs: [HASH, HASH] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("duplicate");
  });

  it("rejects a malformed enc payload", () => {
    const bad = (enc: unknown) => validateManifest({ ...makeManifestV2({ blobs: [] }), enc }).ok;
    expect(bad({ alg: "AES-GCM", iv: "AAAAAAAAAAAAAAAA", data: "" })).toBe(false); // empty
    expect(bad({ alg: "AES-GCM", iv: "short", data: "ZmFrZQ==" })).toBe(false); // wrong IV size
    expect(bad({ alg: "AES-CBC", iv: "AAAAAAAAAAAAAAAA", data: "ZmFrZQ==" })).toBe(false);
    expect(bad({ alg: "AES-GCM", iv: "AAAAAAAAAAAAAAAA", data: "not base64!" })).toBe(false);
    expect(bad(undefined)).toBe(false);
  });

  it("rejects a plaintext files map smuggled alongside enc", () => {
    const m = { ...makeManifestV2({ blobs: [HASH] }), files: { "a.md": { h: HASH, size: 1, mtime: 1 } } };
    expect(validateManifest(m).ok).toBe(false);
  });
});

describe("manifestHashes / isEmptyManifest", () => {
  it("reads hashes from either version", () => {
    expect(manifestHashes(makeManifest({ files: { "a.md": { h: HASH } } }))).toEqual([HASH]);
    expect(manifestHashes(makeManifestV2({ blobs: [HASH] }))).toEqual([HASH]);
  });

  it("detects emptiness in either version", () => {
    expect(isEmptyManifest(makeManifest({ files: {} }))).toBe(true);
    expect(isEmptyManifest(makeManifest({ files: { "a.md": { h: HASH } } }))).toBe(false);
    expect(isEmptyManifest(makeManifestV2({ blobs: [] }))).toBe(true);
    expect(isEmptyManifest(makeManifestV2({ blobs: [HASH] }))).toBe(false);
  });
});
