import { describe, it, expect } from "vitest";
import {
  alwaysSkip,
  globToRegExp,
  makeExcluder,
  pathError,
  LEGACY_PLUGIN_DIR,
  PLUGIN_DIR,
} from "../src/paths";

describe("pathError", () => {
  it("accepts ordinary vault paths", () => {
    expect(pathError("daily/2026-08-03.md")).toBeNull();
    expect(pathError("a.md")).toBeNull();
  });

  it("rejects the server's forbidden shapes", () => {
    expect(pathError("")).toMatch(/empty/);
    expect(pathError("/abs.md")).toMatch(/absolute/);
    expect(pathError("a\\b.md")).toMatch(/backslash/);
    expect(pathError("../escape.md")).toMatch(/dot segment/);
    expect(pathError("a//b.md")).toMatch(/empty path segment/);
    expect(pathError("x".repeat(1200))).toMatch(/1024/);
  });

  it("rejects control characters, which is also what catches macOS Icon files", () => {
    expect(pathError(`Icon${String.fromCharCode(13)}`)).toMatch(/control character/);
  });

  it("rejects segments with edge whitespace or a trailing dot", () => {
    expect(pathError("a /b.md")).toMatch(/leading\/trailing space/);
    expect(pathError("dir./b.md")).toMatch(/trailing dot/);
  });
});

describe("globToRegExp", () => {
  it("treats * as within-segment and ** as across segments", () => {
    expect(globToRegExp("*.md").test("a.md")).toBe(true);
    expect(globToRegExp("*.md").test("dir/a.md")).toBe(false);
    expect(globToRegExp(".obsidian/**").test(".obsidian/deep/nested.json")).toBe(true);
  });

  it("escapes regex metacharacters in literal text", () => {
    expect(globToRegExp("a+b.md").test("a+b.md")).toBe(true);
    expect(globToRegExp("a+b.md").test("aab.md")).toBe(false);
  });
});

describe("makeExcluder", () => {
  it("ignores blank lines so a trailing newline in settings is harmless", () => {
    const excluded = makeExcluder(["", "  ", ".trash/**"]);
    expect(excluded("a.md")).toBe(false);
    expect(excluded(".trash/x.md")).toBe(true);
  });
});

describe("alwaysSkip — junk", () => {
  it("skips OS and editor droppings anywhere in the tree", () => {
    for (const p of [
      ".DS_Store",
      "notes/.DS_Store",
      "Thumbs.db",
      "notes/thumbs.db",
      "desktop.ini",
      "notes/Desktop.ini",
    ]) {
      expect(alwaysSkip(p), p).toBe(true);
    }
  });

  it("skips Office lock files, which are transient by nature", () => {
    expect(alwaysSkip("~$report.docx")).toBe(true);
    expect(alwaysSkip("dir/~$sheet.xlsx")).toBe(true);
  });

  it("skips the macOS folder-icon marker (Icon + carriage return)", () => {
    expect(alwaysSkip(`Icon${String.fromCharCode(13)}`)).toBe(true);
    expect(alwaysSkip(`dir/Icon${String.fromCharCode(13)}`)).toBe(true);
  });

  it("skips VCS and dependency directories at any depth", () => {
    expect(alwaysSkip(".git/config")).toBe(true);
    expect(alwaysSkip("sub/.git/HEAD")).toBe(true);
    expect(alwaysSkip("node_modules/pkg/index.js")).toBe(true);
    expect(alwaysSkip("__MACOSX/._a")).toBe(true);
  });

  it("leaves real notes alone, including lookalike names", () => {
    for (const p of [
      "daily/2026-08-03.md",
      "Icon.md",
      "notes/desktop.ini.md",
      "gitignore.md",
      "my-node_modules-notes.md",
      "~tilde.md",
    ]) {
      expect(alwaysSkip(p), p).toBe(false);
    }
  });
});

describe("alwaysSkip — hard self-excludes", () => {
  it("never syncs this plugin's own directory", () => {
    // data.json holds the access token and the vault master key in plaintext. Uploading it
    // would put the key in the vault it protects; pulling another device's copy would
    // silently swap this device's identity.
    expect(alwaysSkip(`${PLUGIN_DIR}/data.json`)).toBe(true);
    expect(alwaysSkip(`${PLUGIN_DIR}/main.js`)).toBe(true);
    expect(alwaysSkip(`${LEGACY_PLUGIN_DIR}/data.json`)).toBe(true);
  });

  it("never syncs workspace layout files", () => {
    expect(alwaysSkip(".obsidian/workspace.json")).toBe(true);
    expect(alwaysSkip(".obsidian/workspace-mobile.json")).toBe(true);
  });

  it("still allows other plugins and config files, which config-dir sync may want", () => {
    expect(alwaysSkip(".obsidian/plugins/dataview/data.json")).toBe(false);
    expect(alwaysSkip(".obsidian/themes/mytheme/theme.css")).toBe(false);
    expect(alwaysSkip(".obsidian/hotkeys.json")).toBe(false);
  });
});
