import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { parameterControlsForModel } from "../../domain/catalog";
import { validateRunParams } from "../../domain/runParams";
import type { ProviderReasoningRequestMapping } from "../../contracts/providerReasoningRequestMapping";
import { configuredModelParameterControls } from "../providers/providerModelCapabilities";
import { insertAcceptedProviderRunBindings } from "../runs/prismaRepositoryBindings";
import { loadInstallationAnswerProviderRole, loadInstallationRerankerProviderRole, loadProviderAdmissionPlan, ProviderAdmissionError, type ProviderAdmissionPlan } from "./admission";

const capabilities = (input: Readonly<{
  nativePdfInput?: boolean;
  nativeSearch?: boolean;
  pdf?: boolean;
  reasoningModes?: readonly string[];
  toolCalling?: boolean;
}> = {}) => ({
  ...(input.reasoningModes
    ? { defaultReasoningMode: input.reasoningModes[0], reasoningModes: [...input.reasoningModes] }
    : {}),
  nativePdfInput: input.nativePdfInput ?? true,
  nativeSearch: input.nativeSearch ?? false,
  pdf: input.pdf ?? true,
  reasoning: true,
  streaming: true,
  toolCalling: input.toolCalling ?? true,
  vision: true
});

type ModelSpec = Readonly<{
  adapterKind:
    | "anthropic_messages"
    | "deepseek_responses_native"
    | "gemini_interactions_native"
    | "openai_chat_completions_compatible"
    | "openai_responses_compatible"
    | "openai_responses_native"
    | "openrouter_chat_completions";
  answerSelectable?: boolean;
  connectionResponseTimeoutMs?: number;
  connectionId: string;
  contextWindow?: number;
  defaultParams?: Readonly<Record<string, unknown>>;
  displayName?: string;
  family: "anthropic" | "deepseek" | "gemini" | "openai" | "openai_compatible" | "openrouter";
  id: string;
  nativePdfInput?: boolean;
  nativeSearch?: boolean;
  pdf?: boolean;
  responseTimeoutMs?: number;
  reasoningModes?: readonly string[];
  reasoningRequestMapping?: ProviderReasoningRequestMapping;
  toolCalling?: boolean;
  upstreamModelId: string;
}>;

type RouteSpec = Readonly<{
  adapterKind: "answer_provider_hosted" | "provider_model_client";
  enabled?: boolean;
  id: string;
  /** OpenRouter's web search engine; Perplexity when absent. */
  openRouterEngine?: "exa" | "parallel" | "perplexity";
  protocol:
    | "anthropic_web_search"
    | "deepseek_search_api"
    | "gemini_google_search"
    | "openai_responses_web_search"
    | "openrouter_perplexity_chat"
    | "openrouter_web_search";
  providerModelId?: string | null;
  revisionId: string;
}>;

type OptionSpec = Readonly<{
  displayName: string;
  kind: "deepseek_search_api" | "gemini_google_search" | "none" | "perplexity_search" | "web_search";
  optionId: string;
  routes?: readonly RouteSpec[];
  sourceConnectionId: string | null;
}>;

function apiRoot(family: ModelSpec["family"]): string {
  if (family === "anthropic") return "https://api.anthropic.com/v1";
  if (family === "deepseek") return "https://api.deepseek.com";
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
        nativePdfInput: spec.nativePdfInput,
        nativeSearch: spec.nativeSearch,
        pdf: spec.pdf,
        reasoningModes: spec.reasoningModes,
        toolCalling: spec.toolCalling
      }),
      defaultParams: spec.defaultParams ?? {},
      modelClass: "answer",
      ...(spec.reasoningRequestMapping
        ? { reasoningRequestMapping: spec.reasoningRequestMapping }
        : {}),
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
    ...(spec.protocol === "openrouter_web_search"
      ? { openRouterWebSearch: spec.openRouterEngine === "parallel"
          ? { engine: "parallel", mode: "fast" }
          : spec.openRouterEngine === "exa" ? { engine: "exa", mode: "auto" } : { engine: "perplexity", mode: null } }
      : {}),
    protocol: spec.protocol,
    providerModelId,
    // The DeepSeek Search API takes at most 128 query characters.
    queryMaxCharacters: spec.protocol === "deepseek_search_api" ? 128 : 500,
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

