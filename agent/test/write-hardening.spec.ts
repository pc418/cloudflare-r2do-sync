/**
 * Regressions from the adversarial re-review of the write path (2026-08-31).
 *
 * The first review pass ran against compacted diffs and missed all three of these. They are
 * kept together because they share one lesson: on this surface the *carried* map and the
 * *visible* map are different things, and every decision has to say which one it means.
 */
import { describe, it, expect } from "vitest";
import { SyncApi } from "../../plugin/src/api";
import { callTool, type ToolContext } from "../src/tools";
import { VaultView } from "../src/vault";
import { VaultWriter, type WriteOp } from "../src/write";
import { fakeVault, policyDoc, seed, testCrypto } from "./helpers";

async function build(notes: Record<string, string>, policy?: Record<string, unknown>, deny?: string) {
  const vault = fakeVault();
  const crypto = await testCrypto();
  await seed(vault, crypto, notes);
  if (policy !== undefined) vault.settings = await policyDoc(crypto, 1, policy);
  const client = () => new SyncApi({ baseUrl: "https://vault.test", token: "t", http: vault.http });
  const view = new VaultView({ api: client(), writeApi: client(), crypto, deny });
  const writer = new VaultWriter({ view, device: "agent" });
  const ctx: ToolContext = {
    view, writable: true,
    enqueue: async (op: WriteOp) => {
      const o = await writer.apply([op]);
      return { head: o.head, summary: o.applied[0] };
    },
  };
  return { vault, crypto, view, writer, ctx };
}

describe("a refusal must not name what the agent cannot see", () => {
  it("never names an excluded file in a folder-conflict message", async () => {
    const { ctx } = await build(
      { "Welcome.md": "hi\n", "Credentials/keys.md": "AWS_SECRET=hunter2\n" },
      { excludes: "Credentials/**" }
    );
    // `Credentials/**` does not match the bare folder, so this passes the scope gate.
    const err = await callTool("append", { path: "Credentials", text: "x\n" }, ctx).then(
      () => null,
      (e: unknown) => String(e)
    );
    expect(err).not.toBeNull();
    expect(err).not.toContain("keys.md");
    // Not even that a folder is there: every child of it is hidden.
    expect(err).not.toMatch(/folder/);
  });

  const refusal = (ctx: ToolContext, op: { tool: string; args: Record<string, unknown> }) =>
    callTool(op.tool, op.args, ctx).then(
      () => null,
      (e: unknown) => String(e)
    );

  it("does not name, or confirm as a note, a hidden ancestor (excluded or denied)", async () => {
    const notes = { "Welcome.md": "hi\n", "Secret.md": "classified\n" };
    for (const { ctx } of [
      await build(notes, { excludes: "Secret.md" }),
      await build(notes, undefined, "Secret.md"),
    ]) {
      // The caller's own spelling, so the real-case name can only appear if it leaked.
      const err = await refusal(ctx, { tool: "append", args: { path: "secret.md/child.md", text: "x\n" } });
      expect(err).not.toBeNull();
      expect(err).toContain('"secret.md/child.md"');
      expect(err).not.toContain("Secret.md");
      expect(err).not.toMatch(/is a note/);
    }
  });

  it("refuses a hidden note and a hidden folder in the same words", async () => {
    const { ctx } = await build(
      { "Welcome.md": "hi\n", "Hidden.md": "n\n", "Vaulted/keys.md": "k\n" },
      { excludes: "Hidden.md\nVaulted/**" }
    );
    const asNote = await refusal(ctx, { tool: "append", args: { path: "Hidden.md/x.md", text: "x\n" } });
    const asFolder = await refusal(ctx, { tool: "append", args: { path: "Vaulted", text: "x\n" } });
    expect(asNote?.replace('"Hidden.md/x.md"', "<path>")).toBe(asFolder?.replace('"Vaulted"', "<path>"));
  });

  it("keeps the helpful diagnostics when the clash is visible", async () => {
    const { ctx } = await build(
      { "Welcome.md": "hi\n", "Mixed/open.md": "o\n", "Mixed/secret.md": "s\n" },
      { excludes: "Mixed/secret.md" }
    );
    const ancestor = await refusal(ctx, { tool: "append", args: { path: "Welcome.md/child.md", text: "x\n" } });
    expect(ancestor).toMatch(/"Welcome.md" is a note, so "Welcome.md\/child.md" cannot live inside it/);
    // A folder with a visible child names that one, and never the hidden sibling.
    const folder = await refusal(ctx, { tool: "append", args: { path: "Mixed", text: "x\n" } });
    expect(folder).toMatch(/"Mixed" is a folder in this vault \(it holds "Mixed\/open.md"\)/);
    expect(folder).not.toContain("secret.md");
  });
});

describe("prototype-named vault paths are ordinary absent paths", () => {
  it("treats __proto__/constructor/toString as absent, not as entries", async () => {
    const { ctx } = await build({ "Welcome.md": "hi\n" });
    for (const p of ["constructor", "toString", "valueOf"]) {
      await expect(callTool("delete", { path: p }, ctx)).rejects.toThrow(/does not exist/);
      await expect(callTool("move", { from: p, to: "X.md" }, ctx)).rejects.toThrow(/does not exist/);
    }
  });
});

