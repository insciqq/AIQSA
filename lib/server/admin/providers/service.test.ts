import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  decryptProviderCredentialSecret,
  encryptProviderCredentialSecret
} from "../../providers/credentialSecrets";
import type {
  AdminProviderRepository,
  ProviderActivationCandidate,
  ProviderActiveRefreshCandidate
} from "./repositoryContract";
import {
  AdminProviderServiceError,
  createAdminProviderService,
  providerCredentialDraftValueId
} from "./service";
import {
  createAdminProviderDraftTester,
  type AdminProviderDraftTester,
  type AdminProviderDraftTestOutcome
} from "./tester";
import { createOpenRouterDiscoveryClient } from "../../providers/openRouterDiscovery";
import type { AdminProviderCredentialTester } from "./credentialTester";
import type { AdminProviderConnection } from "../../../contracts/adminProviders";
import { createPrismaAdminProviderRepository } from "./prismaRepository";
import { approvedRerankerDeployments } from "./approvedRerankers";

const KEY = Buffer.alloc(32, 19);
const NOW = new Date("2026-07-23T12:00:00.000Z");

const connectionConfiguration = {
  allowPrivateNetwork: false,
  apiRoot: "https://compatible.example.test/v1/",
  authenticationMode: "bearer" as const,
  responseTimeoutSeconds: 300
};

const storedConnectionConfiguration = {
  allowPrivateNetwork: false,
  apiRoot: "https://compatible.example.test/v1/",
  authenticationMode: "bearer" as const,
  responseTimeoutMs: 300_000
};

const modelConfiguration = {
  adapterKind: "openai_responses_compatible" as const,
  answerSelectable: true,
  capabilities: {
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    vision: false
  },
  defaultParams: {},
  modelClass: "answer" as const,
  upstreamModelId: "vendor/model"
};

function adminConnection(): AdminProviderConnection {
  return {
    activatedAt: null,
    activeChecks: [],
    activeConfig: null,
    activeVersion: 0,
    assignments: [],
    createdAt: NOW.toISOString(),
    credentials: [],
    defaultCredentialId: null,
    displayName: "Compatible",
    draftChecks: [],
    draftConfig: connectionConfiguration,
    draftVersion: 3,
    enabled: false,
    family: "openai_compatible",
    id: "connection-1",
    models: [],
    unassignedPolicy: "use_default",
    updatedAt: NOW.toISOString(),
    userAssignments: []
  };
}

function repository(
  overrides: Partial<AdminProviderRepository> = {}
): AdminProviderRepository {
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
    async listConnections() { return []; },
    async loadActivationCandidate() { return null; },
    async loadActiveRefreshCandidate() { return null; },
    async loadDiscoveryCandidate() { return null; },
    async loadModelActivationCandidate() { return null; },
    async renameCredential() { return "updated"; },
    async recordActiveRefreshFailureCas() { return "stored"; },
    async revokeCredentialVersion() { return "revoked"; },
    async revokeGroupCredential() { return "revoked"; },
    async setDefaultCredential() { return "updated"; },
    async storeActiveRefreshCas() { return "stored"; },
    async updateModelDraft() { return "updated"; },
    async withLockedCredential() { return null; },
    ...overrides
  };
}

function tester(
  test: AdminProviderDraftTester["test"] = async (input) => ({
    evidence: {
      detail: "ok",
      method: input.mode === "account_catalog"
        ? "openrouter_account_catalog"
        : "tiny_generation",
      selectedProviders: input.model.openRouterRouting?.providers ?? [],
      upstreamModelId: input.model.upstreamModelId
    },
    status: "available"
  })
): AdminProviderDraftTester {
  return { test };
}

function credentialTester(
  test: AdminProviderCredentialTester["test"] = async () => ({
    method: "models_catalog",
    modelIds: ["vendor/model", "vendor/model-two"]
  })
): AdminProviderCredentialTester {
  return { test };
}

function service(
  providerRepository: AdminProviderRepository,
  providerTester: AdminProviderDraftTester = tester(),
  ids: string[] = ["generated-id"],
  providerCredentialTester: AdminProviderCredentialTester = credentialTester()
) {
  let index = 0;
  return createAdminProviderService({
    credentialTester: providerCredentialTester,
    encryptionKey: () => KEY,
    idFactory: () => ids[index++] ?? `generated-${index}`,
    now: () => NOW,
    repository: providerRepository,
    tester: providerTester
  });
}

function refreshCandidate(): ProviderActiveRefreshCandidate {
  return {
    connection: { configuration: storedConnectionConfiguration, displayName: "Compatible", family: "openai_compatible", id: "connection-1", version: 3 },
    credential: { envelope: "synthetic-envelope-not-dispatched", id: "credential-1", versionId: "version-1" },
    model: { configuration: modelConfiguration, displayName: "Model", id: "model-1", version: 4 }
  };
}

function activationCandidate(): ProviderActivationCandidate {
  return {
    connection: {
      activeConfiguration: null,
      configuration: storedConnectionConfiguration,
      displayName: "Compatible gateway",
      draftVersion: 3,
      family: "openai_compatible",
      id: "connection-1"
    },
    credentials: [
      {
        activeVersion: null,
        draftSecretEnvelope: encryptProviderCredentialSecret({
          credentialId: "credential-draft",
          key: KEY,
          secret: "rotated-secret",
          valueId: providerCredentialDraftValueId(2)
        }),
        draftVersion: 2,
        enabled: true,
        id: "credential-draft"
      },
      {
        activeVersion: {
          envelope: encryptProviderCredentialSecret({
            credentialId: "credential-active",
            key: KEY,
            secret: "active-secret",
            valueId: "active-version"
          }),
          id: "active-version",
          version: 1
        },
        draftSecretEnvelope: null,
        draftVersion: 1,
        enabled: true,
        id: "credential-active"
      }
    ],
    draftChecks: [],
    models: [
      {
        configuration: modelConfiguration,
        displayName: "Vendor Model",
        draftVersion: 4,
        id: "model-1"
      },
      {
        configuration: { ...modelConfiguration, upstreamModelId: "vendor/model-two" },
        displayName: "Vendor Model Two",
        draftVersion: 5,
        id: "model-2"
      }
    ]
  };
}

