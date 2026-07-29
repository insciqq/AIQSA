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
});