describe("policy changing under a CAS retry", () => {
  it("refuses a delete whose path the vault excluded while the first attempt was in flight", async () => {
    const { vault, crypto, writer, view } = await build({
      "Welcome.md": "hi\n",
      "Secret.md": "not excluded yet\n",
    });

    // The vault moves under the write AND the policy changes at the same moment: another
    // device commits (losing us the CAS) and publishes an exclude covering our target.
    let raced = false;
    vault.before = async (path) => {
      if (path === "/api/commit" && !raced) {
        raced = true;
        vault.settings = await policyDoc(crypto, 2, { excludes: "Secret.md" }, { updatedAt: 1_754_000_001_000 });
        // The whole map the other device published — seeding replaces it, so the notes that
        // survive its commit have to be named here.
        await seed(vault, crypto, {
          "Welcome.md": "hi\n",
          "Secret.md": "not excluded yet\n",
          "Other.md": "from another device\n",
        });
      }
    };

    // Specifically the scope refusal: the retry must judge against the policy that is live
    // now, not the one captured before the first attempt.
    await expect(writer.apply([{ kind: "delete", path: "Secret.md" }])).rejects.toThrow(
      /outside what this vault syncs/
    );

    // The note the exclude was added to protect is still there.
    const after = await view.snapshot({ fresh: true });
    expect(Object.keys(after.all)).toContain("Secret.md");
  });
});

const doc = async (rev: number, plain: Record<string, unknown>) => policyDoc(await testCrypto(), rev, plain);

describe("policy moving between the snapshot and the scope gate", () => {
  it("never treats a carried-but-hidden note as absent and replaces it", async () => {
    const vault = fakeVault();
    const crypto = await testCrypto();
    await seed(vault, crypto, { "Secret.md": "the original content\n" });
    vault.settings = await doc(1, { excludes: "Secret.md" });

    // Flip the policy to ALLOW the path on the second settings read — i.e. between the
    // snapshot that built `seen` and the scope() call that gates the write.
    let reads = 0;
    vault.before = async (path) => {
      if (path === "/api/settings") {
        reads++;
        if (reads >= 2) vault.settings = await doc(2, { excludes: "" });
      }
    };

    const client = () => new SyncApi({ baseUrl: "https://vault.test", token: "t", http: vault.http });
    const view = new VaultView({ api: client(), writeApi: client(), crypto });
    const writer = new VaultWriter({ view, device: "agent" });

    await writer.apply([{ kind: "append", path: "Secret.md", text: "appended\n" }]).catch(() => null);

    const after = await view.snapshot({ fresh: true });
    const text = new TextDecoder().decode(await view.read(after.all["Secret.md"]));
    // Either the write was refused, or it appended. It must never have replaced the note.
    expect(text).toContain("the original content");
  });
});

describe("case-only note/folder clash", () => {
  it("refuses a path whose folder is an existing note in another case", async () => {
    const vault = fakeVault();
    const crypto = await testCrypto();
    await seed(vault, crypto, { "Projects": "i am a note, not a folder\n" });
    const client = () => new SyncApi({ baseUrl: "https://vault.test", token: "t", http: vault.http });
    const view = new VaultView({ api: client(), writeApi: client(), crypto });
    const writer = new VaultWriter({ view, device: "agent" });

    await expect(
      writer.apply([{ kind: "append", path: "projects/Roadmap.md", text: "x\n" }])
    ).rejects.toThrow();
  });
});

// On macOS, iOS and Windows a path differing only in case lands in the same folder, so a deny
// or exclude that matched case-exactly let `credentials/new.md` into a denied `Credentials/`.
describe("write gates ignore case; reads do not", () => {
  const notes = {
    "Welcome.md": "hi\n",
    "Credentials/keys.md": "AWS_SECRET=hunter2\n",
    // Visible today because the exact-case rule does not match it; the agent may still read it.
    "credentials/old.md": "legacy\n",
    "privateer/log.md": "ahoy\n",
  };
  const mutations = (dir: string): { tool: string; args: Record<string, unknown> }[] => [
    { tool: "append", args: { path: `${dir}/new.md`, text: "x\n" } },
    { tool: "append", args: { path: `${dir}/old.md`, text: "x\n" } },
    { tool: "edit", args: { path: `${dir}/old.md`, old_text: "legacy", new_text: "changed" } },
    { tool: "delete", args: { path: `${dir}/old.md` } },
    { tool: "move", args: { from: `${dir}/old.md`, to: "Moved.md" } },
    { tool: "move", args: { from: "Welcome.md", to: `${dir.toUpperCase()}/Welcome.md` } },
  ];

  for (const [label, setup, refusal] of [
    ["AGENT_DENY", () => build(notes, undefined, "Credentials/**\nPrivate/**"), /no permission/],
    ["the vault's excludes", () => build(notes, { excludes: "Credentials/**\nPrivate/**" }), /outside what this vault syncs/],
  ] as const) {
    it(`refuses every mutation under a mixed-case spelling of ${label}`, async () => {
      const { ctx, view } = await setup();
      const before = await view.snapshot({ fresh: true });
      for (const op of [...mutations("credentials"), ...mutations("CREDENTIALS")]) {
        await expect(callTool(op.tool, op.args, ctx), `${op.tool} ${JSON.stringify(op.args)}`).rejects.toThrow(refusal);
      }
      await expect(
        callTool("append", { path: "private/x.md", text: "x\n" }, ctx)
      ).rejects.toThrow(refusal);
      const after = await view.snapshot({ fresh: true });
      expect(after.all).toEqual(before.all);

      // Reads are unchanged: the mixed-case note stays readable, the real-case one hidden.
      expect(await callTool("read", { path: "credentials/old.md" }, ctx)).toContain("legacy");
      await expect(callTool("read", { path: "Credentials/keys.md" }, ctx)).rejects.toThrow(/no note at/);

      // Segment boundaries hold: `Private/**` does not reach `privateer/`.
      await callTool("append", { path: "privateer/new.md", text: "fine\n" }, ctx);
      await callTool("append", { path: "privateer/log.md", text: "more\n" }, ctx);
      const done = await view.snapshot({ fresh: true });
      expect(Object.keys(done.files)).toContain("privateer/new.md");
    });
  }
});
