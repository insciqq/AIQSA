import { decodeSearchPlan, type SearchPlan } from "./search";

export type UserSettingsWire = {
  defaultControlValues: Record<string, unknown>;
  hasPersonalModelDefault: boolean;
  modelPreferenceSource: "none" | "organization" | "personal";
  organizationModelDefault: { modelId: string; provider: string } | null;
  personalModelDefault: { modelId: string; provider: string } | null;
  defaultSearchPlan: SearchPlan;
  organizationSearchPlan: SearchPlan;
  searchPreferenceSource: "organization" | "personal";
  showCitations: boolean;
  showReasoningBlocks: boolean;
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

function modelDefaultSelection(
  value: unknown
): value is { modelId: string; provider: string } | null {
  return value === null || (isRecord(value) && isNonEmptyString(value.modelId) &&
    isNonEmptyString(value.provider));
}

export function decodeUpdateSettingsResponse(value: unknown): UpdateSettingsResponse | null {
  if (!isRecord(value) || !isRecord(value.settings)) {
    return null;
  }

  const settings = value.settings;
  const defaultSearchPlan = decodeSearchPlan(settings.defaultSearchPlan);
  const organizationSearchPlan = decodeSearchPlan(settings.organizationSearchPlan);
  if (
    !isRecord(settings.defaultControlValues) ||
    typeof settings.hasPersonalModelDefault !== "boolean" ||
    (settings.modelPreferenceSource !== "none" &&
      settings.modelPreferenceSource !== "organization" &&
      settings.modelPreferenceSource !== "personal") ||
    !modelDefaultSelection(settings.organizationModelDefault) ||
    !modelDefaultSelection(settings.personalModelDefault) ||
    typeof settings.showCitations !== "boolean" ||
    typeof settings.showReasoningBlocks !== "boolean" ||
    settings.defaultSearchPlan === undefined ||
    settings.organizationSearchPlan === undefined ||
    !defaultSearchPlan.ok ||
    !organizationSearchPlan.ok ||
    (settings.searchPreferenceSource !== "organization" && settings.searchPreferenceSource !== "personal")
  ) {
    return null;
  }

  return {
    settings: {
      defaultControlValues: { ...settings.defaultControlValues },
      hasPersonalModelDefault: settings.hasPersonalModelDefault,
      modelPreferenceSource: settings.modelPreferenceSource,
      organizationModelDefault: settings.organizationModelDefault,
      personalModelDefault: settings.personalModelDefault,
      defaultSearchPlan: defaultSearchPlan.plan,
      organizationSearchPlan: organizationSearchPlan.plan,
      searchPreferenceSource: settings.searchPreferenceSource,
      showCitations: settings.showCitations,
      showReasoningBlocks: settings.showReasoningBlocks
    }
  };
}
