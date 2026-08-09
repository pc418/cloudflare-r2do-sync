import { afterEach, describe, expect, it, vi } from "vitest";
import { generateMasterKey, generateVaultSalt } from "../src/crypto";
import {
  ApplySetupModal,
  DEFAULT_SETTINGS,
  DeviceSetupModal,
  PasteSetupModal,
  type Settings,
} from "../src/main";
import { encodeSetupUri, parseSetupText, type SetupPayload } from "../src/setup-link";
import { App, type FakeElement, Modal, Notice } from "./obsidian-fake";

// Exporting the payload as a QR only reaches devices that can point a camera at this screen.
// Desktop-to-desktop therefore had no route at all, and the "copy the setup link" the docs
// told people to use only existed when a phone scanner mis-routed obsidian:// into a browser.
// These tests pin the link export, and above all that it decodes back through the very parser
// the paste modal uses — a link the receiving side cannot read would be worse than none.

// Minted with the real generators: a hand-written base64 string is rejected downstream for
// non-canonical padding, and that failure would look like a bug in the export.
const KEY = generateMasterKey();
const SALT = generateVaultSalt();

function fakePlugin(over: Partial<Settings> = {}) {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    serverUrl: "https://vault.example.workers.dev",
    accessToken: "access-token",
    masterKey: KEY,
    masterKeyBackedUp: true,
    vaultSalt: SALT,
    ...over,
  };
  return { app: new App(), settings, encryptionEnabled: settings.encryptionMode === "encrypted" };
}

function open(over: Partial<Settings> = {}) {
  const modal = new DeviceSetupModal(new App() as never, fakePlugin(over) as never);
  modal.open();
  const content = modal.contentEl as unknown as FakeElement;
  const buttons = content.log.rows.flatMap((r) => r.buttons);
  const button = (text: string) => {
    const found = buttons.find((b) => b.text === text);
    if (found === undefined) throw new Error(`no "${text}" button; got ${buttons.map((b) => b.text).join(", ")}`);
    return found;
  };
  return { modal, content, button };
}

/** Vitest's stub is used because `navigator` is a non-writable global in Node. */
function withClipboard(impl: (text: string) => Promise<void>): string[] {
  const written: string[] = [];
  vi.stubGlobal("navigator", {
    clipboard: {
      async writeText(text: string) {
        await impl(text);
        written.push(text);
      },
    },
  });
  return written;
}

afterEach(() => {
  vi.unstubAllGlobals();
  Notice.shown.length = 0;
  Modal.shown.length = 0;
});

/** The buttons a window rendered, by label. */
function buttonsOf(content: FakeElement) {
  const all = content.log.rows.flatMap((r) => r.buttons);
  return (text: string) => {
    const found = all.find((b) => b.text === text);
    if (found === undefined) {
      throw new Error(`no "${text}" button; got ${all.map((b) => b.text).join(", ")}`);
    }
    return found;
  };
}

