import type { CatalogWireModel } from "../../contracts/catalog";
import type { UserSettingsWire } from "../../contracts/settings";
import type { RequestAuthResolver } from "../auth/requestAuth";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../http/requestBody";
import { decodeSearchPlan, type SearchPlan } from "../../domain/search";
import { isSearchCombinationCompatible } from "../../domain/catalogMatrix";
import {
  decodeChatDefaultMcpMode,
  type ChatDefaultMcpMode
} from "../../contracts/chatDefaults";
import {
  decodeKnowledgeSelection,
  type KnowledgeSelection
} from "../../contracts/knowledge";
import {
  resolveChatDefaults,
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
  defaultKnowledgePlan: KnowledgeSelection | null;
  defaultMcpMode: ChatDefaultMcpMode;
  defaultProviderModelId: string | null;
  defaultSearchPlan: SearchPlan | null;
  sendWithEnter: boolean;
  showCitations: boolean;
  showReasoningBlocks: boolean;
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

  const supportedKeys = new Set([
    "defaultControlValues",
    "defaultKnowledgePlan",
    "defaultMcpMode",
    "defaultProviderModelId",
    "defaultSearchPlan",
    "sendWithEnter",
    "showCitations",
    "showReasoningBlocks"
  ]);
  if (Object.keys(body).some((key) => !supportedKeys.has(key))) {
    return { error: "settings_update_required" };
  }

  const { models } = resolveCurrentUserCatalogSelection(data);
  const update: UserSettingsUpdate = {};

  if ("defaultProviderModelId" in body) {
    if (body.defaultProviderModelId === null) {
      update.defaultProviderModelId = null;
    } else if (typeof body.defaultProviderModelId === "string") {
      const modelId = body.defaultProviderModelId.trim();
      const model = models.find((candidate) => candidate.modelId === modelId);
      if (!model) {
        return { error: "default_model_unavailable" };
      }
      update.defaultProviderModelId = model.modelId;
    } else {
      return { error: "default_model_required" };
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
    }
  }

  if ("defaultKnowledgePlan" in body) {
    if (body.defaultKnowledgePlan === null) {
      update.defaultKnowledgePlan = null;
    } else {
      const decoded = decodeKnowledgeSelection(body.defaultKnowledgePlan);
      if (!decoded.ok || decoded.plan.mode === "inherited") {
        return { error: "default_knowledge_plan_invalid" };
      }
      update.defaultKnowledgePlan = decoded.plan.mode === "none" ? null : decoded.plan;
    }
  }

  if ("defaultMcpMode" in body) {
    const mode = decodeChatDefaultMcpMode(body.defaultMcpMode);
    if (!mode) {
      return { error: "default_mcp_mode_invalid" };
    }
    update.defaultMcpMode = mode;
  }

  if ("sendWithEnter" in body) {
    if (typeof body.sendWithEnter !== "boolean") {
      return { error: "send_with_enter_boolean_required" };
    }
    update.sendWithEnter = body.sendWithEnter;
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
  const chatDefaults = resolveChatDefaults(settings);
  return {
    defaultControlValues: isRecord(settings.defaultControlValues) ? settings.defaultControlValues : {},
    defaultKnowledgePlan: chatDefaults.knowledgePlan,
    defaultMcpMode: chatDefaults.mcpMode,
    hasPersonalModelDefault: selection.hasPersonalModelDefault,
    modelPreferenceSource: selection.modelPreferenceSource,
    organizationModelDefault: selection.organizationModelDefault,
    personalModelDefault: selection.personalModelDefault,
    defaultSearchPlan: searchPreference.preferredPlan,
    organizationSearchPlan: searchPreference.organizationPlan,
    searchPreferenceSource: searchPreference.source,
    sendWithEnter: chatDefaults.sendWithEnter,
    showCitations: settings.showCitations,
    showReasoningBlocks: settings.showReasoningBlocks
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
