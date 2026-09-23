import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AdminProviderConnection, AdminProviderTestEvidence } from "../../../contracts/adminProviders";
import { adminProviderConnectionConfiguration, adminProviderModelConfiguration, normalizeAdminProviderModelConfiguration } from "./adminConfiguration";
import { createAdminProviderCustomSetupService } from "./customSetupService";
import type { AdminProviderCustomSetupCommitPlan } from "./customSetupRepositoryContract";
import { createPrismaAdminProviderRepository } from "./prismaRepository";
import { createAdminProviderService } from "./service";
import type { AdminProviderDraftTesterInput } from "./tester";
import { createCustomSetupCatalogProof } from "./customSetupCatalogProof";

const NOW = new Date("2026-09-09T00:00:00Z");
const KEY = Buffer.alloc(32, 32);
const PROOF_KEY = "synthetic-catalog-proof-key";

function fixture() {
  let plan!: AdminProviderCustomSetupCommitPlan;
  let connection!: AdminProviderConnection;
  let nextId = 0;
  let unavailable = "model-d";
  let failSave = false;
  let onCheck: (() => void) | undefined;
  const repository = createPrismaAdminProviderRepository({} as PrismaClient);
  vi.spyOn(repository, "listConnections").mockImplementation(async () => [connection]);
  vi.spyOn(repository, "loadActiveRefreshCandidate").mockImplementation(async ({ providerModelId }) => {
    const model = connection.models.find((entry) => entry.id === providerModelId)!;
    return { connection: { configuration: plan.connection.configuration, displayName: connection.displayName,
      family: connection.family, id: connection.id, version: connection.activeVersion },
      credential: { envelope: plan.credential.secretEnvelope, id: plan.credential.id,
        versionId: connection.credentials[0]!.activeVersion!.id },
      model: { configuration: normalizeAdminProviderModelConfiguration(model.activeConfig), displayName: model.displayName,
        id: model.id, version: model.activeVersion, draftVersion: model.draftVersion } };
  });
  const store = vi.spyOn(repository, "storeActiveRefreshCas").mockImplementation(async (value) => {
    value.signal?.throwIfAborted();
    if (failSave) { failSave = false; throw new Error("synthetic_database_failure"); }
    const model = connection.models.find((entry) => entry.id === value.candidate.model.id)!;
    if (value.activatedConfiguration) {
      model.activeConfig = adminProviderModelConfiguration(value.activatedConfiguration);
      model.draftConfig = model.activeConfig;
      model.activeVersion += 1;
      model.draftVersion += 1;
    }
    connection.activeChecks = connection.activeChecks.filter((entry) => entry.providerModelId !== model.id);
    connection.activeChecks.push({ checkedAt: NOW.toISOString(), connectionVersion: connection.activeVersion,
      credentialId: plan.credential.id, credentialVersionId: plan.credential.versionId, evidence: value.evidence,
      latestRefreshError: null, modelVersion: model.activeVersion, providerModelId: model.id,
      refreshFailedAt: null, status: value.status });
    return "stored";
  });
  const test = vi.fn(async (value: AdminProviderDraftTesterInput) => {
    expect(value.initialSetup).toBe(true);
    onCheck?.();
    const available = value.model.upstreamModelId !== unavailable;
    const evidence: AdminProviderTestEvidence = { detail: available ? "ok" : "model_missing",
      method: "tiny_generation", selectedProviders: [], upstreamModelId: value.model.upstreamModelId,
      capabilitySetup: { policyVersion: 2, checks: { modelAccess: available ? "verified" : "incomplete",
        toolCalling: "unsupported", forcedToolCall: "unsupported", structuredOutput: "unsupported",
        parallelToolCalls: "unsupported", vision: "unsupported", directPdf: "unsupported", streaming: available ? "verified" : "not_checked" } },
      compatibility: { probeVersion: 2, modelAccess: available ? "verified" : "not_supported",
        streaming: available ? "verified" : "not_supported", usage: available ? "verified" : "not_supported",
        directPdf: "not_supported", structuredOutput: "not_supported" } };
    return { evidence, status: available ? "available" as const : "unavailable" as const };
  });
  const service = createAdminProviderService({ repository, tester: { test }, encryptionKey: () => KEY,
    checkConcurrency: 1, credentialTester: { async test() { throw new Error("unexpected_catalog"); } } });
  const commit = vi.fn(async (value: AdminProviderCustomSetupCommitPlan) => {
    plan = value;
    const stamp = NOW.toISOString();
    const config = adminProviderConnectionConfiguration(plan.connection.configuration);
    connection = {
      activatedAt: stamp, activeVersion: 1, activeConfig: config, draftVersion: 1, draftConfig: config,
      assignments: [], credentials: [{ activatedAt: stamp, activeVersion: { activatedAt: stamp, id: plan.credential.versionId,
        revokedAt: null, testedAt: stamp, version: 1 }, createdAt: stamp, draftSecretConfigured: false, draftVersion: 1,
        enabled: true, id: plan.credential.id, label: "Main", testedAt: stamp, updatedAt: stamp }],
      createdAt: stamp, defaultCredentialId: plan.credential.id, displayName: "Custom", draftChecks: [], enabled: true,
      family: "openai_compatible", id: plan.connection.id, unassignedPolicy: "use_default", updatedAt: stamp, userAssignments: [],
      models: plan.models.map((model) => ({ activatedAt: stamp, activeConfig: adminProviderModelConfiguration(model.configuration),
        activeVersion: 1, connectionId: plan.connection.id, createdAt: stamp, displayName: model.displayName,
        draftConfig: adminProviderModelConfiguration(model.configuration), draftVersion: 1, enabled: true, id: model.id, updatedAt: stamp })),
      activeChecks: plan.models.map((model) => ({ checkedAt: stamp, connectionVersion: 1, credentialId: plan.credential.id,
        credentialVersionId: plan.credential.versionId, evidence: model.evidence, latestRefreshError: null,
        modelVersion: 1, providerModelId: model.id, refreshFailedAt: null, status: model.status ?? "available" }))
    };
    return { status: "ready" as const, defaultChanged: false };
  });
  const custom = createAdminProviderCustomSetupService({ encryptionKey: () => KEY,
    proofKey: () => PROOF_KEY,
    idFactory: () => `synthetic-${++nextId}`, now: () => NOW,
    repository: { commit }, tester: { test: async () => { throw new Error("unexpected_prepublication_probe"); } },
    finishInitialSetup: (value) => service.finishInitialSetup(value) });
  return { custom, service, test, store, commit, connection: () => connection,
    recover: () => { unavailable = ""; }, failSave: () => { failSave = true; }, onCheck: (callback: () => void) => { onCheck = callback; } };
}

