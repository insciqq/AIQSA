import { MCP_APPROVAL_CONTINUATION_KIND, type MessageSystemTurnKind } from "../../contracts/mcpApprovals";
import { connectorTurnRules, type ConnectorTurn, type ConnectorTurnRules } from "../connectors/turn";
import type { FrozenComputerBinding } from "../tools/computerBinding";
import type { ComputerRunOrigin } from "./computerAdmission";
import type { RunPreparationInput } from "./runPreparation";
import type { ScheduledOccurrenceAdmission } from "./runRepositoryContract";

/**
 * Where an admitted turn comes from and whose request it is, derived once at
 * admission from the server-only facts the entry point gives (the source and
 * its stored message, the connector or wake-up origin, the turn the server
 * wrote) and read by every decision preparation takes from them. The body
 * never reaches it. It is never stored: an accepted run keeps the decisions
 * it fed, not their inputs.
 *
 * Two facts are kept apart. Who wrote the current message's text
 * (`serverAuthoredInput`): a turn the server wrote is never the user's words,
 * so it carries no Deep research choice and the MCP guard never reads it as
 * theirs. And whether the turn is the user's own request (`userRequest`),
 * which only the user's own message in this turn makes it: the continuation
 * after the user's MCP Allow still is, while a sub-agent wake-up, a browser
 * sign-in request and an answer to a scheduled task's prompt, which the model
 * may have written, never are (`agent_docs/RUN_CONTRACTS.md`, Agent-initiated
 * changes).
 */
export type TurnProvenance = Readonly<{
  /** The scheduled task occurrence a send admits, from its server-only source; none for any other turn. */
  scheduledOccurrence: ScheduledOccurrenceAdmission | undefined;
  /**
   * Any answer to a scheduled task's prompt, which the model may have written: the occurrence itself or a regenerate
   * of the stored prompt, in its chat or a branch copy (`Message.scheduledTaskPrompt`).
   */
  scheduledPromptAnswer: boolean;
  /**
   * Such an answer reads Memory only while its task has Memory on: the occurrence by its own switch, a regenerate by
   * the task that posted the prompt (never in a branch copy).
   */
  scheduledMemoryRead: boolean;
  /** The connector whose turn this is, prepared under its rules whatever the body says; none on the web or for a wake-up. */
  connectorTurn: ConnectorTurn | undefined;
  /** That connector's rules (`connectorTurnRules`); null for a turn no connector admitted. */
  connector: ConnectorTurnRules | null;
  /** MCP runs unattended, with no approval or guard: a scheduled occurrence, or a connector whose rules say so. */
  unattendedMcp: boolean;
  /** Where the computer admission takes the message from (`computerAdmission.ts`). */
  computerOrigin: ComputerRunOrigin;
  /**
   * The computer of the run this turn repeats (a regenerate) or continues (the turn after an MCP Allow), null for none,
   * which the turn keeps whatever its request says; undefined for a new message or a regenerate whose message had no run.
   */
  frozenComputer: FrozenComputerBinding | null | undefined;
  /** The current message's text is the server's (an approval continuation, a sign-in request, a wake-up turn). */
  serverAuthoredInput: boolean;
  /** The MCP guard reads the current message as the user's words: only a send whose text the user wrote. */
  guardReadsCurrentMessage: boolean;
  /**
   * The turn the server wrote, as the regenerated message is stored or this send names it (`Message.systemTurnKind`),
   * `server_authored` for a server-written send that names none; undefined for the user's own message.
   */
  serverTurnKind: MessageSystemTurnKind | "server_authored" | undefined;
  /** No turn the server wrote, or the continuation after the user's MCP Allow, which goes on with the user's own turn. */
  userAuthoredTurn: boolean;
  /** The turn is the user's own request in this turn: user-authored, and no answer to a scheduled task's prompt. */
  userRequest: boolean;
  /** The approval whose Allow this send continues: what admits that exact call (`mcpApprovalAdmission`). */
  mcpApprovalId: string | undefined;
}>;

/** The turn's provenance (`TurnProvenance`), from the entry point's server-only facts alone. */
export function turnProvenance(input: Pick<RunPreparationInput, "mcpApprovalId" | "origin" | "serverAuthoredInput" | "source" |
  "systemTurnKind">): TurnProvenance {
  const source = input.source;
  const scheduledOccurrence = source.kind === "send" ? source.scheduledOccurrence : undefined;
  const scheduledPromptAnswer = scheduledOccurrence !== undefined ||
    (source.kind === "regenerate" && source.source.userMessage.scheduledTaskPrompt === true);
  const scheduledMemoryRead = scheduledOccurrence ? scheduledOccurrence.memory === true
    : source.kind === "regenerate" && source.source.userMessage.scheduledTaskMemory === true;
  const connectorTurn = input.origin === "wake_up" ? undefined : input.origin;
  const connector = connectorTurnRules(connectorTurn);
  const serverAuthoredInput = input.serverAuthoredInput === true;
  // A regenerate repeats an admitted run and the turn after an Allow continues one: each keeps that run's computer.
  const frozenComputer = source.kind === "regenerate" ? source.source.computer
    : source.approvalContinuation ? source.approvalContinuation.computer : undefined;
  // A regenerate reads what its stored message is; a send, what the server wrote for it.
  const serverTurnKind = source.kind === "regenerate"
    ? source.source.userMessage.systemTurnKind
    : serverAuthoredInput ? input.systemTurnKind ?? "server_authored" : undefined;
  const userAuthoredTurn = serverTurnKind === undefined || serverTurnKind === MCP_APPROVAL_CONTINUATION_KIND;
  return Object.freeze({
    computerOrigin: scheduledOccurrence ? "scheduled" : input.origin ?? "interactive",
    connector,
    connectorTurn,
    frozenComputer,
    guardReadsCurrentMessage: source.kind === "send" && !serverAuthoredInput,
    mcpApprovalId: input.mcpApprovalId,
    scheduledMemoryRead,
    scheduledOccurrence,
    scheduledPromptAnswer,
    serverAuthoredInput,
    serverTurnKind,
    unattendedMcp: scheduledOccurrence !== undefined || connector?.unattendedMcp === true,
    userAuthoredTurn,
    userRequest: userAuthoredTurn && !scheduledPromptAnswer
  });
}