function logicalOption(spec: OptionSpec, index = 0) {
  return {
    archivedAt: null,
    // Sources are ordered by when they were set up; the list order stands for it.
    createdAt: new Date(Date.UTC(2026, 7, 1) + index * 60_000),
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
  credentialCheckEvidenceByModel?: Readonly<Record<string, unknown>>;
  credentialCheckEvidenceByCredential?: Readonly<Record<string, unknown>>;
  /** The installation's Search policy row; none reads as the default policy. */
  policy?: Readonly<{ backupOptionId?: string | null; engineOptionId?: string | null; inAnswerSearch?: boolean }>;
  technicalModels?: readonly ModelSpec[];
  unassignedPolicy?: "require_assignment" | "use_default";
  /** Models that are not live at all. */
  unavailableModelIds?: readonly string[];
  /** Live models this user's admission cannot load (their credentials do not reach them). */
  unreachableModelIds?: readonly string[];
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
  const options = new Map(input.options.map((spec, index) => [spec.optionId, logicalOption(spec, index)]));
  const grantedSearchOptionIds = new Set(input.grantedSearchOptionIds ?? []);
  // A Search grant of any source lets its holder search; a model grant counts as granted.
  const accessGrantCount = vi.fn(async (args?: {
    where?: { searchStrategy?: unknown };
  }) => args?.where?.searchStrategy !== undefined
    ? Number(grantedSearchOptionIds.size > 0)
    : 1);
  const unavailableModelIds = new Set(input.unavailableModelIds ?? []);
  const unreachableModelIds = new Set(input.unreachableModelIds ?? []);
  const providerModelFindFirst = vi.fn(async (args?: { where?: { id?: string } }) => {
    const id = args?.where?.id ?? input.answer.id;
    return unavailableModelIds.has(id) || unreachableModelIds.has(id) ? null : models.get(id) ?? null;
  });
  const providerModelFindMany = vi.fn(async (args?: { where?: { id?: { in?: readonly string[] } } }) =>
    (args?.where?.id?.in ?? []).flatMap((id) => {
      const model = models.get(id);
      return model && !unavailableModelIds.has(id)
        ? [{ activeConfig: model.activeConfig, connectionId: model.connectionId, id }]
        : [];
    }));
  const providerModelFindUnique = vi.fn(async (args?: { where?: { id?: string } }) => {
    const model = models.get(args?.where?.id ?? "");
    return model ? { connectionId: model.connectionId } : null;
  });
  const searchOptionFindFirst = vi.fn(async (args?: { where?: { optionId?: string } }) =>
    options.get(args?.where?.optionId ?? "") ?? null);
  const searchOptionFindMany = vi.fn(async () => [...options.values()]);
  const searchPolicyFindUnique = vi.fn(async () => input.policy
    ? { backupOptionId: null, engineOptionId: null, inAnswerSearch: true, ...input.policy }
    : null);
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
      findMany: providerModelFindMany,
      findUnique: providerModelFindUnique
    },
    providerModelCredentialCheck: {
      findFirst: vi.fn(async (args?: {
        where?: { credentialId?: string; providerModelId?: string };
      }) => ({
        evidence: input.credentialCheckEvidenceByCredential?.[
          args?.where?.credentialId ?? ""
        ] ?? input.credentialCheckEvidenceByModel?.[
          args?.where?.providerModelId ?? input.answer.id
        ] ?? {},
        id: "check-1"
      }))
    },
    searchOption: { findFirst: searchOptionFindFirst, findMany: searchOptionFindMany },
    searchPolicy: { findUnique: searchPolicyFindUnique },
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
    searchOptionFindFirst,
    searchOptionFindMany
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
  it.each([undefined, "another-model", officialOpenAiModel.upstreamModelId])(
    "grants image transcription only with matching active evidence (%s)", async (upstreamModelId) => {
      const answer = officialOpenAiModel;
      const { db } = admissionDb({
        answer,
        credentialCheckEvidenceByModel: { [answer.id]: upstreamModelId ? {
          visionInput: { adapterKind: answer.adapterKind, probeVersion: 1,
            upstreamModelId, verified: true }
        } : {} },
        options: [off]
      });
      const plan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
        providerConnectionId: answer.connectionId, providerModelId: answer.id,
        searchPlan: { mode: "all_selected", optionIds: [] }, userId: "user-1"
      });
      expect(plan.answer.verifiedVisionInput === true)
        .toBe(upstreamModelId === answer.upstreamModelId);
    }
  );
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

  it("admits technical-only internal models independently of chat visibility and rejects unavailable targets", async () => {
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
      defaultCredentialIdByConnection: { [officialOpenAiModel.connectionId]: "credential:" + officialOpenAiModel.connectionId },
      options: [off]
    });
    await expect(loadInstallationAnswerProviderRole(
      technical.db as unknown as Prisma.TransactionClient,
      { providerModelId: officialOpenAiModel.id }
    )).resolves.toMatchObject({ snapshot: { providerModelId: officialOpenAiModel.id } });
  });

  it("keeps answer and reranker installation admission classes mutually exclusive", async () => {
    const findFirst = vi.fn(async () => null);
    const db = {
      providerModel: {
        findFirst,
        findUnique: vi.fn(async () => ({ connectionId: "connection-1" }))
      }
    } as unknown as Prisma.TransactionClient;

    await expect(loadInstallationAnswerProviderRole(
      db,
      { providerModelId: "reranker-1" }
    )).rejects.toEqual(new ProviderAdmissionError("model_not_available"));
    await expect(loadInstallationRerankerProviderRole(
      db,
      { providerModelId: "answer-1" }
    )).rejects.toEqual(new ProviderAdmissionError("model_not_available"));

    expect(findFirst).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ id: "reranker-1", modelClass: "answer" })
    }));
    expect(findFirst).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ id: "answer-1", modelClass: "reranker" })
    }));
  });

  // A mode is offered only where the administrator listed the model's modes and the
  // route can carry one; an unconfigured codex-lb row offers none (2026-11-07).
  it.each([
    { adapterKind: "openai_responses_compatible", mapping: undefined, mode: true, modes: ["standard", "pro"] },
    { adapterKind: "openai_responses_compatible", mapping: undefined, mode: false, modes: undefined },
    { adapterKind: "openai_responses_compatible", mapping: { effortPath: "thinking.effort", modePath: "thinking.mode" }, mode: true, modes: ["standard", "pro"] },
    { adapterKind: "openai_chat_completions_compatible", mapping: { effortPath: "reasoning_effort", modePath: "reasoning_mode" }, mode: true, modes: ["standard", "pro"] },
    { adapterKind: "openai_chat_completions_compatible", mapping: undefined, mode: false, modes: ["standard", "pro"] }
  ] as const)("accepts catalog reasoning controls after $adapterKind admission with mode=$mode", async ({ adapterKind, mapping, mode, modes }) => {
    const answer: ModelSpec = {
      adapterKind, connectionId: "connection-compatible", family: "openai_compatible",
      id: "model-compatible", upstreamModelId: "vendor/reasoning-model",
      ...(mapping ? { reasoningRequestMapping: mapping } : {}),
      ...(modes ? { reasoningModes: modes } : {})
    };
    const { db } = admissionDb({ answer, options: [off] });
    const plan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: answer.connectionId, providerModelId: answer.id,
      searchPlan: { mode: "all_selected", optionIds: [] }, userId: "user-1"
    });
    const model = plan.answer.snapshot.model;
    if (model.adapterKind === "fake") throw new Error("expected_compatible_model");
    const catalogControls = configuredModelParameterControls(model, answer.family);
    expect(Boolean(catalogControls.reasoningMode?.supported)).toBe(mode);
    const configuration = plan.answer.modelConfiguration;
    const acceptedControls = parameterControlsForModel({
      adapterKind: configuration.adapterKind, defaultParams: configuration.defaultParams,
      modelCapabilities: configuration.capabilities, modelId: model.upstreamModelId,
      provider: "openai", supportsReasoningMode: Boolean(configuration.reasoningRequestMapping?.modePath)
    });
    expect(validateRunParams({
      controls: acceptedControls, provider: "openai", params: {
        maxOutputTokens: catalogControls.maxOutputTokens.defaultValue,
        reasoning: {
          effort: catalogControls.reasoningEffort.defaultValue,
          ...(catalogControls.reasoningMode?.supported
            ? { mode: catalogControls.reasoningMode.defaultValue } : {})
        }
      }
    }).ok).toBe(true);
    expect(configuration.reasoningRequestMapping).toEqual(model.reasoningRequestMapping);
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

  it("grants strict capabilities only from exact current-tuple probe evidence", async () => {
    const verified = admissionDb({
      answer: officialOpenAiModel,
      options: [off],
      credentialCheckEvidenceByModel: {
        [officialOpenAiModel.id]: {
          forcedToolCall: {
            adapterKind: officialOpenAiModel.adapterKind,
            probeVersion: 2,
            upstreamModelId: officialOpenAiModel.upstreamModelId,
            verified: true,
            verifiedModes: ["native"]
          },
          structuredOutput: {
            adapterKind: officialOpenAiModel.adapterKind,
            probeVersion: 2,
            upstreamModelId: officialOpenAiModel.upstreamModelId,
            verified: true
          }
        }
      }
    });
    const withoutEvidence = admissionDb({
      answer: officialOpenAiModel,
      options: [off]
    });

    const [verifiedPlan, unverifiedPlan] = await Promise.all([
      loadProviderAdmissionPlan(verified.db as unknown as Prisma.TransactionClient, {
        providerConnectionId: officialOpenAiModel.connectionId,
        providerModelId: officialOpenAiModel.id,
        searchPlan: { mode: "all_selected", optionIds: [] },
        userId: "user-1"
      }),
      loadProviderAdmissionPlan(withoutEvidence.db as unknown as Prisma.TransactionClient, {
        providerConnectionId: officialOpenAiModel.connectionId,
        providerModelId: officialOpenAiModel.id,
        searchPlan: { mode: "all_selected", optionIds: [] },
        userId: "user-1"
      })
    ]);

    expect(verifiedPlan.answer.modelConfiguration.capabilities.structuredOutput).toBe(true);
    expect(verifiedPlan.answer.snapshot.model.capabilities.structuredOutput).toBe(true);
    expect(verifiedPlan.answer.modelConfiguration.capabilities.forcedToolCalling).toBe(true);
    expect(verifiedPlan.answer.snapshot.model.capabilities.forcedToolCalling).toBe(true);
    expect(unverifiedPlan.answer.modelConfiguration.capabilities.structuredOutput).not.toBe(true);
    expect(unverifiedPlan.answer.snapshot.model.capabilities.structuredOutput).not.toBe(true);
    expect(unverifiedPlan.answer.modelConfiguration.capabilities.forcedToolCalling).not.toBe(true);
    expect(unverifiedPlan.answer.snapshot.model.capabilities.forcedToolCalling).not.toBe(true);
  });

  it.each([
    {
      declared: false,
      evidence: undefined,
      expected: false,
      scenario: "undeclared without evidence"
    },
    {
      declared: false,
      evidence: {
        adapterKind: officialOpenAiModel.adapterKind,
        probeVersion: 1,
        upstreamModelId: officialOpenAiModel.upstreamModelId,
        verified: true
      },
      expected: false,
      scenario: "undeclared with matching evidence"
    },
    {
      declared: true,
      evidence: undefined,
      expected: false,
      scenario: "declared without evidence"
    },
    {
      declared: true,
      evidence: { verified: true },
      expected: false,
      scenario: "declared with malformed evidence"
    },
    {
      declared: true,
      evidence: {
        adapterKind: officialOpenAiModel.adapterKind,
        probeVersion: 1,
        upstreamModelId: "gpt-other",
        verified: true
      },
      expected: false,
      scenario: "declared with evidence for another deployment"
    },
    {
      declared: true,
      evidence: {
        adapterKind: "anthropic_messages",
        probeVersion: 1,
        upstreamModelId: officialOpenAiModel.upstreamModelId,
        verified: true
      },
      expected: false,
      scenario: "declared with evidence for another adapter"
    },
    {
      declared: true,
      evidence: {
        adapterKind: officialOpenAiModel.adapterKind,
        probeVersion: 1,
        upstreamModelId: officialOpenAiModel.upstreamModelId,
        verified: true
      },
      expected: true,
      scenario: "declared with current matching evidence"
    }
  ])("normalizes direct PDF for $scenario", async ({ declared, evidence, expected }) => {
    const answer = { ...officialOpenAiModel, nativePdfInput: declared };
    const { db } = admissionDb({
      answer,
      ...(evidence === undefined
        ? {}
        : { credentialCheckEvidenceByModel: { [answer.id]: { pdfInput: evidence } } }),
      options: [off]
    });

    const plan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: answer.connectionId,
      providerModelId: answer.id,
      searchPlan: { mode: "all_selected", optionIds: [] },
      userId: "user-1"
    });

    expect(plan.answer.modelConfiguration.capabilities.nativePdfInput).toBe(expected);
    expect(plan.answer.snapshot.model.capabilities.nativePdfInput).toBe(expected);
  });

  it("enables local PDF extraction for a new answer run with legacy capability metadata", async () => {
    const answer = { ...officialOpenAiModel, nativePdfInput: false, pdf: false };
    const { db } = admissionDb({ answer, options: [off] });

    const plan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: answer.connectionId,
      providerModelId: answer.id,
      searchPlan: { mode: "all_selected", optionIds: [] },
      userId: "user-1"
    });

    expect(plan.answer.modelConfiguration.capabilities.pdf).toBe(true);
    expect(plan.answer.snapshot.model.capabilities.pdf).toBe(true);
    expect(plan.answer.snapshot.model.capabilities.nativePdfInput).toBe(false);
  });

  it("does not reuse credential A PDF evidence for a user routed through credential B", async () => {
    const credentialB = "credential-b";
    const { db } = admissionDb({
      answer: officialOpenAiModel,
      credentialCheckEvidenceByCredential: {
        "credential-a": {
          pdfInput: {
            adapterKind: officialOpenAiModel.adapterKind,
            probeVersion: 1,
            upstreamModelId: officialOpenAiModel.upstreamModelId,
            verified: true
          }
        },
        [credentialB]: {}
      },
      credentialIdByConnection: {
        [officialOpenAiModel.connectionId]: credentialB
      },
      options: [off]
    });

    const plan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
      providerConnectionId: officialOpenAiModel.connectionId,
      providerModelId: officialOpenAiModel.id,
      searchPlan: { mode: "all_selected", optionIds: [] },
      userId: "user-1"
    });

    expect(plan.answer.snapshot.credentialId).toBe(credentialB);
    expect(plan.answer.snapshot.model.capabilities.nativePdfInput).toBe(false);
    expect(db.providerModelCredentialCheck.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ credentialId: credentialB })
    }));
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

  describe("the installation's Search engine", () => {
    const anthropic: ModelSpec = {
      adapterKind: "anthropic_messages",
      connectionId: "connection-anthropic",
      family: "anthropic",
      id: "model-opus",
      upstreamModelId: "claude-opus-5"
    };
    const on = { mode: "all_selected" as const, optionIds: ["web-search"] };
    const openRouterModel: ModelSpec = {
      adapterKind: "openrouter_chat_completions",
      answerSelectable: false,
      connectionId: "connection-openrouter",
      family: "openrouter",
      id: "model-openrouter-flash",
      upstreamModelId: "deepseek/deepseek-v4.1-flash"
    };
    const openRouterOption = (engine: "parallel" | "perplexity" = "perplexity"): OptionSpec => ({
      displayName: `OpenRouter ${engine}`,
      kind: "web_search",
      optionId: `openrouter-${engine}`,
      routes: [{
        adapterKind: "provider_model_client",
        id: `route-openrouter-${engine}`,
        openRouterEngine: engine,
        protocol: "openrouter_web_search",
        providerModelId: openRouterModel.id,
        revisionId: `revision-openrouter-${engine}`
      }],
      sourceConnectionId: openRouterModel.connectionId
    });
    const deepSeekCarrier: ModelSpec = {
      adapterKind: "deepseek_responses_native",
      connectionId: "connection-deepseek",
      family: "deepseek",
      id: "model-deepseek-flash",
      nativeSearch: false,
      upstreamModelId: "deepseek-flash"
    };
    const deepSeekOption = (providerModelId = deepSeekCarrier.id): OptionSpec => ({
      displayName: "DeepSeek Search API",
      kind: "deepseek_search_api",
      optionId: "deepseek-search-api-1",
      routes: [{
        adapterKind: "provider_model_client",
        id: "route-deepseek-api",
        protocol: "deepseek_search_api",
        providerModelId,
        revisionId: "revision-deepseek-api"
      }],
      sourceConnectionId: deepSeekCarrier.connectionId
    });
    const admit = (db: unknown, answer: ModelSpec, extra: Readonly<{ requiresClientToolCoexistence?: boolean }> = {}) =>
      loadProviderAdmissionPlan(db as Prisma.TransactionClient, {
        providerConnectionId: answer.connectionId,
        providerModelId: answer.id,
        requiresClientToolCoexistence: true,
        searchPlan: on,
        userId: "user-1",
        ...extra
      });
    const uses = (plan: ProviderAdmissionPlan) => plan.searches.map((search) => [search.optionId, search.use]);

    it("reads nothing of Search while it is off", async () => {
      const { db, searchOptionFindMany } = admissionDb({ answer: officialOpenAiModel, options: [openAiOption()] });
      const plan = await admit(db, officialOpenAiModel, {});
      const offPlan = await loadProviderAdmissionPlan(db as unknown as Prisma.TransactionClient, {
        providerConnectionId: officialOpenAiModel.connectionId, providerModelId: officialOpenAiModel.id,
        searchPlan: { mode: "all_selected", optionIds: [] }, userId: "user-1"
      });
      expect(plan.requestedSearchPlan).toEqual(on);
      expect(offPlan).toMatchObject({ requestedSearchPlan: { mode: "all_selected", optionIds: [] }, searches: [] });
      expect(offPlan.searchUnavailable).toBeUndefined();
      expect(searchOptionFindMany).toHaveBeenCalledTimes(1);
    });

    it("lets GPT search inside its own answer and binds the engine for its sub-agents and researchers", async () => {
      const option = openAiOption();
      const { db, providerModelFindUnique } = admissionDb({
        answer: officialOpenAiModel, options: [option], technicalModels: [officialOpenAiSearchModel]
      });
      const plan = await admit(db, officialOpenAiModel);

      expect(uses(plan)).toEqual([[option.optionId, "in_answer"], [option.optionId, "engine"]]);
      expect(plan.searches[0]).toMatchObject({
        bindingKey: null, integrationId: "route-hosted:openai", revisionId: "revision-hosted:openai",
        configuration: { adapterKind: "answer_provider_hosted", displayName: "OpenAI Search", strategyId: option.optionId }
      });
      expect(plan.searches[0]).not.toHaveProperty("role");
      expect(plan.searches[1]).toMatchObject({
        bindingKey: `search:${option.optionId}`, integrationId: "route-client:openai",
        configuration: { adapterKind: "provider_model_client", modelId: "gpt-5.6-search" },
        role: { snapshot: { connectionId: officialOpenAiModel.connectionId } }
      });
      expect(providerModelFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: officialOpenAiSearchModel.id } }));
    });

    it("gives GPT the engine's web_search instead while the administrator's switch is off", async () => {
      const option = openAiOption();
      const { db } = admissionDb({
        answer: officialOpenAiModel, options: [option], policy: { inAnswerSearch: false },
        technicalModels: [officialOpenAiSearchModel]
      });
      expect(uses(await admit(db, officialOpenAiModel))).toEqual([[option.optionId, "engine"]]);
    });

    it("never searches inside an answer without verified hosted search or on another protocol", async () => {
      const option = openAiOption();
      const unverified = { ...officialOpenAiModel, id: "model-openai-unverified", nativeSearch: false };
      const first = admissionDb({ answer: unverified, options: [option], technicalModels: [officialOpenAiSearchModel] });
      expect(uses(await admit(first.db, unverified))).toEqual([[option.optionId, "engine"]]);
      // Hosted Anthropic and Gemini search never run beside chat tools; their client routes do.
      const google = geminiOption();
      const second = admissionDb({ answer: geminiModel, options: [google], technicalModels: [geminiSearchModel] });
      const plan = await admit(second.db, geminiModel);
      expect(uses(plan)).toEqual([[google.optionId, "engine"]]);
      expect(plan.searches[0]).toMatchObject({ integrationId: "route-client:gemini", configuration: { provider: "gemini" } });
      const claude = anthropicOption();
      const third = admissionDb({ answer: officialAnthropicModel, options: [claude], technicalModels: [officialAnthropicSearchModel] });
      expect((await admit(third.db, officialAnthropicModel)).searches[0]).toMatchObject({
        integrationId: "route-client:anthropic", use: "engine", configuration: { adapterKind: "provider_model_client" }
      });
    });

    it.each([
      { engine: "openai-native-web-search", label: "OpenAI (Codex LB) only", options: () => [openAiOption()] },
      { engine: "openrouter-perplexity", label: "OpenRouter only", options: () => [openRouterOption("parallel"), openRouterOption()] },
      { engine: "deepseek-search-api-1", label: "DeepSeek only", options: () => [deepSeekOption()] },
      { engine: "gemini-google-search", label: "Gemini only", options: () => [geminiOption()] },
      { engine: "anthropic-web-search", label: "Anthropic only", options: () => [anthropicOption()] },
      {
        engine: "openai-native-web-search", label: "every provider, set up in reverse order",
        options: () => [anthropicOption(), geminiOption(), deepSeekOption(), openRouterOption(), openAiOption()]
      },
      {
        engine: "openrouter-perplexity", label: "OpenRouter, DeepSeek and Gemini",
        options: () => [geminiOption(), deepSeekOption(), openRouterOption()]
      }
    ])("follows the default order on an installation with $label", async ({ engine, options }) => {
      const { db } = admissionDb({
        answer: anthropic, options: options(),
        technicalModels: [officialOpenAiSearchModel, openRouterModel, deepSeekCarrier, geminiSearchModel, officialAnthropicSearchModel]
      });
      const plan = await admit(db, anthropic);
      expect(uses(plan)).toEqual([[engine, "engine"]]);
      expect(plan.searchUnavailable).toBeUndefined();
    });

    it("names why an installation without a default engine cannot search, and never picks Parallel or Sonar", async () => {
      const sonar: OptionSpec = {
        displayName: "Perplexity Sonar", kind: "perplexity_search", optionId: "perplexity-tool-search",
        routes: [{ adapterKind: "provider_model_client", id: "route-sonar", protocol: "openrouter_perplexity_chat",
          providerModelId: openRouterModel.id, revisionId: "revision-sonar" }],
        sourceConnectionId: openRouterModel.connectionId
      };
      const { db } = admissionDb({ answer: anthropic, options: [openRouterOption("parallel"), sonar], technicalModels: [openRouterModel] });
      const plan = await admit(db, anthropic);
      expect(plan.searches).toEqual([]);
      expect(plan.searchUnavailable).toBe("search_engine_not_configured");
      // Admission still succeeds: the answer runs without Search and says why.
      expect(plan.answer.snapshot.providerModelId).toBe(anthropic.id);
    });

    it("searches with the administrator's engine and never replaces it when it cannot search", async () => {
      const options = [openAiOption(), geminiOption()];
      const technicalModels = [officialOpenAiSearchModel, geminiSearchModel];
      const chosen = admissionDb({ answer: anthropic, options, policy: { engineOptionId: "gemini-google-search" }, technicalModels });
      expect(uses(await admit(chosen.db, anthropic))).toEqual([["gemini-google-search", "engine"]]);

      const broken = admissionDb({
        answer: anthropic, options, policy: { engineOptionId: "gemini-google-search" }, technicalModels,
        unavailableModelIds: [geminiSearchModel.id]
      });
      const plan = await admit(broken.db, anthropic);
      expect(plan.searches).toEqual([]);
      expect(plan.searchUnavailable).toBe("search_engine_unavailable");
    });

    it("binds the backup beside a usable engine only, never in its place", async () => {
      const options = [deepSeekOption(), geminiOption()];
      const technicalModels = [deepSeekCarrier, geminiSearchModel];
      const policy = { backupOptionId: "gemini-google-search", engineOptionId: "deepseek-search-api-1" };
      const both = admissionDb({ answer: anthropic, options, policy, technicalModels });
      const plan = await admit(both.db, anthropic);
      expect(uses(plan)).toEqual([["deepseek-search-api-1", "engine"], ["gemini-google-search", "backup"]]);
      expect(plan.searches.map((search) => search.bindingKey)).toEqual(["search:deepseek-search-api-1", "search:gemini-google-search"]);

      const engineDown = admissionDb({ answer: anthropic, options, policy, technicalModels, unavailableModelIds: [deepSeekCarrier.id] });
      const down = await admit(engineDown.db, anthropic);
      expect(down.searches).toEqual([]);
      expect(down.searchUnavailable).toBe("search_engine_unavailable");
    });

    it("leaves Search unavailable for a user the engine's credentials do not reach, without trying another engine", async () => {
      const { db } = admissionDb({
        answer: anthropic, options: [openAiOption(), geminiOption()],
        technicalModels: [officialOpenAiSearchModel, geminiSearchModel], unreachableModelIds: [officialOpenAiSearchModel.id]
      });
      const plan = await admit(db, anthropic);
      expect(plan.searches).toEqual([]);
      expect(plan.searchUnavailable).toBe("search_engine_unavailable");
    });

    it("keeps in-answer search for GPT when only the engine cannot run, and names the reason for its sub-agents", async () => {
      const option = openAiOption();
      const { db } = admissionDb({
        answer: officialOpenAiModel, options: [option], technicalModels: [officialOpenAiSearchModel],
        unavailableModelIds: [officialOpenAiSearchModel.id]
      });
      const plan = await admit(db, officialOpenAiModel);
      expect(uses(plan)).toEqual([[option.optionId, "in_answer"]]);
      expect(plan.searchUnavailable).toBe("search_engine_not_configured");
    });

    it("lets any Search grant carry over to the engine, and names a user without one", async () => {
      const option = geminiOption();
      const granted = admissionDb({
        answer: anthropic, fullAccess: false, grantedSearchOptionIds: ["an-earlier-source"], options: [option],
        technicalModels: [geminiSearchModel]
      });
      expect(uses(await admit(granted.db, anthropic))).toEqual([[option.optionId, "engine"]]);

      const ungranted = admissionDb({ answer: anthropic, fullAccess: false, options: [option], technicalModels: [geminiSearchModel] });
      const plan = await admit(ungranted.db, anthropic);
      expect(plan.searches).toEqual([]);
      expect(plan.searchUnavailable).toBe("search_not_granted");
      expect(ungranted.searchOptionFindMany).not.toHaveBeenCalled();
    });

    it("refuses an engine whose route lacks its exact active revision, is disabled, or competes with another", async () => {
      const option = openAiOption();
      const cases = [
        { ...option, routes: option.routes!.map((route) => route.adapterKind === "provider_model_client" ? { ...route, enabled: false } : route) },
        { ...option, routes: [...option.routes!, { ...option.routes![1]!, id: "route-client:second", revisionId: "revision-client:second" }] }
      ];
      for (const spec of cases) {
        const { db } = admissionDb({ answer: anthropic, options: [spec], technicalModels: [officialOpenAiSearchModel] });
        expect((await admit(db, anthropic)).searchUnavailable).toBe("search_engine_not_configured");
      }
      const missingRevision = admissionDb({ answer: anthropic, options: [option], technicalModels: [officialOpenAiSearchModel] });
      const row = logicalOption(option);
      missingRevision.searchOptionFindMany.mockImplementationOnce(async () => [{
        ...row, strategies: row.strategies.map((strategy) => ({ ...strategy, activeRevision: null }))
      }] as never);
      expect((await admit(missingRevision.db, anthropic)).searchUnavailable).toBe("search_engine_not_configured");
    });

    it("refuses a client route whose technical model belongs to another connection", async () => {
      const foreign: ModelSpec = { ...officialOpenAiSearchModel, connectionId: "connection-elsewhere" };
      const { db } = admissionDb({ answer: anthropic, options: [openAiOption()], technicalModels: [foreign] });
      expect((await admit(db, anthropic)).searchUnavailable).toBe("search_engine_not_configured");
      const carrier = admissionDb({
        answer: anthropic, options: [deepSeekOption(officialOpenAiSearchModel.id)],
        technicalModels: [{ ...officialOpenAiSearchModel, connectionId: deepSeekCarrier.connectionId }]
      });
      expect((await admit(carrier.db, anthropic)).searchUnavailable).toBe("search_engine_not_configured");
    });

    it.each([
      ["OpenAI", officialOpenAiModel],
      ["Claude", anthropic],
      ["DeepSeek", { ...deepSeekCarrier, id: "model-deepseek-pro", nativeSearch: true, upstreamModelId: "deepseek-v4-pro" }]
    ] satisfies Array<[string, ModelSpec]>)("admits the DeepSeek Search API's raw results for a %s answer model", async (_name, answer) => {
      const { db } = admissionDb({ answer, options: [deepSeekOption()], technicalModels: [deepSeekCarrier] });
      const plan = await admit(db, answer);
      expect(plan.searches.find((search) => search.use === "engine")).toMatchObject({
        bindingKey: "search:deepseek-search-api-1",
        configuration: {
          adapterKind: "provider_model_client",
          kind: "provider_model_web_search",
          // Usage and evidence name the API, not the carrier model.
          modelId: "deepseek-search-api",
          protocol: "deepseek_search_api",
          provider: "deepseek",
          providerModelId: deepSeekCarrier.id
        },
        integrationId: "route-deepseek-api",
        role: { snapshot: { connectionId: "connection-deepseek", providerModelId: deepSeekCarrier.id } }
      });
    });

    it.each([false, true])("persists the run's bindings after revalidation with Search on=%s", async (searchOn) => {
      const option = openAiOption();
      const { db } = admissionDb({ answer: anthropic, options: [option], technicalModels: [officialOpenAiSearchModel] });
      const createMany = vi.fn(async () => ({ count: searchOn ? 2 : 1 }));
      const tx = { ...db, providerRunBinding: { createMany } } as unknown as Prisma.TransactionClient;
      const plan = await loadProviderAdmissionPlan(tx, {
        providerConnectionId: anthropic.connectionId, providerModelId: anthropic.id,
        searchPlan: searchOn ? on : { mode: "all_selected", optionIds: [] },
        userId: "user-1", requiresClientToolCoexistence: true
      });

      await insertAcceptedProviderRunBindings(tx, { plan, nativeBackgroundRequested: false, runId: "agent-run", userId: "user-1" });

      expect(createMany).toHaveBeenCalledExactlyOnceWith({ data: [
        expect.objectContaining({ role: "answer", providerModelId: anthropic.id, modelRunId: "agent-run" }),
        ...(searchOn ? [expect.objectContaining({ role: "search", bindingKey: `search:${option.optionId}`,
          providerModelId: officialOpenAiSearchModel.id, modelRunId: "agent-run" })] : [])
      ] });
    });

    it.each([
      {
        credentialIdByConnection: { [officialOpenAiModel.connectionId]: "credential:connection-openai:replacement" },
        credentialVersionIdByConnection: { [officialOpenAiModel.connectionId]: "credential-version:connection-openai:replacement" },
        expectedCredentialId: "credential:connection-openai:replacement",
        expectedCredentialVersionId: "credential-version:connection-openai:replacement",
        label: "credential"
      },
      {
        credentialIdByConnection: undefined,
        credentialVersionIdByConnection: { [officialOpenAiModel.connectionId]: "credential-version:connection-openai:v2" },
        expectedCredentialId: "credential:connection-openai",
        expectedCredentialVersionId: "credential-version:connection-openai:v2",
        label: "credential version"
      }
    ])("pins the engine's current $label at admission without a new Search probe", async (authority) => {
      const { db } = admissionDb({
        answer: anthropic,
        credentialIdByConnection: authority.credentialIdByConnection,
        credentialVersionIdByConnection: authority.credentialVersionIdByConnection,
        options: [openAiOption()],
        technicalModels: [officialOpenAiSearchModel]
      });
      expect(expectSearch(await admit(db, anthropic)).role?.authority).toMatchObject({
        credentialId: authority.expectedCredentialId,
        credentialVersionId: authority.expectedCredentialVersionId,
        providerModelId: officialOpenAiSearchModel.id
      });
    });

    it("never searches through Perplexity Sonar, retired, even where a policy still names it, and replaces it with nothing", async () => {
      // Sonar's stored kind and protocol, as a row the 2026-11-26 upgrade had not archived yet.
      const sonar: OptionSpec = {
        displayName: "Perplexity Sonar", kind: "perplexity_search", optionId: "perplexity-tool-search",
        routes: [{ adapterKind: "provider_model_client", id: "route-sonar", protocol: "openrouter_perplexity_chat",
          providerModelId: openRouterModel.id, revisionId: "revision-sonar" }],
        sourceConnectionId: openRouterModel.connectionId
      };
      const { db } = admissionDb({
        answer: anthropic, options: [sonar, openAiOption()], policy: { engineOptionId: sonar.optionId },
        technicalModels: [openRouterModel, officialOpenAiSearchModel]
      });
      const plan = await admit(db, anthropic);
      expect(plan.searches).toEqual([]);
      expect(plan.searchUnavailable).toBe("search_engine_unavailable");
    });
  });
});
