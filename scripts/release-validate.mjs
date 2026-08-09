import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function fail(message) {
  throw new Error(`release validation failed: ${message}`);
}

function readJson(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return { text, value: JSON.parse(text) };
  } catch (error) {
    fail(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateManifest(manifest) {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    fail("manifest must be an object");
  }
  for (const field of ["id", "name", "version", "minAppVersion", "description", "author"]) {
    if (typeof manifest[field] !== "string" || manifest[field].trim() === "") {
      fail(`manifest field ${field} must be a non-empty string`);
    }
  }
  if (manifest.isDesktopOnly !== false) fail("manifest must set isDesktopOnly to false");
  if (!/^[a-z-]+$/.test(manifest.id)) fail("plugin id must contain only lowercase letters and hyphens");
  if (manifest.id.includes("obsidian")) fail('plugin id must not contain "obsidian"');
  if (manifest.id.endsWith("plugin")) fail('plugin id must not end with "plugin"');
  if (/\b(?:obsidian|plugin)\b/i.test(manifest.name)) {
    fail('plugin display name must not contain "Obsidian" or "Plugin"');
  }
  if (!SEMVER.test(manifest.version)) fail("manifest version must be SemVer without a v prefix");
}

export function validateRelease(rootDir, { tag = null, requireDist = false } = {}) {
  const root = readJson(path.join(rootDir, "manifest.json"));
  const plugin = readJson(path.join(rootDir, "plugin", "manifest.json"));
  validateManifest(root.value);
  if (plugin.text !== root.text) fail("root and plugin manifest.json must be byte-for-byte equal");

  const versions = readJson(path.join(rootDir, "versions.json")).value;
  if (versions[root.value.version] !== root.value.minAppVersion) {
    fail(`versions.json must map ${root.value.version} to ${root.value.minAppVersion}`);
  }
  if (tag !== null && tag !== root.value.version) {
    fail(`tag ${tag} does not equal manifest version ${root.value.version}`);
  }

  if (requireDist) {
    const dist = path.join(rootDir, "plugin", "dist");
    for (const name of ["main.js", "manifest.json", "styles.css"]) {
      const file = path.join(dist, name);
      if (!existsSync(file)) fail(`missing built release asset ${file}`);
      if (readFileSync(file).byteLength === 0) fail(`built release asset ${file} is empty`);
    }
    if (readFileSync(path.join(dist, "manifest.json"), "utf8") !== root.text) {
      fail("built manifest.json does not match the repository-root manifest");
    }
  }
  return root.value;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.dirname(here);
  const tag = process.argv[2] ?? null;
  const manifest = validateRelease(rootDir, { tag, requireDist: true });
  console.log(`release ${manifest.version} validated`);
}
