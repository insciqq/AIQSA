import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { loadProviderAdmissionPlan } from "./admission";

function fullAccessAdmissionDb(input: Readonly<{
  compatibleResponses?: boolean;
  directCredential?: boolean;
}> = {}) {
  const accessGrantCount = vi.fn(async () => 0);
  const credentialId = "credential-1";
  const db = {
    accessGrant: { count: accessGrantCount },
    providerCredential: {
      findMany: vi.fn(async () => [{
        activeVersion: { id: "credential-version-1", revokedAt: null },
        enabled: true,
        id: credentialId
      }])
    },
    providerGroupCredentialAssignment: { findMany: vi.fn(async () => []) },
    providerUserCredentialAssignment: {
      findUnique: vi.fn(async () => input.directCredential === false
        ? null
        : { credentialId })
    },
    providerModel: {
      findFirst: vi.fn(async () => ({
        activeConfig: {
          adapterKind: input.compatibleResponses
            ? "openai_responses_compatible"
            : "openai_responses_native",
          capabilities: {
            nativePdfInput: true,
            nativeSearch: true,
            pdf: true,
            reasoning: true,
            streaming: true,
            toolCalling: true,
            vision: true
          },
          defaultParams: { maxOutputTokens: 128_000 },
          upstreamModelId: "gpt-future"
        },
        activeVersion: 1,
        connection: {
          activeConfig: {
            allowPrivateNetwork: false,
            apiRoot: input.compatibleResponses
              ? "https://compatible.example.test/v1"
              : "https://api.openai.com/v1"
          },
          activeVersion: 1,
          defaultCredentialId: null,
          displayName: "OpenAI",
          enabled: true,
          family: input.compatibleResponses ? "openai_compatible" : "openai",
          id: "connection-future",
          unassignedPolicy: "use_default"
        },
        connectionId: "connection-future",
        contextWindow: 128_000,
        displayName: "Future model",
        enabled: true,
        id: "deployment-future"
      })),
      findUnique: vi.fn()
    },
    providerModelCredentialCheck: { findFirst: vi.fn(async () => ({ id: "check-1" })) },
    searchStrategy: {
      findFirst: vi.fn(async () => ({
        config: {},
        enabled: true,
        kind: "openai_native_web_search",
        providerModelId: null,
        strategyId: "future-native-search"
      }))
    },
    user: { findFirst: vi.fn(async () => ({ id: "user-1" })) },
    userGroup: {
      findMany: vi.fn(async () => [{
        group: { systemRole: "full_access" },
        groupId: "full-access"
      }])
    }
  };

  return { accessGrantCount, db };
}

