import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import { createAdminSystemModelPolicyService } from "./systemModelPolicyService";
import { createPrismaAdminProviderRepository } from "./prismaRepository";
import { createAdminKnowledgeProfileService } from "../knowledge/profileService";
import { loadInstallationAnswerProviderRole } from "../../providerRuntime/admission";
import { createSystemModelRoleResolver } from "../../providerRuntime/systemModelRole";
import { createChatPdfModelRoleResolver } from "../../providerRuntime/chatPdfModelRole";
import type { AdminProviderTestEvidence } from "../../../contracts/adminProviders";

afterAll(() => prisma.$disconnect());

async function fixture(run: (input: {
  db: PrismaClient; adminId: string; memory: string; vision: string; embedding: string; reranker: string;
}) => Promise<void>) {
  const rolledBack = new Error("fixture_rollback");
  try {
    await prisma.$transaction(async (tx) => {
      // Nested service transactions share this fixture transaction. Constraint
      // triggers are forced before rollback; no fixture or global policy escapes.
      const db = new Proxy(tx, { get(target, key) {
        if (key === "$transaction") return (operation: (client: Prisma.TransactionClient) => Promise<unknown>) => operation(tx);
        return Reflect.get(target, key);
      } }) as unknown as PrismaClient;
      const adminId = randomUUID();
      await tx.user.create({ data: { id: adminId, displayName: "Role test administrator", role: "admin", status: "active" } });
      async function model(purpose: "memory" | "vision" | "embedding" | "reranker") {
        const id = randomUUID();
        const family = purpose === "reranker" ? "openrouter" : "openai_compatible";
        const answer = purpose === "memory" || purpose === "vision";
        const modelClass = purpose === "embedding" ? "embedding" : purpose === "reranker" ? "reranker" : "answer";
        const adapterKind = answer ? "openai_responses_compatible" : purpose === "embedding" ? "openai_embeddings_compatible" : "openrouter_rerank";
        const capabilities = { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false,
          vision: purpose === "vision", toolCalling: purpose === "memory", streaming: answer };
        const configuration = { adapterKind, answerSelectable: answer, modelClass,
          capabilities, defaultParams: {}, upstreamModelId: purpose === "reranker" ? "qwen/qwen3-reranker-8b" : "fixture",
          ...(purpose === "reranker" ? { openRouterRouting: { mode: "only_selected", providers: ["Together"] } } : {}),
          ...(purpose === "embedding" ? { embedding: { nativeDimension: 1024, targetDimension: 1024, supportsMrl: false,
            providerFamily: family, queryInstructionTemplate: null } } : {}) };
        const connection = await tx.providerConnection.create({ data: { id: randomUUID(), displayName: purpose, family,
          enabled: true, activeVersion: 1, activatedAt: new Date(), activeConfig: {
            allowPrivateNetwork: false, apiRoot: family === "openrouter" ? "https://openrouter.ai/api/v1" : "https://provider.example.test/v1",
            authenticationMode: "bearer", responseTimeoutMs: 300_000
          } } });
        const credential = await tx.providerCredential.create({ data: { id: randomUUID(), connectionId: connection.id,
          label: "Synthetic role credential", enabled: true } });
        const version = await tx.providerCredentialVersion.create({ data: { id: randomUUID(), credentialId: credential.id, version: 1,
          secretEnvelope: "synthetic-envelope-not-dispatched", testedAt: new Date(), activatedAt: new Date(), testEvidence: { authenticationMode: "bearer" } } });
        await tx.providerCredential.update({ where: { id: credential.id }, data: { activeVersionId: version.id, activatedAt: new Date() } });
        await tx.providerConnection.update({ where: { id: connection.id }, data: { defaultCredentialId: credential.id } });
        await tx.providerModel.create({ data: { id, connectionId: connection.id, displayName: purpose, provider: family,
          modelId: configuration.upstreamModelId, modelClass, capabilities, defaultParams: {},
          enabled: true, activeConfig: configuration, activeVersion: 1, activatedAt: new Date() } });
        const proof = { adapterKind, probeVersion: 1, upstreamModelId: configuration.upstreamModelId, verified: true };
        const evidence = { method: "tiny_generation", detail: "ok", selectedProviders: purpose === "reranker" ? ["Together"] : [],
          upstreamModelId: configuration.upstreamModelId,
          compatibility: { probeVersion: 1, modelAccess: "verified", streaming: answer ? "verified" : "not_supported",
            usage: "not_supported", directPdf: "not_supported", structuredOutput: purpose === "memory" ? "verified" : "not_supported",
            forcedToolCall: purpose === "memory" ? "verified" : "not_supported", vision: purpose === "vision" ? "verified" : "not_supported" },
          ...(purpose === "memory" ? { structuredOutput: { ...proof, probeVersion: 2 }, forcedToolCall: proof } : {}),
          ...(purpose === "vision" ? { visionInput: proof } : {}),
          ...(purpose === "embedding" ? { embedding: { probeVersion: 1, document: true, query: true, dimensions: 1024 } } : {}),
          ...(purpose === "reranker" ? { reranking: { probeVersion: 1, completeScores: true } } : {}) };
        await tx.providerModelCredentialCheck.create({ data: { providerModelId: id, connectionId: connection.id,
          connectionVersion: 1, modelVersion: 1, credentialId: credential.id, credentialVersionId: version.id,
          status: "available", evidence, checkedAt: new Date() } });
        return id;
      }
      await run({ db, adminId, memory: await model("memory"), vision: await model("vision"),
        embedding: await model("embedding"), reranker: await model("reranker") });
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      throw rolledBack;
    }, { timeout: 30_000 });
  } catch (error) { if (error !== rolledBack) throw error; }
}

