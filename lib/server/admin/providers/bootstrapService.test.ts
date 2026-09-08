import { describe, expect, it, vi } from "vitest";
import { fixtureCheck, workingConnection } from "@/components/admin/providers/providerFixtures";
import type { AdminModelPolicyCatalog } from "../../../contracts/adminModelPolicy";
import type { AdminSystemModelPolicyCatalog } from "../../../contracts/adminSystemModelPolicy";
import type { AdminSearchCatalog } from "../../../contracts/adminSearch";
import { createAdminProviderBootstrap } from "./bootstrapService";

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
    maxMcpToolsPerDiscovery: 8, maxToolCalls: 12, maxToolRounds: 8, mcpAutoDiscoveryTimeoutSeconds: 10
  } };
  const roles: AdminSystemModelPolicyCatalog = { candidates, documentCandidates: candidates, verificationCandidates: candidates,
    ineligible: { memory: [], vision: [], direct_pdf: [] }, rerankerCandidates: [], policy: {
      chatPdfPreparationAllowed: false, chatPdfModel: null, chatPdfReasoningEffort: null, reasoningEffort: null,
      rerankerModel: null, systemModel: null, updatedAt: "2026-09-08T12:00:00Z", updatedBy: null, version: 1
    } };
  const search: AdminSearchCatalog = { integrations: [], policy: { defaultPlan: { mode: "all_selected", optionIds: [] }, version: 1, updatedAt: "2026-09-08T12:00:00Z" },
    providerModels: candidates.map((model) => ({ ...model, enabled: true, searchReasoningSupported: false, searchKind: "web_search" })) };
  const chatUpdate = vi.fn(async () => {});
  const rolesUpdate = vi.fn(async () => {});
  const searchCreate = vi.fn(async () => ({ created: true, id: "search" }));
  const searchSave = vi.fn(async () => {});
  const complete = createAdminProviderBootstrap({ providers: { listConnections: async () => [connection] },
    chat: { list: async () => chat, update: chatUpdate }, roles: { list: async () => roles, update: rolesUpdate },
    search: { list: async () => search, createDraft: searchCreate, saveAndCheck: searchSave } });
  const run = (signal = new AbortController().signal) => complete({ connectionId: connection.id, credentialId: "cred-primary", userId: "operator", signal });
  return { chat, chatUpdate, connection, roles, rolesUpdate, run, search, searchCreate, searchSave };
}

describe("provider automatic setup", () => {
  it("fills empty roles after exact model checks and runs a real Search check", async () => {
    const value = fixture();
    expect(await value.run()).toMatchObject({ state: "completed", search: "ready", defaults: [
      "Chat: GPT-5.6 Terra", "Memory: GPT-5.6 Terra", "Chat PDF: GPT-5.6 Terra"
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
    value.roles.policy.chatPdfModel = chosen;
    value.search.integrations.push({ archivedAt: null, broaderModelSetup: "ready", configurable: true, configuration: null,
      configurationActive: true, description: "Existing search", displayName: "Existing search", draftDirty: false, draftVersion: 2,
      draftTestEvidence: null, enabled: false, executionModes: ["all_selected"], id: "search", kind: "web_search", providerModel: null,
      ready: true, readiness: "ready", sourceConnectionId: value.connection.id, strategyId: "search", system: false });
    expect(await value.run()).toEqual({ defaults: [], state: "completed", search: "skipped" });
    expect(value.chatUpdate).not.toHaveBeenCalled();
    expect(value.rolesUpdate).not.toHaveBeenCalled();
    expect(value.searchCreate).not.toHaveBeenCalled();
    expect(value.searchSave).not.toHaveBeenCalled();
  });

  it("does not derive role readiness from a catalog, a stale key version or a disabled connection", async () => {
    const value = fixture();
    value.connection.activeChecks[0]!.credentialVersionId = "previous-key";
    value.connection.activeChecks[1]!.evidence = null;
    expect(await value.run()).toEqual({ defaults: [], search: "skipped", state: "completed" });
    value.connection.enabled = false;
    await value.run();
    expect(value.chatUpdate).not.toHaveBeenCalled();
    expect(value.rolesUpdate).not.toHaveBeenCalled();
    expect(value.searchCreate).not.toHaveBeenCalled();
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