describe("provider admission", () => {
  it("resolves a verified model context before snapshotting a new run", async () => {
    const db = {
      accessGrant: { count: vi.fn(async () => 1) },
      providerCredential: {
        findMany: vi.fn(async () => [{
          activeVersion: { id: "credential-version-1", revokedAt: null },
          enabled: true,
          id: "credential-1"
        }])
      },
      providerGroupCredentialAssignment: { findMany: vi.fn(async () => []) },
      providerUserCredentialAssignment: {
        findUnique: vi.fn(async () => ({ credentialId: "credential-1" }))
      },
      providerModel: {
        findFirst: vi.fn(async () => ({
          activeConfig: {
            adapterKind: "openai_responses_native",
            capabilities: {
              nativePdfInput: true,
              nativeSearch: true,
              pdf: true,
              reasoning: true,
              streaming: true,
              vision: true
            },
            defaultParams: { maxOutputTokens: 128_000 },
            upstreamModelId: "gpt-5.6-sol"
          },
          activeVersion: 1,
          connection: {
            activeConfig: {
              allowPrivateNetwork: false,
              apiRoot: "https://api.openai.com/v1"
            },
            activeVersion: 1,
            defaultCredentialId: "credential-1",
            displayName: "OpenAI",
            enabled: true,
            family: "openai",
            id: "connection-1",
            unassignedPolicy: "use_default"
          },
          connectionId: "connection-1",
          contextWindow: 1,
          displayName: "GPT-5.6 Sol",
          enabled: true,
          id: "deployment-1"
        })),
        findUnique: vi.fn()
      },
      providerModelCredentialCheck: { findFirst: vi.fn(async () => ({ id: "check-1" })) },
      searchStrategy: {
        findFirst: vi.fn(async () => ({
          config: {},
          enabled: true,
          kind: "none",
          providerModelId: null,
          strategyId: "search-disabled"
        }))
      },
      user: { findFirst: vi.fn(async () => ({ id: "user-1" })) },
      userGroup: { findMany: vi.fn(async () => []) }
    };

    const plan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: "connection-1",
      providerModelId: "deployment-1",
      searchStrategyId: "search-disabled",
      userId: "user-1"
    });

    expect(plan.answer.modelConfiguration.capabilities.contextWindow).toBe(1_050_000);
    expect(plan.answer.snapshot.model.capabilities.contextWindow).toBe(1_050_000);
    expect(plan.answer.credentialSource).toBe("user");
  });

  it("admits future model and search ids through full access without grant rows", async () => {
    const { accessGrantCount, db } = fullAccessAdmissionDb();

    const plan = await loadProviderAdmissionPlan(
      db as unknown as Prisma.TransactionClient,
      {
        providerConnectionId: "connection-future",
        providerModelId: "deployment-future",
        searchStrategyId: "future-native-search",
        userId: "user-1"
      }
    );

    expect(plan.answer.credentialSource).toBe("user");
    expect(plan.requestedSearchStrategyId).toBe("future-native-search");
    expect(accessGrantCount).not.toHaveBeenCalled();
  });

  it("admits declared hosted web search for compatible Responses", async () => {
    const { db } = fullAccessAdmissionDb({ compatibleResponses: true });

    await expect(loadProviderAdmissionPlan(
      db as unknown as Prisma.TransactionClient,
      {
        providerConnectionId: "connection-future",
        providerModelId: "deployment-future",
        searchStrategyId: "future-native-search",
        userId: "user-1"
      }
    )).resolves.toMatchObject({
      answer: {
        snapshot: {
          model: { adapterKind: "openai_responses_compatible" },
          providerFamily: "openai_compatible"
        }
      }
    });
  });

  it("does not let full access bypass credential selection", async () => {
    const { accessGrantCount, db } = fullAccessAdmissionDb({ directCredential: false });

    await expect(loadProviderAdmissionPlan(
      db as unknown as Prisma.TransactionClient,
      {
        providerConnectionId: "connection-future",
        providerModelId: "deployment-future",
        searchStrategyId: "future-native-search",
        userId: "user-1"
      }
    )).rejects.toMatchObject({ code: "credential_default_missing" });
    expect(accessGrantCount).not.toHaveBeenCalled();
  });

  it("does not authorize a provider-backed search deployment as its own answer model", async () => {
    const providerModelId = "opaque-search-deployment";
    const findUnique = vi.fn();
    const db = {
      accessGrant: { count: vi.fn(async () => 1) },
      providerCredential: { findMany: vi.fn(async () => []) },
      providerGroupCredentialAssignment: { findMany: vi.fn(async () => []) },
      providerUserCredentialAssignment: { findUnique: vi.fn(async () => null) },
      providerModel: {
        findFirst: vi.fn(async () => ({
          activeConfig: {
            adapterKind: "fake",
            capabilities: {
              nativePdfInput: false,
              nativeSearch: false,
              pdf: false,
              reasoning: false,
              toolCalling: true,
              vision: false
            },
            defaultParams: {},
            upstreamModelId: "search/upstream"
          },
          activeVersion: 1,
          connection: {
            activeConfig: {
              allowPrivateNetwork: true,
              apiRoot: "http://127.0.0.1"
            },
            activeVersion: 1,
            defaultCredentialId: null,
            displayName: "Fake",
            enabled: true,
            family: "fake",
            id: "fake-connection",
            unassignedPolicy: "use_default"
          },
          connectionId: "fake-connection",
          displayName: "Search model",
          enabled: true,
          id: providerModelId
        })),
        findUnique
      },
      providerModelCredentialCheck: { findFirst: vi.fn() },
      searchStrategy: {
        findFirst: vi.fn(async () => ({
          config: {},
          enabled: true,
          kind: "perplexity_tool_search",
          providerModelId,
          strategyId: "perplexity-tool-search"
        }))
      },
      user: { findFirst: vi.fn(async () => ({ id: "user-1" })) },
      userGroup: { findMany: vi.fn(async () => []) }
    };

    await expect(loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: "fake-connection",
      providerModelId,
      searchStrategyId: "perplexity-tool-search",
      userId: "user-1"
    })).rejects.toMatchObject({
      code: "search_strategy_not_available"
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("admits an ordered multi-engine client plan with exact revision and binding keys", async () => {
    const { db } = fullAccessAdmissionDb({ compatibleResponses: true });
    const answerModel = await db.providerModel.findFirst();
    const model = (id: string) => ({
      ...answerModel,
      activeConfig: {
        ...answerModel.activeConfig,
        adapterKind: "openai_responses_compatible",
        capabilities: { ...answerModel.activeConfig.capabilities, nativeSearch: true },
        upstreamModelId: `upstream-${id}`
      },
      id
    });
    const multiDb = {
      ...db,
      providerModel: {
        findFirst: vi.fn(async (args?: { where?: { id?: string } }) =>
          model(args?.where?.id ?? "deployment-future")),
        findUnique: vi.fn(async () => ({ connectionId: "connection-future" }))
      },
      searchStrategy: {
        findFirst: vi.fn(async (args?: { where?: { strategyId?: string } }) => {
          const optionId = args?.where?.strategyId ?? "missing";
          const ordinal = optionId === "search-alpha" ? 1 : 2;
          return {
            activeRevision: {
              adapterKind: "provider_model_client",
              configuration: {
                adapterKind: "provider_model_client",
                credentialMode: "provider_model",
                maxResults: 8,
                protocol: "openai_responses_web_search",
                providerModelId: `technical-${ordinal}`,
                queryMaxCharacters: 500,
                timeoutMs: 15_000
              },
              credentialMode: "provider_model",
              id: `revision-${ordinal}`,
              providerModelId: `technical-${ordinal}`
            },
            config: {},
            enabled: true,
            id: `integration-${ordinal}`,
            kind: "provider_model_web_search",
            providerModelId: `technical-${ordinal}`,
            strategyId: optionId
          };
        })
      }
    };

    const plan = await loadProviderAdmissionPlan(
      multiDb as unknown as Prisma.TransactionClient,
      {
        providerConnectionId: "connection-future",
        providerModelId: "deployment-future",
        searchPlan: {
          mode: "all_selected",
          optionIds: ["search-alpha", "search-beta"]
        },
        searchStrategyId: "search-alpha",
        userId: "user-1"
      }
    );

    expect(plan.searches).toEqual([
      expect.objectContaining({
        bindingKey: "search:search-alpha",
        integrationId: "integration-1",
        optionId: "search-alpha",
        ordinal: 0,
        revisionId: "revision-1"
      }),
      expect.objectContaining({
        bindingKey: "search:search-beta",
        integrationId: "integration-2",
        optionId: "search-beta",
        ordinal: 1,
        revisionId: "revision-2"
      })
    ]);
    expect(plan.requestedSearchPlan).toEqual({
      mode: "all_selected",
      optionIds: ["search-alpha", "search-beta"]
    });
  });
});
