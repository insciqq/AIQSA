import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { loadInstallationAnswerProviderRole, loadProviderAdmissionPlan, ProviderAdmissionError, type ProviderAdmissionPlan } from "./admission";

const capabilities = (input: Readonly<{
  nativeSearch?: boolean;
  toolCalling?: boolean;
}> = {}) => ({
  nativePdfInput: true,
  nativeSearch: input.nativeSearch ?? false,
  pdf: true,
  reasoning: true,
  streaming: true,
  toolCalling: input.toolCalling ?? true,
  vision: true
});

type ModelSpec = Readonly<{
  adapterKind:
    | "anthropic_messages"
    | "gemini_interactions_native"
    | "openai_responses_compatible"
    | "openai_responses_native"
    | "openrouter_chat_completions";
  answerSelectable?: boolean;
  connectionResponseTimeoutMs?: number;
  connectionId: string;
  contextWindow?: number;
  displayName?: string;
  family: "anthropic" | "gemini" | "openai" | "openai_compatible" | "openrouter";
  id: string;
  nativeSearch?: boolean;
  responseTimeoutMs?: number;
  toolCalling?: boolean;
  upstreamModelId: string;
}>;

type RouteSpec = Readonly<{
  adapterKind: "answer_provider_hosted" | "provider_model_client";
  enabled?: boolean;
  id: string;
  protocol:
    | "anthropic_web_search"
    | "gemini_google_search"
    | "openai_responses_web_search"
    | "openrouter_perplexity_chat";
  providerModelId?: string | null;
  revisionId: string;
}>;

type OptionSpec = Readonly<{
  displayName: string;
  kind: "gemini_google_search" | "none" | "perplexity_search" | "web_search";
  optionId: string;
  routes?: readonly RouteSpec[];
  sourceConnectionId: string | null;
}>;

function apiRoot(family: ModelSpec["family"]): string {
  if (family === "anthropic") return "https://api.anthropic.com/v1";
  if (family === "gemini") return "https://generativelanguage.googleapis.com/v1beta";
  if (family === "openrouter") return "https://openrouter.ai/api/v1";
  if (family === "openai_compatible") return "https://compatible.example.test/v1";
  return "https://api.openai.com/v1";
}

function providerModel(
  spec: ModelSpec,
  defaultCredentialId: string | null = null,
  unassignedPolicy: "require_assignment" | "use_default" = "use_default"
) {
  return {
    activeConfig: {
      adapterKind: spec.adapterKind,
      answerSelectable: spec.answerSelectable ?? true,
      capabilities: capabilities({
        nativeSearch: spec.nativeSearch,
        toolCalling: spec.toolCalling
      }),
      defaultParams: {},
      modelClass: "answer",
      ...(spec.adapterKind === "openrouter_chat_completions"
        ? { openRouterRouting: { mode: "automatic", providers: [] } }
        : {}),
      ...(spec.responseTimeoutMs === undefined
        ? {}
        : { responseTimeoutMs: spec.responseTimeoutMs }),
      upstreamModelId: spec.upstreamModelId
    },
    activeVersion: 1,
    connection: {
      activeConfig: {
        allowPrivateNetwork: false,
        authenticationMode: "bearer",
        apiRoot: apiRoot(spec.family),
        responseTimeoutMs: 300_000,
        ...(spec.connectionResponseTimeoutMs === undefined
          ? {}
          : { responseTimeoutMs: spec.connectionResponseTimeoutMs })
      },
      activeVersion: 1,
      defaultCredentialId,
      displayName: `${spec.displayName ?? spec.upstreamModelId} provider`,
      enabled: true,
      family: spec.family,
      id: spec.connectionId,
      unassignedPolicy
    },
    connectionId: spec.connectionId,
    contextWindow: spec.contextWindow ?? 128_000,
    displayName: spec.displayName ?? spec.upstreamModelId,
    enabled: true,
    id: spec.id
  };
}

function physicalRoute(spec: RouteSpec) {
  const providerModelId = spec.providerModelId ?? null;
  const credentialMode = spec.adapterKind === "answer_provider_hosted"
    ? "answer_provider"
    : "provider_model";
  const kind = spec.protocol === "gemini_google_search"
    ? "gemini_google_search"
    : spec.protocol === "anthropic_web_search"
      ? spec.adapterKind === "answer_provider_hosted"
        ? "anthropic_native_web_search"
        : "provider_model_web_search"
    : spec.protocol === "openrouter_perplexity_chat"
      ? "perplexity_tool_search"
      : spec.adapterKind === "answer_provider_hosted"
        ? "openai_native_web_search"
        : "provider_model_web_search";
  const draft = {
    adapterKind: spec.adapterKind,
    credentialMode,
    maxOutputTokens: 4_096,
    maxResults: 8,
    maxSearchCallsPerAnswer: 2,
    protocol: spec.protocol,
    providerModelId,
    queryMaxCharacters: 500,
    reasoningPolicy: spec.adapterKind === "provider_model_client"
      ? "lowest_supported"
      : "provider_default",
    timeoutMs: 15_000
  };
  return {
    activeRevision: {
      adapterKind: spec.adapterKind,
      configuration: draft,
      credentialMode,
      id: spec.revisionId,
      providerModelId
    },
    activeRevisionId: spec.revisionId,
    adapterKind: spec.adapterKind,
    archivedAt: null,
    createdAt: new Date("2026-08-02T00:00:00.000Z"),
    credentialMode,
    enabled: spec.enabled ?? true,
    id: spec.id,
    kind,
    providerModelId,
    strategyId: `physical:${spec.id}`
  };
}

function logicalOption(spec: OptionSpec) {
  return {
    archivedAt: null,
    displayName: spec.displayName,
    enabled: true,
    id: `option-row:${spec.optionId}`,
    kind: spec.kind,
    optionId: spec.optionId,
    sourceConnectionId: spec.sourceConnectionId,
    strategies: (spec.routes ?? []).map(physicalRoute)
  };
}

