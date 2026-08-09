import { describe, expect, it } from "vitest";
import { allHotkeys, assignHotkey, boundHotkeys, openHotkeySettings } from "../src/hotkey-bridge";
import type { KeyBinding } from "../src/hotkeys";

// These functions reach into Obsidian internals that no public API covers, so the contract
// worth pinning is the *degradation*: a missing or changed internal must report "cannot tell"
// or "did not happen", never throw. A throw inside display() abandons the rest of the tab.

const SYNC = "cloudflare-rdo-sync:sync-now";
const MOD_SHIFT_S: KeyBinding = { modifiers: ["Mod", "Shift"], key: "S" };

function fakeApp(hotkeyManager: unknown, setting?: unknown): never {
  return { hotkeyManager, setting } as never;
}

describe("boundHotkeys", () => {
  it("prefers what the user customised over the default", () => {
    const app = fakeApp({
      defaultKeys: { [SYNC]: [{ modifiers: ["Alt"], key: "S" }] },
      customKeys: { [SYNC]: [MOD_SHIFT_S] },
    });
    expect(boundHotkeys(app, SYNC)).toEqual([MOD_SHIFT_S]);
  });

  it("treats an empty custom list as deliberately unbound", () => {
    // Obsidian records "the user removed the default" exactly this way.
    const app = fakeApp({
      defaultKeys: { [SYNC]: [{ modifiers: ["Alt"], key: "S" }] },
      customKeys: { [SYNC]: [] },
    });
    expect(boundHotkeys(app, SYNC)).toEqual([]);
  });

  it("falls back to the default, and to nothing at all", () => {
    const app = fakeApp({ defaultKeys: { [SYNC]: [MOD_SHIFT_S] }, customKeys: {} });
    expect(boundHotkeys(app, SYNC)).toEqual([MOD_SHIFT_S]);
    expect(boundHotkeys(app, "other:command")).toEqual([]);
  });

  it("reports that it cannot tell when the internal is gone", () => {
    expect(boundHotkeys(fakeApp(undefined), SYNC)).toBeNull();
    expect(boundHotkeys(fakeApp({}), SYNC)).toBeNull();
  });

  it("reports that it cannot tell instead of throwing", () => {
    const app = {
      get hotkeyManager(): unknown {
        throw new Error("internals moved");
      },
    } as never;
    expect(boundHotkeys(app, SYNC)).toBeNull();
  });
});

describe("allHotkeys", () => {
  it("merges defaults with the user's own, customs winning", () => {
    const app = fakeApp({
      defaultKeys: {
        "editor:save-file": [{ modifiers: ["Mod"], key: "S" }],
        "theme:switch": [{ modifiers: ["Mod", "Shift"], key: "S" }],
      },
      customKeys: { "theme:switch": [], [SYNC]: [MOD_SHIFT_S] },
    });
    expect(allHotkeys(app)).toEqual({
      "editor:save-file": [{ modifiers: ["Mod"], key: "S" }],
      "theme:switch": [],
      [SYNC]: [MOD_SHIFT_S],
    });
  });

  it("cannot tell without the internal", () => {
    expect(allHotkeys(fakeApp(undefined))).toBeNull();
  });
});

describe("assignHotkey", () => {
  it("writes the binding and persists it", () => {
    const calls: string[] = [];
    let written: { id: string; keys: readonly KeyBinding[] } | null = null;
    const app = fakeApp({
      customKeys: {},
      setHotkeys(id: string, keys: readonly KeyBinding[]) {
        written = { id, keys };
        calls.push("set");
      },
      bake() {
        calls.push("bake");
      },
      save() {
        calls.push("save");
      },
    });
    expect(assignHotkey(app, SYNC, MOD_SHIFT_S)).toBe(true);
    expect(written).toEqual({ id: SYNC, keys: [MOD_SHIFT_S] });
    // Baking rebuilds the live keymap; without it the binding only works after a restart.
    expect(calls).toEqual(["set", "bake", "save"]);
  });

  it("refuses rather than half-assigning when the internal is missing", () => {
    expect(assignHotkey(fakeApp({ customKeys: {} }), SYNC, MOD_SHIFT_S)).toBe(false);
    expect(assignHotkey(fakeApp(undefined), SYNC, MOD_SHIFT_S)).toBe(false);
  });

  it("reports failure when the internal throws", () => {
    const app = fakeApp({
      setHotkeys() {
        throw new Error("nope");
      },
    });
    expect(assignHotkey(app, SYNC, MOD_SHIFT_S)).toBe(false);
  });
});

describe("openHotkeySettings", () => {
  function settingsFake(tab: unknown) {
    const opened: string[] = [];
    return {
      opened,
      setting: {
        open() {
          opened.push("open");
        },
        openTabById(id: string) {
          opened.push(id);
          return tab;
        },
      },
    };
  }

  it("opens the hotkeys tab and prefills the search", () => {
    const queries: string[] = [];
    const fake = settingsFake({ setQuery: (q: string) => queries.push(q) });
    expect(openHotkeySettings(fakeApp({}, fake.setting), "R2DO Sync")).toBe(true);
    expect(fake.opened).toEqual(["open", "hotkeys"]);
    expect(queries).toEqual(["R2DO Sync"]);
  });

  it("falls back to the search input when setQuery is absent", () => {
    const searchInputEl = { value: "" };
    let refreshed = 0;
    const fake = settingsFake({
      searchInputEl,
      updateHotkeyVisibility: () => {
        refreshed += 1;
      },
    });
    expect(openHotkeySettings(fakeApp({}, fake.setting), "R2DO Sync")).toBe(true);
    expect(searchInputEl.value).toBe("R2DO Sync");
    expect(refreshed).toBe(1);
  });

  it("still succeeds when the tab offers no way to search", () => {
    // The user is looking at the Hotkeys page; pre-filtering it is a convenience, not the point.
    const fake = settingsFake({});
    expect(openHotkeySettings(fakeApp({}, fake.setting), "R2DO Sync")).toBe(true);
    expect(fake.opened).toEqual(["open", "hotkeys"]);
  });

  it("reports failure when settings cannot be opened at all", () => {
    expect(openHotkeySettings(fakeApp({}, undefined), "R2DO Sync")).toBe(false);
    expect(openHotkeySettings(fakeApp({}, { open: () => {} }), "R2DO Sync")).toBe(false);
  });
});
