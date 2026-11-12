import { Prisma, type DiscordReply, type PrismaClient } from "@prisma/client";
import { retainDatabaseFailure } from "../../observability/databaseFailure";

/**
 * One row per Discord question (PRD D-25, D-28). Inserting it is the claim
 * that keeps a question to one answer: a repeated gateway event, a replay
 * after RESUME and the overlap of two containers during an upgrade all meet
 * the same primary key, so exactly one claim wins. The row is also the
 * content-free journal: who and where (ids and a display name), stages,
 * outcome and run totals, never message text.
 */

export type DiscordReplyKind = "answer" | "follow_up" | "refused";
export type DiscordReplyState = "claimed" | "admitted" | "delivered" | "failed" | "interrupted" | "unknown";
export type DiscordLimitKind = "author" | "thread" | "key";
export type DiscordMcpTotals = Readonly<Record<string, Readonly<{ calls: number; errors: number }>>>;

export type DiscordReplyClaim = Readonly<{
  questionMessageId: string;
  guildId: string | null;
  channelId: string;
  discordUserId: string;
  /** A display snapshot (nick, global name or username), at most 100 characters; never logged. */
  authorName: string;
  conversationId?: string | null;
  kind?: DiscordReplyKind;
  test: boolean;
  receivedAt: Date;
  expectedLeafId?: string | null;
}>;

export type DiscordReplyRecord = Readonly<{
  questionMessageId: string;
  conversationId: string | null;
  guildId: string | null;
  channelId: string;
  discordUserId: string;
  authorName: string;
  kind: DiscordReplyKind;
  state: DiscordReplyState;
  test: boolean;
  runId: string | null;
  expectedLeafId: string | null;
  /** A new chat's id, set once before the send: every attempt, live or recovered, admits into this chat. */
  plannedChatId: string | null;
  statusMessageId: string | null;
  answerMessageId: string | null;
  code: string | null;
  failureKind: string | null;
  limitKind: DiscordLimitKind | null;
  receivedAt: Date;
  ackAt: Date | null;
  admittedAt: Date | null;
  firstStatusAt: Date | null;
  deliveredAt: Date | null;
  /** When an attempt claimed the question's one send (`claimSend`); another attempt never sends. */
  sendClaimedAt: Date | null;
  mcpByServer: DiscordMcpTotals | null;
  compactions: number | null;
  subagents: number | null;
  sources: number | null;
}>;

/** Fields a later stage sets; `null` clears a field, an absent key keeps it. */
export type DiscordReplyPatch = Partial<Readonly<{
  conversationId: string | null;
  kind: DiscordReplyKind;
  state: DiscordReplyState;
  runId: string | null;
  expectedLeafId: string | null;
  plannedChatId: string | null;
  statusMessageId: string | null;
  answerMessageId: string | null;
  code: string | null;
  failureKind: string | null;
  limitKind: DiscordLimitKind | null;
  ackAt: Date | null;
  admittedAt: Date | null;
  firstStatusAt: Date | null;
  deliveredAt: Date | null;
  mcpByServer: DiscordMcpTotals | null;
  compactions: number | null;
  subagents: number | null;
  sources: number | null;
}>>;

export type DiscordReplyStore = Readonly<{
  /** Claims the question; `duplicate` when any process claimed it before. */
  claim(input: DiscordReplyClaim): Promise<"claimed" | "duplicate">;
  find(questionMessageId: string): Promise<DiscordReplyRecord | null>;
  /** The question an AIQSA answer message answers (ratings, deletes of the answer). */
  findByAnswerMessage(answerMessageId: string): Promise<DiscordReplyRecord | null>;
  /** Applies the patch only while the row is in one of `whenState` (any state when absent); false when nothing changed. */
  update(questionMessageId: string, patch: DiscordReplyPatch, whenState?: readonly DiscordReplyState[]): Promise<boolean>;
  /** Questions still `claimed` or `admitted` that arrived before `before`, oldest first, for recovery. */
  listUnsettled(input: Readonly<{ before: Date; limit: number }>): Promise<DiscordReplyRecord[]>;
  /**
   * Fixes the question's admission target once and reads it back: a new chat's planned id, or the existing chat's
   * expected leaf, is written only while unset, so every attempt (live or recovered, in any process) admits the same
   * way. Null when the question is no longer `claimed`.
   */
  fixAdmissionTarget(questionMessageId: string, target: Readonly<{ plannedChatId: string }> | Readonly<{ expectedLeafId: string | null }>):
    Promise<DiscordReplyRecord | null>;
  /** Claims the question's one send right before it; true for the one attempt (across processes) that may send. */
  claimSend(questionMessageId: string, at: Date): Promise<boolean>;
}>;

