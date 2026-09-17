import { describe, expect, it, vi } from "vitest";
import { fixtureCheck, workingConnection } from "@/components/admin/providers/providerFixtures";
import type { AdminModelPolicyCatalog } from "../../../contracts/adminModelPolicy";
import type { AdminSystemModelPolicyCatalog } from "../../../contracts/adminSystemModelPolicy";
import type { AdminSearchCatalog } from "../../../contracts/adminSearch";
import { createAdminProviderBootstrap } from "./bootstrapService";
import { adminKnowledgeProfileFixture } from "@/tests/support/knowledgeProfile";
import { providerSetupModels } from "./setupModels";
import { adminProviderModelConfiguration } from "./adminConfiguration";

function fixture() {
  const connection = workingConnection();
  connection.activeChecks = connection.models.map((model) => fixtureCheck({
    providerModelId: model.id, credentialId: "cred-primary", evidence: {
      detail: "ok", method: "tiny_generation", selectedProviders: [], upstreamModelId: model.activeConfig!.upstreamModelId,
      compatibility: { probeVersion: 1, modelAccess: "verified", directPdf: "verified", streaming: "verified", structuredOutput: "verified", usage: "verified" }
    }
  }));
  const candidates = connection.models.map((model) => ({
    id: model.id, displayName: model.displayName, connectionId: connection.id, connectionDisplayName: connection.displayName,
    defaultReasoningEffort: null, reasoningEfforts: [], structuredOutput: "verified" as const,
    forcedToolCall: "verified" as const, visionInput: "verified" as const
  }));
  const chat: AdminModelPolicyCatalog = { candidates, policy: {
    defaultModel: null, reasoningEffort: null, version: 1, updatedAt: "2026-09-08T12:00:00Z", updatedBy: null,
    maxMcpToolsPerDiscovery: 8, maxToolCalls: 12, maxToolRounds: 8,
    mcpAutoDiscoveryMaxOutputTokens: 8_192, mcpAutoDiscoveryTimeoutSeconds: 10
  } };
  const roles: AdminSystemModelPolicyCatalog = { candidates, titleCandidates: [], documentCandidates: candidates, verificationCandidates: candidates,
    memoryPolicy: { assignmentSource: "unassigned", model: null, reasoningEffort: null, version: 1,
      recommendations: [{ id: "terra-low-memory-v1", providerModelId: "model-terra", connectionId: connection.id,
        modelName: "GPT-5.6 Terra", displayName: "GPT-5.6 Terra", reasoningEffort: "low", unavailableReason: null,
        evidence: { revision: "synthetic", passedCases: 5, totalCases: 5, latencyP50Ms: 3000, latencyP95Ms: 14000 } }] },
    ineligible: { chat_titles: [], memory: [], vision: [], direct_pdf: [] }, rerankerCandidates: [], policy: {
      chatTitleModel: null, chatTitleReasoningEffort: null, chatPdfModel: null, chatPdfReasoningEffort: null, reasoningEffort: null,
      rerankerModel: null, systemModel: null, updatedAt: "2026-09-08T12:00:00Z", updatedBy: null, version: 1
    } };
  const search: AdminSearchCatalog = { integrations: [], policy: { defaultPlan: { mode: "all_selected", optionIds: [] }, version: 1, updatedAt: "2026-09-08T12:00:00Z" },
    providerModels: candidates.map((model) => ({ ...model, enabled: true, searchReasoningSupported: false, searchKind: "web_search" })) };
  const chatUpdate = vi.fn(async () => {});
  const rolesUpdate = vi.fn(async () => {});
  const memoryUpdate = vi.fn(async () => {});
  const searchCreate = vi.fn(async () => ({ created: true, id: "search" }));
  const searchSave = vi.fn(async () => {});
  const knowledge = adminKnowledgeProfileFixture({ activeRevision: null, availableDestinations: [], availablePdfDestinations: [] });
  const knowledgeActivate = vi.fn(async () => {});
  const complete = createAdminProviderBootstrap({ providers: { listConnections: async () => [connection] },
    chat: { list: async () => chat, update: chatUpdate }, roles: { list: async () => roles, update: rolesUpdate, updateMemory: memoryUpdate },
    search: { list: async () => search, createDraft: searchCreate, saveAndCheck: searchSave },
    knowledge: { list: async () => knowledge, activate: knowledgeActivate } });
  const run = (signal = new AbortController().signal) => complete({ connectionId: connection.id, credentialId: "cred-primary", userId: "operator", signal });
  return { chat, chatUpdate, connection, roles, rolesUpdate, memoryUpdate, run, search, searchCreate, searchSave, knowledge, knowledgeActivate };
}

