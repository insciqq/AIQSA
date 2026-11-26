import { DEFAULT_ANSWER_SOUND, type AnswerSoundPreferences } from "../../contracts/answerSound";
import type {
  CurrentUserCatalogWire,
  CatalogWireModel,
  CatalogWireProvider
} from "../../contracts/catalog";
import { catalogConnectionLabels } from "../../contracts/providerConnectionLabels";
import type { ProviderModelCatalogEntry, SearchStrategyCatalogEntry } from "../../domain/catalog";
import {
  buildCatalogModel,
  toCatalogSearchStrategy,
  webSearchCatalogEntry,
  type CatalogSearchAvailability
} from "../../domain/catalogMatrix";
import {
  canAccessModel,
  canAccessSearchStrategy,
  type ResolvedEntitlements
} from "../auth/entitlements";
import {
  decodeSearchPlan,
  hostedSearchProtocolUsable,
  resolveSearchEngine,
  SEARCH_DISABLED_STRATEGY_ID,
  searchPlanEnabled,
  searchSettingPlan,
  type SearchPlan,
  type SearchUnavailableReason
} from "../../domain/search";
import {
  decodeChatDefaultMcpMode,
  INSTALLATION_CHAT_DEFAULTS,
  type ChatDefaultAssistant,
  type ChatDefaults
} from "../../contracts/chatDefaults";

export type CatalogSettingsRecord = Partial<AnswerSoundPreferences> & {
  browserNotificationsEnabled?: boolean;
  /** Saved personal default Assistant, before any availability check. */
  defaultAssistantId?: string | null;
  /** Whether the saved default Assistant is available to the user now; absent means not checked. */
  defaultAssistantAvailable?: boolean;
  defaultControlValues: unknown;
  defaultMcpMode?: string | null;
  defaultSkillsMode?: string | null;
  defaultWorkspaceEnabled?: boolean;
  defaultProviderModelId: string | null;
  defaultSearchPlan: unknown;
  sendWithEnter?: boolean | null;
  showCitations: boolean;
  showReasoningBlocks: boolean;
};

/** Personal chat defaults from the settings row; unreadable values fall back to the installation defaults. */
export function resolveChatDefaults(
  settings: Pick<CatalogSettingsRecord, "defaultMcpMode" | "defaultSkillsMode" | "sendWithEnter">
): ChatDefaults {
  return {
    mcpMode: decodeChatDefaultMcpMode(settings.defaultMcpMode) ?? INSTALLATION_CHAT_DEFAULTS.mcpMode,
    skillsMode: settings.defaultSkillsMode === "off" ? "off" : "auto",
    sendWithEnter: settings.sendWithEnter ?? INSTALLATION_CHAT_DEFAULTS.sendWithEnter
  };
}

/**
 * Names the saved default only while it is available to the user; otherwise
 * reports it as unavailable without naming it, and never clears it. An
 * unchecked default fails closed.
 */
export function catalogDefaultAssistant(
  settings: Pick<CatalogSettingsRecord, "defaultAssistantAvailable" | "defaultAssistantId">
): ChatDefaultAssistant {
  return settings.defaultAssistantId && settings.defaultAssistantAvailable === true
    ? { assistantId: settings.defaultAssistantId, assistantUnavailable: false }
    : { assistantId: null, assistantUnavailable: Boolean(settings.defaultAssistantId) };
}

/**
 * The installation's Search for one user, as the loader resolved it (`lib/server/search/engineResolution.ts`): the
 * engine with whether the user's credentials reach its technical model, and why the user cannot search with it.
 */
export type CatalogSearchData = CatalogSearchAvailability & Readonly<{
  engine: Readonly<{ displayName: string; protocol: string; usable: boolean }> | null;
  reason: SearchUnavailableReason | null;
}>;

export type CatalogData = {
  entitlements: ResolvedEntitlements;
  modelPolicy?: { defaultProviderModelId: string | null; reasoningEffort?: string | null } | null;
  models: ProviderModelCatalogEntry[];
  /** The resolved Search; a reader that left it out derives it from `searchStrategies` (`catalogSearchData`). */
  search?: CatalogSearchData;
  searchPolicy?: Readonly<{
    backupOptionId?: string | null;
    defaultPlan?: unknown;
    engineOptionId?: string | null;
    inAnswerSearch?: boolean;
  }> | null;
  /** The sources the user's grants and credentials reach, as earlier releases exposed them. */
  searchStrategies: SearchStrategyCatalogEntry[];
  settings: CatalogSettingsRecord;
};

