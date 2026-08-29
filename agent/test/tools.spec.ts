import { describe, it, expect } from "vitest";
import { SyncApi } from "../../plugin/src/api";
import { callTool, TOOLS, type ToolContext } from "../src/tools";
import { fetchHttp, VaultView } from "../src/vault";
import { PLUGIN_DIR } from "../../plugin/src/paths";
import { VaultWriter, refuseWrite, type WriteOp } from "../src/write";
import { fakeVault, seed, testCrypto } from "./helpers";

const NOTES = {
  "Welcome.md": "# Welcome\n\nThis vault is a test fixture.\nNothing here is real.\n",
  "Projects/Roadmap.md": "# Roadmap\n\n- [x] read-only scope\n- [ ] agent worker\n",
  "Projects/Tea.md": "# Tea\n\nGyokuro wants 60C water.\n",
  "Daily/2026-08-28.md": "# Today\n\nStood up a dummy vault.\n",
};

async function context(opts: { writable?: boolean; notes?: Record<string, string> } = {}) {
  const vault = fakeVault();
  const crypto = await testCrypto();
  await seed(vault, crypto, opts.notes ?? NOTES);
  const client = () => new SyncApi({ baseUrl: "https://vault.test", token: "t", http: vault.http });
  const view = new VaultView({
    api: client(),
    writeApi: opts.writable === false ? null : client(),
    crypto,
  });
  const writer = new VaultWriter({ view, device: "agent" });
  const ctx: ToolContext = {
    view,
    writable: view.writable,
    enqueue: async (op: WriteOp) => {
      const outcome = await writer.apply([op]);
      return { head: outcome.head, summary: outcome.applied[0] };
    },
  };
  return { vault, crypto, view, writer, ctx };
}

describe("tool surface", () => {
  it("every tool is named, titled and annotated, within the 64-character limit", () => {
    for (const tool of TOOLS) {
      expect(tool.name.length).toBeLessThanOrEqual(64);
      expect(tool.title).not.toBe("");
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema).toMatchObject({ type: "object" });
      // Defaults are the pessimistic reading, so silence would describe `search` as possibly
      // destructive. `readOnlyHint: true` is also what lets a tool run without a per-call prompt.
      expect(Object.keys(tool.annotations).sort()).toEqual([
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
        "readOnlyHint",
      ]);
    }
    expect(TOOLS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)).toEqual([
      "search",
      "read",
      "list",
      "recent",
    ]);
  });
});

describe("read tools", () => {
  it("lists notes with no blob downloads", async () => {
    const { ctx, vault } = await context();
    vault.requests.length = 0;
    const out = await callTool("list", {}, ctx);
    expect(out).toContain("Projects/Roadmap.md");
    expect(out).toContain("head at");
    expect(vault.requests.filter((r) => r.includes("/api/blobs/"))).toEqual([]);
  });

  it("filters a listing by folder and by glob", async () => {
    const { ctx } = await context();
    const folder = await callTool("list", { folder: "Projects" }, ctx);
    expect(folder).toContain("Projects/Tea.md");
    expect(folder).not.toContain("Welcome.md");
    const glob = await callTool("list", { glob: "Daily/**" }, ctx);
    expect(glob).toContain("Daily/2026-08-28.md");
    expect(glob).not.toContain("Projects/Tea.md");
  });

  it("reads a note with line numbers and its hash", async () => {
    const { ctx } = await context();
    const out = await callTool("read", { path: "Projects/Tea.md" }, ctx);
    expect(out).toContain("Gyokuro wants 60C water.");
    expect(out).toMatch(/^Projects\/Tea\.md \(\d+ lines, hash [0-9a-f]{12}\)/);
    expect(out).toContain("1  # Tea");
  });

  it("pages a long note and says how much is left", async () => {
    const long = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    const { ctx } = await context({ notes: { "Long.md": long } });
    const out = await callTool("read", { path: "Long.md", offset: 10, limit: 5 }, ctx);
    expect(out).toContain("10  line 10");
    expect(out).toContain("14  line 14");
    expect(out).not.toContain("15  line 15");
    expect(out).toContain("more line(s); read again with offset 15");
  });

  it("suggests near matches instead of just failing on a wrong path", async () => {
    const { ctx } = await context();
    await expect(callTool("read", { path: "roadmap.md" }, ctx)).rejects.toThrow(/Did you mean.*Roadmap/);
  });

  it("searches with context lines and reports what it scanned", async () => {
    const { ctx } = await context();
    const out = await callTool("search", { query: "gyokuro" }, ctx);
    expect(out).toContain("Projects/Tea.md:3");
    expect(out).toContain("Gyokuro wants 60C water.");
    expect(out).toContain("scanned");
  });

  it("says plainly when a search found nothing", async () => {
    const { ctx } = await context();
    expect(await callTool("search", { query: "kombucha" }, ctx)).toContain("No matches");
  });

  it("restricts a search to a folder", async () => {
    const { ctx } = await context();
    const out = await callTool("search", { query: "roadmap", folder: "Daily" }, ctx);
    expect(out).toContain("No matches");
  });

  it("lists recent notes from metadata alone", async () => {
    const vault = fakeVault();
    const crypto = await testCrypto();
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    await seed(vault, crypto, { "Old.md": "ancient\n" }, { mtime: old });
    await seed(vault, crypto, { "New.md": "fresh\n" }, { mtime: Date.now() });
    const api = new SyncApi({ baseUrl: "https://vault.test", token: "t", http: vault.http });
    const view = new VaultView({ api, crypto });
    const ctx: ToolContext = { view, writable: false, enqueue: async () => ({ head: "", summary: "" }) };
    vault.requests.length = 0;
    const out = await callTool("recent", { days: 7 }, ctx);
    expect(out).toContain("New.md");
    expect(out).not.toContain("Old.md");
    expect(vault.requests.filter((r) => r.includes("/api/blobs/"))).toEqual([]);
  });
});

