import { describe, expect, it, vi } from "vitest";
import type { AdminProviderConnection } from "../../../contracts/adminProviders";
import { encryptProviderCredentialSecret } from "../../providers/credentialSecrets";
import type { AdminProviderCredentialTester } from "./credentialTester";
import type {
  AdminProviderRepository,
  ProviderActiveRefreshCandidate,
  ProviderModelActivationCandidate
} from "./repositoryContract";
import { createAdminProviderService } from "./service";
import type { AdminProviderDraftTester, AdminProviderDraftTesterInput } from "./tester";
import { providerSetupModels } from "./setupModels";
import { adminProviderModelConfiguration } from "./adminConfiguration";

/**
 * Model `Test & Save` (PRD B2) and background capability checks (PRD B3)
 * through the service with a fake tester: activation, evidence CAS, transient
 * failures that keep prior evidence, cancellation, interrupted recovery and
 * the per-connection concurrency bound.
 */

const KEY = Buffer.alloc(32, 7);
const NOW = new Date("2026-09-07T12:51:00.000Z");

const connectionConfiguration = {
  allowPrivateNetwork: false,
  apiRoot: "https://api.openai.com/v1",
  authenticationMode: "bearer" as const,
  responseTimeoutSeconds: 300
};

const storedConnectionConfiguration = {
  allowPrivateNetwork: false,
  apiRoot: "https://api.openai.com/v1",
  authenticationMode: "bearer" as const,
  responseTimeoutMs: 300_000
};

function modelConfiguration(upstreamModelId: string, modelClass: "answer" | "embedding" | "reranker" = "answer") {
  return {
    adapterKind: modelClass === "embedding"
      ? "openai_embeddings_compatible" as const
      : "openai_responses_native" as const,
    answerSelectable: modelClass === "answer",
    capabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      vision: false
    },
    defaultParams: {},
    ...(modelClass === "embedding"
      ? {
          embedding: {
            nativeDimension: 3_072,
            providerFamily: "openai" as const,
            queryInstructionTemplate: null,
            supportsMrl: true,
            targetDimension: 1_536
          }
        }
      : {}),
    modelClass,
    upstreamModelId
  };
}

const envelope = encryptProviderCredentialSecret({
  credentialId: "cred-primary",
  key: KEY,
  secret: "primary-secret",
  valueId: "version-primary"
});

function model(id: string, upstreamModelId: string, overrides: Partial<AdminProviderConnection["models"][number]> = {}) {
  const configuration = modelConfiguration(upstreamModelId);
  return {
    activatedAt: NOW.toISOString(),
    activeConfig: configuration,
    activeVersion: 1,
    connectionId: "conn-openai",
    createdAt: NOW.toISOString(),
    displayName: upstreamModelId,
    draftConfig: configuration,
    draftVersion: 1,
    enabled: true,
    id,
    modelClass: "answer" as const,
    updatedAt: NOW.toISOString(),
    ...overrides
  };
}

function connection(overrides: Partial<AdminProviderConnection> = {}): AdminProviderConnection {
  return {
    activatedAt: NOW.toISOString(),
    activeChecks: [],
    activeConfig: connectionConfiguration,
    activeVersion: 1,
    assignments: [],
    createdAt: NOW.toISOString(),
    credentials: [{
      activatedAt: NOW.toISOString(),
      activeVersion: {
        activatedAt: NOW.toISOString(),
        id: "version-primary",
        revokedAt: null,
        testedAt: NOW.toISOString(),
        version: 1
      },
      createdAt: NOW.toISOString(),
      draftSecretConfigured: false,
      draftVersion: 1,
      enabled: true,
      id: "cred-primary",
      label: "Primary",
      testedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString()
    }],
    defaultCredentialId: "cred-primary",
    displayName: "OpenAI",
    draftChecks: [],
    draftConfig: connectionConfiguration,
    draftVersion: 1,
    enabled: true,
    family: "openai",
    id: "conn-openai",
    models: [
      model("model-terra", "gpt-5.6-terra"),
      model("model-luna", "gpt-5.6-luna"),
      model("model-sol", "gpt-5.6-sol"),
      model("model-off", "gpt-5.5", { enabled: false }),
      model("model-draft", "gpt-5.4", { activeConfig: null, activeVersion: 0 })
    ],
    unassignedPolicy: "use_default",
    updatedAt: NOW.toISOString(),
    userAssignments: [],
    ...overrides
  };
}

