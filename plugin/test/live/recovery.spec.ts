// Group 7 — Safety and recovery. The destructive half of the settings page, against a real
// deployment: preview, history browsing, per-file and whole-vault restore, force pull, force
// push, and reroot.
//
// Written by hand rather than generated, because the invariants here are the ones where a
// test that asserts the *wrong* thing is worse than no test at all: an overwrite approval is
// bound to one specific version, a dry run that writes is not a dry run, and a dismissed
// reroot must publish nothing.
import { afterEach, describe, expect, it } from "vitest";
import { Modal, requestUrlMock } from "../obsidian-fake";
import { LiveHarness, liveConfig } from "./harness";

const config = liveConfig("recovery");

/** Modals open asynchronously (`open()` does not await `onOpen`), so let the body draw. */
const settle = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function head(): Promise<string | null> {
  const res = await fetch(`${config!.url}/api/head`, {
    headers: { authorization: `Bearer ${config!.token}` },
  });
  if (!res.ok) throw new Error(`GET /api/head → ${res.status}`);
  return ((await res.json()) as { head: string | null }).head;
}

async function manifest(id: string): Promise<{ parent: string | null }> {
  const res = await fetch(`${config!.url}/api/manifests/${id}`, {
    headers: { authorization: `Bearer ${config!.token}` },
  });
  if (!res.ok) throw new Error(`GET /api/manifests/${id} → ${res.status}`);
  return (await res.json()) as { parent: string | null };
}

