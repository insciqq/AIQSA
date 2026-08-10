import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { encryptProviderCredentialSecret } from "../../providers/credentialSecrets";
import { createPrismaAdminProviderRepository } from "./prismaRepository";
import type {
  ProviderActiveRefreshCandidate,
  ProviderDraftTestCandidate,
  StoredProviderDraftCheck
} from "./repositoryContract";

const KEY = Buffer.alloc(32, 20);
const NOW = new Date("2026-07-23T14:00:00.000Z");

function transactional<T extends Record<string, unknown>>(db: T): T & {
  $queryRaw: ReturnType<typeof vi.fn>;
  $transaction: (operation: (tx: T) => Promise<unknown>) => Promise<unknown>;
} {
  const transaction = Object.assign({
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => [{ id: "installation" }]),
    memoryExecutionBinding: { count: vi.fn(async () => 0) }
  }, db);
  return Object.assign(transaction, {
    $transaction: vi.fn(async (operation: (tx: T) => Promise<unknown>) =>
      operation(transaction as T))
  });
}

function candidate(): ProviderDraftTestCandidate {
  return {
    connection: {
      configuration: {
        allowPrivateNetwork: false,
        apiRoot: "https://provider.example.test/v1"
      },
      displayName: "Provider",
      draftVersion: 2,
      family: "openai_compatible",
      id: "connection-1"
    },
    credential: {
      id: "credential-1",
      source: {
        draftVersion: 3,
        envelope: encryptProviderCredentialSecret({
          credentialId: "credential-1",
          key: KEY,
          secret: "secret",
          valueId: "draft:3"
        }),
        kind: "draft"
      }
    },
    model: {
      configuration: {
        adapterKind: "openai_responses_compatible",
        capabilities: {
          nativePdfInput: false,
          nativeSearch: false,
          pdf: false,
          reasoning: false,
          vision: false
        },
        defaultParams: {},
        upstreamModelId: "vendor/model"
      },
      displayName: "Model",
      draftVersion: 4,
      id: "model-1"
    }
  };
}

function storedCheck(): StoredProviderDraftCheck {
  return {
    checkedAt: NOW,
    connectionDraftVersion: 2,
    credentialDraftVersion: 3,
    credentialId: "credential-1",
    credentialVersionId: null,
    evidence: {
      detail: "ok",
      method: "tiny_generation",
      selectedProviders: [],
      upstreamModelId: "vendor/model"
    },
    fingerprint: "fingerprint-1",
    modelDraftVersion: 4,
    providerModelId: "model-1",
    status: "available"
  };
}

function activeCandidate(): ProviderActiveRefreshCandidate {
  return {
    connection: {
      configuration: {
        allowPrivateNetwork: false,
        apiRoot: "https://provider.example.test/v1"
      },
      displayName: "Provider",
      family: "openai_compatible",
      id: "connection-1",
      version: 2
    },
    credential: {
      envelope: "active-envelope",
      id: "credential-1",
      versionId: "version-1"
    },
    model: {
      configuration: candidate().model.configuration,
      displayName: "Model",
      id: "model-1",
      version: 4
    }
  };
}

