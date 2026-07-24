import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { loadProviderAdmissionPlan } from "./admission";

describe("provider admission", () => {
  it("does not authorize a provider-backed search deployment as its own answer model", async () => {
    const providerModelId = "opaque-search-deployment";
    const findUnique = vi.fn();
    const db = {
      accessGrant: { count: vi.fn(async () => 1) },
      providerCredential: { findMany: vi.fn(async () => []) },
      providerGroupCredentialAssignment: { findMany: vi.fn(async () => []) },
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
});
