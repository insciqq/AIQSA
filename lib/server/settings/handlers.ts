import type { CatalogWireModel } from "../../contracts/catalog";
import type { UserSettingsWire } from "../../contracts/settings";
import type { RequestAuthResolver } from "../auth/requestAuth";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../http/requestBody";
import { decodeSearchPlan, legacySearchStrategyFromPlan, type SearchPlan } from "../../domain/search";
import { isSearchCombinationCompatible } from "../../domain/catalogMatrix";
import {
  resolveCurrentUserCatalogSelection,
  resolveSearchPreference,
  type CatalogSelectionData,
  type CatalogSettingsRecord
} from "../catalog/currentUserCatalog";

export type UserSettingsRecord = CatalogSettingsRecord;

export type SettingsHandlerData = CatalogSelectionData & {
  searchPolicy?: { defaultPlan: unknown } | null;
};

export type UserSettingsUpdate = Partial<{
  defaultControlValues: Record<string, unknown>;
  defaultProviderModelId: string | null;
  defaultSearchStrategyId: string;
  defaultSearchPlan: SearchPlan | null;
  showCitations: boolean;
  showReasoningBlocks: boolean;
  showToolActivity: boolean;
}>;

export type SettingsValidationModel = Pick<
  CatalogWireModel,
  "modelId" | "provider" | "searchStrategyIds"
>;

export type UserSettingsUpdateResult =
  | {
      kind: "invalid";
      error: "default_model_unavailable" | "default_search_unavailable";
    }
  | {
      kind: "not_found";
    }
  | {
      kind: "updated";
      settings: UserSettingsRecord;
    };

export type SettingsHandlerDeps = {
  loadSettingsData(userId: string): Promise<SettingsHandlerData | null>;
  resolveAuth: RequestAuthResolver;
  updateSettings(
    userId: string,
    update: UserSettingsUpdate,
    validationModels: SettingsValidationModel[]
  ): Promise<UserSettingsUpdateResult>;
};

type SettingsDraftValue = boolean | string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(
  request: Request
): Promise<readonly [Record<string, unknown> | null, Response | null]> {
  const value = await readJsonBodyOrNull(request, "json");
  return [isRecord(value) ? value : null, requestBodyErrorResponse(value)];
}

function modelKey(model: Pick<CatalogWireModel, "modelId" | "provider">): string {
  return `${model.provider}:${model.modelId}`;
}

function numberFromDraft(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sanitizeControlDraft(
  input: Record<string, unknown>,
  model: CatalogWireModel
): Record<string, SettingsDraftValue> {
  const controls = model.parameterControls;
  const next: Record<string, SettingsDraftValue> = {};

  if (typeof input.backgroundMode === "boolean" && controls.background.supported) {
    next.backgroundMode = input.backgroundMode;
  }

  const maxOutputTokens = numberFromDraft(input.maxOutputTokens);
  if (maxOutputTokens !== null) {
    next.maxOutputTokens = String(
      Math.round(clamp(maxOutputTokens, 1, controls.maxOutputTokens.maxValue))
    );
  }

  const temperature = numberFromDraft(input.temperature);
  if (temperature !== null && controls.temperature.supported) {
    next.temperature = String(clamp(temperature, controls.temperature.minValue, controls.temperature.maxValue));
  }

  if (
    typeof input.reasoningEffort === "string" &&
    controls.reasoningEffort.options.includes(input.reasoningEffort)
  ) {
    next.reasoningEffort = input.reasoningEffort;
  }

  if (
    typeof input.reasoningMode === "string" &&
    controls.reasoningMode?.supported === true &&
    controls.reasoningMode.options.includes(input.reasoningMode)
  ) {
    next.reasoningMode = input.reasoningMode;
  }

  if (typeof input.streamMode === "boolean" && controls.stream.supported) {
    next.streamMode = input.streamMode;
  }

  return next;
}

function sanitizeControlValues(input: unknown, models: CatalogWireModel[]): Record<string, unknown> {
  if (!isRecord(input)) {
    return {};
  }

  const modelsByKey = new Map(models.map((model) => [modelKey(model), model]));
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    const model = modelsByKey.get(key);
    if (!model || !isRecord(value)) {
      continue;
    }

    const draft = sanitizeControlDraft(value, model);
    if (Object.keys(draft).length > 0) {
      output[key] = draft;
    }
  }

  return output;
}

