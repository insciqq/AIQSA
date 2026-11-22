import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import { createAdminSystemModelPolicyService } from "./systemModelPolicyService";
import { createPrismaAdminProviderRepository } from "./prismaRepository";
import { loadInstallationAnswerProviderRole } from "../../providerRuntime/admission";
import { createSystemModelRoleResolver } from "../../providerRuntime/systemModelRole";
import { structuredOutputVerificationEvidence } from "../../providers/structuredOutputEvidence";
import { createChatTitleModelRoleResolver } from "../../providerRuntime/chatTitleModelRole";
import { createVisionModelRoleResolver } from "../../providerRuntime/visionModelRole";
import { createChatPdfModelRoleResolver } from "../../providerRuntime/chatPdfModelRole";
import type { AdminProviderTestEvidence } from "../../../contracts/adminProviders";
import { providerSetupModels } from "./setupModels";
import { JEV_MODEL_ID, JEV_SERVED_MODEL_ID } from "../../../domain/decisionModels";
import { createDecisionModelRoleResolver } from "../../providerRuntime/decisionModelRole";

afterAll(() => prisma.$disconnect());

async function fixture(run: (input: {
  db: PrismaClient; adminId: string; titles: string; system: string; vision: string; embedding: string; reranker: string;
  addDecisionModel: () => Promise<string>;
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
      // `system`: an answer deployment with verified structured output and forced tool calls, as the System model needs.
      async function model(purpose: "titles" | "system" | "vision" | "embedding" | "reranker" | "decision") {
        const id = randomUUID();
        const family = purpose === "reranker" || purpose === "decision" ? "openrouter" : "openai_compatible";
        const answer = purpose === "titles" || purpose === "system" || purpose === "vision";
        const modelClass = purpose === "embedding" ? "embedding" : purpose === "reranker" ? "reranker" : purpose === "decision" ? "decision" : "answer";
        const adapterKind = answer ? "openai_responses_compatible" : purpose === "embedding" ? "openai_embeddings_compatible" : purpose === "decision" ? "openrouter_decisions" : "openrouter_rerank";
        const capabilities = { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false,
          vision: purpose === "vision", toolCalling: purpose === "system", streaming: answer };
        const selectedProviders = purpose === "decision" ? ["typesafe"] : purpose === "reranker" ? ["Together"] : [];
        const configuration = { adapterKind, answerSelectable: answer, modelClass,
          capabilities, defaultParams: {},
          upstreamModelId: purpose === "reranker" ? "qwen/qwen3-reranker-8b" : purpose === "decision" ? JEV_MODEL_ID : "fixture",
          ...(selectedProviders.length ? { openRouterRouting: { mode: "only_selected", providers: selectedProviders } } : {}),
          ...(purpose === "embedding" ? { embedding: { nativeDimension: 1024, targetDimension: 1024, supportsMrl: false,
            providerFamily: family, queryInstructionTemplate: null } } : {}) };
        const connection = await tx.providerConnection.create({ data: { id: randomUUID(), displayName: purpose, family,
          enabled: true, activeVersion: 1, activatedAt: new Date(), activeConfig: {
            allowPrivateNetwork: false, apiRoot: family === "openrouter" ? "https://openrouter.ai/api/v1"
              : "https://provider.example.test/v1",
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
        const evidence = { method: "tiny_generation", detail: "ok", selectedProviders,
          upstreamModelId: configuration.upstreamModelId,
          compatibility: { probeVersion: 1, modelAccess: "verified", streaming: answer ? "verified" : "not_supported",
            usage: "not_supported", directPdf: "not_supported", structuredOutput: purpose === "system" || purpose === "titles" ? "verified" : "not_supported",
            forcedToolCall: purpose === "system" ? "verified" : "not_supported", vision: purpose === "vision" ? "verified" : "not_supported" },
          ...(purpose === "system" || purpose === "titles"
            ? { structuredOutput: structuredOutputVerificationEvidence(adapterKind, configuration.upstreamModelId) } : {}),
          ...(purpose === "system" ? { forcedToolCall: proof } : {}),
          ...(purpose === "vision" ? { visionInput: proof } : {}),
          ...(purpose === "embedding" ? { embedding: { probeVersion: 1, document: true, query: true, dimensions: 1024 } } : {}),
          ...(purpose === "decision" ? { decisions: { probeVersion: 1, adapterKind: "openrouter_decisions",
            upstreamModelId: JEV_MODEL_ID, servedModelId: JEV_SERVED_MODEL_ID, provider: "TypeSafe", noul: true, choice: true } } : {}),
          ...(purpose === "reranker" ? { reranking: { probeVersion: 1, completeScores: true } } : {}) };
        await tx.providerModelCredentialCheck.create({ data: { providerModelId: id, connectionId: connection.id,
          connectionVersion: 1, modelVersion: 1, credentialId: credential.id, credentialVersionId: version.id,
          status: "available", evidence, checkedAt: new Date() } });
        return id;
      }
      await run({ db, adminId, titles: await model("titles"), system: await model("system"), vision: await model("vision"),
        embedding: await model("embedding"), reranker: await model("reranker"), addDecisionModel: () => model("decision") });
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      throw rolledBack;
    }, { timeout: 30_000 });
  } catch (error) { if (error !== rolledBack) throw error; }
}

describe("persisted independent System Model roles", () => {
  it("persists independent Vision assignment, clear and exact evidence revocation", async () => {
    await fixture(async ({ db, adminId, vision, system }) => {
      await db.systemModelPolicy.update({ where: { id: "installation" }, data: {
        visionProviderModelId: null, visionReasoningEffort: null,
        chatPdfProviderModelId: vision, chatPdfReasoningEffort: null
      } });
      const service = createAdminSystemModelPolicyService(db);
      const resolver = createVisionModelRoleResolver(db);
      expect(await resolver.resolve()).toMatchObject({ ok: false, code: "system_model_absent" });
      let current = await db.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
      await service.update({ userId: adminId, expectedVersion: current.version, visionProviderModelId: vision, visionReasoningEffort: null });
      expect(await resolver.resolve()).toMatchObject({ ok: true, providerModelId: vision });
      expect((await service.list()).visionAnalysisAvailable).toBe(true);
      current = await db.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
      await expect(service.update({ userId: adminId, expectedVersion: current.version, visionProviderModelId: system, visionReasoningEffort: null }))
        .rejects.toMatchObject({ code: "system_model_policy_target_unavailable" });
      await db.providerModel.update({ where: { id: vision }, data: { enabled: false } });
      expect(await resolver.resolve()).toMatchObject({ ok: false, code: "system_model_unavailable" });
      expect((await service.list()).policy.visionModel).toMatchObject({ id: vision, available: false });
      await service.update({ userId: adminId, expectedVersion: current.version, visionProviderModelId: null, visionReasoningEffort: null });
      expect(await resolver.resolve()).toMatchObject({ ok: false, code: "system_model_absent" });
      expect(await db.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } }))
        .toMatchObject({ chatPdfProviderModelId: vision, visionProviderModelId: null, visionReasoningEffort: null });
    });
  });
  it("adopts qualified defaults once and preserves independent opt-outs on repeated setup", async () => {
    await fixture(async ({ db, adminId, addDecisionModel }) => {
      const id = await addDecisionModel();
      await db.systemModelPolicy.update({ where: { id: "installation" }, data: {
        decisionProviderModelId: null, decisionConfiguredAt: null, decisionFeaturesJson: {}
      } });
      const service = createAdminSystemModelPolicyService(db);
      const before = await db.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
      expect(await service.adoptDecisionModel({ userId: adminId, expectedVersion: before.version, providerModelId: id })).toBe(true);
      const roles = createDecisionModelRoleResolver(db);
      expect((await roles.resolve("skillSuggestions")).ok).toBe(true);
      let current = await db.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
      await service.update({ userId: adminId, expectedVersion: current.version,
        decisionFeatures: { skillSuggestions: false } });
      current = await db.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
      expect(await service.adoptDecisionModel({ userId: adminId, expectedVersion: current.version, providerModelId: id })).toBe(false);
      expect(await roles.resolve("skillSuggestions")).toMatchObject({ ok: false, code: "decision_feature_disabled" });
      expect((await db.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } })).providerModelId)
        .toBe(before.providerModelId);
    });
  });

  it("persists optional Decisions independently and immediately removes revoked authority", async () => {
    await fixture(async ({ db, adminId, addDecisionModel }) => {
      const id = await addDecisionModel();
      const before = await db.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
      const service = createAdminSystemModelPolicyService(db);
      await service.update({ expectedVersion: before.version, userId: adminId,
        decisionProviderModelId: id, decisionFeatures: { skillSuggestions: true, skillCatalogRelevance: false } });
      const admitted = await createDecisionModelRoleResolver(db).resolve("skillSuggestions");
      expect(admitted.ok).toBe(true);
      expect((await service.list()).policy.decisionModel).toMatchObject({ id, available: true });
      const saved = await db.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
      expect(saved).toMatchObject({ providerModelId: before.providerModelId, rerankerProviderModelId: before.rerankerProviderModelId,
        decisionConfiguredAt: expect.any(Date), decisionFeaturesJson: { skillSuggestions: true, skillCatalogRelevance: false } });
      await expect(service.update({ expectedVersion: before.version, userId: adminId, decisionProviderModelId: null }))
        .rejects.toMatchObject({ code: "system_model_policy_stale" });
      if (!admitted.ok) throw new Error("decision_fixture_admission_failed");
      await db.providerCredentialVersion.update({ where: { id: admitted.role.authority.credentialVersionId }, data: { revokedAt: new Date() } });
      expect(await createDecisionModelRoleResolver(db).resolve("skillSuggestions")).toMatchObject({ ok: false, code: "decision_model_unavailable" });
      expect((await service.list()).policy.decisionModel).toMatchObject({ id, available: false });
      await service.update({ expectedVersion: saved.version, userId: adminId, decisionProviderModelId: null });
      expect(await db.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } })).toMatchObject({
        decisionProviderModelId: null, decisionConfiguredAt: expect.any(Date), decisionFeaturesJson: saved.decisionFeaturesJson
      });
    });
  });
  it("provisions helpers only through the exact default key and keeps repeat checks idempotent", async () => {
    await fixture(async ({ db, reranker }) => {
      const target = await db.providerModel.findUniqueOrThrow({ where: { id: reranker }, include: { connection: true } });
      const key = await db.providerCredential.findUniqueOrThrow({ where: { id: target.connection.defaultCredentialId! } });
      const preset = providerSetupModels("openrouter").find((model) => model.configuration.modelClass === "embedding")!;
      const id = randomUUID();
      const write = { connectionId: target.connectionId, connectionVersion: target.connection.activeVersion,
        credentialId: key.id, credentialVersionId: key.activeVersionId!, now: new Date(),
        models: [{ ...preset, id, templateKey: null }] };
      const repository = createPrismaAdminProviderRepository(db);
      expect(await repository.addSetupModelsCas({ ...write, credentialVersionId: randomUUID() })).toBe("stale");
      expect(await db.providerModel.count({ where: { id } })).toBe(0);
      expect(await repository.addSetupModelsCas(write)).toBe("updated");
      const pendingChecks = await db.providerModelCredentialCheck.findMany({ where: { providerModelId: id } });
      expect(pendingChecks).toMatchObject([{
        credentialId: key.id, credentialVersionId: key.activeVersionId, status: "unavailable",
        evidence: { capabilitySetup: { checks: { modelAccess: "not_checked" } } }
      }]);
      await db.providerModel.update({ where: { id }, data: { enabled: false } });
      expect(await repository.addSetupModelsCas({ ...write, models: [{ ...write.models[0]!, id: randomUUID() }] })).toBe("updated");
      expect(await db.providerModel.count({ where: { connectionId: target.connectionId, modelClass: "embedding" } })).toBe(1);
      expect((await db.providerModel.findUniqueOrThrow({ where: { id } })).enabled).toBe(false);
      expect(await db.providerModelCredentialCheck.findMany({ where: { providerModelId: id } })).toEqual(pendingChecks);
    });
  });

  it("saves roles independently and keeps the document model when the System Model is cleared", async () => {
    await fixture(async ({ db, adminId, system, vision, reranker }) => {
      const service = createAdminSystemModelPolicyService(db);
      const version = async () => (await db.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } })).version;
      await service.update({ expectedVersion: await version(), providerModelId: system, reasoningEffort: null, userId: adminId });
      await service.update({ expectedVersion: await version(), chatPdfProviderModelId: vision, chatPdfReasoningEffort: null,
        userId: adminId });
      await service.update({ expectedVersion: await version(), rerankerProviderModelId: reranker, userId: adminId });
      const catalog = await service.list();
      expect(catalog.candidates.map((item) => item.id)).toContain(system);
      expect(catalog.candidates.map((item) => item.id)).not.toContain(vision);
      expect(catalog.documentCandidates.map((item) => item.id)).toContain(vision);
      expect(catalog.documentCandidates.map((item) => item.id)).not.toContain(system);
      expect(catalog.rerankerCandidates.map((item) => item.id)).toContain(reranker);
      expect(await createSystemModelRoleResolver(db).resolve()).toMatchObject({ ok: true, providerModelId: system });
      expect(await createChatPdfModelRoleResolver(db).resolve()).toMatchObject({ ok: true, providerModelId: vision });
      await expect(service.update({ expectedVersion: await version(), providerModelId: vision, reasoningEffort: null, userId: adminId }))
        .rejects.toMatchObject({ code: "system_model_policy_target_unavailable" });
      expect(await loadInstallationAnswerProviderRole(db, { providerModelId: vision })).toMatchObject({ verifiedVisionInput: true });
      await service.update({ expectedVersion: await version(), providerModelId: null, reasoningEffort: null, userId: adminId });
      expect(await createChatPdfModelRoleResolver(db).resolve()).toMatchObject({ ok: true, providerModelId: vision });
    });
  });

  it("preserves unrelated evidence on role checks and fences changed versions or revoked credentials", async () => {
    await fixture(async ({ db, adminId, system, vision }) => {
      const repository = createPrismaAdminProviderRepository(db);
      const model = await db.providerModel.findUniqueOrThrow({ where: { id: system }, include: { connection: true } });
      const credentialId = model.connection.defaultCredentialId!;
      const candidate = await repository.loadActiveRefreshCandidate({ connectionId: model.connectionId, credentialId, providerModelId: system });
      expect(candidate).not.toBeNull();
      const old = await db.providerModelCredentialCheck.findFirstOrThrow({ where: { providerModelId: system } });
      const evidence = old.evidence as unknown as AdminProviderTestEvidence;
      expect(await repository.storeActiveRefreshCas({ candidate: candidate!, capabilityRole: "vision", checkedAt: new Date(),
        evidence: { ...evidence, compatibility: { ...evidence.compatibility!, vision: "not_supported" } }, status: "available" })).toBe("stored");
      expect(await loadInstallationAnswerProviderRole(db, { providerModelId: system })).toMatchObject({
        verifiedStructuredOutput: true, verifiedForcedToolCall: true
      });
      const service = createAdminSystemModelPolicyService(db);
      const policy = await db.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
      await service.update({ expectedVersion: policy.version, providerModelId: system, reasoningEffort: null, userId: adminId });
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

it("adopts titles once, rejects stale setup and preserves an explicit clear", async () => {
  await fixture(async ({ db, adminId, titles, system }) => {
    await db.systemModelPolicy.update({ where: { id: "installation" }, data: {
      chatTitleProviderModelId: null, chatTitleReasoningEffort: null, chatTitleConfiguredAt: null
    } });
    const service = createAdminSystemModelPolicyService(db);
    const policy = () => db.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
    const original = await policy();
    expect(await service.adoptChatTitle({ expectedVersion: original.version, providerModelId: titles,
      reasoningEffort: null, userId: adminId })).toBe(true);
    expect(await policy()).toMatchObject({ chatTitleProviderModelId: titles, chatTitleConfiguredAt: expect.any(Date),
      providerModelId: original.providerModelId, version: original.version + 1 });
    await expect(service.adoptChatTitle({ expectedVersion: original.version, providerModelId: system,
      reasoningEffort: null, userId: adminId })).rejects.toMatchObject({ code: "system_model_policy_stale" });
    expect(await service.adoptChatTitle({ expectedVersion: (await policy()).version, providerModelId: system,
      reasoningEffort: null, userId: adminId })).toBe(false);
    await service.update({ expectedVersion: (await policy()).version, chatTitleProviderModelId: null,
      chatTitleReasoningEffort: null, userId: adminId });
    const cleared = await policy();
    expect(await service.adoptChatTitle({ expectedVersion: cleared.version, providerModelId: titles,
      reasoningEffort: null, userId: adminId })).toBe(false);
    expect(await policy()).toEqual(cleared);
  });
});

it("persists a structured-only title assignment, retains admitted identity and preserves an explicit clear", async () => {
  await fixture(async ({ db, adminId, titles, system }) => {
    const service = createAdminSystemModelPolicyService(db);
    const version = async () => (await db.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } })).version;
    await service.update({ expectedVersion: await version(), providerModelId: system, reasoningEffort: null, userId: adminId });
    const priorVersion = await version();
    await service.update({ expectedVersion: priorVersion, chatTitleProviderModelId: titles, chatTitleReasoningEffort: null, userId: adminId });
    const admitted = await createChatTitleModelRoleResolver(db).resolve();
    expect(admitted).toMatchObject({ ok: true, providerModelId: titles, reasoningEffort: null });
    const catalog = await service.list();
    expect(catalog.titleCandidates.map((model) => model.id)).toContain(titles);
    expect(catalog.candidates.map((model) => model.id)).not.toContain(titles);
    expect(catalog.policy.systemModel?.id).toBe(system);
    expect(catalog.policy.chatTitleModel).toMatchObject({ id: titles, available: true });
    await expect(service.update({ expectedVersion: priorVersion, chatTitleProviderModelId: null, chatTitleReasoningEffort: null, userId: adminId }))
      .rejects.toMatchObject({ code: "system_model_policy_stale" });
    await expect(service.update({ expectedVersion: await version(), providerModelId: titles, reasoningEffort: null, userId: adminId }))
      .rejects.toMatchObject({ code: "system_model_policy_target_unavailable" });
    await expect(service.update({ expectedVersion: await version(), chatTitleProviderModelId: titles, chatTitleReasoningEffort: "max", userId: adminId }))
      .rejects.toMatchObject({ code: "system_model_policy_reasoning_unavailable" });
    await service.update({ expectedVersion: await version(), chatTitleProviderModelId: null, chatTitleReasoningEffort: null, userId: adminId });
    await service.update({ expectedVersion: await version(), providerModelId: system, reasoningEffort: null, userId: adminId });
    expect(await createChatTitleModelRoleResolver(db).resolve()).toMatchObject({ ok: false });
    expect(admitted).toMatchObject({ ok: true, providerModelId: titles });
    await service.update({ expectedVersion: await version(), chatTitleProviderModelId: titles, chatTitleReasoningEffort: null, userId: adminId });
    if (!admitted.ok) throw new Error("title_role_not_admitted");
    await db.providerCredentialVersion.update({ where: { id: admitted.role.snapshot.credentialVersionId! }, data: { revokedAt: new Date() } });
    expect(await createChatTitleModelRoleResolver(db).resolve()).toMatchObject({ ok: false });
    expect((await service.list()).policy.chatTitleModel).toMatchObject({ id: titles, available: false });
    expect(await createSystemModelRoleResolver(db).resolve()).toMatchObject({ ok: true, providerModelId: system });
  });
});
