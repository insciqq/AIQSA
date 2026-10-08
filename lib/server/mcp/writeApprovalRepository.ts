import { Prisma, type PrismaClient } from "@prisma/client";
import {
  MCP_APPROVAL_CONTINUATION_KIND,
  type McpApprovalCard,
  type McpApprovalDecision,
  type McpApprovalSource,
  type McpApprovalState,
  type McpToolConsentWire
} from "@/lib/contracts/mcpApprovals";
import { resolveChatAccess } from "../projects/access";
import { MCP_APPROVAL_TTL_MS, type McpApprovalCallKey, type McpApprovalRequest } from "./writeApproval";

/**
 * Durable state of MCP write approval: the initiator's "Always allow"
 * consents, and one row per refused call that is both the card's request and,
 * once decided Allow once, the one-shot approval a later run of the same chat
 * consumes. Rows are content-free: digests and bounded display names.
 */
type ApprovalClient = Pick<Prisma.TransactionClient, "mcpToolApproval">;
type ConsentClient = Pick<Prisma.TransactionClient, "mcpToolConsent">;

/** The run that refuses or consumes, and the chat whose later runs an approval serves. */
export type McpApprovalScope = Readonly<{ chatId: string; runId: string; userId: string }>;

/** Unconsumed Allow once approvals of exactly this call, from another run of the chat. */
function availableWhere(scope: McpApprovalScope, key: McpApprovalCallKey, now: Date): Prisma.McpToolApprovalWhereInput {
  return {
    argumentsDigest: key.argumentsDigest,
    chatId: scope.chatId,
    consumedAt: null,
    decision: "allow_once",
    definitionHash: key.definitionHash,
    expiresAt: { gt: now },
    modelRunId: { not: scope.runId },
    serverId: key.serverId,
    toolName: key.toolName,
    userId: scope.userId
  };
}

export async function countAvailableMcpApprovals(
  client: ApprovalClient,
  scope: McpApprovalScope,
  key: McpApprovalCallKey,
  now = new Date()
): Promise<number> {
  return client.mcpToolApproval.count({ where: availableWhere(scope, key, now) });
}

/**
 * Consumes one approval of exactly this call for the scope's run: the oldest
 * decision first, one guarded winner per approval. False when none is left.
 */
export async function consumeMcpApproval(
  client: ApprovalClient,
  scope: McpApprovalScope,
  key: McpApprovalCallKey,
  now = new Date()
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = await client.mcpToolApproval.findFirst({
      orderBy: [{ decidedAt: "asc" }, { id: "asc" }],
      select: { id: true },
      where: availableWhere(scope, key, now)
    });
    if (!candidate) return false;
    const consumed = await client.mcpToolApproval.updateMany({
      data: { consumedAt: now, consumedByRunId: scope.runId },
      where: { consumedAt: null, decision: "allow_once", expiresAt: { gt: now }, id: candidate.id }
    });
    if (consumed.count === 1) return true;
  }
  return false;
}

/**
 * The run's pending request for this call. A repeated refused call of the
 * same server, tool, definition and arguments in the same run keeps the one
 * card it already has.
 */
export async function requestMcpApproval(
  client: ApprovalClient,
  scope: McpApprovalScope,
  request: McpApprovalRequest & Readonly<{ source: McpApprovalSource; toolCallId: string | null }>
): Promise<string> {
  const existing = await client.mcpToolApproval.findFirst({
    select: { id: true },
    where: {
      argumentsDigest: request.argumentsDigest,
      decision: null,
      definitionHash: request.definitionHash,
      modelRunId: scope.runId,
      serverId: request.serverId,
      toolName: request.toolName
    }
  });
  if (existing) return existing.id;
  const created = await client.mcpToolApproval.create({
    data: {
      argumentsDigest: request.argumentsDigest,
      chatId: scope.chatId,
      definitionHash: request.definitionHash,
      modelRunId: scope.runId,
      serverId: request.serverId,
      serverName: request.serverName,
      source: request.source,
      toolCallId: request.source === "code" ? null : request.toolCallId,
      toolName: request.toolName,
      toolTitle: request.toolTitle,
      userId: scope.userId
    },
    select: { id: true }
  });
  return created.id;
}

