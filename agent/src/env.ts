import type { AgentState } from "./agent-state";

/**
 * Everything the agent Worker holds. All of it is secret except the sync URL.
 *
 * Note what is *not* here: no R2 binding and no access to the vault's storage. The agent
 * reaches the vault only through the sync Worker's public `/api/*`, as device N+1, which is
 * what keeps a bug in MCP handling incapable of touching commit serialisation.
 */
export interface AgentEnv {
  /** The vault master key, in the plugin's own text form. This is the custody trade. */
  VAULT_MASTER_KEY: string;
  /** Base URL of the sync Worker this agent is a device of. */
  SYNC_URL: string;
  /** Access token with the `read` scope. Never `sync`. */
  SYNC_TOKEN: string;
  /**
   * Access token with the `sync` scope, present only on a deployment meant to capture.
   * Absent means the write tools are not advertised and no object exists that could commit.
   */
  SYNC_WRITE_TOKEN?: string;
  /** Bearer the MCP client must present. Long, random, compared in constant time. */
  MCP_BEARER: string;
  /** Device name stamped on the agent's snapshots, so history shows who wrote them. */
  AGENT_DEVICE?: string;
  AGENT: DurableObjectNamespace<AgentState>;
}
