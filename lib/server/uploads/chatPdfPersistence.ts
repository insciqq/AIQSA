import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { ChatPdfRoute } from "../../contracts/chatPdfPreparation";
import type { ProviderAdmissionRole } from "../providerRuntime/admission";
import { normalizeProviderExecutionSnapshot } from "../providers/runtimeFactory";
import type { SearchProbeBinding } from "../search/probeBinding";
import { type ChatPdfAttachmentAdmission, chatPdfFingerprint, createChatPdfRouteResolver } from "./chatPdfAdmission";
import { CHAT_PDF_ARTIFACT_MAX_BYTES, ChatPdfPreparationError, chatPdfCompatibilityKey, type ChatPdfWorkPlan } from "./chatPdfCore";

export const CHAT_PDF_CLAIM_LEASE_MS = 5 * 60_000;
export const CHAT_PDF_HEARTBEAT_MS = 10_000;

export type ChatPdfClaim = Readonly<{
  claimToken: string;
  runId: string;
  userId: string;
}>;

export function chatPdfJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function assertChatPdfClaim(tx: Prisma.TransactionClient, claim: ChatPdfClaim): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT job."modelRunId" AS "id" FROM "ChatPdfRunPreparation" job
    JOIN "ModelRun" r ON r."id" = job."modelRunId"
    JOIN "Chat" c ON c."id" = r."chatId"
    JOIN "User" u ON u."id" = r."userId"
    WHERE job."modelRunId" = ${claim.runId} AND job."claimToken" = ${claim.claimToken}
      AND job."state" IN ('pending', 'preparing', 'answer_ready')
      AND r."status" IN ('preparing', 'streaming') AND r."userId" = ${claim.userId}
      AND c."permanentDeletionAt" IS NULL AND NOT c."archived" AND u."status" = 'active'
      AND (c."temporaryRetentionDeadline" IS NULL OR c."temporaryRetentionDeadline" > CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
    FOR UPDATE OF job
  `);
  if (rows.length !== 1) throw new ChatPdfPreparationError("pdf_preparation_unavailable");
}

/** Called in Phase A after the originals and provider bindings are linked. */
export async function insertChatPdfAdmissions(tx: Prisma.TransactionClient, input: Readonly<{
  admissions: readonly ChatPdfAttachmentAdmission[];
  answer: ProviderAdmissionRole;
  deferred?: Readonly<{ admissionKey: string; snapshot: unknown }>;
  runId: string;
}>): Promise<void> {
  if (!input.admissions.length) return;
  const current = await createChatPdfRouteResolver(tx).resolve(input.answer);
  const deferred = input.admissions.some(({ route }) => route !== "direct_pdf");
  if (deferred !== Boolean(input.deferred)) throw new ChatPdfPreparationError("pdf_preparation_invalid");
  for (const admitted of input.admissions) {
    const { attachmentId: _attachmentId, byteSize: _byteSize, pageCount: _pageCount,
      sourceChecksum: _sourceChecksum, ...route } = admitted;
    void _attachmentId; void _byteSize; void _pageCount; void _sourceChecksum;
    if (chatPdfFingerprint(route) !== chatPdfFingerprint(current)) {
      throw new ChatPdfPreparationError("pdf_preparation_unavailable", true);
    }
    await tx.chatPdfAttachmentPreparation.create({ data: {
      attachmentId: admitted.attachmentId,
      bindingAuthority: admitted.authority ? chatPdfJson(admitted.authority) : Prisma.DbNull,
      bindingSnapshot: admitted.snapshot ? chatPdfJson(admitted.snapshot) : Prisma.DbNull,
      compatibilityKey: chatPdfCompatibilityKey(admitted),
      credentialVersionId: admitted.snapshot?.credentialVersionId ?? null,
      modelRunId: input.runId, pageCount: admitted.pageCount,
      completedPages: admitted.route === "direct_pdf" ? admitted.pageCount ?? 0 : 0,
      policyVersion: admitted.policyVersion,
      providerModelId: admitted.snapshot?.providerModelId ?? null,
      route: admitted.route, sourceByteSize: admitted.byteSize, sourceChecksum: admitted.sourceChecksum,
      state: admitted.route === "direct_pdf" ? "ready" : "checking"
    } });
  }
  if (input.deferred) {
    if (Buffer.byteLength(JSON.stringify(input.deferred.snapshot)) > CHAT_PDF_ARTIFACT_MAX_BYTES) {
      throw new ChatPdfPreparationError("pdf_preparation_invalid");
    }
    await tx.chatPdfRunPreparation.create({ data: {
      admissionKey: input.deferred.admissionKey, modelRunId: input.runId,
      snapshot: chatPdfJson(input.deferred.snapshot)
    } });
  }
}

export async function storeChatPdfAdmissionResult(tx: Prisma.TransactionClient, runId: string, result: unknown) {
  await tx.chatPdfRunPreparation.update({
    data: { admissionResult: chatPdfJson(result) }, where: { modelRunId: runId }
  });
}

export function chatPdfAdmissionFromRow(row: Readonly<{
  attachmentId: string; bindingAuthority: unknown; bindingSnapshot: unknown; pageCount: number | null;
  policyVersion: number | null; route: string; sourceByteSize: number; sourceChecksum: string;
}>): ChatPdfAttachmentAdmission {
  return { attachmentId: row.attachmentId,
    authority: row.bindingAuthority as SearchProbeBinding | null,
    byteSize: row.sourceByteSize, pageCount: row.pageCount, policyVersion: row.policyVersion,
    route: row.route as ChatPdfRoute,
    snapshot: row.bindingSnapshot ? normalizeProviderExecutionSnapshot(row.bindingSnapshot) : null,
    sourceChecksum: row.sourceChecksum.trim() };
}

export function createChatPdfRepository(prisma: PrismaClient) {
  return {
    async cleanupAbandonedArtifacts(now = new Date()): Promise<void> {
      const cutoff = new Date(now.getTime() - CHAT_PDF_CLAIM_LEASE_MS);
      await prisma.$executeRaw(Prisma.sql`
        DELETE FROM "ChatPdfArtifact" WHERE "id" IN (
          SELECT a."id" FROM "ChatPdfArtifact" a WHERE a."createdAt" < (${cutoff}::timestamptz AT TIME ZONE 'UTC')
            AND NOT EXISTS (SELECT 1 FROM "ChatPdfAttachmentPreparation" p
              WHERE p."localArtifactId" = a."id" OR p."documentArtifactId" = a."id")
            AND NOT EXISTS (SELECT 1 FROM "ChatPdfPageAttempt" p WHERE p."resultArtifactId" = a."id")
            AND NOT EXISTS (SELECT 1 FROM "ChatPdfRunPreparation" j
              WHERE j."modelRunId" = a."preparationGeneration" AND j."state" IN ('pending','preparing','answer_ready')
                AND j."claimToken" IS NOT NULL AND j."claimedAt" >= (${cutoff}::timestamptz AT TIME ZONE 'UTC'))
          ORDER BY a."createdAt", a."id" LIMIT 25 FOR UPDATE SKIP LOCKED
        )
      `);
    },
    async claim(now = new Date()): Promise<ChatPdfClaim | null> {
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ modelRunId: string; userId: string }>>(Prisma.sql`
          SELECT job."modelRunId", r."userId" FROM "ChatPdfRunPreparation" job
          JOIN "ModelRun" r ON r."id" = job."modelRunId"
          WHERE job."state" IN ('pending', 'preparing', 'answer_ready')
            AND r."status" IN ('preparing', 'streaming')
            AND (job."claimedAt" IS NULL OR job."claimedAt" <
              (${new Date(now.getTime() - CHAT_PDF_CLAIM_LEASE_MS)}::timestamptz AT TIME ZONE 'UTC'))
          ORDER BY job."lastWorkedAt", job."modelRunId"
          LIMIT 1 FOR UPDATE OF job SKIP LOCKED
        `);
        const row = rows[0];
        if (!row) return null;
        const claimToken = randomUUID();
        await tx.chatPdfRunPreparation.update({ where: { modelRunId: row.modelRunId }, data: {
          claimToken, claimedAt: now, lastWorkedAt: now
        } });
        return { claimToken, runId: row.modelRunId, userId: row.userId };
      });
    },

    async heartbeat(claim: ChatPdfClaim, now = new Date()): Promise<boolean> {
      const updated = await prisma.chatPdfRunPreparation.updateMany({
        data: { claimedAt: now }, where: { modelRunId: claim.runId, claimToken: claim.claimToken,
          state: { in: ["pending", "preparing", "answer_ready"] } }
      });
      return updated.count === 1;
    },

    async release(claim: ChatPdfClaim): Promise<void> {
      await prisma.chatPdfRunPreparation.updateMany({ where: {
        modelRunId: claim.runId, claimToken: claim.claimToken,
        state: { in: ["pending", "preparing", "answer_ready"] }
      }, data: { claimToken: null, claimedAt: null, lastWorkedAt: new Date() } });
    },

    async load(claim: ChatPdfClaim) {
      return prisma.$transaction(async (tx) => {
        await assertChatPdfClaim(tx, claim);
        return tx.chatPdfRunPreparation.findUniqueOrThrow({
          where: { modelRunId: claim.runId }, include: { modelRun: { include: {
            chat: { select: { projectId: true } },
            workspaceRunBinding: { select: { modelRunId: true } },
            chatPdfAttachments: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: {
              attachment: { select: { storageKey: true } }
            } }
          } } }
        });
      });
    },

    async pageCount(claim: ChatPdfClaim, preparationId: string, count: number): Promise<void> {
      await prisma.$transaction(async (tx) => {
        await assertChatPdfClaim(tx, claim);
        const row = await tx.chatPdfAttachmentPreparation.findFirstOrThrow({
          where: { id: preparationId, modelRunId: claim.runId }
        });
        if (row.pageCount !== null && row.pageCount !== count) {
          throw new ChatPdfPreparationError("pdf_preparation_invalid");
        }
        if (row.pageCount === null) await tx.chatPdfAttachmentPreparation.update({
          data: { pageCount: count }, where: { id: row.id }
        });
        await tx.$executeRaw(Prisma.sql`
          UPDATE "Attachment" SET "metadata" = jsonb_set(COALESCE("metadata", '{}'::jsonb),
            '{pdfPageCount}', to_jsonb(${count}::int), true)
          WHERE "id" = ${row.attachmentId} AND "checksum" = ${row.sourceChecksum}
        `);
      });
    },

    async reserveArtifact(claim: ChatPdfClaim, input: Readonly<{
      admission: ChatPdfAttachmentAdmission; byteSize: number; checksum: string;
      kind: "local" | "page" | "document"; pageCount: number;
    }>) {
      return prisma.$transaction(async (tx) => {
        await assertChatPdfClaim(tx, claim);
        const id = randomUUID();
        return tx.chatPdfArtifact.create({ data: {
          attachmentId: input.admission.attachmentId, byteSize: input.byteSize, checksum: input.checksum,
          id, kind: input.kind, pageCount: input.pageCount, preparationGeneration: claim.runId,
          route: input.admission.route, sourceChecksum: input.admission.sourceChecksum,
          storageKey: `chat-pdf/${input.admission.attachmentId}/${claim.runId}/${id}.json`
        } });
      });
    },

    async acceptArtifact(claim: ChatPdfClaim, artifactId: string): Promise<boolean> {
      return prisma.$transaction(async (tx) => {
        await assertChatPdfClaim(tx, claim);
        const updated = await tx.chatPdfArtifact.updateMany({ where: {
          id: artifactId, preparationGeneration: claim.runId, state: "reserved"
        }, data: { state: "ready" } });
        return updated.count === 1;
      });
    },

    async readArtifact(id: string, attachmentId: string) {
      const row = await prisma.chatPdfArtifact.findFirst({ where: { id, attachmentId, state: "ready" } });
      if (!row) throw new ChatPdfPreparationError("pdf_preparation_invalid");
      return row;
    },

    async abandonArtifact(id: string, storageKey: string): Promise<void> {
      await prisma.$transaction(async (tx) => {
        await tx.chatPdfArtifact.deleteMany({ where: { id, state: "reserved" } });
        await tx.attachmentDeletionJob.upsert({ where: { storageKey }, update: {}, create: { storageKey } });
      });
    },

    async savePlan(claim: ChatPdfClaim, input: Readonly<{
      preparationId: string; localArtifactId: string; plan: ChatPdfWorkPlan;
    }>): Promise<void> {
      await prisma.$transaction(async (tx) => {
        await assertChatPdfClaim(tx, claim);
        const row = await tx.chatPdfAttachmentPreparation.findFirstOrThrow({
          where: { id: input.preparationId, modelRunId: claim.runId }
        });
        if (row.workPlan !== null) {
          if (chatPdfFingerprint(row.workPlan) !== chatPdfFingerprint(input.plan)) {
            throw new ChatPdfPreparationError("pdf_preparation_invalid");
          }
          return;
        }
        await tx.chatPdfAttachmentPreparation.update({ where: { id: row.id }, data: {
          localArtifactId: input.localArtifactId, workPlan: chatPdfJson(input.plan), state: "preparing",
          completedPages: row.route === "local_text" ? 0 : input.plan.adaptive?.nativeOnlyPageCount ?? 0
        } });
        await tx.chatPdfRunPreparation.update({ where: { modelRunId: claim.runId }, data: { state: "preparing" } });
      });
    },

    async completedPages(claim: ChatPdfClaim, preparationId: string): Promise<void> {
      await prisma.$transaction(async (tx) => {
        await assertChatPdfClaim(tx, claim);
        const row = await tx.chatPdfAttachmentPreparation.findFirstOrThrow({
          where: { id: preparationId, modelRunId: claim.runId }
        });
        const plan = row.workPlan as unknown as ChatPdfWorkPlan;
        const accepted = await tx.chatPdfPageAttempt.count({ where: {
          preparationId, state: "settled", resultArtifactId: { not: null }, errorCode: null
        } });
        const completedPages = (plan.adaptive?.nativeOnlyPageCount ?? 0) + accepted;
        await tx.chatPdfAttachmentPreparation.update({ where: { id: preparationId }, data: { completedPages } });
      });
    },

    async beginAssembly(claim: ChatPdfClaim, preparationId: string) {
      return prisma.$transaction(async (tx) => {
        await assertChatPdfClaim(tx, claim);
        const row = await tx.chatPdfAttachmentPreparation.findFirstOrThrow({
          where: { id: preparationId, modelRunId: claim.runId }
        });
        if (row.route !== "local_text" && row.completedPages !== row.pageCount) {
          throw new ChatPdfPreparationError("pdf_preparation_invalid");
        }
        await tx.chatPdfAttachmentPreparation.update({ where: { id: preparationId }, data: { state: "assembling" } });
        return tx.chatPdfPageAttempt.findMany({ where: {
          preparationId, state: "settled", resultArtifactId: { not: null }, errorCode: null
        }, orderBy: { page: "asc" } });
      });
    },

    async publishDocument(claim: ChatPdfClaim, preparationId: string, documentArtifactId: string): Promise<void> {
      await prisma.$transaction(async (tx) => {
        await assertChatPdfClaim(tx, claim);
        const row = await tx.chatPdfAttachmentPreparation.findFirstOrThrow({
          where: { id: preparationId, modelRunId: claim.runId, state: "assembling" }
        });
        await tx.chatPdfAttachmentPreparation.update({ where: { id: row.id }, data: {
          completedPages: row.pageCount!, documentArtifactId, state: "ready"
        } });
      });
    },

    async useWorkspaceOriginal(claim: ChatPdfClaim, preparationId: string,
      errorCode: "pdf_local_text_unusable" | "pdf_transcription_failed"): Promise<void> {
      await prisma.$transaction(async (tx) => {
        await assertChatPdfClaim(tx, claim);
        if (!await tx.workspaceRunBinding.findUnique({ where: { modelRunId: claim.runId } })) {
          throw new ChatPdfPreparationError("pdf_preparation_unavailable");
        }
        const updated = await tx.chatPdfAttachmentPreparation.updateMany({ where: {
          id: preparationId, modelRunId: claim.runId, route: { not: "direct_pdf" },
          state: { in: ["checking", "preparing", "assembling"] }
        }, data: { state: "original_only", errorCode, retryable: false } });
        if (updated.count !== 1) throw new ChatPdfPreparationError("pdf_preparation_unavailable");
      });
    },

    async markAnswerDispatched(claim: ChatPdfClaim): Promise<boolean> {
      const updated = await prisma.chatPdfRunPreparation.updateMany({
        where: { modelRunId: claim.runId, claimToken: claim.claimToken, state: "answer_ready",
          modelRun: { status: "streaming" } },
        data: { claimToken: null, claimedAt: null, snapshot: {}, state: "dispatched" }
      });
      return updated.count === 1;
    }
  };
}
