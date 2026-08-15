import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  LogSyncSettingTab,
  dataResponsibility,
  type Settings,
} from "../src/main";
import { App, type FakeElement, Modal, Notice, Platform, type RenderLog } from "./obsidian-fake";

// Vitest aliases "obsidian" to the fake at runtime, but tsc still resolves the real types
// (src must keep typechecking against the real API). Bridge the two here, in one place.
function logOf(tab: LogSyncSettingTab): RenderLog {
  return (tab.containerEl as unknown as FakeElement).log;
}
function newTab(plugin: unknown, app: unknown = new App()): LogSyncSettingTab {
  return new LogSyncSettingTab(app as never, plugin as never);
}
function bodyOf(modal: Modal): FakeElement {
  return modal.contentEl as unknown as FakeElement;
}
/** Lets a staged commit finish: its handler is fire-and-forget, by design. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  Notice.shown.length = 0;
  Modal.shown.length = 0;
});

afterEach(() => {
  Platform.isMobile = false;
});

// The settings tab is the plugin's whole configuration surface. It used to render only
// "Server URL" and "Access token" in real Obsidian: `const tokenSetting = new Setting(...)`
// referenced `tokenSetting` from inside its own chained addText() callback, which runs before
// the const is initialised, so display() threw a TDZ ReferenceError and abandoned every
// control below it. Nothing caught that, because no test had ever rendered this tab.

// The default fixture is a device that is already connected, because that is the state this
// page spends its life in. A device with no credentials renders an extra first-run panel
// ahead of everything else, so tests about the ordinary page must not start from that state;
// the "first run" block below opts back into it explicitly.
const CONFIGURED: Partial<Settings> = {
  serverUrl: "https://vault.example.workers.dev",
  accessToken: "access-token",
};

function fakePlugin(over: Partial<Settings> = {}, keyMismatch: string | null = null) {
  const settings: Settings = { ...DEFAULT_SETTINGS, ...CONFIGURED, ...over };
  return {
    app: new App(),
    settings,
    saved: 0,
    encryptionEnabled: settings.encryptionMode === "encrypted",
    hasSyncedSnapshot: false,
    keyMismatch,
    lastConflicts: [] as unknown[],
    syncCommandId: "cloudflare-rdo-sync:sync-now",
    hotkeySearchQuery: "R2DO Sync",
    async saveSettings() {
      this.saved += 1;
    },
    async syncNow() {},
    async previewSync() {},
    async openHistory() {},
    async exportLog() {},
    async applySetup() {},
    requested: 0,
    async requestEncryptionTarget() {
      this.requested += 1;
    },
    async forcePull() {},
    async forcePush() {},
    async rebuildHistory() {},
    openConflictReview() {
      this.reviewed += 1;
    },
    reviewed: 0,
  };
}

function render(
  over: Partial<Settings> = {},
  keyMismatch: string | null = null,
  app: unknown = new App()
): { log: RenderLog; names: string[] } {
  const tab = newTab(fakePlugin(over, keyMismatch), app);
  tab.display();
  const log = logOf(tab);
  return { log, names: log.settings.map((s) => s.name) };
}

describe("settings tab rendering", () => {
  it("renders every section heading", () => {
    const { log } = render();
    // Grouped by what each part of the plugin does. There is deliberately no "Advanced"
    // bucket: it grouped settings by how obscure they looked, which split every feature
    // across two places — the retry count a page away from the schedule, the history depth
    // a page away from the history browser, the log length a page away from the export.
    expect(log.headings).toEqual([
      "Connection",
      "This device",
      "Encryption",
      "What syncs",
      "How and when it syncs",
      "Conflicts",
      "Safety and recovery",
      "Notices",
      "Troubleshooting",
    ]);
  });

  it.each([
    ["Sync direction", "How and when it syncs"],
    ["Automatic retries", "How and when it syncs"],
    ["Parallel lanes", "How and when it syncs"],
    ["Conflict handling", "Conflicts"],
    ["Unresolved conflicts", "Conflicts"],
    ["Rebuild remote history", "Safety and recovery"],
    ["Snapshots listed in history", "Safety and recovery"],
    ["Sync log length", "Troubleshooting"],
    ["Report folder", "Troubleshooting"],
    ["Sync settings between devices", "This device"],
  ])("files %s under %s", (row, heading) => {
    const found = render().log.settings.find((s) => s.name === row);
    expect(found, row).toBeDefined();
    expect(found?.section).toBe(heading);
  });

  it("keeps the sync log export with the knobs that shape it", () => {
    const { names } = render();
    expect(names.indexOf("Sync log")).toBeLessThan(names.indexOf("Sync log length"));
    expect(names.indexOf("Sync log length")).toBeLessThan(names.indexOf("Report folder"));
  });

  it("renders the credential fields with the connection test beside them", () => {
    const { names } = render();
    // The TDZ bug stopped after the first two: "Device name" never rendered at all. The test
    // moved up here from the bottom of "Advanced", a page away from the only two values it
    // can say anything about.
    expect(names.slice(0, 3)).toEqual(["Server URL", "Access token", "Test connection"]);
    expect(names.indexOf("Device name")).toBeGreaterThan(names.indexOf("Test connection"));
  });

  it("opens with what the plugin does, rather than closing with it", () => {
    // This paragraph is the page's orientation text. It used to be the very last thing below
    // "Advanced", where the person deciding whether to trust the plugin never reaches it.
    expect(render().log.paragraphs[0]).toContain("Two-way sync");
  });

  it.each([
    "Vault master key",
    "Set up another device",
    "Apply a setup link",
    "Only sync matching paths",
    "Sync direction",
    "Sync Obsidian configuration directory",
    "Exclude globs",
    "Debounce (seconds)",
    "Periodic sync (minutes)",
    "Sync on startup",
    "Sync hotkey",
    "Ask before large changes (%)",
    "Conflict handling",
    "Preview sync",
    "Snapshot history",
    "Unresolved conflicts",
    "Pull remote over local",
    "Push local over remote",
    "Rebuild remote history",
    "Sync log",
    "Parallel lanes",
    "Sync log length",
    "Report folder",
    "Snapshots listed in history",
    "Automatic retries",
    "Notice when a sync runs",
    "Only notice syncs that changed something",
    "List the changed files in the notice",
    "Sync settings between devices",
    "Test connection",
  ])("renders %s", (name) => {
    expect(render().names).toContain(name);
  });

  it("warns that rebuilding history destroys it, before anything is clicked", () => {
    const desc = render().log.settings.find((s) => s.name === "Rebuild remote history")?.desc;
    expect(desc).toContain("DISCARDS every earlier one");
    expect(desc).toContain("Nothing it removes can be restored");
    // "Purged" and "unreachable" are different promises, and the difference is a day.
    expect(desc).toContain("daily collection");
  });

  it("gives every rendered setting a name and at least one control", () => {
    const { log } = render();
    for (const setting of log.settings) {
      expect(setting.name, JSON.stringify(setting)).not.toBe("");
      expect(setting.controls.length, setting.name).toBeGreaterThan(0);
    }
  });

  it("offers the reveal control on both secret fields", () => {
    const { log } = render({ masterKey: "a".repeat(44), masterKeyBackedUp: true });
    const token = log.settings.find((s) => s.name === "Access token");
    const key = log.settings.find((s) => s.name === "Vault master key");
    expect(token?.controls).toContain("extra-button");
    expect(key?.controls).toContain("extra-button");
  });

  it("shows the backup gate only while the key is unacknowledged", () => {
    expect(render({ masterKey: "a".repeat(44), masterKeyBackedUp: false }).names).toContain(
      "Key backup required"
    );
    expect(render({ masterKey: "a".repeat(44), masterKeyBackedUp: true }).names).not.toContain(
      "Key backup required"
    );
  });

  it("renders the plaintext variant without the encryption-only controls", () => {
    const { names } = render({ encryptionMode: "plaintext", masterKey: "", masterKeyBackedUp: true });
    expect(names).toContain("Vault master key");
    expect(names).not.toContain("Turn off encryption");
    // Everything after the encryption block must still render.
    expect(names).toContain("Test connection");
  });

  // Rendering a button proves nothing about it doing anything — the class of bug this whole
  // spec exists for. These two are the destructive pair, so they are worth wiring checks.
  it.each([
    ["Pull remote over local", "Pull remote", "pull"],
    ["Push local over remote", "Push local", "push"],
    // The only control on this page that destroys history rather than moving files.
    ["Rebuild remote history", "Rebuild", "rebuild"],
  ])("wires %s to the plugin action", (row, button, action) => {
    const called: string[] = [];
    const plugin = fakePlugin();
    plugin.forcePull = async () => void called.push("pull");
    plugin.forcePush = async () => void called.push("push");
    plugin.rebuildHistory = async () => void called.push("rebuild");
    const tab = newTab(plugin);
    tab.display();
    const log = logOf(tab);

    const index = log.settings.findIndex((s) => s.name === row);
    const control = log.rows[index].buttons.find((b) => b.text === button);
    control?.click();

    expect(control).toBeDefined();
    expect(called).toEqual([action]);
  });

  // Three toggles that read almost identically. A copy-paste that pointed two of them at one
  // setting would render perfectly and quietly do the wrong thing.
  it.each([
    ["Notice when a sync runs", "notifyOnSync", false],
    ["Only notice syncs that changed something", "notifyOnlyChanged", true],
    ["List the changed files in the notice", "verboseSyncNotice", true],
    ["Sync on startup", "syncOnStartup", false],
  ] as const)("wires the %s toggle to %s", async (row, key, target) => {
    const plugin = fakePlugin();
    const tab = newTab(plugin);
    tab.display();
    const log = logOf(tab);

    const index = log.settings.findIndex((s) => s.name === row);
    const toggle = log.rows[index].toggles[0];
    expect(toggle.getValue()).toBe(DEFAULT_SETTINGS[key]);

    await toggle.change(target);

    expect(plugin.settings[key]).toBe(target);
    expect(plugin.saved).toBe(1);
    // Nothing else moved with it.
    const others = (["notifyOnSync", "notifyOnlyChanged", "verboseSyncNotice", "syncOnStartup"] as const)
      .filter((k) => k !== key);
    for (const other of others) {
      expect(plugin.settings[other]).toBe(DEFAULT_SETTINGS[other]);
    }
  });

  it("shows the notice toggles in the order they narrow down", () => {
    const { names } = render();
    const at = (name: string) => names.indexOf(name);
    expect(at("Notice when a sync runs")).toBeLessThan(
      at("Only notice syncs that changed something")
    );
    expect(at("Only notice syncs that changed something")).toBeLessThan(
      at("List the changed files in the notice")
    );
  });

  it("offers nothing to review when there are no conflicts, rather than an empty window", () => {
    const { log, names } = render();
    const index = names.indexOf("Unresolved conflicts");
    const button = log.rows[index].buttons[0];
    expect(button.text).toBe("None");
    expect(button.disabled).toBe(true);
  });

  it("counts outstanding conflicts on the button and opens the review", async () => {
    const plugin = fakePlugin();
    plugin.lastConflicts = [{ path: "a.md" }, { path: "b.md" }];
    const tab = newTab(plugin);
    tab.display();
    const log = logOf(tab);

    const index = log.settings.findIndex((s) => s.name === "Unresolved conflicts");
    const button = log.rows[index].buttons[0];
    expect(button.text).toBe("Review 2");
    expect(button.disabled).toBe(false);

    await button.click();
    expect(plugin.reviewed).toBe(1);
  });

  // The hotkey row reads Obsidian internals that may not be there. It must never claim a key
  // it did not verify is free, and must never break the page when the internals are missing.
  describe("sync hotkey row", () => {
    const SYNC = "cloudflare-rdo-sync:sync-now";

    function hotkeyApp(
      defaultKeys: Record<string, unknown[]> = {},
      custom: Record<string, unknown[]> = {}
    ) {
      const opened: string[] = [];
      const queries: string[] = [];
      const customKeys: Record<string, unknown[]> = { ...custom };
      return {
        opened,
        queries,
        customKeys,
        app: {
          hotkeyManager: {
            defaultKeys,
            customKeys,
            setHotkeys(id: string, keys: unknown[]) {
              customKeys[id] = keys;
            },
            bake() {},
            save() {},
          },
          setting: {
            open() {
              opened.push("open");
            },
            openTabById(id: string) {
              opened.push(id);
              return { setQuery: (q: string) => queries.push(q) };
            },
          },
        },
      };
    }

    function row(app: unknown) {
      const { log, names } = render({}, null, app);
      const index = names.indexOf("Sync hotkey");
      return { setting: log.settings[index], buttons: log.rows[index].buttons };
    }

    it("sends the user to Hotkeys when the bindings cannot be read", () => {
      // The fake App has no hotkeyManager at all — the same shape as an Obsidian release that
      // renamed it. Rendering must survive and say something true.
      const { setting, buttons } = row(new App());
      expect(setting.desc).toContain("could not be read");
      expect(setting.desc).toContain('search "R2DO Sync"');
      expect(buttons.map((b) => b.text)).toEqual(["Choose"]);
    });

    it("offers the suggested key when nothing holds it, and binds it on click", () => {
      const fake = hotkeyApp();
      const { setting, buttons } = row(fake.app);
      expect(setting.desc).toContain("Not set");
      // Platform.isMacOS is false in the fake, so the label is the spelled-out form.
      expect(buttons[0].text).toBe("Use Ctrl+Shift+S");
      expect(buttons[0].cta).toBe(true);

      buttons[0].click();

      expect(fake.customKeys[SYNC]).toEqual([{ modifiers: ["Mod", "Shift"], key: "S" }]);
    });

    it("reports the binding it finds and offers to change it", () => {
      const fake = hotkeyApp({}, { [SYNC]: [{ modifiers: ["Alt"], key: "J" }] });
      const { setting, buttons } = row(fake.app);
      expect(setting.desc).toContain("Currently Alt+J");
      expect(buttons.map((b) => b.text)).toEqual(["Change"]);
    });

    it("refuses to offer a key another command already uses", () => {
      const fake = hotkeyApp({ "theme:switch": [{ modifiers: ["Mod", "Shift"], key: "s" }] });
      const { setting, buttons } = row(fake.app);
      expect(setting.desc).toContain("Ctrl+Shift+S is already used by 1 other command");
      expect(buttons.map((b) => b.text)).toEqual(["Choose"]);
    });

    it("opens the hotkeys tab filtered to this plugin", () => {
      const fake = hotkeyApp();
      const { buttons } = row(fake.app);
      buttons[buttons.length - 1].click();
      expect(fake.opened).toEqual(["open", "hotkeys"]);
      expect(fake.queries).toEqual(["R2DO Sync"]);
    });
  });

  // A wrong master key is the one failure these fields cannot fix: server URL and access
  // token do not carry the key. The cure therefore has to be offered here, above them.
  it("offers a setup link above the credentials when the key does not match the vault", () => {
    const { names, log } = render({}, "shared settings were written with a different master key");

    expect(names[0]).toBe("This device is not set up for this vault");
    expect(names[1]).toBe("Server URL");
    expect(log.settings[0].desc).toContain("different master key");
  });

  it("says nothing about setup links when the key is fine", () => {
    expect(render().names).not.toContain("This device is not set up for this vault");
  });

  // The row opens a window that exports two ways now, so a button still labelled "Show QR"
  // would hide the only route to a device that has no camera to scan with.
  it("opens device setup without promising only a QR", () => {
    const { log, names } = render({ masterKey: "a".repeat(44), masterKeyBackedUp: true });
    const index = names.indexOf("Set up another device");
    expect(log.rows[index].buttons.map((b) => b.text)).toEqual(["Set up device"]);
    expect(log.rows[index].buttons[0].disabled).toBe(false);
    expect(log.settings[index].desc).toContain("cannot scan");
  });

  // Every one of these rows used to render an enabled control whose only outcome was an
  // error notice. A button offered for something that cannot be done is a dead end, and the
  // reason belongs on the page rather than in a notice after the click.
  describe("actions with unmet prerequisites", () => {
    function setupRow(over: Partial<Settings>) {
      const { log, names } = render(over);
      const index = names.indexOf("Set up another device");
      return { setting: log.settings[index], button: log.rows[index].buttons[0] };
    }

    it("does not put the row on a page with nothing to hand over at all", () => {
      // Stronger than disabling it: an unconfigured device renders none of the rows that
      // depend on a server, so there is nothing to explain away.
      expect(render({ serverUrl: "", accessToken: "" }).names).not.toContain("Set up another device");
    });

    it("still says why it is blocked when the row renders beside the mismatch banner", () => {
      const { log, names } = render({ serverUrl: "", accessToken: "" }, "a different master key");
      const index = names.indexOf("Set up another device");
      expect(log.rows[index].buttons[0].disabled).toBe(true);
      expect(log.settings[index].desc).toContain("nothing to hand over");
    });

    it("will not offer device setup before the key exists", () => {
      const { setting, button } = setupRow({ masterKey: "" });
      expect(button.disabled).toBe(true);
      expect(setting.desc).toContain("master key to be generated");
    });

    it("will not share a key whose backup is unfinished", () => {
      const { setting, button } = setupRow({ masterKey: "a".repeat(44), masterKeyBackedUp: false });
      expect(button.disabled).toBe(true);
      expect(setting.desc).toContain("not a backup");
    });

    it("hides Key backup required until a key has been generated", () => {
      expect(render({ masterKey: "" }).names).not.toContain("Key backup required");
    });

    // One secret, one place to look at it. The field's own eye toggle shows the same stored
    // key in place, so a separate "Reveal master key" row was a third way to put it on a
    // screen and a second window to close.
    it("offers no separate reveal row beside a field that already reveals", () => {
      const { log, names } = render({ masterKey: "a".repeat(44), masterKeyBackedUp: true });
      expect(names).not.toContain("Reveal master key");
      const key = log.settings.find((s) => s.name === "Vault master key");
      expect(key?.controls).toContain("extra-button");
    });
  });

  // A fresh install used to land on two bare credential fields. Joining an existing vault was
  // reachable only from the command palette, or from the key-mismatch banner that appears
  // *after* a hand-configuration has already failed — the failure taught the user what the
  // page should have said first.
  describe("the Generate key button", () => {
    /** Renders and returns the tab's Generate button, plus the plugin it is wired to. */
    function generateRow(over: Partial<Settings>): {
      plugin: ReturnType<typeof fakePlugin>;
      click: () => void;
    } {
      const plugin = fakePlugin({ encryptionMode: "encrypted", ...over });
      const tab = newTab(plugin);
      tab.display();
      const log = logOf(tab);
      const button = log.rows.flatMap((row) => row.buttons).find((b) => b.text === "Generate");
      if (button === undefined) throw new Error("the encryption section rendered no Generate button");
      return { plugin, click: () => void button.click() };
    }

    it("creates the first key without interrupting onboarding", () => {
      const { plugin, click } = generateRow({ masterKey: "", masterKeyBackedUp: false });
      click();
      // Nothing is being replaced, so there is nothing to confirm — and this is the very
      // path a new user is on. A dialog here would be noise that teaches people to dismiss
      // dialogs; the mandatory backup window that follows is the real gate.
      expect(Modal.shown.filter((m) => bodyOf(m).texts().join(" ").includes("Replace the key"))).toHaveLength(0);
      expect(plugin.requested).toBe(1);
    });

    it("asks before replacing a key this device already holds", () => {
      // No synced snapshot, so no migration is involved — but this key may have been typed in
      // from another device and never used. Overwriting it silently strands this device.
      const { plugin, click } = generateRow({ masterKey: "a".repeat(44), masterKeyBackedUp: true });
      click();

      expect(plugin.requested).toBe(0);
      const confirm = Modal.shown.at(-1)!;
      const text = bodyOf(confirm).texts().join(" ");
      expect(text).toContain("Replace the key this device holds?");
      expect(text).toContain("last moment it exists on this device");
    });
  });

  describe("first run", () => {
    const FRESH: Partial<Settings> = { serverUrl: "", accessToken: "" };

    it("leads with the setup panel and shows nothing that needs a server yet", () => {
      // Every section below "Connection" needs credentials to do anything, and each one is
      // something to scroll past on the way to the two fields that provide them.
      const { log, names } = render(FRESH);
      expect(log.headings).toEqual(["Set up sync", "Connection"]);
      expect(names).toEqual([
        "Join a vault that already syncs",
        "Server URL",
        "Access token",
        "Test connection",
        "Device name",
      ]);
    });

    it("grows into the whole page the moment both credentials are in", async () => {
      const plugin = fakePlugin(FRESH);
      const tab = newTab(plugin);
      tab.display();
      const url = logOf(tab).rows[1].texts[0];
      const token = logOf(tab).rows[2].texts[0];

      url.inputEl.value = "https://vault.example.workers.dev";
      url.inputEl.fire("blur");
      await flush();
      // Half a pair configures nothing, so the page is still the short one.
      expect(logOf(tab).settings.map((s) => s.name)).not.toContain("Vault master key");

      token.inputEl.value = "access-token";
      token.inputEl.fire("blur");
      await flush();

      const names = logOf(tab).settings.map((s) => s.name);
      expect(names).toContain("Vault master key");
      expect(names).toContain("Exclude globs");
      expect(names).not.toContain("Join a vault that already syncs");
    });

    it("offers the setup-link route first, as the default action", () => {
      const { log, names } = render(FRESH);
      expect(names.indexOf("Join a vault that already syncs")).toBe(0);
      const button = log.rows[0].buttons[0];
      expect(button.text).toBe("Paste setup link");
      expect(button.cta).toBe(true);
      // Rendering a button proves nothing about it opening anything.
      expect(() => button.click()).not.toThrow();
    });

    it("warns that hand-typed credentials cannot join an encrypted vault", () => {
      // The single most expensive misunderstanding this plugin has: a URL and a token look
      // like enough, so the user types them and the device silently mints a key of its own.
      expect(render(FRESH).log.settings[0].desc).toContain("mint a key of its own");
    });

    it("points a first device at the setup script and the fields below", () => {
      expect(render(FRESH).log.paragraphs.join(" ")).toContain("scripts/setup.mjs");
    });

    // The instruction is a procedure to carry out on another device while reading it here, so
    // it is short paragraphs with the path called out — not the six-sentence block it was.
    it("spells out where to click on the device that already syncs", () => {
      const said = render(FRESH).log.paragraphs.join(" ");
      expect(said).toContain("Settings → R2DO Sync → Set up another device");
      expect(said).toContain("Copy setup link");
    });

    it("links to the instructions, for a user who installed the plugin and has no clone", () => {
      const tab = newTab(fakePlugin(FRESH));
      tab.display();
      const links = (tab.containerEl as unknown as FakeElement).children
        .flatMap((c) => c.children)
        .filter((c) => c.tag === "a");
      expect(links.map((a) => a.href)).toEqual([
        "https://github.com/pc418/cloudflare-r2do-sync#readme",
      ]);
    });

    it("states that the user is responsible for their own data", () => {
      expect(render(FRESH).log.paragraphs).toContain(dataResponsibility("encrypted"));
    });

    it("does not promise encryption to a device set to plaintext", () => {
      const { log } = render({ ...FRESH, encryptionMode: "plaintext", masterKeyBackedUp: true });
      expect(log.paragraphs).toContain(dataResponsibility("plaintext"));
      expect(log.paragraphs).not.toContain(dataResponsibility("encrypted"));
    });

    it("still gives every row of the fresh page a name and a control", () => {
      for (const setting of render(FRESH).log.settings) {
        expect(setting.name, JSON.stringify(setting)).not.toBe("");
        expect(setting.controls.length, setting.name).toBeGreaterThan(0);
      }
    });

    it("drops the panel entirely once the device is connected", () => {
      const { log, names } = render();
      expect(names).not.toContain("Join a vault that already syncs");
      expect(log.paragraphs).not.toContain(dataResponsibility("encrypted"));
    });

    it.each([
      ["no token", { serverUrl: "https://vault.example.workers.dev", accessToken: "" }],
      ["no URL", { serverUrl: "", accessToken: "access-token" }],
      ["blank-looking values", { serverUrl: "   ", accessToken: "  " }],
    ])("still counts as unconfigured with %s", (_label, over) => {
      expect(render(over).names).toContain("Join a vault that already syncs");
    });

    it("yields to the key-mismatch banner instead of offering two paste routes", () => {
      // Both cures are "paste a setup link". Rendering them together would put two primary
      // buttons that do the same thing on one page.
      const { log, names } = render(FRESH, "written with a different master key");
      expect(names[0]).toBe("This device is not set up for this vault");
      expect(log.headings).not.toContain("Set up sync");
      expect(names).not.toContain("Join a vault that already syncs");
    });
  });

  // Every field on this page used to store what it held after each keystroke. Typing "100"
  // into a field holding 50 therefore stored 1, then 10, then 100 — two values nobody asked
  // for — and for the guard threshold the 100 raised a confirmation in the middle of the word,
  // whose Cancel then restored the intermediate 10 rather than the 50 the user started with.
  describe("staged fields", () => {
    function field(over: Partial<Settings>, row: string) {
      const plugin = fakePlugin(over);
      const tab = newTab(plugin);
      tab.display();
      const log = logOf(tab);
      const index = log.settings.findIndex((s) => s.name === row);
      if (index < 0) throw new Error(`no "${row}" row`);
      return { plugin, tab, text: log.rows[index].texts[0] };
    }

    it("stores nothing while the value is being typed", async () => {
      const { plugin, text } = field({}, "Periodic sync (minutes)");
      text.change("3");
      text.change("30");
      await flush();
      expect(plugin.saved).toBe(0);
      expect(plugin.settings.intervalMinutes).toBe(DEFAULT_SETTINGS.intervalMinutes);
    });

    it("stores the finished value when the field loses focus", async () => {
      const { plugin, text } = field({}, "Periodic sync (minutes)");
      text.change("30");
      text.inputEl.fire("blur");
      await flush();
      expect(plugin.settings.intervalMinutes).toBe(30);
      expect(plugin.saved).toBe(1);
    });

    it("stores it on Enter too, without waiting for focus to move", async () => {
      const { plugin, text } = field({}, "Debounce (seconds)");
      text.change("12");
      text.inputEl.fire("keydown", { key: "Enter" });
      await flush();
      expect(plugin.settings.debounceSeconds).toBe(12);
    });

    it("ignores other keys", async () => {
      const { plugin, text } = field({}, "Debounce (seconds)");
      text.change("12");
      text.inputEl.fire("keydown", { key: "2" });
      await flush();
      expect(plugin.saved).toBe(0);
    });

    // A settings page can close with a field still focused, and on some platforms that never
    // fires blur. Silently discarding what was typed is the worst of the three outcomes.
    it("flushes a still-focused field when the page closes", async () => {
      const { plugin, tab, text } = field({}, "Parallel lanes");
      text.change("8");
      tab.hide();
      await flush();
      expect(plugin.settings.lanes).toBe(8);
    });

    it("does not save again for a field that was already committed", async () => {
      const { plugin, tab, text } = field({}, "Parallel lanes");
      text.change("8");
      text.inputEl.fire("blur");
      await flush();
      tab.hide();
      await flush();
      expect(plugin.saved).toBe(1);
    });

    it.each([
      ["out of range", "99"],
      ["not a number", "four"],
      ["fractional", "2.5"],
      ["empty", ""],
    ])("refuses a %s value out loud and keeps the stored one", async (_label, typed) => {
      const { plugin, text } = field({ lanes: 4 }, "Parallel lanes");
      text.change(typed);
      text.inputEl.fire("blur");
      await flush();
      expect(plugin.settings.lanes).toBe(4);
      expect(plugin.saved).toBe(0);
      // The field must not be left disagreeing with what is stored: that reads as accepted.
      expect(text.getValue()).toBe("4");
      expect(Notice.shown.join(" ")).toContain("Parallel lanes takes 1–16");
    });

    it("asks before the threshold's off switch, and applies it when answered", async () => {
      const { plugin, text } = field({ protectPercent: 50 }, "Ask before large changes (%)");
      text.change("100");
      text.inputEl.fire("blur");
      await flush();

      const confirm = Modal.shown.at(-1);
      expect(bodyOf(confirm!).log.headings).toContain("Turn off the mass-change guard?");
      expect(plugin.settings.protectPercent).toBe(50);

      const button = bodyOf(confirm!).log.rows.flatMap((r) => r.buttons).find((b) => b.text === "Turn it off");
      await button?.click();
      await flush();
      expect(plugin.settings.protectPercent).toBe(100);
    });

    it("restores the threshold that was there when the question is declined", async () => {
      const { plugin, text } = field({ protectPercent: 50 }, "Ask before large changes (%)");
      text.change("100");
      text.inputEl.fire("blur");
      await flush();

      const cancel = bodyOf(Modal.shown.at(-1)!)
        .log.rows.flatMap((r) => r.buttons)
        .find((b) => b.text === "Keep the guard");
      await cancel?.click();
      await flush();

      expect(plugin.settings.protectPercent).toBe(50);
      // Not the 10 that "100" passed through on its way in.
      expect(text.getValue()).toBe("50");
      expect(plugin.saved).toBe(0);
    });

    it("does not ask again for any other threshold", async () => {
      const { plugin, text } = field({ protectPercent: 50 }, "Ask before large changes (%)");
      text.change("75");
      text.inputEl.fire("blur");
      await flush();
      expect(Modal.shown).toEqual([]);
      expect(plugin.settings.protectPercent).toBe(75);
    });

    it("refuses a server URL it cannot normalise and says so", async () => {
      const { plugin, text } = field({}, "Server URL");
      text.change("definitely not a url");
      text.inputEl.fire("blur");
      await flush();
      expect(plugin.settings.serverUrl).toBe("https://vault.example.workers.dev");
      expect(text.getValue()).toBe("https://vault.example.workers.dev");
      expect(Notice.shown.join(" ")).toContain("server URL rejected");
    });

    it("trims a pasted access token on commit", async () => {
      const { plugin, text } = field({}, "Access token");
      text.change("  pasted-token\n");
      await flush();
      expect(plugin.saved).toBe(0);
      text.inputEl.fire("blur");
      await flush();
      expect(plugin.settings.accessToken).toBe("pasted-token");
    });

    it("keeps a name for a device whose name field was cleared", async () => {
      const { plugin, text } = field({ deviceName: "laptop" }, "Device name");
      text.change("   ");
      text.inputEl.fire("blur");
      await flush();
      expect(plugin.settings.deviceName).toBe("device");
    });

    it("commits glob lists on blur rather than on every keystroke", async () => {
      const { plugin, text } = field({}, "Exclude globs");
      text.change(".trash/**\n.arch");
      await flush();
      // A half-typed glob must never be the live exclude rule.
      expect(plugin.settings.excludes).toBe(DEFAULT_SETTINGS.excludes);
      text.change(".trash/**\n.archive/**");
      text.inputEl.fire("blur");
      await flush();
      expect(plugin.settings.excludes).toBe(".trash/**\n.archive/**");
      expect(plugin.saved).toBe(1);
    });
  });

  // A glob's effect used to be visible only in the aftermath of a sync.
  describe("glob match counts", () => {
    const VAULT = ["note.md", "log/2026-08-08.md", "log/2026-08-07.md", "img/a.png", ".trash/old.md"];
    const indexedApp = { vault: { getFiles: () => VAULT.map((path) => ({ path })) } };

    function scope(over: Partial<Settings> = {}) {
      const tab = newTab(fakePlugin(over), indexedApp);
      tab.display();
      const container = tab.containerEl as unknown as FakeElement;
      return { tab, hints: container.byClass("r2do-hint").map((h) => h.text), container };
    }

    it("counts what the current rules keep, not what the vault holds", () => {
      // `.trash/**` is the default exclude, so four of five files sync.
      const { hints } = scope();
      expect(hints[0]).toContain("4 of 5 files in Obsidian's index");
      expect(hints[1]).toContain("Excludes drop 1 file of the 5");
    });

    it("counts and names the vault's own configuration directory, not `.obsidian`", () => {
      const CUSTOM = ".config-obsidian";
      const files = ["note.md", `${CUSTOM}/app.json`, `${CUSTOM}/plugins/cloudflare-rdo-sync/data.json`];
      const app = { vault: { configDir: CUSTOM, getFiles: () => files.map((path) => ({ path })) } };
      const tab = newTab(fakePlugin({ syncConfigDir: true, excludes: "" }), app);
      tab.display();
      const container = tab.containerEl as unknown as FakeElement;
      // Config files are in scope once the toggle is on; our own credential file never is.
      expect(container.byClass("r2do-hint")[0].text).toContain("2 of 3 files");
      const desc = logOf(tab).settings.find(
        (s) => s.name === "Sync Obsidian configuration directory"
      )?.desc;
      expect(desc).toContain(`${CUSTOM}/**`);
      expect(desc).not.toContain(".obsidian/**");
    });

    it("counts an allow-list", () => {
      const { hints } = scope({ onlyPaths: "log/**" });
      expect(hints[0]).toContain("Allow-list matches 2 of 5");
    });

    it("follows the draft while it is typed, before anything is stored", () => {
      const { tab, container } = scope();
      const log = logOf(tab);
      const index = log.settings.findIndex((s) => s.name === "Only sync matching paths");
      log.rows[index].texts[0].change("img/**");
      expect(container.byClass("r2do-hint")[0].text).toContain("matches 1 of 5");
    });

    it("says nothing at all when the file index cannot be read", () => {
      // "We cannot tell" and "nothing matches" are different answers, and a 0 that means the
      // first one is the kind of number that sends someone rewriting a working glob.
      const container = (() => {
        const tab = newTab(fakePlugin());
        tab.display();
        return tab.containerEl as unknown as FakeElement;
      })();
      expect(container.byClass("r2do-hint")).toEqual([]);
    });
  });

  it("reveals the master key in place, and never through a notice", async () => {
    const key = "a".repeat(44);
    const { log, names } = render({ masterKey: key, masterKeyBackedUp: true });
    const row = log.rows[names.indexOf("Vault master key")];
    const field = row.texts[0].inputEl;
    expect(field.type).toBe("password");

    row.buttons[0].click();

    expect(field.type).toBe("text");
    expect(field.value).toBe(key);
    // A Notice cannot be selected on a phone, stays on top of the page until dismissed, and
    // is the part of the screen people photograph.
    expect(Notice.shown.join(" ")).not.toContain(key);
  });

  // A row about keystrokes on a device with no keyboard, sending the user to a settings page
  // that mobile Obsidian does not have.
  it("leaves the hotkey row off a phone", () => {
    Platform.isMobile = true;
    expect(render().names).not.toContain("Sync hotkey");
  });

  it("renders identically on a second display() call", () => {
    const tab = newTab(fakePlugin());
    tab.display();
    const first = logOf(tab).settings.map((s) => s.name);
    tab.display();
    expect(logOf(tab).settings.map((s) => s.name)).toEqual(first);
  });
});
