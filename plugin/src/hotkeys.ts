/**
 * Hotkey display and conflict checking.
 *
 * Pure on purpose: the settings row shows what is bound today, and offers a one-click
 * binding only when the combination is genuinely free. Both of those are decisions about
 * strings and sets, so they are testable without Obsidian — the code that actually touches
 * Obsidian's (undocumented) hotkey manager lives in `hotkey-bridge.ts` and does nothing else.
 *
 * The plugin ships NO default hotkey. Obsidian's own API docs say so: "It is recommended for
 * plugins to avoid setting default hotkeys if possible, to avoid conflicting hotkeys with one
 * that's set by the user." A key is claimed only when the user asks for it here.
 */

/** Structurally what Obsidian's `Hotkey` is, without importing the module. */
export interface KeyBinding {
  readonly modifiers: readonly string[];
  readonly key: string;
}

/**
 * Offered for "Sync now" — Mod is Command on macOS and Ctrl elsewhere, so one suggestion
 * reads naturally on every platform. Nothing binds it until the user clicks.
 */
export const SUGGESTED_SYNC_HOTKEY: KeyBinding = { modifiers: ["Mod", "Shift"], key: "S" };

// Apple's order is ⌃⌥⇧⌘; Windows and Linux spell modifiers out with Ctrl leading.
const MAC_ORDER = ["Ctrl", "Alt", "Shift", "Meta"];
const PC_ORDER = ["Ctrl", "Meta", "Alt", "Shift"];
const MAC_SYMBOL: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" };
const PC_NAME: Record<string, string> = { Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Win" };

/**
 * "Mod" is a platform alias, not a key: resolving it is what makes ⌘S and Mod+S the same
 * binding on a Mac and different ones on Windows. Duplicates collapse, because a binding
 * cannot hold the same physical key twice.
 */
function canonicalModifiers(modifiers: readonly string[], isMac: boolean): string[] {
  const out: string[] = [];
  for (const raw of modifiers) {
    const resolved = raw === "Mod" ? (isMac ? "Meta" : "Ctrl") : raw;
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

function orderModifiers(modifiers: readonly string[], isMac: boolean): string[] {
  const order = isMac ? MAC_ORDER : PC_ORDER;
  // An unrecognised modifier is still shown, last: dropping one would report a binding the
  // user does not actually have.
  const unknown = modifiers.filter((m) => !order.includes(m)).sort();
  return [...order.filter((m) => modifiers.includes(m)), ...unknown];
}

function formatKey(key: string): string {
  if (key === " ") return "Space";
  return key.length === 1 ? key.toUpperCase() : key;
}

/** One binding as the user's keyboard labels it, e.g. `⇧⌘S` or `Ctrl+Shift+S`. */
export function formatHotkey(binding: KeyBinding, isMac: boolean): string {
  const modifiers = orderModifiers(canonicalModifiers(binding.modifiers, isMac), isMac);
  const parts = modifiers.map((m) => (isMac ? MAC_SYMBOL[m] ?? m : PC_NAME[m] ?? m));
  const joiner = isMac && parts.every((p) => p.length === 1) ? "" : "+";
  return [...parts, formatKey(binding.key)].join(joiner);
}

/** Every binding a command holds; empty string when it holds none. */
export function formatBindings(bindings: readonly KeyBinding[], isMac: boolean): string {
  return bindings.map((b) => formatHotkey(b, isMac)).join(" or ");
}

/** Whether two bindings are the same keystroke, whatever order and case they are written in. */
export function sameBinding(a: KeyBinding, b: KeyBinding, isMac: boolean): boolean {
  if (a.key.toLowerCase() !== b.key.toLowerCase()) return false;
  const left = canonicalModifiers(a.modifiers, isMac).sort();
  const right = canonicalModifiers(b.modifiers, isMac).sort();
  return left.length === right.length && left.every((m, i) => m === right[i]);
}

/**
 * Command ids already holding `candidate`, sorted. The suggestion is only offered when this
 * is empty: quietly stealing a key the user or another plugin already uses is worse than
 * making them pick one.
 */
export function findBindingConflicts(
  bindings: Readonly<Record<string, readonly KeyBinding[]>>,
  candidate: KeyBinding,
  ignoreIds: readonly string[],
  isMac: boolean
): string[] {
  return Object.entries(bindings)
    .filter(([id, held]) => !ignoreIds.includes(id) && held.some((b) => sameBinding(b, candidate, isMac)))
    .map(([id]) => id)
    .sort();
}