export type ResolvedSearchPreference = {
  /** The user's Search switch: on unless they turned it off. */
  enabled: boolean;
  organizationPlan: SearchPlan;
  preferredPlan: SearchPlan;
  source: "organization" | "personal";
};

export type CatalogSelectionData = Pick<
  CatalogData,
  "entitlements" | "modelPolicy" | "models" | "search" | "searchPolicy" | "searchStrategies" | "settings"
>;

export type ModelDefaultSelection = {
  modelId: string;
  provider: string;
};

export type CurrentUserCatalogSelection = {
  defaultModel: CatalogWireModel | null;
  /** The one virtual Search source (`webSearchCatalogEntry`) while some model of the user can search, else none. */
  entitledStrategies: SearchStrategyCatalogEntry[];
  search: CatalogSearchData;
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

/** Whether the user may search at all: Full access or a grant of any Search source (`hasSearchEntitlement`). */
export function searchEntitled(entitlements: ResolvedEntitlements): boolean {
  return entitlements.fullAccess === true ||
    [...entitlements.searchStrategies].some((strategyId) => strategyId !== SEARCH_DISABLED_STRATEGY_ID);
}

/**
 * The user's Search: the loader's resolution, or, for a reader that only listed the sources the user's grants and
 * credentials reach, the same resolution over those sources, each counted ready and reachable.
 */
export function catalogSearchData(input: Pick<CatalogData, "entitlements" | "search" | "searchPolicy" | "searchStrategies">): CatalogSearchData {
  if (input.search) return input.search;
  const sources = input.searchStrategies.filter((strategy) => strategy.kind !== "none" &&
    canAccessSearchStrategy(input.entitlements, strategy.strategyId));
  const entitled = searchEntitled(input.entitlements) || sources.length > 0;
  const candidates = sources.flatMap((strategy) => {
    const client = strategy.routes.find((route) => route.adapterKind === "provider_model_client");
    if (!client) return [];
    const engine = isRecord(client.config.openRouterWebSearch) && typeof client.config.openRouterWebSearch.engine === "string"
      ? client.config.openRouterWebSearch.engine
      : null;
    return [{ displayName: strategy.displayName, openRouterEngine: engine, optionId: strategy.strategyId,
      protocol: client.protocol, ready: true }];
  });
  const resolution = resolveSearchEngine({
    backupOptionId: input.searchPolicy?.backupOptionId ?? null,
    candidates,
    engineOptionId: input.searchPolicy?.engineOptionId ?? null
  });
  return {
    engine: resolution.engine
      ? { displayName: resolution.engine.displayName, protocol: resolution.engine.protocol, usable: true }
      : null,
    entitled,
    inAnswerConnectionIds: input.searchPolicy?.inAnswerSearch === false ? [] : [...new Set(sources.flatMap((strategy) =>
      strategy.kind === "web_search" && strategy.sourceConnectionId && strategy.routes.some((route) =>
        route.adapterKind === "answer_provider_hosted" && hostedSearchProtocolUsable(route.protocol))
        ? [strategy.sourceConnectionId] : []))],
    reason: !entitled ? "search_not_granted" : resolution.reason
  };
}

export function resolveCurrentUserCatalogSelection(
  input: CatalogSelectionData
): CurrentUserCatalogSelection {
  const search = catalogSearchData(input);
  const models = input.models
    .filter((model) => canAccessModel(input.entitlements, model.provider, model.modelId))
    .map((model) => buildCatalogModel(model, search));
  // Earlier clients and the run-row rules read Search as sources: the one virtual source while some model can search.
  const entitledStrategies = models.some((model) => model.webSearch) ? [webSearchCatalogEntry()] : [];
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
    personalModelDefault: selection(personalModel),
    search
  };
}

/**
 * The user's Search switch (operator decisions 2026-11-26: users only switch Search on or off). Search is on for
 * everyone (2026-10-24) until the user turns it off in Chat defaults, stored as a plan without sources; a stored plan
 * that names sources, the personal choice of an earlier release, or one that no longer reads, keeps it on. The
 * organization's side is always on: the installation's engine is the administrator's, never a user's choice.
 */
