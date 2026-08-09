/**
 * The only code in the plugin that touches Obsidian's hotkey internals.
 *
 * `app.hotkeyManager` and `app.setting` are real but undocumented: they are not in
 * `obsidian.d.ts`, so a future release may rename or drop them. Everything here is therefore
 * probed before use and reports a distinct "cannot tell" / "did not happen" value instead of
 * throwing — deliberately, not as a silent fallback: the caller renders that state in words
 * ("Set it in Settings → Hotkeys") or raises a notice, so the user is always told. A throw
 * inside the settings tab's `display()` would abandon every control below it, which is exactly
 * how 0.1.0 shipped a half-drawn page.
 *
 * Decisions about bindings — formatting, conflicts — live in `hotkeys.ts` and are pure.
 */
import type { App } from "obsidian";
import type { KeyBinding } from "./hotkeys";

/** Command id → the keystrokes bound to it. Ids are fully qualified: `<plugin id>:<command>`. */
export type Bindings = Record<string, KeyBinding[]>;

interface HotkeyManagerish {
  customKeys?: Bindings;
  defaultKeys?: Bindings;
  setHotkeys?: (commandId: string, keys: KeyBinding[]) => void;
  bake?: () => void;
  save?: () => void;
}

interface HotkeyTabish {
  setQuery?: (query: string) => void;
  searchInputEl?: { value: string };
  updateHotkeyVisibility?: () => void;
}

interface SettingsManagerish {
  open?: () => void;
  openTabById?: (id: string) => unknown;
}

const HOTKEYS_TAB_ID = "hotkeys";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function manager(app: App): HotkeyManagerish | null {
  const found = (app as unknown as { hotkeyManager?: unknown }).hotkeyManager;
  return isRecord(found) ? (found as HotkeyManagerish) : null;
}

/** Both binding tables, or null when neither is readable. */
function tables(app: App): { custom: Bindings | null; fallback: Bindings | null } | null {
  const found = manager(app);
  if (found === null) return null;
  const custom = isRecord(found.customKeys) ? (found.customKeys as Bindings) : null;
  const fallback = isRecord(found.defaultKeys) ? (found.defaultKeys as Bindings) : null;
  return custom === null && fallback === null ? null : { custom, fallback };
}

/**
 * What `commandId` is bound to: `[]` for nothing, `null` when the internals could not be read.
 *
 * A customised entry always wins, including an empty one — that is how Obsidian records "the
 * user removed the default", and reading past it would claim a hotkey that does not fire.
 */
export function boundHotkeys(app: App, commandId: string): KeyBinding[] | null {
  try {
    const found = tables(app);
    if (found === null) return null;
    const own = found.custom?.[commandId];
    if (Array.isArray(own)) return [...own];
    const preset = found.fallback?.[commandId];
    return Array.isArray(preset) ? [...preset] : [];
  } catch {
    return null;
  }
}

/** Every command's bindings, customs overriding defaults; null when unreadable. */
export function allHotkeys(app: App): Bindings | null {
  try {
    const found = tables(app);
    if (found === null) return null;
    const merged: Bindings = {};
    for (const source of [found.fallback, found.custom]) {
      if (source === null) continue;
      for (const [id, keys] of Object.entries(source)) {
        if (Array.isArray(keys)) merged[id] = [...keys];
      }
    }
    return merged;
  } catch {
    return null;
  }
}

/**
 * Bind `commandId` to one keystroke, replacing whatever it had. Returns false without writing
 * anything if the internals are not there — a partial assignment (recorded but not baked) would
 * look bound in the settings page and do nothing when pressed.
 */
export function assignHotkey(app: App, commandId: string, binding: KeyBinding): boolean {
  try {
    const found = manager(app);
    if (found === null || typeof found.setHotkeys !== "function") return false;
    found.setHotkeys(commandId, [{ modifiers: [...binding.modifiers], key: binding.key }]);
    // bake() rebuilds the live keymap; without it the binding only takes effect after a restart.
    found.bake?.();
    found.save?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * Open Settings → Hotkeys with `query` typed into its search box. True once the page is open:
 * pre-filtering is a convenience, and an Obsidian version that renamed the search internals
 * has still put the user where they can bind the key.
 */
export function openHotkeySettings(app: App, query: string): boolean {
  try {
    const settings = (app as unknown as { setting?: unknown }).setting;
    if (!isRecord(settings)) return false;
    const api = settings as SettingsManagerish;
    if (typeof api.open !== "function" || typeof api.openTabById !== "function") return false;
    api.open();
    const tab = api.openTabById(HOTKEYS_TAB_ID);
    if (isRecord(tab)) {
      const hotkeyTab = tab as HotkeyTabish;
      if (typeof hotkeyTab.setQuery === "function") {
        hotkeyTab.setQuery(query);
      } else if (isRecord(hotkeyTab.searchInputEl) && typeof hotkeyTab.updateHotkeyVisibility === "function") {
        hotkeyTab.searchInputEl.value = query;
        hotkeyTab.updateHotkeyVisibility();
      }
    }
    return true;
  } catch {
    return false;
  }
}
