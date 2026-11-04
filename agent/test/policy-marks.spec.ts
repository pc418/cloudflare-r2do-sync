/**
 * Once this agent has read an authenticated (v3) policy for its vault, a missing settings
 * document is not "no policy", and a v2 one is not an edit. The fact is kept in the Durable
 * Object's storage, so it holds for a view built later over the same storage — an isolate
 * restart or a redeploy — and is read from storage at the moment of the decision.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { SyncApi } from "../../plugin/src/api";
import { VaultCrypto } from "../../plugin/src/crypto";
import { callTool, type ToolContext } from "../src/tools";
import { StoredVaultMarks, VaultView } from "../src/vault";
import type { AgentState } from "../src/agent-state";
import { fakeVault, policyDoc, seed, testCrypto, type FakeVault } from "./helpers";

const NOTES = { "Welcome.md": "hi\n", "Private/diary.md": "secret entry\n" };

/** A fresh view over a fresh client — what a restarted isolate would build — on `storage`. */
function viewOver(vault: FakeVault, crypto: VaultCrypto, sql: SqlStorage, scope = "vault-a"): ToolContext {
  const view = new VaultView({
    api: new SyncApi({ baseUrl: "https://vault.test", token: "t", http: vault.http }),
    crypto,
    marks: new StoredVaultMarks(sql, scope),
  });
  return { view, writable: false, enqueue: async () => ({ head: "", summary: "" }) };
}

/** Each call runs in the same Durable Object, so `state.storage` is the same storage. */
function inObject(name: string) {
  const stub = env.AGENT.getByName(name);
  return <T>(body: (sql: SqlStorage) => Promise<T>): Promise<T> =>
    runInDurableObject(stub, (_i: AgentState, state) => body(state.storage.sql));
}

const listed = async (ctx: ToolContext) => callTool("list", {}, ctx);

describe("an authenticated policy, once read, cannot silently disappear", () => {
  it("refuses a later 404 — from a view rebuilt over the same storage, and from the old one", async () => {
    const vault = fakeVault();
    const crypto = await testCrypto();
    await seed(vault, crypto, NOTES);
    vault.settings = await policyDoc(crypto, 1, { excludes: "Private/**" });
    const run = inObject(`marks-${Math.random().toString(36).slice(2)}`);

    const first = await run(async (sql) => {
      const ctx = viewOver(vault, crypto, sql);
      return { out: await listed(ctx), ctx };
    });
    expect(first.out).toContain("Welcome.md");
    expect(first.out).not.toContain("Private/diary.md");

    // The settings document vanishes (only a server or R2 operator can do that).
    vault.settings = undefined;
    await run(async (sql) => {
      await expect(listed(viewOver(vault, crypto, sql))).rejects.toThrow(
        /missing, but an authenticated policy for this vault was read before/
      );
    });
    // The view that read the policy refuses as well: the decision reads storage, not memory.
    await run(async () => {
      await expect(listed(first.ctx)).rejects.toThrow(/refusing to fall back to no restrictions/);
    });
  });

  it("refuses a v2 settings document after v3 was read, but not on a vault that never had v3", async () => {
    const crypto = await testCrypto();
    const v2Doc = async () => ({
      v: 2, rev: 1, device: "old-phone", updatedAt: 1_754_000_000_000, keyId: crypto.keyId,
      enc: await crypto.encryptSettingsJson({ excludes: "" }),
    });

    const legacy = fakeVault();
    await seed(legacy, crypto, NOTES);
    legacy.settings = await v2Doc();
    await inObject(`marks-${Math.random().toString(36).slice(2)}`)(async (sql) => {
      expect(await listed(viewOver(legacy, crypto, sql))).toContain("Private/diary.md");
    });

    const upgraded = fakeVault();
    await seed(upgraded, crypto, NOTES);
    upgraded.settings = await policyDoc(crypto, 2, { excludes: "Private/**" });
    const run = inObject(`marks-${Math.random().toString(36).slice(2)}`);
    await run(async (sql) => {
      await listed(viewOver(upgraded, crypto, sql));
    });
    upgraded.settings = await v2Doc();
    await run(async (sql) => {
      await expect(listed(viewOver(upgraded, crypto, sql))).rejects.toThrow(/legacy v2 format/);
    });
  });

  it("keeps a first-ever 404 meaning 'no policy', and an invalid document sets nothing", async () => {
    const vault = fakeVault();
    const crypto = await testCrypto();
    await seed(vault, crypto, NOTES);
    const run = inObject(`marks-${Math.random().toString(36).slice(2)}`);

    // Never published: the whole vault (minus hard skips) is in scope, as before.
    await run(async (sql) => {
      expect(await listed(viewOver(vault, crypto, sql))).toContain("Private/diary.md");
    });

    // A v3 document that authenticates but cannot be understood, and one that does not
    // authenticate at all: both refused, and neither may arm the latch.
    const good = await policyDoc(crypto, 3, { excludes: "Private/**" });
    for (const bad of [
      await policyDoc(crypto, 3, { excludes: ["not", "text"] }),
      { ...good, device: "tampered" },
    ]) {
      vault.settings = bad;
      await run(async (sql) => {
        await expect(listed(viewOver(vault, crypto, sql))).rejects.toThrow();
      });
    }
    vault.settings = undefined;
    await run(async (sql) => {
      expect(await listed(viewOver(vault, crypto, sql))).toContain("Private/diary.md");
    });
  });

  it("is scoped to one vault: the same storage serving another vault starts clean", async () => {
    const vault = fakeVault();
    const crypto = await testCrypto();
    await seed(vault, crypto, NOTES);
    vault.settings = await policyDoc(crypto, 1, { excludes: "Private/**" });
    const run = inObject(`marks-${Math.random().toString(36).slice(2)}`);
    await run(async (sql) => {
      await listed(viewOver(vault, crypto, sql, "vault-a"));
    });
    vault.settings = undefined;
    await run(async (sql) => {
      expect(await listed(viewOver(vault, crypto, sql, "vault-b"))).toContain("Welcome.md");
    });
  });
});