/** The servers among `serverIds` the user always allows: frozen into an interactive run's admission. */
export async function loadMcpToolConsentServerIds(
  client: ConsentClient,
  input: Readonly<{ serverIds: readonly string[]; userId: string }>
): Promise<string[]> {
  if (input.serverIds.length === 0) return [];
  const rows = await client.mcpToolConsent.findMany({
    select: { serverId: true },
    where: { serverId: { in: [...new Set(input.serverIds)] }, userId: input.userId }
  });
  return rows.map((row) => row.serverId).sort();
}

export async function listMcpToolConsents(
  client: Pick<PrismaClient, "mcpToolConsent">,
  userId: string
): Promise<McpToolConsentWire[]> {
  const rows = await client.mcpToolConsent.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { createdAt: true, server: { select: { displayName: true } }, serverId: true },
    take: 256,
    where: { userId }
  });
  return rows.map((row) => ({ createdAt: row.createdAt.toISOString(), serverId: row.serverId,
    serverName: row.server.displayName }));
}

/** Revocation applies to runs admitted after it: accepted runs keep their frozen consent. */
export async function revokeMcpToolConsent(
  client: Pick<PrismaClient, "mcpToolConsent">,
  input: Readonly<{ serverId: string; userId: string }>
): Promise<boolean> {
  const deleted = await client.mcpToolConsent.deleteMany({ where: { serverId: input.serverId, userId: input.userId } });
  return deleted.count > 0;
}

/** The card fields every reader of a run selects. */
export const mcpApprovalCardSelect = {
  consumedAt: true,
  decidedAt: true,
  decision: true,
  id: true,
  // A continuation turn already answering the run's answer spends Continue.
  modelRun: { select: { assistantMessage: { select: { children: {
    select: { id: true }, take: 1, where: { systemTurnKind: MCP_APPROVAL_CONTINUATION_KIND }
  } } } } },
  serverName: true,
  source: true,
  toolCall: { select: { ordinal: true, roundIndex: true } },
  toolTitle: true
} satisfies Prisma.McpToolApprovalSelect;

export type McpApprovalCardRow = Prisma.McpToolApprovalGetPayload<{ select: typeof mcpApprovalCardSelect }>;

function cardState(decision: McpApprovalCardRow["decision"]): McpApprovalState {
  return decision === "allow_once" ? "allowed_once" : decision === "allow_server" ? "allowed_server"
    : decision === "deny" ? "denied" : "pending";
}

/**
 * An Allow whose continuation may still start: exactly while the send
 * handler accepts it (`loadMcpApprovalContinuation`: unconsumed, decided
 * within the approval window) and no continuation turn answers the run's
 * answer yet.
 */
function continuable(row: McpApprovalCardRow, now: Date): boolean {
  return (row.decision === "allow_once" || row.decision === "allow_server") && row.consumedAt === null &&
    row.decidedAt !== null && row.decidedAt.getTime() > now.getTime() - MCP_APPROVAL_TTL_MS &&
    (row.modelRun.assistantMessage?.children.length ?? 0) === 0;
}

/**
 * The cards of one run as a reader sees them. Only the initiator may decide,
 * continue after an Allow and expand the refused call's redacted request;
 * Project members see the card read-only. A branch copy of an answer shows
 * them read-only too.
 */
export function projectMcpApprovalCards(
  rows: readonly McpApprovalCardRow[],
  input: Readonly<{ initiator: boolean; now?: Date }>
): McpApprovalCard[] {
  const now = input.now ?? new Date();
  return rows.slice(0, 16).map((row) => ({
    approvalId: row.id,
    ...(input.initiator && continuable(row, now) ? { canContinue: true as const } : {}),
    ...(input.initiator && row.decision === null ? { canDecide: true as const } : {}),
    ...(input.initiator && row.source === "model" && row.toolCall && row.toolCall.roundIndex > 0
      ? { details: { ordinal: row.toolCall.ordinal, roundIndex: row.toolCall.roundIndex } } : {}),
    serverName: row.serverName,
    source: row.source,
    state: cardState(row.decision),
    toolName: row.toolTitle
  }));
}

export type McpApprovalDecisionOutcome =
  | Readonly<{ kind: "decided"; card: McpApprovalCard; continuation: boolean }>
  /** Already decided otherwise: the card as it is. */
  | Readonly<{ kind: "conflict"; card: McpApprovalCard }>
  /** The run is still working; its answer must settle first. */
  | Readonly<{ kind: "run_active" }>
  | Readonly<{ kind: "not_found" }>;