function admissionDb(input: Readonly<{
  answer: ModelSpec;
  credentialIdByConnection?: Readonly<Record<string, string>>;
  credentialVersionIdByConnection?: Readonly<Record<string, string>>;
  defaultCredentialIdByConnection?: Readonly<Record<string, string>>;
  directCredential?: boolean;
  fullAccess?: boolean;
  grantedSearchOptionIds?: readonly string[];
  options: readonly OptionSpec[];
  technicalModels?: readonly ModelSpec[];
  unassignedPolicy?: "require_assignment" | "use_default";
  unavailableModelIds?: readonly string[];
  userRole?: "admin" | "user";
}>) {
  const models = new Map(
    [input.answer, ...(input.technicalModels ?? [])].map((spec) => [
      spec.id,
      providerModel(
        spec,
        input.defaultCredentialIdByConnection?.[spec.connectionId] ?? null,
        input.unassignedPolicy
      )
    ])
  );
  const options = new Map(input.options.map((spec) => [spec.optionId, logicalOption(spec)]));
  const grantedSearchOptionIds = new Set(input.grantedSearchOptionIds ?? []);
  const accessGrantCount = vi.fn(async (args?: {
    where?: { searchStrategy?: string };
  }) => args?.where?.searchStrategy
    ? Number(grantedSearchOptionIds.has(args.where.searchStrategy))
    : 1);
  const unavailableModelIds = new Set(input.unavailableModelIds ?? []);
  const providerModelFindFirst = vi.fn(async (args?: { where?: { id?: string } }) => {
    const id = args?.where?.id ?? input.answer.id;
    return unavailableModelIds.has(id) ? null : models.get(id) ?? null;
  });
  const providerModelFindUnique = vi.fn(async (args?: { where?: { id?: string } }) => {
    const model = models.get(args?.where?.id ?? "");
    return model ? { connectionId: model.connectionId } : null;
  });
  const searchOptionFindFirst = vi.fn(async (args?: { where?: { optionId?: string } }) =>
    options.get(args?.where?.optionId ?? "") ?? null);
  const db = {
    accessGrant: { count: accessGrantCount },
    providerCredential: {
      findMany: vi.fn(async (args?: { where?: { connectionId?: string } }) => {
        const connectionId = args?.where?.connectionId ?? "missing";
        const credentialId = input.credentialIdByConnection?.[connectionId] ??
          `credential:${connectionId}`;
        return [{
          activeVersion: {
            id: input.credentialVersionIdByConnection?.[connectionId] ??
              `credential-version:${connectionId}`,
            revokedAt: null
          },
          enabled: true,
          id: credentialId
        }];
      })
    },
    providerGroupCredentialAssignment: { findMany: vi.fn(async () => []) },
    providerUserCredentialAssignment: {
      findUnique: vi.fn(async (args?: {
        where?: { connectionId_userId?: { connectionId?: string } };
      }) => input.directCredential === false
        ? null
        : {
            credentialId: (() => {
              const connectionId = args?.where?.connectionId_userId?.connectionId ?? "missing";
              return input.credentialIdByConnection?.[connectionId] ??
                `credential:${connectionId}`;
            })()
          })
    },
    providerModel: {
      findFirst: providerModelFindFirst,
      findUnique: providerModelFindUnique
    },
    providerModelCredentialCheck: { findFirst: vi.fn(async () => ({ id: "check-1" })) },
    searchOption: { findFirst: searchOptionFindFirst },
    user: {
      findFirst: vi.fn(async () => ({ id: "user-1", role: input.userRole ?? "admin" }))
    },
    userGroup: {
      findMany: vi.fn(async () => input.fullAccess === false
        ? []
        : [{ group: { systemRole: "full_access" }, groupId: "full-access" }])
    }
  };
  return {
    accessGrantCount,
    db,
    providerModelFindUnique,
    searchOptionFindFirst
  };
}

const off: OptionSpec = {
  displayName: "Off",
  kind: "none",
  optionId: "search-disabled",
  sourceConnectionId: null
};

const officialOpenAiModel: ModelSpec = {
  adapterKind: "openai_responses_native",
  connectionId: "connection-openai",
  family: "openai",
  id: "model-openai-answer",
  nativeSearch: true,
  upstreamModelId: "gpt-5.6-sol"
};

const officialOpenAiSearchModel: ModelSpec = {
  ...officialOpenAiModel,
  answerSelectable: false,
  id: "model-openai-search",
  upstreamModelId: "gpt-5.6-search"
};

const officialAnthropicModel: ModelSpec = {
  adapterKind: "anthropic_messages",
  connectionId: "connection-anthropic",
  family: "anthropic",
  id: "model-anthropic-answer",
  nativeSearch: true,
  upstreamModelId: "claude-opus-5"
};

const officialAnthropicSearchModel: ModelSpec = {
  ...officialAnthropicModel,
  answerSelectable: false,
  id: "model-anthropic-search"
};

function anthropicOption(clientModelId = officialAnthropicSearchModel.id): OptionSpec {
  return {
    displayName: "Anthropic Search",
    kind: "web_search",
    optionId: "anthropic-web-search",
    routes: [
      {
        adapterKind: "answer_provider_hosted",
        id: "route-hosted:anthropic",
        protocol: "anthropic_web_search",
        revisionId: "revision-hosted:anthropic"
      },
      {
        adapterKind: "provider_model_client",
        id: "route-client:anthropic",
        protocol: "anthropic_web_search",
        providerModelId: clientModelId,
        revisionId: "revision-client:anthropic"
      }
    ],
    sourceConnectionId: officialAnthropicModel.connectionId
  };
}

