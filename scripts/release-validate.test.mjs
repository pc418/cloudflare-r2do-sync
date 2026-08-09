import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { validateManifest, validateRelease } from "./release-validate.mjs";

const manifest = {
  id: "cloudflare-rdo-sync",
  name: "R2DO Sync",
  version: "0.1.0",
  minAppVersion: "1.5.0",
  description: "Sync to R2.",
  author: "jg",
  isDesktopOnly: false,
};

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "r2do-release-"));
  await mkdir(path.join(root, "plugin", "dist"), { recursive: true });
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(root, "manifest.json"), text);
  await writeFile(path.join(root, "plugin", "manifest.json"), text);
  await writeFile(path.join(root, "versions.json"), '{"0.1.0":"1.5.0"}\n');
  await writeFile(path.join(root, "plugin", "dist", "manifest.json"), text);
  await writeFile(path.join(root, "plugin", "dist", "main.js"), "main");
  await writeFile(path.join(root, "plugin", "dist", "styles.css"), "/* styles */");
  return root;
}

test("accepts a matching Obsidian release layout", async () => {
  const root = await fixture();
  assert.equal(validateRelease(root, { tag: "0.1.0", requireDist: true }).id, manifest.id);
});

test("rejects a tag that differs from the manifest version", async () => {
  const root = await fixture();
  assert.throws(() => validateRelease(root, { tag: "v0.1.0" }), /does not equal/);
});

test("rejects stale duplicate manifests", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "plugin", "manifest.json"), "{}\n");
  assert.throws(() => validateRelease(root), /byte-for-byte/);
});

test("rejects illegal community plugin ids and names", () => {
  assert.throws(() => validateManifest({ ...manifest, id: "obsidian-sync" }), /must not contain/);
  assert.throws(() => validateManifest({ ...manifest, name: "R2DO Plugin" }), /display name/);
});

test("rejects missing release assets", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "plugin", "dist", "styles.css"), "");
  assert.throws(() => validateRelease(root, { requireDist: true }), /is empty/);
});
