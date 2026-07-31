import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { searchDraftHash } from "../../search/configuration";
import {
  AdminSearchServiceError,
  createAdminSearchService
} from "./service";

const NOW = new Date("2026-07-29T12:00:00.000Z");
const draft = {
  adapterKind: "provider_model_client" as const,
  credentialMode: "provider_model" as const,
  maxResults: 8,
  protocol: "openai_responses_web_search" as const,
  providerModelId: "technical-1",
  queryMaxCharacters: 500,
  timeoutMs: 15_000
};

function technicalModel() {
  return {
    activeConfig: {
      adapterKind: "openai_responses_compatible",
      answerSelectable: false,
      capabilities: {
        nativePdfInput: false,
        nativeSearch: true,
        pdf: false,
        reasoning: false,
        streaming: true,
        toolCalling: true,
        vision: false
      },
      defaultParams: {},
      upstreamModelId: "opaque-search-model"
    },
    activeVersion: 1,
    connection: {
      displayName: "Compatible gateway",
      enabled: true,
      family: "openai_compatible"
    },
    displayName: "Search model",
    enabled: true,
    id: "technical-1"
  };
}

describe("admin Search service", () => {
  it("reports dependency-aware readiness instead of treating every active revision as ready", async () => {
    const technical = {
      ...technicalModel(),
      activatedAt: NOW,
      connection: {
        activeConfig: {},
        activeVersion: 1,
        activatedAt: NOW,
        displayName: "Compatible gateway",
        enabled: true
      }
    };
    const baseRow = {
      activeRevision: {
        configuration: draft,
        id: "revision-1",
        revisionNumber: 1
      },
      activeRevisionId: "revision-1",
      activatedAt: NOW,
      adapterKind: draft.adapterKind,
      archivedAt: null,
      credentialMode: draft.credentialMode,
      description: "Search",
      displayName: "Search",
      draft,
      draftTestEvidence: null,
      draftVersion: 1,
      enabled: true,
      id: "integration-1",
      providerModel: technicalModel(),
      strategyId: "company-search",
      testedDraftHash: searchDraftHash(draft)
    };
    const prisma = {
      providerModel: { findMany: vi.fn(async () => [technical]) },
      searchPolicy: {
        findUnique: vi.fn(async () => ({
          defaultPlan: { mode: "all_selected", optionIds: [] },
          updatedAt: NOW,
          version: 1
        }))
      },
      searchStrategy: {
        findMany: vi.fn(async () => [
          baseRow,
          {
            ...baseRow,
            activeRevision: {
              configuration: {
                ...draft,
                adapterKind: "answer_provider_hosted",
                credentialMode: "answer_provider",
                protocol: "gemini_google_search",
                providerModelId: null
              },
              id: "revision-google",
              revisionNumber: 1
            },
            activeRevisionId: "revision-google",
            adapterKind: "answer_provider_hosted",
            credentialMode: "answer_provider",
            displayName: "Google Search",
            draft: {
              ...draft,
              adapterKind: "answer_provider_hosted",
              credentialMode: "answer_provider",
              protocol: "gemini_google_search",
              providerModelId: null
            },
            id: "integration-google",
            providerModel: null,
            strategyId: "gemini-google-search"
          }
        ])
      }
    } as unknown as PrismaClient;
    const search = createAdminSearchService({ prisma, tester: { test: vi.fn() } });

    const catalog = await search.list();

    expect(catalog.integrations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "integration-1", readiness: "ready", ready: true }),
      expect.objectContaining({
        id: "integration-google",
        readiness: "compatible_model_unavailable",
        ready: false
      })
    ]));
  });

  it("creates only a typed, disabled provider-model integration without endpoint or secret data", async () => {
    const create = vi.fn(async () => undefined);
    const prisma = {
      providerModel: { findFirst: vi.fn(async () => technicalModel()) },
      searchStrategy: { create }
    } as unknown as PrismaClient;
    const search = createAdminSearchService({
      idFactory: () => "12345678-1234-4234-8234-123456789012",
      prisma,
      tester: { test: vi.fn() }
    });

    await search.createDraft({
      description: " Query-only web evidence ",
      displayName: " Company Search ",
      draft
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        adapterKind: "provider_model_client",
        description: "Query-only web evidence",
        displayName: "Company Search",
        enabled: false,
        kind: "provider_model_web_search",
        modelId: "opaque-search-model",
        providerModelId: "technical-1",
        strategyId: "company-search-12345678"
      })
    });
    expect(JSON.stringify(create.mock.calls[0])).not.toContain("apiRoot");
    expect(JSON.stringify(create.mock.calls[0])).not.toContain("secret");
  });

  it("fences activation to the successfully tested exact draft", async () => {
    const revisionCreate = vi.fn(async () => ({ id: "revision-1" }));
    const strategyUpdate = vi.fn(async () => undefined);
    const current = {
      activeRevision: null,
      draft,
      draftTestEvidence: {
        checkedAt: NOW.toISOString(),
        method: "provider_search",
        normalizedSourceCount: 2,
        protocol: draft.protocol,
        status: "available"
      },
      id: "integration-1",
      revisions: [],
      testedDraftHash: searchDraftHash(draft)
    };
    const tx = {
      providerModel: { findFirst: vi.fn(async () => technicalModel()) },
      searchIntegrationRevision: {
        create: revisionCreate,
        findUnique: vi.fn(async () => null)
      },
      searchStrategy: {
        findUnique: vi.fn(async () => current),
        update: strategyUpdate
      }
    };
    const prisma = {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)
    } as unknown as PrismaClient;
    const search = createAdminSearchService({
      now: () => NOW,
      prisma,
      tester: { test: vi.fn() }
    });

    await search.activate({ id: "integration-1" });

    expect(revisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        configuration: draft,
        draftHash: searchDraftHash(draft),
        revisionNumber: 1,
        searchStrategyId: "integration-1"
      })
    });
    expect(strategyUpdate).toHaveBeenCalledWith({
      data: expect.objectContaining({ activeRevisionId: "revision-1" }),
      where: { id: "integration-1" }
    });

    current.testedDraftHash = "stale-hash";
    await expect(search.activate({ id: "integration-1" })).rejects.toEqual(
      expect.objectContaining<Partial<AdminSearchServiceError>>({
        code: "search_activation_evidence_missing"
      })
    );
    expect(revisionCreate).toHaveBeenCalledTimes(1);
  });

  it("keeps built-in identities archival-safe", async () => {
    const update = vi.fn();
    const prisma = {
      searchStrategy: {
        findUnique: vi.fn(async () => ({ strategyId: "openai-native-web-search" })),
        update
      }
    } as unknown as PrismaClient;
    const search = createAdminSearchService({ prisma, tester: { test: vi.fn() } });

    await expect(search.archive({ id: "built-in" })).rejects.toEqual(
      expect.objectContaining<Partial<AdminSearchServiceError>>({
        code: "search_system_integration_forbidden"
      })
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("validates and compare-and-swaps the installation Search recommendation", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const activeRow = {
      activeRevision: { configuration: draft, id: "revision-1", revisionNumber: 1 },
      activeRevisionId: "revision-1",
      activatedAt: NOW,
      adapterKind: draft.adapterKind,
      archivedAt: null,
      credentialMode: draft.credentialMode,
      description: "Query-only evidence",
      displayName: "Company Search",
      draft,
      draftTestEvidence: null,
      draftVersion: 1,
      enabled: true,
      id: "integration-1",
      providerModel: technicalModel(),
      strategyId: "company-search",
      testedDraftHash: searchDraftHash(draft)
    };
    const prisma = {
      providerModel: { findMany: vi.fn(async () => [{
        ...technicalModel(),
        activatedAt: NOW,
        connection: {
          activeConfig: {},
          activeVersion: 1,
          activatedAt: NOW,
          displayName: "Compatible gateway",
          enabled: true
        }
      }]) },
      searchPolicy: {
        findUnique: vi.fn(async () => ({
          defaultPlan: { mode: "all_selected", optionIds: [] },
          updatedAt: NOW,
          version: 3
        })),
        updateMany
      },
      searchStrategy: { findMany: vi.fn(async () => [activeRow]) }
    } as unknown as PrismaClient;
    const search = createAdminSearchService({ prisma, tester: { test: vi.fn() } });

    await search.updatePolicy({
      defaultPlan: { mode: "all_selected", optionIds: ["company-search"] },
      expectedVersion: 3,
      userId: "admin-1"
    });

    expect(updateMany).toHaveBeenCalledWith({
      data: {
        defaultPlan: { mode: "all_selected", optionIds: ["company-search"] },
        updatedByUserId: "admin-1",
        version: { increment: 1 }
      },
      where: { id: "installation", version: 3 }
    });
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(search.updatePolicy({
      defaultPlan: { mode: "all_selected", optionIds: ["company-search"] },
      expectedVersion: 3,
      userId: "admin-1"
    })).rejects.toMatchObject({ code: "search_policy_stale" });
  });
});