const TERMINAL_RUN_STATUSES = new Set(["cancelled", "complete", "error"]);

/**
 * The initiator's decision on one card, nonce-idempotent: the same nonce and
 * decision replay the stored outcome, any other decision of a decided card
 * conflicts. Allow once writes the one-shot approval (`expiresAt`), Always
 * allow the server consent; Deny only records the card's state. Others' and
 * missing cards look alike.
 */
export async function decideMcpApproval(
  prisma: PrismaClient,
  input: Readonly<{ approvalId: string; decision: McpApprovalDecision; nonce: string; runId: string; userId: string }>,
  now = new Date()
): Promise<McpApprovalDecisionOutcome> {
  return prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "McpToolApproval"
      WHERE "id" = ${input.approvalId} AND "modelRunId" = ${input.runId} AND "userId" = ${input.userId}
      FOR UPDATE
    `);
    if (!locked) return { kind: "not_found" as const };
    const row = await tx.mcpToolApproval.findUniqueOrThrow({
      select: { ...mcpApprovalCardSelect, chatId: true, decisionNonce: true,
        modelRun: { select: { ...mcpApprovalCardSelect.modelRun.select, answerCompletedAt: true, status: true } },
        serverId: true },
      where: { id: input.approvalId }
    });
    const access = await resolveChatAccess(tx, { chatId: row.chatId, minimumProjectRole: "CONTRIBUTOR",
      requireMutable: true, userId: input.userId });
    if (!access) return { kind: "not_found" as const };
    const card = (current: McpApprovalCardRow) => projectMcpApprovalCards([current], { initiator: true, now })[0]!;
    if (row.decision !== null) {
      return row.decision === input.decision && row.decisionNonce === input.nonce
        ? { card: card(row), continuation: row.decision !== "deny", kind: "decided" as const }
        : { card: card(row), kind: "conflict" as const };
    }
    // A published answer whose Workspace still settles counts as settled.
    if (!TERMINAL_RUN_STATUSES.has(row.modelRun.status) && row.modelRun.answerCompletedAt === null) {
      return { kind: "run_active" as const };
    }
    const decided = await tx.mcpToolApproval.update({
      data: {
        decidedAt: now,
        decision: input.decision,
        decisionNonce: input.nonce,
        ...(input.decision === "allow_once" ? { expiresAt: new Date(now.getTime() + MCP_APPROVAL_TTL_MS) } : {})
      },
      select: mcpApprovalCardSelect,
      where: { id: input.approvalId }
    });
    if (input.decision === "allow_server") {
      await tx.mcpToolConsent.upsert({
        create: { serverId: row.serverId, userId: input.userId },
        update: {},
        where: { userId_serverId: { serverId: row.serverId, userId: input.userId } }
      });
    }
    return { card: card(decided), continuation: input.decision !== "deny", kind: "decided" as const };
  });
}

/**
 * The approval a continuation turn names, while it may still continue: the
 * initiator's own Allow in this chat, decided within the approval window and
 * not yet used by a run.
 */
export async function loadMcpApprovalContinuation(
  client: Pick<PrismaClient, "mcpToolApproval">,
  input: Readonly<{ approvalId: string; chatId: string; userId: string }>,
  now = new Date()
): Promise<Readonly<{ serverName: string; toolName: string }> | null> {
  const row = await client.mcpToolApproval.findFirst({
    select: { serverName: true, toolTitle: true },
    where: { chatId: input.chatId, consumedAt: null, decidedAt: { gt: new Date(now.getTime() - MCP_APPROVAL_TTL_MS) },
      decision: { in: ["allow_once", "allow_server"] }, id: input.approvalId, userId: input.userId }
  });
  return row ? { serverName: row.serverName, toolName: row.toolTitle } : null;
}

/** Cards of one run created after the newest the caller already emitted (live streaming). */
export async function loadRunMcpApprovalCards(
  client: Pick<PrismaClient, "mcpToolApproval">,
  input: Readonly<{ runId: string; userId: string }>
): Promise<McpApprovalCard[]> {
  const rows = await client.mcpToolApproval.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: mcpApprovalCardSelect,
    take: 16,
    where: { modelRunId: input.runId, userId: input.userId }
  });
  return projectMcpApprovalCards(rows, { initiator: true });
}