export function resolveSearchPreference(input: Readonly<{
  settings: Pick<CatalogSettingsRecord, "defaultSearchPlan">;
}>): ResolvedSearchPreference {
  const stored = input.settings.defaultSearchPlan ?? null;
  const decoded = stored === null ? null : decodeSearchPlan(stored);
  const enabled = !decoded?.ok || searchPlanEnabled(decoded.plan);
  return {
    enabled,
    organizationPlan: searchSettingPlan(true),
    preferredPlan: searchSettingPlan(enabled),
    source: stored === null ? "organization" : "personal"
  };
}

export function resolveCurrentUserControlValues(
  input: CatalogSelectionData,
  { defaultModel, modelPreferenceSource }: CurrentUserCatalogSelection
): Record<string, unknown> {
  const effort = input.modelPolicy?.reasoningEffort;
  const reasoning = defaultModel?.parameterControls.reasoningEffort;
  const controlValues = isRecord(input.settings.defaultControlValues)
    ? { ...input.settings.defaultControlValues }
    : {};
  if (modelPreferenceSource === "organization" && defaultModel && effort &&
    reasoning?.supported && reasoning.options.includes(effort)) {
    const key = `${defaultModel.provider}:${defaultModel.modelId}`;
    const personal = controlValues[key];
    controlValues[key] = {
      reasoningEffort: effort,
      ...(isRecord(personal) ? personal : {})
    };
  }
  return controlValues;
}

/** The provider connections of the user's entitled models, as `/api/me/catalog` lists them. */
export function currentUserCatalogProviders(
  sources: readonly ProviderModelCatalogEntry[],
  models: readonly CatalogWireModel[]
): CatalogWireProvider[] {
  return Array.from(new Set(models.map((model) => model.provider))).map((provider) => {
    const providerModels = models.filter((model) => model.provider === provider);
    const source = sources.find((model) => model.provider === provider);

    return {
      family: source?.providerFamily ?? "unknown",
      id: provider,
      models: providerModels.map((model) => model.modelId),
      name: source?.providerDisplayName ?? provider
    };
  });
}

/**
 * Each entitled model's connection label by connection id, exactly as the
 * chat's model picker shows it (`catalogConnectionLabels` over the providers
 * `/api/me/catalog` sends), for server surfaces that name a model's
 * connection to the user or the agent.
 */
export function currentUserConnectionLabels(
  sources: readonly ProviderModelCatalogEntry[],
  models: readonly CatalogWireModel[]
): ReadonlyMap<string, string> {
  return catalogConnectionLabels(currentUserCatalogProviders(sources, models));
}

export function buildCurrentUserCatalog(input: CatalogData): CurrentUserCatalogWire {
  const selection = resolveCurrentUserCatalogSelection(input);
  const {
    defaultModel,
    entitledStrategies,
    hasPersonalModelDefault,
    modelPreferenceSource,
    models,
    organizationModelDefault,
    personalModelDefault,
    search
  } = selection;
  const providers = currentUserCatalogProviders(input.models, models);
  const searchPreference = resolveSearchPreference({ settings: input.settings });
  return {
    defaults: {
      answerSoundEnabled: input.settings.answerSoundEnabled ?? DEFAULT_ANSWER_SOUND.answerSoundEnabled,
      answerSoundId: input.settings.answerSoundId ?? DEFAULT_ANSWER_SOUND.answerSoundId,
      browserNotificationsEnabled: input.settings.browserNotificationsEnabled ?? true,
      controlValues: resolveCurrentUserControlValues(input, selection),
      modelId: defaultModel?.modelId ?? "",
      hasPersonalModelDefault,
      modelPreferenceSource,
      organizationModelDefault,
      personalModelDefault,
      provider: defaultModel?.provider ?? "",
      organizationSearchPlan: searchPreference.organizationPlan,
      searchPlan: searchPreference.preferredPlan,
      searchEnabled: searchPreference.enabled,
      searchPreferenceSource: searchPreference.source,
      ...resolveChatDefaults(input.settings),
      ...catalogDefaultAssistant(input.settings),
      workspaceEnabled: input.settings.defaultWorkspaceEnabled ?? true,
      showCitations: input.settings.showCitations,
      showReasoningBlocks: input.settings.showReasoningBlocks
    },
    models,
    providers,
    search: {
      // The engine's name only while it serves this user; the reason otherwise, never a substitute.
      engine: search.engine?.usable && search.reason === null ? { displayName: search.engine.displayName } : null,
      reason: search.reason
    },
    searchStrategies: entitledStrategies.map(toCatalogSearchStrategy)
  };
}