function refreshCandidate(modelId: string, upstreamModelId: string): ProviderActiveRefreshCandidate {
  return {
    connection: {
      configuration: storedConnectionConfiguration,
      displayName: "OpenAI",
      family: "openai",
      id: "conn-openai",
      version: 1
    },
    credential: { envelope, id: "cred-primary", versionId: "version-primary" },
    model: {
      configuration: modelConfiguration(upstreamModelId),
      displayName: upstreamModelId,
      id: modelId,
      version: 1
    }
  };
}

function activationCandidate(
  overrides: Partial<ProviderModelActivationCandidate["connection"]> = {}
): ProviderModelActivationCandidate {
  return {
    connection: {
      activeVersion: 1,
      defaultCredential: { id: "cred-primary", usable: true },
      draftConfiguration: storedConnectionConfiguration,
      draftVersion: 1,
      family: "openai",
      id: "conn-openai",
      ...overrides
    },
    model: {
      configuration: modelConfiguration("gpt-5.6-sol"),
      displayName: "GPT-5.6 Sol",
      draftVersion: 2,
      id: "model-sol"
    }
  };
}

function repository(overrides: Partial<AdminProviderRepository> = {}): AdminProviderRepository {
  const catalog = connection();
  return {
    async addSetupModelsCas() { return "updated"; },
    async activateConnectionCas() { return "updated"; },
    async activateCredentialCas() { return "updated"; },
    async activateModelCas() { return "updated"; },
    async saveConnectionSettingsCas() { return "updated"; },
    async assignGroupCredential() { return "assigned"; },
    async createConnection() {},
    async createModel() { return "created"; },
    async deleteConnection() { return { status: "deleted" }; },
    async deleteCredential() { return { status: "deleted" }; },
    async deleteModel() { return { status: "deleted" }; },
    async disable() { return "disabled"; },
    async enable() { return "enabled"; },
    async listConnections() { return [catalog]; },
    async loadActivationCandidate() { return null; },
    async loadActiveRefreshCandidate(input) {
      const target = catalog.models.find(({ id }) => id === input.providerModelId);
      return target && target.activeConfig && input.credentialId === "cred-primary"
        ? refreshCandidate(target.id, target.draftConfig.upstreamModelId)
        : null;
    },
    async loadDiscoveryCandidate() { return null; },
    async loadModelActivationCandidate() { return activationCandidate(); },
    async renameCredential() { return "updated"; },
    async recordActiveRefreshFailureCas() { return "stored"; },
    async revokeCredentialVersion() { return "revoked"; },
    async revokeGroupCredential() { return "revoked"; },
    async setDefaultCredential() { return "updated"; },
    async storeActiveRefreshCas() { return "stored"; },
    async updateModelDraft() { return "updated"; },
    async withLockedCredential(_credentialId, _versionId, consume) {
      return consume({
        credentialId: "cred-primary",
        id: "version-primary",
        revokedAt: null,
        secretEnvelope: envelope
      });
    },
    ...overrides
  };
}

function okOutcome(input: AdminProviderDraftTesterInput) {
  return {
    evidence: {
      compatibility: {
        directPdf: "not_supported" as const,
        modelAccess: "verified" as const,
        probeVersion: 1 as const,
        streaming: "verified" as const,
        structuredOutput: "not_supported" as const,
        usage: "verified" as const
      },
      detail: "ok" as const,
      method: "tiny_generation" as const,
      selectedProviders: [],
      upstreamModelId: input.model.upstreamModelId
    },
    status: "available" as const
  };
}

