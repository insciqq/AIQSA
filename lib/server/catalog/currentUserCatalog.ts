import type {
  CurrentUserCatalogWire,
  CatalogWireModel
} from "../../contracts/catalog";
import type { ProviderModelCatalogEntry, SearchStrategyCatalogEntry } from "../../domain/catalog";
import {
  buildCatalogModel,
  reconcileSearchPlanSelection,
  toCatalogSearchStrategy
} from "../../domain/catalogMatrix";
import {
  canAccessModel,
  canAccessSearchStrategy,
  type ResolvedEntitlements
} from "../auth/entitlements";
import { decodeSearchPlan, type SearchPlan } from "../../domain/search";
import {
  decodeChatDefaultMcpMode,
  INSTALLATION_CHAT_DEFAULTS,
  type ChatDefaults
} from "../../contracts/chatDefaults";
import { decodeKnowledgePlan } from "../../contracts/knowledge";

export type CatalogSettingsRecord = {
  defaultControlValues: unknown;
  /** Persisted knowledge selection for new chats; absent or invalid means none. */
  defaultKnowledgePlan?: unknown;
  defaultMcpMode?: string | null;
  defaultProviderModelId: string | null;
  defaultSearchPlan: unknown;
  sendWithEnter?: boolean | null;
  showCitations: boolean;
  showReasoningBlocks: boolean;
};

/** Personal chat defaults from the settings row; unreadable values fall back to the installation defaults. */
export function resolveChatDefaults(
  settings: Pick<CatalogSettingsRecord, "defaultKnowledgePlan" | "defaultMcpMode" | "sendWithEnter">
): ChatDefaults {
  const decodedPlan = settings.defaultKnowledgePlan === null || settings.defaultKnowledgePlan === undefined
    ? null
    : decodeKnowledgePlan(settings.defaultKnowledgePlan);
  const knowledgePlan = decodedPlan?.ok && decodedPlan.plan.mode !== "none" && decodedPlan.plan.mode !== "inherited"
    ? decodedPlan.plan
    : null;
  return {
    knowledgePlan,
    mcpMode: decodeChatDefaultMcpMode(settings.defaultMcpMode) ?? INSTALLATION_CHAT_DEFAULTS.mcpMode,
    sendWithEnter: settings.sendWithEnter ?? INSTALLATION_CHAT_DEFAULTS.sendWithEnter
  };
}

export type CatalogData = {
  entitlements: ResolvedEntitlements;
  modelPolicy?: { defaultProviderModelId: string | null } | null;
  models: ProviderModelCatalogEntry[];
  searchPolicy?: { defaultPlan: unknown } | null;
  searchStrategies: SearchStrategyCatalogEntry[];
  settings: CatalogSettingsRecord;
};

export type ResolvedSearchPreference = {
  organizationPlan: SearchPlan;
  preferredPlan: SearchPlan;
  source: "organization" | "personal";
};

export type CatalogSelectionData = Pick<
  CatalogData,
  "entitlements" | "modelPolicy" | "models" | "searchStrategies" | "settings"
>;

export type ModelDefaultSelection = {
  modelId: string;
  provider: string;
};

export type CurrentUserCatalogSelection = {
  defaultModel: CatalogWireModel | null;
  entitledStrategies: SearchStrategyCatalogEntry[];
  hasPersonalModelDefault: boolean;
  modelPreferenceSource: "none" | "organization" | "personal";
  models: CatalogWireModel[];
  organizationModelDefault: ModelDefaultSelection | null;
  personalModelDefault: ModelDefaultSelection | null;
};