type ReplyClient = Pick<PrismaClient, "discordReply">;

function snowflake(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

function optionalSnowflake(value: string | null | undefined): bigint | null | undefined {
  return value === undefined ? undefined : value === null ? null : BigInt(value);
}

function mcpTotals(value: Prisma.JsonValue | null): DiscordMcpTotals | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const totals: Record<string, { calls: number; errors: number }> = {};
  for (const [serverId, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const calls = (entry as Record<string, unknown>).calls;
    const errors = (entry as Record<string, unknown>).errors;
    if (Number.isSafeInteger(calls) && Number.isSafeInteger(errors)) totals[serverId] = { calls: calls as number, errors: errors as number };
  }
  return totals;
}

export function discordReplyRecord(row: DiscordReply): DiscordReplyRecord {
  return {
    ackAt: row.ackAt,
    admittedAt: row.admittedAt,
    answerMessageId: snowflake(row.answerMessageId),
    authorName: row.authorName,
    channelId: row.channelId.toString(),
    code: row.code,
    compactions: row.compactions,
    conversationId: row.conversationId,
    deliveredAt: row.deliveredAt,
    discordUserId: row.discordUserId.toString(),
    expectedLeafId: row.expectedLeafId,
    failureKind: row.failureKind,
    firstStatusAt: row.firstStatusAt,
    guildId: snowflake(row.guildId),
    kind: row.kind,
    limitKind: row.limitKind,
    mcpByServer: mcpTotals(row.mcpByServer),
    plannedChatId: row.plannedChatId,
    questionMessageId: row.questionMessageId.toString(),
    receivedAt: row.receivedAt,
    runId: row.runId,
    sendClaimedAt: row.sendClaimedAt,
    sources: row.sources,
    state: row.state,
    statusMessageId: snowflake(row.statusMessageId),
    subagents: row.subagents,
    test: row.test
  };
}

/** Display names are bounded snapshots; an empty one keeps the row valid. */
export function discordAuthorNameSnapshot(name: string): string {
  const trimmed = name.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 100);
  return trimmed || "Discord user";
}

function patchData(patch: DiscordReplyPatch): Prisma.DiscordReplyUncheckedUpdateManyInput {
  const data: Prisma.DiscordReplyUncheckedUpdateManyInput = {};
  if (patch.conversationId !== undefined) data.conversationId = patch.conversationId;
  if (patch.kind !== undefined) data.kind = patch.kind;
  if (patch.state !== undefined) data.state = patch.state;
  if (patch.runId !== undefined) data.runId = patch.runId;
  if (patch.expectedLeafId !== undefined) data.expectedLeafId = patch.expectedLeafId;
  if (patch.plannedChatId !== undefined) data.plannedChatId = patch.plannedChatId;
  if (patch.statusMessageId !== undefined) data.statusMessageId = optionalSnowflake(patch.statusMessageId);
  if (patch.answerMessageId !== undefined) data.answerMessageId = optionalSnowflake(patch.answerMessageId);
  if (patch.code !== undefined) data.code = patch.code === null ? null : patch.code.slice(0, 80);
  if (patch.failureKind !== undefined) data.failureKind = patch.failureKind === null ? null : patch.failureKind.slice(0, 32);
  if (patch.limitKind !== undefined) data.limitKind = patch.limitKind;
  if (patch.ackAt !== undefined) data.ackAt = patch.ackAt;
  if (patch.admittedAt !== undefined) data.admittedAt = patch.admittedAt;
  if (patch.firstStatusAt !== undefined) data.firstStatusAt = patch.firstStatusAt;
  if (patch.deliveredAt !== undefined) data.deliveredAt = patch.deliveredAt;
  if (patch.mcpByServer !== undefined) data.mcpByServer = patch.mcpByServer === null ? Prisma.DbNull : { ...patch.mcpByServer };
  if (patch.compactions !== undefined) data.compactions = patch.compactions;
  if (patch.subagents !== undefined) data.subagents = patch.subagents;
  if (patch.sources !== undefined) data.sources = patch.sources;
  return data;
}