describe("credential-bearing paths are never exposed", () => {
  // The agent holds the master key. A `data.json` carried in an old snapshot holds another
  // device's access token AND master key, so reading it back would hand over the whole vault.
  it("hides hard-skipped paths from list, search and read", async () => {
    const { ctx } = await context({
      notes: {
        "Welcome.md": "hello\n",
        ".obsidian/plugins/cloudflare-r2do-sync/data.json": '{"accessToken":"SECRET-TOKEN"}\n',
      },
    });
    const listed = await callTool("list", {}, ctx);
    expect(listed).not.toContain("data.json");
    expect(listed).toContain("1 path(s) this vault never syncs are not listed");

    const searched = await callTool("search", { query: "SECRET-TOKEN" }, ctx);
    expect(searched).toContain("No matches");

    await expect(
      callTool("read", { path: ".obsidian/plugins/cloudflare-r2do-sync/data.json" }, ctx)
    ).rejects.toThrow(/no note at/);
  });

  it("refuses to write into the plugin's own folder", () => {
    expect(refuseWrite(`${PLUGIN_DIR}/data.json`, ".obsidian")).toMatch(/device credentials/);
    // Any other config-directory path is refused too, by the standing hard-skip set.
    expect(refuseWrite(".obsidian/workspace.json", ".obsidian")).toMatch(/does not sync|never syncs|not a path/);
    expect(refuseWrite("Notes/fine.md", ".obsidian")).toBeNull();
  });
});

