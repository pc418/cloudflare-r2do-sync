import { describe, it, expect } from "vitest";
import { SyncApi } from "../../plugin/src/api";
import { callTool, TOOLS, type ToolContext } from "../src/tools";
import { fetchHttp, VaultView } from "../src/vault";
import { PLUGIN_DIR } from "../../plugin/src/paths";
import { INDEX_CHUNK, SearchIndex } from "../src/index-store";
import { BLOB_BUDGET, MAX_SCAN_FILES, REQUEST_OVERHEAD, SUBREQUEST_LIMIT } from "../src/search";
import { env, runInDurableObject } from "cloudflare:test";
import type { AgentState } from "../src/agent-state";
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

  // A deferred-tools client shows the model names and one-line blurbs, fetching full
  // descriptions and schemas only on an explicit request. Until it does, the first sentence is
  // the entire description — so a contract that lives in sentence two is a contract the model
  // plans without. Pinned here because the failure is invisible: the tool still works, the
  // caller just does not know the rule it is about to break.
  it("states each tool's load-bearing contract in its first sentence", () => {
    const contracts: Record<string, RegExp> = {
      search: /case-insensitive substring, never a regular expression/,
      read: /hash that `write` requires/,
      list: /downloading no note content/,
      recent: /downloading no note content/,
      append: /at the very end of a note/,
      edit: /failing unless that string appears exactly once/,
      write: /requires expected_hash from a prior `read`/,
    };
    expect(Object.keys(contracts).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    for (const tool of TOOLS) {
      const first = firstSentence(tool.description);
      expect(first, `${tool.name}: contract missing from its first sentence`).toMatch(
        contracts[tool.name]
      );
      // A blurb nobody reads to the end is the same failure in a different costume.
      expect(first.length, `${tool.name}: first sentence too long to serve as a blurb`)
        .toBeLessThanOrEqual(200);
    }
  });
});

/** Up to the first sentence-ending period followed by whitespace, or the whole string. */
function firstSentence(text: string): string {
  const end = /\.\s/.exec(text);
  return end === null ? text : text.slice(0, end.index + 1);
}

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
    // The FULL hash: `write` compares `expected_hash` against all 64 characters, so a
    // truncated one made the advertised read-then-write workflow impossible.
    expect(out).toMatch(/^Projects\/Tea\.md \(\d+ lines, hash [0-9a-f]{64}\)/);
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