function rerankerActivationCandidate(): ProviderActivationCandidate {
  const base = activationCandidate();
  const credential = base.credentials[1]!;
  const configuration = {
    adapterKind: "openrouter_rerank",
    answerSelectable: false,
    capabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      streaming: false,
      toolCalling: false,
      vision: false
    },
    defaultParams: {},
    modelClass: "reranker",
    openRouterRouting: { mode: "automatic", providers: [] },
    upstreamModelId: "qwen/qwen3-reranker-8b"
  } as const;
  return {
    connection: { ...base.connection, family: "openrouter" },
    credentials: [credential],
    draftChecks: [{
      checkedAt: new Date("2026-08-27T12:00:00.000Z"),
      connectionDraftVersion: base.connection.draftVersion,
      credentialDraftVersion: null,
      credentialId: credential.id,
      credentialVersionId: credential.activeVersion!.id,
      evidence: {
        compatibility: {
          directPdf: "not_supported",
          modelAccess: "verified",
          probeVersion: 1,
          streaming: "not_supported",
          structuredOutput: "not_supported",
          usage: "verified"
        },
        detail: "ok",
        method: "tiny_generation",
        selectedProviders: [],
        upstreamModelId: configuration.upstreamModelId
      },
      fingerprint: "reranker-direct-check",
      modelDraftVersion: 4,
      providerModelId: "reranker-1",
      status: "available"
    }],
    models: [{
      configuration,
      displayName: "Qwen3 Reranker 8B",
      draftVersion: 4,
      id: "reranker-1"
    }]
  };
}