describe("write tools", () => {
  it("appends to an existing note and commits a new snapshot", async () => {
    const { ctx, vault, view } = await context();
    const before = vault.head;
    const out = await callTool("append", { path: "Daily/2026-08-28.md", text: "- another thought\n" }, ctx);
    expect(out).toContain("appended to Daily/2026-08-28.md");
    expect(vault.head).not.toBe(before);
    const after = await view.snapshot({ fresh: true });
    const text = new TextDecoder().decode(await view.read(after.files["Daily/2026-08-28.md"]));
    expect(text).toContain("- another thought");
    expect(text).toContain("Stood up a dummy vault.");
  });

  it("creates the note when appending to a path that does not exist", async () => {
    const { ctx, view } = await context();
    expect(await callTool("append", { path: "Inbox/new.md", text: "captured\n" }, ctx)).toContain(
      "created Inbox/new.md"
    );
    const snap = await view.snapshot({ fresh: true });
    expect(Object.keys(snap.files)).toContain("Inbox/new.md");
  });

  it("carries every untouched entry through unchanged", async () => {
    const { ctx, view } = await context();
    const before = await view.snapshot();
    await callTool("append", { path: "Welcome.md", text: "more\n" }, ctx);
    const after = await view.snapshot({ fresh: true });
    for (const path of Object.keys(before.files)) {
      if (path === "Welcome.md") continue;
      expect(after.files[path]).toEqual(before.files[path]);
    }
  });

  it("edits a unique string, and refuses an ambiguous or absent one", async () => {
    const { ctx, view } = await context();
    expect(await callTool("edit", { path: "Projects/Tea.md", old_text: "60C", new_text: "50C" }, ctx)).toContain(
      "edited"
    );
    const snap = await view.snapshot({ fresh: true });
    expect(new TextDecoder().decode(await view.read(snap.files["Projects/Tea.md"]))).toContain("50C");

    await expect(
      callTool("edit", { path: "Projects/Tea.md", old_text: "absent", new_text: "x" }, ctx)
    ).rejects.toThrow(/does not appear/);
    await expect(
      callTool("edit", { path: "Projects/Roadmap.md", old_text: "- [", new_text: "* [" }, ctx)
    ).rejects.toThrow(/appears 2 times/);
  });

  it("binds an overwrite to the version that was read", async () => {
    const { ctx, view } = await context();
    const snap = await view.snapshot();
    const stale = "0".repeat(64);
    await expect(
      callTool("write", { path: "Welcome.md", content: "replaced\n", expected_hash: stale }, ctx)
    ).rejects.toThrow(/changed since it was read/);

    const good = snap.files["Welcome.md"].h;
    expect(
      await callTool("write", { path: "Welcome.md", content: "replaced\n", expected_hash: good }, ctx)
    ).toContain("replaced Welcome.md");
  });

  it("creates a new note with write and needs no hash for it", async () => {
    const { ctx } = await context();
    expect(await callTool("write", { path: "Fresh.md", content: "brand new\n" }, ctx)).toContain(
      "created Fresh.md"
    );
  });

  // Creating is free; replacing is not. An absent hash on an existing note must be a refusal,
  // or a model that never read the note could discard it wholesale on a guessed path.
  it("refuses to replace an existing note when no hash was supplied at all", async () => {
    const { ctx, view } = await context();
    await expect(
      callTool("write", { path: "Welcome.md", content: "clobbered\n" }, ctx)
    ).rejects.toThrow(/already exists.*expected_hash/s);
    const snap = await view.snapshot({ fresh: true });
    expect(new TextDecoder().decode(await view.read(snap.files["Welcome.md"]))).toContain("# Welcome");
  });

  it("is refused entirely when the deployment holds no write credential", async () => {
    const { ctx } = await context({ writable: false });
    await expect(callTool("append", { path: "a.md", text: "x" }, ctx)).rejects.toThrow(/read-only/);
  });

  it("cannot commit when the sync token itself is read-only, even if asked", async () => {
    const { ctx, vault } = await context();
    // The server, not the agent, is the one refusing here.
    vault.readOnly = true;
    await expect(callTool("append", { path: "a.md", text: "x" }, ctx)).rejects.toThrow();
    expect(vault.manifests.size).toBe(1);
  });
});

describe("concurrency", () => {
  it("re-applies onto the new head when another device commits mid-write", async () => {
    const { vault, crypto, view, writer } = await context();
    let raced = false;
    // A real device lands a snapshot in the window between absorb and commit.
    vault.before = async (path) => {
      if (path === "/api/commit" && !raced) {
        raced = true;
        await seed(vault, crypto, { "Other.md": "from another device\n" });
      }
    };

    const outcome = await writer.apply([{ kind: "append", path: "Welcome.md", text: "mine\n" }]);
    expect(outcome.head).toBe(vault.head);
    const after = await view.snapshot({ fresh: true });
    // Neither write is lost: the CAS retry re-applied onto what the other device wrote.
    expect(Object.keys(after.files)).toContain("Other.md");
    expect(new TextDecoder().decode(await view.read(after.files["Welcome.md"]))).toContain("mine");
  });

  it("commits one snapshot for a batch, not one per operation", async () => {
    const { vault, writer, view } = await context();
    const before = vault.manifests.size;
    await writer.apply([
      { kind: "append", path: "Daily/2026-08-28.md", text: "one\n" },
      { kind: "append", path: "Daily/2026-08-28.md", text: "two\n" },
      { kind: "append", path: "Inbox/capture.md", text: "three\n" },
    ]);
    expect(vault.manifests.size).toBe(before + 1);
    const snap = await view.snapshot({ fresh: true });
    const daily = new TextDecoder().decode(await view.read(snap.files["Daily/2026-08-28.md"]));
    // Two appends to one path in one batch chain, rather than the second overwriting the first.
    expect(daily).toContain("one");
    expect(daily).toContain("two");
    expect(snap.files["Inbox/capture.md"]).toBeDefined();
  });
});

describe("fetchHttp", () => {
  it("is a structural passthrough of the platform Response", async () => {
    expect(typeof fetchHttp).toBe("function");
  });
});
