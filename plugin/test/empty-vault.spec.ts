// The first pass of a device that has nothing of its own to publish.
//
// A brand-new install handed a setup link cannot damage the remote — a first sync has no base,
// so `planFile` has no deletion to reach — but it CAN publish the blank note the app created on
// its way in, and the ordinary first-sync gate promises "everything here is published", which
// is the wrong thing to tell someone whose device is empty. So such a pass is downgraded to
// pull-only and asked a different question.
import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_VAULT_MAX_BYTES, EMPTY_VAULT_MAX_FILES, SyncEngine, isBlankContent } from "../src/sync";
import { FakeServer, FakeStore, FakeVault } from "./fakes";
import type { FileEntry, Manifest } from "../src/types";

let vault: FakeVault;
let server: FakeServer;
let store: FakeStore;

function makeEngine(overrides: Partial<ConstructorParameters<typeof SyncEngine>[0]> = {}): SyncEngine {
  return new SyncEngine({
    vault,
    api: server,
    store,
    deviceName: "fresh-device",
    excludes: [".obsidian/**"],
    maxBlobBytes: 4 * 1024 * 1024,
    now: () => 1_754_000_000_000,
    ...overrides,
  });
}

/** These vaults are unencrypted, so the published path map is readable as-is. */
function plaintextPaths(manifest: Manifest): Record<string, FileEntry> {
  if (!("files" in manifest)) throw new Error("expected a plaintext manifest");
  return manifest.files;
}

beforeEach(() => {
  vault = new FakeVault();
  server = new FakeServer();
  store = new FakeStore();
});

describe("isBlankContent", () => {
  it("counts nothing and whitespace as blank", () => {
    const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
    expect(isBlankContent(new Uint8Array(0))).toBe(true);
    expect(isBlankContent(enc(" "))).toBe(true);
    expect(isBlankContent(enc("\n\n  \t\r\n"))).toBe(true);
    // The case this exists for: Obsidian's blank first note.
    expect(isBlankContent(enc("\n"))).toBe(true);
  });

  it("counts anything a person wrote as content", () => {
    const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
    expect(isBlankContent(enc("hi"))).toBe(false);
    expect(isBlankContent(enc("  x  "))).toBe(false);
    // A single zero byte is not whitespace, and "small" is not "empty".
    expect(isBlankContent(new Uint8Array([0]))).toBe(false);
  });

  it("treats undecodable bytes as content rather than guessing", () => {
    // A lone 0xFF is invalid UTF-8. Reading it as "empty enough not to publish" would quietly
    // drop somebody's file, so anything that does not decode cleanly counts as content.
    expect(isBlankContent(new Uint8Array([0xff]))).toBe(false);
    expect(isBlankContent(new Uint8Array([0x00, 0x01, 0x02]))).toBe(false);
  });
});

describe("SyncEngine.isEffectivelyEmpty", () => {
  it("is true for a vault with no files at all", async () => {
    await expect(makeEngine().isEffectivelyEmpty()).resolves.toBe(true);
  });

  it("is true when every file is blank", async () => {
    vault.set("Untitled.md", "");
    vault.set("Untitled 1.md", "   \n\n");
    await expect(makeEngine().isEffectivelyEmpty()).resolves.toBe(true);
  });

  it("is false as soon as one file has real content", async () => {
    vault.set("Untitled.md", "");
    vault.set("notes/real.md", "something I wrote\n");
    await expect(makeEngine().isEffectivelyEmpty()).resolves.toBe(false);
  });

  it("ignores paths that would never be published anyway", async () => {
    // Excluded, hard-skipped and out-of-scope files say nothing about whether this device has
    // anything to contribute: the pass would not publish them either way.
    vault.set(".obsidian/app.json", '{"theme":"obsidian"}');
    vault.set(".trash/deleted.md", "old note\n");
    await expect(
      makeEngine({ excludes: [".obsidian/**", ".trash/**"] }).isEffectivelyEmpty()
    ).resolves.toBe(true);

    vault.set("drafts/keep.md", "content\n");
    await expect(
      makeEngine({ excludes: [".obsidian/**", ".trash/**"], onlyPaths: ["notes/**"] }).isEffectivelyEmpty()
    ).resolves.toBe(true);
  });

  it("settles a large file from the listing without reading it", async () => {
    vault.set("big.md", "x".repeat(EMPTY_VAULT_MAX_BYTES + 1));
    await expect(makeEngine().isEffectivelyEmpty()).resolves.toBe(false);
    // Nothing was read: a file that size is content whatever its bytes are, and the answer
    // must not cost a read per file on a vault that is obviously not empty.
    expect(vault.reads).toHaveLength(0);
  });

  it("stops looking once there are clearly too many files", async () => {
    for (let i = 0; i <= EMPTY_VAULT_MAX_FILES; i++) vault.set(`blank-${i}.md`, "");
    await expect(makeEngine().isEffectivelyEmpty()).resolves.toBe(false);
    expect(vault.reads).toHaveLength(0);
  });
});

describe("a pull-only first pass", () => {
  it("writes the remote here and publishes nothing", async () => {
    // The vault this device is joining.
    const other = new FakeVault();
    other.set("notes/shared.md", "everyone's note\n");
    const publisher = new SyncEngine({
      vault: other,
      api: server,
      store: new FakeStore(),
      deviceName: "existing-device",
      excludes: [".obsidian/**"],
      maxBlobBytes: 4 * 1024 * 1024,
      now: () => 1_754_000_000_000,
    });
    await publisher.sync();
    const publishedHead = server.head;

    // The fresh device: one blank note the app made on its way in.
    vault.set("Untitled.md", "\n");
    const result = await makeEngine().sync({ pullOnly: true });

    expect(result.status).toBe("pulled");
    expect(vault.text("notes/shared.md")).toBe("everyone's note\n");
    // The blank note is still here — nothing is deleted — and the remote never heard of it.
    expect(vault.files.has("Untitled.md")).toBe(true);
    expect(server.head).toBe(publishedHead);
  });

  it("leaves the device syncing normally afterwards", async () => {
    const result = await makeEngine().sync({ pullOnly: true });
    expect(result.status).toBe("unchanged");

    // The downgrade is per pass, not a mode: the very next pass publishes as usual.
    vault.set("Untitled.md", "no longer blank\n");
    const engine = makeEngine();
    await engine.sync();
    expect(server.head).not.toBeNull();
    expect(Object.keys(plaintextPaths(await server.getManifest(server.head!)))).toContain(
      "Untitled.md"
    );
  });

  it("refuses to be combined with a publish", async () => {
    // `keepLocal` and `reroot` exist to publish this device over the remote. Silently doing
    // neither would be worse than refusing.
    await expect(makeEngine().sync({ pullOnly: true, keepLocal: true })).rejects.toThrow(
      /cannot be combined/
    );
  });

  it("never reverses a direction the operator chose", async () => {
    vault.set("note.md", "mine\n");
    // push-only is a deliberate setting — a backup device. Downgrading it to pull-only would
    // start writing over the very files it exists to protect.
    const engine = makeEngine({ mode: "push-only" });
    await engine.sync({ pullOnly: true });
    expect(server.head).not.toBeNull();
    expect(Object.keys(plaintextPaths(await server.getManifest(server.head!)))).toContain(
      "note.md"
    );
  });
});