describe("DeviceSetupModal", () => {
  it("offers both exports, with the scannable one as the default", () => {
    const { button } = open();
    expect(button("Show QR").cta).toBe(true);
    expect(button("Copy setup link").cta).toBe(false);
  });

  it("copies a link the paste side can actually parse", async () => {
    const written = withClipboard(async () => {});
    const { button } = open();

    await button("Copy setup link").click();

    expect(written).toHaveLength(1);
    // The real acceptance test: the exact parser PasteSetupModal calls.
    const payload = parseSetupText(written[0]);
    expect(payload).toEqual({
      v: 2,
      url: "https://vault.example.workers.dev",
      name: "phone",
      token: "access-token",
      mode: "encrypted",
      key: KEY,
      vaultSalt: SALT,
    });
  });

  it("carries the plaintext vault's mode instead of a key it does not have", async () => {
    const written = withClipboard(async () => {});
    const { button } = open({ encryptionMode: "plaintext", masterKey: "", vaultSalt: "" });

    await button("Copy setup link").click();

    const payload = parseSetupText(written[0]);
    expect(payload.mode).toBe("plaintext");
    expect(payload).not.toHaveProperty("key");
  });

  it("names the new device from the field rather than this one", async () => {
    const written = withClipboard(async () => {});
    const { content, button } = open();
    content.log.rows[0].texts[0].change("laptop");

    await button("Copy setup link").click();

    expect(parseSetupText(written[0]).name).toBe("laptop");
  });

  it("says what the link carries before it is anywhere near a clipboard", async () => {
    withClipboard(async () => {});
    const { content, button } = open();

    await button("Copy setup link").click();

    const warning = content.texts().find((t) => t.includes("Anyone who"));
    expect(warning).toContain("master key");
    expect(warning).toContain("full access");
  });

  it("leaves the link selectable when the platform refuses the clipboard", async () => {
    // A denied clipboard must not be a dead end: this link is the only route to a device
    // that cannot scan the code, so there has to be something left to select by hand.
    withClipboard(async () => {
      throw new Error("denied");
    });
    const { content, button } = open();

    await button("Copy setup link").click();

    const field = content.children.flatMap((c) => [c, ...c.children]).find((c) => c.tag === "textarea");
    expect(field?.value).toMatch(/^obsidian:\/\/r2do-sync-setup\?d=/);
    expect(field?.readOnly).toBe(true);
    expect(field?.selected).toBe(true);
    expect(Notice.shown.join(" ")).toContain("Select and copy it manually");
  });

  it.each([
    ["no server URL", { serverUrl: "" }, "Set the server URL"],
    ["no access token", { accessToken: "" }, "No token to share"],
  ])("refuses to export with %s, and says why", async (_label, over, said) => {
    const written = withClipboard(async () => {});
    const { button } = open(over);

    await button("Copy setup link").click();

    expect(written).toEqual([]);
    expect(Notice.shown.join(" ")).toContain(said);
  });

  // Sending the key to a second device is not a backup — both can be lost together. Without
  // this the acknowledgement is laundered by transit: the source exports a key it never
  // saved, and applySetup records it as backed up on the recipient.
  it("refuses to share a key whose backup gate is unfinished", async () => {
    const written = withClipboard(async () => {});
    const { button } = open({ masterKeyBackedUp: false });

    await button("Copy setup link").click();

    expect(written).toEqual([]);
    expect(Notice.shown.join(" ")).toContain("not a backup");
  });

  it("still shares a plaintext vault, which has no key to back up", async () => {
    const written = withClipboard(async () => {});
    const { button } = open({
      encryptionMode: "plaintext",
      masterKey: "",
      vaultSalt: "",
      masterKeyBackedUp: false,
    });

    await button("Copy setup link").click();

    expect(written).toHaveLength(1);
  });

  // Export used to check only that two strings were non-empty, so a link the parser rejects
  // could be copied with a success notice — and the failure surfaced on the *other* device.
  it.each([
    ["an unset vault salt", { vaultSalt: "" }],
    ["a malformed master key", { masterKey: "not-a-key" }],
    ["a server URL that is not one", { serverUrl: "definitely not a url" }],
  ])("refuses to export with %s rather than promising a usable link", async (_label, over) => {
    const written = withClipboard(async () => {});
    const { button } = open(over);

    await button("Copy setup link").click();

    expect(written).toEqual([]);
    expect(Notice.shown.join(" ")).toContain("cannot produce a usable setup link");
  });

  it("bails before drawing anything when the QR payload would be rejected", () => {
    // The QR path shares the same guard. It must refuse before `renderQr`, which is also
    // why this asserts on an empty output area rather than on an absent code: a drawn
    // warning would mean the check ran too late.
    const { content, button } = open({ vaultSalt: "" });
    button("Show QR").click();
    expect(content.texts().some((t) => t.includes("Anyone who"))).toBe(false);
    expect(Notice.shown.join(" ")).toContain("cannot produce a usable setup link");
  });

  // An export left on screen after the fields changed describes a payload the page no longer
  // shows — and a QR is scanned by pointing a camera at it, long after any of this.
  it("discards a rendered export when the device name changes", async () => {
    withClipboard(async () => {});
    const { content, button } = open();
    await button("Copy setup link").click();
    expect(content.texts().some((t) => t.includes("Anyone who"))).toBe(true);

    content.log.rows[0].texts[0].change("laptop");

    expect(content.texts().some((t) => t.includes("Anyone who"))).toBe(false);
  });

  it("discards a rendered export when the token changes", async () => {
    withClipboard(async () => {});
    const { content, button } = open();
    await button("Copy setup link").click();

    content.log.rows[1].texts[0].change("other-token");

    expect(content.texts().some((t) => t.includes("Anyone who"))).toBe(false);
  });

  it("drops the token from memory when the window closes", async () => {
    const written = withClipboard(async () => {});
    const { modal, button } = open();
    modal.onClose();

    await button("Copy setup link").click();

    expect(written).toEqual([]);
    expect(Notice.shown.join(" ")).toContain("No token to share");
  });
});