describe("provider automatic setup", () => {
  it("leaves Memory unassigned when only unqualified candidates are available", async () => {
    const value = fixture();
    value.roles.memoryPolicy.recommendations = [];
    expect(await value.run()).toMatchObject({ state: "partial" });
    expect(value.memoryUpdate).not.toHaveBeenCalled();
    expect(value.chatUpdate).toHaveBeenCalledOnce();
  });
  it.each([false, true])("publishes Anthropic Search only after its check (failure=%s)", async (fails) => {
    const value = fixture();
    value.connection.family = "anthropic";
    value.connection.displayName = "Anthropic";
    value.search.providerModels = value.search.providerModels.map((model) => ({
      ...model, connectionDisplayName: "Anthropic", searchKind: "anthropic_web_search"
    }));
    if (fails) value.searchCreate.mockRejectedValueOnce(new Error("synthetic_search_failure"));
    expect(await value.run()).toMatchObject({ search: fails ? "failed" : "ready", state: fails ? "partial" : "completed" });
    expect(value.searchCreate).toHaveBeenCalledWith(expect.objectContaining({ bootstrap: true, check: true,
      draft: expect.objectContaining({ protocol: "anthropic_web_search" }) }));
    expect(value.chatUpdate).toHaveBeenCalledOnce();
  });
  it("assigns verified OpenRouter helpers and initializes Knowledge with image reading only once", async () => {
    const value = fixture();
    value.connection.family = "openrouter";
    const helpers = providerSetupModels("openrouter").filter((model) => model.configuration.modelClass !== "answer");
    for (const helper of helpers) {
      const configuration = adminProviderModelConfiguration(helper.configuration);
      value.connection.models.push({ ...value.connection.models[0]!, id: helper.modelId,
        displayName: helper.displayName, modelClass: helper.configuration.modelClass,
        activeConfig: configuration, draftConfig: configuration });
      value.connection.activeChecks.push({ ...value.connection.activeChecks[0]!, providerModelId: helper.modelId });
      if (helper.configuration.modelClass === "reranker") value.roles.rerankerCandidates.push({
        id: helper.modelId, connectionId: value.connection.id, connectionDisplayName: value.connection.displayName, displayName: helper.displayName
      });
    }
    const embedding = helpers.find((model) => model.configuration.modelClass === "embedding")!;
    const reranker = helpers.find((model) => model.configuration.modelClass === "reranker")!;
    const destination = { deploymentId: embedding.modelId, modelDisplayName: embedding.displayName,
      connectionDisplayName: value.connection.displayName, provider: "openrouter", targetDimension: 1536 };
    Object.assign(value.knowledge, { availableDestinations: [destination], availablePdfDestinations: [{
      deploymentId: value.roles.documentCandidates[0]!.id, modelDisplayName: "Page reader",
      defaultReasoningEffort: null, reasoningEfforts: [],
      connectionDisplayName: value.connection.displayName, provider: "openrouter", upstreamModelId: "page-reader", directPdf: false, vision: true
    }] });
    expect(await value.run()).toMatchObject({ state: "completed", defaults: expect.arrayContaining([
      "Reranking: Voyage Rerank 2.5", "Knowledge: Qwen3 Embedding 8B · Page reader"
    ]) });
    expect(value.rolesUpdate).toHaveBeenCalledWith(expect.objectContaining({ rerankerProviderModelId: reranker.modelId }));
    expect(value.knowledgeActivate).toHaveBeenCalledWith(expect.objectContaining({
      deploymentId: embedding.modelId, documentDeploymentId: "model-terra", pdfProcessingMode: "system_model_vision",
      expectedVersion: value.knowledge.version, userId: "operator"
    }));
    Object.assign(value.knowledge, { activeRevision: adminKnowledgeProfileFixture().activeRevision });
    value.roles.policy.rerankerModel = { ...value.roles.rerankerCandidates[0]!, available: true };
    value.rolesUpdate.mockClear();
    await value.run();
    expect(value.knowledgeActivate).toHaveBeenCalledOnce();
    expect(value.rolesUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ rerankerProviderModelId: expect.anything() }));
  });

  it("fills empty roles after exact model checks and runs a real Search check", async () => {
    const value = fixture();
    expect(await value.run()).toMatchObject({ state: "completed", search: "ready", defaults: [
      "Chat: GPT-5.6 Terra", "System model: GPT-5.6 Terra", "Page-image reader: GPT-5.6 Terra", "Memory: GPT-5.6 Terra"
    ] });
    expect(value.chatUpdate).toHaveBeenCalledWith({ expectedVersion: 1, providerModelId: "model-terra", reasoningEffort: null, userId: "operator" });
    expect(value.rolesUpdate).toHaveBeenCalledWith({ expectedVersion: 1, providerModelId: "model-terra", reasoningEffort: null,
      chatPdfProviderModelId: "model-terra", chatPdfReasoningEffort: null, userId: "operator" });
    expect(value.searchCreate).toHaveBeenCalledWith(expect.objectContaining({ bootstrap: true, check: true,
      draft: expect.objectContaining({ providerModelId: "model-terra", protocol: "openai_responses_web_search" }), userId: "operator" }));
  });

  it("preserves established assignments and disabled Search, including unrelated independent fields", async () => {
    const value = fixture();
    const chosen = { ...value.roles.candidates[1]!, available: true };
    value.chat.policy.defaultModel = chosen;
    value.roles.policy.systemModel = chosen;
    value.roles.memoryPolicy = { assignmentSource: "operator", model: chosen, reasoningEffort: "low", version: 3 };
    value.roles.policy.chatPdfModel = chosen;
    value.search.integrations.push({ archivedAt: null, broaderModelSetup: "ready", configurable: true, configuration: null,
      configurationActive: true, description: "Existing search", displayName: "Existing search", draftDirty: false, draftVersion: 2,
      draftTestEvidence: null, enabled: false, executionModes: ["all_selected"], id: "search", kind: "web_search", providerModel: null,
      ready: true, readiness: "ready", sourceConnectionId: value.connection.id, strategyId: "search", system: false });
    expect(await value.run()).toEqual({ defaults: [], state: "completed", search: "skipped" });
    expect(value.chatUpdate).not.toHaveBeenCalled();
    expect(value.rolesUpdate).not.toHaveBeenCalled();
    expect(value.memoryUpdate).not.toHaveBeenCalled();
    expect(value.searchCreate).not.toHaveBeenCalled();
    expect(value.searchSave).not.toHaveBeenCalled();
  });

  it("does not derive role readiness from a catalog, a stale key version or a disabled connection", async () => {
    const value = fixture();
    value.connection.activeChecks[0]!.credentialVersionId = "previous-key";
    value.connection.activeChecks[1]!.evidence = null;
    expect(await value.run()).toEqual({ defaults: [], search: "skipped", state: "partial" });
    value.connection.enabled = false;
    await value.run();
    expect(value.chatUpdate).not.toHaveBeenCalled();
    expect(value.rolesUpdate).not.toHaveBeenCalled();
    expect(value.searchCreate).not.toHaveBeenCalled();
  });

  it.each(["operator", "inherited"] as const)("preserves an explicitly empty %s Memory assignment during setup", async (assignmentSource) => {
    const value = fixture();
    value.roles.memoryPolicy = { assignmentSource, model: null, reasoningEffort: null, version: 8 };
    await value.run();
    expect(value.memoryUpdate).not.toHaveBeenCalled();
  });

  it("keeps completed defaults on Search failure and permits a bounded retry", async () => {
    const value = fixture();
    value.searchCreate.mockRejectedValueOnce(new Error("private-provider-body"));
    const first = await value.run();
    expect(first).toMatchObject({ search: "failed", state: "partial", defaults: expect.arrayContaining(["Chat: GPT-5.6 Terra"]) });
    expect(JSON.stringify(first)).not.toContain("private-provider-body");
    expect(await value.run()).toMatchObject({ state: "completed", search: "ready" });
    expect(value.searchCreate).toHaveBeenCalledTimes(2);
    await expect(value.run(AbortSignal.abort())).rejects.toThrow();
    expect(value.searchCreate).toHaveBeenCalledTimes(2);
  });
});