const request = { allowPrivateNetwork: false, apiRoot: "https://provider.example.test/v1", authenticationMode: "bearer" as const,
  confirmPaidRequest: true as const, modelIds: ["model-a", "model-b", "model-c", "model-d"], protocol: "responses" as const,
  responseTimeoutSeconds: 300, secret: "synthetic-secret",
  perModelCapabilities: { "model-a": { contextWindow: 272_000, maxOutputTokens: 65_536 }, "model-b": { contextWindow: 128_000 } } };

describe("initial setup per-model publication and retry", () => {
  it("preserves the model-bound Codex search proof across activation and check publication", async () => {
    const f = fixture();
    const ordinaryTest = f.test.getMockImplementation()!;
    f.test.mockImplementation(async (value) => {
      const outcome = await ordinaryTest(value);
      return { ...outcome, evidence: { ...outcome.evidence,
        capabilitySetup: { ...outcome.evidence.capabilitySetup!, checks: { ...outcome.evidence.capabilitySetup!.checks,
          codexWebSearch: "verified" } },
        codexWebSearch: { adapterKind: "openai_responses_compatible", sourceCount: 1, probeVersion: 1,
          upstreamModelId: value.model.upstreamModelId, verified: true } as const
      } };
    });
    await f.custom.setup({ actor: { sessionId: "session", userId: "admin" },
      request: { ...request, apiRoot: "https://provider.example.test/backend-api/codex", modelIds: ["model-a"] } });
    expect(f.connection().models[0]!.activeConfig?.capabilities).toMatchObject({ codexStandaloneWebSearch: true, nativeSearch: false });
    expect(f.store.mock.calls.at(-1)?.[0].evidence.codexWebSearch).toEqual({
      adapterKind: "openai_responses_compatible", sourceCount: 1, probeVersion: 1, upstreamModelId: "model-a", verified: true
    });
    expect(f.connection().activeChecks.find((check) => check.providerModelId === f.connection().models[0]!.id)
      ?.evidence?.codexWebSearch?.verified).toBe(true);
  });

  it("checks every detected codex-lb model and publishes only its successful Search capability", async () => {
    const f = fixture();
    const ordinaryTest = f.test.getMockImplementation()!;
    f.test.mockImplementation(async (value) => {
      expect(value.connection.responsesRequestIsolationDetected).toBe(true);
      const outcome = await ordinaryTest(value);
      const supportsSearch = value.model.upstreamModelId === "model-a";
      return { ...outcome, evidence: { ...outcome.evidence,
        capabilitySetup: { ...outcome.evidence.capabilitySetup!, checks: { ...outcome.evidence.capabilitySetup!.checks,
          hostedSearch: supportsSearch ? "verified" : "incomplete" } },
        ...(supportsSearch ? { hostedSearch: { adapterKind: "openai_responses_compatible", normalizedSourceCount: 1,
          probeVersion: 1, upstreamModelId: value.model.upstreamModelId, verified: true } as const } : {})
      } };
    });
    const catalogProof = createCustomSetupCatalogProof({ endpoint: request.apiRoot, key: PROOF_KEY, now: NOW.valueOf(),
      responsesRequestIsolationDetected: true, secret: request.secret, userId: "admin" });
    const result = await f.custom.setup({ actor: { sessionId: "session", userId: "admin" },
      request: { ...request, catalogProof, modelIds: ["model-a", "model-b"] } });
    expect(result.outcome).toBe("partial");
    expect(f.test.mock.calls.map(([value]) => value.model.upstreamModelId)).toEqual(["model-a", "model-b", "gpt-image-2"]);
    expect(f.connection().models.filter(model => model.activeConfig?.modelClass === "answer")
      .map((model) => model.activeConfig?.capabilities.nativeSearch)).toEqual([true, false]);
    const checkFor = (upstreamModelId: string) => f.connection().activeChecks.find(check =>
      check.providerModelId === f.connection().models.find(model => model.activeConfig?.upstreamModelId === upstreamModelId)?.id);
    expect(checkFor("model-a")).toMatchObject({ status: "available", evidence: { hostedSearch: { verified: true } } });
    expect(checkFor("model-b")?.status).toBe("available");
    expect(checkFor("gpt-image-2")?.status).toBe("unavailable");
  });

  it("persists three usable models, preserves each limit, then retries only the fourth without recreating ids", async () => {
    const f = fixture();
    const result = await f.custom.setup({ actor: { sessionId: "session", userId: "admin" }, request });
    expect(result.outcome).toBe("partial");
    expect(f.connection().activeChecks.map((check) => check.status)).toEqual(["available", "available", "available", "unavailable"]);
    expect(f.connection().models[0]!.activeConfig?.capabilities.contextWindow).toBe(272_000);
    expect(f.connection().models[1]!.activeConfig?.capabilities.contextWindow).toBe(128_000);
    f.recover();
    const run = await f.service.startCheckRun({ connectionId: result.connectionId,
      credentialId: result.checkRun!.credentialId, reason: "requested", retryUnresolved: true });
    await vi.waitFor(() => expect(f.service.checkRun({ connectionId: result.connectionId, runId: run.id }).state).toBe("completed"));
    expect(f.test.mock.calls.map(([value]) => value.model.upstreamModelId)).toEqual(["model-a", "model-b", "model-c", "model-d", "model-d"]);
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.connection().activeChecks.every((check) => check.status === "available")).toBe(true);
  });

  it("reports publication failure and retries its exact paid result without a second provider check", async () => {
    const f = fixture();
    f.recover(); f.failSave();
    const result = await f.custom.setup({ actor: { sessionId: "session", userId: "admin" }, request: { ...request, modelIds: ["model-a"] } });
    expect(result.outcome).toBe("partial");
    expect(result.checkRun?.results?.[0]?.state).toBe("save_failed");
    const run = await f.service.startCheckRun({ connectionId: result.connectionId,
      credentialId: result.checkRun!.credentialId, reason: "requested", retryUnresolved: true });
    await vi.waitFor(() => expect(f.service.checkRun({ connectionId: result.connectionId, runId: run.id }).state).toBe("completed"));
    expect(f.test).toHaveBeenCalledOnce();
    expect(f.connection().activeChecks[0]!.status).toBe("available");
  });

  it("keeps the saved graph while cancellation fences late results and queued dispatch", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.onCheck(() => controller.abort());
    const result = await f.custom.setup({ actor: { sessionId: "session", userId: "admin" }, request, signal: controller.signal });
    expect(result.outcome).toBe("cancelled");
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.store).not.toHaveBeenCalled();
    expect(f.test).toHaveBeenCalledOnce();
    expect(f.connection().activeChecks.every((check) => check.status === "unavailable")).toBe(true);
  });
});