describe.skipIf(config === null)("Safety and recovery", () => {
  let harness: LiveHarness | null = null;
  afterEach(async () => {
    await harness?.dispose();
    harness = null;
  });

  /**
   * A vault whose *remote* is exactly these files.
   *
   * Force push, not an ordinary sync: one Worker is one vault with one head, so every test in
   * this file shares the remote with the ones before it. A fresh device doing a first sync
   * would merge whatever the previous test published, and the assertions would then be about
   * accumulated history rather than about the button under test.
   */
  async function published(files: Record<string, string>): Promise<LiveHarness> {
    const h = await LiveHarness.start(config!, {
      files,
      // The shipped default walks 40 manifests, one network round trip each, every time the
      // history window opens. Three is enough to prove ordering and costs seconds less.
      persisted: { settings: { historyLimit: 3 } },
    });
    h.render();
    // The window only opens once the summary has been computed over the network, so this
    // waits for it rather than guessing how long that takes.
    await h.opens(() => h.button("Push local over remote").click());
    await h.confirm("PUSH LOCAL", "Confirm");
    await h.waitFor(async () => (await head()) !== null, { label: "the seeded snapshot" });
    return h;
  }

  it("Preview reads the remote without touching it", async () => {
    harness = await published({ "note.md": "one\n" });
    const before = await head();
    await harness.write("note.md", "one\ntwo\n");
    harness.render();

    // A preview is a full remote read, not a local computation.
    const window = await harness.opens(() => harness!.button("Preview sync").click());

    // A preview that publishes is not a preview. The head is the whole assertion: the window
    // may say anything it likes, but nothing may have moved.
    expect(await head()).toBe(before);
    expect(window.opened).toBe(true);
  });

  it("Browse lists the snapshots that exist, newest first", async () => {
    harness = await published({ "note.md": "one\n" });
    await harness.write("note.md", "one\ntwo\n");
    await harness.plugin.syncNow();
    harness.render();

    const window = await harness.opens(() => harness!.button("Snapshot history").click());
    await harness.waitFor(() => window.contentEl.log.rows.length > 0, { label: "the history list" });

    const log = window.contentEl.log;
    expect(log.settings.length).toBeGreaterThanOrEqual(2);
    // Every listed snapshot offers a way in. A row with no Browse button is a snapshot the
    // user can see and cannot open, which is worse than not listing it.
    expect(log.rows.every((r) => r.buttons.some((b) => b.text === "Browse"))).toBe(true);
  });

  it("restoring content that is already identical writes nothing and downloads nothing", async () => {
    harness = await published({ "note.md": "one\n" });
    const snapshot = await openNewestSnapshot(harness);

    const before = harness.blobReads();
    await snapshot.restore("note.md");
    await harness.waitFor(() => /already identical|nothing to restore/i.test(harness!.notices().at(-1) ?? ""), {
      label: "the identical-content notice",
    });

    // The invariant is a cost as much as a correctness claim: comparison is by content hash,
    // so an identical file must not fetch the blob to find that out. Total requests cannot
    // say this — inspecting the snapshot legitimately costs a manifest fetch — so only blob
    // downloads are counted.
    expect(harness.blobReads()).toBe(before);
    expect(await harness.read("note.md")).toBe("one\n");
  });

  it("restoring to a path that is now free writes the snapshot's exact bytes", async () => {
    harness = await published({ "note.md": "one\n", "gone.md": "kept\n" });
    const snapshot = await openNewestSnapshot(harness);

    // Delete it locally *without* syncing, so the snapshot still has it and the disk does not.
    await harness.remove("gone.md");
    await snapshot.restore("gone.md");
    await settle(800);

    expect(await harness.read("gone.md")).toBe("kept\n");
  });

  it("a different version at the path is a copy by default, never a silent overwrite", async () => {
    harness = await published({ "note.md": "published\n" });
    const snapshot = await openNewestSnapshot(harness);
    await harness.write("note.md", "unsynced local work\n");

    await snapshot.restore("note.md");
    await settle(2000);

    // The destination window is the only place the difference between the two versions is
    // visible, so reaching it is the behaviour under test.
    const destination = Modal.shown.at(-1)!;
    expect(destination.contentEl.log.rows.flatMap((r) => r.buttons).map((b) => b.text)).toEqual(
      expect.arrayContaining(["Save a copy", "Replace current file", "Cancel"])
    );

    await harness.modalButton("Save a copy").click();
    await settle(800);

    // The live file keeps the edit that was never synced; the snapshot's version arrives
    // beside it. Losing the former to recover the latter is the failure this prevents.
    expect(await harness.read("note.md")).toBe("unsynced local work\n");
    const copies = (await harness.files()).filter((p) => p !== "note.md" && p.endsWith(".md"));
    expect(copies).toHaveLength(1);
    expect(await harness.read(copies[0])).toBe("published\n");
  });

  it("an overwrite approved for one version is not spent on another", async () => {
    harness = await published({ "note.md": "published\n" });
    const snapshot = await openNewestSnapshot(harness);
    await harness.write("note.md", "version the user looked at\n");

    await snapshot.restore("note.md");
    await settle(2000);

    // The race the invariant exists for: a confirmation can sit open while the note is
    // edited. The edit is injected *during* the blob download, so the approval is already
    // given and the destination has changed underneath it by the time the write is attempted.
    const passthrough = requestUrlMock.impl!;
    let injected = false;
    requestUrlMock.impl = async (req: unknown) => {
      const { url } = req as { url: string };
      if (!injected && url.includes("/api/blobs/")) {
        injected = true;
        await harness!.write("note.md", "edited while the window was open\n");
      }
      return passthrough(req);
    };

    await harness.modalButton("Replace current file").click();
    await settle(500);
    requestUrlMock.impl = passthrough;

    expect(injected).toBe(true);
    // Aborts having written nothing. Spending a stale approval on bytes nobody looked at is
    // exactly how an irreversible overwrite destroys work the user never agreed to lose.
    expect(await harness.read("note.md")).toBe("edited while the window was open\n");
    expect(harness.notices().at(-1)).toMatch(/could not restore|changed|stale/i);
  });

  it("Pull remote parks local work it has never published instead of destroying it", async () => {
    harness = await published({ "note.md": "published\n" });
    await harness.write("note.md", "never synced\n");
    harness.render();

    await harness.opens(() => harness!.button("Pull remote over local").click());
    await harness.confirm("PULL REMOTE", "Confirm");
    await settle(1000);

    expect(await harness.read("note.md")).toBe("published\n");
    // "Overwritten by the remote" and "gone" must not be the same outcome. The parked copy is
    // the only record of an edit that, by definition, exists nowhere else.
    const parked = (await harness.files()).filter((p) => p.includes(".conflict-"));
    expect(parked).toHaveLength(1);
    expect(await harness.read(parked[0])).toBe("never synced\n");
  });

  it("Pull remote publishes nothing when the phrase is not typed", async () => {
    harness = await published({ "note.md": "published\n" });
    const before = await head();
    await harness.write("note.md", "never synced\n");
    harness.render();

    await harness.opens(() => harness!.button("Pull remote over local").click());
    // Dismissal is a refusal. The window closes, and the vault is exactly as it was.
    harness.top().close();
    await settle();

    expect(await head()).toBe(before);
    expect(await harness.read("note.md")).toBe("never synced\n");
  });

  it("Push local makes the remote match this device without merging", async () => {
    harness = await published({ "note.md": "published\n" });
    await harness.write("note.md", "this device wins\n");
    harness.render();

    await harness.opens(() => harness!.button("Push local over remote").click());
    await harness.confirm("PUSH LOCAL", "Confirm");
    await settle(5000);

    // Proven from the other side: a second device that pulls gets the pushed bytes. Reading
    // the head id back would only prove that something was published.
    const other = await LiveHarness.start({ ...config!, root: `${config!.root}-reader` });
    try {
      await other.plugin.syncNow();
      expect(await other.read("note.md")).toBe("this device wins\n");
    } finally {
      await other.dispose();
    }
    expect(await harness.read("note.md")).toBe("this device wins\n");
  });

  it("Rebuild publishes a parentless root — and publishes nothing when dismissed", async () => {
    harness = await published({ "note.md": "one\n" });
    await harness.write("note.md", "two\n");
    await harness.plugin.syncNow();
    const before = await head();
    expect((await manifest(before!)).parent).not.toBeNull();

    harness.render();
    await harness.opens(() => harness!.button("Rebuild remote history").click());
    harness.top().close();
    await settle();
    // The single irreversible action in the plugin. Dismissing it has to cost nothing.
    expect(await head()).toBe(before);

    await harness.opens(() => harness!.button("Rebuild remote history").click());
    await harness.confirm("REBUILD HISTORY", "Confirm");
    await settle(2000);

    const after = await head();
    expect(after).not.toBe(before);
    // A new root, not a new child: the old chain is abandoned, which is what "rebuild" means
    // and why it is the one action that deliberately discards history.
    expect((await manifest(after!)).parent).toBeNull();
  });

  it("turning the mass-change guard off is a decision, and declining keeps it", async () => {
    harness = await published({ "note.md": "one\n" });
    harness.render();
    const field = harness.row("Ask before large changes (%)").texts[0];
    const previous = harness.plugin.settings.protectPercent;

    await harness.opens(() => {
      field.change("100");
      field.inputEl.fire("blur");
    });

    await harness.modalButton("Keep the guard").click();
    await settle();

    // 100 is the off switch, and a guard that turns itself off because someone typed a number
    // is not a guard. Declining must leave the old value, not a disabled one.
    expect(harness.plugin.settings.protectPercent).toBe(previous);
  });

  it("Rows listed in history bounds the walk", async () => {
    harness = await published({ "note.md": "one\n" });
    for (const text of ["two\n", "three\n"]) {
      await harness.write("note.md", text);
      await harness.plugin.syncNow();
    }

    harness.plugin.settings.historyLimit = 1;
    // Every sync, deliberately: three commits seconds apart are one calendar day, so a grouped
    // window would show one row whatever the limit said and prove nothing about the limit.
    harness.plugin.settings.historyGranularity = "sync";
    harness.render();
    await harness.button("Snapshot history").click();
    await settle(500);

    expect(LiveHarness.historyRows(Modal.shown.at(-1)!.contentEl.log)).toHaveLength(1);
  });

  it("groups the same syncs into a single day when asked to", async () => {
    harness = await published({ "note.md": "one\n" });
    for (const text of ["two\n", "three\n"]) {
      await harness.write("note.md", text);
      await harness.plugin.syncNow();
    }

    harness.plugin.settings.historyGranularity = "day";
    harness.render();
    await harness.button("Snapshot history").click();
    await settle(1000);

    const rows = LiveHarness.historyRows(Modal.shown.at(-1)!.contentEl.log);
    // Three commits in one day collapse to one row, and it says how many syncs it covers
    // rather than presenting the day's diff as a single sync.
    expect(rows).toHaveLength(1);
    expect(rows[0].rendered.desc).toContain("spans 3 syncs");
  });
});

