import { describe, expect, it, vi } from "vitest";
import {
  decryptProviderCredentialSecret,
  encryptProviderCredentialSecret
} from "../../providers/credentialSecrets";
import type {
  AdminProviderRepository,
  ProviderActivationCandidate,
  ProviderDraftTestCandidate
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

const KEY = Buffer.alloc(32, 19);
const NOW = new Date("2026-07-23T12:00:00.000Z");

const connectionConfiguration = {
  allowPrivateNetwork: false,
  apiRoot: "https://compatible.example.test/v1/"
};

const modelConfiguration = {
  adapterKind: "openai_responses_compatible" as const,
  capabilities: {
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    vision: false
  },
  defaultParams: {},
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
    updatedAt: NOW.toISOString()
  };
}

function repository(
  overrides: Partial<AdminProviderRepository> = {}
): AdminProviderRepository {
  return {
    async activateConnectionCas() { return "updated"; },
    async assignGroupCredential() { return "assigned"; },
    async createConnection() {},
    async createCredential() { return "created"; },
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
    async loadDraftTestCandidate() { return null; },
    async renameCredential() { return "updated"; },
    async recordActiveRefreshFailureCas() { return "stored"; },
    async revokeCredentialVersion() { return "revoked"; },
    async revokeGroupCredential() { return "revoked"; },
    async setDefaultCredential() { return "updated"; },
    async storeDraftCheckCas() { return "stored"; },
    async storeActiveRefreshCas() { return "stored"; },
    async updateConnectionDraft() { return "updated"; },
    async updateCredentialDraft() { return "updated"; },
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

function draftCandidate(): ProviderDraftTestCandidate {
  return {
    connection: {
      configuration: connectionConfiguration,
      displayName: "Compatible",
      draftVersion: 3,
      family: "openai_compatible",
      id: "connection-1"
    },
    credential: {
      id: "credential-1",
      source: {
        draftVersion: 2,
        envelope: encryptProviderCredentialSecret({
          credentialId: "credential-1",
          key: KEY,
          secret: "draft-secret",
          valueId: providerCredentialDraftValueId(2)
        }),
        kind: "draft"
      }
    },
    model: {
      configuration: modelConfiguration,
      displayName: "Vendor Model",
      draftVersion: 4,
      id: "model-1"
    }
  };
}

function activationCandidate(): ProviderActivationCandidate {
  return {
    connection: {
      configuration: connectionConfiguration,
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
    models: [
      { configuration: modelConfiguration, draftVersion: 4, id: "model-1" },
      {
        configuration: { ...modelConfiguration, upstreamModelId: "vendor/model-two" },
        draftVersion: 5,
        id: "model-2"
      }
    ]
  };
}

describe("admin provider service", () => {
  it("normalizes CRUD drafts and keeps credential ciphertext write-only", async () => {
    const createConnection = vi.fn<AdminProviderRepository["createConnection"]>(async () => {});
    const createModel = vi.fn<AdminProviderRepository["createModel"]>(async () => "created");
    const createCredential = vi.fn<AdminProviderRepository["createCredential"]>(async () => "created");
    const updateCredentialDraft = vi.fn<AdminProviderRepository["updateCredentialDraft"]>(async () => "updated");
    const providerRepository = repository({
      createConnection,
      createCredential,
      createModel,
      updateCredentialDraft
    });
    const providers = service(providerRepository, tester(), [
      "connection-new",
      "model-new",
      "credential-new"
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
    const created = await providers.createCredentialDraft({
      connectionId: "connection-new",
      label: "Primary",
      secret: "created-secret"
    });
    expect(created).toEqual({ id: "credential-new" });
    const createInput = createCredential.mock.calls[0]?.[0];
    expect(createInput).not.toHaveProperty("secret");
    expect(JSON.stringify(created)).not.toContain("created-secret");
    expect(decryptProviderCredentialSecret({
      credentialId: "credential-new",
      envelope: createInput!.draftSecretEnvelope,
      key: KEY,
      valueId: "draft:1"
    })).toBe("created-secret");

    await expect(providers.rotateCredential({
      credentialId: "credential-new",
      expectedDraftVersion: 1,
      secret: "rotated-secret"
    })).resolves.toEqual({ draftVersion: 2 });
    const rotateInput = updateCredentialDraft.mock.calls[0]?.[0];
    expect(decryptProviderCredentialSecret({
      credentialId: "credential-new",
      envelope: rotateInput!.draftSecretEnvelope!,
      key: KEY,
      valueId: "draft:2"
    })).toBe("rotated-secret");

    await expect(providers.clearCredentialDraft({
      confirmed: false,
      credentialId: "credential-new",
      expectedDraftVersion: 2
    })).rejects.toMatchObject({ code: "provider_revoke_confirmation_required" });
  });

  it("validates an unsaved credential against the current connection draft without persisting it", async () => {
    const createCredential = vi.fn<AdminProviderRepository["createCredential"]>(async () => "created");
    const test = vi.fn<AdminProviderCredentialTester["test"]>(async (input) => {
      expect(input.secret).toBe("candidate-secret");
      expect(input.family).toBe("openai_compatible");
      return { method: "models_catalog", modelIds: ["vendor/model"] };
    });
    const providers = service(repository({
      createCredential,
      async listConnections() { return [adminConnection()]; }
    }), tester(), [], credentialTester(test));

    await expect(providers.testCredential({
      connectionId: "connection-1",
      expectedConnectionDraftVersion: 3,
      secret: "candidate-secret"
    })).resolves.toEqual({
      checkedAt: NOW.toISOString(),
      connectionDraftVersion: 3,
      modelCount: 1,
      status: "valid"
    });
    expect(createCredential).not.toHaveBeenCalled();

    await expect(providers.testCredential({
      connectionId: "connection-1",
      expectedConnectionDraftVersion: 2,
      secret: "candidate-secret"
    })).rejects.toMatchObject({ code: "provider_draft_stale" });
    expect(test).toHaveBeenCalledOnce();
  });

  it("does all network work before the evidence CAS and rejects a stale tuple", async () => {
    let finish!: (value: AdminProviderDraftTestOutcome) => void;
    const network = new Promise<AdminProviderDraftTestOutcome>((resolve) => {
      finish = resolve;
    });
    const storeDraftCheckCas = vi.fn<AdminProviderRepository["storeDraftCheckCas"]>(async () => "stale");
    const providerRepository = repository({
      async loadDraftTestCandidate() { return draftCandidate(); },
      storeDraftCheckCas
    });
    const test = vi.fn<AdminProviderDraftTester["test"]>(async (input) => {
      expect(input.secret).toBe("draft-secret");
      return network;
    });
    const promise = service(providerRepository, tester(test)).testDraft({
      confirmPaidRequest: true,
      connectionId: "connection-1",
      credentialId: "credential-1",
      mode: "tiny_generation",
      providerModelId: "model-1"
    });

    await vi.waitFor(() => expect(test).toHaveBeenCalledOnce());
    expect(storeDraftCheckCas).not.toHaveBeenCalled();
    finish({
      evidence: {
        detail: "ok",
        method: "tiny_generation",
        selectedProviders: [],
        upstreamModelId: "vendor/model"
      },
      status: "available"
    });
    await expect(promise).rejects.toMatchObject({ code: "provider_draft_stale" });
    expect(storeDraftCheckCas).toHaveBeenCalledOnce();
    const stored = storeDraftCheckCas.mock.calls[0]?.[1];
    expect(stored).toMatchObject({
      connectionDraftVersion: 3,
      credentialDraftVersion: 2,
      credentialVersionId: null,
      modelDraftVersion: 4,
      status: "available"
    });
    expect(JSON.stringify(stored)).not.toContain("draft-secret");
  });

  it("requires explicit paid-test confirmation and accepts only fixed safe evidence", async () => {
    const providerRepository = repository({
      async loadDraftTestCandidate() { return draftCandidate(); }
    });
    await expect(service(providerRepository).testDraft({
      connectionId: "connection-1",
      credentialId: "credential-1",
      mode: "tiny_generation",
      providerModelId: "model-1"
    })).rejects.toMatchObject({ code: "provider_paid_test_confirmation_required" });

    const invalidTester = tester(async () => ({
      evidence: {
        detail: "ok",
        method: "tiny_generation",
        selectedProviders: [],
        upstreamModelId: "different-model"
      },
      status: "available"
    }));
    await expect(service(providerRepository, invalidTester).testDraft({
      confirmPaidRequest: true,
      connectionId: "connection-1",
      credentialId: "credential-1",
      mode: "tiny_generation",
      providerModelId: "model-1"
    })).rejects.toBeInstanceOf(AdminProviderServiceError);
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
    const createDiscoveryClient = vi.fn(() => ({ listModelEndpoints, listModels }));
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
                apiRoot: "https://openrouter.example.test/api/v1"
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
      bearerToken: "openrouter-draft-key"
    });
    expect(listModels).toHaveBeenCalledOnce();
    expect(listModelEndpoints).toHaveBeenCalledWith("vendor/model", { signal: undefined });
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
          apiRoot: "https://openrouter.example.test/api/v1"
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
          capabilities: {
            nativePdfInput: false,
            nativeSearch: false,
            pdf: false,
            reasoning: false,
            vision: false
          },
          defaultParams: {},
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
          apiRoot: "https://openrouter.example.test/api/v1"
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
          capabilities: {
            nativePdfInput: false,
            nativeSearch: false,
            pdf: false,
            reasoning: false,
            vision: false
          },
          defaultParams: {},
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
      connectionId: "connection-active",
      credentialId: "credential-active",
      providerModelId: "model-active"
    })).rejects.toMatchObject({ code: "provider_refresh_failed" });
    expect(lockCount).toBe(2);
    expect(requests).toEqual([
      "https://openrouter.example.test/api/v1/models/user"
    ]);
  });

  it("preserves prior active authority and stores attention on transient refresh failure", async () => {
    const envelope = encryptProviderCredentialSecret({
      credentialId: "credential-active",
      key: KEY,
      secret: "active-secret",
      valueId: "version-active"
    });
    const candidate = {
      connection: {
        configuration: connectionConfiguration,
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
      confirmPaidRequest: true,
      connectionId: "connection-1",
      credentialId: "credential-active",
      providerModelId: "model-active"
    })).rejects.toMatchObject({ code: "provider_refresh_failed" });
    expect(recordActiveRefreshFailureCas).toHaveBeenCalledWith({ candidate, failedAt: NOW });
    expect(storeActiveRefreshCas).not.toHaveBeenCalled();
  });
});
