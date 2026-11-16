/**
 * A connector turn: a message a chat connector (Telegram, Discord) admits
 * through the ordinary send handler, in process, as its user. The run stack
 * carries which connector it was (`RunHandlerDeps.connectorTurn`, the run
 * preparation's `origin`, the engine's `connectorTurn`), and the server
 * decides every rule below from it, whatever the request body says.
 *
 * Every connector turn starts no background sub-agents (it answers and stops
 * those of its branch), and never gets Deep research, the user's computer or
 * the live browser. Every connector turn has the Workspace like a web chat
 * whenever the installation offers it, with no switch (operator decisions
 * 2026-11-16, `connectorWorkspaceRequest`); nobody can take its browser over
 * from Telegram or Discord, so `browser_handoff` says what blocked the agent
 * there (`lib/server/tools/browserHandoff.ts`). A Telegram turn takes the
 * self-service tools, Skill saves and sub-agent management its chat takes on
 * the web, shown as messages with Undo, Confirm and Cancel (operator decision
 * 2026-11-16, `lib/server/telegram/changes/`); a Discord turn takes none
 * (`selfServiceToolsFor`). Its service account stands for every thread, so its
 * runs bind no saved secrets and save no browser sign-in back to the account:
 * what one thread signs in to stays in that thread's Workspace
 * (`lib/server/workspace/secrets/store.ts`). What differs by connector is in
 * `connectorTurnRules`.
 */

import type { WorkspaceNotRequestedReason } from "../../contracts/workspace";

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
  regenerate: "discord_regenerate_unavailable"
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
  /** The user's per-user message limits are checked and recorded; budgets and the installation cap apply either way (D-12e). */
  messageLimits: boolean;
  /** The automation tools (create and manage scheduled tasks) may be offered. */
  automations: boolean;
  /** A fixed note for the model, frozen with the chat's system prompt at admission. */
  note: string | null;
}>;

const RULES: Readonly<Record<ConnectorTurn, ConnectorTurnRules>> = Object.freeze({
  // Telegram turns are the linked user's interactive personal runs (`agent_docs/RUN_CONTRACTS.md`).
  telegram: Object.freeze({ automations: true, memory: true, messageLimits: true, note: null, unattendedMcp: false }),
  // Discord turns are runs of the installation's service account for a Discord thread (owner decisions 2026-11-12).
  discord: Object.freeze({
    automations: false, memory: false, messageLimits: false, note: DISCORD_CONNECTOR_NOTE, unattendedMcp: true
  })
});

/** The rules of a connector turn; null for a run no connector admitted. */
export function connectorTurnRules(turn: ConnectorTurn | undefined): ConnectorTurnRules | null {
  return turn ? RULES[turn] : null;
}

/**
 * The Workspace intent a connector turn sends: always, as the web composer asks
 * for it (operator decisions 2026-10-20 and 2026-11-16), except on an
 * installation that does not offer it now or with a model that calls no tools,
 * which name why for the content-free `run_accepted` record. An Assistant
 * chat's model must call tools, so its turns pass `toolCalling` true.
 */
export function connectorWorkspaceRequest(
  offered: boolean, toolCalling: boolean
): Readonly<{ enabled: true }> | Readonly<{ enabled: false; reason: WorkspaceNotRequestedReason }> {
  if (!offered) return { enabled: false, reason: "installation_disabled" };
  if (!toolCalling) return { enabled: false, reason: "model_no_tools" };
  return { enabled: true };
}