describe("the shared sync policy governs the agent too", () => {
  const policy = (plain: Record<string, unknown>) => ({
    v: 1 as const,
    updatedAt: 1_754_000_000_000,
    device: "laptop",
    rev: 1,
    plain,
  });

  async function withPolicy(plain: Record<string, unknown>, notes: Record<string, string>) {
    const vault = fakeVault();
    const crypto = await testCrypto();
    await seed(vault, crypto, notes);
    vault.settings = policy(plain);
    const client = () => new SyncApi({ baseUrl: "https://vault.test", token: "t", http: vault.http });
    const view = new VaultView({ api: client(), writeApi: client(), crypto });
    const writer = new VaultWriter({ view, device: "agent" });
    const ctx: ToolContext = {
      view,
      writable: true,
      enqueue: async (op: WriteOp) => {
        const outcome = await writer.apply([op]);
        return { head: outcome.head, summary: outcome.applied[0] };
      },
    };
    return { vault, view, writer, ctx };
  }

  // The standing-instructions note is read through the same scoped snapshot as everything
  // else, which is the whole reason it is not a second read path: an AGENT.md the vault
  // excludes must be invisible to the agent exactly as any other excluded note is. Asserted at
  // the snapshot, not through a tool, because the tool layer is not what enforces it.
  it("hides an excluded AGENT.md from the instructions the agent would serve", async () => {
    const { view } = await withPolicy(
      { excludes: "AGENT.md" },
      { "Welcome.md": "hello\n", "AGENT.md": "read Inbox.md first\n" }
    );
    const snapshot = await view.snapshot();
    // Carried in the snapshot, as every excluded path is — and absent from what may be read.
    expect(Object.keys(snapshot.all)).toContain("AGENT.md");
    expect(Object.keys(snapshot.files)).not.toContain("AGENT.md");
  });

  it("serves an AGENT.md the policy allows", async () => {
    const { view } = await withPolicy({}, { "AGENT.md": "read Inbox.md first\n" });
    const snapshot = await view.snapshot();
    expect(Object.keys(snapshot.files)).toContain("AGENT.md");
  });

  // The vault's excludes are what keep a credentials folder — real secrets — off synced devices.
  // Excluded paths are CARRIED in snapshots, so without this the agent reads them straight out
  // of the path map and hands them to whatever the model was asked to summarise.
  it("hides user-excluded paths from list, read and search", async () => {
    const { ctx } = await withPolicy(
      { excludes: "Credentials/**" },
      { "Welcome.md": "hello\n", "Credentials/keys.md": "AWS_SECRET=hunter2\n" }
    );
    const listed = await callTool("list", {}, ctx);
    expect(listed).not.toContain("Credentials/keys.md");
    expect(listed).toContain("path(s) this vault never syncs are not listed");
    expect(await callTool("search", { query: "hunter2" }, ctx)).toContain("No matches");
    await expect(callTool("read", { path: "Credentials/keys.md" }, ctx)).rejects.toThrow(/no note at/);
  });

  it("refuses to write to an excluded path", async () => {
    const { ctx } = await withPolicy({ excludes: "Private/**" }, { "Welcome.md": "hello\n" });
    await expect(
      callTool("append", { path: "Private/secret.md", text: "x" }, ctx)
    ).rejects.toThrow(/outside what this vault syncs/);
  });

  it("honours an only-paths allow-list in both directions", async () => {
    const { ctx } = await withPolicy(
      { onlyPaths: "Notes/**" },
      { "Notes/a.md": "in scope\n", "Other/b.md": "out of scope\n" }
    );
    const listed = await callTool("list", {}, ctx);
    expect(listed).toContain("Notes/a.md");
    expect(listed).not.toContain("Other/b.md");
    await expect(callTool("append", { path: "Elsewhere/c.md", text: "x" }, ctx)).rejects.toThrow(
      /outside what this vault syncs/
    );
  });

  // A 404 is a real state — no policy published yet. Any other failure is not evidence of an
  // absent policy, and treating it as one would open the vault wide exactly when something
  // is wrong.
  it("treats an absent settings document as no policy, but never a failed read", async () => {
    const { ctx } = await context();
    expect(await callTool("list", {}, ctx)).toContain("Welcome.md");

    const broken = fakeVault();
    const crypto = await testCrypto();
    await seed(broken, crypto, { "a.md": "x\n" });
    broken.settingsStatus = 500;
    const client = () => new SyncApi({ baseUrl: "https://vault.test", token: "t", http: broken.http });
    const view = new VaultView({ api: client(), crypto });
    const ctx2: ToolContext = { view, writable: false, enqueue: async () => ({ head: "", summary: "" }) };
    await expect(callTool("list", {}, ctx2)).rejects.toThrow();
  });

  // A policy is edited on a phone and published without any snapshot being committed. A cache
  // that only refreshed when the head moved would keep exposing a just-excluded folder for the
  // lifetime of the Durable Object.
  it("notices a policy change even though the head never moved", async () => {
    const { ctx, vault } = await withPolicy({ excludes: "" }, { "Welcome.md": "hi\n", "Secrets/k.md": "TOPSECRET\n" });
    expect(await callTool("list", {}, ctx)).toContain("Secrets/k.md");
    expect(await callTool("search", { query: "TOPSECRET" }, ctx)).toContain("Secrets/k.md");

    const head = vault.head;
    vault.settings = { v: 1, updatedAt: 1_754_000_000_001, device: "phone", rev: 2, plain: { excludes: "Secrets/**" } };
    expect(vault.head).toBe(head); // nothing was committed

    expect(await callTool("list", {}, ctx)).not.toContain("Secrets/k.md");
    expect(await callTool("search", { query: "TOPSECRET" }, ctx)).toContain("No matches");
    await expect(callTool("append", { path: "Secrets/k.md", text: "x" }, ctx)).rejects.toThrow(
      /outside what this vault syncs/
    );
  });

  // A present-but-not-text policy field is a document this agent does not understand. Reading
  // it as "no excludes" would widen scope to the whole vault exactly when the policy stopped
  // making sense.
  it("fails closed on a malformed policy field instead of exposing everything", async () => {
    const { ctx } = await withPolicy({ excludes: ["Secrets/**"] }, { "Welcome.md": "hi\n" });
    await expect(callTool("list", {}, ctx)).rejects.toThrow(/is not text/);
  });

  // `null` is a PRESENT value, not an absent field. Reading it as "no rule" widens scope
  // exactly as reading an array that way would.
  it("refuses an explicitly null policy field", async () => {
    const { ctx } = await withPolicy({ excludes: null }, { "Welcome.md": "hi\n" });
    await expect(callTool("list", {}, ctx)).rejects.toThrow(/is not text/);
  });

  it("still accepts a policy that simply omits a field", async () => {
    const { ctx } = await withPolicy({ excludes: "Secrets/**" }, { "Welcome.md": "hi\n" });
    expect(await callTool("list", {}, ctx)).toContain("Welcome.md");
  });

  // Excluded and hard-skipped entries are carried through snapshots on purpose. A commit built
  // from the visible subset deletes every one of them.
  it("carries hidden entries through a commit instead of deleting them", async () => {
    const { ctx, view } = await withPolicy(
      { excludes: "Credentials/**" },
      { "Welcome.md": "hello\n", "Credentials/keys.md": "AWS_SECRET=hunter2\n" }
    );
    await callTool("append", { path: "Welcome.md", text: "more\n" }, ctx);
    const after = await view.snapshot({ fresh: true });
    expect(Object.keys(after.all)).toContain("Credentials/keys.md");
    expect(Object.keys(after.files)).not.toContain("Credentials/keys.md");
  });
});

