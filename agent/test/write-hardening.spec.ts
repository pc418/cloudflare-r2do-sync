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
import { fakeVault, seed, testCrypto } from "./helpers";

async function build(notes: Record<string, string>, settings?: unknown) {
  const vault = fakeVault();
  const crypto = await testCrypto();
  await seed(vault, crypto, notes);
  if (settings !== undefined) vault.settings = settings;
  const client = () => new SyncApi({ baseUrl: "https://vault.test", token: "t", http: vault.http });
  const view = new VaultView({ api: client(), writeApi: client(), crypto });
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
      { v: 1 as const, updatedAt: 1_754_000_000_000, device: "laptop", rev: 1, plain: { excludes: "Credentials/**" } }
    );
    // `Credentials/**` does not match the bare folder, so this passes the scope gate.
    const err = await callTool("write", { path: "Credentials", content: "x\n" }, ctx).then(
      () => null,
      (e: unknown) => String(e)
    );
    expect(err).not.toBeNull();
    expect(err).not.toContain("keys.md");
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
        vault.settings = {
          v: 1 as const,
          updatedAt: 1_754_000_001_000,
          device: "laptop",
          rev: 2,
          plain: { excludes: "Secret.md" },
        };
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
