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

/**
 * Enough DOM for `renderQr`, which builds the code as inline SVG rather than as markup.
 * Without it the QR export cannot be rendered in node at all, and the primary button on this
 * window would have no test that it draws anything.
 */
function withSvgDocument(): void {
  vi.stubGlobal("document", {
    createElementNS: (_ns: string, tagName: string) => ({
      tagName,
      setAttribute() {},
      appendChild() {},
    }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  Notice.shown.length = 0;
  Modal.shown.length = 0;
});

/**
 * Stubs `navigator.clipboard` with methods that RECORD instead of throwing, and returns the
 * log. Throwing would be the weaker guard: every clipboard call this code ever made sat in a
 * try/catch, so a throw would be swallowed and the test would pass with the permission back.
 */
function touchRecorder(): string[] {
  const touched: string[] = [];
  vi.stubGlobal("navigator", {
    clipboard: {
      readText: () => {
        touched.push("readText");
        return Promise.resolve("");
      },
      writeText: () => {
        touched.push("writeText");
        return Promise.resolve();
      },
    },
  });
  return touched;
}

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
    expect(button("Show setup link").cta).toBe(false);
  });

  it("shows a link the paste side can actually parse", async () => {
    const { content, button } = open();

    await button("Show setup link").click();

    // The real acceptance test: the exact parser PasteSetupModal calls, over what is on
    // screen — which is the only place the link ever exists now.
    const payload = parseSetupText(linkField(content)!.value);
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
    const { content, button } = open({ encryptionMode: "plaintext", masterKey: "", vaultSalt: "" });

    await button("Show setup link").click();

    const payload = parseSetupText(linkField(content)!.value);
    expect(payload.mode).toBe("plaintext");
    expect(payload).not.toHaveProperty("key");
  });

  it("names the new device from the field rather than this one", async () => {
    const { content, button } = open();
    content.log.rows[0].texts[0].change("laptop");

    await button("Show setup link").click();

    expect(parseSetupText(linkField(content)!.value).name).toBe("laptop");
  });

  it("says what the link carries before the user copies it anywhere", async () => {
    const { content, button } = open();

    await button("Show setup link").click();

    const warning = content.texts().find((t) => t.includes("Anyone who"));
    expect(warning).toContain("master key");
    expect(warning).toContain("full access");
  });

  /** The setup link as it appears on screen, wherever in the window it was drawn. */
  function linkField(content: FakeElement) {
    return content.children.flatMap((c) => [c, ...c.children]).find((c) => c.tag === "textarea");
  }

  it("hands the whole link over on focus, so it can be copied without dragging", async () => {
    // The field is the only export route — nothing here touches the clipboard — and the link
    // is ~400 unbroken characters, which is not a realistic hand-selection on a phone.
    const { content, button } = open();

    await button("Show setup link").click();

    const field = linkField(content);
    expect(field?.value).toMatch(/^obsidian:\/\/r2do-sync-setup\?d=/);
    expect(field?.readOnly).toBe(true);
    expect(field?.selected).toBe(false);
    field!.focus();
    expect(field?.selected).toBe(true);
  });

  it("asks for no clipboard permission on the way", async () => {
    // Regression guard for the whole point of this. It RECORDS calls rather than throwing on
    // contact: the code this replaced wrapped its clipboard write in try/catch, so a stub that
    // threw would be swallowed and this test would pass while the permission was quietly back.
    const touched = touchRecorder();
    const { content, button } = open();

    await button("Show setup link").click();

    expect(touched).toEqual([]);
    expect(linkField(content)?.value).toMatch(/^obsidian:\/\/r2do-sync-setup\?d=/);
  });

  it("shows the link itself, rather than a promise that it went somewhere", async () => {
    const { content, button } = open();

    await button("Show setup link").click();

    expect(linkField(content)?.value).toMatch(/^obsidian:\/\/r2do-sync-setup\?d=/);
    expect(linkField(content)?.readOnly).toBe(true);
  });

  // The link is ~400 unbroken base64 characters. In a default textarea that is a narrow box
  // showing a dozen of them, so the first cut of this shipped as an unlabelled mystery field
  // that appeared to be empty — the opposite of "you can see the link now".
  it("renders the link legibly and says what it is", async () => {
    const { content, button } = open();

    await button("Show setup link").click();

    const field = linkField(content);
    expect(field?.cls).toBe("r2do-secret");
    // Labelled, and labelled BEFORE the box: an unexplained field full of base64 reads as a
    // glitch, and this one holds the vault's master key.
    const row = content.log.settings.find((r) => r.name === "Setup link");
    expect(row?.desc).toContain("device with no camera");
    // A label and an explanation, and no controls at all: the field below it is the whole
    // mechanism now, so a button here could only be one that touches the clipboard.
    expect(row?.controls).toEqual([]);
    expect(row?.desc).toContain("Copy it");
  });

  // A QR is useless to a second computer, and a phone scanner that opens obsidian:// in a
  // browser drops it — so the code without the link beside it leaves both of them stuck.
  it("shows the link beside the QR code as well", () => {
    withSvgDocument();
    const { content, button } = open();

    button("Show QR").click();

    // The code itself is drawn, not merely promised.
    expect(content.children.flatMap((c) => c.children).some((c) => c.tag === "svg")).toBe(true);

    const shown = linkField(content)?.value;
    expect(shown).toMatch(/^obsidian:\/\/r2do-sync-setup\?d=/);
    // The same payload both exports carry, proved through the parser the paste side uses.
    expect(parseSetupText(shown!).mode).toBe("encrypted");
  });

  it("offers no copy button beside the QR, only the field", async () => {
    withSvgDocument();
    const { content, button } = open();
    button("Show QR").click();

    expect(content.log.rows.flatMap((r) => r.buttons).map((b) => b.text)).not.toContain(
      "Copy link"
    );
    expect(parseSetupText(linkField(content)!.value).token).toBe("access-token");
  });

  it.each([
    ["no server URL", { serverUrl: "" }, "Set the server URL"],
    ["no access token", { accessToken: "" }, "No token to share"],
  ])("refuses to export with %s, and says why", async (_label, over, said) => {
    const { content, button } = open(over);

    await button("Show setup link").click();

    expect(linkField(content)).toBeUndefined();
    expect(Notice.shown.join(" ")).toContain(said);
  });

  // Sending the key to a second device is not a backup — both can be lost together. Without
  // this the acknowledgement is laundered by transit: the source exports a key it never
  // saved, and applySetup records it as backed up on the recipient.
  it("refuses to share a key whose backup gate is unfinished", async () => {
    const { content, button } = open({ masterKeyBackedUp: false });

    await button("Show setup link").click();

    expect(linkField(content)).toBeUndefined();
    expect(Notice.shown.join(" ")).toContain("not a backup");
  });

  it("still shares a plaintext vault, which has no key to back up", async () => {
    const { content, button } = open({
      encryptionMode: "plaintext",
      masterKey: "",
      vaultSalt: "",
      masterKeyBackedUp: false,
    });

    await button("Show setup link").click();

    expect(linkField(content)?.value).toMatch(/^obsidian:\/\/r2do-sync-setup\?d=/);
  });

  // Export used to check only that two strings were non-empty, so a link the parser rejects
  // could be shown as if it were usable — and the failure surfaced on the *other* device.
  it.each([
    ["an unset vault salt", { vaultSalt: "" }],
    ["a malformed master key", { masterKey: "not-a-key" }],
    ["a server URL that is not one", { serverUrl: "definitely not a url" }],
  ])("refuses to export with %s rather than promising a usable link", async (_label, over) => {
    const { content, button } = open(over);

    await button("Show setup link").click();

    expect(linkField(content)).toBeUndefined();
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
    const { content, button } = open();
    await button("Show setup link").click();
    expect(content.texts().some((t) => t.includes("Anyone who"))).toBe(true);

    content.log.rows[0].texts[0].change("laptop");

    expect(content.texts().some((t) => t.includes("Anyone who"))).toBe(false);
  });

  it("discards a rendered export when the token changes", async () => {
    const { content, button } = open();
    await button("Show setup link").click();

    content.log.rows[1].texts[0].change("other-token");

    expect(content.texts().some((t) => t.includes("Anyone who"))).toBe(false);
  });

  it("drops the token from memory when the window closes", async () => {
    const { modal, content, button } = open();
    modal.onClose();

    await button("Show setup link").click();

    expect(linkField(content)).toBeUndefined();
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
  function open() {
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

  it("applies a link the user pasted into the field themselves", () => {
    const { button, field } = open();
    field.change(encodeSetupUri(PAYLOAD));

    button("Continue").click();

    const applied = Modal.shown.at(-1);
    expect(applied).toBeInstanceOf(ApplySetupModal);
    expect((applied!.contentEl as unknown as FakeElement).texts().join(" ")).toContain(PAYLOAD.url);
  });

  it("offers no clipboard button and never reads the clipboard", () => {
    // Records rather than throws, for the same reason as the export side: a swallowed throw
    // would let a reintroduced clipboard read pass as clean.
    const touched = touchRecorder();
    const { content, button, field } = open();

    expect(content.log.rows.flatMap((r) => r.buttons).map((b) => b.text)).not.toContain(
      "Paste from clipboard"
    );
    field.change(encodeSetupUri(PAYLOAD));
    button("Continue").click();

    expect(touched).toEqual([]);
    expect(Modal.shown.at(-1)).toBeInstanceOf(ApplySetupModal);
  });

  it("says so in place when the field holds something that is not a link", () => {
    const { content, field, button } = open();
    field.change("a shopping list");

    button("Continue").click();

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