function buildSettingsUpdate(
  body: Record<string, unknown> | null,
  data: SettingsHandlerData
): { error?: string; update?: UserSettingsUpdate; validationModels?: SettingsValidationModel[] } {
  if (!body) {
    return { error: "settings_update_required" };
  }

  const { models } = resolveCurrentUserCatalogSelection(data);
  const update: UserSettingsUpdate = {};

  if ("defaultProviderModelId" in body) {
    if (body.defaultProviderModelId !== null || "defaultProvider" in body ||
      "defaultModelId" in body) {
      return { error: "default_model_required" };
    }
    update.defaultProviderModelId = null;
  }

  if ("defaultProvider" in body || "defaultModelId" in body) {
    if (typeof body.defaultProvider !== "string" || typeof body.defaultModelId !== "string") {
      return { error: "default_model_required" };
    }

    const provider = body.defaultProvider.trim();
    const modelId = body.defaultModelId.trim();
    const model = models.find((candidate) => candidate.provider === provider && candidate.modelId === modelId);
    if (!model) {
      return { error: "default_model_unavailable" };
    }

    update.defaultProviderModelId = model.modelId;
  }

  if ("defaultSearchStrategyId" in body) {
    if (typeof body.defaultSearchStrategyId !== "string") {
      return { error: "default_search_unavailable" };
    }

    const strategyId = body.defaultSearchStrategyId.trim();
    if (strategyId !== "search-disabled" &&
      !data.searchStrategies.some((strategy) => strategy.strategyId === strategyId)) {
      return { error: "default_search_unavailable" };
    }

    update.defaultSearchStrategyId = strategyId;
    if (!("defaultSearchPlan" in body)) {
      update.defaultSearchPlan = {
        mode: "all_selected",
        optionIds: strategyId === "search-disabled" ? [] : [strategyId]
      };
    }
  }

  if ("defaultSearchPlan" in body) {
    if (body.defaultSearchPlan === null) {
      update.defaultSearchPlan = null;
    } else {
      const decoded = decodeSearchPlan(body.defaultSearchPlan);
      if (!decoded.ok || decoded.plan.optionIds.some((strategyId) =>
        !data.searchStrategies.some((strategy) => strategy.strategyId === strategyId)) ||
        !isSearchCombinationCompatible(
          decoded.plan.optionIds,
          data.searchStrategies,
          decoded.plan.mode
        )) {
        return { error: "default_search_unavailable" };
      }
      update.defaultSearchPlan = decoded.plan;
      update.defaultSearchStrategyId = legacySearchStrategyFromPlan(decoded.plan);
    }
  }

  if ("showCitations" in body) {
    if (typeof body.showCitations !== "boolean") {
      return { error: "show_citations_boolean_required" };
    }

    update.showCitations = body.showCitations;
  }

  if ("showReasoningBlocks" in body) {
    if (typeof body.showReasoningBlocks !== "boolean") {
      return { error: "show_reasoning_blocks_boolean_required" };
    }

    update.showReasoningBlocks = body.showReasoningBlocks;
  }

  if ("showToolActivity" in body) {
    if (typeof body.showToolActivity !== "boolean") {
      return { error: "show_tool_activity_boolean_required" };
    }

    update.showToolActivity = body.showToolActivity;
  }

  if ("defaultControlValues" in body) {
    update.defaultControlValues = sanitizeControlValues(body.defaultControlValues, models);
  }

  return Object.keys(update).length > 0
    ? { update, validationModels: models }
    : { error: "settings_update_required" };
}

function serializeSettings(
  settings: UserSettingsRecord,
  data: SettingsHandlerData
): UserSettingsWire {
  const selection = resolveCurrentUserCatalogSelection({ ...data, settings });
  const searchPreference = resolveSearchPreference({
    organizationPlan: data.searchPolicy?.defaultPlan,
    settings,
    strategies: selection.entitledStrategies
  });
  return {
    defaultControlValues: isRecord(settings.defaultControlValues) ? settings.defaultControlValues : {},
    defaultModelId: selection.defaultModel?.modelId ?? "",
    defaultProvider: selection.defaultModel?.provider ?? "",
    hasPersonalModelDefault: selection.hasPersonalModelDefault,
    modelPreferenceSource: selection.modelPreferenceSource,
    organizationModelDefault: selection.organizationModelDefault,
    personalModelDefault: selection.personalModelDefault,
    defaultSearchStrategyId: settings.defaultSearchStrategyId,
    defaultSearchPlan: searchPreference.preferredPlan,
    organizationSearchPlan: searchPreference.organizationPlan,
    searchPreferenceSource: searchPreference.source,
    showCitations: settings.showCitations,
    showReasoningBlocks: settings.showReasoningBlocks,
    showToolActivity: settings.showToolActivity
  };
}

export function createUpdateSettingsHandler(deps: SettingsHandlerDeps) {
  return async function PATCH(request: Request): Promise<Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const data = await deps.loadSettingsData(auth.userId);
    if (!data) {
      return Response.json({ error: "settings_not_found" }, { status: 404 });
    }

    const [body, bodyError] = await readJson(request);
    if (bodyError) {
      return bodyError;
    }
    const result = buildSettingsUpdate(body, data);
    if (!result.update) {
      return Response.json({ error: result.error ?? "settings_update_required" }, { status: 400 });
    }

    const persistence = await deps.updateSettings(
      auth.userId,
      result.update,
      result.validationModels ?? []
    );
    if (persistence.kind === "invalid") {
      return Response.json({ error: persistence.error }, { status: 400 });
    }

    if (persistence.kind === "not_found") {
      return Response.json({ error: "settings_not_found" }, { status: 404 });
    }

    return Response.json({
      settings: serializeSettings(persistence.settings, data)
    });
  };
}
