import type { ModelParameterControls } from "./catalog";
import {
  canonicalizeMaxOutputTokenParams,
  maxOutputTokenParamKeys
} from "./providerParams";

export const invalidRunParamsError = "invalid_run_params";

export type RunParamValidationResult =
  | {
      ok: true;
      params: Record<string, unknown>;
    }
  | {
      code: typeof invalidRunParamsError;
      ok: false;
    };

export type SearchRunParamControls = Pick<
  ModelParameterControls,
  "maxOutputTokens" | "temperature"
>;

export type SearchRunParamValidationResult =
  | {
      ok: true;
      params: Record<string, unknown> | undefined;
    }
  | {
      code: typeof invalidRunParamsError;
      ok: false;
    };

const openAiReasoningSummaries = new Set(["auto", "concise", "detailed", "none"]);
const anthropicThinkingTypes = new Set(["adaptive", "enabled"]);
const openRouterDataCollectionValues = new Set(["allow", "deny"]);
const openRouterSortValues = new Set(["latency", "price", "throughput"]);

const allowedTopLevelKeys: Record<string, Set<string>> = {
  anthropic: new Set([
    "maxTokens",
    "max_tokens",
    "maxOutputTokens",
    "max_output_tokens",
    "temperature",
    "thinking",
    "outputConfig",
    "output_config",
    "search"
  ]),
  fake: new Set([
    "deterministic",
    "latencyMs",
    "maxOutputTokens",
    "maxTokens",
    "max_output_tokens",
    "max_tokens",
    "reasoning",
    "responseStyle",
    "search",
    "temperature"
  ]),
  openai: new Set([
    "background",
    "manualContextReplay",
    "maxOutputTokens",
    "maxTokens",
    "max_output_tokens",
    "max_completion_tokens",
    "max_tokens",
    "reasoning",
    "search",
    "store",
    "stream",
    "temperature"
  ]),
  openrouter: new Set([
    "maxTokens",
    "max_tokens",
    "maxOutputTokens",
    "max_output_tokens",
    "max_completion_tokens",
    "provider",
    "reasoning",
    "search",
    "stream",
    "temperature",
    "verbosity"
  ])
};