function openAiOption(input: Readonly<{
  clientConnectionModelId?: string;
  optionId?: string;
  sourceConnectionId?: string;
}> = {}): OptionSpec {
  return {
    displayName: input.sourceConnectionId ? "Custom Search" : "OpenAI Search",
    kind: "web_search",
    optionId: input.optionId ?? "openai-native-web-search",
    routes: [
      {
        adapterKind: "answer_provider_hosted",
        id: `route-hosted:${input.optionId ?? "openai"}`,
        protocol: "openai_responses_web_search",
        revisionId: `revision-hosted:${input.optionId ?? "openai"}`
      },
      {
        adapterKind: "provider_model_client",
        id: `route-client:${input.optionId ?? "openai"}`,
        protocol: "openai_responses_web_search",
        providerModelId: input.clientConnectionModelId ?? officialOpenAiSearchModel.id,
        revisionId: `revision-client:${input.optionId ?? "openai"}`
      }
    ],
    sourceConnectionId: input.sourceConnectionId ?? officialOpenAiModel.connectionId
  };
}

const geminiModel: ModelSpec = {
  adapterKind: "gemini_interactions_native",
  connectionId: "connection-gemini",
  family: "gemini",
  id: "model-gemini-answer",
  nativeSearch: true,
  upstreamModelId: "gemini-3.6-flash"
};

const geminiSearchModel: ModelSpec = {
  ...geminiModel,
  answerSelectable: false,
  id: "model-gemini-search"
};

function geminiOption(includeClient = true): OptionSpec {
  return {
    displayName: "Google Search",
    kind: "gemini_google_search",
    optionId: "gemini-google-search",
    routes: [
      {
        adapterKind: "answer_provider_hosted",
        id: "route-hosted:gemini",
        protocol: "gemini_google_search",
        revisionId: "revision-hosted:gemini"
      },
      ...(includeClient
        ? [{
            adapterKind: "provider_model_client" as const,
            id: "route-client:gemini",
            protocol: "gemini_google_search" as const,
            providerModelId: geminiSearchModel.id,
            revisionId: "revision-client:gemini"
          }]
        : [])
    ],
    sourceConnectionId: geminiModel.connectionId
  };
}

function expectSearch(plan: ProviderAdmissionPlan) {
  expect(plan.searches).toHaveLength(1);
  return plan.searches![0]!;
}

