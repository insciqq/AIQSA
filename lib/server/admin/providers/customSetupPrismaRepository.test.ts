import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { adminSearchExecutionDefaults } from "../../../contracts/adminSearch";
import type { AdminProviderCustomSetupCommitPlan } from "./customSetupRepositoryContract";
import { createPrismaAdminProviderCustomSetupRepository } from "./customSetupPrismaRepository";
import { searchDraftHash } from "../../search/configuration";

const now = new Date("2026-07-26T10:00:01.000Z");
const checkedAt = new Date("2026-07-26T10:00:00.000Z");

function plan(
  overrides: Partial<AdminProviderCustomSetupCommitPlan> = {}
): AdminProviderCustomSetupCommitPlan {
  return {
    actor: { sessionId: "session-admin", userId: "admin" },
    checkedAt,
    connection: {
      configuration: {
        allowPrivateNetwork: false,
        apiRoot: "https://llm.example.test/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 300_000
      },
      displayName: "Custom provider",
      id: "connection-1"
    },
    credential: {
      id: "credential-1",
      label: "Personal API key",
      secretEnvelope: "encrypted-envelope",
      versionId: "credential-version-1"
    },
    models: [{
      configuration: {
        adapterKind: "openai_chat_completions_compatible",
        answerSelectable: true,
        capabilities: {
          contextWindow: 8_192,
          defaultMaxOutputTokens: 1_024,
          nativePdfInput: false,
          nativeSearch: false,
          parallelToolCalls: false,
          pdf: false,
          reasoning: false,
          streaming: true,
          toolCalling: false,
          vision: false
        },
        defaultParams: {},
        modelClass: "answer",
        upstreamModelId: "vendor/model-1"
      },
      displayName: "Model 1",
      evidence: {
        detail: "ok",
        method: "tiny_generation",
        selectedProviders: [],
        upstreamModelId: "vendor/model-1"
      },
      grantId: "grant-1",
      id: "model-1"
    }],
    now,
    ...overrides
  };
}

function readyModel(commitPlan: AdminProviderCustomSetupCommitPlan, index = 0) {
  const model = commitPlan.models[index]!;
  return {
    activeConfig: model.configuration,
    activeCredentialChecks: [{
      connectionId: commitPlan.connection.id,
      connectionVersion: 1,
      credentialId: commitPlan.credential.id,
      credentialVersionId: commitPlan.credential.versionId,
      modelVersion: 1,
      providerModelId: model.id,
      status: "available"
    }],
    activeVersion: 1,
    activatedAt: now,
    connection: {
      activeConfig: commitPlan.connection.configuration,
      activeVersion: 1,
      activatedAt: now,
      credentials: [{
        activeVersion: {
          id: commitPlan.credential.versionId,
          revokedAt: null
        },
        enabled: true,
        groupAssignments: [],
        id: commitPlan.credential.id,
        userAssignments: [{
          credentialId: commitPlan.credential.id,
          userId: commitPlan.actor.userId
        }]
      }],
      defaultCredentialId: null,
      displayName: commitPlan.connection.displayName,
      enabled: true,
      family: "openai_compatible",
      id: commitPlan.connection.id,
      templateKey: null,
      unassignedPolicy: "require_assignment"
    },
    connectionId: commitPlan.connection.id,
    enabled: true,
    id: model.id,
    templateKey: null
  };
}

