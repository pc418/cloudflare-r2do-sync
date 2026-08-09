import { describe, expect, it } from "vitest";
import {
  SUGGESTED_SYNC_HOTKEY,
  findBindingConflicts,
  formatBindings,
  formatHotkey,
  sameBinding,
  type KeyBinding,
} from "../src/hotkeys";

// The user reads these strings to decide whether a key is free, so they have to match what
// their keyboard actually says: Command symbols on macOS, spelled-out names elsewhere.

describe("formatHotkey", () => {
  it("uses macOS symbols in Apple's modifier order", () => {
    expect(formatHotkey({ modifiers: ["Mod", "Shift"], key: "s" }, true)).toBe("⇧⌘S");
    expect(formatHotkey({ modifiers: ["Shift", "Mod"], key: "s" }, true)).toBe("⇧⌘S");
    expect(formatHotkey({ modifiers: ["Alt", "Ctrl", "Shift", "Meta"], key: "k" }, true)).toBe(
      "⌃⌥⇧⌘K"
    );
  });

  it("spells modifiers out on other platforms", () => {
    expect(formatHotkey({ modifiers: ["Mod", "Shift"], key: "s" }, false)).toBe("Ctrl+Shift+S");
    expect(formatHotkey({ modifiers: ["Meta"], key: "e" }, false)).toBe("Win+E");
  });

  it("collapses Mod onto the platform key it means", () => {
    // Both spellings are the same physical key, so showing "Ctrl+Ctrl+S" would be a lie.
    expect(formatHotkey({ modifiers: ["Mod", "Ctrl"], key: "s" }, false)).toBe("Ctrl+S");
    expect(formatHotkey({ modifiers: ["Mod", "Meta"], key: "s" }, true)).toBe("⌘S");
  });

  it("names keys the way a keyboard does", () => {
    expect(formatHotkey({ modifiers: [], key: " " }, false)).toBe("Space");
    expect(formatHotkey({ modifiers: ["Mod"], key: "F5" }, false)).toBe("Ctrl+F5");
    expect(formatHotkey({ modifiers: [], key: "Enter" }, false)).toBe("Enter");
  });

  it("shows a modifier it does not know rather than dropping it", () => {
    // A silently dropped modifier would report a binding the user does not have.
    expect(formatHotkey({ modifiers: ["Hyper"], key: "s" }, false)).toBe("Hyper+S");
  });

  it("formats the suggested sync binding on both platforms", () => {
    expect(formatHotkey(SUGGESTED_SYNC_HOTKEY, true)).toBe("⇧⌘S");
    expect(formatHotkey(SUGGESTED_SYNC_HOTKEY, false)).toBe("Ctrl+Shift+S");
  });
});

describe("formatBindings", () => {
  it("is empty when a command has no hotkey", () => {
    expect(formatBindings([], false)).toBe("");
  });

  it("lists every binding a command has", () => {
    const list: KeyBinding[] = [
      { modifiers: ["Mod", "Shift"], key: "s" },
      { modifiers: ["Alt"], key: "s" },
    ];
    expect(formatBindings(list, false)).toBe("Ctrl+Shift+S or Alt+S");
  });
});

describe("sameBinding", () => {
  it("ignores modifier order and key case", () => {
    expect(
      sameBinding({ modifiers: ["Shift", "Mod"], key: "S" }, { modifiers: ["Mod", "Shift"], key: "s" }, false)
    ).toBe(true);
  });

  it("resolves Mod per platform", () => {
    const mod: KeyBinding = { modifiers: ["Mod"], key: "s" };
    const meta: KeyBinding = { modifiers: ["Meta"], key: "s" };
    const ctrl: KeyBinding = { modifiers: ["Ctrl"], key: "s" };
    expect(sameBinding(mod, meta, true)).toBe(true);
    expect(sameBinding(mod, ctrl, true)).toBe(false);
    expect(sameBinding(mod, ctrl, false)).toBe(true);
    expect(sameBinding(mod, meta, false)).toBe(false);
  });

  it("separates a bare key from a modified one", () => {
    expect(sameBinding({ modifiers: [], key: "s" }, { modifiers: ["Mod"], key: "s" }, false)).toBe(false);
  });
});

describe("findBindingConflicts", () => {
  const bindings: Record<string, KeyBinding[]> = {
    "editor:save-file": [{ modifiers: ["Mod"], key: "s" }],
    "theme:switch": [{ modifiers: ["Mod", "Shift"], key: "s" }],
    "other:thing": [{ modifiers: ["Alt"], key: "q" }, { modifiers: ["Mod", "Shift"], key: "s" }],
    "cloudflare-rdo-sync:sync-now": [{ modifiers: ["Mod", "Shift"], key: "s" }],
    "nothing:bound": [],
  };

  it("names every command already holding the combination, sorted", () => {
    expect(findBindingConflicts(bindings, SUGGESTED_SYNC_HOTKEY, [], false)).toEqual([
      "cloudflare-rdo-sync:sync-now",
      "other:thing",
      "theme:switch",
    ]);
  });

  it("skips the command being bound", () => {
    expect(
      findBindingConflicts(bindings, SUGGESTED_SYNC_HOTKEY, ["cloudflare-rdo-sync:sync-now"], false)
    ).toEqual(["other:thing", "theme:switch"]);
  });

  it("does not count a different combination", () => {
    expect(findBindingConflicts(bindings, { modifiers: ["Mod"], key: "s" }, [], false)).toEqual([
      "editor:save-file",
    ]);
  });

  it("finds nothing when the combination is free", () => {
    expect(findBindingConflicts(bindings, { modifiers: ["Mod", "Alt"], key: "j" }, [], false)).toEqual([]);
  });
});
