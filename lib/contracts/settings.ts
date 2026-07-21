export type UserSettingsWire = {
  defaultControlValues: Record<string, unknown>;
  defaultModelId: string;
  defaultPromptPresetId: string | null;
  defaultProvider: string;
  defaultSearchStrategyId: string;
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

function isNullableString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

export function decodeUpdateSettingsResponse(value: unknown): UpdateSettingsResponse | null {
  if (!isRecord(value) || !isRecord(value.settings)) {
    return null;
  }

  const settings = value.settings;
  if (
    !isRecord(settings.defaultControlValues) ||
    !isNonEmptyString(settings.defaultModelId) ||
    !isNullableString(settings.defaultPromptPresetId) ||
    !isNonEmptyString(settings.defaultProvider) ||
    !isNonEmptyString(settings.defaultSearchStrategyId) ||
    typeof settings.showCitations !== "boolean" ||
    typeof settings.showReasoningBlocks !== "boolean"
  ) {
    return null;
  }

  return {
    settings: {
      defaultControlValues: { ...settings.defaultControlValues },
      defaultModelId: settings.defaultModelId,
      defaultPromptPresetId: settings.defaultPromptPresetId,
      defaultProvider: settings.defaultProvider,
      defaultSearchStrategyId: settings.defaultSearchStrategyId,
      showCitations: settings.showCitations,
      showReasoningBlocks: settings.showReasoningBlocks
    }
  };
}
