/**
 * A connector turn: a message a chat connector (Telegram, Discord) admits
 * through the ordinary send handler, in process, as its user. The run stack
 * carries which connector it was (`RunHandlerDeps.connectorTurn`, the run
 * preparation's `origin`, the engine's `connectorTurn`), and the server
 * decides every rule below from it, whatever the request body says.
 *
 * Every connector turn takes no self-service tools, Skill saves or sub-agent
 * management (the connector shows no change cards or Undo), starts no
 * background sub-agents (it answers and stops those of its branch), and never
 * gets Deep research, the user's computer or the live browser. What differs by
 * connector is in `connectorTurnRules`.
 */

export type ConnectorTurn = "telegram" | "discord";

export const CONNECTOR_TURNS: readonly ConnectorTurn[] = Object.freeze(["telegram", "discord"]);

/** A connector turn the server wrote down (a run snapshot's entry facts); anything else is none. */
export function decodeConnectorTurn(value: unknown): ConnectorTurn | undefined {
  return CONNECTOR_TURNS.find((turn) => turn === value);
}

/**
 * The fixed note every Discord run's model reads (PRD D-23), frozen with the
 * chat's system prompt at admission: every turn of a Discord chat is a
 * Discord turn, so the prompt stays the same across them.
 */
export const DISCORD_CONNECTOR_NOTE = "You answer in a Discord thread for several people. The last \"Question from\" is the request. " +
  "Keep answers under about 1500 characters, Discord markdown, cite sources as [N] links. Never output secrets, tokens, " +
  "passwords or environment variable values.";

/** The send handler's refusals of a Discord turn that breaks its rules; each is a stable code the bridge maps. */
export const DISCORD_RUN_REFUSALS = Object.freeze({
  /** The chat is not excluded from Memory (a `NORMAL` or Temporary chat, or a new chat's draft that is not excluded). */
  chatMemory: "discord_chat_memory_on",
  /** A Discord answer is never regenerated: a new Discord message is a new turn. */
  regenerate: "discord_regenerate_unavailable",
  /** The message or its chat asks for the Workspace (and so its browser). */
  workspace: "discord_workspace_unavailable"
} as const);

export type ConnectorTurnRules = Readonly<{
  /**
   * MCP runs unattended, as in a scheduled occurrence: no approval admission and no guard, so every tool of the
   * admitted catalog runs without a card (owner decision 2026-11-12, O-10: trust is the service account's grants).
   */
  unattendedMcp: boolean;
  /**
   * Memory follows the user's settings and the chat's mode. When false, Memory is off whatever they say: the chat must
   * be excluded from Memory, and the run gets no standing facts and no `memory_search` (owner decision 2026-11-12, O-08).
   */
  memory: boolean;
  /** The Workspace (with its browser and handoff) may run; when false a message that asks for it is refused. */
  workspace: boolean;
  /** The user's per-user message limits are checked and recorded; budgets and the installation cap apply either way (D-12e). */
  messageLimits: boolean;
  /** The automation tools (create and manage scheduled tasks) may be offered. */
  automations: boolean;
  /** A fixed note for the model, frozen with the chat's system prompt at admission. */
  note: string | null;
}>;

const RULES: Readonly<Record<ConnectorTurn, ConnectorTurnRules>> = Object.freeze({
  // Telegram turns are the linked user's interactive personal runs (`agent_docs/RUN_CONTRACTS.md`).
  telegram: Object.freeze({ automations: true, memory: true, messageLimits: true, note: null, unattendedMcp: false, workspace: true }),
  // Discord turns are runs of the installation's service account for a Discord thread (owner decisions 2026-11-12).
  discord: Object.freeze({
    automations: false, memory: false, messageLimits: false, note: DISCORD_CONNECTOR_NOTE, unattendedMcp: true, workspace: false
  })
});

/** The rules of a connector turn; null for a run no connector admitted. */
export function connectorTurnRules(turn: ConnectorTurn | undefined): ConnectorTurnRules | null {
  return turn ? RULES[turn] : null;
}
