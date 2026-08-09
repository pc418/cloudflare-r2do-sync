import { describe, it, expect } from "vitest";
import {
  alwaysSkip,
  countInScope,
  globToRegExp,
  isConfigPath,
  makeExcluder,
  makeScopeFilter,
  parseGlobs,
  pathError,
  selfDirs,
  DEFAULT_CONFIG_DIR,
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

// Obsidian lets a vault rename its configuration folder. Every rule that protects this
// plugin's own `data.json` — access token and master key, in plaintext — is keyed on that name,
// so a hardcoded `.obsidian` would upload the credentials of any vault that renamed it.
describe("a renamed configuration directory", () => {
  const CUSTOM = ".config-obsidian";

  it("skips our credential folder inside the directory the vault actually uses", () => {
    expect(alwaysSkip(`${CUSTOM}/plugins/cloudflare-rdo-sync/data.json`, CUSTOM)).toBe(true);
    expect(alwaysSkip(`${CUSTOM}/plugins/obsidian-log-sync/data.json`, CUSTOM)).toBe(true);
  });

  it("is what the default argument was silently getting wrong", () => {
    // The pre-fix behaviour, kept as the regression: with no configDir the custom path is
    // ordinary vault content, and syncing it publishes the key.
    expect(alwaysSkip(`${CUSTOM}/plugins/cloudflare-rdo-sync/data.json`)).toBe(false);
  });

  it("still skips the default directory as well, because a rename leaves the old one on disk", () => {
    expect(alwaysSkip(`${PLUGIN_DIR}/data.json`, CUSTOM)).toBe(true);
    expect(alwaysSkip(`${LEGACY_PLUGIN_DIR}/data.json`, CUSTOM)).toBe(true);
    expect(selfDirs(CUSTOM)).toContain(PLUGIN_DIR);
    expect(selfDirs(CUSTOM)).toHaveLength(4);
  });

  it("lists only the default pair when that is the directory in use", () => {
    expect(selfDirs(DEFAULT_CONFIG_DIR)).toEqual([PLUGIN_DIR, LEGACY_PLUGIN_DIR]);
    expect(selfDirs()).toEqual([PLUGIN_DIR, LEGACY_PLUGIN_DIR]);
  });

  it("skips workspace layout files under either name", () => {
    expect(alwaysSkip(`${CUSTOM}/workspace.json`, CUSTOM)).toBe(true);
    expect(alwaysSkip(`${CUSTOM}/workspace-mobile.json`, CUSTOM)).toBe(true);
    expect(alwaysSkip(".obsidian/workspace.json", CUSTOM)).toBe(true);
  });

  it("gates the config-directory opt-in on the active name only", () => {
    // Unlike the credential skip: a directory left over from a previous config-folder name is
    // ordinary content, not the config this vault's user consented to publish.
    expect(isConfigPath(`${CUSTOM}/app.json`, CUSTOM)).toBe(true);
    expect(isConfigPath(".obsidian/app.json", CUSTOM)).toBe(false);
  });

  it("carries through the scope filter the settings page counts with", () => {
    const files = [`${CUSTOM}/app.json`, `${CUSTOM}/plugins/cloudflare-rdo-sync/data.json`, "note.md"];
    const rules = { excludes: [], onlyPaths: [], syncConfigDir: false, configDir: CUSTOM };
    expect(files.filter(makeScopeFilter(rules))).toEqual(["note.md"]);
    // Opting in reaches the config files without ever reaching our own.
    expect(files.filter(makeScopeFilter({ ...rules, syncConfigDir: true }))).toEqual([
      `${CUSTOM}/app.json`,
      "note.md",
    ]);
  });
});

describe("parseGlobs", () => {
  it("takes one glob per line and drops the blanks", () => {
    expect(parseGlobs("a/**\n\n  b/*  \n")).toEqual(["a/**", "b/*"]);
  });

  it("treats an empty setting as no globs at all", () => {
    expect(parseGlobs("")).toEqual([]);
    expect(parseGlobs("   \n  ")).toEqual([]);
  });
});

describe("isConfigPath", () => {
  it("covers the directory and everything under it", () => {
    expect(isConfigPath(".obsidian")).toBe(true);
    expect(isConfigPath(".obsidian/app.json")).toBe(true);
  });

  it("does not catch a note whose name merely starts the same way", () => {
    expect(isConfigPath(".obsidian-notes/a.md")).toBe(false);
    expect(isConfigPath("notes/.obsidian/a.md")).toBe(false);
  });
});

// The settings page counts what a glob list would do without running a pass, so this predicate
// has to agree with the engine's own scope rule. A count that disagrees is worse than none.
describe("makeScopeFilter", () => {
  const VAULT = [
    "note.md",
    "log/2026-08-08.md",
    "img/a.png",
    ".trash/old.md",
    ".DS_Store",
    ".obsidian/app.json",
    `${PLUGIN_DIR}/data.json`,
  ];

  it("keeps ordinary files and drops junk, the config directory and our own folder", () => {
    const rules = { excludes: [".trash/**"], onlyPaths: [], syncConfigDir: false };
    expect(VAULT.filter(makeScopeFilter(rules))).toEqual(["note.md", "log/2026-08-08.md", "img/a.png"]);
  });

  it("lets the config directory in on request, still without our own folder", () => {
    const rules = { excludes: [".trash/**"], onlyPaths: [], syncConfigDir: true };
    const kept = VAULT.filter(makeScopeFilter(rules));
    expect(kept).toContain(".obsidian/app.json");
    expect(kept).not.toContain(`${PLUGIN_DIR}/data.json`);
  });

  it("narrows to the allow-list when there is one", () => {
    const rules = { excludes: [], onlyPaths: ["log/**"], syncConfigDir: false };
    expect(VAULT.filter(makeScopeFilter(rules))).toEqual(["log/2026-08-08.md"]);
  });

  it("applies excludes on top of the allow-list rather than instead of it", () => {
    const rules = { excludes: ["log/2026-08-08.md"], onlyPaths: ["log/**", "note.md"], syncConfigDir: false };
    expect(VAULT.filter(makeScopeFilter(rules))).toEqual(["note.md"]);
  });

  it("refuses a path the server would reject", () => {
    const inScope = makeScopeFilter({ excludes: [], onlyPaths: [], syncConfigDir: false });
    expect(inScope("bad\\path.md")).toBe(false);
    expect(inScope("/absolute.md")).toBe(false);
  });

  it("counts what it keeps", () => {
    expect(countInScope(VAULT, { excludes: [".trash/**"], onlyPaths: [], syncConfigDir: false })).toBe(3);
    expect(countInScope([], { excludes: [], onlyPaths: [], syncConfigDir: false })).toBe(0);
  });
});
