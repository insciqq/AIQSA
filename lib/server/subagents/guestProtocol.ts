import { BROWSER_BUSY_CODE, BROWSER_MEMORY_LOW_CODE, SUBAGENT_LIMITS, normalizeSubagentName } from "../../contracts/subagents";

/**
 * The Workspace guest's agent protocol, mirrored from
 * `ops/workspace-guest/python/aiqsa/agents.py`, which explains it;
 * `guestProtocol.test.ts` keeps the two equal. Owners: the agent id in the
 * exec environment and the release request are the browser lease task's
 * (`20261029221039219-browser-agent-lease`), the live messages the browser
 * panel task's (`20261029221054145-browser-multi-agent`).
 */
export const WORKSPACE_AGENT_PROTOCOL = Object.freeze({
  AGENT_ID_ENV: "AIQSA_AGENT_ID",
  AGENT_NAME_ENV: "AIQSA_AGENT_NAME",
  MAIN_AGENT_ID: "main",
  AGENT_ID_PATTERN: "^[A-Za-z0-9_-]{1,64}$",
  AGENT_NAME_MAX_CHARS: SUBAGENT_LIMITS.nameCharacters,
  BROWSER_AGENT_SLOTS: 5,
  BROWSER_BUSY_CODE,
  BROWSER_MEMORY_LOW_CODE,
  BROWSER_RELEASE_COMMAND: "release",
  LIVE_PER_AGENT_PROTOCOL: 2,
  LIVE_AGENT_FIELD: "agent",
  LIVE_AGENTS_MESSAGE: "agents",
  LIVE_AGENTS_FIELD: "agents",
  LIVE_SELECT_MESSAGE: "select"
} as const);

/** The agent a Workspace command runs for. */
export type WorkspaceAgent =
  | Readonly<{ kind: "main" }>
  | Readonly<{ kind: "subagent"; name: string; threadId: string }>;

const AGENT_ID = new RegExp(WORKSPACE_AGENT_PROTOCOL.AGENT_ID_PATTERN, "u");

/**
 * The environment values every Workspace command of this agent carries, set
 * by the server over anything the command's own environment holds. Throws on
 * an id or name the protocol cannot carry: the server builds both, so that is
 * a defect, never input to bound.
 */
export function workspaceAgentEnvironment(agent: WorkspaceAgent): Readonly<Record<string, string>> {
  if (agent.kind === "main") return { [WORKSPACE_AGENT_PROTOCOL.AGENT_ID_ENV]: WORKSPACE_AGENT_PROTOCOL.MAIN_AGENT_ID };
  if (!AGENT_ID.test(agent.threadId) || agent.threadId === WORKSPACE_AGENT_PROTOCOL.MAIN_AGENT_ID ||
    normalizeSubagentName(agent.name) !== agent.name) throw new Error("workspace_agent_identity_invalid");
  return { [WORKSPACE_AGENT_PROTOCOL.AGENT_ID_ENV]: agent.threadId, [WORKSPACE_AGENT_PROTOCOL.AGENT_NAME_ENV]: agent.name };
}

/** The browser agent id of a Workspace agent: `main` or the thread id. */
export function workspaceAgentId(agent: WorkspaceAgent): string {
  return agent.kind === "main" ? WORKSPACE_AGENT_PROTOCOL.MAIN_AGENT_ID : agent.threadId;
}
