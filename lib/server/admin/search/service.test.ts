import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AdminSearchDraft } from "../../../contracts/adminSearch";
import { searchDraftHash } from "../../search/configuration";
import type { SearchProbeBinding } from "../../search/probeBinding";
import { createAdminSearchService } from "./service";

const NOW = new Date("2026-07-29T12:00:00.000Z");
const draft: AdminSearchDraft = {
  adapterKind: "provider_model_client",
  credentialMode: "provider_model",
  maxOutputTokens: 4_096,
  maxResults: 8,
  maxSearchCallsPerAnswer: 2,
  protocol: "openai_responses_web_search",
  providerModelId: "technical-1",
  queryMaxCharacters: 500,
  reasoningPolicy: "lowest_supported",
  timeoutMs: 15_000
};
const hostedDraft: AdminSearchDraft = {
  ...draft,
  adapterKind: "answer_provider_hosted",
  credentialMode: "answer_provider",
  providerModelId: null,
  reasoningPolicy: "provider_default"
};
const PROBE_BINDING = {
  connectionId: "connection-1",
  connectionVersion: 1,
  credentialId: "credential-1",
  credentialVersionId: "credential-version-1",
  modelVersion: 1,
  providerModelId: "technical-1"
} as const;

function providerModel(input: Readonly<{
  adapterKind?:
    | "gemini_interactions_native"
    | "openai_responses_compatible"
    | "openrouter_chat_completions";
  connectionId?: string;
  id?: string;
}> = {}) {
  const adapterKind = input.adapterKind ?? "openai_responses_compatible";
  const connectionId = input.connectionId ?? "connection-1";
  const searchReasoningSupported = adapterKind === "openai_responses_compatible" ||
    adapterKind === "gemini_interactions_native";
  return {
    activeConfig: {
      adapterKind,
      answerSelectable: adapterKind === "gemini_interactions_native",
      capabilities: {
        nativePdfInput: false,
        nativeSearch: true,
        pdf: false,
        reasoning: searchReasoningSupported,
        ...(searchReasoningSupported
          ? { defaultReasoningEffort: "low", reasoningEfforts: ["low", "medium"] }
          : {}),
        streaming: true,
        toolCalling: true,
        vision: false
      },
      defaultParams: {},
      ...(adapterKind === "openrouter_chat_completions"
        ? { openRouterRouting: { mode: "automatic", providers: [] } }
        : {}),
      upstreamModelId: adapterKind === "gemini_interactions_native"
        ? "gemini-search"
        : adapterKind === "openrouter_chat_completions"
          ? "perplexity/sonar"
        : "opaque-search-model"
    },
    activeVersion: 1,
    activatedAt: NOW,
    connection: {
      activeConfig: {
        allowPrivateNetwork: false,
        apiRoot: "https://provider.example.test/v1",
        responseTimeoutMs: 500_000
      },
      activeVersion: 1,
      activatedAt: NOW,
      displayName: adapterKind === "gemini_interactions_native" ? "Gemini" : "Compatible gateway",
      enabled: true,
      family: adapterKind === "gemini_interactions_native"
        ? "gemini"
        : adapterKind === "openrouter_chat_completions"
          ? "openrouter"
          : "openai_compatible",
      id: connectionId
    },
    connectionId,
    displayName: adapterKind === "gemini_interactions_native" ? "Gemini Search" : "Search model",
    enabled: true,
    id: input.id ?? "technical-1"
  };
}

function activeRevision(configuration: AdminSearchDraft, id = "revision-1") {
  const validationEvidence = {
    checkedAt: NOW.toISOString(),
    method: "configuration",
    normalizedSourceCount: 0,
    protocol: configuration.protocol,
    status: "available"
  };
  return {
    adapterKind: configuration.adapterKind,
    configuration,
    credentialMode: configuration.credentialMode,
    draftHash: searchDraftHash(configuration),
    id,
    providerModelId: configuration.providerModelId,
    revisionNumber: 1,
    validationEvidence
  };
}

function child(
  configuration: AdminSearchDraft,
  overrides: Record<string, unknown> = {}
) {
  const revision = activeRevision(configuration);
  return {
    activeRevision: revision,
    activeRevisionId: revision.id,
    activatedAt: NOW,
    adapterKind: configuration.adapterKind,
    archivedAt: null,
    draft: configuration,
    draftTestEvidence: null,
    draftVersion: 1,
    enabled: true,
    id: "strategy-1",
    providerModelId: configuration.providerModelId,
    revisions: [{ revisionNumber: 1 }],
    strategyId: "physical-search-1",
    testedDraftHash: searchDraftHash(configuration),
    ...overrides
  };
}

function option(
  strategies: ReturnType<typeof child>[],
  overrides: Record<string, unknown> = {}
) {
  return {
    archivedAt: null,
    description: "Web evidence",
    displayName: "OpenAI Search",
    enabled: true,
    id: "source-1",
    kind: "web_search",
    optionId: "openai-search",
    sourceConnectionId: "connection-1",
    strategies,
    templateKey: "search:openai",
    ...overrides
  };
}