function invalid(): RunParamValidationResult {
  return {
    code: invalidRunParamsError,
    ok: false
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function allKeysAllowed(record: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function validateBoolean(value: unknown): boolean {
  return typeof value === "boolean";
}

function validateIntegerRange(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function validateNumberRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function validateStringArrayOrCsv(value: unknown): boolean {
  if (typeof value === "string") {
    return true;
  }

  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateMaxOutputTokens(params: Record<string, unknown>, controls: ModelParameterControls): boolean {
  const values: number[] = [];

  for (const key of maxOutputTokenParamKeys) {
    if (!hasOwn(params, key)) {
      continue;
    }

    const value = params[key];
    if (!validateIntegerRange(value, 1, controls.maxOutputTokens.maxValue)) {
      return false;
    }
    values.push(value);
  }

  return new Set(values).size <= 1;
}

function validateTemperature(params: Record<string, unknown>, controls: ModelParameterControls): boolean {
  if (!hasOwn(params, "temperature")) {
    return true;
  }

  return (
    controls.temperature.supported &&
    validateNumberRange(params.temperature, controls.temperature.minValue, controls.temperature.maxValue)
  );
}

function validateEffort(
  value: unknown,
  controls: ModelParameterControls,
  options: {
    allowDisabledUnsupportedValue?: boolean;
  } = {}
): boolean {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }

  if (controls.reasoningEffort.supported) {
    return controls.reasoningEffort.options.includes(value);
  }

  return value === "none" || Boolean(options.allowDisabledUnsupportedValue);
}

function validateReasoningMode(value: unknown, controls: ModelParameterControls): boolean {
  return (
    typeof value === "string" &&
    controls.reasoningMode?.supported === true &&
    controls.reasoningMode.options.includes(value)
  );
}

export function validateSearchRunParams(
  value: unknown,
  controls?: SearchRunParamControls
): SearchRunParamValidationResult {
  if (value === undefined) {
    return {
      ok: true,
      params: undefined
    };
  }

  if (!controls || !isRecord(value)) {
    return invalid();
  }

  if (!allKeysAllowed(value, new Set(["maxOutputTokens", "temperature"]))) {
    return invalid();
  }

  if (
    hasOwn(value, "maxOutputTokens") &&
    !validateIntegerRange(value.maxOutputTokens, 1, controls.maxOutputTokens.maxValue)
  ) {
    return invalid();
  }

  if (
    hasOwn(value, "temperature") &&
    (!controls.temperature.supported ||
      !validateNumberRange(
        value.temperature,
        controls.temperature.minValue,
        controls.temperature.maxValue
      ))
  ) {
    return invalid();
  }

  return {
    ok: true,
    params: { ...value }
  };
}

function validateFakeParams(params: Record<string, unknown>, controls: ModelParameterControls): boolean {
  if (hasOwn(params, "deterministic") && !validateBoolean(params.deterministic)) {
    return false;
  }
  if (hasOwn(params, "latencyMs") && !validateIntegerRange(params.latencyMs, 0, 60_000)) {
    return false;
  }
  if (
    hasOwn(params, "responseStyle") &&
    params.responseStyle !== "concise" &&
    params.responseStyle !== "inspectable"
  ) {
    return false;
  }
  if (hasOwn(params, "reasoning")) {
    if (!isRecord(params.reasoning)) {
      return false;
    }
    if (!allKeysAllowed(params.reasoning, new Set(["enabled", "effort"]))) {
      return false;
    }
    if (hasOwn(params.reasoning, "enabled") && !validateBoolean(params.reasoning.enabled)) {
      return false;
    }
    if (hasOwn(params.reasoning, "effort") && !validateEffort(params.reasoning.effort, controls)) {
      return false;
    }
  }

  return true;
}

function validateOpenAiParams(params: Record<string, unknown>, controls: ModelParameterControls): boolean {
  if (hasOwn(params, "background") && (!controls.background.supported || !validateBoolean(params.background))) {
    return false;
  }
  for (const key of ["manualContextReplay", "store", "stream"]) {
    if (hasOwn(params, key) && !validateBoolean(params[key])) {
      return false;
    }
  }
  if (hasOwn(params, "stream") && !controls.stream.supported) {
    return false;
  }
  if (hasOwn(params, "reasoning")) {
    if (!isRecord(params.reasoning)) {
      return false;
    }
    if (!allKeysAllowed(params.reasoning, new Set(["effort", "mode", "summary"]))) {
      return false;
    }
    if (hasOwn(params.reasoning, "effort") && !validateEffort(params.reasoning.effort, controls)) {
      return false;
    }
    if (hasOwn(params.reasoning, "mode") && !validateReasoningMode(params.reasoning.mode, controls)) {
      return false;
    }
    if (
      hasOwn(params.reasoning, "summary") &&
      (typeof params.reasoning.summary !== "string" || !openAiReasoningSummaries.has(params.reasoning.summary))
    ) {
      return false;
    }
  }

  return true;
}

function validateAnthropicParams(params: Record<string, unknown>, controls: ModelParameterControls): boolean {
  const thinking = params.thinking;
  if (hasOwn(params, "thinking")) {
    if (!isRecord(thinking) || !allKeysAllowed(thinking, new Set(["budgetTokens", "budget_tokens", "enabled", "type"]))) {
      return false;
    }
    if (hasOwn(thinking, "enabled") && !validateBoolean(thinking.enabled)) {
      return false;
    }
    for (const key of ["budgetTokens", "budget_tokens"]) {
      if (hasOwn(thinking, key) && !validateIntegerRange(thinking[key], 0, controls.maxOutputTokens.maxValue)) {
        return false;
      }
    }
    if (hasOwn(thinking, "type") && (typeof thinking.type !== "string" || !anthropicThinkingTypes.has(thinking.type))) {
      return false;
    }
  }

  for (const key of ["outputConfig", "output_config"]) {
    if (!hasOwn(params, key)) {
      continue;
    }
    const outputConfig = params[key];
    if (!isRecord(outputConfig) || !allKeysAllowed(outputConfig, new Set(["effort"]))) {
      return false;
    }
    if (hasOwn(outputConfig, "effort") && !validateEffort(outputConfig.effort, controls)) {
      return false;
    }
  }

  return true;
}

function validateOpenRouterProviderParams(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !allKeysAllowed(
      value,
      new Set([
        "allowFallbacks",
        "allow_fallbacks",
        "dataCollection",
        "data_collection",
        "order",
        "only",
        "requireParameters",
        "require_parameters",
        "sort",
        "zdr"
      ])
    )
  ) {
    return false;
  }

  for (const key of ["allowFallbacks", "allow_fallbacks", "requireParameters", "require_parameters", "zdr"]) {
    if (hasOwn(value, key) && !validateBoolean(value[key])) {
      return false;
    }
  }
  for (const key of ["dataCollection", "data_collection"]) {
    if (hasOwn(value, key) && (typeof value[key] !== "string" || !openRouterDataCollectionValues.has(value[key]))) {
      return false;
    }
  }

  return (
    (!hasOwn(value, "order") || validateStringArrayOrCsv(value.order)) &&
    (!hasOwn(value, "only") || validateStringArrayOrCsv(value.only)) &&
    (!hasOwn(value, "sort") || (typeof value.sort === "string" && openRouterSortValues.has(value.sort)))
  );
}

function validateOpenRouterParams(params: Record<string, unknown>, controls: ModelParameterControls): boolean {
  if (hasOwn(params, "stream") && !validateBoolean(params.stream)) {
    return false;
  }
  if (hasOwn(params, "stream") && !controls.stream.supported) {
    return false;
  }
  if (hasOwn(params, "provider") && !validateOpenRouterProviderParams(params.provider)) {
    return false;
  }
  if (hasOwn(params, "verbosity") && !validateEffort(params.verbosity, controls)) {
    return false;
  }
  if (hasOwn(params, "reasoning")) {
    if (!isRecord(params.reasoning)) {
      return false;
    }
    if (!allKeysAllowed(params.reasoning, new Set(["enabled", "effort", "exclude", "maxTokens", "max_tokens"]))) {
      return false;
    }
    if (hasOwn(params.reasoning, "enabled") && !validateBoolean(params.reasoning.enabled)) {
      return false;
    }
    if (hasOwn(params.reasoning, "exclude") && !validateBoolean(params.reasoning.exclude)) {
      return false;
    }
    for (const key of ["maxTokens", "max_tokens"]) {
      if (hasOwn(params.reasoning, key) && !validateIntegerRange(params.reasoning[key], 0, controls.maxOutputTokens.maxValue)) {
        return false;
      }
    }
    if (
      hasOwn(params.reasoning, "effort") &&
      !validateEffort(params.reasoning.effort, controls, {
        allowDisabledUnsupportedValue: params.reasoning.enabled !== true
      })
    ) {
      return false;
    }
  }

  return true;
}

function validateProviderParams(
  provider: string,
  params: Record<string, unknown>,
  controls: ModelParameterControls
): boolean {
  if (provider === "fake") {
    return validateFakeParams(params, controls);
  }
  if (provider === "openai") {
    return validateOpenAiParams(params, controls);
  }
  if (provider === "anthropic") {
    return validateAnthropicParams(params, controls);
  }
  if (provider === "openrouter") {
    return validateOpenRouterParams(params, controls);
  }

  return false;
}

export function validateRunParams(input: {
  controls: ModelParameterControls;
  params: Record<string, unknown>;
  provider: string;
  searchControls?: SearchRunParamControls;
}): RunParamValidationResult {
  const allowed = allowedTopLevelKeys[input.provider] ?? new Set(["maxOutputTokens", "maxTokens", "reasoning", "search", "temperature"]);

  if (!allKeysAllowed(input.params, allowed)) {
    return invalid();
  }
  const searchValidation = validateSearchRunParams(input.params.search, input.searchControls);
  if (!searchValidation.ok) {
    return invalid();
  }
  if (!validateMaxOutputTokens(input.params, input.controls)) {
    return invalid();
  }
  if (!validateTemperature(input.params, input.controls)) {
    return invalid();
  }
  if (!validateProviderParams(input.provider, input.params, input.controls)) {
    return invalid();
  }

  const params = canonicalizeMaxOutputTokenParams(input.params);
  if (searchValidation.params) {
    params.search = searchValidation.params;
  }

  return {
    ok: true,
    params
  };
}
