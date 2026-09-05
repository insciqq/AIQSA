import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { textMessageContent } from "../../domain/content";
import { estimateCostMicros, normalizeTokenUsage } from "../../domain/usage";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { resolveChatAccess } from "../projects/access";
import { notifyProjectEvent } from "../projects/events";
import { applyMemorySourceMutations, lockMemorySourceChat } from "../memory/sourceState";
import { defaultMemorySourceMutationHooks } from "../memory/sourceHooks";
import { scheduleTemporaryChatDeletion, temporaryRetentionDeadline } from "../memory/temporaryRetention";
import { MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } from "../../contracts/memory";
import { CHAT_SUMMARY_TIMEOUT_MS, ChatContinuationError, type ContinuationRepository, type ContinuationSource } from "./continuation";

const sourceSelect = {
  activeLeafMessageId: true, archived: true, defaultProviderModelId: true, folderId: true,
  id: true, memoryMode: true, permanentDeletionAt: true, projectFolderId: true, projectId: true,
  title: true, updatedAt: true, userId: true
} satisfies Prisma.ChatSelect;

async function lockedSource(tx: Prisma.TransactionClient, input: {
  chatId: string; userId: string; leafMessageId: string; updatedAt?: Date;
}) {
  const boundary = await tx.chat.findUnique({ select: { projectId: true }, where: { id: input.chatId } });
  if (boundary?.projectId) await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${boundary.projectId} FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "Chat" WHERE "id" = ${input.chatId} FOR UPDATE`;
  const access = await resolveChatAccess(tx, {
    chatId: input.chatId, userId: input.userId, requireMutable: true, minimumProjectRole: "CONTRIBUTOR"
  });
  const actor = await tx.user.findFirst({ select: { displayName: true }, where: { id: input.userId, status: "active" } });
  const chat = access ? await tx.chat.findUnique({ select: sourceSelect, where: { id: input.chatId } }) : null;
  if (!chat || !actor || chat.archived || chat.permanentDeletionAt) throw new ChatContinuationError("chat_not_found", 404);
  if (chat.activeLeafMessageId !== input.leafMessageId ||
    input.updatedAt && chat.updatedAt.getTime() !== input.updatedAt.getTime()) throw new ChatContinuationError("chat_changed");
  const active = await tx.modelRun.findFirst({ select: { id: true }, where: {
    chatId: chat.id, status: { in: ["queued", "preparing", "streaming", "in_progress"] }
  } });
  if (active) throw new ChatContinuationError("chat_busy");
  return { actor, chat, projectRole: access?.project?.effectiveRole ?? null };
}

function currentInput(source: ContinuationSource) {
  return { chatId: source.chatId, userId: source.userId, leafMessageId: source.leafMessageId, updatedAt: source.updatedAt };
}

export async function continuationSourceHref(client: PrismaClient, chatId: string, userId: string): Promise<string | null> {
  if (!await resolveChatAccess(client, { chatId, userId })) return null;
  const operation = await client.chatContinuation.findUnique({ where: { newChatId: chatId }, select: { sourceChatId: true } });
  if (!operation) return null;
  const source = await resolveChatAccess(client, { chatId: operation.sourceChatId, userId });
  if (!source) return null;
  const params = new URLSearchParams({ chat: operation.sourceChatId });
  if (source.project) params.set("project", source.project.projectId);
  return `/?${params}`;
}

export function createChatContinuationRepository(client: PrismaClient): ContinuationRepository {
  return {
    loadSource: (input) => client.$transaction(async (tx) => {
      const { chat } = await lockedSource(tx, { chatId: input.chatId, userId: input.userId, leafMessageId: input.expectedLeafMessageId });
      // First load only bounded graph metadata. Sibling contents, tools, files and Workspace are never read.
      const path = await tx.$queryRaw<Array<{ id: string; parentMessageId: string | null; bytes: number; role: string; status: string; depth: number }>>(Prisma.sql`
        WITH RECURSIVE branch AS (
          SELECT "id", "parentMessageId", octet_length("content"::text) AS bytes, "role", "status", 1 AS depth
          FROM "Message" WHERE "chatId" = ${chat.id} AND "id" = ${input.expectedLeafMessageId}
          UNION ALL
          SELECT m."id", m."parentMessageId", octet_length(m."content"::text), m."role", m."status", b.depth + 1
          FROM "Message" m JOIN branch b ON m."id" = b."parentMessageId"
          WHERE m."chatId" = ${chat.id} AND b.depth < 2001
        ) SELECT * FROM branch ORDER BY depth DESC
      `);
      if (!path.length || path.at(-1)?.role !== "assistant" || path.at(-1)?.status !== "complete") throw new ChatContinuationError("chat_changed");
      if (path[0]?.parentMessageId || path.length > 2000 || path.reduce((total, row) => total + row.bytes, 0) > 4 * 1024 * 1024) {
        throw new ChatContinuationError("chat_summary_too_large", 413);
      }
      const messages = await tx.message.findMany({ where: { chatId: chat.id, id: { in: path.map((row) => row.id) } }, select: { id: true, content: true } });
      const byId = new Map(messages.map((message) => {
        const content = message.content;
        const blocks = content && typeof content === "object" && !Array.isArray(content) && Array.isArray(content.blocks)
          ? content.blocks : [];
        return [message.id, textFromContentBlocks({ blocks })];
      }));
      const transcript = path.flatMap((row) => {
        const text = byId.get(row.id)?.trim();
        return text && (row.role === "user" || row.role === "assistant")
          ? [`${row.role.toUpperCase()}${row.status === "complete" ? "" : " (unfinished)"}:\n${text}`] : [];
      }).join("\n\n");
      if (!transcript) throw new ChatContinuationError("chat_changed");
      return { chatId: chat.id, leafMessageId: input.expectedLeafMessageId, projectId: chat.projectId, updatedAt: chat.updatedAt, userId: input.userId, transcript };
    }),

    claim: (source, requestId) => client.$transaction(async (tx) => {
      await lockedSource(tx, currentInput(source));
      const key = { sourceChatId: source.chatId, sourceMessageId: source.leafMessageId, snapshotUpdatedAt: source.updatedAt };
      const duplicateId = await tx.chatContinuation.findUnique({ where: { attemptId: requestId } });
      if (duplicateId && (duplicateId.sourceChatId !== source.chatId || duplicateId.sourceMessageId !== source.leafMessageId)) {
        throw new ChatContinuationError("chat_changed");
      }
      const existing = duplicateId ?? await tx.chatContinuation.findUnique({
        where: { sourceChatId_sourceMessageId_snapshotUpdatedAt: key }
      });
      if (existing?.status === "complete") {
        const access = existing.newChatId ? await resolveChatAccess(tx, { chatId: existing.newChatId, userId: source.userId }) : null;
        if (!access || !existing.newChatId) throw new ChatContinuationError("chat_not_found", 404);
        return { kind: "result", result: { status: "complete", chatId: existing.newChatId, projectId: access.project?.projectId ?? null } };
      }
      if (existing?.status === "running") {
        if (Date.now() - existing.updatedAt.getTime() <= CHAT_SUMMARY_TIMEOUT_MS + 60_000) {
          return { kind: "result", result: { status: "running" } };
        }
        // A stopped process has an unknown provider outcome. Only a fresh explicit attempt can retry.
        await tx.chatContinuation.update({ where: { id: existing.id }, data: { status: "failed", errorCode: "chat_summary_failed" } });
        return { kind: "failed" };
      }
      if (existing?.attemptId === requestId) throw new ChatContinuationError("chat_summary_failed", 502);
      const operation = existing
        ? await tx.chatContinuation.update({ where: { id: existing.id }, data: {
            actorUserId: source.userId, attemptId: requestId, errorCode: null, status: "running"
          } })
        : await tx.chatContinuation.create({ data: {
            ...key, actorUserId: source.userId, attemptId: requestId, status: "running"
          } });
      return { kind: "claimed", claim: { id: operation.id, attemptId: operation.attemptId } };
    }),

    async assertCurrent(source) {
      await client.$transaction((tx) => lockedSource(tx, currentInput(source)));
    },

    complete: async (source, claim, summary) => {
      const result = await client.$transaction(async (tx) => {
        const { actor, chat, projectRole } = await lockedSource(tx, currentInput(source));
        const operation = await tx.chatContinuation.findFirst({ where: {
          id: claim.id, attemptId: claim.attemptId, actorUserId: source.userId, status: "running"
        } });
        if (!operation) throw new ChatContinuationError("chat_changed");
        const newChatId = randomUUID();
        const requestMessageId = randomUUID();
        const messageId = randomUUID();
        const deadline = chat.memoryMode === "TEMPORARY" ? temporaryRetentionDeadline(new Date()) : null;
        await tx.chat.create({ data: {
          id: newChatId, title: `Continued: ${chat.title}`.slice(0, 120),
          defaultProviderModelId: chat.defaultProviderModelId, memoryMode: chat.memoryMode,
          ...(chat.projectId ? {
            userId: null, projectId: chat.projectId, projectFolderId: chat.projectFolderId,
            createdByUserId: source.userId, createdByDisplayName: actor.displayName
          } : { userId: source.userId, folderId: chat.folderId }),
          ...(deadline ? { temporaryRetentionDeadline: deadline, temporaryRetentionPolicyVersion: MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } : {})
        } });
        await tx.message.create({ data: {
          id: requestMessageId, chatId: newChatId, role: "user", status: "complete",
          content: textMessageContent("Continue from the conversation summary below."),
          ...(chat.projectId ? { authorUserId: source.userId, authorDisplayName: actor.displayName,
            authorProjectRole: projectRole } : {})
        } });
        await tx.message.create({ data: {
          id: messageId, parentMessageId: requestMessageId, chatId: newChatId, role: "assistant", status: "complete",
          content: textMessageContent(`Conversation summary\n\n${summary}`)
        } });
        if (chat.projectId) {
          await tx.chat.update({ where: { id: newChatId }, data: { activeLeafMessageId: messageId } });
          await tx.projectAuditEvent.create({ data: {
            projectId: chat.projectId, actorUserId: source.userId, actorDisplayName: actor.displayName,
            eventType: "project_chat_created", metadata: { chatId: newChatId }
          } });
        }
        else {
          const newChat = await lockMemorySourceChat(tx, { chatId: newChatId, lock: "UPDATE", userId: source.userId });
          if (!newChat) throw new ChatContinuationError("chat_summary_failed", 502);
          await applyMemorySourceMutations(tx, {
            chat: newChat, hooks: defaultMemorySourceMutationHooks, mutations: ["NORMAL_APPEND"], patch: { activeLeafMessageId: messageId }
          });
        }
        if (deadline) await scheduleTemporaryChatDeletion(tx, { chatId: newChatId, deadline, now: new Date(), userId: source.userId });
        const settled = await tx.chatContinuation.updateMany({ where: { id: claim.id, attemptId: claim.attemptId, status: "running" }, data: { status: "complete", newChatId, errorCode: null } });
        if (settled.count !== 1) throw new ChatContinuationError("chat_changed");
        return { status: "complete" as const, chatId: newChatId, projectId: chat.projectId };
      });
      if (result.projectId) notifyProjectEvent(result.projectId);
      return result;
    },

    async fail(claim, code) {
      await client.chatContinuation.updateMany({ where: { id: claim.id, attemptId: claim.attemptId, status: "running" }, data: { status: "failed", errorCode: code } });
    },

    async recordUsage({ claim, ordinal, source, provider, modelId, providerModelId, usage }) {
      const pricing = await client.providerModel.findUnique({ where: { id: providerModelId }, select: {
        inputTokenPriceMicros: true, outputTokenPriceMicros: true
      } });
      const data = {
        userId: source.userId, chatId: source.chatId, projectId: source.projectId, provider, modelId,
        inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null,
        reasoningTokens: usage.reasoningTokens ?? null, cachedInputTokens: usage.cachedInputTokens ?? null,
        cacheWriteInputTokens: usage.cacheWriteInputTokens ?? null, totalTokens: usage.totalTokens ?? null,
        estimatedCostMicros: pricing && (pricing.inputTokenPriceMicros > 0 || pricing.outputTokenPriceMicros > 0)
          ? estimateCostMicros(normalizeTokenUsage(usage), pricing) : null
      };
      await client.usageEvent.upsert({ where: { id: `chat-summary:${claim.id}:${claim.attemptId}:${ordinal}` },
        create: { ...data, id: `chat-summary:${claim.id}:${claim.attemptId}:${ordinal}` }, update: data });
    }
  };
}
