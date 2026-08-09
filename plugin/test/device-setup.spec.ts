import { afterEach, describe, expect, it, vi } from "vitest";
import { generateMasterKey, generateVaultSalt } from "../src/crypto";
import { DEFAULT_SETTINGS, DeviceSetupModal, type Settings } from "../src/main";
import { parseSetupText } from "../src/setup-link";
import { App, type FakeElement, Notice } from "./obsidian-fake";

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
});

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

  it("drops the token from memory when the window closes", async () => {
    const written = withClipboard(async () => {});
    const { modal, button } = open();
    modal.onClose();

    await button("Copy setup link").click();

    expect(written).toEqual([]);
    expect(Notice.shown.join(" ")).toContain("No token to share");
  });
});