const PAYLOAD: SetupPayload = {
  v: 2,
  url: "https://vault.example.workers.dev",
  name: "laptop",
  token: "access-token",
  mode: "encrypted",
  key: KEY,
  vaultSalt: SALT,
};

describe("PasteSetupModal", () => {
  function open(clipboard?: () => Promise<string>) {
    if (clipboard !== undefined) {
      vi.stubGlobal("navigator", { clipboard: { readText: clipboard } });
    }
    const modal = new PasteSetupModal(new App() as never, fakePlugin() as never);
    modal.open();
    const content = modal.contentEl as unknown as FakeElement;
    return { modal, content, button: buttonsOf(content), field: content.log.rows[0].texts[0] };
  }

  it("says why a link is unusable in place, and marks it as an error", () => {
    const { content, button, field } = open();
    field.change("obsidian://r2do-sync-setup?d=nonsense");

    button("Continue").click();

    // Styled as an error: a page that reads the same whether or not it just refused something
    // has not told the user anything.
    const said = content.byClass("r2do-error")[0];
    expect(said?.text).toContain("Cannot use that link");
    expect(Modal.shown).toHaveLength(1); // still here — nothing was dismissed
  });

  it("takes the link straight off the clipboard, which is how it got to this device", async () => {
    const { button } = open(async () => encodeSetupUri(PAYLOAD));

    await button("Paste from clipboard").click();

    const applied = Modal.shown.at(-1);
    expect(applied).toBeInstanceOf(ApplySetupModal);
    expect((applied!.contentEl as unknown as FakeElement).texts().join(" ")).toContain(PAYLOAD.url);
  });

  it("keeps the field usable when the platform refuses the clipboard", async () => {
    const { content, button } = open(async () => {
      throw new Error("denied");
    });

    await button("Paste from clipboard").click();

    expect(content.byClass("r2do-error")[0]?.text).toContain("Paste into the field instead");
    expect(Modal.shown).toHaveLength(1);
  });

  it("shows what it read when the clipboard held something else", async () => {
    const { content, button, field } = open(async () => "a shopping list");

    await button("Paste from clipboard").click();

    expect(field.getValue()).toBe("a shopping list");
    expect(content.byClass("r2do-error")[0]?.text).toContain("Cannot use that link");
  });
});

describe("ApplySetupModal", () => {
  function open(over: Partial<Settings> = {}) {
    const modal = new ApplySetupModal(
      new App() as never,
      fakePlugin(over) as never,
      PAYLOAD
    );
    modal.open();
    return { modal, content: modal.contentEl as unknown as FakeElement };
  }

  // Repointing a working device at a different vault is the one case where this dialog is
  // consequential, and the flat sentence read identically on a device that had no server yet.
  it("names both ends when the link points at a different server", () => {
    const { content } = open({ serverUrl: "https://old.example.workers.dev" });
    const said = content.log.paragraphs.join(" ");
    expect(said).toContain("currently syncs with https://old.example.workers.dev");
    expect(said).toContain(PAYLOAD.url);
    expect(said).toContain("different vault");
  });

  it("says nothing about moving when the link is for the same server", () => {
    const { content } = open({ serverUrl: `${PAYLOAD.url}/` });
    const said = content.log.paragraphs.join(" ");
    expect(said).toContain("replaces the current server, token and key");
    expect(said).not.toContain("different vault");
  });

  it("treats a device with no server as a fresh one, not a move", () => {
    const { content } = open({ serverUrl: "" });
    expect(content.log.paragraphs.join(" ")).not.toContain("different vault");
  });
});