export function resolveEffectiveModelDefaultId(input: Readonly<{
  organizationModelId: string | null;
  personalModelId: string | null;
}>): string | null {
  return input.personalModelId !== null
    ? input.personalModelId
    : input.organizationModelId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveCurrentUserCatalogSelection(
  input: CatalogSelectionData
): CurrentUserCatalogSelection {
  const entitledStrategies = input.searchStrategies.filter((strategy) =>
    canAccessSearchStrategy(input.entitlements, strategy.strategyId)
  );
  const models = input.models
    .filter((model) => canAccessModel(input.entitlements, model.provider, model.modelId))
    .map((model) => buildCatalogModel(model, entitledStrategies));
  const personalModelId = input.settings.defaultProviderModelId;
  const personalModel = personalModelId
    ? models.find((model) => model.modelId === personalModelId) ?? null
    : null;
  const organizationModelId = input.modelPolicy?.defaultProviderModelId ?? null;
  const organizationModel = organizationModelId
    ? models.find((model) => model.modelId === organizationModelId) ?? null
    : null;
  const hasPersonalModelDefault = personalModelId !== null;
  const effectiveModelId = resolveEffectiveModelDefaultId({
    organizationModelId,
    personalModelId
  });
  const defaultModel = effectiveModelId
    ? models.find((model) => model.modelId === effectiveModelId) ?? null
    : null;
  const selection = (model: CatalogWireModel | null): ModelDefaultSelection | null =>
    model ? { modelId: model.modelId, provider: model.provider } : null;

  return {
    defaultModel,
    entitledStrategies,
    hasPersonalModelDefault,
    modelPreferenceSource: hasPersonalModelDefault
      ? "personal"
      : organizationModel
        ? "organization"
        : "none",
    models,
    organizationModelDefault: selection(organizationModel),
    personalModelDefault: selection(personalModel)
  };
}

export function resolveSearchPreference(input: Readonly<{
  organizationPlan: unknown;
  settings: Pick<CatalogSettingsRecord, "defaultSearchPlan">;
  strategies: SearchStrategyCatalogEntry[];
}>): ResolvedSearchPreference {
  const decodedOrganization = decodeSearchPlan(input.organizationPlan);
  const organizationPlan = reconcileSearchPlanSelection(
    decodedOrganization.ok ? decodedOrganization.plan.optionIds : [],
    decodedOrganization.ok ? decodedOrganization.plan.mode : "all_selected",
    input.strategies
  );
  const personal = input.settings.defaultSearchPlan !== null;
  const decodedPreferred = personal
    ? decodeSearchPlan(input.settings.defaultSearchPlan)
    : { ok: true as const, plan: organizationPlan };
  return {
    organizationPlan,
    preferredPlan: reconcileSearchPlanSelection(
      decodedPreferred.ok ? decodedPreferred.plan.optionIds : [],
      decodedPreferred.ok ? decodedPreferred.plan.mode : "all_selected",
      input.strategies
    ),
    source: personal ? "personal" : "organization"
  };
}

export function buildCurrentUserCatalog(input: CatalogData): CurrentUserCatalogWire {
  const {
    defaultModel,
    entitledStrategies,
    hasPersonalModelDefault,
    modelPreferenceSource,
    models,
    organizationModelDefault,
    personalModelDefault
  } = resolveCurrentUserCatalogSelection(input);
  const providers = Array.from(new Set(models.map((model) => model.provider))).map((provider) => {
    const providerModels = models.filter((model) => model.provider === provider);
    const source = input.models.find((model) => model.provider === provider);

    return {
      family: source?.providerFamily ?? "unknown",
      id: provider,
      models: providerModels.map((model) => model.modelId),
      name: source?.providerDisplayName ?? provider
    };
  });
  const searchPreference = resolveSearchPreference({
    organizationPlan: input.searchPolicy?.defaultPlan,
    settings: input.settings,
    strategies: entitledStrategies
  });

  return {
    defaults: {
      controlValues: isRecord(input.settings.defaultControlValues)
        ? input.settings.defaultControlValues
        : {},
      modelId: defaultModel?.modelId ?? "",
      hasPersonalModelDefault,
      modelPreferenceSource,
      organizationModelDefault,
      personalModelDefault,
      provider: defaultModel?.provider ?? "",
      organizationSearchPlan: searchPreference.organizationPlan,
      searchPlan: searchPreference.preferredPlan,
      searchPreferenceSource: searchPreference.source,
      ...resolveChatDefaults(input.settings),
      showCitations: input.settings.showCitations,
      showReasoningBlocks: input.settings.showReasoningBlocks
    },
    models,
    providers,
    searchStrategies: entitledStrategies.map(toCatalogSearchStrategy)
  };
}
