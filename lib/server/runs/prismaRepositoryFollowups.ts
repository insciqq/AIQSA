import { Prisma, type PrismaClient } from "@prisma/client";
import { decodeRunFollowupInput, RUN_FOLLOWUP_MAX_COUNT, RUN_FOLLOWUP_MAX_TOTAL_CHARS } from "../../contracts/runFollowups";
import { textMessageContent } from "../../domain/content";
import { loadEntitlementsForUser } from "../auth/dbEntitlements";
import { validateRunAccess } from "../auth/entitlements";
import { resolveChatAccess, resolveProjectAccess } from "../projects/access";
import { activeModelRunStatuses, json, lockRunSettlementScope } from "./prismaRepositoryShared";
import { followupTokenCost, projectMessageFollowups, projectRunFollowups, type RunFollowupOperations } from "./runFollowups";
import { ActiveLeafConflictError, type PreparingRunAdmissionInput } from "./runRepositoryContract";
import { takeUtf16SafePrefix } from "../../domain/utf16";

export function admittedFollowupFields(input: PreparingRunAdmissionInput) {
  if (!input.followupAdmission) return {};
  const budget = input.followupAdmission.budgetTokens;
  if (!Number.isSafeInteger(budget) ||
    budget < 0 || budget > 8_192 || (input.normalizedRequest.followupContextReserveTokens ?? 0) < budget) {
    throw new ActiveLeafConflictError();
  }
  return { followupMode: input.normalizedRequest.agent ? "agent" : input.normalizedRequest.workspace?.enabled ? "workspace" : "chat", followupBudgetTokens: budget };
}

export async function insertAdmittedRunFollowups(tx: Prisma.TransactionClient, input: PreparingRunAdmissionInput, runId: string) {
  const inherited = input.followupAdmission?.inherited;
  if (!inherited) return;
  if (input.admissionKind !== "REGENERATE" || !input.preSendAssistantMessageId) throw new ActiveLeafConflictError();
  if (inherited.messageId !== input.preSendAssistantMessageId) throw new ActiveLeafConflictError();
  const source = await tx.message.findFirst({ where: { id: inherited.messageId, chatId: input.chatId, role: "assistant",
    status: { notIn: ["streaming", "queued"] } }, select: messageFollowupSelect });
  const snapshot = source && projectMessageFollowups(source);
  if (!snapshot || snapshot.entries.length !== inherited.revision) throw new ActiveLeafConflictError();
  for (const entry of snapshot.entries) await tx.runFollowup.create({ data: {
    chatId: input.chatId, modelRunId: runId, ordinal: entry.ordinal, nonce: `regeneration-${entry.ordinal}`,
    text: entry.text, authorName: entry.author, createdAt: new Date(entry.createdAt)
  } });
  await tx.modelRun.update({ where: { id: runId }, data: { followupRevision: inherited.revision } });
}

export const runFollowupSelect = {
  followupMode: true, followupClosedAt: true,
  followups: { orderBy: { ordinal: "asc" }, select: {
    id: true, ordinal: true, text: true, authorName: true, createdAt: true, deliveredAt: true, precedingText: true
  } }
} satisfies Prisma.ModelRunSelect;

export const messageFollowupSelect = {
  branchFollowups: true,
  assistantModelRuns: { orderBy: { createdAt: "desc" }, take: 1, select: {
    ...runFollowupSelect, status: true, answerCompletedAt: true
  } }
} satisfies Prisma.MessageSelect;

async function lockRun(tx: Prisma.TransactionClient, runId: string): Promise<void> {
  await lockRunSettlementScope(tx, runId);
  await tx.$queryRaw`SELECT "id" FROM "ModelRun" WHERE "id" = ${runId} FOR UPDATE`;
}

