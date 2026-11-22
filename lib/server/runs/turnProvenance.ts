import type { Prisma } from "@prisma/client";
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
 * which only the user's own message in this turn makes it: a sub-agent
 * wake-up, a browser sign-in request and an answer to a scheduled task's
 * prompt, which the model may have written, never are
 * (`agent_docs/RUN_CONTRACTS.md`, Agent-initiated changes). The continuation
 * after an MCP Allow has the authority of the turn whose call the user
 * allowed, as admission found it (`storedUserRequest`): it goes on with the
 * user's own request, and with nothing more after a wake-up's or a sign-in
 * request's, since the Allow authorizes that one call alone.
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
  /**
   * No turn the server wrote, or the continuation after an MCP Allow of a turn that was the user's own request, which
   * goes on with it (`storedUserRequest`).
   */
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
  // The turn after an Allow goes on with the authority of the turn whose call the user allowed, which admission read from
  // the approval (a send) or the stored chain (a regenerate); nothing that says so is no request of the user's.
  const continuesUserRequest = source.kind === "regenerate" ? source.source.userMessage.continuesUserRequest === true
    : source.approvalContinuation?.userRequest === true;
  const userAuthoredTurn = !serverTurnKind || (serverTurnKind === MCP_APPROVAL_CONTINUATION_KIND && continuesUserRequest);
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

/** How many continuations of continuations a stored turn is followed back through; a longer chain is no request of the user's. */
export const CONTINUATION_CHAIN_LIMIT = 32;

/**
 * `TurnProvenance.userRequest` as a stored user message shows it, for the checks a change makes again as it commits (the
 * self-service fence, the memory note's service, a scheduled task's creation and management, a Skill save) and for a
 * regenerate's admission: a turn the server wrote (`Message.systemTurnKind`) or an answer to a scheduled task's prompt
 * is never the user's own request, and a missing message fails closed.
 *
 * The continuation after an MCP Allow has the authority of the turn whose call the user allowed, followed back
 * through a continuation of a continuation to the first turn: its first run names the Allow it continues
 * (`NormalizedRunRequest.mcpApproval.approvedBy`, which admission freezes on every continuation), the Allow names the
 * run it gated (`McpToolApproval.modelRunId`), and that run its own message. A regenerate shares the message, so it
 * reads the same chain. A link that is missing (a branch copy, whose messages have no runs of their own) or a chain past
 * `CONTINUATION_CHAIN_LIMIT` fails closed.
 */
export async function storedUserRequest(db: Pick<Prisma.TransactionClient, "$queryRaw">,
  input: Readonly<{ messageId: string; userId: string }>): Promise<boolean> {
  const turns = await db.$queryRaw<Array<{ scheduledTaskPrompt: boolean; systemTurnKind: string | null }>>`
    WITH RECURSIVE "turn" AS (
      SELECT m."id", m."chatId", m."systemTurnKind"::text AS "systemTurnKind", m."scheduledTaskPrompt", 0 AS "depth"
      FROM "Message" m
      WHERE m."id" = ${input.messageId} AND m."role" = 'user'
      UNION ALL
      SELECT gated."id", gated."chatId", gated."systemTurnKind"::text, gated."scheduledTaskPrompt", t."depth" + 1
      FROM "turn" t
      JOIN "McpToolApproval" a ON a."userId" = ${input.userId} AND a."chatId" = t."chatId" AND a."id" = (
        SELECT r."normalizedRequest" -> 'mcpApproval' ->> 'approvedBy'
        FROM "ModelRun" r
        WHERE r."userMessageId" = t."id" AND r."chatId" = t."chatId" AND r."userId" = ${input.userId}
          AND r."subagentTurnId" IS NULL AND (r."normalizedRequest" -> 'mcpApproval' ->> 'approvedBy') IS NOT NULL
        ORDER BY r."createdAt" ASC, r."id" ASC
        LIMIT 1)
      JOIN "ModelRun" g ON g."id" = a."modelRunId"
      JOIN "Message" gated ON gated."id" = g."userMessageId"
      WHERE t."systemTurnKind" = ${MCP_APPROVAL_CONTINUATION_KIND} AND t."depth" < CAST(${CONTINUATION_CHAIN_LIMIT} AS integer)
    )
    SELECT "systemTurnKind", "scheduledTaskPrompt" FROM "turn" ORDER BY "depth" ASC`;
  return storedChainUserRequest(turns);
}

/**
 * The user's own request as a stored chain reads, the current turn first: every turn of it no scheduled task's prompt,
 * every turn but the last an Allow's continuation, and the last the user's own message. A chain that ends on a
 * continuation lost its link or its bound.
 */
export function storedChainUserRequest(turns: readonly Readonly<{ scheduledTaskPrompt: boolean | null;
  systemTurnKind: string | null }>[]): boolean {
  const origin = turns.at(-1);
  return origin !== undefined && origin.systemTurnKind === null && turns.every((turn, index) => turn.scheduledTaskPrompt === false &&
    (index === turns.length - 1 || turn.systemTurnKind === MCP_APPROVAL_CONTINUATION_KIND));
}
