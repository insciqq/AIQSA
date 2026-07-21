export type ProviderId = "fake" | "openai" | "anthropic" | "openrouter";
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

export type ProviderParameterField = {
  name: string;
  type: "boolean" | "integer" | "number" | "string" | "enum";
  defaultValue: boolean | number | string;
  allowedValues?: string[];
};

export type ProviderParameterSchema = {
  provider: ProviderId;
  fields: ProviderParameterField[];
};

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

// This is the provider-wide field vocabulary; per-model options and support are
// authoritative only in ModelParameterControls from the entitled catalog.
export const providerParameterSchemas: Record<ProviderId, ProviderParameterSchema> = {
  anthropic: {
    provider: "anthropic",
    fields: [
      { name: "maxTokens", type: "integer", defaultValue: 128000 },
      { name: "temperature", type: "number", defaultValue: 1 },
      { name: "thinking.enabled", type: "boolean", defaultValue: false },
      {
        name: "thinking.type",
        type: "enum",
        defaultValue: "adaptive",
        allowedValues: ["adaptive", "enabled"]
      },
      { name: "thinking.budgetTokens", type: "integer", defaultValue: 0 },
      {
        name: "outputConfig.effort",
        type: "enum",
        defaultValue: "high",
        allowedValues: ["low", "medium", "high", "xhigh", "max"]
      }
    ]
  },
  fake: {
    provider: "fake",
    fields: [
      { name: "deterministic", type: "boolean", defaultValue: true },
      { name: "latencyMs", type: "integer", defaultValue: 0 },
      { name: "responseStyle", type: "enum", defaultValue: "inspectable", allowedValues: ["concise", "inspectable"] }
    ]
  },
  openai: {
    provider: "openai",
    fields: [
      { name: "background", type: "boolean", defaultValue: true },
      { name: "stream", type: "boolean", defaultValue: false },
      { name: "store", type: "boolean", defaultValue: true },
      {
        name: "reasoning.effort",
        type: "enum",
        defaultValue: "medium",
        allowedValues: ["none", "low", "medium", "high", "xhigh", "max"]
      },
      {
        name: "reasoning.mode",
        type: "enum",
        defaultValue: "standard",
        allowedValues: ["standard", "pro"]
      },
      {
        name: "reasoning.summary",
        type: "enum",
        defaultValue: "auto",
        allowedValues: ["auto", "concise", "detailed", "none"]
      },
      { name: "maxOutputTokens", type: "integer", defaultValue: 128000 },
      { name: "temperature", type: "number", defaultValue: 1 },
      { name: "manualContextReplay", type: "boolean", defaultValue: true }
    ]
  },
  openrouter: {
    provider: "openrouter",
    fields: [
      { name: "maxTokens", type: "integer", defaultValue: 128000 },
      { name: "temperature", type: "number", defaultValue: 1 },
      { name: "stream", type: "boolean", defaultValue: true },
      { name: "reasoning.enabled", type: "boolean", defaultValue: false },
      {
        name: "reasoning.effort",
        type: "enum",
        defaultValue: "medium",
        allowedValues: ["none", "minimal", "low", "medium", "high", "xhigh"]
      },
      { name: "reasoning.exclude", type: "boolean", defaultValue: false },
      { name: "reasoning.maxTokens", type: "integer", defaultValue: 0 },
      { name: "provider.allowFallbacks", type: "boolean", defaultValue: true },
      { name: "provider.requireParameters", type: "boolean", defaultValue: false },
      { name: "provider.order", type: "string", defaultValue: "" },
      { name: "provider.only", type: "string", defaultValue: "" },
      {
        name: "verbosity",
        type: "enum",
        defaultValue: "high",
        allowedValues: ["low", "medium", "high", "xhigh", "max"]
      },
      {
        name: "provider.dataCollection",
        type: "enum",
        defaultValue: "deny",
        allowedValues: ["allow", "deny"]
      },
      {
        name: "provider.sort",
        type: "enum",
        defaultValue: "throughput",
        allowedValues: ["latency", "price", "throughput"]
      },
      { name: "provider.zdr", type: "boolean", defaultValue: false }
    ]
  }
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

function anthropicEffort(value: unknown, fallback: AnthropicEffort): AnthropicEffort {
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