function credentialTester(): AdminProviderCredentialTester {
  return {
    async test() {
      return { method: "models_catalog", modelIds: ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol"] };
    }
  };
}

function service(
  providerRepository: AdminProviderRepository,
  tester: AdminProviderDraftTester,
  options: { checkConcurrency?: number; credentialTester?: AdminProviderCredentialTester } = {}
) {
  let runIndex = 0;
  let index = 0;
  return createAdminProviderService({
    checkConcurrency: options.checkConcurrency,
    checkRunIdFactory: () => `run-${++runIndex}`,
    credentialTester: options.credentialTester ?? credentialTester(),
    encryptionKey: () => KEY,
    idFactory: () => `generated-${++index}`,
    now: () => NOW,
    repository: providerRepository,
    tester
  });
}

async function waitFor(predicate: () => boolean, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition not met");
}

describe("model Test & Save (B2)", () => {
  it("activates only that model through the narrow CAS, then checks it with the default key", async () => {
    const activateModelCas = vi.fn<AdminProviderRepository["activateModelCas"]>(async () => "updated");
    const storeActiveRefreshCas = vi.fn<AdminProviderRepository["storeActiveRefreshCas"]>(async () => "stored");
    const test = vi.fn(async (input: AdminProviderDraftTesterInput) => okOutcome(input));
    const providers = service(repository({ activateModelCas, storeActiveRefreshCas }), { test });

    await expect(providers.activateModel({ connectionId: "conn-openai", modelId: "model-sol" }))
      .resolves.toEqual({ check: "checked" });
    expect(activateModelCas).toHaveBeenCalledWith({
      connection: { activateDraft: null, id: "conn-openai" },
      enable: true,
      initialSetup: false,
      model: expect.objectContaining({ draftVersion: 2, id: "model-sol" }),
      now: NOW,
      signal: undefined
    });
    expect(test).toHaveBeenCalledOnce();
    expect(test.mock.calls[0]![0]).toMatchObject({
      credentialId: "cred-primary",
      credentialVersionIdentity: "version-primary",
      mode: "tiny_generation",
      providerModelId: "model-sol"
    });
    expect(storeActiveRefreshCas).toHaveBeenCalledWith(expect.objectContaining({
      candidate: expect.objectContaining({ model: expect.objectContaining({ id: "model-sol" }) }),
      status: "available"
    }));
    const [catalog] = await providers.listConnections();
    expect(catalog?.checkRun).toMatchObject({
      credentialId: "cred-primary",
      done: 1,
      failed: [],
      reason: "model",
      state: "completed",
      total: 1
    });
  });

  it("takes a never-activated connection live with the model and skips the check without a usable key", async () => {
    const activateModelCas = vi.fn<AdminProviderRepository["activateModelCas"]>(async () => "updated");
    const test = vi.fn();
    const providers = service(repository({
      activateModelCas,
      async loadModelActivationCandidate() {
        return activationCandidate({ activeVersion: 0, defaultCredential: { id: "cred-primary", usable: false }, draftVersion: 3 });
      }
    }), { test });

    await expect(providers.activateModel({ connectionId: "conn-openai", modelId: "model-sol" }))
      .resolves.toEqual({ check: "skipped" });
    expect(activateModelCas.mock.calls[0]![0].connection).toEqual({
      activateDraft: { configuration: storedConnectionConfiguration, draftVersion: 3 },
      id: "conn-openai"
    });
    expect(test).not.toHaveBeenCalled();
  });

  it("keeps the activation on a temporary check failure and reports Check failed through the catalog", async () => {
    const recordActiveRefreshFailureCas = vi.fn<AdminProviderRepository["recordActiveRefreshFailureCas"]>(async () => "stored");
    const storeActiveRefreshCas = vi.fn<AdminProviderRepository["storeActiveRefreshCas"]>(async () => "stored");
    const providers = service(repository({ recordActiveRefreshFailureCas, storeActiveRefreshCas }), {
      async test() { throw new Error("upstream 503 with private details"); }
    });

    await expect(providers.activateModel({ connectionId: "conn-openai", modelId: "model-sol" }))
      .resolves.toEqual({ check: "failed" });
    expect(recordActiveRefreshFailureCas).toHaveBeenCalledWith({
      candidate: expect.objectContaining({ model: expect.objectContaining({ id: "model-sol" }) }),
      failedAt: NOW
    });
    expect(storeActiveRefreshCas).not.toHaveBeenCalled();
    const [catalog] = await providers.listConnections();
    expect(catalog?.checkRun).toMatchObject({ failed: ["model-sol"], state: "completed" });
    expect(JSON.stringify(catalog?.checkRun)).not.toContain("503");
  });

  it("rejects a stale or missing model before any provider call", async () => {
    const test = vi.fn();
    const stale = service(repository({ async activateModelCas() { return "stale"; } }), { test });
    await expect(stale.activateModel({ connectionId: "conn-openai", modelId: "model-sol" }))
      .rejects.toMatchObject({ code: "provider_draft_stale" });
    const missing = service(repository({ async loadModelActivationCandidate() { return null; } }), { test });
    await expect(missing.activateModel({ connectionId: "conn-openai", modelId: "model-x" }))
      .rejects.toMatchObject({ code: "provider_model_not_found" });
    expect(test).not.toHaveBeenCalled();
  });
});

describe("background capability checks (B3)", () => {
  it.each(["requested", "setup"] as const)("adds and checks missing dedicated models on %s without replacing the key or enabling disabled models", async (reason) => {
    const presets = providerSetupModels("openrouter");
    const catalog = connection({ family: "openrouter", models: presets.filter((preset) => preset.configuration.modelClass === "answer")
      .map((preset) => model(preset.modelId, preset.configuration.upstreamModelId, {
        activeConfig: adminProviderModelConfiguration(preset.configuration),
        draftConfig: adminProviderModelConfiguration(preset.configuration), enabled: false
      })) });
    const addSetupModelsCas = vi.fn<AdminProviderRepository["addSetupModelsCas"]>(async (write) => {
      for (const addition of write.models) catalog.models.push(model(addition.id, addition.configuration.upstreamModelId, {
        activeConfig: adminProviderModelConfiguration(addition.configuration),
        draftConfig: adminProviderModelConfiguration(addition.configuration), modelClass: addition.configuration.modelClass
      }));
      return "updated";
    });
    const activateCredentialCas = vi.fn<AdminProviderRepository["activateCredentialCas"]>();
    const test = vi.fn<AdminProviderDraftTester["test"]>(async (input) => ({
      ...okOutcome(input), evidence: { ...okOutcome(input).evidence,
        ...(input.model.modelClass === "embedding" ? { embedding: {
          probeVersion: 1, dimensions: 1536, document: true, query: true
        } } : { reranking: { probeVersion: 1, completeScores: true } })
      }
    }));
    const catalogTest = vi.fn<AdminProviderCredentialTester["test"]>(async () => ({
      method: "models_catalog", modelIds: [], modelIdsByClass: {
        answer: [], embedding: ["qwen/qwen3-embedding-8b"], reranker: ["voyageai/rerank-2.5"]
      }
    }));
    const providers = service(repository({ addSetupModelsCas, activateCredentialCas, listConnections: async () => [catalog],
      loadActiveRefreshCandidate: async ({ providerModelId }) => {
        const selected = presets.find((preset) => preset.configuration.upstreamModelId ===
          catalog.models.find((model) => model.id === providerModelId)?.activeConfig?.upstreamModelId)!;
        return { ...refreshCandidate(providerModelId, selected.configuration.upstreamModelId),
          connection: { ...refreshCandidate(providerModelId, "").connection, family: "openrouter" },
          model: { configuration: selected.configuration, displayName: selected.displayName, id: providerModelId, version: 1 }
        };
      }
    }), { test }, { credentialTester: { test: catalogTest } });
    const run = await providers.startCheckRun({ connectionId: catalog.id, credentialId: "cred-primary", reason });
    await waitFor(() => providers.checkRun({ connectionId: catalog.id, runId: run.id }).state === "completed");
    expect(addSetupModelsCas).toHaveBeenCalledWith(expect.objectContaining({ connectionVersion: 1,
      credentialId: "cred-primary", credentialVersionId: "version-primary" }));
    expect(test.mock.calls.map(([input]) => input.model.modelClass).sort()).toEqual(["embedding", "reranker"]);
    expect(activateCredentialCas).not.toHaveBeenCalled();
    const retry = await providers.startCheckRun({ connectionId: catalog.id, credentialId: "cred-primary", reason });
    await waitFor(() => providers.checkRun({ connectionId: catalog.id, runId: retry.id }).state === "completed");
    expect(addSetupModelsCas).toHaveBeenCalledOnce();
    expect(catalogTest).toHaveBeenCalledOnce();
  });

  it("checks every enabled active model with the key, three at a time, and stores each result", async () => {
    const gates = new Map<string, () => void>();
    let active = 0;
    let peak = 0;
    const storeActiveRefreshCas = vi.fn<AdminProviderRepository["storeActiveRefreshCas"]>(async () => "stored");
    const providers = service(repository({
      async listConnections() {
        return [connection({ models: [
          model("m1", "gpt-1"), model("m2", "gpt-2"), model("m3", "gpt-3"), model("m4", "gpt-4"),
          model("off", "gpt-off", { enabled: false }),
          model("draft", "gpt-draft", { activeConfig: null, activeVersion: 0 })
        ] })];
      },
      async loadActiveRefreshCandidate(input) {
        return refreshCandidate(input.providerModelId, `gpt-${input.providerModelId.slice(1)}`);
      },
      storeActiveRefreshCas
    }), {
      async test(input) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => gates.set(input.providerModelId, resolve));
        active -= 1;
        return okOutcome(input);
      }
    });

    const run = await providers.startCheckRun({ connectionId: "conn-openai", credentialId: "cred-primary", reason: "requested" });
    expect(run).toMatchObject({ credentialId: "cred-primary", done: 0, reason: "requested", state: "running", total: 4 });
    await waitFor(() => gates.size === 3);
    expect(peak).toBe(3);
    expect(gates.has("m4")).toBe(false);
    expect(providers.checkRun({ connectionId: "conn-openai", runId: run.id })).toMatchObject({
      current: "m1",
      inFlight: ["m1", "m2", "m3"]
    });
    // A second request for the same key joins the running check instead of paying twice.
    await expect(providers.startCheckRun({ connectionId: "conn-openai", credentialId: "cred-primary", reason: "requested" }))
      .resolves.toMatchObject({ id: run.id });

    for (const modelId of ["m1", "m2", "m3"]) gates.get(modelId)!();
    await waitFor(() => gates.has("m4"));
    gates.get("m4")!();
    await waitFor(() => providers.checkRun({ connectionId: "conn-openai", runId: run.id }).state === "completed");
    expect(storeActiveRefreshCas).toHaveBeenCalledTimes(4);
    expect(providers.checkRun({ connectionId: "conn-openai", runId: run.id })).toMatchObject({
      done: 4,
      failed: [],
      inFlight: [],
      state: "completed",
      total: 4
    });
    const [catalog] = await providers.listConnections();
    expect(catalog?.checkRun?.id).toBe(run.id);
  });

  it.each([
    { label: "an explicit recheck of current initial evidence", modelVersion: 1, retryUnresolved: false },
    { label: "a setup retry after a later model override", modelVersion: 2, retryUnresolved: true }
  ])("preserves disabled features on $label", async ({ modelVersion, retryUnresolved }) => {
    const target = model("model-sol", "gpt-5.6-sol", { activeVersion: modelVersion, draftVersion: modelVersion });
    const catalog = connection({ models: [target], activeChecks: [{
      checkedAt: NOW.toISOString(), connectionVersion: 1, credentialId: "cred-primary", credentialVersionId: "version-primary",
      evidence: { detail: "model_missing", method: "tiny_generation", selectedProviders: [], upstreamModelId: "gpt-5.6-sol",
        capabilitySetup: { policyVersion: 1, checks: { modelAccess: "incomplete", directPdf: "verified", vision: "verified" } } },
      latestRefreshError: null, refreshFailedAt: null, modelVersion: 1, providerModelId: target.id, status: "unavailable"
    }] });
    const test = vi.fn<AdminProviderDraftTester["test"]>(async (input) => okOutcome(input));
    const store = vi.fn<AdminProviderRepository["storeActiveRefreshCas"]>(async () => "stored");
    const providers = service(repository({ listConnections: async () => [catalog], storeActiveRefreshCas: store,
      loadActiveRefreshCandidate: async () => ({ ...refreshCandidate(target.id, "gpt-5.6-sol"),
        model: { ...refreshCandidate(target.id, "gpt-5.6-sol").model, version: modelVersion, draftVersion: modelVersion } })
    }), { test });
    const run = await providers.startCheckRun({ connectionId: catalog.id, credentialId: "cred-primary",
      modelIds: [target.id], reason: "requested", retryUnresolved });
    await waitFor(() => providers.checkRun({ connectionId: catalog.id, runId: run.id }).state === "completed");
    expect(test).toHaveBeenCalledOnce();
    expect(test.mock.calls[0]![0].initialSetup).not.toBe(true);
    expect(test.mock.calls[0]![0].model.capabilities).toMatchObject({ nativePdfInput: false, vision: false });
    expect(store).toHaveBeenCalledOnce();
    expect(store.mock.calls[0]![0].activatedConfiguration).toBeUndefined();
  });

  it.each(["credential", "endpoint"] as const)("rechecks all initial capabilities after a changed %s without reusing old proof", async (changed) => {
    const target = model("model-sol", "gpt-5.6-sol");
    const catalog = connection({ models: [target], activeChecks: [{
      checkedAt: NOW.toISOString(), connectionVersion: 1, credentialId: "cred-primary", credentialVersionId: "version-primary",
      evidence: { detail: "ok", method: "tiny_generation", selectedProviders: [], upstreamModelId: "gpt-5.6-sol",
        compatibility: { modelAccess: "verified", probeVersion: 1, directPdf: "not_supported", structuredOutput: "not_supported", streaming: "not_supported", usage: "verified" },
        capabilitySetup: { policyVersion: 1, checks: { modelAccess: "verified", directPdf: "incomplete" } } },
      latestRefreshError: null, refreshFailedAt: null, modelVersion: 1, providerModelId: target.id, status: "available"
    }] });
    const originalCandidate = refreshCandidate(target.id, "gpt-5.6-sol");
    const candidate: ProviderActiveRefreshCandidate = {
      ...originalCandidate,
      ...(changed === "credential" ? { credential: { ...originalCandidate.credential, versionId: "version-replaced" } }
        : { connection: { ...originalCandidate.connection,
          configuration: { ...storedConnectionConfiguration, apiRoot: "https://replacement.example/v1" }, version: 2 } })
    };
    if (changed === "credential") {
      catalog.credentials[0]!.activeVersion!.id = "version-replaced";
    } else {
      catalog.activeVersion = 2;
      catalog.activeConfig = { ...connectionConfiguration, apiRoot: "https://replacement.example/v1" };
    }
    const test = vi.fn<AdminProviderDraftTester["test"]>(async (input) => okOutcome(input));
    const providers = service(repository({ listConnections: async () => [catalog],
      loadActiveRefreshCandidate: async () => candidate
    }), { test });
    const run = await providers.startCheckRun({ connectionId: catalog.id, credentialId: "cred-primary",
      modelIds: [target.id], reason: "requested", retryUnresolved: true });
    await waitFor(() => providers.checkRun({ connectionId: catalog.id, runId: run.id }).state === "completed");
    expect(test).toHaveBeenCalledOnce();
    expect(test.mock.calls[0]![0].initialSetup).toBe(true);
    expect(test.mock.calls[0]![0].reuseSetupEvidence).toBeUndefined();
  });

  it("classifies a transient failure without touching prior evidence and lets Retry clear it", async () => {
    const recordActiveRefreshFailureCas = vi.fn<AdminProviderRepository["recordActiveRefreshFailureCas"]>(async () => "stored");
    const storeActiveRefreshCas = vi.fn<AdminProviderRepository["storeActiveRefreshCas"]>(async () => "stored");
    let attempt = 0;
    const providers = service(repository({ recordActiveRefreshFailureCas, storeActiveRefreshCas }), {
      async test(input) {
        attempt += 1;
        if (input.providerModelId === "model-luna" && attempt <= 3) throw new Error("rate limited");
        return okOutcome(input);
      }
    });

    const run = await providers.startCheckRun({ connectionId: "conn-openai", credentialId: "cred-primary", reason: "credential" });
    await waitFor(() => providers.checkRun({ connectionId: "conn-openai", runId: run.id }).state === "completed");
    expect(recordActiveRefreshFailureCas).toHaveBeenCalledOnce();
    expect(recordActiveRefreshFailureCas.mock.calls[0]![0].candidate.model.id).toBe("model-luna");
    expect(storeActiveRefreshCas).toHaveBeenCalledTimes(2);
    expect(providers.checkRun({ connectionId: "conn-openai", runId: run.id })).toMatchObject({
      done: 3,
      failed: ["model-luna"],
      total: 3
    });

    const retry = await providers.startCheckRun({
      connectionId: "conn-openai",
      credentialId: "cred-primary",
      modelIds: ["model-luna"],
      reason: "model"
    });
    await waitFor(() => providers.checkRun({ connectionId: "conn-openai", runId: retry.id }).state === "completed");
    expect(providers.checkRun({ connectionId: "conn-openai", runId: retry.id })).toMatchObject({ failed: [], total: 1 });
    expect(storeActiveRefreshCas).toHaveBeenCalledTimes(3);
  });

  it("stops a run on cancel: queued models are skipped and aborted checks write nothing", async () => {
    const signals: AbortSignal[] = [];
    const recordActiveRefreshFailureCas = vi.fn<AdminProviderRepository["recordActiveRefreshFailureCas"]>(async () => "stored");
    const storeActiveRefreshCas = vi.fn<AdminProviderRepository["storeActiveRefreshCas"]>(async () => "stored");
    const providers = service(repository({ recordActiveRefreshFailureCas, storeActiveRefreshCas }), {
      test(input) {
        signals.push(input.signal!);
        return new Promise((_resolve, reject) => {
          input.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
    }, { checkConcurrency: 1 });

    const run = await providers.startCheckRun({ connectionId: "conn-openai", credentialId: "cred-primary", reason: "requested" });
    await waitFor(() => signals.length === 1);
    expect(providers.cancelCheckRun({ connectionId: "conn-openai", runId: run.id })).toMatchObject({ state: "cancelled" });
    await waitFor(() => providers.checkRun({ connectionId: "conn-openai", runId: run.id }).inFlight.length === 0);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(recordActiveRefreshFailureCas).not.toHaveBeenCalled();
    expect(storeActiveRefreshCas).not.toHaveBeenCalled();
    expect(providers.checkRun({ connectionId: "conn-openai", runId: run.id })).toMatchObject({
      done: 1,
      failed: [],
      state: "cancelled",
      total: 3
    });
    expect(() => providers.cancelCheckRun({ connectionId: "conn-other", runId: run.id }))
      .toThrow(expect.objectContaining({ code: "provider_check_run_not_found" }));
  });

  it("reports a run this process never saw as interrupted and lets it be started again", async () => {
    const providers = service(repository(), { async test(input) { return okOutcome(input); } });
    expect(providers.checkRun({ connectionId: "conn-openai", runId: "run-from-before-restart" }))
      .toMatchObject({ id: "run-from-before-restart", state: "interrupted", total: 0 });
    const restarted = await providers.startCheckRun({ connectionId: "conn-openai", credentialId: "cred-primary", reason: "requested" });
    expect(restarted.state).toBe("running");
    await waitFor(() => providers.checkRun({ connectionId: "conn-openai", runId: restarted.id }).state === "completed");
  });

  it("refuses an unusable key and starts automatically after a key is saved", async () => {
    const test = vi.fn(async (input: AdminProviderDraftTesterInput) => okOutcome(input));
    const providers = service(repository(), { test });
    await expect(providers.startCheckRun({ connectionId: "conn-openai", credentialId: "cred-missing", reason: "requested" }))
      .rejects.toMatchObject({ code: "provider_credential_not_found" });
    await expect(providers.startCheckRun({ connectionId: "conn-missing", credentialId: "cred-primary", reason: "requested" }))
      .rejects.toMatchObject({ code: "provider_connection_not_found" });
    expect(test).not.toHaveBeenCalled();

    const rotated = service(repository(), { test });
    await rotated.activateRotatedCredential({
      connectionId: "conn-openai",
      credentialId: "cred-primary",
      expectedDraftVersion: 1,
      secret: "rotated-secret"
    });
    await waitFor(() => test.mock.calls.length === 3);
    const [catalog] = await rotated.listConnections();
    expect(catalog?.checkRun).toMatchObject({ credentialId: "cred-primary", reason: "credential", total: 3 });
  });

  it("recovers a saved first key at the unchanged endpoint and starts checks without asking for the secret", async () => {
    let catalog = connection({ activeConfig: null, activeVersion: 0, enabled: false });
    catalog.models = catalog.models.slice(0, 3).map((model) => ({ ...model, activeConfig: null, activeVersion: 0, enabled: false }));
    const activateCredentialCas = vi.fn<AdminProviderRepository["activateCredentialCas"]>(async (write) => {
      expect(write.bootstrap).toBeDefined();
      catalog = { ...catalog, activeConfig: catalog.draftConfig, activeVersion: 1, enabled: true,
        models: catalog.models.map((model) => ({ ...model, activeConfig: model.draftConfig, activeVersion: 1, enabled: true })) };
      return "updated";
    });
    const test = vi.fn(async (input: AdminProviderDraftTesterInput) => okOutcome(input));
    const providers = service(repository({ activateCredentialCas, async listConnections() { return [catalog]; } }), { test });
    const run = await providers.startCheckRun({ connectionId: catalog.id, credentialId: "cred-primary", reason: "requested" });
    await waitFor(() => providers.checkRun({ connectionId: catalog.id, runId: run.id }).state === "completed");
    expect(activateCredentialCas).toHaveBeenCalledOnce();
    expect(run.total).toBe(3);
    expect(test).toHaveBeenCalledTimes(3);
  });

  it.each([
    { draftVersion: 2 },
    { draftConfig: { ...connectionConfiguration, apiRoot: "https://changed.example.test/v1" } },
    { family: "openai_compatible" as const }
  ])("refuses saved-key recovery after endpoint or setup changes: %j", async (change) => {
    const catalog = connection({ activeConfig: null, activeVersion: 0, ...change });
    const activateCredentialCas = vi.fn<AdminProviderRepository["activateCredentialCas"]>();
    const test = vi.fn<AdminProviderDraftTester["test"]>();
    const providers = service(repository({ activateCredentialCas, async listConnections() { return [catalog]; } }), { test });
    await expect(providers.startCheckRun({ connectionId: catalog.id, credentialId: "cred-primary", reason: "requested" }))
      .rejects.toMatchObject({ code: "provider_endpoint_keys_required" });
    expect(activateCredentialCas).not.toHaveBeenCalled();
    expect(test).not.toHaveBeenCalled();
  });
});

describe("no-auth background checks", () => {
  it("checks an explicit no-auth endpoint with a null secret and publishes the result", async () => {
    const active = refreshCandidate("model-sol", "sol");
    const noAuth = { ...storedConnectionConfiguration, allowPrivateNetwork: true, apiRoot: "http://127.0.0.1:9000/v1", authenticationMode: "none" as const };
    const candidate: ProviderActiveRefreshCandidate = {
      ...active,
      connection: { ...active.connection, configuration: noAuth, family: "openai_compatible" },
      credential: { ...active.credential, envelope: null },
      model: { ...active.model, configuration: { ...modelConfiguration("sol"), adapterKind: "openai_responses_compatible" } }
    };
    const storeActiveRefreshCas = vi.fn<AdminProviderRepository["storeActiveRefreshCas"]>(async () => "stored");
    const test = vi.fn<AdminProviderDraftTester["test"]>(async () => ({
      evidence: { detail: "ok", method: "tiny_generation", selectedProviders: [], upstreamModelId: "sol" }, status: "available"
    }));
    const providers = service(repository({ loadActiveRefreshCandidate: async () => candidate, storeActiveRefreshCas }), { test });
    const run = await providers.startCheckRun({ connectionId: "conn-openai", credentialId: "cred-primary", modelIds: ["model-sol"], reason: "requested" });
    await vi.waitFor(() => expect(providers.checkRun({ connectionId: "conn-openai", runId: run.id }).state).toBe("completed"));
    expect(test).toHaveBeenCalledWith(expect.objectContaining({ secret: null }));
    expect(storeActiveRefreshCas).toHaveBeenCalledOnce();
  });
});