/** All mutations share admission/terminal lock order: principal, chat, run. */
export function createPrismaRunFollowupOperations(db: PrismaClient): RunFollowupOperations {
  return {
    accept: async input => {
      const decoded = decodeRunFollowupInput({ chatId: input.chatId, assistantMessageId: input.assistantMessageId,
        nonce: input.nonce, text: input.text });
      if (!decoded) return { kind: "conflict" };
      return db.$transaction(async tx => {
        await lockRun(tx, input.runId);
        const run = await tx.modelRun.findUnique({ where: { id: input.runId }, include: {
          chat: { select: { activeLeafMessageId: true, archived: true } },
          projectRunBinding: true,
          providerRunBindings: { where: { bindingKey: "answer" } },
          followups: { orderBy: { ordinal: "asc" } }
        } });
        if (!run || run.chatId !== input.chatId || run.assistantMessageId !== input.assistantMessageId) return { kind: "not_found" };
        const actor = await tx.user.findFirst({ where: { id: input.userId, status: "active" }, select: { displayName: true } });
        const access = actor && await resolveChatAccess(tx, { chatId: run.chatId, userId: input.userId,
          minimumProjectRole: "CONTRIBUTOR", requireMutable: true });
        if (!actor || !access) return { kind: "not_found" };
        const previous = run.followups.find(entry => entry.nonce === input.nonce);
        if (previous) {
          if (previous.authorUserId !== input.userId || previous.text !== decoded.text) return { kind: "conflict" };
          return { kind: "accepted", entry: projectRunFollowups({ ...run, followups: [previous] }).entries[0]! };
        }
        if (!run.followupMode || run.followupClosedAt || run.answerCompletedAt || !activeModelRunStatuses.includes(run.status) ||
          run.chat.archived || run.chat.activeLeafMessageId !== run.assistantMessageId) return { kind: "closed" };
        const binding = run.providerRunBindings[0];
        if (access.kind === "project") {
          const accepted = run.projectRunBinding;
          const ownerAccess = accepted && await resolveProjectAccess(tx, { projectId: accepted.projectId,
            minimumRole: "CONTRIBUTOR", requireActive: true, userId: run.userId });
          if (!accepted || !ownerAccess || ownerAccess.accessRevision !== accepted.accessRevision ||
            ownerAccess.instructionsRevision !== accepted.instructionsRevision || ownerAccess.memoryRevision !== accepted.memoryRevision ||
            ownerAccess.policyRevision !== accepted.policyRevision) return { kind: "closed" };
        } else {
          const entitlement = await loadEntitlementsForUser(input.userId, tx);
          if (!validateRunAccess(entitlement, { provider: binding?.connectionId ?? run.provider,
            modelId: binding?.providerModelId ?? run.modelId }).ok) return { kind: "closed" };
        }
        const cost = followupTokenCost(decoded.text);
        if (run.followupRevision >= RUN_FOLLOWUP_MAX_COUNT || cost > run.followupBudgetTokens ||
          run.followups.reduce((sum, entry) => sum + entry.text.length, decoded.text.length) > RUN_FOLLOWUP_MAX_TOTAL_CHARS) {
          return { kind: "context_full" };
        }
        const entry = await tx.runFollowup.create({ data: { chatId: run.chatId, modelRunId: run.id,
          ordinal: run.followupRevision + 1, nonce: input.nonce, text: decoded.text,
          authorUserId: input.userId, authorName: takeUtf16SafePrefix(actor.displayName, 256) } });
        await tx.modelRun.update({ where: { id: run.id }, data: {
          followupRevision: { increment: 1 }, followupBudgetTokens: { decrement: cost }
        } });
        return { kind: "accepted", entry: projectRunFollowups({ ...run, followups: [entry] }).entries[0]! };
      });
    },
    load: async input => {
      const run = await db.modelRun.findFirst({ where: { id: input.runId, userId: input.userId }, select: {
        ...runFollowupSelect, answerCompletedAt: true, status: true, followupRevision: true
      } });
      return run && run.followupMode ? { revision: run.followupRevision, entries: projectRunFollowups(run).entries } : null;
    },
    deliver: input => db.$transaction(async tx => {
      await lockRun(tx, input.runId);
      const run = await tx.modelRun.findFirst({ where: { id: input.runId, userId: input.userId,
        status: { in: activeModelRunStatuses }, answerCompletedAt: null, followupClosedAt: null,
        followupMode: input.confirmedThrough ? "agent" : { not: null },
        followupRevision: input.confirmedThrough ? { gte: input.revision } : input.revision },
        select: { assistantMessageId: true, followupBudgetTokens: true,
          followups: { where: { deliveredAt: null, ordinal: { lte: input.revision } }, orderBy: { ordinal: "asc" } } } });
      if (!run) return false;
      const first = run.followups[0];
      if (first) {
        await tx.runFollowup.update({ where: { id: first.id }, data: {
          deliveredAt: new Date(), ...(input.precedingText ? { precedingText: input.precedingText } : {})
        } });
        await tx.runFollowup.updateMany({ where: { modelRunId: input.runId, deliveredAt: null, ordinal: { lte: input.revision } }, data: { deliveredAt: new Date() } });
        if (run.assistantMessageId) await tx.message.update({ where: { id: run.assistantMessageId },
          data: { content: json(textMessageContent("")), status: "streaming" } });
      }
      await tx.modelRun.update({ where: { id: input.runId }, data: {
        followupBudgetTokens: Math.max(0, Math.floor(input.confirmedThrough
          ? Math.min(run.followupBudgetTokens, input.budgetTokens) : input.budgetTokens)),
        ...(first ? { providerResponseId: null } : {})
      } });
      return true;
    }),
    beginKnowledge: input => db.$transaction(async tx => {
      await lockRun(tx, input.runId);
      const run = await tx.modelRun.findFirst({ where: { id: input.runId, userId: input.userId,
        status: { in: activeModelRunStatuses }, answerCompletedAt: null, followupClosedAt: null,
        followupRevision: input.revision }, select: {
        followupMode: true, followupKnowledgeOffset: true, followupKnowledgeRevision: true
      } });
      if (!run) throw new Error("followup_execution_closed");
      if (!run.followupMode || run.followupKnowledgeRevision === input.revision) return run.followupKnowledgeOffset;
      const latest = await tx.knowledgeProviderAttempt.aggregate({ where: { modelRunId: input.runId }, _max: { ordinal: true } });
      const offset = latest._max.ordinal ?? 0;
      if (offset >= 8) throw new Error("knowledge_answer_operation_budget_exceeded");
      await tx.modelRun.update({ where: { id: input.runId }, data: {
        followupKnowledgeRevision: input.revision, followupKnowledgeOffset: offset
      } });
      return offset;
    }),
    close: input => db.$transaction(async tx => {
      await lockRun(tx, input.runId);
      const result = await tx.modelRun.updateMany({ where: { id: input.runId, userId: input.userId,
        status: { in: activeModelRunStatuses }, answerCompletedAt: null, followupMode: { not: null },
        followupRevision: input.revision, followups: { none: { deliveredAt: null } } }, data: { followupClosedAt: new Date() } });
      return result.count === 1;
    })
  };
}

/** Old executors cannot complete a task after a newer clarification was accepted. */
export async function runFollowupsAllowCompletion(tx: Prisma.TransactionClient, runId: string, revision = 0): Promise<boolean> {
  const run = await tx.modelRun.findUnique({ where: { id: runId }, select: {
    followupMode: true, followupRevision: true, followupClosedAt: true,
    followups: { where: { deliveredAt: null }, select: { id: true }, take: 1 }
  } });
  return Boolean(run && (run.followupMode === null || run.followupRevision === revision &&
    (revision === 0 || run.followupClosedAt !== null) && run.followups.length === 0));
}