export function createPrismaDiscordReplyStore(prisma: ReplyClient): DiscordReplyStore {
  return Object.freeze({
    async claim(input) {
      const created = await prisma.discordReply.createMany({
        data: [{
          authorName: discordAuthorNameSnapshot(input.authorName),
          channelId: BigInt(input.channelId),
          conversationId: input.conversationId ?? null,
          discordUserId: BigInt(input.discordUserId),
          expectedLeafId: input.expectedLeafId ?? null,
          guildId: input.guildId === null ? null : BigInt(input.guildId),
          kind: input.kind ?? "answer",
          questionMessageId: BigInt(input.questionMessageId),
          receivedAt: input.receivedAt,
          test: input.test
        }],
        skipDuplicates: true
      }).catch(retainDatabaseFailure);
      return created.count === 1 ? "claimed" : "duplicate";
    },

    async find(questionMessageId) {
      const row = await prisma.discordReply.findUnique({ where: { questionMessageId: BigInt(questionMessageId) } })
        .catch(retainDatabaseFailure);
      return row ? discordReplyRecord(row) : null;
    },

    async findByAnswerMessage(answerMessageId) {
      const row = await prisma.discordReply.findFirst({ where: { answerMessageId: BigInt(answerMessageId) } })
        .catch(retainDatabaseFailure);
      return row ? discordReplyRecord(row) : null;
    },

    async update(questionMessageId, patch, whenState) {
      const data = patchData(patch);
      if (Object.keys(data).length === 0) return false;
      const updated = await prisma.discordReply.updateMany({
        data,
        where: { questionMessageId: BigInt(questionMessageId), ...(whenState ? { state: { in: [...whenState] } } : {}) }
      }).catch(retainDatabaseFailure);
      return updated.count === 1;
    },

    async listUnsettled(input) {
      const rows = await prisma.discordReply.findMany({
        orderBy: { receivedAt: "asc" },
        take: Math.max(1, Math.min(input.limit, 500)),
        where: { receivedAt: { lt: input.before }, state: { in: ["claimed", "admitted"] } }
      }).catch(retainDatabaseFailure);
      return rows.map(discordReplyRecord);
    },

    async fixAdmissionTarget(questionMessageId, target) {
      const id = BigInt(questionMessageId);
      if ("plannedChatId" in target) {
        await prisma.discordReply.updateMany({
          data: { plannedChatId: target.plannedChatId }, where: { plannedChatId: null, questionMessageId: id, state: "claimed" }
        }).catch(retainDatabaseFailure);
      } else if (target.expectedLeafId !== null) {
        await prisma.discordReply.updateMany({
          data: { expectedLeafId: target.expectedLeafId }, where: { expectedLeafId: null, questionMessageId: id, state: "claimed" }
        }).catch(retainDatabaseFailure);
      }
      const row = await prisma.discordReply.findUnique({ where: { questionMessageId: id } }).catch(retainDatabaseFailure);
      return row && row.state === "claimed" ? discordReplyRecord(row) : null;
    },

    async claimSend(questionMessageId, at) {
      const updated = await prisma.discordReply.updateMany({
        data: { sendClaimedAt: at },
        where: { questionMessageId: BigInt(questionMessageId), runId: null, sendClaimedAt: null, state: "claimed" }
      }).catch(retainDatabaseFailure);
      return updated.count === 1;
    }
  });
}
