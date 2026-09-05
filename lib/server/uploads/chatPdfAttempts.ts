import { Prisma, type PrismaClient } from "@prisma/client";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import { estimateCostMicros, normalizeTokenUsage } from "../../domain/usage";
import { ChatPdfPreparationError } from "./chatPdfCore";
import { assertChatPdfClaim, chatPdfJson, type ChatPdfClaim } from "./chatPdfPersistence";

export type ChatPdfAttemptWork = Readonly<{
  page: number;
  preparationId: string;
  requestDigest: string;
  workKey: string;
}>;

export type ChatPdfDispatch = Readonly<{
  attemptId: string;
  usageEventId: string;
}>;

export function createChatPdfAttempts(prisma: PrismaClient) {
  return {
    async reserve(claim: ChatPdfClaim, work: ChatPdfAttemptWork): Promise<Readonly<
      | { kind: "reserved"; attemptId: string }
      | { kind: "settled"; resultArtifactId: string }
      | { kind: "ambiguous" }
    >> {
      return prisma.$transaction(async (tx) => {
        await assertChatPdfClaim(tx, claim);
        const preparation = await tx.chatPdfAttachmentPreparation.findFirstOrThrow({
          where: { id: work.preparationId, modelRunId: claim.runId, state: "preparing" }
        });
        const existing = await tx.chatPdfPageAttempt.findUnique({ where: {
          preparationId_page: { preparationId: work.preparationId, page: work.page }
        } });
        if (existing) {
          if (existing.requestDigest !== work.requestDigest || existing.workKey !== work.workKey) {
            throw new ChatPdfPreparationError("pdf_preparation_invalid");
          }
          if (existing.state === "settled" && existing.resultArtifactId && !existing.errorCode) {
            return { kind: "settled", resultArtifactId: existing.resultArtifactId };
          }
          if (existing.state === "reserved") return { kind: "reserved", attemptId: existing.id };
          if (existing.state === "dispatched") await tx.chatPdfPageAttempt.update({
            data: { state: "ambiguous", errorCode: "pdf_preparation_ambiguous" }, where: { id: existing.id }
          });
          return { kind: "ambiguous" };
        }
        const settled = await tx.chatPdfPageAttempt.findFirst({ where: {
          page: work.page, requestDigest: work.requestDigest, workKey: work.workKey,
          errorCode: null, state: "settled", resultArtifact: { state: "ready" },
          preparation: { attachmentId: preparation.attachmentId,
            compatibilityKey: preparation.compatibilityKey, sourceChecksum: preparation.sourceChecksum }
        }, orderBy: { createdAt: "desc" } });
        if (settled?.resultArtifactId) {
          await tx.chatPdfPageAttempt.create({ data: {
            ...work, state: "settled", resultArtifactId: settled.resultArtifactId,
            reusedFromAttemptId: settled.id, settledAt: new Date()
          } });
          return { kind: "settled", resultArtifactId: settled.resultArtifactId };
        }
        const created = await tx.chatPdfPageAttempt.create({ data: work });
        return { kind: "reserved", attemptId: created.id };
      });
    },

    async dispatch(claim: ChatPdfClaim, attemptId: string): Promise<ChatPdfDispatch> {
      return prisma.$transaction(async (tx) => {
        await assertChatPdfClaim(tx, claim);
        const attempt = await tx.chatPdfPageAttempt.findFirstOrThrow({ where: {
          id: attemptId, state: "reserved", preparation: { modelRunId: claim.runId, state: "preparing" }
        }, include: { preparation: { include: { modelRun: { include: {
          chat: { select: { projectId: true } }
        } } } } } });
        const snapshot = attempt.preparation.bindingSnapshot as Prisma.JsonObject;
        const model = snapshot.model as Prisma.JsonObject;
        const changed = await tx.chatPdfPageAttempt.updateMany({
          where: { id: attemptId, state: "reserved" }, data: { state: "dispatched", dispatchedAt: new Date() }
        });
        if (changed.count !== 1) throw new ChatPdfPreparationError("pdf_preparation_ambiguous", true);
        // Persist a chargeable, unknown-usage receipt before I/O. A crash or
        // artifact cleanup can detach the attempt without erasing its receipt.
        // Owning-chat/account deletion still follows its ordinary retention policy.
        // Null token/cost values mean unreported, never estimated token counts.
        const usage = await tx.usageEvent.create({ data: {
          chatId: attempt.preparation.modelRun.chatId,
          chatPdfPageAttemptId: attemptId,
          chatPdfPreparation: true,
          modelId: String(model.upstreamModelId), modelRunId: claim.runId,
          projectId: attempt.preparation.modelRun.chat.projectId,
          provider: String(snapshot.providerFamily),
          providerModelId: attempt.preparation.providerModelId,
          userId: claim.userId
        } });
        return { attemptId, usageEventId: usage.id };
      });
    },

    async ambiguous(dispatch: ChatPdfDispatch, errorCode: "pdf_preparation_ambiguous" | "pdf_transcription_failed" = "pdf_preparation_ambiguous"): Promise<void> {
      await prisma.chatPdfPageAttempt.updateMany({ where: { id: dispatch.attemptId, state: "dispatched" },
        data: { state: "ambiguous", errorCode } });
    },

    async recordUsage(dispatch: ChatPdfDispatch, reported: ModelRunUsage): Promise<void> {
      await prisma.$transaction(async (tx) => {
        const [event] = await tx.$queryRaw<Array<{
          id: string; inputTokens: number | null; providerModelId: string | null;
        }>>(Prisma.sql`
          SELECT "id", "inputTokens", "providerModelId" FROM "UsageEvent"
          WHERE "id" = ${dispatch.usageEventId} FOR UPDATE
        `);
        // Aggregate deletion owns removal of its accounting rows. If only the
        // attachment was deleted, replace the detached receipt's nulls once
        // without reviving any run or document.
        if (!event) return;
        const normalized = normalizeTokenUsage(reported);
        // Ordinary adapters use an all-zero result when usage is absent. A
        // non-empty page transcription cannot establish a zero-token charge.
        if (normalized.totalTokens === 0) return;
        const pricing = event.providerModelId ? await tx.providerModel.findUnique({
          where: { id: event.providerModelId },
          select: { inputTokenPriceMicros: true, outputTokenPriceMicros: true }
        }) : null;
        const estimatedCostMicros = pricing &&
          (pricing.inputTokenPriceMicros > 0 || pricing.outputTokenPriceMicros > 0)
          ? estimateCostMicros(normalized, pricing) : null;
        const usage = { ...normalized, estimatedCostMicros };
        if (event.inputTokens === null) await tx.usageEvent.update({
          where: { id: event.id }, data: usage
        });
      });
    },

    async settle(dispatch: ChatPdfDispatch, input: Readonly<{
      errorCode?: "pdf_preparation_invalid" | "pdf_transcription_failed";
      resultArtifactId: string | null;
      usage: ModelRunUsage;
    }>): Promise<void> {
      await prisma.$transaction(async (tx) => {
        const attempt = await tx.chatPdfPageAttempt.findUnique({ where: { id: dispatch.attemptId } });
        if (!attempt || attempt.state === "settled") return;
        if (attempt.state !== "dispatched" && attempt.state !== "ambiguous") {
          throw new ChatPdfPreparationError("pdf_preparation_invalid");
        }
        await tx.chatPdfPageAttempt.update({ where: { id: dispatch.attemptId }, data: {
          errorCode: input.errorCode ?? null, resultArtifactId: input.resultArtifactId,
          settledAt: new Date(), state: "settled", usage: chatPdfJson(input.usage)
        } });
      });
    },

    async list(preparationId: string) {
      return prisma.chatPdfPageAttempt.findMany({ where: { preparationId }, orderBy: { page: "asc" } });
    }
  };
}