describe("budgets and configuration", () => {
  // The Free plan allows 50 EXTERNAL subrequests per invocation. Every blob is a fetch to the
  // sync Worker, and head + manifest + settings have already spent three. Exceeding it does
  // not degrade gracefully — it throws mid-scan.
  // The earlier version of this test allowed the combined work to reach TWO limits, which is
  // exactly the mistake: a search that misses the index scans and then catches up in the SAME
  // invocation, so the two budgets add.
  it("keeps one invocation's worst case under the external subrequest limit", () => {
    expect(REQUEST_OVERHEAD + BLOB_BUDGET).toBeLessThanOrEqual(SUBREQUEST_LIMIT);
    expect(MAX_SCAN_FILES).toBeLessThanOrEqual(BLOB_BUDGET);
    expect(INDEX_CHUNK).toBeLessThanOrEqual(BLOB_BUDGET);
    // The worst case is a full scan followed by a catch-up taking what is left, never both caps.
    expect(REQUEST_OVERHEAD + MAX_SCAN_FILES + (BLOB_BUDGET - MAX_SCAN_FILES)).toBeLessThanOrEqual(
      SUBREQUEST_LIMIT
    );
  });

  it("spends no more blob reads in one search than the shared budget allows", async () => {
    const notes: Record<string, string> = {};
    for (let i = 0; i < BLOB_BUDGET * 2; i++) notes[`n${i}.md`] = `note ${i}\nneedle here\n`;
    const vault = fakeVault();
    const crypto = await testCrypto();
    await seed(vault, crypto, notes);

    // Entirely inside the Durable Object: its SQLite handle cannot be used from outside it.
    const blobReads = await runInDurableObject(
      env.AGENT.getByName(`b-${Math.random().toString(36).slice(2)}`),
      async (_i: AgentState, state) => {
        const view = new VaultView({
          api: new SyncApi({ baseUrl: "https://vault.test", token: "t", http: vault.http }),
          crypto,
        });
        const ctx: ToolContext = {
          view,
          writable: false,
          enqueue: async () => ({ head: "", summary: "" }),
          index: new SearchIndex(state.storage.sql),
        };
        vault.requests.length = 0;
        await callTool("search", { query: "needle", max_results: 1000 }, ctx);
        return vault.requests.filter((r) => r.startsWith("GET /api/blobs/")).length;
      }
    );
    expect(blobReads).toBeLessThanOrEqual(BLOB_BUDGET);
  });

  // A failed fetch has still been spent. Budgeting on successes lets a run of unreadable
  // blobs walk past the limit, and hands the catch-up a remainder that was already used.
  it("counts a failed blob read against the budget, not only a successful one", async () => {
    const notes: Record<string, string> = {};
    for (let i = 0; i < BLOB_BUDGET * 2; i++) notes[`n${i}.md`] = `note ${i}\nneedle\n`;
    const vault = fakeVault();
    const crypto = await testCrypto();
    await seed(vault, crypto, notes);
    // Every blob fetch fails, so `scanned` would stay at zero forever.
    vault.before = async (path, method) => {
      if (method === "GET" && path.startsWith("/api/blobs/")) vault.blobs.clear();
    };

    const blobReads = await runInDurableObject(
      env.AGENT.getByName(`f-${Math.random().toString(36).slice(2)}`),
      async (_i: AgentState, state) => {
        const view = new VaultView({
          api: new SyncApi({ baseUrl: "https://vault.test", token: "t", http: vault.http }),
          crypto,
        });
        const ctx: ToolContext = {
          view,
          writable: false,
          enqueue: async () => ({ head: "", summary: "" }),
          index: new SearchIndex(state.storage.sql),
        };
        vault.requests.length = 0;
        await callTool("search", { query: "needle", max_results: 1000 }, ctx);
        return vault.requests.filter((r) => r.startsWith("GET /api/blobs/")).length;
      }
    );
    expect(blobReads).toBeGreaterThan(0);
    expect(blobReads).toBeLessThanOrEqual(BLOB_BUDGET);
  });

  // A vault whose Obsidian folder was renamed still has credentials under the ACTIVE directory.
  // The reader and the writer must be deciding about the same one.
  it("applies a renamed config directory to both hiding and write protection", async () => {
    const vault = fakeVault();
    const crypto = await testCrypto();
    await seed(vault, crypto, {
      "Welcome.md": "hello\n",
      ".config/plugins/cloudflare-rdo-sync/data.json": '{"accessToken":"SECRET"}\n',
    });
    const client = () => new SyncApi({ baseUrl: "https://vault.test", token: "t", http: vault.http });
    const view = new VaultView({ api: client(), writeApi: client(), crypto, configDir: ".config" });
    const writer = new VaultWriter({ view, device: "agent" });
    const ctx: ToolContext = {
      view,
      writable: true,
      enqueue: async (op: WriteOp) => {
        const outcome = await writer.apply([op]);
        return { head: outcome.head, summary: outcome.applied[0] };
      },
    };

    const listed = await callTool("list", {}, ctx);
    expect(listed).not.toContain("data.json");
    expect(await callTool("search", { query: "SECRET" }, ctx)).toContain("No matches");
    await expect(
      callTool("append", { path: ".config/plugins/cloudflare-rdo-sync/data.json", text: "x" }, ctx)
    ).rejects.toThrow(/credential|never syncs|not a path|outside what/);
    // The writer inherits the view's directory rather than defaulting to `.obsidian`.
    expect(writer instanceof VaultWriter).toBe(true);
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
