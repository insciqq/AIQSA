export type ProviderId = "fake" | "openai" | "anthropic" | "gemini" | "openrouter";
export type ReasoningEffort = string;
export type OpenAIReasoningEffort = string;
export type OpenAIReasoningMode = "pro" | "standard";
export type AnthropicEffort = string;

export const maxOutputTokenParamKeys = [
  "maxOutputTokens",
  "maxTokens",
  "max_output_tokens",
  "max_tokens",
  "max_completion_tokens"
] as const;

export function maxOutputTokensFromParams(
  params: Readonly<Record<string, unknown>>
): number | undefined {
  for (const key of maxOutputTokenParamKeys) {
    const value = params[key];

    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return undefined;
}

export function canonicalizeMaxOutputTokenParams(
  params: Record<string, unknown>
): Record<string, unknown> {
  const maxOutputTokens = maxOutputTokensFromParams(params);
  const hasNonCanonicalAlias = maxOutputTokenParamKeys
    .slice(1)
    .some((key) => Object.prototype.hasOwnProperty.call(params, key));

  if (maxOutputTokens === undefined || !hasNonCanonicalAlias) {
    return params;
  }

  const canonicalParams = { ...params };
  for (const key of maxOutputTokenParamKeys) {
    delete canonicalParams[key];
  }
  canonicalParams.maxOutputTokens = maxOutputTokens;

  return canonicalParams;
}

export type OpenAIResponsesParams = {
  background: boolean;
  stream: boolean;
  store: boolean;
  reasoning: {
    effort: OpenAIReasoningEffort;
    mode?: OpenAIReasoningMode;
    summary: "auto" | "concise" | "detailed" | "none";
  };
  maxOutputTokens: number;
  manualContextReplay: boolean;
  temperature: number;
};

export type AnthropicMessagesParams = {
  maxTokens: number;
  temperature: number;
  thinking: {
    enabled: boolean;
    budgetTokens: number;
    type: "adaptive" | "enabled";
  };
  outputConfig: {
    effort: AnthropicEffort;
  };
};

export type GeminiInteractionsParams = {
  maxTokens: number;
  reasoning: {
    effort: ReasoningEffort;
  };
  stream: boolean;
};

export type FakeProviderParams = {
  deterministic: boolean;
  latencyMs: number;
  responseStyle: "concise" | "inspectable";
};

export type OpenRouterParams = {
  maxTokens: number;
  provider: {
    allowFallbacks: boolean;
    dataCollection: "allow" | "deny";
    order: string[];
    only: string[];
    requireParameters: boolean;
    sort: "latency" | "price" | "throughput";
    zdr: boolean;
  };
  reasoning: {
    enabled: boolean;
    effort: ReasoningEffort;
    exclude: boolean;
    maxTokens: number;
  };
  stream: boolean;
  temperature?: number;
  verbosity?: AnthropicEffort;
};

export function defaultOpenAIResponsesParams(): OpenAIResponsesParams {
  return {
    background: true,
    manualContextReplay: true,
    maxOutputTokens: 128000,
    reasoning: {
      effort: "medium",
      summary: "auto"
    },
    store: true,
    stream: false,
    temperature: 1
  };
}

export function defaultGeminiInteractionsParams(): GeminiInteractionsParams {
  return {
    maxTokens: 65536,
    reasoning: {
      effort: "medium"
    },
    stream: true
  };
}

export function normalizeOpenAIResponsesParams(
  params: Partial<OpenAIResponsesParams> & Record<string, unknown> = {}
): OpenAIResponsesParams {
  const defaults = defaultOpenAIResponsesParams();
  const maxOutputTokens = maxOutputTokensFromParams(params) ?? defaults.maxOutputTokens;

  return {
    ...defaults,
    ...params,
    maxOutputTokens,
    reasoning: {
      ...defaults.reasoning,
      ...params.reasoning
    },
    temperature: numberValue(params.temperature, defaults.temperature)
  };
}

export function defaultAnthropicMessagesParams(): AnthropicMessagesParams {
  return {
    maxTokens: 128000,
    temperature: 1,
    thinking: {
      budgetTokens: 0,
      enabled: false,
      type: "adaptive"
    },
    outputConfig: {
      effort: "high"
    }
  };
}

export function defaultFakeProviderParams(): FakeProviderParams {
  return {
    deterministic: true,
    latencyMs: 0,
    responseStyle: "inspectable"
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringArrayValue(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function openRouterEffort(value: unknown, fallback: OpenRouterParams["reasoning"]["effort"]) {
  return stringValue(value, fallback);
}

function optionalAnthropicEffort(value: unknown, fallback?: AnthropicEffort): AnthropicEffort | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  return fallback;
}

function openRouterSort(value: unknown, fallback: OpenRouterParams["provider"]["sort"]) {
  return value === "latency" || value === "price" || value === "throughput" ? value : fallback;
}

function openRouterDataCollection(value: unknown, fallback: OpenRouterParams["provider"]["dataCollection"]) {
  return value === "allow" || value === "deny" ? value : fallback;
}

export function defaultOpenRouterParams(): OpenRouterParams {
  return {
    maxTokens: 128000,
    provider: {
      allowFallbacks: true,
      dataCollection: "deny",
      order: [],
      only: [],
      requireParameters: false,
      sort: "throughput",
      zdr: false
    },
    reasoning: {
      enabled: false,
      effort: "medium",
      exclude: false,
      maxTokens: 0
    },
    stream: true,
    temperature: 1
  };
}

export function normalizeOpenRouterParams(params: Record<string, unknown> = {}): OpenRouterParams {
  const defaults = defaultOpenRouterParams();
  const provider = isRecord(params.provider) ? params.provider : {};
  const reasoning = isRecord(params.reasoning) ? params.reasoning : {};
  const maxTokens = maxOutputTokensFromParams(params) ?? defaults.maxTokens;

  const temperature =
    typeof params.temperature === "number" ? numberValue(params.temperature, defaults.temperature ?? 1) : undefined;
  const verbosity = optionalAnthropicEffort(params.verbosity, defaults.verbosity);

  return {
    maxTokens,
    provider: {
      allowFallbacks: booleanValue(
        provider.allowFallbacks ?? provider.allow_fallbacks,
        defaults.provider.allowFallbacks
      ),
      dataCollection: openRouterDataCollection(
        provider.dataCollection ?? provider.data_collection,
        defaults.provider.dataCollection
      ),
      order: stringArrayValue(provider.order),
      only: stringArrayValue(provider.only),
      requireParameters: booleanValue(
        provider.requireParameters ?? provider.require_parameters,
        defaults.provider.requireParameters
      ),
      sort: openRouterSort(provider.sort, defaults.provider.sort),
      zdr: booleanValue(provider.zdr, defaults.provider.zdr)
    },
    reasoning: {
      enabled: booleanValue(reasoning.enabled, defaults.reasoning.enabled),
      effort: openRouterEffort(reasoning.effort, defaults.reasoning.effort),
      exclude: booleanValue(reasoning.exclude, defaults.reasoning.exclude),
      maxTokens:
        numberValue(reasoning.maxTokens, 0) ||
        numberValue(reasoning.max_tokens, defaults.reasoning.maxTokens)
    },
    stream: booleanValue(params.stream, defaults.stream),
    ...(typeof temperature === "number" ? { temperature } : {}),
    ...(verbosity ? { verbosity } : {})
  };
}