describe("admin provider service", () => {
  it("accepts only the native Interactions adapter for Advanced Gemini models", async () => {
    const create = vi.fn(async () => ({}));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const db = {
      providerConnection: {
        findUnique: vi.fn(async () => ({ family: "gemini" }))
      },
      providerModel: {
        create,
        findUnique: vi.fn(async () => ({
          connection: { family: "gemini" },
          id: "gemini-model-1",
          modelClass: "answer"
        })),
        updateMany
      }
    };
    const providers = service(
      createPrismaAdminProviderRepository(db as unknown as PrismaClient),
      tester(),
      ["gemini-model-1", "rejected-model-1"]
    );
    const geminiConfiguration = {
      adapterKind: "gemini_interactions_native" as const,
      answerSelectable: true,
      capabilities: {
        nativePdfInput: false,
        nativeSearch: true,
        pdf: true,
        reasoning: true,
        streaming: true,
        toolCalling: true,
        vision: true
      },
      defaultParams: {
        maxTokens: 64,
        reasoning: { effort: "low" },
        stream: true
      },
      modelClass: "answer" as const,
      upstreamModelId: "gemini-3.6-flash"
    };

    await expect(providers.createModelDraft({
      configuration: geminiConfiguration,
      connectionId: "gemini-connection-1",
      displayName: "Gemini 3.6 Flash"
    })).resolves.toEqual({ id: "gemini-model-1" });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        connectionId: "gemini-connection-1",
        draftConfig: expect.objectContaining({
          adapterKind: "gemini_interactions_native",
          upstreamModelId: "gemini-3.6-flash"
        }),
        id: "gemini-model-1",
        provider: "gemini"
      })
    });

    await expect(providers.updateModelDraft({
      configuration: geminiConfiguration,
      displayName: "Gemini 3.6 Flash",
      expectedDraftVersion: 1,
      modelId: "gemini-model-1"
    })).resolves.toEqual({ draftVersion: 2 });
    expect(updateMany).toHaveBeenCalledWith({
      data: expect.objectContaining({
        draftConfig: expect.objectContaining({
          adapterKind: "gemini_interactions_native"
        }),
        draftVersion: { increment: 1 }
      }),
      where: { draftVersion: 1, id: "gemini-model-1" }
    });

    await expect(providers.createModelDraft({
      configuration: {
        ...geminiConfiguration,
        adapterKind: "openai_responses_compatible"
      },
      connectionId: "gemini-connection-1",
      displayName: "Invalid Gemini wire protocol"
    })).rejects.toMatchObject({ code: "provider_family_adapter_mismatch" });
    expect(create).toHaveBeenCalledOnce();
  });

  it("normalizes a new connection and model configuration", async () => {
    const createConnection = vi.fn<AdminProviderRepository["createConnection"]>(async () => {});
    const createModel = vi.fn<AdminProviderRepository["createModel"]>(async () => "created");
    const providerRepository = repository({
      createConnection,
      createModel
    });
    const providers = service(providerRepository, tester(), [
      "connection-new",
      "model-new"
    ]);

    await expect(providers.createConnectionDraft({
      configuration: connectionConfiguration,
      displayName: "  Compatible  ",
      family: "openai_compatible"
    })).resolves.toEqual({ id: "connection-new" });
    await providers.createModelDraft({
      configuration: modelConfiguration,
      connectionId: "connection-new",
      displayName: "Model"
    });

    expect(createConnection).toHaveBeenCalledWith(expect.objectContaining({ displayName: "Compatible" }));
    expect(createModel).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "connection-new", id: "model-new" }));
  });

  it("saves a new key in one step against the active configuration and writes nothing when the provider rejects it", async () => {
    const activateCredentialCas = vi.fn<AdminProviderRepository["activateCredentialCas"]>(async () => "updated");
    const activeConnection: AdminProviderConnection = {
      ...adminConnection(),
      activeConfig: { ...connectionConfiguration, apiRoot: "https://active.example.test/v1/" },
      activeVersion: 2,
      models: [{
        activatedAt: NOW.toISOString(),
        activeConfig: modelConfiguration,
        activeVersion: 1,
        connectionId: "connection-1",
        createdAt: NOW.toISOString(),
        displayName: "Vendor Model",
        draftConfig: modelConfiguration,
        draftVersion: 1,
        enabled: true,
        id: "model-1",
        modelClass: "answer",
        updatedAt: NOW.toISOString()
      }]
    };
    const test = vi.fn<AdminProviderCredentialTester["test"]>(async () => ({
      method: "models_catalog",
      modelIds: ["vendor/model"]
    }));
    const providers = service(repository({
      activateCredentialCas,
      async listConnections() { return [activeConnection]; }
    }), tester(), ["credential-new", "version-new"], credentialTester(test));

    await expect(providers.activateNewCredential({
      connectionId: "connection-1",
      label: "  Primary ",
      secret: "candidate-secret"
    })).resolves.toEqual({ credentialId: "credential-new", versionId: "version-new" });
    expect(test).toHaveBeenCalledOnce();
    expect(test.mock.calls[0]?.[0]).toMatchObject({
      connection: expect.objectContaining({ apiRoot: expect.stringContaining("https://active.example.test/v1") }),
      family: "openai_compatible",
      modelClasses: ["answer"],
      secret: "candidate-secret"
    });
    const write = activateCredentialCas.mock.calls[0]?.[0];
    expect(write).toMatchObject({
      checkedAt: NOW,
      connectionId: "connection-1",
      expectedConnectionVersion: 2,
      modelChecks: [{
        evidence: { detail: "ok", method: "models_catalog", selectedProviders: [], upstreamModelId: "vendor/model" },
        modelVersion: 1,
        providerModelId: "model-1",
        status: "available"
      }],
      credential: { id: "credential-new", kind: "new", label: "Primary" },
      testEvidence: { method: "models_catalog", modelCount: 1, version: 1 },
      versionId: "version-new"
    });
    expect(JSON.stringify(write)).not.toContain("candidate-secret");
    expect(decryptProviderCredentialSecret({
      credentialId: "credential-new",
      envelope: write!.versionEnvelope,
      key: KEY,
      valueId: "version-new"
    })).toBe("candidate-secret");

    const rejecting = service(repository({
      activateCredentialCas,
      async listConnections() { return [activeConnection]; }
    }), tester(), [], credentialTester(async () => {
      throw new Error("provider details must be discarded");
    }));
    await expect(rejecting.activateNewCredential({
      connectionId: "connection-1",
      label: "Finance",
      secret: "rejected-secret"
    })).rejects.toMatchObject({ code: "provider_credential_test_failed" });
    expect(activateCredentialCas).toHaveBeenCalledOnce();

    const taken = service(repository({
      async activateCredentialCas() { return "label_taken"; },
      async listConnections() { return [activeConnection]; }
    }), tester(), [], credentialTester(test));
    await expect(taken.activateNewCredential({
      connectionId: "connection-1",
      label: "Primary",
      secret: "candidate-secret"
    })).rejects.toMatchObject({ code: "provider_credential_label_taken" });
  });

  it("rotates a key in one step only for the exact current credential and never tests a stale one", async () => {
    const activateCredentialCas = vi.fn<AdminProviderRepository["activateCredentialCas"]>(async () => "updated");
    const test = vi.fn<AdminProviderCredentialTester["test"]>(async () => ({
      method: "models_catalog",
      modelIds: ["vendor/model"]
    }));
    const connection: AdminProviderConnection = {
      ...adminConnection(),
      credentials: [{
        activatedAt: NOW.toISOString(),
        activeVersion: {
          activatedAt: NOW.toISOString(),
          id: "version-1",
          revokedAt: null,
          testedAt: NOW.toISOString(),
          version: 1
        },
        createdAt: NOW.toISOString(),
        draftSecretConfigured: false,
        draftVersion: 1,
        enabled: true,
        id: "credential-1",
        label: "Primary",
        testedAt: NOW.toISOString(),
        updatedAt: NOW.toISOString()
      }]
    };
    const providers = service(repository({
      activateCredentialCas,
      async listConnections() { return [connection]; }
    }), tester(), ["version-2"], credentialTester(test));

    await expect(providers.activateRotatedCredential({
      connectionId: "connection-1",
      credentialId: "credential-1",
      expectedDraftVersion: 2,
      secret: "new-secret"
    })).rejects.toMatchObject({ code: "provider_draft_stale" });
    await expect(providers.activateRotatedCredential({
      connectionId: "connection-1",
      credentialId: "credential-missing",
      expectedDraftVersion: 1,
      secret: "new-secret"
    })).rejects.toMatchObject({ code: "provider_credential_not_found" });
    expect(test).not.toHaveBeenCalled();
    expect(activateCredentialCas).not.toHaveBeenCalled();

    await expect(providers.activateRotatedCredential({
      connectionId: "connection-1",
      credentialId: "credential-1",
      expectedDraftVersion: 1,
      secret: "new-secret"
    })).resolves.toEqual({ credentialId: "credential-1", versionId: "version-2" });
    expect(test).toHaveBeenCalledOnce();
    expect(activateCredentialCas.mock.calls[0]?.[0]).toMatchObject({
      credential: { expectedDraftVersion: 1, id: "credential-1", kind: "rotate" },
      versionId: "version-2"
    });

    const raced = service(repository({
      async activateCredentialCas() { return "stale"; },
      async listConnections() { return [connection]; }
    }), tester(), ["version-3"], credentialTester(test));
    await expect(raced.activateRotatedCredential({
      connectionId: "connection-1",
      credentialId: "credential-1",
      expectedDraftVersion: 1,
      secret: "new-secret"
    })).rejects.toMatchObject({ code: "provider_draft_stale" });
  });

  it("accepts discovered PDF support independently of the runtime opt-in and rejects inconsistent compatibility", async () => {
    const storeActiveRefreshCas = vi.fn<AdminProviderRepository["storeActiveRefreshCas"]>(
      async () => "stored"
    );
    const providerRepository = repository({
      async loadActiveRefreshCandidate() { return refreshCandidate(); },
      storeActiveRefreshCas
    });
    const compatibleEvidence = {
      compatibility: {
        directPdf: "verified" as const,
        modelAccess: "verified" as const,
        probeVersion: 1 as const,
        streaming: "verified" as const,
        structuredOutput: "not_supported" as const,
        usage: "verified" as const
      },
      detail: "ok" as const,
      method: "tiny_generation" as const,
      pdfInput: {
        adapterKind: "openai_responses_compatible" as const,
        probeVersion: 1 as const,
        upstreamModelId: "vendor/model",
        verified: true as const
      },
      selectedProviders: [],
      upstreamModelId: "vendor/model"
    };
    const providers = service(providerRepository, tester(async () => ({
      evidence: compatibleEvidence,
      status: "available"
    })));

    await expect(providers.refreshActive({
      confirmPaidRequest: true,
      connectionId: "connection-1",
      credentialId: "credential-1",
      providerModelId: "model-1"
    })).resolves.toMatchObject({ evidence: compatibleEvidence });
    expect(storeActiveRefreshCas).toHaveBeenCalledOnce();

    const inconsistent = service(providerRepository, tester(async () => ({
      evidence: {
        ...compatibleEvidence,
        pdfInput: undefined
      },
      status: "available"
    })));
    await expect(inconsistent.refreshActive({
      confirmPaidRequest: true,
      connectionId: "connection-1",
      credentialId: "credential-1",
      providerModelId: "model-1"
    })).rejects.toMatchObject({ code: "provider_test_evidence_invalid" });
  });

  it("validates each referenced credential once and derives the model matrix from catalogs", async () => {
    const activateConnectionCas = vi.fn<AdminProviderRepository["activateConnectionCas"]>(async () => "updated");
    const providerRepository = repository({
      activateConnectionCas,
      async loadActivationCandidate() { return activationCandidate(); }
    });
    let catalogCall = 0;
    const testCredential = vi.fn<AdminProviderCredentialTester["test"]>(async () => {
      const activeCredential = catalogCall++ % 2 === 1;
      return {
        method: "models_catalog",
        modelIds: activeCredential
          ? ["vendor/model"]
          : ["vendor/model", "vendor/model-two"]
      };
    });
    const modelTester = tester(vi.fn(async () => {
      throw new Error("model diagnostics must not run during activation");
    }));
    const providers = service(
      providerRepository,
      modelTester,
      ["discarded-version-id", "new-version-id"],
      credentialTester(testCredential)
    );

    await expect(providers.activateConnection({
      confirmUnavailable: false,
      connectionId: "connection-1",
      enableConnection: true
    })).rejects.toMatchObject({
      code: "provider_activation_unavailable_confirmation_required",
      resourceIds: ["model-2:credential-active"]
    });
    await expect(providers.activateConnection({
      confirmUnavailable: true,
      connectionId: "connection-1",
      enableConnection: true
    })).resolves.toEqual({
      activatedCredentialCount: 2,
      activatedModelCount: 2,
      connectionVersion: 3
    });
    const write = activateConnectionCas.mock.calls[0]?.[0];
    expect(write?.checks).toHaveLength(4);
    expect(write?.checks.filter(({ status }) => status === "unavailable")).toEqual([
      expect.objectContaining({
        credentialId: "credential-active",
        providerModelId: "model-2"
      })
    ]);
    expect(write?.checks.every(({ evidence }) => evidence.method === "models_catalog")).toBe(true);
    expect(testCredential).toHaveBeenCalledTimes(4);
    expect(modelTester.test).not.toHaveBeenCalled();
    expect(write?.connection).toMatchObject({ draftVersion: 3, enable: true });
    const rotated = write?.credentials.find(({ id }) => id === "credential-draft");
    expect(rotated).toMatchObject({
      draftVersion: 2,
      kind: "draft",
      versionId: "new-version-id"
    });
    if (rotated?.kind !== "draft") throw new Error("expected draft credential");
    expect(decryptProviderCredentialSecret({
      credentialId: rotated.id,
      envelope: rotated.versionEnvelope,
      key: KEY,
      valueId: rotated.versionId
    })).toBe("rotated-secret");

    const failedTest = credentialTester(async () => {
      throw new Error("remote details must be discarded");
    });
    await expect(service(providerRepository, tester(), [], failedTest).activateConnection({
      confirmUnavailable: true,
      connectionId: "connection-1",
      enableConnection: true
    })).rejects.toMatchObject({
      code: "provider_credential_test_failed",
      resourceIds: ["credential-draft"]
    });
  });

  it("uses an exact positive reranker probe when OpenRouter's text catalog omits it", async () => {
    const activateConnectionCas = vi.fn<AdminProviderRepository["activateConnectionCas"]>(
      async () => "updated"
    );
    const providers = service(
      repository({
        activateConnectionCas,
        async loadActivationCandidate() { return rerankerActivationCandidate(); }
      }),
      tester(vi.fn(async () => {
        throw new Error("activation must reuse the exact paid draft probe");
      })),
      [],
      credentialTester(async () => ({
        method: "models_catalog",
        modelIds: [],
        modelIdsByClass: { answer: [], embedding: [], reranker: [] }
      }))
    );

    await expect(providers.activateConnection({
      confirmUnavailable: false,
      connectionId: "connection-1",
      enableConnection: true
    })).resolves.toEqual({
      activatedCredentialCount: 1,
      activatedModelCount: 1,
      connectionVersion: 3
    });
    expect(activateConnectionCas.mock.calls[0]?.[0].checks).toEqual([
      expect.objectContaining({
        credentialId: "credential-active",
        providerModelId: "reranker-1",
        status: "available"
      })
    ]);
  });

  it("does not block provider activation when an automatic fallback probe is unavailable", async () => {
    const deployment = approvedRerankerDeployments[0]!;
    const base = rerankerActivationCandidate();
    const candidate: ProviderActivationCandidate = {
      ...base,
      draftChecks: [],
      models: [{
        configuration: deployment.configuration,
        displayName: deployment.displayName,
        draftVersion: 4,
        id: deployment.providerModelId
      }]
    };
    const activateConnectionCas = vi.fn<AdminProviderRepository["activateConnectionCas"]>(
      async () => "updated"
    );
    const providers = service(
      repository({
        activateConnectionCas,
        async loadActivationCandidate() { return candidate; }
      }),
      tester(vi.fn(async () => {
        throw new Error("temporary endpoint failure");
      })),
      [],
      credentialTester(async () => ({
        method: "models_catalog",
        modelIds: [deployment.configuration.upstreamModelId],
        modelIdsByClass: {
          answer: [],
          embedding: [],
          reranker: [deployment.configuration.upstreamModelId]
        }
      }))
    );

    await expect(providers.activateConnection({
      confirmUnavailable: false,
      connectionId: "connection-1",
      enableConnection: true
    })).resolves.toMatchObject({ activatedModelCount: 1 });
    expect(activateConnectionCas.mock.calls[0]?.[0].checks).toEqual([
      expect.objectContaining({
        providerModelId: deployment.providerModelId,
        status: "unavailable"
      })
    ]);
  });

  it("keeps assignment separate from RBAC and confirmation-gates revoke and deletion", async () => {
    const assignGroupCredential = vi.fn<AdminProviderRepository["assignGroupCredential"]>(async () => "assigned");
    const disable = vi.fn<AdminProviderRepository["disable"]>(async () => "disabled");
    const revokeCredentialVersion = vi.fn<AdminProviderRepository["revokeCredentialVersion"]>(async () => "revoked");
    const deleteCredential = vi.fn<AdminProviderRepository["deleteCredential"]>(async () => ({
      blockers: [{ count: 2, kind: "group_assignments" }],
      status: "conflict"
    }));
    const providers = service(repository({
      assignGroupCredential,
      deleteCredential,
      disable,
      revokeCredentialVersion
    }));

    await providers.assignGroupCredential({
      connectionId: "connection-1",
      credentialId: "credential-1",
      groupId: "group-1"
    });
    expect(assignGroupCredential).toHaveBeenCalledWith({
      connectionId: "connection-1",
      credentialId: "credential-1",
      groupId: "group-1"
    });
    await expect(providers.disable("credential", "credential-1")).resolves.toBe("disabled");
    await expect(providers.revokeCredentialVersion({
      clearSecret: true,
      confirmed: false,
      credentialId: "credential-1",
      versionId: "version-1"
    })).rejects.toMatchObject({ code: "provider_revoke_confirmation_required" });
    await providers.revokeCredentialVersion({
      clearSecret: true,
      confirmed: true,
      credentialId: "credential-1",
      versionId: "version-1"
    });
    expect(revokeCredentialVersion).toHaveBeenCalledWith({
      clearSecret: true,
      credentialId: "credential-1",
      now: NOW,
      versionId: "version-1"
    });

    await expect(providers.deleteCredential({
      confirmed: false,
      credentialId: "credential-1"
    })).rejects.toMatchObject({ code: "provider_delete_confirmation_required" });
    await expect(providers.deleteCredential({
      confirmed: true,
      credentialId: "credential-1"
    })).resolves.toEqual({
      blockers: [{ count: 2, kind: "group_assignments" }],
      status: "conflict"
    });
  });

  it("discovers OpenRouter models and routes with the exact stored draft key", async () => {
    const envelope = encryptProviderCredentialSecret({
      credentialId: "credential-or",
      key: KEY,
      secret: "openrouter-draft-key",
      valueId: providerCredentialDraftValueId(2)
    });
    const listModels = vi.fn(async () => [{
      id: "vendor/model",
      inputModalities: ["text"],
      name: "Vendor Model",
      outputModalities: ["text"],
      pricing: {},
      supportedParameters: ["tools"]
    }]);
    const listModelEndpoints = vi.fn(async () => [{
      name: "Vendor A",
      providerName: "Vendor",
      supportedParameters: ["tools"],
      tag: "vendor-a"
    }]);
    const listEmbeddingModels = vi.fn(async () => []);
    const createDiscoveryClient = vi.fn(() => ({
      listEmbeddingModels,
      listModelEndpoints,
      listModels,
      listRerankModels: vi.fn(async () => [])
    }));
    const providers = createAdminProviderService({
      credentialTester: credentialTester(),
      createDiscoveryClient,
      encryptionKey: () => KEY,
      repository: repository({
        async loadDiscoveryCandidate() {
          return {
            connection: {
              configuration: {
                allowPrivateNetwork: false,
                apiRoot: "https://openrouter.example.test/api/v1",
                authenticationMode: "bearer",
                responseTimeoutMs: 300_000
              },
              family: "openrouter",
              id: "connection-or"
            },
            credential: {
              id: "credential-or",
              source: { draftVersion: 2, envelope, kind: "draft" }
            }
          };
        }
      }),
      tester: tester()
    });

    await expect(providers.discoverOpenRouterModels({
      connectionId: "connection-or",
      credentialId: "credential-or"
    })).resolves.toEqual([expect.objectContaining({ id: "vendor/model" })]);
    await expect(providers.discoverOpenRouterEndpoints({
      connectionId: "connection-or",
      credentialId: "credential-or",
      modelId: "vendor/model"
    })).resolves.toEqual([expect.objectContaining({ tag: "vendor-a" })]);
    expect(createDiscoveryClient).toHaveBeenCalledWith({
      allowPrivateNetwork: false,
      apiRoot: "https://openrouter.example.test/api/v1",
      bearerToken: "openrouter-draft-key",
      responseTimeoutMs: 300_000
    });
    expect(listModels).toHaveBeenCalledOnce();
    expect(listModelEndpoints).toHaveBeenCalledWith("vendor/model", { signal: undefined });
  });

  it("discovers bounded compatible model metadata with the exact stored bearer credential", async () => {
    const envelope = encryptProviderCredentialSecret({
      credentialId: "credential-compatible",
      key: KEY,
      secret: "compatible-draft-key",
      valueId: providerCredentialDraftValueId(2)
    });
    const testCatalog = vi.fn<AdminProviderCredentialTester["test"]>(async (input) => {
      const secret = typeof input.secret === "function"
        ? await input.secret()
        : input.secret;
      expect(secret).toBe("compatible-draft-key");
      return {
        method: "models_catalog",
        modelIds: ["vendor/a", "vendor/b"],
        models: [
          {
            capabilities: {
              defaultReasoningEffort: "medium",
              reasoning: true,
              reasoningEfforts: ["low", "medium", "high"]
            },
            id: "vendor/a"
          },
          { capabilities: {}, id: "vendor/b" }
        ]
      };
    });
    const providers = createAdminProviderService({
      credentialTester: credentialTester(testCatalog),
      encryptionKey: () => KEY,
      repository: repository({
        async loadDiscoveryCandidate() {
          return {
            connection: {
              configuration: {
                allowPrivateNetwork: false,
                apiRoot: "https://compatible.example.test/v1",
                authenticationMode: "bearer",
                responseTimeoutMs: 300_000
              },
              family: "openai_compatible",
              id: "connection-compatible"
            },
            credential: {
              id: "credential-compatible",
              source: { draftVersion: 2, envelope, kind: "draft" }
            }
          };
        }
      }),
      tester: tester()
    });

    await expect(providers.discoverCompatibleModels({
      connectionId: "connection-compatible",
      credentialId: "credential-compatible"
    })).resolves.toEqual([
      {
        capabilities: {
          defaultReasoningEffort: "medium",
          reasoning: true,
          reasoningEfforts: ["low", "medium", "high"]
        },
        id: "vendor/a"
      },
      { capabilities: {}, id: "vendor/b" }
    ]);
    expect(testCatalog).toHaveBeenCalledOnce();
  });

  it("discovers compatible models without inventing a secret for explicit no-auth", async () => {
    const testCatalog = vi.fn<AdminProviderCredentialTester["test"]>(async (input) => {
      expect(input.secret).toBeNull();
      return { method: "models_catalog", modelIds: ["local-a", "local-b"] };
    });
    const providers = createAdminProviderService({
      credentialTester: credentialTester(testCatalog),
      repository: repository({
        async loadDiscoveryCandidate() {
          return {
            connection: {
              configuration: {
                allowPrivateNetwork: true,
                apiRoot: "http://127.0.0.1:11434/v1",
                authenticationMode: "none",
                responseTimeoutMs: 300_000
              },
              family: "openai_compatible",
              id: "connection-local"
            },
            credential: { id: "credential-local", source: null }
          };
        }
      }),
      tester: tester()
    });

    await expect(providers.discoverCompatibleModels({
      connectionId: "connection-local",
      credentialId: "credential-local"
    })).resolves.toEqual([
      { capabilities: {}, id: "local-a" },
      { capabilities: {}, id: "local-b" }
    ]);
  });

  it("refreshes the exact active tuple and records authoritative unavailable results", async () => {
    const envelope = encryptProviderCredentialSecret({
      credentialId: "credential-active",
      key: KEY,
      secret: "active-secret",
      valueId: "version-active"
    });
    const candidate = {
      connection: {
        configuration: {
          allowPrivateNetwork: false,
          apiRoot: "https://openrouter.example.test/api/v1",
          authenticationMode: "bearer",
          responseTimeoutMs: 300_000
        },
        displayName: "OpenRouter",
        family: "openrouter",
        id: "connection-active",
        version: 3
      },
      credential: {
        envelope,
        id: "credential-active",
        versionId: "version-active"
      },
      model: {
        configuration: {
          adapterKind: "openrouter_chat_completions" as const,
          answerSelectable: true,
          capabilities: {
            nativePdfInput: false,
            nativeSearch: false,
            pdf: false,
            reasoning: false,
            vision: false
          },
          defaultParams: {},
          modelClass: "answer" as const,
          openRouterRouting: { mode: "automatic" as const, providers: [] as [] },
          upstreamModelId: "vendor/model"
        },
        displayName: "Model",
        id: "model-active",
        version: 4
      }
    };
    const storeActiveRefreshCas = vi.fn(async () => "stored" as const);
    const providerRepository = repository({
      async loadActiveRefreshCandidate() { return candidate; },
      storeActiveRefreshCas,
      async withLockedCredential(_credentialId, _versionId, consume) {
        return consume({
          credentialId: "credential-active",
          id: "version-active",
          revokedAt: null,
          secretEnvelope: envelope
        });
      }
    });
    const providers = service(providerRepository, tester(async () => ({
      evidence: {
        detail: "model_missing",
        method: "openrouter_account_catalog",
        selectedProviders: [],
        upstreamModelId: "vendor/model"
      },
      status: "unavailable"
    })));

    await expect(providers.refreshActive({
      confirmPaidRequest: true,
      connectionId: "connection-active",
      credentialId: "credential-active",
      providerModelId: "model-active"
    })).resolves.toMatchObject({
      connectionVersion: 3,
      credentialVersionId: "version-active",
      latestRefreshError: null,
      modelVersion: 4,
      refreshFailedAt: null,
      status: "unavailable"
    });
    expect(storeActiveRefreshCas).toHaveBeenCalledWith(expect.objectContaining({
      candidate,
      evidence: expect.objectContaining({ detail: "model_missing" }),
      status: "unavailable"
    }));
  });

  it("blocks the second OpenRouter active Refresh request when the credential is revoked between catalog calls", async () => {
    const envelope = encryptProviderCredentialSecret({
      credentialId: "credential-active",
      key: KEY,
      secret: "active-secret",
      valueId: "version-active"
    });
    const candidate = {
      connection: {
        configuration: {
          allowPrivateNetwork: false,
          apiRoot: "https://openrouter.example.test/api/v1",
          authenticationMode: "bearer",
          responseTimeoutMs: 300_000
        },
        displayName: "OpenRouter",
        family: "openrouter",
        id: "connection-active",
        version: 3
      },
      credential: {
        envelope,
        id: "credential-active",
        versionId: "version-active"
      },
      model: {
        configuration: {
          adapterKind: "openrouter_chat_completions" as const,
          answerSelectable: true,
          capabilities: {
            nativePdfInput: false,
            nativeSearch: false,
            pdf: false,
            reasoning: false,
            vision: false
          },
          defaultParams: {},
          modelClass: "answer" as const,
          openRouterRouting: {
            mode: "only_selected" as const,
            providers: ["provider-a"]
          },
          upstreamModelId: "vendor/model"
        },
        displayName: "Model",
        id: "model-active",
        version: 4
      }
    };
    let revoked = false;
    let lockCount = 0;
    const requests: string[] = [];
    const providerRepository = repository({
      async loadActiveRefreshCandidate() { return candidate; },
      async withLockedCredential(_credentialId, _versionId, consume) {
        lockCount += 1;
        return consume({
          credentialId: "credential-active",
          id: "version-active",
          revokedAt: revoked ? NOW : null,
          secretEnvelope: envelope
        });
      }
    });
    const providerTester = createAdminProviderDraftTester({
      createDiscoveryClient: ({ connection, secret }) =>
        createOpenRouterDiscoveryClient({
          allowPrivateNetwork: connection.allowPrivateNetwork,
          apiRoot: connection.apiRoot,
          bearerToken: secret,
          network: {
            dispatch: async (request) => {
              requests.push(request.url.href);
              expect(request.headers.get("authorization")).toBe("Bearer active-secret");
              revoked = true;
              return new Response(JSON.stringify({
                data: [{ id: "vendor/model", name: "Vendor Model" }]
              }), { status: 200 });
            },
            lookupHostname: async () => [{ address: "93.184.216.34", family: 4 }]
          }
        })
    });
    const providers = service(providerRepository, providerTester);

    await expect(providers.refreshActive({
      confirmPaidRequest: true,
      connectionId: "connection-active",
      credentialId: "credential-active",
      providerModelId: "model-active"
    })).rejects.toMatchObject({ code: "provider_refresh_failed" });
    expect(lockCount).toBe(2);
    expect(requests).toEqual([
      "https://openrouter.example.test/api/v1/models/user"
    ]);
  });

  it.each([undefined, "memory", "vision"] as const)("preserves prior authority on transient %s refresh failure", async (capabilityRole) => {
    const envelope = encryptProviderCredentialSecret({
      credentialId: "credential-active",
      key: KEY,
      secret: "active-secret",
      valueId: "version-active"
    });
    const candidate = {
      connection: {
        configuration: storedConnectionConfiguration,
        displayName: "Compatible",
        family: "openai_compatible",
        id: "connection-1",
        version: 3
      },
      credential: { envelope, id: "credential-active", versionId: "version-active" },
      model: {
        configuration: modelConfiguration,
        displayName: "Model",
        id: "model-active",
        version: 4
      }
    };
    const recordActiveRefreshFailureCas = vi.fn(async () => "stored" as const);
    const storeActiveRefreshCas = vi.fn(async () => "stored" as const);
    const providers = service(repository({
      async loadActiveRefreshCandidate() { return candidate; },
      recordActiveRefreshFailureCas,
      storeActiveRefreshCas,
      async withLockedCredential(_credentialId, _versionId, consume) {
        return consume({
          credentialId: "credential-active",
          id: "version-active",
          revokedAt: null,
          secretEnvelope: envelope
        });
      }
    }), tester(async () => {
      throw new Error("remote detail must not escape");
    }));

    await expect(providers.refreshActive({
      capabilityRole,
      confirmPaidRequest: true,
      connectionId: "connection-1",
      credentialId: "credential-active",
      providerModelId: "model-active"
    })).rejects.toMatchObject({ code: "provider_refresh_failed" });
    expect(recordActiveRefreshFailureCas).toHaveBeenCalledWith({ candidate, failedAt: NOW });
    expect(storeActiveRefreshCas).not.toHaveBeenCalled();
  });
});

