import { decodeSearchPlan, type SearchPlan } from "./search";

export type UserSettingsWire = {
  defaultControlValues: Record<string, unknown>;
  defaultModelId: string;
  defaultProvider: string;
  defaultSearchStrategyId: string;
  defaultSearchPlan?: SearchPlan;
  organizationSearchPlan?: SearchPlan;
  searchPreferenceSource?: "organization" | "personal";
  showCitations: boolean;
  showReasoningBlocks: boolean;
  showToolActivity: boolean;
};

export type UpdateSettingsResponse = {
  settings: UserSettingsWire;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

export function decodeUpdateSettingsResponse(value: unknown): UpdateSettingsResponse | null {
  if (!isRecord(value) || !isRecord(value.settings)) {
    return null;
  }

  const settings = value.settings;
  const defaultSearchPlan = settings.defaultSearchPlan === undefined
    ? null
    : decodeSearchPlan(settings.defaultSearchPlan, settings.defaultSearchStrategyId);
  const organizationSearchPlan = decodeSearchPlan(settings.organizationSearchPlan);
  if (
    !isRecord(settings.defaultControlValues) ||
    !isString(settings.defaultModelId) ||
    !isString(settings.defaultProvider) ||
    !isNonEmptyString(settings.defaultSearchStrategyId) ||
    typeof settings.showCitations !== "boolean" ||
    typeof settings.showReasoningBlocks !== "boolean" ||
    typeof settings.showToolActivity !== "boolean" ||
    (settings.defaultSearchPlan !== undefined && !defaultSearchPlan?.ok) ||
    !organizationSearchPlan.ok ||
    (settings.searchPreferenceSource !== "organization" && settings.searchPreferenceSource !== "personal")
  ) {
    return null;
  }

  return {
    settings: {
      defaultControlValues: { ...settings.defaultControlValues },
      defaultModelId: settings.defaultModelId,
      defaultProvider: settings.defaultProvider,
      defaultSearchStrategyId: settings.defaultSearchStrategyId,
      ...(defaultSearchPlan?.ok
        ? { defaultSearchPlan: defaultSearchPlan.plan }
        : {}),
      organizationSearchPlan: organizationSearchPlan.plan,
      searchPreferenceSource: settings.searchPreferenceSource,
      showCitations: settings.showCitations,
      showReasoningBlocks: settings.showReasoningBlocks,
      showToolActivity: settings.showToolActivity
    }
  };
}
