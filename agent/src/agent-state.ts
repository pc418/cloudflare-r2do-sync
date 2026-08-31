/**
 * The agent's single stateful point.
 *
 * Every tool call is routed through one instance, which buys three things at once: the
 * decrypted path map is cached across a search→read→read burst instead of being re-fetched
 * per call; writes are serialised, so two tool calls in one turn cannot race each other into
 * a CAS fight; and a burst of captures coalesces into one snapshot rather than one per
 * keystroke. Manifests are ~353 KB, so per-call commits at chat cadence would bloat history
 * for nothing — and not creating the waste beats collecting it later.
 */
import { DurableObject } from "cloudflare:workers";
import { SyncApi } from "../../plugin/src/api";
import { VaultCrypto } from "../../plugin/src/crypto";
import { SearchIndex, type IndexStatus } from "./index-store";
import { callTool, type ToolContext } from "./tools";
import { fetchHttp, VaultView } from "./vault";
import { VaultWriter, type WriteOp, type WriteOutcome } from "./write";
import type { AgentEnv } from "./env";

/**
 * How long a write waits for company before it commits.
 *
 * Long enough that several `append`s in one chat turn land in one snapshot; short enough that
 * a single capture still feels immediate. The caller awaits the flush either way, so the
 * result it reports is a real committed head, never an optimistic "queued".
 */
export const WRITE_DEBOUNCE_MS = 2000;

/**
 * The note carrying the owner's standing instructions for this agent.
 *
 * A note rather than a deploy-time binding, because it is *preference*, not policy: the owner
 * edits it in Obsidian on any device, it syncs, history versions it, and on a writable
 * deployment the agent can update its own instructions with an ordinary `edit` — no redeploy,
 * ever. Security policy takes the opposite route and stays in bindings.
 *
 * The name is fixed. A configurable filename would be a knob with one caller, which is exactly
 * the speculative flag the simplicity rule bans.
 */
export const INSTRUCTIONS_NOTE = "AGENTS.md";

export class AgentState extends DurableObject<AgentEnv> {
  #view: VaultView | null = null;
  #writer: VaultWriter | null = null;
  #pending: WriteOp[] = [];
  #flush: Promise<WriteOutcome> | null = null;

  async #ready(): Promise<{ view: VaultView; writer: VaultWriter }> {
    if (this.#view === null || this.#writer === null) {
      const crypto = await VaultCrypto.fromText(this.env.VAULT_MASTER_KEY);
      const client = (token: string) =>
        new SyncApi({ baseUrl: this.env.SYNC_URL, token, http: fetchHttp });
      const write = this.env.SYNC_WRITE_TOKEN;
      // One value, threaded to both: the reader hides the config directory's contents and the
      // writer refuses to write into it, and they must be deciding about the same directory.
      const configDir =
        this.env.VAULT_CONFIG_DIR !== undefined && this.env.VAULT_CONFIG_DIR !== ""
          ? this.env.VAULT_CONFIG_DIR
          : ".obsidian";
      this.#view = new VaultView({
        api: client(this.env.SYNC_TOKEN),
        writeApi: write === undefined || write === "" ? null : client(write),
        crypto,
        configDir,
      });
      this.#writer = new VaultWriter({
        view: this.#view,
        device: this.env.AGENT_DEVICE ?? "agent",
        configDir,
      });
    }
    return { view: this.#view, writer: this.#writer };
  }

  #index: SearchIndex | null = null;

  #searchIndex(): SearchIndex {
    this.#index ??= new SearchIndex(this.ctx.storage.sql);
    return this.#index;
  }

  /** Runs one tool call. Called over RPC from the Worker's MCP layer. */
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const { view } = await this.#ready();
    const ctx: ToolContext = {
      view,
      writable: view.writable,
      enqueue: (op) => this.#enqueue(op),
      index: this.#searchIndex(),
    };
    return callTool(name, args, ctx);
  }

  /** Drops the search index. It holds nothing that is not in R2, so this only costs a rebuild. */
  async dropIndex(): Promise<IndexStatus> {
    const index = this.#searchIndex();
    index.drop();
    return index.status();
  }

  async indexStatus(): Promise<IndexStatus> {
    return this.#searchIndex().status();
  }

  /**
   * The owner's standing instructions, or "" when the vault has none.
   *
   * Read through the **scoped** snapshot, so the shared exclude policy applies to it exactly
   * as it does to every other note: a hidden `AGENTS.md` is simply absent, and the agent never
   * gains a second, unfiltered way to read a path.
   *
   * It is bytes handed to the model, never parsed as configuration — it cannot un-hide a path,
   * widen scope or change a tool. Enforcement stays in the policy; prose stays advisory.
   */
  async instructions(): Promise<string> {
    const { view } = await this.#ready();
    const { files } = await view.snapshot();
    const entry = files[INSTRUCTIONS_NOTE];
    if (entry === undefined) return "";
    const bytes = await view.read(entry);
    // Binary here means somebody put something odd at that path; serving mojibake as standing
    // instructions is worse than having none.
    if (bytes.includes(0)) return "";
    return new TextDecoder().decode(bytes);
  }

  /** Which tools this deployment advertises. A read-only agent never mentions the write ones. */
  async writable(): Promise<boolean> {
    const { view } = await this.#ready();
    return view.writable;
  }

  /**
   * Adds one op to the open batch and resolves when that batch commits.
   *
   * The batch is captured *after* the debounce, so anything queued while the timer runs joins
   * it. `#flush` is cleared before the commit runs, so an op arriving during the commit opens
   * the next batch rather than joining one that has already been sealed.
   */
  async #enqueue(op: WriteOp): Promise<{ head: string; summary: string }> {
    const { writer } = await this.#ready();
    const index = this.#pending.push(op) - 1;
    const mine = this.#flush ??= (async () => {
      await new Promise((resolve) => setTimeout(resolve, WRITE_DEBOUNCE_MS));
      const batch = this.#pending;
      this.#pending = [];
      this.#flush = null;
      return writer.apply(batch);
    })();
    const outcome = await mine;
    return {
      head: outcome.head,
      summary: outcome.applied[index] ?? `applied ${outcome.applied.length} change(s)`,
    };
  }
}
