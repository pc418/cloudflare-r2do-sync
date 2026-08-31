import { describe, it, expect } from "vitest";
import { SyncApi } from "../../plugin/src/api";
import { callTool, TOOLS, type ToolContext } from "../src/tools";
import { fetchHttp, VaultView } from "../src/vault";
import { PLUGIN_DIR } from "../../plugin/src/paths";
import { INDEX_CHUNK, SearchIndex } from "../src/index-store";
import {
  BLOB_BUDGET,
  CONTEXT_MAX,
  MAX_SCAN_FILES,
  REQUEST_OVERHEAD,
  SUBREQUEST_LIMIT,
} from "../src/search";
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
      search: /case-insensitively: a substring by default, or a regular expression/,
      read: /line numbers added for reference/,
      list: /downloading no note content/,
      recent: /downloading no note content/,
      append: /at the very end of a note/,
      edit: /failing unless that string appears exactly once/,
      write: /replace an existing one entirely and without warning/,
      delete: /Delete one note permanently/,
      move: /a path that does not already exist/,
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

  // A captured deferred-harness session dropped `initialize.instructions` entirely, including
  // the static preamble every build has served since before AGENT.md existed. A tool
  // description is the only carrier such a client cannot discard, so the pointer lives here —
  // on the two entry points into an unread vault, and never in the slot the catalog truncates
  // to, which belongs to each tool's own contract.
  it("points at AGENT.md from the entry-point read tools, below their first sentence", () => {
    const carriers = TOOLS.filter((t) => t.description.includes("`AGENT.md`"));
    expect(carriers.map((t) => t.name)).toEqual(["search", "list"]);
    for (const tool of carriers) {
      expect(firstSentence(tool.description)).not.toContain("AGENT.md");
      expect(tool.description).toMatch(/If the vault has a root note `AGENT\.md`/);
      // Supersession, without which a mid-session rewrite leaves the model arbitrating between
      // the note it just read and the copy its client cached at `initialize`.
      expect(tool.description).toMatch(/replacing any vault conventions you were given earlier/);
      // Scoped to vault conventions: a synced note must not read as authority over the chat.
      expect(tool.description).not.toMatch(/ignore|disregard|previous instructions/i);
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

  it("reads a note with line numbers, and no hash or snapshot id", async () => {
    const { ctx } = await context();
    const out = await callTool("read", { path: "Projects/Tea.md" }, ctx);
    expect(out).toContain("Gyokuro wants 60C water.");
    expect(out).toMatch(/^Projects\/Tea\.md \(\d+ lines\)/);
    expect(out).toContain("1  # Tea");
    // Filesystem semantics: nothing on this surface asks the model to reason about versions
    // or snapshots, so neither the content hash nor the head may leak back into a result.
    expect(out).not.toMatch(/hash|head at/);
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

  it("matches a regular expression only when asked, and stays case-insensitive", async () => {
    const { ctx } = await context();
    // A pattern that is meaningless as a substring: proof the mode is doing the work.
    const pattern = "gyokuro.*[0-9]+C";
    expect(await callTool("search", { query: pattern }, ctx)).toContain("No matches");
    const out = await callTool("search", { query: pattern, regex: true }, ctx);
    expect(out).toContain("Projects/Tea.md:3");
  });

  // The measured case this exists for: an outline query over one note returned ~35 lines of
  // context for 7 lines of signal, one of them an 800-character bullet, with no way to
  // suppress it. Zero is grep's own default, so no `paths_only` flag is needed — and the costs
  // are asymmetric: too little context is one cheap follow-up call, too much is spent in every
  // context window with no recourse.
  it("returns matched lines alone by default, and widens on request", async () => {
    const note = [
      "# Title",
      "prose above one",
      "prose above two",
      "## Section",
      "a very long bullet that is pure noise in an outline query",
      "## Another",
    ].join("\n");
    const { ctx } = await context({ notes: { "Outline.md": note } });

    const bare = await callTool("search", { query: "^#{1,6} ", regex: true }, ctx);
    expect(bare).toContain("Outline.md:1");
    expect(bare).toContain("# Title");
    expect(bare).toContain("## Section");
    // The whole point: none of the surrounding prose comes back unasked.
    expect(bare).not.toContain("prose above");
    expect(bare).not.toContain("pure noise");
    // Explicit 0 and the default are the same thing, not two code paths.
    expect(await callTool("search", { query: "^#{1,6} ", regex: true, context: 0 }, ctx)).toBe(bare);

    const wide = await callTool("search", { query: "## Section", context: 2 }, ctx);
    expect(wide).toContain("prose above two");
  });

  it("clamps context rather than failing a search over it", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => (i === 20 ? "needle" : `line ${i}`));
    const { ctx } = await context({ notes: { "Long.md": lines.join("\n") } });
    // 99 is a preference, not a mistake worth refusing — but it must not return the note.
    const out = await callTool("search", { query: "needle", context: 99 }, ctx);
    const shown = out.split("\n").filter((l) => l.startsWith("    ")).length;
    expect(shown).toBe(CONTEXT_MAX * 2 + 1);
    // Negative is nonsense; treat it as zero rather than inverting the slice.
    const none = await callTool("search", { query: "needle", context: -3 }, ctx);
    expect(none.split("\n").filter((l) => l.startsWith("    ")).length).toBe(1);
  });

  it("reports an unparseable pattern instead of burning the scan budget on it", async () => {
    const { ctx, vault } = await context();
    vault.requests.length = 0;
    await expect(callTool("search", { query: "unclosed(", regex: true }, ctx)).rejects.toThrow(
      /not a valid regular expression/
    );
    // Compiled before the first blob is fetched: a search that spent its budget and *then*
    // reported a syntax error would charge the caller for their own typo.
    expect(vault.requests.filter((r) => r.includes("/api/blobs/"))).toEqual([]);
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

  it("replaces every occurrence when asked, and still fails on none", async () => {
    const { ctx, view } = await context();
    // Two occurrences: the exactly-once contract refuses this, `replace_all` is the opt-in.
    expect(
      await callTool(
        "edit",
        { path: "Projects/Roadmap.md", old_text: "- [", new_text: "* [", replace_all: true },
        ctx
      )
    ).toContain("2 occurrence(s)");
    const snap = await view.snapshot({ fresh: true });
    const text = new TextDecoder().decode(await view.read(snap.files["Projects/Roadmap.md"]));
    expect(text).not.toContain("- [");
    expect(text.split("* [").length - 1).toBe(2);

    // Zero matches fails in both modes. "Replace all of them" is not an answer to "there are
    // none of them", and succeeding silently would report an edit no later read could find.
    await expect(
      callTool("edit", { path: "Welcome.md", old_text: "absent", new_text: "x", replace_all: true }, ctx)
    ).rejects.toThrow(/does not appear/);
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

  it("creates a new note with write", async () => {
    const { ctx } = await context();
    expect(await callTool("write", { path: "Fresh.md", content: "brand new\n" }, ctx)).toContain(
      "created Fresh.md"
    );
  });

  // Filesystem semantics, owner's call 2026-08-31: `write` replaces unconditionally, like
  // `fs.writeFile`. The version-bound overwrite this surface used to require is retired, and
  // the trade is history within GC retention. Pinned so nobody restores the guard by accident
  // — and so the schema cannot quietly regrow an `expected_hash` nothing reads.
  it("replaces an existing note unconditionally, with no hash anywhere on the tool", async () => {
    const { ctx, view } = await context();
    expect(
      await callTool("write", { path: "Welcome.md", content: "replaced\n" }, ctx)
    ).toContain("replaced Welcome.md");
    const snap = await view.snapshot({ fresh: true });
    expect(new TextDecoder().decode(await view.read(snap.files["Welcome.md"]))).toBe("replaced\n");

    const schema = TOOLS.find((t) => t.name === "write")!.inputSchema as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties)).toEqual(["path", "content"]);
  });

  it("deletes one note and leaves every other entry identical", async () => {
    const { ctx, view } = await context();
    const before = await view.snapshot();
    expect(await callTool("delete", { path: "Projects/Tea.md" }, ctx)).toContain(
      "deleted Projects/Tea.md"
    );
    const after = await view.snapshot({ fresh: true });
    expect(Object.keys(after.files)).not.toContain("Projects/Tea.md");
    for (const path of Object.keys(before.files)) {
      if (path === "Projects/Tea.md") continue;
      expect(after.files[path]).toEqual(before.files[path]);
    }
  });

  it("refuses to delete a note that is not there", async () => {
    const { ctx } = await context();
    await expect(callTool("delete", { path: "Nope.md" }, ctx)).rejects.toThrow(
      /does not exist.*nothing to delete/
    );
  });

  it("moves a note, carrying its entry byte-for-byte and uploading no blob", async () => {
    const { ctx, view, vault } = await context();
    const before = await view.snapshot();
    const entry = before.files["Projects/Tea.md"];
    vault.requests.length = 0;

    expect(await callTool("move", { from: "Projects/Tea.md", to: "Tea.md" }, ctx)).toContain(
      "moved Projects/Tea.md to Tea.md"
    );
    const after = await view.snapshot({ fresh: true });
    expect(Object.keys(after.files)).not.toContain("Projects/Tea.md");
    // Byte-for-byte, `mtime` included: nothing about the note changed, only its key in the map.
    expect(after.files["Tea.md"]).toEqual(entry);
    // Per-file keys derive from `blob:<content hash>` — content, never path — so a move is a
    // rename inside the encrypted path map and the blob is untouched. If a key derivation ever
    // becomes path-dependent, this fails and `move` has to download and re-encrypt.
    expect(vault.requests.filter((r) => r.startsWith("PUT /api/blobs/"))).toEqual([]);
  });

  // The one deliberate departure from `rename`'s silent clobber: replacing a *different* note
  // by accident is the worst surprise this surface can produce.
  it("refuses a move onto an occupied path, and one from a missing source", async () => {
    const { ctx, view } = await context();
    await expect(
      callTool("move", { from: "Projects/Tea.md", to: "Welcome.md" }, ctx)
    ).rejects.toThrow(/already exists/);
    await expect(callTool("move", { from: "Nope.md", to: "Fine.md" }, ctx)).rejects.toThrow(
      /does not exist.*nothing to move/
    );
    // Refused means nothing moved and nothing was replaced.
    const after = await view.snapshot({ fresh: true });
    expect(new TextDecoder().decode(await view.read(after.files["Welcome.md"]))).toContain(
      "# Welcome"
    );
    expect(Object.keys(after.files)).toContain("Projects/Tea.md");
  });

  // Found by adversarial review, on `move`, but it was never specific to `move`. A manifest is
  // a flat path map, so nothing in the format stops a commit holding both `Projects` and
  // `Projects/Roadmap.md` — and no filesystem can materialize that. A device pulling it fails
  // in `#ensureFolder`, so the agent would have published a snapshot that wedges every
  // device's next sync, with the server unable to catch it because it never sees a path.
  it("refuses any op that would make one path both a note and a folder", async () => {
    const { ctx, view } = await context();
    const before = await view.snapshot();

    // move onto a folder that holds files
    await expect(
      callTool("move", { from: "Welcome.md", to: "Projects" }, ctx)
    ).rejects.toThrow(/is a folder in this vault/);
    // write turning an existing folder into a note
    await expect(callTool("write", { path: "Projects", content: "x\n" }, ctx)).rejects.toThrow(
      /is a folder in this vault/
    );
    // append below an existing note, which is the same clash from the other side
    await expect(
      callTool("append", { path: "Welcome.md/child.md", text: "x\n" }, ctx)
    ).rejects.toThrow(/is a note, so/);

    // Every refusal left the vault exactly as it was.
    const after = await view.snapshot({ fresh: true });
    expect(after.files).toEqual(before.files);
  });

  // The follow-up review's catch: a per-op check rejected a batch whose *result* was legal,
  // purely on the order the ops arrived in. Only what gets committed has to be materializable.
  it("judges the clash on the finished batch, not one operation at a time", async () => {
    const vault = fakeVault();
    const crypto = await testCrypto();
    await seed(vault, crypto, { "Projects/Roadmap.md": "road\n" });
    const client = () => new SyncApi({ baseUrl: "https://vault.test", token: "t", http: vault.http });
    const view = new VaultView({ api: client(), writeApi: client(), crypto });
    const writer = new VaultWriter({ view, device: "agent" });

    // Written first, so a per-op check fires on an intermediate state that never reaches R2.
    await writer.apply([
      { kind: "write", path: "Projects", content: "now a note\n" },
      { kind: "delete", path: "Projects/Roadmap.md" },
    ]);
    const after = await view.snapshot({ fresh: true });
    expect(Object.keys(after.files)).toEqual(["Projects"]);

    // The genuinely unmaterializable batch still fails, and commits nothing.
    await expect(
      writer.apply([{ kind: "write", path: "Projects/again.md", content: "x\n" }])
    ).rejects.toThrow(/is a note, so/);
  });

  it("still allows a move onto a folder name the same op empties", async () => {
    const { ctx, view } = await context({ notes: { "Only/note.md": "solo\n", "T.md": "t\n" } });
    // `Only` stops being a folder in the same operation that makes it a note, so there is no
    // moment at which the map holds both — the clash has to survive the batch to be one.
    await callTool("move", { from: "Only/note.md", to: "Only" }, ctx);
    const after = await view.snapshot({ fresh: true });
    expect(Object.keys(after.files).sort()).toEqual(["Only", "T.md"]);
  });

  // An empty anchor matches between every character: `split`/`join` would interleave new_text
  // through the whole note and report a count nobody asked for, and on an empty note the count
  // arrives as -1, which is not a number of occurrences at all.
  it("refuses an empty edit anchor rather than interleaving the note", async () => {
    const { ctx, view } = await context({ notes: { "A.md": "abc", "E.md": "" } });
    for (const path of ["A.md", "E.md"]) {
      await expect(
        callTool("edit", { path, old_text: "", new_text: "X", replace_all: true }, ctx)
      ).rejects.toThrow(/"old_text" is empty/);
      await expect(
        callTool("edit", { path, old_text: "", new_text: "X" }, ctx)
      ).rejects.toThrow(/"old_text" is empty/);
    }
    const after = await view.snapshot({ fresh: true });
    expect(new TextDecoder().decode(await view.read(after.files["A.md"]))).toBe("abc");
  });

  it("is refused entirely when the deployment holds no write credential", async () => {
    const { ctx } = await context({ writable: false });
    await expect(callTool("append", { path: "a.md", text: "x" }, ctx)).rejects.toThrow(/read-only/);
    await expect(callTool("delete", { path: "a.md" }, ctx)).rejects.toThrow(/read-only/);
    await expect(callTool("move", { from: "a.md", to: "b.md" }, ctx)).rejects.toThrow(/read-only/);
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

  // A move has two ends, and only checking the source would make it a way to write outside the
  // policy from a path inside it — the destination is where the note actually lands.
  it("checks both ends of a move against the policy", async () => {
    const { ctx, view } = await withPolicy(
      { excludes: "Private/**" },
      { "Welcome.md": "hello\n" }
    );
    await expect(
      callTool("move", { from: "Welcome.md", to: "Private/smuggled.md" }, ctx)
    ).rejects.toThrow(/outside what this vault syncs/);
    const after = await view.snapshot({ fresh: true });
    expect(Object.keys(after.files)).toContain("Welcome.md");
  });

  // Same gate, sharper case: `selfDirs` holds this device's access token and master key.
  it("refuses a move that would land inside the plugin's own folder", async () => {
    const { ctx } = await context();
    await expect(
      callTool("move", { from: "Welcome.md", to: `${PLUGIN_DIR}/data.json` }, ctx)
    ).rejects.toThrow(/device credentials|not a path this vault syncs/);
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

  // DO SQLite has `LIKE` and no regular expressions, so an index that answered a `regex: true`
  // query would be applying substring semantics to a pattern — confidently wrong rather than
  // slow. The scan is the only correct path, current index or not.
  it("never lets the index answer a regular-expression search", async () => {
    const vault = fakeVault();
    const crypto = await testCrypto();
    await seed(vault, crypto, { "Tea.md": "# Tea\n\nGyokuro wants 60C water.\n" });

    const [indexed, viaRegex, wide] = await runInDurableObject(
      env.AGENT.getByName(`r-${Math.random().toString(36).slice(2)}`),
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
        // First call scans and catches the index up, so the second would be index-served.
        await callTool("search", { query: "gyokuro" }, ctx);
        const fromIndex = await callTool("search", { query: "gyokuro" }, ctx);
        const fromRegex = await callTool("search", { query: "gyokuro.*[0-9]+C", regex: true }, ctx);
        // `context` reaches the index too. It is an optional parameter on a separate code
        // path, so a forgotten hand-off would typecheck and silently ignore the caller.
        const wide = await callTool("search", { query: "gyokuro", context: 2 }, ctx);
        return [fromIndex, fromRegex, wide];
      }
    );
    // The index really was current — otherwise this test proves nothing about bypassing it.
    expect(indexed).toContain("indexed notes");
    expect(viaRegex).toContain("Tea.md:3");
    expect(viaRegex).not.toContain("indexed notes");
    // The match is on line 3; "# Tea" is line 1, so it appears only once context is asked for.
    expect(indexed).not.toContain("# Tea");
    expect(wide).toContain("indexed notes");
    expect(wide).toContain("# Tea");
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
