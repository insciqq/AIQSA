import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { defaultProviderModels, defaultSearchStrategies } from "@/lib/domain/catalog";
import {
  providerConnectionTemplates,
  providerModelTemplateId,
  providerTemplateIds
} from "@/lib/domain/providerTemplates";
import {
  automaticRerankerRoutePresets,
  rerankerModelConfiguration
} from "@/lib/domain/rerankerModels";
import {
  builtInSearchDraft,
  normalizeSearchDraft,
  searchDraftHash
} from "@/lib/server/search/configuration";
import { searchValidationFingerprint } from "@/lib/server/search/probeBinding";
import { supportsPdfInputAdapter } from "@/lib/server/providers/pdfInputEvidence";

type CodeOwnedCatalogClient = Pick<
  Prisma.TransactionClient,
  | "providerConnection"
  | "providerModel"
  | "searchIntegrationRevision"
  | "searchOption"
  | "searchStrategy"
>;

type SynchronizeCodeOwnedCatalogOptions = Readonly<{
  createError?: (message: string) => Error;
  mode: "installation" | "local_seed";
  now?: Date;
}>;

export type CodeOwnedCatalogSynchronization = Readonly<{
  modelCount: number;
  providerModelIds: ReadonlyMap<string, string>;
  searchOptionCount: number;
}>;

const builtInSearchOptions = Object.freeze({
  "anthropic-web-search": Object.freeze({
    description: "Web search provided by Anthropic.",
    displayName: "Anthropic Search",
    id: "00000000-0000-4000-8000-000000001405",
    kind: "web_search",
    sourceConnectionId: providerTemplateIds.anthropicConnection,
    templateKey: "search:anthropic"
  }),
  "gemini-google-search": Object.freeze({
    description: "Google Search grounding for eligible Gemini models.",
    displayName: "Google Search",
    id: "00000000-0000-4000-8000-000000001403",
    kind: "gemini_google_search",
    sourceConnectionId: providerTemplateIds.geminiConnection,
    templateKey: "search:gemini-google"
  }),
  "openai-native-web-search": Object.freeze({
    description: "Web search provided by OpenAI.",
    displayName: "OpenAI Search",
    id: "00000000-0000-4000-8000-000000001402",
    kind: "web_search",
    sourceConnectionId: providerTemplateIds.openAiConnection,
    templateKey: "search:openai"
  }),
  "perplexity-tool-search": Object.freeze({
    description: "Web search provided by Perplexity through OpenRouter.",
    displayName: "Perplexity Search",
    id: "00000000-0000-4000-8000-000000001404",
    kind: "perplexity_search",
    sourceConnectionId: providerTemplateIds.openRouterConnection,
    templateKey: "search:perplexity"
  }),
  "search-disabled": Object.freeze({
    description: "Answer without web search.",
    displayName: "Off",
    id: "00000000-0000-4000-8000-000000001401",
    kind: "none",
    sourceConnectionId: null,
    templateKey: "search:none"
  })
});

const json = (value: unknown) => value as Prisma.InputJsonValue;