describe("Prisma admin provider repository", () => {
  it("serializes configured-secret metadata without returning either ciphertext", async () => {
    const createdAt = new Date("2026-07-20T00:00:00.000Z");
    const db = {
      providerConnection: {
        findMany: vi.fn(async () => [{
          activatedAt: null,
          activeConfig: null,
          activeVersion: 0,
          createdAt,
          credentials: [{
            activatedAt: null,
            activeVersion: {
              activatedAt: NOW,
              id: "version-1",
              revokedAt: null,
              testedAt: NOW,
              version: 1
            },
            activeVersionId: "version-1",
            connectionId: "connection-1",
            createdAt,
            draftSecretEnvelope: "private-draft-ciphertext",
            draftVersion: 2,
            enabled: true,
            groupAssignments: [],
            id: "credential-1",
            label: "Primary",
            testedAt: NOW,
            updatedAt: NOW,
            userAssignments: [{
              connectionId: "connection-1",
              credentialId: "credential-1",
              updatedAt: NOW,
              user: {
                displayName: "Admin",
                email: "admin@example.test",
                id: "admin-1",
                status: "active"
              }
            }]
          }],
          defaultCredentialId: "credential-1",
          displayName: "Compatible",
          draftConfig: {
            allowPrivateNetwork: false,
            apiRoot: "https://provider.example.test/v1"
          },
          draftVersion: 1,
          enabled: false,
          family: "openai_compatible",
          id: "connection-1",
          models: [],
          templateKey: null,
          unassignedPolicy: "use_default",
          updatedAt: NOW
        }])
      },
      providerDraftCheck: { findMany: vi.fn(async () => []) },
      providerModelCredentialCheck: { findMany: vi.fn(async () => []) }
    };
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    const result = await repository.listConnections();
    expect(result[0]?.credentials[0]).toMatchObject({
      draftSecretConfigured: true,
      id: "credential-1"
    });
    expect(result[0]?.userAssignments).toEqual([{
      connectionId: "connection-1",
      credentialId: "credential-1",
      updatedAt: NOW.toISOString(),
      user: {
        displayName: "Admin",
        email: "admin@example.test",
        id: "admin-1",
        status: "active"
      }
    }]);
    expect(JSON.stringify(result)).not.toContain("private-draft-ciphertext");
    expect(JSON.stringify(result)).not.toContain("secretEnvelope");
  });

  it("CAS-stores candidate evidence only while every draft source is exact", async () => {
    const draft = candidate();
    const upsert = vi.fn(async () => ({}));
    const update = vi.fn(async () => ({}));
    const db = transactional({
      providerConnection: {
        findUnique: vi.fn(async () => ({ draftVersion: 2 }))
      },
      providerCredential: {
        findFirst: vi.fn(async () => ({
          activeVersion: null,
          activeVersionId: null,
          draftSecretEnvelope: draft.credential.source.envelope,
          draftVersion: 3
        })),
        update
      },
      providerDraftCheck: { upsert },
      providerModel: {
        findFirst: vi.fn(async () => ({ draftVersion: 4 }))
      }
    });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.storeDraftCheckCas(draft, storedCheck())).resolves.toBe("stored");
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        credentialDraftVersion: 3,
        credentialVersionId: null,
        fingerprint: "fingerprint-1"
      })
    }));
    expect(update).toHaveBeenCalledWith({
      data: { testedAt: NOW },
      where: { id: "credential-1" }
    });

    db.providerModel.findFirst.mockResolvedValueOnce({ draftVersion: 5 });
    await expect(repository.storeDraftCheckCas(draft, storedCheck())).resolves.toBe("stale");
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("returns actionable model deletion conflicts and never silently cascades references", async () => {
    const remove = vi.fn(async () => ({}));
    const db = transactional({
      accessGrant: { count: vi.fn(async () => 2) },
      assistantRevision: { count: vi.fn(async () => 1) },
      chat: { count: vi.fn(async () => 1) },
      modelPolicy: { count: vi.fn(async () => 1) },
      providerModel: {
        delete: remove,
        findUnique: vi.fn(async () => ({ enabled: false, templateKey: null }))
      },
      providerCredentialVersion: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      providerRunBinding: {
        count: vi.fn(async () => 1),
        updateMany: vi.fn(async () => ({ count: 0 }))
      },
      searchIntegrationRevision: { count: vi.fn(async () => 3) },
      searchStrategy: { count: vi.fn(async () => 1) },
      systemModelPolicy: { count: vi.fn(async () => 1) },
      userSettings: { count: vi.fn(async () => 1) }
    });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.deleteModel("model-1")).resolves.toEqual({
      blockers: [
        { count: 2, kind: "access_grants" },
        { count: 1, kind: "installation_default" },
        { count: 1, kind: "system_model" },
        { count: 1, kind: "user_defaults" },
        { count: 1, kind: "chat_defaults" },
        { count: 1, kind: "search_references" },
        { count: 3, kind: "search_revision_references" },
        { count: 1, kind: "assistant_revisions" },
        { count: 1, kind: "run_bindings" }
      ],
      status: "conflict"
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("blocks model deletion when only immutable Search revisions retain the model", async () => {
    const remove = vi.fn(async () => ({}));
    const db = transactional({
      accessGrant: { count: vi.fn(async () => 0) },
      assistantRevision: { count: vi.fn(async () => 0) },
      chat: { count: vi.fn(async () => 0) },
      modelPolicy: { count: vi.fn(async () => 0) },
      providerModel: {
        delete: remove,
        findUnique: vi.fn(async () => ({ enabled: false, templateKey: null }))
      },
      providerCredentialVersion: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      providerRunBinding: {
        count: vi.fn(async () => 0),
        updateMany: vi.fn(async () => ({ count: 0 }))
      },
      searchIntegrationRevision: { count: vi.fn(async () => 2) },
      searchStrategy: { count: vi.fn(async () => 0) },
      systemModelPolicy: { count: vi.fn(async () => 0) },
      userSettings: { count: vi.fn(async () => 0) }
    });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.deleteModel("model-1")).resolves.toEqual({
      blockers: [{ count: 2, kind: "search_revision_references" }],
      status: "conflict"
    });
    expect(db.searchIntegrationRevision.count).toHaveBeenCalledWith({
      where: { providerModelId: "model-1" }
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("blocks provider model deletion while a live or recoverable Memory call retains it", async () => {
    const remove = vi.fn(async () => ({}));
    const countMemory = vi.fn(async () => 2);
    const db = transactional({
      accessGrant: { count: vi.fn(async () => 0) },
      assistantRevision: { count: vi.fn(async () => 0) },
      chat: { count: vi.fn(async () => 0) },
      memoryExecutionBinding: { count: countMemory },
      modelPolicy: { count: vi.fn(async () => 0) },
      providerModel: {
        delete: remove,
        findUnique: vi.fn(async () => ({ enabled: false, templateKey: null }))
      },
      providerRunBinding: {
        count: vi.fn(async () => 0),
        updateMany: vi.fn(async () => ({ count: 0 }))
      },
      searchIntegrationRevision: { count: vi.fn(async () => 0) },
      searchStrategy: { count: vi.fn(async () => 0) },
      systemModelPolicy: { count: vi.fn(async () => 0) },
      userSettings: { count: vi.fn(async () => 0) }
    });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.deleteModel("model-1")).resolves.toEqual({
      blockers: [{ count: 2, kind: "memory_bindings" }],
      status: "conflict"
    });
    expect(countMemory).toHaveBeenCalledWith({ where: { providerModelId: "model-1" } });
    expect(remove).not.toHaveBeenCalled();
  });

  it.each([
    {
      adapterKind: "openai_responses_compatible" as const,
      clientId: "custom-web-search-client:connection-1",
      clientKind: "provider_model_web_search" as const,
      existingClient: false,
      family: "openai_compatible",
      hostedId: "custom-web-search-hosted:connection-1",
      hostedKind: "openai_native_web_search" as const,
      hostedStrategyId: "custom-web-search-hosted:connection-1",
      label: "custom Responses",
      optionId: "custom-web-search:connection-1",
      optionKind: "web_search" as const,
      optionRowId: "custom-web-search-option:connection-1",
      protocol: "openai_responses_web_search" as const,
      templateKey: null
    },
    {
      adapterKind: "openai_responses_native" as const,
      clientId: "openai-search-client:connection-1",
      clientKind: "provider_model_web_search" as const,
      existingClient: true,
      family: "openai",
      hostedId: "openai-native-web-search",
      hostedKind: "openai_native_web_search" as const,
      hostedStrategyId: "openai-native-web-search",
      label: "official OpenAI Responses",
      optionId: "openai-native-web-search",
      optionKind: "web_search" as const,
      optionRowId: "00000000-0000-4000-8000-000000001402",
      protocol: "openai_responses_web_search" as const,
      templateKey: "openai"
    },
    {
      adapterKind: "anthropic_messages" as const,
      clientId: "anthropic-search-client:connection-1",
      clientKind: "provider_model_web_search" as const,
      existingClient: false,
      family: "anthropic",
      hostedId: "anthropic-web-search",
      hostedKind: "anthropic_native_web_search" as const,
      hostedStrategyId: "anthropic-web-search",
      label: "official Anthropic Messages",
      optionId: "anthropic-web-search",
      optionKind: "web_search" as const,
      optionRowId: "00000000-0000-4000-8000-000000001405",
      protocol: "anthropic_web_search" as const,
      templateKey: "anthropic"
    },
    {
      adapterKind: "gemini_interactions_native" as const,
      clientId: "gemini-search-client:connection-1",
      clientKind: "gemini_google_search" as const,
      existingClient: false,
      family: "gemini",
      hostedId: "00000000-0000-4000-8000-000000001301",
      hostedKind: "gemini_google_search" as const,
      hostedStrategyId: "gemini-google-search",
      label: "native Gemini Interactions",
      optionId: "gemini-google-search",
      optionKind: "gemini_google_search" as const,
      optionRowId: "00000000-0000-4000-8000-000000001403",
      protocol: "gemini_google_search" as const,
      templateKey: "gemini"
    }
  ])("atomically materializes a tested $label draft and both active Search routes", async (scenario) => {
    const candidateCheck = storedCheck();
    const secondCandidateCheck: StoredProviderDraftCheck = {
      ...candidateCheck,
      evidence: {
        ...candidateCheck.evidence,
        upstreamModelId: "vendor/model-2"
      },
      fingerprint: "fingerprint-2",
      modelDraftVersion: 5,
      providerModelId: "model-2"
    };
    const createVersion = vi.fn(async () => ({}));
    const updateCredential = vi.fn(async () => ({ count: 1 }));
    const updateConnection = vi.fn(async () => ({ count: 1 }));
    const updateModel = vi.fn(async (_input: unknown) => ({ count: 1 }));
    const createChecks = vi.fn(async () => ({ count: 1 }));
    const createSearchOption = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      archivedAt: null
    }));
    const createSearchStrategy = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      activeRevision: null
    }));
    const createSearchRevision = vi.fn(async ({ data }: {
      data: { searchStrategyId: string };
    }) => ({ id: `${data.searchStrategyId}:revision-1` }));
    const updateSearchStrategy = vi.fn(async () => ({}));
    const updateSearchStrategies = vi.fn(async () => ({ count: 1 }));
    const db = transactional({
      providerConnection: {
        findUnique: vi.fn(async () => ({
          defaultCredentialId: "credential-1",
          displayName: "Custom gateway",
          draftConfig: {},
          draftVersion: 2,
          family: scenario.family,
          id: "connection-1",
          templateKey: scenario.templateKey
        })),
        updateMany: updateConnection
      },
      providerCredential: {
        findMany: vi.fn(async () => [{
          activeVersion: null,
          activeVersionId: null,
          draftSecretEnvelope: "v2.draft.envelope.value",
          draftVersion: 3,
          enabled: true,
          id: "credential-1"
        }]),
        updateMany: updateCredential
      },
      providerCredentialVersion: {
        create: createVersion,
        deleteMany: vi.fn(async () => ({ count: 0 }))
      },
      providerDraftCheck: {
        findMany: vi.fn(async () => [{
          ...candidateCheck,
          evidence: candidateCheck.evidence
        }])
      },
      providerGroupCredentialAssignment: {
        findMany: vi.fn(async () => [])
      },
      providerUserCredentialAssignment: {
        findMany: vi.fn(async () => [])
      },
      providerModel: {
        findMany: vi.fn(async () => [
          { draftVersion: 4, id: "model-1" },
          { draftVersion: 5, id: "model-2" }
        ]),
        updateMany: updateModel
      },
      providerModelCredentialCheck: {
        createMany: createChecks,
        deleteMany: vi.fn(async () => ({ count: 0 }))
      },
      providerRunBinding: { updateMany: vi.fn(async () => ({ count: 0 })) },
      searchIntegrationRevision: {
        create: createSearchRevision,
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async () => null)
      },
      searchOption: {
        create: createSearchOption,
        findUnique: vi.fn(async () => null)
      },
      searchStrategy: {
        create: createSearchStrategy,
        findFirst: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(scenario.existingClient
            ? {
                draft: {
                  adapterKind: "provider_model_client",
                  credentialMode: "provider_model",
                  maxOutputTokens: 8_192,
                  maxResults: 11,
                  maxSearchCallsPerAnswer: 4,
                  protocol: "openai_responses_web_search",
                  providerModelId: "model-1",
                  queryMaxCharacters: 333,
                  reasoningPolicy: "provider_default",
                  timeoutMs: 123_000
                },
                id: scenario.clientId,
                providerModelId: "model-2"
              }
            : null),
        update: updateSearchStrategy,
        updateMany: updateSearchStrategies
      }
    });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.activateConnectionCas({
      checks: [candidateCheck, secondCandidateCheck],
      connection: {
        configuration: {
          allowPrivateNetwork: false,
          apiRoot: "https://provider.example.test/v1"
        },
        draftVersion: 2,
        enable: true,
        id: "connection-1"
      },
      credentials: [{
        checkedAt: NOW,
        draftVersion: 3,
        id: "credential-1",
        kind: "draft",
        testEvidence: { method: "models_catalog", modelCount: 1, version: 1 },
        versionEnvelope: "v2.active.envelope.value",
        versionId: "version-1"
      }],
      models: [{
        configuration: {
          adapterKind: scenario.adapterKind,
          answerSelectable: true,
          capabilities: {
            nativePdfInput: false,
            nativeSearch: true,
            pdf: false,
            reasoning: false,
            vision: false
          },
          defaultParams: {},
          modelClass: "answer",
          upstreamModelId: "vendor/model"
        },
        draftVersion: 4,
        id: "model-1"
      }, {
        configuration: {
          adapterKind: scenario.adapterKind,
          answerSelectable: true,
          capabilities: {
            nativePdfInput: false,
            nativeSearch: true,
            pdf: false,
            reasoning: false,
            vision: false
          },
          defaultParams: {},
          modelClass: "answer",
          upstreamModelId: "vendor/model-2"
        },
        draftVersion: 5,
        id: "model-2"
      }],
      now: NOW
    })).resolves.toBe("updated");
    expect(createVersion).toHaveBeenCalledWith({
      data: expect.objectContaining({
        credentialId: "credential-1",
        id: "version-1",
        secretEnvelope: "v2.active.envelope.value",
        testEvidence: { method: "models_catalog", modelCount: 1, version: 1 },
        testedAt: NOW,
        version: 3
      })
    });
    expect(updateCredential).toHaveBeenCalledWith({
      data: expect.objectContaining({
        activeVersionId: "version-1",
        draftSecretEnvelope: null
      }),
      where: { draftVersion: 3, id: "credential-1" }
    });
    expect(createChecks).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          connectionVersion: 2,
          credentialVersionId: "version-1",
          modelVersion: 4,
          providerModelId: "model-1",
          status: "available"
        }),
        expect.objectContaining({
          connectionVersion: 2,
          credentialVersionId: "version-1",
          modelVersion: 5,
          providerModelId: "model-2",
          status: "available"
        })
      ])
    });
    expect(createSearchOption).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: scenario.optionRowId,
        kind: scenario.optionKind,
        optionId: scenario.optionId,
        sourceConnectionId: "connection-1"
      })
    });
    expect(createSearchStrategy).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        adapterKind: "answer_provider_hosted",
        id: scenario.hostedId,
        kind: scenario.hostedKind,
        strategyId: scenario.hostedStrategyId
      })
    }));
    if (scenario.existingClient) {
      expect(createSearchStrategy).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ adapterKind: "provider_model_client" })
      }));
    } else {
      expect(createSearchStrategy).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          adapterKind: "provider_model_client",
          enabled: false,
          id: scenario.clientId,
          kind: scenario.clientKind,
          providerModelId: "model-1"
        })
      }));
    }
    expect(createSearchRevision).toHaveBeenCalledWith({
      data: expect.objectContaining({
        configuration: expect.objectContaining({ protocol: scenario.protocol }),
        searchStrategyId: scenario.hostedId,
        validationEvidence: expect.objectContaining({ sourceProbe: false })
      })
    });
    expect(createSearchRevision).toHaveBeenCalledWith({
      data: expect.objectContaining({
        configuration: expect.objectContaining({
          protocol: scenario.protocol,
          ...(scenario.existingClient
            ? {
              maxOutputTokens: 8_192,
              maxResults: 11,
              maxSearchCallsPerAnswer: 4,
              providerModelId: "model-2",
              queryMaxCharacters: 333,
              reasoningPolicy: "provider_default",
              timeoutMs: 123_000
            }
            : {})
        }),
        providerModelId: scenario.existingClient ? "model-2" : "model-1",
        searchStrategyId: scenario.clientId,
        validationEvidence: expect.objectContaining({ sourceProbe: false })
      })
    });
    expect(updateSearchStrategy).toHaveBeenCalledWith({
      data: expect.objectContaining({
        activeRevisionId: `${scenario.hostedId}:revision-1`,
        enabled: true
      }),
      where: { id: scenario.hostedId }
    });
    expect(updateSearchStrategy).toHaveBeenCalledWith({
      data: expect.objectContaining({
        activeRevisionId: `${scenario.clientId}:revision-1`,
        draft: expect.objectContaining(scenario.existingClient
          ? {
              maxOutputTokens: 8_192,
              maxSearchCallsPerAnswer: 4,
              providerModelId: "model-2",
              reasoningPolicy: "provider_default"
            }
          : {}),
        enabled: true,
        providerModelId: scenario.existingClient ? "model-2" : "model-1"
      }),
      where: { id: scenario.clientId }
    });
    expect(updateSearchStrategies).not.toHaveBeenCalled();
    expect(
      (updateModel.mock.calls[0]?.[0] as { data?: object } | undefined)?.data
    ).not.toHaveProperty("contextWindow");
  });

  it("deletes a disabled unreferenced credential by clearing its pointer before versions", async () => {
    const operations: string[] = [];
    const detach = vi.fn(async () => ({ count: 1 }));
    const db = transactional({
      providerConnection: { count: vi.fn(async () => 0) },
      providerCredential: {
        delete: vi.fn(async () => { operations.push("credential"); }),
        findUnique: vi.fn(async () => ({ enabled: false })),
        update: vi.fn(async () => { operations.push("pointer"); })
      },
      providerCredentialVersion: {
        deleteMany: vi.fn(async () => { operations.push("versions"); return { count: 2 }; })
      },
      providerGroupCredentialAssignment: { count: vi.fn(async () => 0) },
      providerUserCredentialAssignment: { count: vi.fn(async () => 0) },
      providerRunBinding: {
        count: vi.fn(async () => 0),
        updateMany: detach
      }
    });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.deleteCredential("credential-1")).resolves.toEqual({
      status: "deleted"
    });
    expect(operations).toEqual(["pointer", "versions", "credential"]);
    expect(detach).toHaveBeenCalledWith({
      data: {
        connectionId: null,
        credentialId: null,
        credentialVersionId: null,
        providerModelId: null
      },
      where: {
        AND: [
          { credentialId: "credential-1" },
          {
            modelRun: {
              status: { notIn: ["preparing", "in_progress", "queued", "streaming"] }
            }
          },
          {
            OR: [
              { recoverableUntil: null },
              { recoverableUntil: { lte: expect.any(Date) } }
            ]
          }
        ]
      }
    });
  });

  it("reports a direct user assignment before deleting a credential", async () => {
    const deleteCredential = vi.fn();
    const db = transactional({
      providerConnection: { count: vi.fn(async () => 0) },
      providerCredential: {
        delete: deleteCredential,
        findUnique: vi.fn(async () => ({ enabled: false }))
      },
      providerCredentialVersion: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      providerGroupCredentialAssignment: { count: vi.fn(async () => 0) },
      providerUserCredentialAssignment: { count: vi.fn(async () => 1) },
      providerRunBinding: {
        count: vi.fn(async () => 0),
        updateMany: vi.fn(async () => ({ count: 0 }))
      }
    });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.deleteCredential("credential-1")).resolves.toEqual({
      blockers: [{ count: 1, kind: "user_assignments" }],
      status: "conflict"
    });
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("serializes emergency revocation with the same credential-version row lock", async () => {
    const update = vi.fn(async () => ({}));
    const query = vi.fn(async (_sql: unknown) => [{
      credentialId: "credential-1",
      id: "version-1",
      revokedAt: null
    }]);
    const db = transactional({
      $queryRaw: query,
      providerCredentialVersion: { update }
    });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.revokeCredentialVersion({
      clearSecret: true,
      credentialId: "credential-1",
      now: NOW,
      versionId: "version-1"
    })).resolves.toBe("revoked");
    expect(update).toHaveBeenCalledWith({
      data: { revokedAt: NOW, secretEnvelope: null },
      where: { id: "version-1" }
    });
    const sql = query.mock.calls[0]?.[0] as { strings?: string[] } | undefined;
    expect(sql?.strings?.join(" ")).toContain("FOR UPDATE");
  });

  it("holds a conflicting shared lock while an active admin test decrypts a key version", async () => {
    const consume = vi.fn(() => "decrypted-for-one-call");
    const query = vi.fn(async (_sql: unknown) => [{
      credentialId: "credential-1",
      id: "version-1",
      revokedAt: null,
      secretEnvelope: "encrypted-value"
    }]);
    const db = transactional({ $queryRaw: query });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.withLockedCredential(
      "credential-1",
      "version-1",
      consume
    )).resolves.toBe("decrypted-for-one-call");
    expect(consume).toHaveBeenCalledWith(expect.objectContaining({
      credentialId: "credential-1",
      id: "version-1",
      secretEnvelope: "encrypted-value"
    }));
    const sql = query.mock.calls[0]?.[0] as { strings?: string[] } | undefined;
    expect(sql?.strings?.join(" ")).toContain("FOR SHARE");
  });

  it("assigns only a same-connection credential to a current non-archived group", async () => {
    const upsert = vi.fn(async () => ({}));
    const db = transactional({
      group: { findFirst: vi.fn(async () => ({ id: "group-1" })) },
      providerCredential: { findFirst: vi.fn(async () => ({ id: "credential-1" })) },
      providerGroupCredentialAssignment: { upsert }
    });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.assignGroupCredential({
      connectionId: "connection-1",
      credentialId: "credential-1",
      groupId: "group-1"
    })).resolves.toBe("assigned");
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: {
        connectionId: "connection-1",
        credentialId: "credential-1",
        groupId: "group-1"
      }
    }));
  });

  it("CAS-refreshes active authority and clears only its prior transient warning", async () => {
    const upsert = vi.fn(async () => ({}));
    const db = transactional({
      providerConnection: { findUnique: vi.fn(async () => ({ activeVersion: 2 })) },
      providerCredential: {
        findFirst: vi.fn(async () => ({
          activeVersion: { revokedAt: null, secretEnvelope: "active-envelope" },
          activeVersionId: "version-1"
        }))
      },
      providerModel: { findFirst: vi.fn(async () => ({ activeVersion: 4 })) },
      providerModelCredentialCheck: { upsert }
    });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.storeActiveRefreshCas({
      candidate: activeCandidate(),
      checkedAt: NOW,
      evidence: {
        detail: "model_missing",
        method: "openrouter_account_catalog",
        selectedProviders: [],
        upstreamModelId: "vendor/model"
      },
      status: "unavailable"
    })).resolves.toBe("stored");
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ status: "unavailable" }),
      update: expect.objectContaining({
        checkedAt: NOW,
        refreshFailedAt: null,
        status: "unavailable"
      }),
      where: {
        providerModelId_credentialVersionId_connectionVersion_modelVersion: {
          connectionVersion: 2,
          credentialVersionId: "version-1",
          modelVersion: 4,
          providerModelId: "model-1"
        }
      }
    }));
  });

  it("records a value-free refresh warning without overwriting prior active status", async () => {
    const updateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
    const db = transactional({
      providerConnection: { findUnique: vi.fn(async () => ({ activeVersion: 2 })) },
      providerCredential: {
        findFirst: vi.fn(async () => ({
          activeVersion: { revokedAt: null, secretEnvelope: "active-envelope" },
          activeVersionId: "version-1"
        }))
      },
      providerModel: { findFirst: vi.fn(async () => ({ activeVersion: 4 })) },
      providerModelCredentialCheck: { updateMany }
    });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.recordActiveRefreshFailureCas({
      candidate: activeCandidate(),
      failedAt: NOW
    })).resolves.toBe("stored");
    const update = updateMany.mock.calls[0]?.[0] as
      | { data: Record<string, unknown> }
      | undefined;
    expect(update).toEqual(expect.objectContaining({
      data: {
        latestRefreshError: { code: "provider_refresh_failed", version: 1 },
        refreshFailedAt: NOW
      }
    }));
    expect(update?.data).not.toHaveProperty("status");
    expect(update?.data).not.toHaveProperty("evidence");
    expect(JSON.stringify(update)).not.toContain("active-envelope");
  });

  it("deletes a Custom connection and its removable configuration graph atomically", async () => {
    const deleteConnection = vi.fn(async () => undefined);
    const db = transactional({
      accessGrant: { deleteMany: vi.fn(async () => ({ count: 1 })) },
      chat: { updateMany: vi.fn(async () => ({ count: 1 })) },
      modelPolicy: { updateMany: vi.fn(async () => ({ count: 1 })) },
      providerConnection: {
        delete: deleteConnection,
        findUnique: vi.fn(async () => ({
          enabled: true,
          family: "openai_compatible",
          templateKey: null
        })),
        update: vi.fn(async () => undefined)
      },
      providerCredential: {
        deleteMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => [{ id: "credential-1" }]),
        updateMany: vi.fn(async () => ({ count: 1 }))
      },
      providerCredentialVersion: {
        deleteMany: vi.fn(async () => ({ count: 1 }))
      },
      providerDraftCheck: { deleteMany: vi.fn(async () => ({ count: 1 })) },
      providerGroupCredentialAssignment: {
        deleteMany: vi.fn(async () => ({ count: 0 }))
      },
      providerModel: {
        deleteMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => [{ id: "model-1" }])
      },
      providerModelCredentialCheck: {
        deleteMany: vi.fn(async () => ({ count: 1 }))
      },
      providerRunBinding: {
        count: vi.fn(async () => 0),
        updateMany: vi.fn(async () => ({ count: 0 }))
      },
      providerUserCredentialAssignment: {
        deleteMany: vi.fn(async () => ({ count: 1 }))
      },
      assistantRevision: { count: vi.fn(async () => 0) },
      searchIntegrationRevision: { count: vi.fn(async () => 0) },
      searchOption: { count: vi.fn(async () => 0) },
      searchStrategy: { count: vi.fn(async () => 0) },
      systemModelPolicy: { updateMany: vi.fn(async () => ({ count: 1 })) },
      userSettings: { updateMany: vi.fn(async () => ({ count: 1 })) }
    });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.deleteConnection("connection-1")).resolves.toEqual({
      status: "deleted"
    });
    expect(deleteConnection).toHaveBeenCalledWith({ where: { id: "connection-1" } });
    expect(db.userSettings.updateMany).toHaveBeenCalledWith({
      data: { defaultProviderModelId: null },
      where: { defaultProviderModelId: { in: ["model-1"] } }
    });
    expect(db.modelPolicy.updateMany).toHaveBeenCalledWith({
      data: {
        defaultProviderModelId: null,
        updatedByUserId: null,
        version: { increment: 1 }
      },
      where: { defaultProviderModelId: { in: ["model-1"] } }
    });
    expect(db.systemModelPolicy.updateMany).toHaveBeenCalledWith({
      data: {
        providerModelId: null,
        updatedByUserId: null,
        version: { increment: 1 }
      },
      where: { providerModelId: { in: ["model-1"] } }
    });
    expect(db.accessGrant.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { providerConnectionId: "connection-1" },
          { providerModelId: { in: ["model-1"] } }
        ]
      }
    });
  });

  it("keeps a Custom connection behind every live-run, assistant, and search hard fence", async () => {
    const deleteConnection = vi.fn();
    const db = transactional({
      assistantRevision: { count: vi.fn(async () => 2) },
      providerConnection: {
        delete: deleteConnection,
        findUnique: vi.fn(async () => ({
          enabled: true,
          family: "openai_compatible",
          templateKey: null
        }))
      },
      providerCredential: { findMany: vi.fn(async () => [{ id: "credential-1" }]) },
      providerCredentialVersion: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      providerModel: { findMany: vi.fn(async () => [{ id: "model-1" }]) },
      providerRunBinding: {
        count: vi.fn(async () => 1),
        updateMany: vi.fn(async () => ({ count: 0 }))
      },
      searchIntegrationRevision: { count: vi.fn(async () => 5) },
      searchOption: { count: vi.fn(async () => 1) },
      searchStrategy: { count: vi.fn(async () => 3) }
    });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.deleteConnection("connection-1")).resolves.toEqual({
      blockers: [
        { count: 4, kind: "search_references" },
        { count: 5, kind: "search_revision_references" },
        { count: 2, kind: "assistant_revisions" },
        { count: 1, kind: "run_bindings" }
      ],
      status: "conflict"
    });
    expect(db.assistantRevision.count).toHaveBeenCalledWith({
      where: { providerModelId: { in: ["model-1"] } }
    });
    expect(db.searchIntegrationRevision.count).toHaveBeenCalledWith({
      where: { providerModelId: { in: ["model-1"] } }
    });
    expect(deleteConnection).not.toHaveBeenCalled();
  });

  it("keeps a Custom connection referenced only by an archived logical Search source", async () => {
    const deleteConnection = vi.fn();
    const db = transactional({
      assistantRevision: { count: vi.fn(async () => 0) },
      providerConnection: {
        delete: deleteConnection,
        findUnique: vi.fn(async () => ({
          enabled: false,
          family: "openai_compatible",
          templateKey: null
        }))
      },
      providerCredential: { findMany: vi.fn(async () => []) },
      providerCredentialVersion: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      providerModel: { findMany: vi.fn(async () => []) },
      providerRunBinding: {
        count: vi.fn(async () => 0),
        updateMany: vi.fn(async () => ({ count: 0 }))
      },
      searchIntegrationRevision: { count: vi.fn(async () => 0) },
      searchOption: { count: vi.fn(async () => 1) },
      searchStrategy: { count: vi.fn(async () => 0) }
    });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.deleteConnection("connection-1")).resolves.toEqual({
      blockers: [{ count: 1, kind: "search_references" }],
      status: "conflict"
    });
    expect(db.searchOption.count).toHaveBeenCalledWith({
      where: { sourceConnectionId: "connection-1" }
    });
    expect(deleteConnection).not.toHaveBeenCalled();
  });
});