function searchPlan(
  commitPlan: AdminProviderCustomSetupCommitPlan
): NonNullable<AdminProviderCustomSetupCommitPlan["search"]> {
  const connectionId = commitPlan.connection.id;
  const hostedDraft = {
    adapterKind: "answer_provider_hosted" as const,
    credentialMode: "answer_provider" as const,
    maxOutputTokens: adminSearchExecutionDefaults.maxOutputTokens,
    maxResults: 8,
    maxSearchCallsPerAnswer: adminSearchExecutionDefaults.maxSearchCallsPerAnswer,
    protocol: "openai_responses_web_search" as const,
    providerModelId: null,
    queryMaxCharacters: 500,
    reasoningPolicy: "provider_default" as const,
    timeoutMs: 300_000
  };
  const clientDraft = {
    adapterKind: "provider_model_client" as const,
    credentialMode: "provider_model" as const,
    maxOutputTokens: adminSearchExecutionDefaults.maxOutputTokens,
    maxResults: 8,
    maxSearchCallsPerAnswer: adminSearchExecutionDefaults.maxSearchCallsPerAnswer,
    protocol: "openai_responses_web_search" as const,
    providerModelId: commitPlan.models[0]!.id,
    queryMaxCharacters: 500,
    reasoningPolicy: adminSearchExecutionDefaults.reasoningPolicy,
    timeoutMs: 300_000
  };
  return {
    client: {
      draft: clientDraft,
      draftHash: searchDraftHash(clientDraft),
      id: `custom-web-search-client:${connectionId}`,
      revisionId: `custom-web-search-client-revision:${connectionId}`,
      strategyId: `custom-web-search-client:${connectionId}`
    },
    description: "Web search provided by Custom provider.",
    displayName: "Custom provider Search",
    evidence: {
      checkedAt: checkedAt.toISOString(),
      method: "configuration",
      normalizedSourceCount: 0,
      protocol: "openai_responses_web_search",
      status: "available"
    },
    grantId: "search-grant-1",
    hosted: {
      draft: hostedDraft,
      draftHash: searchDraftHash(hostedDraft),
      id: `custom-web-search-hosted:${connectionId}`,
      revisionId: `custom-web-search-hosted-revision:${connectionId}`,
      strategyId: `custom-web-search-hosted:${connectionId}`
    },
    optionId: `custom-web-search:${connectionId}`,
    optionRowId: `custom-web-search-option:${connectionId}`
  };
}

function harness(options: Readonly<{
  grantModelIds?: string[];
  models?: unknown[];
  sessionRevoked?: boolean;
}> = {}) {
  const commitPlan = plan();
  const tx = {
    $queryRaw: vi.fn(async () => []),
    accessGrant: {
      create: vi.fn(async () => undefined),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => (options.grantModelIds ?? [commitPlan.models[0]!.id]).map((providerModelId) => ({
        enabled: true,
        groupId: null,
        providerConnectionId: null,
        providerModel: { connectionId: commitPlan.connection.id },
        providerModelId,
        searchStrategy: null,
        userId: commitPlan.actor.userId
      })))
    },
    authSession: {
      findUnique: vi.fn(async () => ({
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        revokedAt: options.sessionRevoked ? now : null,
        userId: commitPlan.actor.userId
      }))
    },
    providerConnection: { create: vi.fn(async () => undefined) },
    providerCredential: {
      create: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined)
    },
    providerCredentialVersion: { create: vi.fn(async () => undefined) },
    providerGroupCredentialAssignment: { create: vi.fn(async () => undefined) },
    providerModel: {
      create: vi.fn(async () => undefined),
      findMany: vi.fn(async () => options.models ?? [readyModel(commitPlan)])
    },
    providerModelCredentialCheck: { create: vi.fn(async () => undefined) },
    providerUserCredentialAssignment: { create: vi.fn(async () => undefined) },
    searchIntegrationRevision: { create: vi.fn(async () => undefined) },
    searchOption: { create: vi.fn(async () => undefined) },
    searchStrategy: {
      create: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined)
    },
    user: {
      findUnique: vi.fn(async () => ({ role: "admin", status: "active" }))
    },
    userGroup: { findMany: vi.fn(async () => []) },
    userSettings: {
      findUnique: vi.fn(async () => ({ defaultProviderModelId: null })),
      update: vi.fn(async () => undefined)
    }
  };
  const transaction = vi.fn(async (
    operation: (transactionClient: typeof tx) => Promise<unknown>,
    _options?: unknown
  ) => operation(tx));
  return {
    commitPlan,
    repository: createPrismaAdminProviderCustomSetupRepository({
      $transaction: transaction
    } as never),
    transaction,
    tx
  };
}