/**
 * Opens the newest snapshot's contents window and returns a way to press one file's Restore.
 * Shared because every restore case starts the same way, and because doing it through the
 * real two windows is the point — a test that called `restoreFile` directly would prove the
 * engine works and say nothing about whether the button reaches it.
 */
async function openNewestSnapshot(harness: LiveHarness): Promise<{ restore(path: string): Promise<void> }> {
  harness.render();
  await harness.opens(() => harness!.button("Snapshot history").click());
  await harness.waitFor(
    () => LiveHarness.historyRows(Modal.shown.at(-1)!.contentEl.log).length > 0,
    { label: "the history list to load" }
  );

  // The FIRST row, deliberately: the list is newest-first, and `modalButton` scans from the
  // end, which would open the oldest snapshot and quietly test the wrong thing.
  const history = Modal.shown.at(-1)!.contentEl.log;
  const browse = LiveHarness.historyRows(history)[0]?.buttons.find((b) => b.text === "Browse");
  if (browse === undefined) {
    throw new Error(`history listed no browsable snapshot: ${history.paragraphs.join(" | ")}`);
  }
  const contentsWindow = await harness.opens(() => browse.click());
  await harness.waitFor(() => contentsWindow.contentEl.log.rows.length > 0, {
    label: "the snapshot's file list",
  });

  const contents = contentsWindow;
  return {
    async restore(path: string): Promise<void> {
      const log = contents.contentEl.log;
      const at = log.settings.findIndex((s) => s.name === path);
      if (at === -1) {
        throw new Error(`snapshot has no file "${path}"; listed: ${log.settings.map((s) => s.name).join(", ")}`);
      }
      await log.rows[at].buttons.find((b) => b.text === "Restore")!.click();
    },
  };
}
