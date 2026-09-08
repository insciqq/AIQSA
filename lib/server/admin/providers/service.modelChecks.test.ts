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
  options: { checkConcurrency?: number } = {}
) {
  let runIndex = 0;
  let index = 0;
  return createAdminProviderService({
    checkConcurrency: options.checkConcurrency,
    checkRunIdFactory: () => `run-${++runIndex}`,
    credentialTester: credentialTester(),
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
      model: expect.objectContaining({ draftVersion: 2, id: "model-sol" }),
      now: NOW
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