describe("Prisma custom provider setup repository", () => {
  it("publishes the tested graph and actor-only assignments in one serializable transaction", async () => {
    const { commitPlan, repository, transaction, tx } = harness();

    await expect(repository.commit(commitPlan)).resolves.toEqual({
      defaultChanged: false,
      status: "ready"
    });

    expect(transaction).toHaveBeenCalledOnce();
    expect(transaction.mock.calls[0]?.[1]).toMatchObject({
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    });
    expect(tx.providerConnection.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        activeConfig: expect.objectContaining({ authenticationMode: "bearer" }),
        activeVersion: 1,
        enabled: true,
        unassignedPolicy: "require_assignment"
      })
    });
    expect(tx.providerModel.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        activeVersion: 1,
        enabled: true,
        provider: "openai_compatible"
      })
    });
    expect(tx.providerCredentialVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        secretEnvelope: "encrypted-envelope",
        testEvidence: expect.objectContaining({ authenticationMode: "bearer" })
      })
    });
    expect(tx.providerUserCredentialAssignment.create).toHaveBeenCalledWith({
      data: {
        connectionId: "connection-1",
        credentialId: "credential-1",
        userId: "admin"
      }
    });
    expect(tx.accessGrant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        groupId: null,
        providerModelId: "model-1",
        userId: "admin"
      })
    });
    expect(tx.providerGroupCredentialAssignment.create).not.toHaveBeenCalled();
    expect(tx.userSettings.update).not.toHaveBeenCalled();
  });

  it("persists null secret material only for an explicit no-auth connection", async () => {
    const { commitPlan, repository, tx } = harness();
    const keyless = plan({
      connection: {
        ...commitPlan.connection,
        configuration: {
          allowPrivateNetwork: true,
          apiRoot: "http://127.0.0.1:11434/v1",
          authenticationMode: "none",
          responseTimeoutMs: 300_000
        }
      },
      credential: {
        ...commitPlan.credential,
        label: "No authentication",
        secretEnvelope: null
      }
    });

    await expect(repository.commit(keyless)).resolves.toMatchObject({ status: "ready" });
    expect(tx.providerCredentialVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        secretEnvelope: null,
        testEvidence: expect.objectContaining({ authenticationMode: "none" })
      })
    });
  });

  it("publishes every selected model, check, and grant inside the same transaction", async () => {
    const base = plan();
    const second = {
      ...base.models[0]!,
      configuration: {
        ...base.models[0]!.configuration,
        upstreamModelId: "vendor/model-2"
      },
      displayName: "Model 2",
      evidence: {
        ...base.models[0]!.evidence,
        upstreamModelId: "vendor/model-2"
      },
      grantId: "grant-2",
      id: "model-2"
    };
    const multi = plan({ models: [base.models[0]!, second] });
    const { repository, transaction, tx } = harness({
      grantModelIds: ["model-1", "model-2"],
      models: [readyModel(multi), readyModel(multi, 1)]
    });

    await expect(repository.commit(multi)).resolves.toMatchObject({ status: "ready" });

    expect(transaction).toHaveBeenCalledOnce();
    expect(tx.providerModel.create).toHaveBeenCalledTimes(2);
    expect(tx.providerModelCredentialCheck.create).toHaveBeenCalledTimes(2);
    expect(tx.accessGrant.create).toHaveBeenCalledTimes(2);
    expect(tx.userSettings.update).not.toHaveBeenCalled();
  });

  it("publishes tested hosted and client routes behind one connection-scoped Search option", async () => {
    const { commitPlan, repository, tx } = harness();
    const searchCapable = plan({
      ...commitPlan,
      models: [{
        ...commitPlan.models[0]!,
        configuration: {
          ...commitPlan.models[0]!.configuration,
          adapterKind: "openai_responses_compatible",
          capabilities: {
            ...commitPlan.models[0]!.configuration.capabilities,
            nativeSearch: true
          }
        }
      }]
    });
    const withSearch = { ...searchCapable, search: searchPlan(searchCapable) };
    await expect(repository.commit(withSearch)).resolves.toMatchObject({
      search: "ready",
      status: "ready"
    });

    expect(tx.searchOption.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        displayName: "Custom provider Search",
        enabled: true,
        optionId: "custom-web-search:connection-1",
        sourceConnectionId: "connection-1"
      })
    });
    expect(tx.searchStrategy.create).toHaveBeenCalledTimes(2);
    expect(tx.searchStrategy.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        adapterKind: "answer_provider_hosted",
        enabled: true,
        providerModelId: null,
        searchOptionId: "custom-web-search-option:connection-1"
      })
    });
    expect(tx.searchStrategy.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        adapterKind: "provider_model_client",
        enabled: true,
        providerModelId: "model-1",
        searchOptionId: "custom-web-search-option:connection-1"
      })
    });
    expect(tx.searchIntegrationRevision.create).toHaveBeenCalledTimes(2);
    expect(tx.searchIntegrationRevision.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        validationEvidence: expect.objectContaining({
          method: "configuration",
          normalizedSourceCount: 0,
          status: "available"
        })
      })
    });
    expect(JSON.stringify(tx.searchIntegrationRevision.create.mock.calls))
      .not.toContain("probeBinding");
    expect(tx.searchStrategy.update).toHaveBeenCalledTimes(2);
    expect(tx.accessGrant.create).toHaveBeenCalledTimes(2);
    expect(tx.accessGrant.create).toHaveBeenLastCalledWith({
      data: {
        enabled: true,
        groupId: null,
        id: "search-grant-1",
        providerConnectionId: null,
        providerModelId: null,
        searchStrategy: "custom-web-search:connection-1",
        userId: "admin"
      }
    });
  });

  it("publishes the client route without credential-bound probe evidence", async () => {
    const { commitPlan, repository, tx } = harness();
    const searchCapable = plan({
      ...commitPlan,
      models: [{
        ...commitPlan.models[0]!,
        configuration: {
          ...commitPlan.models[0]!.configuration,
          adapterKind: "openai_responses_compatible",
          capabilities: {
            ...commitPlan.models[0]!.configuration.capabilities,
            nativeSearch: true
          }
        }
      }]
    });
    await expect(repository.commit({
      ...searchCapable,
      search: searchPlan(searchCapable)
    })).resolves.toMatchObject({ search: "ready", status: "ready" });

    expect(tx.searchOption.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ enabled: true })
    });
    expect(tx.searchStrategy.create).toHaveBeenCalledTimes(2);
    expect(tx.searchStrategy.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        adapterKind: "answer_provider_hosted",
        enabled: true
      })
    });
    expect(tx.searchStrategy.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        adapterKind: "provider_model_client",
        enabled: true
      })
    });
    expect(tx.searchIntegrationRevision.create).toHaveBeenCalledTimes(2);
    expect(tx.searchIntegrationRevision.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        adapterKind: "provider_model_client",
        providerModelId: "model-1",
        searchStrategyId: "custom-web-search-client:connection-1",
        validationEvidence: expect.not.objectContaining({ probeBinding: expect.anything() })
      })
    });
    expect(tx.searchStrategy.update).toHaveBeenCalledTimes(2);
  });

  it("refuses a stale actor before creating provider state", async () => {
    const { commitPlan, repository, tx } = harness({ sessionRevoked: true });
    await expect(repository.commit(commitPlan)).resolves.toBe("forbidden");
    expect(tx.providerConnection.create).not.toHaveBeenCalled();
    expect(tx.providerModel.create).not.toHaveBeenCalled();
  });

  it("refuses an empty commit plan before creating provider state", async () => {
    const { commitPlan, repository, tx } = harness();
    await expect(repository.commit({ ...commitPlan, models: [] })).resolves.toBe(
      "catalog_unavailable"
    );
    expect(tx.providerConnection.create).not.toHaveBeenCalled();
    expect(tx.providerModel.create).not.toHaveBeenCalled();
  });

  it("maps a failed post-write catalog proof to catalog_unavailable", async () => {
    const { commitPlan, repository, tx } = harness({ models: [] });
    await expect(repository.commit(commitPlan)).resolves.toBe("catalog_unavailable");
    expect(tx.userSettings.update).not.toHaveBeenCalled();
  });

  it("retries only serialization conflicts and maps the exhausted race to stale", async () => {
    const serialization = () => new Prisma.PrismaClientKnownRequestError(
      "serialization",
      { clientVersion: "6.19.3", code: "P2034" }
    );
    const transaction = vi.fn()
      .mockRejectedValueOnce(serialization())
      .mockRejectedValueOnce(serialization())
      .mockRejectedValueOnce(serialization());
    const repository = createPrismaAdminProviderCustomSetupRepository({
      $transaction: transaction
    } as never);

    await expect(repository.commit(plan())).resolves.toBe("stale");
    expect(transaction).toHaveBeenCalledTimes(3);
  });
});