describe("provider admission", () => {
  it("resolves installation answer work through only the explicit default credential", async () => {
    const credentialId = `credential:${officialOpenAiModel.connectionId}`;
    const { db } = admissionDb({
      answer: officialOpenAiModel,
      defaultCredentialIdByConnection: {
        [officialOpenAiModel.connectionId]: credentialId
      },
      directCredential: false,
      options: [off],
      unassignedPolicy: "require_assignment",
      userRole: "user"
    });

    await expect(loadInstallationAnswerProviderRole(
      db as unknown as Prisma.TransactionClient,
      { providerModelId: officialOpenAiModel.id }
    )).resolves.toMatchObject({
      authority: { credentialId },
      credentialSource: "default",
      snapshot: { providerModelId: officialOpenAiModel.id }
    });
    expect(db.user.findFirst).not.toHaveBeenCalled();
    expect(db.userGroup.findMany).not.toHaveBeenCalled();
    expect(db.providerGroupCredentialAssignment.findMany).not.toHaveBeenCalled();
    expect(db.providerUserCredentialAssignment.findUnique).not.toHaveBeenCalled();
  });

  it("fails installation answer work closed without an explicit default credential", async () => {
    const { db } = admissionDb({
      answer: officialOpenAiModel,
      directCredential: false,
      options: [off]
    });

    await expect(loadInstallationAnswerProviderRole(
      db as unknown as Prisma.TransactionClient,
      { providerModelId: officialOpenAiModel.id }
    )).rejects.toEqual(new ProviderAdmissionError("credential_default_missing"));
  });

  it("rejects unavailable and technical-only installation answer targets", async () => {
    const unavailable = admissionDb({
      answer: officialOpenAiModel,
      options: [off],
      unavailableModelIds: [officialOpenAiModel.id]
    });
    await expect(loadInstallationAnswerProviderRole(
      unavailable.db as unknown as Prisma.TransactionClient,
      { providerModelId: officialOpenAiModel.id }
    )).rejects.toEqual(new ProviderAdmissionError("model_not_available"));

    const technical = admissionDb({
      answer: { ...officialOpenAiModel, answerSelectable: false },
      options: [off]
    });
    await expect(loadInstallationAnswerProviderRole(
      technical.db as unknown as Prisma.TransactionClient,
      { providerModelId: officialOpenAiModel.id }
    )).rejects.toEqual(new ProviderAdmissionError("model_not_available"));
  });

  it("resolves a verified model context before snapshotting a new run", async () => {
    const { db } = admissionDb({
      answer: { ...officialOpenAiModel, contextWindow: 1 },
      fullAccess: false,
      options: [off]
    });

    const plan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: officialOpenAiModel.connectionId,
      providerModelId: officialOpenAiModel.id,
      searchPlan: { mode: "all_selected", optionIds: [] },
      userId: "user-1"
    });

    expect(plan.answer.modelConfiguration.capabilities.contextWindow).toBe(1_050_000);
    expect(plan.answer.snapshot.model.capabilities.contextWindow).toBe(1_050_000);
    expect(plan.answer.credentialSource).toBe("user");
  });

  it.each([
    { expectedModelTimeoutMs: undefined, modelTimeoutMs: undefined },
    { expectedModelTimeoutMs: 800_000, modelTimeoutMs: 800_000 }
  ])("snapshots the accepted connection deadline and $modelTimeoutMs model override", async ({
    expectedModelTimeoutMs,
    modelTimeoutMs
  }) => {
    const answer: ModelSpec = {
      ...officialOpenAiModel,
      connectionResponseTimeoutMs: 500_000,
      ...(modelTimeoutMs === undefined ? {} : { responseTimeoutMs: modelTimeoutMs })
    };
    const { db } = admissionDb({ answer, options: [off] });

    const plan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: answer.connectionId,
      providerModelId: answer.id,
      searchPlan: { mode: "all_selected", optionIds: [] },
      userId: "user-1"
    });

    expect(plan.answer.snapshot.connection.responseTimeoutMs).toBe(500_000);
    expect(plan.answer.snapshot.model).toMatchObject(
      expectedModelTimeoutMs === undefined
        ? { adapterKind: "openai_responses_native" }
        : { responseTimeoutMs: expectedModelTimeoutMs }
    );
    if (expectedModelTimeoutMs === undefined) {
      expect(plan.answer.snapshot.model).not.toHaveProperty("responseTimeoutMs");
    }
  });

  it("does not let full access bypass credential selection", async () => {
    const { accessGrantCount, db } = admissionDb({
      answer: officialOpenAiModel,
      directCredential: false,
      options: [off]
    });

    await expect(loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: officialOpenAiModel.connectionId,
      providerModelId: officialOpenAiModel.id,
      searchPlan: { mode: "all_selected", optionIds: [] },
      userId: "user-1"
    })).rejects.toMatchObject({ code: "credential_default_missing" });
    expect(accessGrantCount).not.toHaveBeenCalled();
  });

  it("rejects a technical-only deployment as the answer model", async () => {
    const { db } = admissionDb({
      answer: { ...officialOpenAiModel, answerSelectable: false },
      options: [off]
    });

    await expect(loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: officialOpenAiModel.connectionId,
      providerModelId: officialOpenAiModel.id,
      searchPlan: { mode: "all_selected", optionIds: [] },
      userId: "user-1"
    })).rejects.toMatchObject({ code: "model_not_available" });
    expect(db.providerCredential.findMany).not.toHaveBeenCalled();
  });

  it("prefers official OpenAI hosted Search and persists its exact physical ids", async () => {
    const option = openAiOption();
    const { db, providerModelFindUnique } = admissionDb({
      answer: officialOpenAiModel,
      options: [option],
      technicalModels: [officialOpenAiSearchModel]
    });

    const plan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: officialOpenAiModel.connectionId,
      providerModelId: officialOpenAiModel.id,
      searchPlan: { mode: "model_choice", optionIds: [option.optionId] },
      userId: "user-1"
    });
    const search = expectSearch(plan);

    expect(search).toMatchObject({
      bindingKey: null,
      integrationId: "route-hosted:openai",
      optionId: "openai-native-web-search",
      revisionId: "revision-hosted:openai"
    });
    expect(search.configuration).toMatchObject({
      adapterKind: "answer_provider_hosted",
      displayName: "OpenAI Search",
      searchStrategyRowId: "route-hosted:openai",
      strategyId: "openai-native-web-search"
    });
    expect(providerModelFindUnique).not.toHaveBeenCalled();
  });

  it("uses the same official OpenAI source through its client route for Anthropic", async () => {
    const anthropic: ModelSpec = {
      adapterKind: "anthropic_messages",
      connectionId: "connection-anthropic",
      family: "anthropic",
      id: "model-opus",
      upstreamModelId: "claude-opus-5"
    };
    const option = openAiOption();
    const { db } = admissionDb({
      answer: anthropic,
      options: [option],
      technicalModels: [officialOpenAiSearchModel]
    });

    const plan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: anthropic.connectionId,
      providerModelId: anthropic.id,
      searchPlan: { mode: "model_choice", optionIds: [option.optionId] },
      userId: "user-1"
    });
    const search = expectSearch(plan);

    expect(search).toMatchObject({
      bindingKey: "search:openai-native-web-search",
      integrationId: "route-client:openai",
      optionId: "openai-native-web-search",
      revisionId: "revision-client:openai",
      role: { snapshot: { connectionId: "connection-openai", providerFamily: "openai" } }
    });
    expect(search.configuration).toMatchObject({
      adapterKind: "provider_model_client",
      config: {
        maxOutputTokens: 4_096,
        maxSearchCallsPerAnswer: 2,
        reasoningPolicy: "lowest_supported"
      },
      modelId: "gpt-5.6-search",
      providerModelId: "model-openai-search",
      searchStrategyRowId: "route-client:openai"
    });
    expect(search.configuration.config).not.toHaveProperty("modelDefaultParams");
  });

  it("prefers same-connection Anthropic hosted Search", async () => {
    const option = anthropicOption();
    const { db, providerModelFindUnique } = admissionDb({
      answer: officialAnthropicModel,
      options: [option],
      technicalModels: [officialAnthropicSearchModel]
    });

    const plan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: officialAnthropicModel.connectionId,
      providerModelId: officialAnthropicModel.id,
      searchPlan: { mode: "model_choice", optionIds: [option.optionId] },
      userId: "user-1"
    });

    expect(expectSearch(plan)).toMatchObject({
      bindingKey: null,
      integrationId: "route-hosted:anthropic",
      optionId: "anthropic-web-search",
      revisionId: "revision-hosted:anthropic",
      configuration: {
        adapterKind: "answer_provider_hosted",
        provider: "anthropic"
      }
    });
    expect(providerModelFindUnique).not.toHaveBeenCalled();
  });

  it.each([
    {
      answer: officialOpenAiModel,
      label: "cross-provider answers",
      requiresClientToolCoexistence: false
    },
    {
      answer: officialAnthropicModel,
      label: "MCP coexistence",
      requiresClientToolCoexistence: true
    }
  ])("uses the exact Anthropic client route for $label", async (request) => {
    const option = anthropicOption();
    const { db } = admissionDb({
      answer: request.answer,
      options: [option],
      technicalModels: [officialAnthropicSearchModel]
    });

    const plan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: request.answer.connectionId,
      providerModelId: request.answer.id,
      ...(request.requiresClientToolCoexistence
        ? { requiresClientToolCoexistence: true }
        : {}),
      searchPlan: { mode: "model_choice", optionIds: [option.optionId] },
      userId: "user-1"
    });

    expect(expectSearch(plan)).toMatchObject({
      bindingKey: "search:anthropic-web-search",
      integrationId: "route-client:anthropic",
      optionId: "anthropic-web-search",
      revisionId: "revision-client:anthropic",
      configuration: {
        adapterKind: "provider_model_client",
        modelId: "claude-opus-5",
        provider: "anthropic",
        providerModelId: "model-anthropic-search"
      },
      role: {
        snapshot: {
          connectionId: officialAnthropicModel.connectionId,
          providerFamily: "anthropic"
        }
      }
    });
  });

  it.each([
    {
      label: "does not advertise native Search",
      technicalModel: { ...officialAnthropicSearchModel, nativeSearch: false }
    },
    {
      label: "is bound to a non-Anthropic adapter",
      technicalModel: {
        ...officialAnthropicSearchModel,
        adapterKind: "openai_responses_native" as const
      }
    }
  ])("fails closed when the Anthropic client model $label", async ({ technicalModel }) => {
    const option = anthropicOption(technicalModel.id);
    const { db } = admissionDb({
      answer: officialOpenAiModel,
      options: [option],
      technicalModels: [technicalModel]
    });

    await expect(loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: officialOpenAiModel.connectionId,
      providerModelId: officialOpenAiModel.id,
      searchPlan: { mode: "model_choice", optionIds: [option.optionId] },
      userId: "user-1"
    })).rejects.toMatchObject({ code: "search_strategy_not_available" });
  });

  it("keeps single-source same-connection Gemini Search hosted", async () => {
    const option = geminiOption();
    const { db, providerModelFindUnique } = admissionDb({
      answer: geminiModel,
      options: [option],
      technicalModels: [geminiSearchModel]
    });

    const plan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: geminiModel.connectionId,
      providerModelId: geminiModel.id,
      searchPlan: { mode: "all_selected", optionIds: [option.optionId] },
      userId: "user-1"
    });

    expect(expectSearch(plan)).toMatchObject({
      bindingKey: null,
      integrationId: "route-hosted:gemini",
      configuration: { adapterKind: "answer_provider_hosted" }
    });
    expect(providerModelFindUnique).not.toHaveBeenCalled();
  });

  it("uses the Gemini client route for cross-provider answers and MCP coexistence", async () => {
    const anthropic: ModelSpec = {
      adapterKind: "anthropic_messages",
      connectionId: "connection-anthropic",
      family: "anthropic",
      id: "model-opus-gemini-search",
      upstreamModelId: "claude-opus-5"
    };
    const option = geminiOption();
    for (const request of [
      {
        answer: anthropic,
        requiresClientToolCoexistence: false
      },
      {
        answer: geminiModel,
        requiresClientToolCoexistence: true
      }
    ]) {
      const { db } = admissionDb({
        answer: request.answer,
        options: [option],
        technicalModels: [geminiSearchModel]
      });
      const plan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
        providerConnectionId: request.answer.connectionId,
        providerModelId: request.answer.id,
        ...(request.requiresClientToolCoexistence
          ? { requiresClientToolCoexistence: true }
          : {}),
        searchPlan: { mode: "model_choice", optionIds: [option.optionId] },
        userId: "user-1"
      });
      expect(expectSearch(plan)).toMatchObject({
        bindingKey: "search:gemini-google-search",
        integrationId: "route-client:gemini",
        configuration: { adapterKind: "provider_model_client", provider: "gemini" },
        role: { snapshot: { connectionId: geminiModel.connectionId } }
      });
    }
  });

  it("resolves a multi-source plan as all-client or fails without a complete assignment", async () => {
    const openAi = openAiOption();
    const google = geminiOption();
    const { db } = admissionDb({
      answer: geminiModel,
      options: [google, openAi],
      technicalModels: [geminiSearchModel, officialOpenAiSearchModel]
    });
    const plan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: geminiModel.connectionId,
      providerModelId: geminiModel.id,
      searchPlan: {
        mode: "all_selected",
        optionIds: [google.optionId, openAi.optionId]
      },
      userId: "user-1"
    });
    expect(plan.searches?.map((search) => search.configuration.adapterKind)).toEqual([
      "provider_model_client",
      "provider_model_client"
    ]);

    const modelChoiceDb = admissionDb({
      answer: officialOpenAiModel,
      options: [google, openAi],
      technicalModels: [geminiSearchModel, officialOpenAiSearchModel]
    });
    const modelChoice = await loadProviderAdmissionPlan(
      modelChoiceDb.db as unknown as Prisma.TransactionClient,
      {
        providerConnectionId: officialOpenAiModel.connectionId,
        providerModelId: officialOpenAiModel.id,
        searchPlan: {
          mode: "model_choice",
          optionIds: [google.optionId, openAi.optionId]
        },
        userId: "user-1"
      }
    );
    expect(modelChoice.searches?.map((search) => search.configuration.adapterKind)).toEqual([
      "provider_model_client",
      "answer_provider_hosted"
    ]);

    const incomplete = admissionDb({
      answer: geminiModel,
      options: [geminiOption(false), openAi],
      technicalModels: [officialOpenAiSearchModel]
    });
    await expect(loadProviderAdmissionPlan(
      incomplete.db as unknown as Prisma.TransactionClient,
      {
        providerConnectionId: geminiModel.connectionId,
        providerModelId: geminiModel.id,
        searchPlan: {
          mode: "all_selected",
          optionIds: ["gemini-google-search", openAi.optionId]
        },
        userId: "user-1"
      }
    )).rejects.toMatchObject({ code: "search_strategy_not_available" });
  });

  it.each([
    {
      credentialIdByConnection: {
        [officialOpenAiModel.connectionId]: "credential:connection-openai:replacement"
      },
      credentialVersionIdByConnection: {
        [officialOpenAiModel.connectionId]: "credential-version:connection-openai:replacement"
      },
      expectedCredentialId: "credential:connection-openai:replacement",
      expectedCredentialVersionId: "credential-version:connection-openai:replacement",
      label: "credential"
    },
    {
      credentialIdByConnection: undefined,
      credentialVersionIdByConnection: {
        [officialOpenAiModel.connectionId]: "credential-version:connection-openai:v2"
      },
      expectedCredentialId: "credential:connection-openai",
      expectedCredentialVersionId: "credential-version:connection-openai:v2",
      label: "credential version"
    }
  ])("resolves the current $label at admission without requiring a new Search probe", async (authority) => {
    const anthropic: ModelSpec = {
      adapterKind: "anthropic_messages",
      connectionId: "connection-anthropic",
      family: "anthropic",
      id: "model-opus",
      upstreamModelId: "claude-opus-5"
    };
    const option = openAiOption();
    const { db } = admissionDb({
      answer: anthropic,
      credentialIdByConnection: authority.credentialIdByConnection,
      credentialVersionIdByConnection: authority.credentialVersionIdByConnection,
      options: [option],
      technicalModels: [officialOpenAiSearchModel]
    });

    const plan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: anthropic.connectionId,
      providerModelId: anthropic.id,
      searchPlan: { mode: "model_choice", optionIds: [option.optionId] },
      userId: "user-1"
    });

    expect(expectSearch(plan).role?.authority).toMatchObject({
      credentialId: authority.expectedCredentialId,
      credentialVersionId: authority.expectedCredentialVersionId,
      providerModelId: officialOpenAiSearchModel.id
    });
  });

  it("pins the current rotated credential version without mutating the Search source", async () => {
    const anthropic: ModelSpec = {
      adapterKind: "anthropic_messages",
      connectionId: "connection-anthropic",
      family: "anthropic",
      id: "model-opus",
      upstreamModelId: "claude-opus-5"
    };
    const rotatedVersion = "credential-version:connection-openai:v2";
    const option = openAiOption();
    const { db } = admissionDb({
      answer: anthropic,
      credentialVersionIdByConnection: {
        [officialOpenAiModel.connectionId]: rotatedVersion
      },
      options: [option],
      technicalModels: [officialOpenAiSearchModel]
    });

    const plan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: anthropic.connectionId,
      providerModelId: anthropic.id,
      searchPlan: { mode: "model_choice", optionIds: [option.optionId] },
      userId: "user-1"
    });

    expect(expectSearch(plan)).toMatchObject({
      integrationId: "route-client:openai",
      revisionId: "revision-client:openai",
      role: {
        authority: { credentialVersionId: rotatedVersion }
      }
    });
  });

  it("rejects a disabled provider-model client route", async () => {
    const anthropic: ModelSpec = {
      adapterKind: "anthropic_messages",
      connectionId: "connection-anthropic",
      family: "anthropic",
      id: "model-opus",
      upstreamModelId: "claude-opus-5"
    };
    const source = openAiOption();
    const option: OptionSpec = {
      ...source,
      routes: source.routes?.map((route) => route.adapterKind === "provider_model_client"
        ? { ...route, enabled: false }
        : route)
    };
    const { db } = admissionDb({
      answer: anthropic,
      options: [option],
      technicalModels: [officialOpenAiSearchModel]
    });

    await expect(loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: anthropic.connectionId,
      providerModelId: anthropic.id,
      searchPlan: { mode: "model_choice", optionIds: [option.optionId] },
      userId: "user-1"
    })).rejects.toMatchObject({ code: "search_strategy_not_available" });
  });

  it("rejects a logical source with two active hosted routes", async () => {
    const source = openAiOption();
    const hosted = source.routes!.find((route) => route.adapterKind === "answer_provider_hosted")!;
    const option: OptionSpec = {
      ...source,
      routes: [
        ...source.routes!,
        { ...hosted, id: "route-hosted-duplicate", revisionId: "revision-hosted-duplicate" }
      ]
    };
    const { db } = admissionDb({
      answer: officialOpenAiModel,
      options: [option],
      technicalModels: [officialOpenAiSearchModel]
    });

    await expect(loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: officialOpenAiModel.connectionId,
      providerModelId: officialOpenAiModel.id,
      searchPlan: { mode: "model_choice", optionIds: [option.optionId] },
      userId: "user-1"
    })).rejects.toMatchObject({ code: "search_strategy_not_available" });
  });

  it("rejects a logical source with two active client routes", async () => {
    const anthropic: ModelSpec = {
      adapterKind: "anthropic_messages",
      connectionId: "connection-anthropic",
      family: "anthropic",
      id: "model-opus",
      upstreamModelId: "claude-opus-5"
    };
    const source = openAiOption();
    const client = source.routes!.find((route) => route.adapterKind === "provider_model_client")!;
    const option: OptionSpec = {
      ...source,
      routes: [
        client,
        { ...client, id: "route-client-duplicate", revisionId: "revision-client-duplicate" }
      ]
    };
    const { db } = admissionDb({
      answer: anthropic,
      options: [option],
      technicalModels: [officialOpenAiSearchModel]
    });

    await expect(loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: anthropic.connectionId,
      providerModelId: anthropic.id,
      searchPlan: { mode: "model_choice", optionIds: [option.optionId] },
      userId: "user-1"
    })).rejects.toMatchObject({ code: "search_strategy_not_available" });
  });

  it("uses a custom Responses source in-process when it is the answer connection", async () => {
    const customAnswer: ModelSpec = {
      adapterKind: "openai_responses_compatible",
      connectionId: "connection-custom",
      family: "openai_compatible",
      id: "model-custom-answer",
      nativeSearch: true,
      upstreamModelId: "custom-sol"
    };
    const customSearch = { ...customAnswer, answerSelectable: false, id: "model-custom-search" };
    const option = openAiOption({
      clientConnectionModelId: customSearch.id,
      optionId: "custom-web-search:connection-custom",
      sourceConnectionId: customAnswer.connectionId
    });
    const { db } = admissionDb({
      answer: customAnswer,
      options: [option],
      technicalModels: [customSearch]
    });

    const plan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: customAnswer.connectionId,
      providerModelId: customAnswer.id,
      searchPlan: { mode: "model_choice", optionIds: [option.optionId] },
      userId: "user-1"
    });

    expect(expectSearch(plan)).toMatchObject({
      bindingKey: null,
      integrationId: "route-hosted:custom-web-search:connection-custom",
      optionId: "custom-web-search:connection-custom",
      revisionId: "revision-hosted:custom-web-search:connection-custom"
    });
  });

  it("uses the custom source's client route for official GPT without substituting official Search", async () => {
    const customSearch: ModelSpec = {
      adapterKind: "openai_responses_compatible",
      answerSelectable: false,
      connectionId: "connection-custom",
      family: "openai_compatible",
      id: "model-custom-search",
      nativeSearch: true,
      upstreamModelId: "custom-search-model"
    };
    const option = openAiOption({
      clientConnectionModelId: customSearch.id,
      optionId: "custom-web-search:connection-custom",
      sourceConnectionId: customSearch.connectionId
    });
    const { db } = admissionDb({
      answer: officialOpenAiModel,
      options: [option],
      technicalModels: [customSearch]
    });

    const plan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: officialOpenAiModel.connectionId,
      providerModelId: officialOpenAiModel.id,
      searchPlan: { mode: "model_choice", optionIds: [option.optionId] },
      userId: "user-1"
    });

    expect(expectSearch(plan)).toMatchObject({
      bindingKey: "search:custom-web-search:connection-custom",
      integrationId: "route-client:custom-web-search:connection-custom",
      role: {
        snapshot: {
          connectionId: "connection-custom",
          providerFamily: "openai_compatible"
        }
      }
    });
  });

  it("rejects a client route whose provider model belongs to another source", async () => {
    const option = openAiOption({
      clientConnectionModelId: officialOpenAiSearchModel.id,
      optionId: "custom-web-search:connection-custom",
      sourceConnectionId: "connection-custom"
    });
    const { db } = admissionDb({
      answer: {
        adapterKind: "anthropic_messages",
        connectionId: "connection-anthropic",
        family: "anthropic",
        id: "model-opus",
        upstreamModelId: "claude-opus-5"
      },
      options: [option],
      technicalModels: [officialOpenAiSearchModel]
    });

    await expect(loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: "connection-anthropic",
      providerModelId: "model-opus",
      searchPlan: { mode: "model_choice", optionIds: [option.optionId] },
      userId: "user-1"
    })).rejects.toMatchObject({ code: "search_strategy_not_available" });
  });

  it("keeps Perplexity as an independent client-routed Search source", async () => {
    const anthropic: ModelSpec = {
      adapterKind: "anthropic_messages",
      connectionId: "connection-anthropic",
      family: "anthropic",
      id: "model-opus",
      upstreamModelId: "claude-opus-5"
    };
    const perplexityModel: ModelSpec = {
      adapterKind: "openrouter_chat_completions",
      answerSelectable: false,
      connectionId: "connection-openrouter",
      family: "openrouter",
      id: "model-perplexity-search",
      nativeSearch: true,
      upstreamModelId: "perplexity/sonar"
    };
    const option: OptionSpec = {
      displayName: "Perplexity Search",
      kind: "perplexity_search",
      optionId: "perplexity-tool-search",
      routes: [{
        adapterKind: "provider_model_client",
        id: "route-perplexity-client",
        protocol: "openrouter_perplexity_chat",
        providerModelId: perplexityModel.id,
        revisionId: "revision-perplexity-client"
      }],
      sourceConnectionId: perplexityModel.connectionId
    };
    const { db } = admissionDb({
      answer: anthropic,
      options: [option],
      technicalModels: [perplexityModel]
    });

    const plan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: anthropic.connectionId,
      providerModelId: anthropic.id,
      searchPlan: { mode: "all_selected", optionIds: [option.optionId] },
      userId: "user-1"
    });

    expect(expectSearch(plan)).toMatchObject({
      bindingKey: "search:perplexity-tool-search",
      integrationId: "route-perplexity-client",
      optionId: "perplexity-tool-search",
      revisionId: "revision-perplexity-client",
      role: { snapshot: { connectionId: "connection-openrouter" } }
    });
  });

  it("keeps Google Search native to Gemini and rejects it for non-Gemini answers", async () => {
    const option: OptionSpec = {
      displayName: "Google Search",
      kind: "gemini_google_search",
      optionId: "gemini-google-search",
      routes: [{
        adapterKind: "answer_provider_hosted",
        id: "route-google-hosted",
        protocol: "gemini_google_search",
        revisionId: "revision-google-hosted"
      }],
      sourceConnectionId: "connection-gemini"
    };
    const { db } = admissionDb({ answer: officialOpenAiModel, options: [option] });

    await expect(loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: officialOpenAiModel.connectionId,
      providerModelId: officialOpenAiModel.id,
      searchPlan: { mode: "model_choice", optionIds: [option.optionId] },
      userId: "user-1"
    })).rejects.toMatchObject({ code: "search_strategy_not_available" });
  });

  it("admits exact Gemini-hosted Google Search", async () => {
    const gemini: ModelSpec = {
      adapterKind: "gemini_interactions_native",
      connectionId: "connection-gemini",
      family: "gemini",
      id: "model-gemini",
      nativeSearch: true,
      upstreamModelId: "gemini-3.6-flash"
    };
    const option: OptionSpec = {
      displayName: "Google Search",
      kind: "gemini_google_search",
      optionId: "gemini-google-search",
      routes: [{
        adapterKind: "answer_provider_hosted",
        id: "route-google-hosted",
        protocol: "gemini_google_search",
        revisionId: "revision-google-hosted"
      }],
      sourceConnectionId: gemini.connectionId
    };
    const { db } = admissionDb({ answer: gemini, options: [option] });

    const plan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: gemini.connectionId,
      providerModelId: gemini.id,
      searchPlan: { mode: "model_choice", optionIds: [option.optionId] },
      userId: "user-1"
    });

    expect(expectSearch(plan)).toMatchObject({
      integrationId: "route-google-hosted",
      optionId: "gemini-google-search",
      revisionId: "revision-google-hosted"
    });
  });

  it("checks personal preference grants against logical option ids", async () => {
    const option = openAiOption();
    const { accessGrantCount, db } = admissionDb({
      answer: officialOpenAiModel,
      fullAccess: false,
      grantedSearchOptionIds: ["openai-native-web-search"],
      options: [option],
      technicalModels: [officialOpenAiSearchModel]
    });

    const plan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: officialOpenAiModel.connectionId,
      providerModelId: officialOpenAiModel.id,
      searchPlan: { mode: "model_choice", optionIds: ["openai-native-web-search"] },
      searchPreferencePlan: {
        mode: "model_choice",
        optionIds: ["openai-native-web-search"]
      },
      searchPreferenceSource: "personal",
      userId: "user-1"
    });

    expect(plan.requestedSearchPreferencePlan).toEqual({
      mode: "model_choice",
      optionIds: ["openai-native-web-search"]
    });
    expect(accessGrantCount).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ searchStrategy: "openai-native-web-search" })
    }));
  });

  it("rejects a personal Search preference with no normalized active route", async () => {
    const unavailable: OptionSpec = {
      displayName: "Unavailable Search",
      kind: "web_search",
      optionId: "unavailable-search",
      routes: [],
      sourceConnectionId: officialOpenAiModel.connectionId
    };
    const { db } = admissionDb({
      answer: officialOpenAiModel,
      options: [unavailable]
    });

    await expect(loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: officialOpenAiModel.connectionId,
      providerModelId: officialOpenAiModel.id,
      searchPlan: { mode: "all_selected", optionIds: [] },
      searchPreferencePlan: { mode: "model_choice", optionIds: [unavailable.optionId] },
      searchPreferenceSource: "personal",
      userId: "user-1"
    })).rejects.toMatchObject({ code: "search_strategy_not_available" });
  });

  it("rejects a client-only preference whose dependency belongs to another source", async () => {
    const unavailable: OptionSpec = {
      displayName: "Custom Search",
      kind: "web_search",
      optionId: "custom-web-search:connection-custom",
      routes: [{
        adapterKind: "provider_model_client",
        id: "route-client-mismatched",
        protocol: "openai_responses_web_search",
        providerModelId: officialOpenAiSearchModel.id,
        revisionId: "revision-client-mismatched"
      }],
      sourceConnectionId: "connection-custom"
    };
    const { db } = admissionDb({
      answer: officialOpenAiModel,
      options: [unavailable],
      technicalModels: [officialOpenAiSearchModel]
    });

    await expect(loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: officialOpenAiModel.connectionId,
      providerModelId: officialOpenAiModel.id,
      searchPlan: { mode: "all_selected", optionIds: [] },
      searchPreferencePlan: { mode: "model_choice", optionIds: [unavailable.optionId] },
      searchPreferenceSource: "personal",
      userId: "user-1"
    })).rejects.toMatchObject({ code: "search_strategy_not_available" });
  });

  it("rejects multiple client routes instead of silently trying a later dependency", async () => {
    const anthropic: ModelSpec = {
      adapterKind: "anthropic_messages",
      connectionId: "connection-anthropic",
      family: "anthropic",
      id: "model-opus",
      upstreamModelId: "claude-opus-5"
    };
    const firstSearchModel = { ...officialOpenAiSearchModel, id: "model-search-first" };
    const secondSearchModel = { ...officialOpenAiSearchModel, id: "model-search-second" };
    const option: OptionSpec = {
      displayName: "OpenAI Search",
      kind: "web_search",
      optionId: "openai-native-web-search",
      routes: [
        {
          adapterKind: "provider_model_client",
          id: "route-client-first",
          protocol: "openai_responses_web_search",
          providerModelId: firstSearchModel.id,
          revisionId: "revision-client-first"
        },
        {
          adapterKind: "provider_model_client",
          id: "route-client-second",
          protocol: "openai_responses_web_search",
          providerModelId: secondSearchModel.id,
          revisionId: "revision-client-second"
        }
      ],
      sourceConnectionId: officialOpenAiModel.connectionId
    };
    const { db } = admissionDb({
      answer: anthropic,
      options: [option],
      technicalModels: [firstSearchModel, secondSearchModel]
    });
    await expect(loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: anthropic.connectionId,
      providerModelId: anthropic.id,
      searchPlan: { mode: "model_choice", optionIds: [option.optionId] },
      userId: "user-1"
    })).rejects.toMatchObject({ code: "search_strategy_not_available" });
  });

  it("does not admit an active physical route without its exact active revision", async () => {
    const option = logicalOption(openAiOption());
    const { db } = admissionDb({
      answer: officialOpenAiModel,
      options: [openAiOption()],
      technicalModels: [officialOpenAiSearchModel]
    });
    db.searchOption.findFirst.mockImplementationOnce(async () => ({
      ...option,
      strategies: [{ ...option.strategies[0]!, activeRevision: null }]
    }) as never);

    await expect(loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: officialOpenAiModel.connectionId,
      providerModelId: officialOpenAiModel.id,
      searchPlan: { mode: "model_choice", optionIds: ["openai-native-web-search"] },
      userId: "user-1"
    })).rejects.toMatchObject({ code: "search_strategy_not_available" });
  });
});