describe("atomic provider connection settings", () => {
  function liveConnection(): AdminProviderConnection {
    return {
      ...adminConnection(),
      activeConfig: connectionConfiguration,
      activeVersion: 1,
      credentials: ["primary", "group"].map((id) => ({
        activatedAt: NOW.toISOString(),
        activeVersion: { activatedAt: NOW.toISOString(), id: `version-${id}`, revokedAt: null, testedAt: NOW.toISOString(), version: 1 },
        createdAt: NOW.toISOString(),
        draftSecretConfigured: false,
        draftVersion: 1,
        enabled: id === "primary",
        id,
        label: id,
        testedAt: NOW.toISOString(),
        updatedAt: NOW.toISOString()
      })),
      defaultCredentialId: "primary",
      enabled: true
    };
  }
  function request() {
    return {
      configuration: { ...connectionConfiguration, apiRoot: "https://new.example.test/v1" },
      connectionId: "connection-1",
      credentialSecrets: [
        { credentialId: "primary", secret: "new-primary-secret" },
        { credentialId: "group", secret: "new-group-secret" }
      ],
      displayName: "New destination",
      expectedDraftVersion: 3,
      unassignedPolicy: "use_default" as const
    };
  }

  it("tests only re-entered keys at a changed endpoint and publishes them together, including a disabled key", async () => {
    const saveConnectionSettingsCas = vi.fn<AdminProviderRepository["saveConnectionSettingsCas"]>(async () => "updated");
    const withLockedCredential = vi.fn(async (): Promise<never> => {
      throw new Error("must not read old secrets");
    });
    const test = vi.fn<AdminProviderCredentialTester["test"]>(async () => ({ method: "models_catalog", modelIds: [] }));
    const providers = service(repository({
      listConnections: async () => [liveConnection()], saveConnectionSettingsCas, withLockedCredential
    }), tester(), ["replacement-primary", "replacement-group"], credentialTester(test));
    await providers.saveConnectionSettings(request());
    expect(test.mock.calls.map(([input]) => input.secret)).toEqual(["new-primary-secret", "new-group-secret"]);
    expect(test.mock.calls.every(([input]) => input.connection.apiRoot === "https://new.example.test/v1")).toBe(true);
    expect(withLockedCredential).not.toHaveBeenCalled();
    const saved = saveConnectionSettingsCas.mock.calls[0]![0];
    expect(saved).toMatchObject({ expectedActiveVersion: 1, expectedDraftVersion: 3, displayName: "New destination" });
    expect(saved.credentials.map((entry) => entry.credentialId)).toEqual(["primary", "group"]);
    expect(JSON.stringify(saved)).not.toContain("new-primary-secret");
    expect(JSON.stringify(saved)).not.toContain("new-group-secret");
    expect(decryptProviderCredentialSecret({
      credentialId: "group", envelope: saved.credentials[1]!.replacement!.envelope, key: KEY, valueId: "replacement-group"
    })).toBe("new-group-secret");
  });

  it("preserves all settings and key versions when a later re-entered key fails", async () => {
    const saveConnectionSettingsCas = vi.fn<AdminProviderRepository["saveConnectionSettingsCas"]>();
    const test = vi.fn<AdminProviderCredentialTester["test"]>()
      .mockResolvedValueOnce({ method: "models_catalog", modelIds: [] })
      .mockRejectedValueOnce(new Error("upstream private error"));
    const providers = service(repository({
      listConnections: async () => [liveConnection()], saveConnectionSettingsCas
    }), tester(), [], credentialTester(test));
    await expect(providers.saveConnectionSettings(request())).rejects.toMatchObject({ code: "provider_credential_test_failed" });
    expect(test).toHaveBeenCalledTimes(2);
    expect(saveConnectionSettingsCas).not.toHaveBeenCalled();
  });

  it("rejects incomplete key re-entry and stale settings before any provider request", async () => {
    const saveConnectionSettingsCas = vi.fn<AdminProviderRepository["saveConnectionSettingsCas"]>();
    const test = vi.fn<AdminProviderCredentialTester["test"]>();
    const providers = service(repository({
      listConnections: async () => [liveConnection()], saveConnectionSettingsCas
    }), tester(), [], credentialTester(test));
    await expect(providers.saveConnectionSettings({ ...request(), credentialSecrets: request().credentialSecrets.slice(0, 1) }))
      .rejects.toMatchObject({ code: "provider_endpoint_keys_required" });
    await expect(providers.saveConnectionSettings({ ...request(), expectedDraftVersion: 1 }))
      .rejects.toMatchObject({ code: "provider_draft_stale" });
    expect(test).not.toHaveBeenCalled();
    expect(saveConnectionSettingsCas).not.toHaveBeenCalled();
  });

  it("tests an explicit no-auth connection without requesting or inventing a secret", async () => {
    const connection = liveConnection();
    const config = { ...connectionConfiguration, allowPrivateNetwork: true, apiRoot: "http://127.0.0.1:9000/v1", authenticationMode: "none" as const };
    connection.activeConfig = config;
    connection.draftConfig = config;
    connection.credentials = connection.credentials.slice(0, 1);
    const saveConnectionSettingsCas = vi.fn<AdminProviderRepository["saveConnectionSettingsCas"]>(async () => "updated");
    const test = vi.fn<AdminProviderCredentialTester["test"]>(async () => ({ method: "models_catalog", modelIds: [] }));
    const providers = service(repository({ listConnections: async () => [connection], saveConnectionSettingsCas }), tester(), [], credentialTester(test));
    await providers.saveConnectionSettings({ ...request(), configuration: { ...config, responseTimeoutSeconds: 120 }, credentialSecrets: [] });
    expect(test).toHaveBeenCalledWith(expect.objectContaining({ secret: null }));
    expect(saveConnectionSettingsCas.mock.calls[0]![0].credentials[0]!.replacement).toBeNull();
  });

  it("does not let the legacy connection action forward saved keys to a changed endpoint", async () => {
    const candidate = activationCandidate();
    const test = vi.fn<AdminProviderCredentialTester["test"]>();
    const providers = service(repository({
      loadActivationCandidate: async () => ({ ...candidate, connection: {
        ...candidate.connection,
        activeConfiguration: { ...storedConnectionConfiguration, apiRoot: "https://old.example.test/v1" }
      } })
    }), tester(), [], credentialTester(test));
    await expect(providers.activateConnection({ connectionId: "connection-1", confirmUnavailable: true, enableConnection: true }))
      .rejects.toMatchObject({ code: "provider_endpoint_keys_required" });
    expect(test).not.toHaveBeenCalled();
  });
});
