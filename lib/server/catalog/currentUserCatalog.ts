import type {
  CurrentUserCatalogWire,
  CatalogWireModel,
  PromptPreset
} from "../../contracts/catalog";
import {
  RUN_PROFILE_IDS,
  type CatalogRunProfile,
  type RunProfileId
} from "../../contracts/runProfiles";
import type { ProviderModelCatalogEntry, SearchStrategyCatalogEntry } from "../../domain/catalog";
import {
  readableRunProfileControlValue,
  runProfileMetadata
} from "../../domain/runProfiles";
import {
  buildCatalogModel,
  reconcileSearchPlanSelection,
  resolveSearchStrategyId,
  toCatalogSearchStrategy
} from "../../domain/catalogMatrix";
import {
  canAccessModel,
  canAccessSearchStrategy,
  type ResolvedEntitlements
} from "../auth/entitlements";
import { decodeSearchPlan, type SearchPlan } from "../../domain/search";

export type CatalogSettingsRecord = {
  defaultControlValues: unknown;
  defaultModelId: string;
  defaultProviderConnectionId?: string | null;
  defaultProviderModelId?: string | null;
  defaultPromptPresetId: string | null;
  defaultProvider: string;
  defaultSearchStrategyId: string;
  defaultSearchPlan?: unknown;
  showCitations: boolean;
  showReasoningBlocks: boolean;
  showToolActivity: boolean;
};

export type CatalogData = {
  entitlements: ResolvedEntitlements;
  models: ProviderModelCatalogEntry[];
  promptPresets: PromptPreset[];
  runProfiles: CatalogRunProfileRecord[];
  searchPolicy?: { defaultPlan: unknown } | null;
  searchStrategies: SearchStrategyCatalogEntry[];
  settings: CatalogSettingsRecord;
};

export type ResolvedSearchPreference = {
  organizationPlan: SearchPlan;
  preferredPlan: SearchPlan;
  source: "organization" | "personal";
};

export type CatalogRunProfileRecord = {
  description: string;
  enabled: boolean;
  id: RunProfileId;
  providerModelId: string | null;
  reasoningEffort: string;
  reasoningMode: string;
};

export type CatalogSelectionData = Pick<
  CatalogData,
  "entitlements" | "models" | "searchStrategies" | "settings"
>;

export type CurrentUserCatalogSelection = {
  defaultModel: CatalogWireModel | null;
  entitledStrategies: SearchStrategyCatalogEntry[];
  models: CatalogWireModel[];
};

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
  const defaultModel =
    models.find(
      (model) =>
        model.modelId === input.settings.defaultProviderModelId &&
        (!input.settings.defaultProviderConnectionId ||
          model.provider === input.settings.defaultProviderConnectionId)
    ) ?? null;

  return {
    defaultModel,
    entitledStrategies,
    models
  };
}

export function resolveSearchPreference(input: Readonly<{
  organizationPlan: unknown;
  settings: Pick<CatalogSettingsRecord, "defaultSearchPlan" | "defaultSearchStrategyId">;
  strategies: SearchStrategyCatalogEntry[];
}>): ResolvedSearchPreference {
  const decodedOrganization = decodeSearchPlan(input.organizationPlan);
  const organizationPlan = reconcileSearchPlanSelection(
    decodedOrganization.ok ? decodedOrganization.plan.optionIds : [],
    decodedOrganization.ok ? decodedOrganization.plan.mode : "all_selected",
    input.strategies
  );
  // Undefined is retained as the legacy pre-column shape. Only SQL NULL has
  // the durable ADR 0046 meaning "inherit the installation recommendation".
  const personal = input.settings.defaultSearchPlan !== null;
  const decodedPreferred = personal
    ? decodeSearchPlan(
        input.settings.defaultSearchPlan,
        input.settings.defaultSearchStrategyId
      )
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
  const { defaultModel, entitledStrategies, models } = resolveCurrentUserCatalogSelection(input);
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
  const runProfiles = RUN_PROFILE_IDS.flatMap((id): CatalogRunProfile[] => {
    const profile = input.runProfiles.find((candidate) => candidate.id === id);
    if (!profile?.enabled) return [];
    const metadata = runProfileMetadata(id);
    const base = {
      description: profile.description,
      id,
      label: metadata.label
    };
    const model = profile.providerModelId
      ? models.find((candidate) => candidate.modelId === profile.providerModelId)
      : null;
    if (!model) {
      return [{ ...base, available: false, unavailableReason: "model_unavailable" }];
    }
    const effortValid = model.parameterControls.reasoningEffort.options.includes(
      profile.reasoningEffort
    );
    const modeOptions = model.parameterControls.reasoningMode?.options ?? ["standard"];
    if (!effortValid || !modeOptions.includes(profile.reasoningMode)) {
      return [{ ...base, available: false, unavailableReason: "configuration_invalid" }];
    }
    return [{
      ...base,
      available: true,
      configurationLabel: [
        model.displayName,
        readableRunProfileControlValue(profile.reasoningMode),
        readableRunProfileControlValue(profile.reasoningEffort)
      ].join(" · "),
      modelId: model.modelId,
      provider: model.provider,
      reasoningEffort: profile.reasoningEffort,
      reasoningMode: profile.reasoningMode
    }];
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
      promptPresetId: input.settings.defaultPromptPresetId,
      provider: defaultModel?.provider ?? "",
      searchStrategyId: resolveSearchStrategyId(
        defaultModel,
        input.settings.defaultSearchStrategyId
      ),
      organizationSearchPlan: searchPreference.organizationPlan,
      searchPlan: searchPreference.preferredPlan,
      searchPreferenceSource: searchPreference.source,
      showCitations: input.settings.showCitations,
      showReasoningBlocks: input.settings.showReasoningBlocks,
      showToolActivity: input.settings.showToolActivity
    },
    models,
    promptPresets: input.promptPresets,
    providers,
    runProfiles,
    searchStrategies: entitledStrategies.map(toCatalogSearchStrategy)
  };
}