function fail(options: SynchronizeCodeOwnedCatalogOptions, message: string): never {
  throw options.createError?.(message) ?? new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function codeOwnedProviderModelDraftConfig(
  model: (typeof defaultProviderModels)[number]
) {
  const adapterKind = {
    anthropic: "anthropic_messages",
    fake: "fake",
    gemini: "gemini_interactions_native",
    openai: "openai_responses_native",
    openrouter: "openrouter_chat_completions"
  }[model.provider];
  if (!adapterKind) {
    throw new Error("provider_model_adapter_kind_missing");
  }
  const routeProvider = isRecord(model.defaultParams.provider)
    ? model.defaultParams.provider
    : {};
  const selectedProviders = Array.isArray(routeProvider.only)
    ? [...new Set(routeProvider.only.filter((value): value is string =>
        typeof value === "string" && Boolean(value.trim())
      ).map((value) => value.trim()))]
    : [];

  return {
    adapterKind,
    answerSelectable: true,
    capabilities: {
      ...model.capabilities,
      nativePdfInput: supportsPdfInputAdapter(adapterKind),
      contextWindow: model.contextWindow
    },
    defaultParams: model.defaultParams,
    modelClass: "answer" as const,
    ...(model.provider === "openrouter"
      ? {
          openRouterRouting: selectedProviders.length > 0
            ? { mode: "only_selected", providers: selectedProviders }
            : { mode: "automatic", providers: [] }
        }
      : {}),
    upstreamModelId: model.modelId
  };
}

async function synchronizeConnections(
  client: CodeOwnedCatalogClient,
  options: SynchronizeCodeOwnedCatalogOptions,
  now: Date
): Promise<Map<string, string>> {
  const localSeed = options.mode === "local_seed";
  const connectionIds = new Map<string, string>();

  for (const template of providerConnectionTemplates) {
    const active = localSeed && template.family === "fake";
    const row = await client.providerConnection.upsert({
      create: {
        activeConfig: active ? json(template.config) : undefined,
        activeVersion: active ? 1 : 0,
        activatedAt: active ? now : undefined,
        defaultCredentialId: null,
        displayName: template.displayName,
        draftConfig: json(template.config),
        draftVersion: 1,
        enabled: active,
        family: template.family,
        id: template.id,
        templateKey: template.templateKey,
        unassignedPolicy: "use_default"
      },
      update: localSeed
        ? {
            activeConfig: active ? json(template.config) : Prisma.DbNull,
            activeVersion: active ? 1 : 0,
            activatedAt: active ? now : null,
            defaultCredentialId: null,
            displayName: template.displayName,
            draftConfig: json(template.config),
            draftVersion: 1,
            enabled: active,
            family: template.family,
            unassignedPolicy: "use_default"
          }
        : template.family === "fake"
          ? {
              activeConfig: Prisma.DbNull,
              activeVersion: 0,
              activatedAt: null,
              enabled: false
            }
          : {},
      where: { templateKey: template.templateKey }
    });
    connectionIds.set(template.family, row.id);
  }

  return connectionIds;
}

async function synchronizeModels(
  client: CodeOwnedCatalogClient,
  options: SynchronizeCodeOwnedCatalogOptions,
  now: Date,
  connectionIds: ReadonlyMap<string, string>
): Promise<Map<string, string>> {
  const localSeed = options.mode === "local_seed";
  const models = localSeed
    ? defaultProviderModels
    : defaultProviderModels.filter((model) => model.provider === "fake");
  const modelIds = new Map<string, string>();

  if (models.length === 0) fail(options, "Fake provider template is missing.");

  for (const model of models) {
    const templateKey = `${model.provider}:${model.modelId}`;
    const id = providerModelTemplateId(templateKey);
    const connectionId = connectionIds.get(model.provider);
    if (!id || !connectionId) {
      fail(options, `Missing provider template identity: ${templateKey}.`);
    }
    const active = localSeed && model.provider === "fake";
    const draftConfig = codeOwnedProviderModelDraftConfig(model);
    const row = await client.providerModel.upsert({
      create: {
        activeConfig: active ? json(draftConfig) : undefined,
        activeVersion: active ? 1 : 0,
        activatedAt: active ? now : undefined,
        capabilities: json(model.capabilities),
        connectionId,
        defaultParams: json(model.defaultParams),
        displayName: model.displayName,
        draftConfig: json(draftConfig),
        draftVersion: 1,
        enabled: active,
        id,
        inputTokenPriceMicros: model.inputTokenPriceMicros,
        modelId: model.modelId,
        outputTokenPriceMicros: model.outputTokenPriceMicros,
        provider: model.provider,
        supportsNativeSearch: model.capabilities.nativeSearch,
        supportsPdf: model.capabilities.pdf,
        supportsReasoning: model.capabilities.reasoning,
        supportsVision: model.capabilities.vision,
        templateKey
      },
      update: localSeed
        ? {
            activeConfig: active ? json(draftConfig) : Prisma.DbNull,
            activeVersion: active ? 1 : 0,
            activatedAt: active ? now : null,
            capabilities: json(model.capabilities),
            connectionId,
            defaultParams: json(model.defaultParams),
            displayName: model.displayName,
            draftConfig: json(draftConfig),
            draftVersion: 1,
            enabled: active,
            inputTokenPriceMicros: model.inputTokenPriceMicros,
            modelId: model.modelId,
            outputTokenPriceMicros: model.outputTokenPriceMicros,
            provider: model.provider,
            supportsNativeSearch: model.capabilities.nativeSearch,
            supportsPdf: model.capabilities.pdf,
            supportsReasoning: model.capabilities.reasoning,
            supportsVision: model.capabilities.vision
          }
        : {
            activeConfig: Prisma.DbNull,
            activeVersion: 0,
            activatedAt: null,
            enabled: false
          },
      where: { templateKey }
    });
    modelIds.set(templateKey, row.id);
  }

  const openRouterConnectionId = connectionIds.get("openrouter");
  if (!openRouterConnectionId) {
    fail(options, "Missing OpenRouter connection template identity.");
  }
  for (const preset of automaticRerankerRoutePresets) {
    const templateKey = `openrouter:${preset.upstreamModelId}`;
    const id = providerModelTemplateId(templateKey);
    if (!id) fail(options, `Missing provider template identity: ${templateKey}.`);
    const draftConfig = rerankerModelConfiguration(preset);
    const existing = await client.providerModel.findUnique({
      where: { templateKey }
    });
    if (!existing) {
      await client.providerModel.create({
        data: {
          activeConfig: Prisma.DbNull,
          activeVersion: 0,
          activatedAt: null,
          capabilities: json(draftConfig.capabilities),
          connectionId: openRouterConnectionId,
          defaultParams: json(draftConfig.defaultParams),
          displayName: preset.displayName,
          draftConfig: json(draftConfig),
          draftVersion: 1,
          enabled: true,
          id,
          inputTokenPriceMicros: 0,
          modelClass: "reranker",
          modelId: preset.upstreamModelId,
          outputTokenPriceMicros: 0,
          provider: "openrouter",
          supportsNativeSearch: false,
          supportsPdf: false,
          supportsReasoning: false,
          supportsVision: false,
          templateKey
        }
      });
      modelIds.set(templateKey, id);
      continue;
    }
    if (
      existing.id !== id ||
      existing.connectionId !== openRouterConnectionId ||
      existing.provider !== "openrouter"
    ) {
      fail(options, `Conflicting provider template identity: ${templateKey}.`);
    }
    if (existing.activeConfig === null && sameJson(existing.draftConfig, draftConfig)) {
      await client.providerModel.update({
        data: {
          capabilities: json(draftConfig.capabilities),
          defaultParams: json(draftConfig.defaultParams),
          displayName: preset.displayName,
          enabled: true,
          modelClass: "reranker",
          modelId: preset.upstreamModelId,
          supportsNativeSearch: false,
          supportsPdf: false,
          supportsReasoning: false,
          supportsVision: false
        },
        where: { id }
      });
    }
    modelIds.set(templateKey, id);
  }

  return modelIds;
}

async function synchronizeSearch(
  client: CodeOwnedCatalogClient,
  options: SynchronizeCodeOwnedCatalogOptions,
  now: Date,
  providerModelIds: ReadonlyMap<string, string>
): Promise<number> {
  for (const [optionId, option] of Object.entries(builtInSearchOptions)) {
    await client.searchOption.upsert({
      create: {
        description: option.description,
        displayName: option.displayName,
        enabled: true,
        id: option.id,
        kind: option.kind,
        optionId,
        sourceConnectionId: option.sourceConnectionId,
        templateKey: option.templateKey
      },
      update: {
        description: option.description,
        displayName: option.displayName,
        kind: option.kind,
        sourceConnectionId: option.sourceConnectionId,
        templateKey: option.templateKey
      },
      where: { id: option.id }
    });
  }

  const logicalOptions = options.mode === "installation"
    ? defaultSearchStrategies.filter((candidate) => candidate.kind !== "perplexity_tool_search")
    : defaultSearchStrategies;
  const method = options.mode === "installation" ? "bootstrap" : "seed";

  for (const logicalOption of logicalOptions) {
    const searchOption = builtInSearchOptions[
      logicalOption.strategyId as keyof typeof builtInSearchOptions
    ];
    if (!searchOption) {
      fail(options, `Built-in Search option is missing for ${logicalOption.strategyId}.`);
    }
    const physicalRoutes = logicalOption.kind === "none"
      ? [{
          config: {},
          credentialMode: "answer_provider" as const,
          kind: "none" as const,
          physicalStrategyId: logicalOption.strategyId,
          providerModelId: undefined
        }]
      : logicalOption.routes;

    for (const route of physicalRoutes) {
      const providerModelId = route.credentialMode === "provider_model"
        ? providerModelIds.get(`openrouter:${route.providerModelId ?? ""}`) ?? null
        : null;
      if (route.credentialMode === "provider_model" && !providerModelId) {
        fail(options, `Missing Search deployment: ${route.physicalStrategyId}.`);
      }
      const draft = builtInSearchDraft({
        config: route.config,
        kind: route.kind,
        providerModelId
      });
      const draftHash = route.kind === "none"
        ? `code-owned:${route.physicalStrategyId}`
        : searchDraftHash(normalizeSearchDraft(draft));
      const stored = await client.searchStrategy.upsert({
        create: {
          adapterKind: String(draft.adapterKind),
          config: json(route.config),
          credentialMode: String(draft.credentialMode),
          description: logicalOption.description,
          displayName: logicalOption.displayName,
          draft: json(draft),
          draftTestEvidence: json({
            checkedAt: now.toISOString(),
            method: "configuration",
            normalizedSourceCount: 0,
            protocol: draft.protocol,
            status: "available"
          }),
          enabled: true,
          id: randomUUID(),
          kind: route.kind,
          modelId: route.providerModelId ?? null,
          provider: logicalOption.sourceConnectionId ?? "fake",
          providerModelId,
          searchOptionId: searchOption.id,
          strategyId: route.physicalStrategyId,
          testedDraftHash: draftHash
        },
        update: {
          config: json(route.config),
          description: logicalOption.description,
          displayName: logicalOption.displayName,
          kind: route.kind,
          modelId: route.providerModelId ?? null,
          provider: logicalOption.sourceConnectionId ?? "fake",
          providerModelId,
          searchOptionId: searchOption.id
        },
        where: { strategyId: route.physicalStrategyId }
      });
      if (!stored.activeRevisionId) {
        const validationEvidence = { method, status: "available" };
        const revision = await client.searchIntegrationRevision.create({
          data: {
            adapterKind: String(draft.adapterKind),
            configuration: json(draft),
            credentialMode: String(draft.credentialMode),
            draftHash,
            id: randomUUID(),
            providerModelId,
            revisionNumber: 1,
            searchStrategyId: stored.id,
            validationEvidence: json(validationEvidence),
            validationFingerprint: searchValidationFingerprint(validationEvidence)
          }
        });
        await client.searchStrategy.update({
          data: { activeRevisionId: revision.id, activatedAt: now },
          where: { id: stored.id }
        });
      }
    }
  }

  return logicalOptions.length;
}

export async function synchronizeCodeOwnedCatalog(
  client: CodeOwnedCatalogClient,
  options: SynchronizeCodeOwnedCatalogOptions
): Promise<CodeOwnedCatalogSynchronization> {
  const now = options.now ?? new Date();
  const connectionIds = await synchronizeConnections(client, options, now);
  const providerModelIds = await synchronizeModels(client, options, now, connectionIds);
  const searchOptionCount = await synchronizeSearch(
    client,
    options,
    now,
    providerModelIds
  );

  return {
    modelCount: providerModelIds.size,
    providerModelIds,
    searchOptionCount
  };
}