function pendingChild(
  configuration: AdminSearchDraft,
  overrides: Record<string, unknown> = {}
) {
  return child(configuration, {
    activeRevision: null,
    activeRevisionId: null,
    activatedAt: null,
    enabled: false,
    revisions: [],
    testedDraftHash: null,
    ...overrides
  });
}

function revisionRepository() {
  let revision = 0;
  return {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      id: `published-revision-${++revision}`
    })),
    findUnique: vi.fn(async () => null)
  };
}

function policyRow(version = 1) {
  return {
    defaultPlan: { mode: "all_selected", optionIds: [] },
    updatedAt: NOW,
    version
  };
}

describe("admin Search service", () => {
  it("aggregates hosted and incomplete broader-model setup into one usable source", async () => {
    const client = child(draft, {
      draftTestEvidence: null,
      enabled: false,
      id: "strategy-client",
      strategyId: "physical-client",
      testedDraftHash: null
    });
    const prisma = {
      providerModel: { findMany: vi.fn(async () => [providerModel()]) },
      searchOption: {
        findMany: vi.fn(async () => [
          option([child(hostedDraft, { id: "strategy-hosted", strategyId: "physical-hosted" }), client]),
          option([], {
            id: "source-off",
            kind: "none",
            optionId: "search-disabled",
            sourceConnectionId: null,
            templateKey: "search:none"
          })
        ])
      },
      searchPolicy: { findUnique: vi.fn(async () => policyRow()) }
    } as unknown as PrismaClient;
    const service = createAdminSearchService({ prisma, tester: { test: vi.fn() } });

    const catalog = await service.list();

    expect(catalog.integrations).toEqual([
      expect.objectContaining({
        broaderModelSetup: "setup_required",
        configurable: true,
        configuration: draft,
        configurationActive: false,
        draftDirty: true,
        executionModes: ["model_choice"],
        id: "source-1",
        ready: true,
        readiness: "ready",
        strategyId: "openai-search",
        system: true
      })
    ]);
    expect(catalog.integrations[0]).not.toHaveProperty("adapterKind");
    expect(catalog.integrations[0]).not.toHaveProperty("activeRevision");
    expect(JSON.stringify(catalog)).not.toMatch(
      /probeBinding|credentialId|credentialVersionId|credential-1|credential-version-1/u
    );
    expect(catalog.providerModels).toEqual([
      expect.objectContaining({
        connectionId: "connection-1",
        id: "technical-1",
        responseTimeoutSeconds: 500,
        searchKind: "web_search",
        searchReasoningSupported: true
      })
    ]);
  });

  it("keeps the old active route ready while a replacement model draft awaits activation", async () => {
    const replacementDraft: AdminSearchDraft = {
      ...draft,
      providerModelId: "technical-2"
    };
    const staged = child(replacementDraft, {
      activeRevision: activeRevision(draft),
      activeRevisionId: "revision-1",
      providerModelId: draft.providerModelId
    });
    const prisma = {
      providerModel: {
        findMany: vi.fn(async () => [
          providerModel(),
          providerModel({ id: "technical-2" })
        ])
      },
      searchOption: { findMany: vi.fn(async () => [option([staged])]) },
      searchPolicy: { findUnique: vi.fn(async () => policyRow()) }
    } as unknown as PrismaClient;
    const service = createAdminSearchService({ prisma, tester: { test: vi.fn() } });

    const catalog = await service.list();

    expect(catalog.integrations[0]).toMatchObject({
      broaderModelSetup: "ready",
      configuration: replacementDraft,
      configurationActive: false,
      providerModel: { id: "technical-2" },
      ready: true
    });
  });

  it("keeps broader-model setup ready across credential rotation without a probe gate", async () => {
    const currentBinding = vi.fn(async (): Promise<SearchProbeBinding> => PROBE_BINDING);
    const prisma = {
      providerModel: { findMany: vi.fn(async () => [providerModel()]) },
      searchOption: {
        findMany: vi.fn(async () => [option([
          child(hostedDraft, { id: "strategy-hosted", strategyId: "physical-hosted" }),
          child(draft, { id: "strategy-client", strategyId: "physical-client" })
        ])])
      },
      searchPolicy: { findUnique: vi.fn(async () => policyRow()) }
    } as unknown as PrismaClient;
    const service = createAdminSearchService({
      prisma,
      tester: { currentBinding, test: vi.fn() }
    });

    const exact = await service.list({ userId: "admin-1" });
    expect(exact.integrations[0]).toMatchObject({
      broaderModelSetup: "ready",
      executionModes: ["all_selected", "model_choice"],
      ready: true
    });

    currentBinding.mockResolvedValueOnce({
      ...PROBE_BINDING,
      credentialVersionId: "credential-version-2"
    });
    const rotated = await service.list({ userId: "admin-1" });
    expect(rotated.integrations[0]).toMatchObject({
      broaderModelSetup: "ready",
      executionModes: ["all_selected", "model_choice"],
      ready: true,
      readiness: "ready"
    });
    expect(JSON.stringify(rotated)).not.toMatch(
      /probeBinding|credentialId|credentialVersionId|credential-version-2/u
    );
    expect(currentBinding).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "hosted",
      strategies: [
        child(hostedDraft, { id: "hosted-a", strategyId: "hosted-a" }),
        child(hostedDraft, { id: "hosted-b", strategyId: "hosted-b" })
      ]
    },
    {
      label: "client",
      strategies: [
        child(draft, { id: "client-a", strategyId: "client-a" }),
        child(draft, { id: "client-b", strategyId: "client-b" })
      ]
    }
  ])("fails closed for duplicate active $label children", async ({ strategies }) => {
    const prisma = {
      providerModel: { findMany: vi.fn(async () => [providerModel()]) },
      searchOption: { findMany: vi.fn(async () => [option(strategies)]) },
      searchPolicy: { findUnique: vi.fn(async () => policyRow()) }
    } as unknown as PrismaClient;
    const service = createAdminSearchService({ prisma, tester: { test: vi.fn() } });

    const catalog = await service.list();

    expect(catalog.integrations[0]).toMatchObject({
      configurable: false,
      configuration: null,
      executionModes: [],
      ready: false,
      readiness: "source_unavailable"
    });
  });

  it("keeps optional diagnostics separate from compatibility publication", async () => {
    const editable = child(draft, {
      draftTestEvidence: null,
      enabled: false,
      testedDraftHash: null
    });
    const hosted = child(hostedDraft, {
      id: "strategy-hosted",
      strategyId: "physical-hosted"
    });
    const source = option([editable, hosted]);
    const updateMany = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(editable, data);
      return { count: 1 };
    });
    const strategyUpdate = vi.fn(async () => undefined);
    const revisionCreate = vi.fn(async () => ({ id: "unexpected-revision" }));
    const tx = {
      providerModel: { findFirst: vi.fn(async () => providerModel()) },
      searchIntegrationRevision: {
        create: revisionCreate,
        findUnique: vi.fn(async () => editable.activeRevision)
      },
      searchOption: { findUnique: vi.fn(async () => source) },
      searchStrategy: { update: strategyUpdate, updateMany }
    };
    const prisma = {
      ...tx,
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)
    } as unknown as PrismaClient;
    const currentBinding = vi.fn(async () => PROBE_BINDING);
    const tester = {
      currentBinding,
      test: vi.fn(async () => ({
        method: "provider_search" as const,
        normalizedSourceCount: 2,
        probeBinding: PROBE_BINDING,
        protocol: draft.protocol,
        status: "available" as const
      }))
    };
    const service = createAdminSearchService({ now: () => NOW, prisma, tester });

    await service.activate({ id: "source-1", userId: "admin-1" });
    await service.testDraft({ id: "source-1", userId: "admin-1" });

    expect(tester.test).toHaveBeenCalledWith({ draft, userId: "admin-1" });
    expect(updateMany).toHaveBeenCalledWith({
      data: {
        draftTestEvidence: expect.objectContaining({
          checkedAt: NOW.toISOString(),
          method: "provider_search",
          status: "available"
        }),
        testedDraftHash: searchDraftHash(draft)
      },
      where: { draftVersion: 1, id: "strategy-1" }
    });
    expect(strategyUpdate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        activeRevisionId: "revision-1",
        enabled: true
      }),
      where: { id: "strategy-1" }
    });
    expect(revisionCreate).not.toHaveBeenCalled();
    expect(currentBinding).not.toHaveBeenCalled();
  });

  it("creates one disabled parent with linked client and hosted web-search routes", async () => {
    const optionCreate = vi.fn(async () => undefined);
    const strategyCreate = vi.fn(async () => undefined);
    const strategyUpdate = vi.fn(async () => undefined);
    const revisions = revisionRepository();
    const createdOption = option([
      pendingChild(draft, {
        id: "87654321-4321-4321-8321-210987654321",
        strategyId: "company-search-12345678:client"
      }),
      pendingChild(hostedDraft, {
        id: "abcdef12-4321-4321-8321-210987654321",
        strategyId: "company-search-12345678:hosted"
      })
    ], { id: "12345678-1234-4234-8234-123456789012" });
    const tx = {
      $queryRaw: vi.fn(async () => []),
      providerModel: { findFirst: vi.fn(async () => providerModel()) },
      searchIntegrationRevision: revisions,
      searchOption: {
        create: optionCreate,
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => createdOption)
      },
      searchStrategy: {
        create: strategyCreate,
        findUnique: vi.fn(async () => null),
        update: strategyUpdate
      }
    };
    const ids = [
      "12345678-1234-4234-8234-123456789012",
      "87654321-4321-4321-8321-210987654321",
      "abcdef12-4321-4321-8321-210987654321"
    ];
    const prisma = {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
      providerModel: { findFirst: vi.fn(async () => providerModel()) }
    } as unknown as PrismaClient;
    const service = createAdminSearchService({
      idFactory: () => ids.shift()!,
      prisma,
      tester: { test: vi.fn() }
    });

    const created = await service.createDraft({
      description: " Web evidence ",
      displayName: " Company Search ",
      draft
    });

    expect(created).toEqual({
      created: true,
      id: "12345678-1234-4234-8234-123456789012"
    });

    expect(optionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        description: "Web evidence",
        displayName: "Company Search",
        enabled: false,
        id: "12345678-1234-4234-8234-123456789012",
        kind: "web_search",
        optionId: "company-search-12345678",
        sourceConnectionId: "connection-1"
      })
    });
    expect(strategyCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        enabled: true,
        id: "87654321-4321-4321-8321-210987654321",
        providerModelId: "technical-1",
        searchOptionId: "12345678-1234-4234-8234-123456789012",
        strategyId: "company-search-12345678:client"
      })
    });
    expect(strategyCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        adapterKind: "answer_provider_hosted",
        enabled: false,
        id: "abcdef12-4321-4321-8321-210987654321",
        providerModelId: null,
        searchOptionId: "12345678-1234-4234-8234-123456789012",
        strategyId: "company-search-12345678:hosted"
      })
    });
    expect(strategyCreate).toHaveBeenCalledTimes(2);
    expect(revisions.create).toHaveBeenCalledTimes(2);
    expect(revisions.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        searchStrategyId: "87654321-4321-4321-8321-210987654321",
        validationEvidence: expect.objectContaining({ method: "configuration" })
      })
    });
    expect(strategyUpdate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        activeRevisionId: "published-revision-1",
        enabled: true
      }),
      where: { id: "87654321-4321-4321-8321-210987654321" }
    });
    expect(JSON.stringify([optionCreate.mock.calls, strategyCreate.mock.calls])).not.toMatch(
      /apiRoot|secret/u
    );
  });

  it("keeps Perplexity Search client-only", async () => {
    const perplexityDraft: AdminSearchDraft = {
      ...draft,
      protocol: "openrouter_perplexity_chat"
    };
    const technical = providerModel({ adapterKind: "openrouter_chat_completions" });
    const strategyCreate = vi.fn(async () => undefined);
    const strategyUpdate = vi.fn(async () => undefined);
    const revisions = revisionRepository();
    const tx = {
      $queryRaw: vi.fn(async () => []),
      providerModel: { findFirst: vi.fn(async () => technical) },
      searchIntegrationRevision: revisions,
      searchOption: {
        create: vi.fn(async () => undefined),
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => option([
          pendingChild(perplexityDraft, {
            id: "perplexity-client",
            strategyId: "perplexity-search-perplex:client"
          })
        ], {
          id: "perplexity-option",
          kind: "perplexity_search",
          optionId: "perplexity-search-perplex",
          templateKey: null
        }))
      },
      searchStrategy: {
        create: strategyCreate,
        findUnique: vi.fn(async () => null),
        update: strategyUpdate
      }
    };
    const ids = ["perplexity-option", "perplexity-client"];
    const prisma = {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
      providerModel: { findFirst: vi.fn(async () => technical) }
    } as unknown as PrismaClient;
    const service = createAdminSearchService({
      idFactory: () => ids.shift()!,
      prisma,
      tester: { test: vi.fn() }
    });

    await service.createDraft({
      description: "Perplexity evidence",
      displayName: "Perplexity Search",
      draft: perplexityDraft
    });

    expect(strategyCreate).toHaveBeenCalledTimes(1);
    expect(revisions.create).toHaveBeenCalledTimes(1);
    expect(strategyCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        adapterKind: "provider_model_client",
        kind: "perplexity_tool_search"
      })
    });
  });

  it.each([
    {
      label: "official OpenAI",
      row: option([
        child(draft),
        child(hostedDraft, { id: "strategy-hosted", strategyId: "physical-hosted" })
      ])
    },
    {
      label: "custom Responses",
      row: option([
        child(draft),
        child(hostedDraft, { id: "strategy-hosted", strategyId: "physical-hosted" })
      ], {
        displayName: "Compatible gateway Search",
        id: "custom-web-search-option:connection-1",
        optionId: "custom-web-search:connection-1",
        templateKey: null
      })
    }
  ])("reuses the existing $label parent and client route instead of duplicating it", async ({ row }) => {
    const optionCreate = vi.fn(async () => undefined);
    const strategyCreate = vi.fn(async () => undefined);
    const strategyUpdate = vi.fn(async () => undefined);
    const tx = {
      $queryRaw: vi.fn(async () => []),
      providerModel: { findFirst: vi.fn(async () => providerModel()) },
      searchOption: {
        create: optionCreate,
        findMany: vi.fn(async () => [row]),
        findUnique: vi.fn(async () => row)
      },
      searchStrategy: {
        create: strategyCreate,
        findUnique: vi.fn(async () => null),
        update: strategyUpdate
      }
    };
    const prisma = {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
      providerModel: { findFirst: vi.fn(async () => providerModel()) }
    } as unknown as PrismaClient;
    const service = createAdminSearchService({ prisma, tester: { test: vi.fn() } });

    const reused = await service.createDraft({
      description: "A duplicate form must not create another source.",
      displayName: "Duplicate Search",
      draft
    });

    expect(reused).toEqual({ created: false, id: row.id });
    expect(optionCreate).not.toHaveBeenCalled();
    expect(strategyCreate).not.toHaveBeenCalled();
    expect(strategyUpdate).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("completes a hosted-only custom parent with its canonical client route", async () => {
    const existing = option([child(hostedDraft)], {
      displayName: "Compatible gateway Search",
      id: "custom-web-search-option:connection-1",
      optionId: "custom-web-search:connection-1",
      templateKey: null
    });
    const optionCreate = vi.fn(async () => undefined);
    const strategyCreate = vi.fn(async () => undefined);
    const strategyUpdate = vi.fn(async () => undefined);
    const revisions = revisionRepository();
    const completed = option([
      child(hostedDraft),
      pendingChild(draft, {
        id: "custom-web-search-client:connection-1",
        strategyId: "custom-web-search-client:connection-1"
      })
    ], {
      displayName: "Compatible gateway Search",
      id: "custom-web-search-option:connection-1",
      optionId: "custom-web-search:connection-1",
      templateKey: null
    });
    const tx = {
      $queryRaw: vi.fn(async () => []),
      providerModel: { findFirst: vi.fn(async () => providerModel()) },
      searchIntegrationRevision: revisions,
      searchOption: {
        create: optionCreate,
        findMany: vi.fn(async () => [existing]),
        findUnique: vi.fn(async () => completed)
      },
      searchStrategy: {
        create: strategyCreate,
        findUnique: vi.fn(async () => null),
        update: strategyUpdate
      }
    };
    const prisma = {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
      providerModel: { findFirst: vi.fn(async () => providerModel()) }
    } as unknown as PrismaClient;
    const service = createAdminSearchService({ prisma, tester: { test: vi.fn() } });

    await service.createDraft({
      description: "Ignored in favor of the existing logical source.",
      displayName: "Duplicate Search",
      draft
    });

    expect(optionCreate).not.toHaveBeenCalled();
    expect(strategyCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        description: "Web evidence",
        displayName: "Compatible gateway Search",
        id: "custom-web-search-client:connection-1",
        providerModelId: "technical-1",
        searchOptionId: "custom-web-search-option:connection-1",
        strategyId: "custom-web-search-client:connection-1"
      })
    });
  });

  it("reuses and unarchives the stable parent identity instead of creating a replacement", async () => {
    const archivedAt = new Date("2026-07-28T09:00:00.000Z");
    const existing = option([
      child(draft),
      child(hostedDraft, { id: "strategy-hosted", strategyId: "physical-hosted" })
    ], {
      archivedAt,
      enabled: false,
      id: "custom-web-search-option:connection-1",
      optionId: "custom-web-search:connection-1",
      templateKey: null
    });
    const optionCreate = vi.fn(async () => undefined);
    const optionUpdate = vi.fn(async () => undefined);
    const strategyCreate = vi.fn(async () => undefined);
    const strategyUpdate = vi.fn(async () => undefined);
    const replacementDraft: AdminSearchDraft = { ...draft, providerModelId: "technical-2" };
    const reopened = option([
      child(replacementDraft, {
        activeRevision: activeRevision(draft),
        activeRevisionId: "revision-1",
        providerModelId: draft.providerModelId
      }),
      child(hostedDraft, { id: "strategy-hosted", strategyId: "physical-hosted" })
    ], {
      archivedAt: null,
      enabled: false,
      id: "custom-web-search-option:connection-1",
      optionId: "custom-web-search:connection-1",
      templateKey: null
    });
    const revisions = revisionRepository();
    const tx = {
      $queryRaw: vi.fn(async () => []),
      providerModel: {
        findFirst: vi.fn(async () => providerModel({ id: "technical-2" }))
      },
      searchIntegrationRevision: revisions,
      searchOption: {
        create: optionCreate,
        findMany: vi.fn(async () => [existing]),
        findUnique: vi.fn(async () => reopened),
        update: optionUpdate
      },
      searchStrategy: {
        create: strategyCreate,
        findUnique: vi.fn(async () => null),
        update: strategyUpdate
      }
    };
    const prisma = {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
      providerModel: { findFirst: vi.fn(async () => providerModel({ id: "technical-2" })) }
    } as unknown as PrismaClient;
    const service = createAdminSearchService({ prisma, tester: { test: vi.fn() } });

    await service.createDraft({
      description: "Restore the prior source.",
      displayName: "Compatible Search",
      draft: replacementDraft
    });

    expect(optionCreate).not.toHaveBeenCalled();
    expect(strategyCreate).not.toHaveBeenCalled();
    expect(strategyUpdate).toHaveBeenCalledWith({
      data: {
        draft: replacementDraft,
        draftTestEvidence: expect.anything(),
        draftVersion: { increment: 1 },
        enabled: false,
        testedDraftHash: null
      },
      where: { id: "strategy-1" }
    });
    expect(optionUpdate).toHaveBeenCalledWith({
      data: { archivedAt: null, enabled: false },
      where: { id: "custom-web-search-option:connection-1" }
    });
  });

  it("rejects an editable child moved to another provider connection", async () => {
    const strategyUpdate = vi.fn();
    const optionUpdate = vi.fn();
    const tx = {
      providerModel: {
        findFirst: vi.fn(async () => providerModel({ connectionId: "connection-2" }))
      },
      searchOption: {
        findUnique: vi.fn(async () => option([child(draft, {
          activeRevision: null,
          activeRevisionId: null
        })])),
        update: optionUpdate
      },
      searchStrategy: { updateMany: strategyUpdate }
    };
    const prisma = {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)
    } as unknown as PrismaClient;
    const service = createAdminSearchService({ prisma, tester: { test: vi.fn() } });

    await expect(service.updateDraft({
      description: "Web evidence",
      displayName: "OpenAI Search",
      draft,
      expectedDraftVersion: 1,
      id: "source-1"
    })).rejects.toMatchObject({ code: "search_provider_model_not_available" });
    expect(strategyUpdate).not.toHaveBeenCalled();
    expect(optionUpdate).not.toHaveBeenCalled();
  });

  it("publishes a same-source technical-model replacement immediately on save", async () => {
    const replacementDraft: AdminSearchDraft = {
      ...draft,
      providerModelId: "technical-2"
    };
    const strategyUpdateMany = vi.fn(async () => ({ count: 1 }));
    const strategyPublish = vi.fn(async () => undefined);
    const optionUpdate = vi.fn(async () => undefined);
    const revisions = revisionRepository();
    const tx = {
      providerModel: {
        findFirst: vi.fn(async () => providerModel({ id: "technical-2" }))
      },
      searchOption: {
        findUnique: vi.fn(async () => option([
          child(draft),
          child(hostedDraft, { id: "strategy-hosted", strategyId: "physical-hosted" })
        ])),
        update: optionUpdate
      },
      searchIntegrationRevision: revisions,
      searchStrategy: { update: strategyPublish, updateMany: strategyUpdateMany }
    };
    const prisma = {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)
    } as unknown as PrismaClient;
    const service = createAdminSearchService({ prisma, tester: { test: vi.fn() } });

    await service.updateDraft({
      description: "Web evidence",
      displayName: "OpenAI Search",
      draft: replacementDraft,
      expectedDraftVersion: 1,
      id: "source-1"
    });

    expect(strategyUpdateMany).toHaveBeenCalledWith({
      data: {
        description: "Web evidence",
        displayName: "OpenAI Search",
        draft: replacementDraft,
        draftTestEvidence: expect.anything(),
        draftVersion: { increment: 1 },
        testedDraftHash: null
      },
      where: { draftVersion: 1, id: "strategy-1" }
    });
    expect(revisions.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        configuration: replacementDraft,
        searchStrategyId: "strategy-1",
        validationEvidence: expect.objectContaining({ method: "configuration" })
      })
    });
    expect(strategyPublish).toHaveBeenCalledWith({
      data: expect.objectContaining({
        activeRevisionId: "published-revision-1",
        enabled: true,
        providerModelId: "technical-2"
      }),
      where: { id: "strategy-1" }
    });
    expect(optionUpdate).toHaveBeenCalledWith({
      data: { description: "Web evidence", displayName: "OpenAI Search" },
      where: { id: "source-1" }
    });
  });

  it("applies advanced execution controls only to the broader-model route", async () => {
    const advancedDraft: AdminSearchDraft = {
      ...draft,
      maxOutputTokens: 8_192,
      maxSearchCallsPerAnswer: 4,
      reasoningPolicy: "provider_default"
    };
    const strategyUpdateMany = vi.fn(async () => ({ count: 1 }));
    const strategyPublish = vi.fn(async () => undefined);
    const revisions = revisionRepository();
    const tx = {
      providerModel: {
        findFirst: vi.fn(async () => providerModel())
      },
      searchOption: {
        findUnique: vi.fn(async () => option([
          child(draft),
          child(hostedDraft, { id: "strategy-hosted", strategyId: "physical-hosted" })
        ])),
        update: vi.fn(async () => undefined)
      },
      searchIntegrationRevision: revisions,
      searchStrategy: { update: strategyPublish, updateMany: strategyUpdateMany }
    };
    const prisma = {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)
    } as unknown as PrismaClient;
    const service = createAdminSearchService({ prisma, tester: { test: vi.fn() } });

    await service.updateDraft({
      description: "Web evidence",
      displayName: "OpenAI Search",
      draft: advancedDraft,
      expectedDraftVersion: 1,
      id: "source-1"
    });

    expect(revisions.create).toHaveBeenCalledTimes(1);
    expect(revisions.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        adapterKind: "provider_model_client",
        configuration: advancedDraft,
        searchStrategyId: "strategy-1"
      })
    });
    expect(strategyPublish).toHaveBeenCalledWith({
      data: expect.objectContaining({
        config: advancedDraft,
        draft: advancedDraft
      }),
      where: { id: "strategy-1" }
    });
    expect(strategyPublish).toHaveBeenCalledWith({
      data: expect.objectContaining({
        config: hostedDraft,
        draft: hostedDraft
      }),
      where: { id: "strategy-hosted" }
    });
  });

  it("keeps the activate endpoint as a network-free compatibility publication", async () => {
    const revisionCreate = vi.fn()
      .mockResolvedValueOnce({ id: "revision-2" })
      .mockResolvedValueOnce({ id: "revision-hosted-1" });
    const strategyUpdate = vi.fn(async () => undefined);
    const editable = child(draft, {
      activeRevision: null,
      activeRevisionId: null,
      draftTestEvidence: {
        checkedAt: NOW.toISOString(),
        method: "provider_search",
        normalizedSourceCount: 2,
        probeBinding: PROBE_BINDING,
        protocol: draft.protocol,
        status: "available"
      },
      revisions: [{ revisionNumber: 1 }]
    });
    const hosted = child(hostedDraft, {
      activeRevision: null,
      activeRevisionId: null,
      activatedAt: null,
      enabled: false,
      id: "strategy-hosted",
      revisions: [],
      strategyId: "physical-hosted"
    });
    const tx = {
      providerModel: { findFirst: vi.fn(async () => providerModel()) },
      searchIntegrationRevision: {
        create: revisionCreate,
        findUnique: vi.fn(async () => null)
      },
      searchOption: { findUnique: vi.fn(async () => option([editable, hosted])) },
      searchStrategy: { update: strategyUpdate }
    };
    const prisma = {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)
    } as unknown as PrismaClient;
    const currentBinding = vi.fn(async () => PROBE_BINDING);
    const service = createAdminSearchService({
      now: () => NOW,
      prisma,
      tester: {
        currentBinding,
        test: vi.fn()
      }
    });

    await service.activate({ id: "source-1", userId: "admin-1" });

    expect(revisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        draftHash: searchDraftHash(draft),
        revisionNumber: 2,
        searchStrategyId: "strategy-1",
        validationEvidence: expect.objectContaining({ method: "configuration" })
      })
    });
    expect(strategyUpdate).toHaveBeenCalledWith({
      data: expect.objectContaining({ activeRevisionId: "revision-2", enabled: true }),
      where: { id: "strategy-1" }
    });
    expect(revisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        adapterKind: "answer_provider_hosted",
        providerModelId: null,
        searchStrategyId: "strategy-hosted"
      })
    });
    expect(strategyUpdate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        activeRevisionId: "revision-hosted-1",
        adapterKind: "answer_provider_hosted",
        enabled: true,
        providerModelId: null
      }),
      where: { id: "strategy-hosted" }
    });

    expect(revisionCreate).toHaveBeenCalledTimes(2);
    expect(currentBinding).not.toHaveBeenCalled();
  });

  it("does not let a failed optional diagnostic disable an active source", async () => {
    const source = option([
      child(draft),
      child(hostedDraft, { id: "strategy-hosted", strategyId: "physical-hosted" })
    ]);
    const diagnosticUpdate = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      providerModel: {
        findFirst: vi.fn(async () => providerModel()),
        findMany: vi.fn(async () => [providerModel()])
      },
      searchOption: {
        findMany: vi.fn(async () => [source]),
        findUnique: vi.fn(async () => source)
      },
      searchPolicy: { findUnique: vi.fn(async () => policyRow()) },
      searchStrategy: { updateMany: diagnosticUpdate }
    } as unknown as PrismaClient;
    const service = createAdminSearchService({
      prisma,
      tester: {
        test: vi.fn(async () => ({
          method: "provider_search" as const,
          normalizedSourceCount: 0,
          probeBinding: PROBE_BINDING,
          protocol: draft.protocol,
          status: "unavailable" as const
        }))
      }
    });

    await service.testDraft({ id: "source-1", userId: "admin-1" });
    expect(diagnosticUpdate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        draftTestEvidence: expect.objectContaining({ status: "unavailable" })
      }),
      where: { draftVersion: 1, id: "strategy-1" }
    });
    await expect(service.list({ userId: "admin-2" })).resolves.toMatchObject({
      integrations: [{
        broaderModelSetup: "ready",
        executionModes: ["all_selected", "model_choice"],
        ready: true,
        readiness: "ready"
      }]
    });
  });

  it("creates an exact hosted revision when client limits change", async () => {
    const changedDraft: AdminSearchDraft = {
      ...draft,
      maxResults: 12,
      queryMaxCharacters: 900,
      timeoutMs: 25_000
    };
    const changedHostedDraft: AdminSearchDraft = {
      ...changedDraft,
      adapterKind: "answer_provider_hosted",
      credentialMode: "answer_provider",
      providerModelId: null,
      reasoningPolicy: "provider_default"
    };
    const evidence = {
      checkedAt: NOW.toISOString(),
      method: "provider_search",
      normalizedSourceCount: 2,
      probeBinding: PROBE_BINDING,
      protocol: changedDraft.protocol,
      status: "available"
    } as const;
    const editable = child(changedDraft, {
      activeRevision: activeRevision(changedDraft),
      draftTestEvidence: evidence,
      testedDraftHash: searchDraftHash(changedDraft)
    });
    const hosted = child(hostedDraft, {
      id: "strategy-hosted",
      strategyId: "physical-hosted"
    });
    const revisionCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      id: "revision-hosted-2"
    }));
    const findUnique = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const identity = where.searchStrategyId_draftHash_validationFingerprint as
        | { searchStrategyId?: string }
        | undefined;
      return identity?.searchStrategyId === editable.id ? editable.activeRevision : null;
    });
    const strategyUpdate = vi.fn(async () => undefined);
    const tx = {
      providerModel: { findFirst: vi.fn(async () => providerModel()) },
      searchIntegrationRevision: { create: revisionCreate, findUnique },
      searchOption: { findUnique: vi.fn(async () => option([editable, hosted])) },
      searchStrategy: { update: strategyUpdate }
    };
    const prisma = {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)
    } as unknown as PrismaClient;
    const service = createAdminSearchService({
      now: () => NOW,
      prisma,
      tester: {
        currentBinding: vi.fn(async () => PROBE_BINDING),
        test: vi.fn()
      }
    });

    await service.activate({ id: "source-1", userId: "admin-1" });

    expect(revisionCreate).toHaveBeenCalledTimes(1);
    expect(revisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        adapterKind: "answer_provider_hosted",
        configuration: changedHostedDraft,
        draftHash: searchDraftHash(changedHostedDraft),
        searchStrategyId: "strategy-hosted"
      })
    });
    expect(strategyUpdate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        activeRevisionId: "revision-hosted-2",
        config: changedHostedDraft,
        draft: changedHostedDraft
      }),
      where: { id: "strategy-hosted" }
    });
  });

  it("enables and archives the parent without rewriting physical children", async () => {
    const sourceUpdate = vi.fn(async () => undefined);
    const findUnique = vi.fn(async (): Promise<{ templateKey: string | null }> => ({
      templateKey: null
    }));
    const prisma = {
      providerModel: { findMany: vi.fn(async () => [providerModel()]) },
      searchOption: {
        findMany: vi.fn(async () => [option([child(draft)], { enabled: false, templateKey: null })]),
        findUnique,
        update: sourceUpdate
      },
      searchPolicy: { findUnique: vi.fn(async () => policyRow()) }
    } as unknown as PrismaClient;
    const service = createAdminSearchService({
      now: () => NOW,
      prisma,
      tester: { currentBinding: vi.fn(async () => PROBE_BINDING), test: vi.fn() }
    });

    await service.setEnabled({ enabled: true, id: "source-1", userId: "admin-1" });
    expect(sourceUpdate).toHaveBeenCalledWith({
      data: { enabled: true },
      where: { id: "source-1" }
    });

    await service.archive({ id: "source-1" });
    expect(sourceUpdate).toHaveBeenLastCalledWith({
      data: { archivedAt: NOW, enabled: false },
      where: { id: "source-1" }
    });

    findUnique.mockResolvedValueOnce({ templateKey: "search:openai" });
    await expect(service.archive({ id: "source-1" })).rejects.toMatchObject({
      code: "search_system_integration_forbidden"
    });
  });

  it("reports readiness rather than activation evidence when enable is unavailable", async () => {
    const sourceUpdate = vi.fn(async () => undefined);
    const prisma = {
      providerModel: { findMany: vi.fn(async () => [providerModel()]) },
      searchOption: {
        findMany: vi.fn(async () => [option([pendingChild(draft)], { enabled: false })]),
        update: sourceUpdate
      },
      searchPolicy: { findUnique: vi.fn(async () => policyRow()) }
    } as unknown as PrismaClient;
    const service = createAdminSearchService({ prisma, tester: { test: vi.fn() } });

    await expect(service.setEnabled({
      enabled: true,
      id: "source-1",
      userId: "admin-1"
    })).rejects.toMatchObject({ code: "search_source_not_ready" });
    expect(sourceUpdate).not.toHaveBeenCalled();
  });

  it("validates logical policy kinds and permits normalized Google multi-source plans", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const geminiDraft: AdminSearchDraft = {
      ...draft,
      adapterKind: "answer_provider_hosted",
      credentialMode: "answer_provider",
      protocol: "gemini_google_search",
      providerModelId: null
    };
    const openAi = option([child(draft)]);
    const google = option([child(geminiDraft, { id: "strategy-google" })], {
      displayName: "Google Search",
      id: "source-google",
      kind: "gemini_google_search",
      optionId: "gemini-google-search",
      sourceConnectionId: "connection-gemini",
      templateKey: "search:gemini-google"
    });
    const findMany = vi.fn(async () => [openAi]);
    const prisma = {
      providerModel: {
        findMany: vi.fn(async () => [
          providerModel(),
          providerModel({
            adapterKind: "gemini_interactions_native",
            connectionId: "connection-gemini",
            id: "gemini-model"
          })
        ])
      },
      searchOption: { findMany },
      searchPolicy: { findUnique: vi.fn(async () => policyRow(3)), updateMany }
    } as unknown as PrismaClient;
    const service = createAdminSearchService({
      prisma,
      tester: { currentBinding: vi.fn(async () => PROBE_BINDING), test: vi.fn() }
    });

    await service.updatePolicy({
      defaultPlan: { mode: "all_selected", optionIds: ["openai-search"] },
      expectedVersion: 3,
      userId: "admin-1"
    });
    expect(updateMany).toHaveBeenCalledWith({
      data: {
        defaultPlan: { mode: "all_selected", optionIds: ["openai-search"] },
        updatedByUserId: "admin-1",
        version: { increment: 1 }
      },
      where: { id: "installation", version: 3 }
    });

    findMany.mockResolvedValueOnce([option([child({
      ...draft,
      adapterKind: "answer_provider_hosted",
      credentialMode: "answer_provider",
      providerModelId: null
    })])]);
    await expect(service.updatePolicy({
      defaultPlan: { mode: "all_selected", optionIds: ["openai-search"] },
      expectedVersion: 3,
      userId: "admin-1"
    })).rejects.toMatchObject({ code: "search_default_unavailable" });

    findMany.mockResolvedValueOnce([openAi, google]);
    await service.updatePolicy({
      defaultPlan: {
        mode: "model_choice",
        optionIds: ["openai-search", "gemini-google-search"]
      },
      expectedVersion: 3,
      userId: "admin-1"
    });
  });
});