describe("persisted independent System Model roles", () => {
  it("saves roles independently and pins a separate document model in an immutable Knowledge profile", async () => {
    await fixture(async ({ db, adminId, memory, vision, embedding, reranker }) => {
      const service = createAdminSystemModelPolicyService(db);
      const version = async () => (await db.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } })).version;
      await service.update({ expectedVersion: await version(), providerModelId: memory, reasoningEffort: null, userId: adminId });
      await service.update({ expectedVersion: await version(), chatPdfProviderModelId: vision, chatPdfReasoningEffort: null,
        chatPdfPreparationAllowed: true, userId: adminId });
      await service.update({ expectedVersion: await version(), rerankerProviderModelId: reranker, userId: adminId });
      const catalog = await service.list();
      expect(catalog.candidates.map((item) => item.id)).toContain(memory);
      expect(catalog.candidates.map((item) => item.id)).not.toContain(vision);
      expect(catalog.documentCandidates.map((item) => item.id)).toContain(vision);
      expect(catalog.documentCandidates.map((item) => item.id)).not.toContain(memory);
      expect(catalog.rerankerCandidates.map((item) => item.id)).toContain(reranker);
      expect(await createSystemModelRoleResolver(db).resolve()).toMatchObject({ ok: true, providerModelId: memory });
      expect(await createChatPdfModelRoleResolver(db).resolve()).toMatchObject({ ok: true, providerModelId: vision });
      await expect(service.update({ expectedVersion: await version(), providerModelId: vision, reasoningEffort: null, userId: adminId }))
        .rejects.toMatchObject({ code: "system_model_policy_target_unavailable" });
      expect(await loadInstallationAnswerProviderRole(db, { providerModelId: vision })).toMatchObject({ verifiedVisionInput: true });
      const profile = createAdminKnowledgeProfileService(db, { probeVision: async () => true });
      const before = await profile.list();
      expect(before.availableDestinations.map((item) => item.deploymentId)).toContain(embedding);
      await profile.activate({ deploymentId: embedding, documentDeploymentId: vision,
        expectedVersion: before.version, pdfProcessingMode: "system_model_vision", userId: adminId });
      const accepted = await db.knowledgeIndexProfile.findUniqueOrThrow({ where: { id: "installation" }, include: { activeRevision: true } });
      expect(accepted.activeRevision?.pdfSystemModelSnapshot).toMatchObject({ providerModelId: vision });
      expect(accepted.activeRevision?.embeddingProviderModelId).toBe(embedding);
      await service.update({ expectedVersion: await version(), providerModelId: null, reasoningEffort: null, userId: adminId });
      expect(await db.knowledgeIndexProfileRevision.findUnique({ where: { id: accepted.activeRevisionId! } })).toEqual(accepted.activeRevision);
      expect(await createChatPdfModelRoleResolver(db).resolve()).toMatchObject({ ok: true, providerModelId: vision });
      const racingActivation = createAdminKnowledgeProfileService(db, { probeVision: async () => {
        const target = await db.providerModel.findUniqueOrThrow({ where: { id: vision } });
        await db.providerConnection.update({ where: { id: target.connectionId }, data: { activeVersion: 2 } });
        return true;
      } });
      await expect(racingActivation.activate({ deploymentId: embedding, documentDeploymentId: vision,
        expectedVersion: before.version + 1, pdfProcessingMode: "system_model_vision", userId: adminId }))
        .rejects.toMatchObject({ code: "knowledge_pdf_processing_mode_unavailable" });
      expect((await db.knowledgeIndexProfile.findUniqueOrThrow({ where: { id: "installation" } })).activeRevisionId)
        .toBe(accepted.activeRevisionId);
    });
  });

  it("preserves unrelated evidence on role checks and fences changed versions or revoked credentials", async () => {
    await fixture(async ({ db, adminId, memory, vision }) => {
      const repository = createPrismaAdminProviderRepository(db);
      const model = await db.providerModel.findUniqueOrThrow({ where: { id: memory }, include: { connection: true } });
      const credentialId = model.connection.defaultCredentialId!;
      const candidate = await repository.loadActiveRefreshCandidate({ connectionId: model.connectionId, credentialId, providerModelId: memory });
      expect(candidate).not.toBeNull();
      const old = await db.providerModelCredentialCheck.findFirstOrThrow({ where: { providerModelId: memory } });
      const evidence = old.evidence as unknown as AdminProviderTestEvidence;
      expect(await repository.storeActiveRefreshCas({ candidate: candidate!, capabilityRole: "vision", checkedAt: new Date(),
        evidence: { ...evidence, compatibility: { ...evidence.compatibility!, vision: "not_supported" } }, status: "available" })).toBe("stored");
      expect(await loadInstallationAnswerProviderRole(db, { providerModelId: memory })).toMatchObject({
        verifiedStructuredOutput: true, verifiedForcedToolCall: true
      });
      const service = createAdminSystemModelPolicyService(db);
      const policy = await db.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
      await service.update({ expectedVersion: policy.version, providerModelId: memory, reasoningEffort: null, userId: adminId });
      await db.providerConnection.update({ where: { id: model.connectionId }, data: { activeVersion: 2 } });
      expect(await createSystemModelRoleResolver(db).resolve()).toMatchObject({ ok: false });
      expect(await repository.storeActiveRefreshCas({ candidate: candidate!, capabilityRole: "memory", checkedAt: new Date(),
        evidence, status: "available" })).toBe("stale");
      const visionRole = await loadInstallationAnswerProviderRole(db, { providerModelId: vision });
      await db.providerCredentialVersion.update({ where: { id: visionRole.snapshot.credentialVersionId! }, data: { revokedAt: new Date() } });
      await expect(service.update({ expectedVersion: policy.version + 1, chatPdfProviderModelId: vision,
        chatPdfReasoningEffort: null, userId: adminId })).rejects.toMatchObject({ code: "system_model_policy_target_unavailable" });
    });
  });
});
