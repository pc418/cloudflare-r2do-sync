// A second device joining an existing vault, against a real Worker.
//
// This is the flow the empty-vault downgrade exists for: install the plugin, scan the code or
// paste the link, confirm once, and receive the vault. The thing being proved is a negative —
// that the new device publishes NOTHING on the way in, not even the blank note the app made —
// so every assertion here is against the server's own head and manifest, not a notice.
import { afterEach, describe, expect, it } from "vitest";
import type { Modal } from "../obsidian-fake";
import { LiveHarness, liveConfig } from "./harness";

const config = liveConfig("onboarding");

/** Distinct per run: the sandbox's remote survives between runs, and republished bytes are correctly reported unchanged. */
const RUN = Math.floor(Date.now() / 1000).toString(36);

async function head(): Promise<string | null> {
  const res = await fetch(`${config!.url}/api/head`, {
    headers: { authorization: `Bearer ${config!.token}` },
  });
  if (!res.ok) throw new Error(`GET /api/head → ${res.status}`);
  return ((await res.json()) as { head: string | null }).head;
}

async function remotePaths(id: string): Promise<string[]> {
  const res = await fetch(`${config!.url}/api/manifests/${id}`, {
    headers: { authorization: `Bearer ${config!.token}` },
  });
  if (!res.ok) throw new Error(`GET /api/manifests/${id} → ${res.status}`);
  const manifest = (await res.json()) as { files?: Record<string, unknown> };
  if (manifest.files === undefined) throw new Error("expected a plaintext manifest");
  return Object.keys(manifest.files);
}

/**
 * Starts a pass and hands back both the window it raises and the pass itself.
 *
 * The pass has to be awaited rather than watched for side effects: a two-way pass pulls and
 * only then commits, so waiting for a pulled file to appear and reading the head at that
 * moment races its own push. Collected through an array because the pass begins inside a
 * callback, where a `let` would still be narrowed to its initial value afterwards.
 */
async function gateFor(h: LiveHarness): Promise<{ gate: Modal; pass: Promise<void> }> {
  const pending: Promise<void>[] = [];
  const gate = await h.opens(() => {
    pending.push(h.plugin.syncNow());
  });
  return { gate, pass: pending[0] };
}

describe.skipIf(config === null)("joining a vault from a new device", () => {
  const started: LiveHarness[] = [];
  afterEach(async () => {
    for (const h of started.splice(0)) await h.dispose();
  });

  /** Puts a note in the vault from an established device, and returns the head it published. */
  async function existingVault(note: string): Promise<string> {
    const device = await LiveHarness.start({ ...config!, root: `${config!.root}-existing` });
    started.push(device);
    await device.write(`notes/${note}`, `everyone's note ${RUN}\n`);
    await device.plugin.syncNow();
    const published = await head();
    if (published === null) throw new Error("the established device published nothing to join");
    return published;
  }

  /**
   * A device that has never synced, so the one-time gate is still owed an answer — which is
   * the state a freshly installed plugin is in after a setup link is applied.
   */
  async function freshDevice(files: Record<string, string>): Promise<LiveHarness> {
    const device = await LiveHarness.start({ ...config!, root: `${config!.root}-fresh` }, {
      files,
      persisted: { settings: { firstSyncAcknowledged: false } },
    });
    started.push(device);
    return device;
  }

  it("offers an empty device a download, and publishes nothing when it accepts", async () => {
    const before = await existingVault(`shared-${RUN}.md`);
    const fresh = await freshDevice({});

    const { gate, pass } = await gateFor(fresh);
    // The question a device with nothing of its own is asked. The general gate warns about
    // reconciling two real vaults and tells the user their files will be published — true in
    // general, and the opposite of what is about to happen here.
    expect(gate.contentEl.log.headings.join(" ")).toMatch(/download/i);
    expect(gate.contentEl.log.paragraphs.join(" ")).toMatch(/nothing on this device is published/i);

    await fresh.modalButton("Download the vault").click();
    await pass;

    expect(await fresh.read(`notes/shared-${RUN}.md`)).toBe(`everyone's note ${RUN}\n`);
    // The whole point: joining moved nothing on the server.
    expect(await head()).toBe(before);
  });

  it("keeps a blank starter note on disk and off the remote", async () => {
    const before = await existingVault(`shared-blank-${RUN}.md`);
    // What Obsidian leaves behind when it opens a brand-new vault.
    const fresh = await freshDevice({ "Untitled.md": "\n" });

    const { pass } = await gateFor(fresh);
    await fresh.modalButton("Download the vault").click();
    await pass;

    // Still here — nothing this device owns is deleted to make it look tidy...
    expect(await fresh.read("Untitled.md")).toBe("\n");
    // ...and it did not follow the user into somebody else's vault.
    expect(await head()).toBe(before);
    expect(await remotePaths(before)).not.toContain("Untitled.md");
  });

  it("asks a device that has real notes to weigh the merge instead", async () => {
    await existingVault(`shared-merge-${RUN}.md`);
    const fresh = await freshDevice({ "mine.md": `work I did offline ${RUN}\n` });

    // The pass itself is the thing to await: it pulls and then commits, so waiting for the
    // pulled file to appear and reading the head at that moment races its own push.
    const { gate, pass } = await gateFor(fresh);

    // A device with its own work is reconciling two real vaults, and is told so.
    expect(gate.contentEl.log.headings.join(" ")).toMatch(/back up/i);
    expect(gate.contentEl.log.paragraphs.join(" ")).toMatch(/everything here is published/i);

    await fresh.modalButton("I have a backup — sync").click();
    await pass;

    // Both directions, because this device genuinely had something to contribute.
    const after = await head();
    expect(await remotePaths(after!)).toContain("mine.md");
    expect(await fresh.read(`notes/shared-merge-${RUN}.md`)).toBe(`everyone's note ${RUN}\n`);
  });

  it("does not downgrade a device the user set to push-only", async () => {
    await existingVault(`shared-push-${RUN}.md`);
    const fresh = await LiveHarness.start({ ...config!, root: `${config!.root}-push` }, {
      files: { [`backup-${RUN}.md`]: `from the backup device ${RUN}\n` },
      persisted: { settings: { firstSyncAcknowledged: false, syncMode: "push-only" } },
    });
    started.push(fresh);

    const { gate, pass } = await gateFor(fresh);
    // push-only is a deliberate choice — a device that backs up and never receives. Offering
    // it a download would reverse the direction its owner set.
    expect(gate.contentEl.log.headings.join(" ")).toMatch(/back up/i);

    await fresh.modalButton("I have a backup — sync").click();
    await pass;

    // It published, and it did not receive.
    expect(await remotePaths((await head())!)).toContain(`backup-${RUN}.md`);
    expect(await fresh.files()).not.toContain(`notes/shared-push-${RUN}.md`);
  });
});
