import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  LogSyncSettingTab,
  dataResponsibility,
  type Settings,
} from "../src/main";
import { App, type FakeElement, type RenderLog } from "./obsidian-fake";

// Vitest aliases "obsidian" to the fake at runtime, but tsc still resolves the real types
// (src must keep typechecking against the real API). Bridge the two here, in one place.
function logOf(tab: LogSyncSettingTab): RenderLog {
  return (tab.containerEl as unknown as FakeElement).log;
}
function newTab(plugin: unknown, app: unknown = new App()): LogSyncSettingTab {
  return new LogSyncSettingTab(app as never, plugin as never);
}

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
    async requestEncryptionTarget() {},
    async forcePull() {},
    async forcePush() {},
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
    expect(log.headings).toEqual(["Encryption", "Safety", "Advanced"]);
  });

  it("renders the credential fields and the device name below them", () => {
    const { names } = render();
    // The TDZ bug stopped exactly here: the first two rendered, "Device name" did not.
    expect(names.slice(0, 3)).toEqual(["Server URL", "Access token", "Device name"]);
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
    "Sync log",
    "Parallel lanes",
    "Sync log length",
    "Report folder",
    "Snapshots listed in history",
    "Automatic retries",
    "Notice when a sync finishes",
    "Only notice syncs that changed something",
    "List the changed files in the notice",
    "Sync settings between devices",
    "Test connection",
  ])("renders %s", (name) => {
    expect(render().names).toContain(name);
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
    expect(names).not.toContain("Reveal master key");
    expect(names).not.toContain("Turn off encryption");
    // Everything after the encryption block must still render.
    expect(names).toContain("Test connection");
  });

  // Rendering a button proves nothing about it doing anything — the class of bug this whole
  // spec exists for. These two are the destructive pair, so they are worth wiring checks.
  it.each([
    ["Pull remote over local", "Pull remote", "pull"],
    ["Push local over remote", "Push local", "push"],
  ])("wires %s to the plugin action", (row, button, action) => {
    const called: string[] = [];
    const plugin = fakePlugin();
    plugin.forcePull = async () => void called.push("pull");
    plugin.forcePush = async () => void called.push("push");
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
    ["Notice when a sync finishes", "notifyOnSync", false],
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
    expect(at("Notice when a sync finishes")).toBeLessThan(
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

    it("will not offer device setup before there is anything to hand over", () => {
      const { setting, button } = setupRow({ serverUrl: "", accessToken: "" });
      expect(button.disabled).toBe(true);
      expect(setting.desc).toContain("nothing to hand over");
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

    it.each(["Key backup required", "Reveal master key"])(
      "hides %s until a key has been generated",
      (row) => {
        expect(render({ masterKey: "" }).names).not.toContain(row);
      }
    );
  });

  // A fresh install used to land on two bare credential fields. Joining an existing vault was
  // reachable only from the command palette, or from the key-mismatch banner that appears
  // *after* a hand-configuration has already failed — the failure taught the user what the
  // page should have said first.
  describe("first run", () => {
    const FRESH: Partial<Settings> = { serverUrl: "", accessToken: "" };

    it("leads with the setup panel, ahead of every other section", () => {
      expect(render(FRESH).log.headings).toEqual([
        "Set up sync",
        "Encryption",
        "Safety",
        "Advanced",
      ]);
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

  it("renders identically on a second display() call", () => {
    const tab = newTab(fakePlugin());
    tab.display();
    const first = logOf(tab).settings.map((s) => s.name);
    tab.display();
    expect(logOf(tab).settings.map((s) => s.name)).toEqual(first);
  });
});
