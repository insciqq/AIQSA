import {
  defaultAnthropicMessagesParams,
  defaultDeepSeekResponsesParams,
  defaultFakeProviderParams,
  defaultGeminiInteractionsParams,
  defaultOpenRouterParams,
  defaultOpenAIResponsesParams,
  type ProviderId
} from "./providerParams";
import type { ModelParameterControls } from "../contracts/catalog";
import type { SearchAdapterKind, SearchPlanMode, SearchProtocol } from "./search";

export type { ModelParameterControls } from "../contracts/catalog";

export type CatalogAdapterKind =
  | "anthropic_messages"
  | "deepseek_responses_native"
  | "fake"
  | "gemini_interactions_native"
  | "openai_chat_completions_compatible"
  | "openai_responses_compatible"
  | "openai_responses_native"
  | "openrouter_chat_completions";

export type ProviderModelCatalogEntry = {
  adapterKind: CatalogAdapterKind;
  provider: string;
  providerDisplayName: string;
  providerFamily: string;
  modelId: string;
  upstreamModelId: string;
  displayName: string;
  contextWindow: number | null;
  inputTokenPriceMicros: number;
  outputTokenPriceMicros: number;
  capabilities: {
    backgroundStreaming?: boolean;
    nativePdfInput: boolean;
    nativeBackground?: boolean;
    pdf: boolean;
    reasoning: boolean;
    nativeSearch: boolean;
    parallelToolCalls?: boolean;
    streaming: boolean;
    toolCalling?: boolean;
    vision: boolean;
  };
  defaultParams: Record<string, unknown>;
  parameterControls: ModelParameterControls;
};

export type SearchStrategyRouteCatalogEntry = {
  adapterKind: SearchAdapterKind;
  config: Record<string, unknown>;
  credentialMode: "answer_provider" | "provider_model";
  executionModes: readonly SearchPlanMode[];
  kind: "anthropic_native_web_search" | "deepseek_native_web_search" | "gemini_google_search" | "openai_native_web_search" | "perplexity_tool_search" | "provider_model_web_search";
  physicalStrategyId: string;
  protocol: SearchProtocol;
  providerModelId?: string;
  revisionId: string;
  searchStrategyRowId: string;
};

/** One user-visible Search source. Its exact hosted/query-only execution route
 * is selected for the answer model at catalog/admission time and never exposed
 * as another user preference. */
export type SearchStrategyCatalogEntry = {
  description: string;
  displayName: string;
  kind: "gemini_google_search" | "none" | "perplexity_tool_search" | "web_search";
  routes: SearchStrategyRouteCatalogEntry[];
  sourceConnectionId?: string;
  strategyId: string;
};

type ProviderModelTemplate = Omit<
  ProviderModelCatalogEntry,
  "adapterKind" | "providerDisplayName" | "providerFamily" | "upstreamModelId"
> & {
  provider: ProviderId;
};

const neutralTemperature = 1;
const fallbackReasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const noReasoningControls: ModelParameterControls["reasoningEffort"] = {
  defaultValue: "none",
  options: ["none"],
  supported: false
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function controls(input: Partial<ModelParameterControls> & Pick<ModelParameterControls, "maxOutputTokens">): ModelParameterControls {
  return {
    background: input.background ?? {
      defaultValue: false,
      supported: false
    },
    maxOutputTokens: input.maxOutputTokens,
    reasoningEffort: input.reasoningEffort ?? noReasoningControls,
    ...(input.reasoningMode ? { reasoningMode: input.reasoningMode } : {}),
    stream: input.stream ?? {
      defaultValue: false,
      supported: false
    },
    temperature: input.temperature ?? {
      defaultValue: neutralTemperature,
      maxValue: 2,
      minValue: 0,
      supported: true
    }
  };
}

const openAIResponsesParams = defaultOpenAIResponsesParams();
const anthropicMessagesParams = defaultAnthropicMessagesParams();
const deepSeekResponsesParams = defaultDeepSeekResponsesParams();
const geminiInteractionsParams = defaultGeminiInteractionsParams();
const openRouterParams = defaultOpenRouterParams();

function openAIGpt56Model(modelId: string, displayName: string): ProviderModelTemplate {
  return {
    provider: "openai",
    modelId,
    displayName,
    contextWindow: 1_050_000,
    inputTokenPriceMicros: 0,
    outputTokenPriceMicros: 0,
    capabilities: {
      backgroundStreaming: true,
      nativeBackground: true,
      nativePdfInput: true,
      nativeSearch: true,
      parallelToolCalls: true,
      pdf: true,
      reasoning: true,
      streaming: true,
      toolCalling: true,
      vision: true
    },
    defaultParams: {
      ...openAIResponsesParams,
      reasoning: {
        ...openAIResponsesParams.reasoning,
        mode: "standard"
      }
    },
    parameterControls: controls({
      background: {
        defaultValue: true,
        supported: true
      },
      maxOutputTokens: {
        defaultValue: 128_000,
        maxValue: 128_000
      },
      reasoningEffort: {
        defaultValue: "medium",
        options: ["none", "low", "medium", "high", "xhigh", "max"],
        supported: true
      },
      reasoningMode: {
        defaultValue: "standard",
        options: ["standard", "pro"],
        supported: true
      },
      stream: {
        defaultValue: false,
        supported: true
      },
      temperature: {
        defaultValue: neutralTemperature,
        maxValue: 2,
        minValue: 0,
        supported: true
      }
    })
  };
}

function anthropicClaude5Model(modelId: string, displayName: string): ProviderModelTemplate {
  return {
    provider: "anthropic",
    modelId,
    displayName,
    contextWindow: 1_000_000,
    inputTokenPriceMicros: 0,
    outputTokenPriceMicros: 0,
    capabilities: {
      backgroundStreaming: false,
      nativeBackground: false,
      nativePdfInput: true,
      nativeSearch: true,
      parallelToolCalls: true,
      pdf: true,
      reasoning: true,
      streaming: true,
      toolCalling: true,
      vision: true
    },
    defaultParams: {
      ...anthropicMessagesParams,
      thinking: {
        ...anthropicMessagesParams.thinking,
        enabled: true,
        type: "adaptive"
      }
    },
    parameterControls: controls({
      maxOutputTokens: {
        defaultValue: 128_000,
        maxValue: 128_000
      },
      reasoningEffort: {
        defaultValue: "high",
        options: ["low", "medium", "high", "xhigh", "max"],
        supported: true
      },
      stream: {
        defaultValue: true,
        supported: false
      },
      temperature: {
        defaultValue: neutralTemperature,
        maxValue: 1,
        minValue: 0,
        supported: false
      }
    })
  };
}

function geminiModel(input: Readonly<{
  displayName: string;
  effort: "high" | "medium" | "minimal";
  modelId: string;
  pro?: boolean;
}>): ProviderModelTemplate {
  return {
    provider: "gemini",
    modelId: input.modelId,
    displayName: input.displayName,
    contextWindow: 1_000_000,
    inputTokenPriceMicros: 0,
    outputTokenPriceMicros: 0,
    capabilities: {
      backgroundStreaming: false,
      nativeBackground: false,
      nativePdfInput: false,
      nativeSearch: true,
      parallelToolCalls: false,
      pdf: true,
      reasoning: true,
      streaming: true,
      toolCalling: true,
      vision: true
    },
    defaultParams: {
      ...geminiInteractionsParams,
      reasoning: {
        effort: input.effort
      }
    },
    parameterControls: controls({
      maxOutputTokens: {
        defaultValue: 65_536,
        maxValue: 65_536
      },
      reasoningEffort: {
        defaultValue: input.effort,
        options: input.pro
          ? ["low", "medium", "high"]
          : ["minimal", "low", "medium", "high"],
        supported: true
      },
      stream: {
        defaultValue: true,
        supported: true
      },
      temperature: {
        defaultValue: neutralTemperature,
        maxValue: 2,
        minValue: 0,
        supported: false
      }
    })
  };
}

function deepSeekModel(input: Readonly<{
  displayName: string;
  modelId: string;
  vision?: boolean;
}>): ProviderModelTemplate {
  return {
    provider: "deepseek",
    modelId: input.modelId,
    displayName: input.displayName,
    contextWindow: 1_048_576,
    inputTokenPriceMicros: 0,
    outputTokenPriceMicros: 0,
    capabilities: {
      backgroundStreaming: false,
      nativeBackground: false,
      nativePdfInput: false,
      nativeSearch: true,
      parallelToolCalls: true,
      pdf: true,
      reasoning: true,
      streaming: true,
      toolCalling: true,
      vision: input.vision === true
    },
    defaultParams: deepSeekResponsesParams,
    parameterControls: controls({
      maxOutputTokens: {
        defaultValue: 32_768,
        maxValue: 384_000
      },
      reasoningEffort: {
        defaultValue: "high",
        options: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        supported: true
      },
      stream: {
        defaultValue: true,
        supported: true
      },
      temperature: {
        defaultValue: neutralTemperature,
        maxValue: 2,
        minValue: 0,
        supported: true
      }
    })
  };
}

const defaultProviderModelTemplates: ProviderModelTemplate[] = [
  {
    provider: "fake",
    modelId: "fake-qsa",
    displayName: "Fake QSA",
    contextWindow: 8192,
    inputTokenPriceMicros: 0,
    outputTokenPriceMicros: 0,
    capabilities: {
      backgroundStreaming: false,
      nativeBackground: false,
      nativePdfInput: false,
      nativeSearch: true,
      parallelToolCalls: false,
      pdf: true,
      reasoning: true,
      streaming: true,
      toolCalling: true,
      vision: true
    },
    defaultParams: defaultFakeProviderParams(),
    parameterControls: controls({
      maxOutputTokens: {
        defaultValue: 8192,
        maxValue: 8192
      },
      reasoningEffort: {
        defaultValue: "medium",
        options: ["none", "low", "medium", "high"],
        supported: true
      },
      stream: {
        defaultValue: true,
        supported: false
      },
      temperature: {
        defaultValue: neutralTemperature,
        maxValue: 2,
        minValue: 0,
        supported: true
      }
    })
  },
  {
    provider: "openai",
    modelId: "gpt-5.5",
    displayName: "GPT-5.5",
    contextWindow: 1_050_000,
    inputTokenPriceMicros: 0,
    outputTokenPriceMicros: 0,
    capabilities: {
      backgroundStreaming: true,
      nativeBackground: true,
      nativePdfInput: true,
      nativeSearch: true,
      parallelToolCalls: true,
      pdf: true,
      reasoning: true,
      streaming: true,
      toolCalling: true,
      vision: true
    },
    defaultParams: openAIResponsesParams,
    parameterControls: controls({
      background: {
        defaultValue: true,
        supported: true
      },
      maxOutputTokens: {
        defaultValue: 128000,
        maxValue: 128000
      },
      reasoningEffort: {
        defaultValue: "medium",
        options: ["none", "low", "medium", "high", "xhigh"],
        supported: true
      },
      stream: {
        defaultValue: false,
        supported: true
      },
      temperature: {
        defaultValue: neutralTemperature,
        maxValue: 2,
        minValue: 0,
        supported: true
      }
    })
  },
  openAIGpt56Model("gpt-5.6-sol", "GPT-5.6 Sol"),
  openAIGpt56Model("gpt-5.6-terra", "GPT-5.6 Terra"),
  openAIGpt56Model("gpt-5.6-luna", "GPT-5.6 Luna"),
  anthropicClaude5Model("claude-opus-5", "Claude Opus 5"),
  anthropicClaude5Model("claude-sonnet-5", "Claude Sonnet 5"),
  {
    provider: "anthropic",
    modelId: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    contextWindow: 1000000,
    inputTokenPriceMicros: 0,
    outputTokenPriceMicros: 0,
    capabilities: {
      backgroundStreaming: false,
      nativeBackground: false,
      nativePdfInput: true,
      nativeSearch: true,
      parallelToolCalls: true,
      pdf: true,
      reasoning: true,
      streaming: true,
      toolCalling: true,
      vision: true
    },
    defaultParams: anthropicMessagesParams,
    parameterControls: controls({
      maxOutputTokens: {
        defaultValue: 128000,
        maxValue: 128000
      },
      reasoningEffort: {
        defaultValue: "high",
        options: ["low", "medium", "high", "xhigh", "max"],
        supported: true
      },
      stream: {
        defaultValue: true,
        supported: false
      },
      temperature: {
        defaultValue: neutralTemperature,
        maxValue: 1,
        minValue: 0,
        supported: false
      }
    })
  },
  geminiModel({
    displayName: "Gemini 3.6 Flash",
    effort: "medium",
    modelId: "gemini-3.6-flash"
  }),
  geminiModel({
    displayName: "Gemini 3.5 Flash",
    effort: "medium",
    modelId: "gemini-3.5-flash"
  }),
  geminiModel({
    displayName: "Gemini 3.5 Flash-Lite",
    effort: "minimal",
    modelId: "gemini-3.5-flash-lite"
  }),
  geminiModel({
    displayName: "Gemini 3.1 Pro Preview",
    effort: "high",
    modelId: "gemini-3.1-pro-preview",
    pro: true
  }),
  deepSeekModel({
    displayName: "DeepSeek V4 Pro",
    modelId: "deepseek-v4-pro"
  }),
  deepSeekModel({
    displayName: "DeepSeek V4 Flash",
    modelId: "deepseek-v4-flash"
  }),
  deepSeekModel({
    displayName: "DeepSeek V4 Flash Vision (Experimental)",
    modelId: "deepseek-v4-flash-vision-exp",
    vision: true
  }),
  {
    provider: "openrouter",
    modelId: "anthropic/claude-opus-4.8",
    displayName: "Claude Opus 4.8",
    contextWindow: 1000000,
    inputTokenPriceMicros: 5,
    outputTokenPriceMicros: 25,
    capabilities: {
      backgroundStreaming: false,
      nativeBackground: false,
      nativePdfInput: true,
      nativeSearch: false,
      parallelToolCalls: true,
      pdf: true,
      reasoning: true,
      streaming: true,
      toolCalling: true,
      vision: true
    },
    defaultParams: {
      ...openRouterParams,
      provider: {
        ...openRouterParams.provider,
        order: ["anthropic"],
        only: ["anthropic"]
      },
      reasoning: {
        ...openRouterParams.reasoning,
        enabled: true
      },
      verbosity: "high"
    },
    parameterControls: controls({
      maxOutputTokens: {
        defaultValue: 128000,
        maxValue: 128000
      },
      reasoningEffort: {
        defaultValue: "high",
        options: ["low", "medium", "high", "xhigh", "max"],
        supported: true
      },
      stream: {
        defaultValue: true,
        supported: true
      },
      temperature: {
        defaultValue: neutralTemperature,
        maxValue: 1,
        minValue: 0,
        supported: false
      }
    })
  },
  {
    provider: "openrouter",
    modelId: "google/gemini-3.5-flash",
    displayName: "Gemini 3.5 Flash",
    contextWindow: 1048576,
    inputTokenPriceMicros: 2,
    outputTokenPriceMicros: 9,
    capabilities: {
      backgroundStreaming: false,
      nativeBackground: false,
      nativePdfInput: false,
      nativeSearch: false,
      parallelToolCalls: true,
      pdf: true,
      reasoning: true,
      streaming: true,
      toolCalling: true,
      vision: true
    },
    defaultParams: {
      ...openRouterParams,
      maxTokens: 65536,
      reasoning: {
        ...openRouterParams.reasoning,
        enabled: true,
        effort: "medium"
      },
      temperature: neutralTemperature
    },
    parameterControls: controls({
      maxOutputTokens: {
        defaultValue: 65536,
        maxValue: 65536
      },
      reasoningEffort: {
        defaultValue: "medium",
        options: ["none", "minimal", "low", "medium", "high"],
        supported: true
      },
      stream: {
        defaultValue: true,
        supported: true
      },
      temperature: {
        defaultValue: neutralTemperature,
        maxValue: 2,
        minValue: 0,
        supported: true
      }
    })
  },
  {
    provider: "openrouter",
    modelId: "~google/gemini-pro-latest",
    displayName: "Gemini Pro Latest",
    contextWindow: 1048576,
    inputTokenPriceMicros: 2,
    outputTokenPriceMicros: 12,
    capabilities: {
      backgroundStreaming: false,
      nativeBackground: false,
      nativePdfInput: false,
      nativeSearch: false,
      parallelToolCalls: true,
      pdf: true,
      reasoning: true,
      streaming: true,
      toolCalling: true,
      vision: true
    },
    defaultParams: {
      ...openRouterParams,
      maxTokens: 65536,
      reasoning: {
        ...openRouterParams.reasoning,
        enabled: true,
        effort: "high"
      },
      temperature: neutralTemperature
    },
    parameterControls: controls({
      maxOutputTokens: {
        defaultValue: 65536,
        maxValue: 65536
      },
      reasoningEffort: {
        defaultValue: "high",
        options: ["none", "minimal", "low", "medium", "high"],
        supported: true
      },
      stream: {
        defaultValue: true,
        supported: true
      },
      temperature: {
        defaultValue: neutralTemperature,
        maxValue: 2,
        minValue: 0,
        supported: true
      }
    })
  },
  {
    provider: "openrouter",
    modelId: "perplexity/sonar-pro-search",
    displayName: "Perplexity Sonar Pro Search",
    contextWindow: 200000,
    inputTokenPriceMicros: 3,
    outputTokenPriceMicros: 15,
    capabilities: {
      backgroundStreaming: false,
      nativeBackground: false,
      nativePdfInput: false,
      nativeSearch: true,
      parallelToolCalls: true,
      pdf: false,
      reasoning: false,
      streaming: true,
      toolCalling: true,
      vision: false
    },
    defaultParams: {
      ...openRouterParams,
      maxTokens: 8192,
      provider: {
        ...openRouterParams.provider,
        order: ["perplexity"]
      },
      reasoning: {
        ...openRouterParams.reasoning,
        exclude: true
      },
      temperature: neutralTemperature
    },
    parameterControls: controls({
      maxOutputTokens: {
        defaultValue: 8192,
        maxValue: 8192
      },
      reasoningEffort: noReasoningControls,
      stream: {
        defaultValue: true,
        supported: true
      },
      temperature: {
        defaultValue: neutralTemperature,
        maxValue: 2,
        minValue: 0,
        supported: true
      }
    })
  }
];

const providerDisplayNames: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  fake: "Fake",
  gemini: "Gemini",
  openai: "OpenAI",
  openrouter: "OpenRouter"
};

const providerAdapterKinds: Record<ProviderId, CatalogAdapterKind> = {
  anthropic: "anthropic_messages",
  deepseek: "deepseek_responses_native",
  fake: "fake",
  gemini: "gemini_interactions_native",
  openai: "openai_responses_native",
  openrouter: "openrouter_chat_completions"
};

export const defaultProviderModels: ProviderModelCatalogEntry[] =
  defaultProviderModelTemplates.map((model) => ({
    ...model,
    adapterKind: providerAdapterKinds[model.provider],
    providerDisplayName: providerDisplayNames[model.provider],
    providerFamily: model.provider,
    upstreamModelId: model.modelId
  }));

export function resolveProviderModelParameterControls(input: {
  adapterKind: CatalogAdapterKind;
  defaultMaxOutputTokens?: number;
  defaultReasoningEffort?: string;
  defaultReasoningMode?: string;
  defaultParams: Record<string, unknown>;
  providerFamily: string;
  reasoningEfforts?: readonly string[];
  reasoningModes?: readonly string[];
  supportsReasoningMode?: boolean;
  supportsReasoning: boolean;
  supportsStreaming: boolean;
  upstreamModelId: string;
}): ModelParameterControls {
  const template = defaultProviderModels.find(
    (model) =>
      model.adapterKind === input.adapterKind &&
      model.providerFamily === input.providerFamily &&
      model.upstreamModelId === input.upstreamModelId
  );

  return template?.parameterControls ?? fallbackParameterControls({
    adapterKind: input.adapterKind,
    defaultParams: input.defaultParams,
    defaultMaxOutputTokens: input.defaultMaxOutputTokens,
    defaultReasoningEffort: input.defaultReasoningEffort,
    defaultReasoningMode: input.defaultReasoningMode,
    provider: input.providerFamily,
    reasoningEfforts: input.reasoningEfforts,
    reasoningModes: input.reasoningModes,
    supportsReasoningMode: input.supportsReasoningMode,
    supportsReasoning: input.supportsReasoning,
    supportsStreaming: input.supportsStreaming
  });
}

export function fallbackParameterControls(input: {
  adapterKind?: CatalogAdapterKind;
  defaultParams?: Record<string, unknown>;
  defaultMaxOutputTokens?: number;
  defaultReasoningEffort?: string;
  defaultReasoningMode?: string;
  provider: string;
  reasoningEfforts?: readonly string[];
  reasoningModes?: readonly string[];
  supportsReasoningMode?: boolean;
  supportsReasoning: boolean;
  supportsStreaming?: boolean;
}): ModelParameterControls {
  const defaultParams = input.defaultParams ?? {};
  const reasoning = isRecord(defaultParams.reasoning) ? defaultParams.reasoning : {};
  const maxOutputTokens =
    numberValue(defaultParams.maxOutputTokens, 0) ||
    numberValue(defaultParams.maxTokens, 0) ||
    numberValue(defaultParams.max_output_tokens, input.defaultMaxOutputTokens ?? 1024);
  const nativeResponses = input.adapterKind === "openai_responses_native";
  const openRouter = input.adapterKind === "openrouter_chat_completions";
  const streamDefault = booleanValue(defaultParams.stream, openRouter);
  const rawReasoningEffort = reasoning.effort;
  const configuredReasoningEffort =
    typeof rawReasoningEffort === "string" &&
    fallbackReasoningEfforts.includes(rawReasoningEffort as (typeof fallbackReasoningEfforts)[number])
      ? rawReasoningEffort
      : "medium";
  const compatibleOpenAI = input.adapterKind === "openai_chat_completions_compatible" ||
    input.adapterKind === "openai_responses_compatible";
  const reasoningEfforts = input.reasoningEfforts?.length
    ? [...input.reasoningEfforts]
    : compatibleOpenAI
      ? ["none", "low", "medium", "high", "xhigh", "max"]
      : ["none", "low", "medium", "high"];
  const defaultReasoningEffort = input.defaultReasoningEffort &&
    reasoningEfforts.includes(input.defaultReasoningEffort)
    ? input.defaultReasoningEffort
    : reasoningEfforts.includes(configuredReasoningEffort)
      ? configuredReasoningEffort
      : reasoningEfforts[0] ?? "none";
  const reasoningModeSerializable = input.supportsReasoningMode ??
    input.adapterKind === "openai_responses_compatible";
  const reasoningModes = reasoningModeSerializable
    ? input.reasoningModes?.length
      ? [...input.reasoningModes]
      : compatibleOpenAI && !input.reasoningEfforts?.length
        ? ["standard", "pro"]
        : []
    : [];
  const defaultReasoningMode = input.defaultReasoningMode &&
    reasoningModes.includes(input.defaultReasoningMode)
    ? input.defaultReasoningMode
    : reasoningModes.includes("standard")
      ? "standard"
      : reasoningModes[0];

  return controls({
    background: {
      defaultValue: nativeResponses,
      supported: nativeResponses
    },
    maxOutputTokens: {
      defaultValue: maxOutputTokens,
      maxValue: maxOutputTokens
    },
    reasoningEffort: input.supportsReasoning
      ? {
          defaultValue: defaultReasoningEffort,
          options: reasoningEfforts,
          supported: true
        }
      : noReasoningControls,
    ...(input.supportsReasoning && defaultReasoningMode ? {
      reasoningMode: {
        defaultValue: defaultReasoningMode,
        options: reasoningModes,
        supported: true
      }
    } : {}),
    stream: {
      defaultValue: streamDefault,
      supported: Boolean(input.supportsStreaming && typeof defaultParams.stream === "boolean")
    },
    temperature: {
      defaultValue: numberValue(defaultParams.temperature, neutralTemperature),
      maxValue: 2,
      minValue: 0,
      supported: true
    }
  });
}

export function parameterControlsForModel(input: {
  adapterKind?: CatalogAdapterKind;
  defaultParams?: Record<string, unknown>;
  modelCapabilities?: {
    defaultMaxOutputTokens?: number;
    defaultReasoningEffort?: string;
    defaultReasoningMode?: string;
    reasoning?: boolean;
    reasoningEfforts?: readonly string[];
    reasoningModes?: readonly string[];
    streaming?: boolean;
  };
  modelId: string;
  provider: string;
  supportsReasoning?: boolean;
  supportsReasoningMode?: boolean;
}): ModelParameterControls {
  const defaultEntry = defaultProviderModels.find(
    (entry) => entry.providerFamily === input.provider && entry.upstreamModelId === input.modelId
  );

  if (defaultEntry) {
    return defaultEntry.parameterControls;
  }

  return fallbackParameterControls({
    adapterKind: input.adapterKind,
    defaultMaxOutputTokens: input.modelCapabilities?.defaultMaxOutputTokens,
    defaultReasoningEffort: input.modelCapabilities?.defaultReasoningEffort,
    defaultReasoningMode: input.modelCapabilities?.defaultReasoningMode,
    defaultParams:
      input.defaultParams ??
      (typeof input.modelCapabilities?.defaultMaxOutputTokens === "number"
        ? { maxOutputTokens: input.modelCapabilities.defaultMaxOutputTokens }
        : {}),
    provider: input.provider,
    reasoningEfforts: input.modelCapabilities?.reasoningEfforts,
    reasoningModes: input.modelCapabilities?.reasoningModes,
    supportsReasoningMode: input.supportsReasoningMode,
    supportsReasoning: input.supportsReasoning ?? Boolean(input.modelCapabilities?.reasoning),
    supportsStreaming: Boolean(input.modelCapabilities?.streaming)
  });
}

export const defaultSearchStrategies: SearchStrategyCatalogEntry[] = [
  {
    description: "Question directly to Answer with no search tool.",
    displayName: "No Search",
    kind: "none",
    routes: [],
    strategyId: "search-disabled"
  },
  {
    description: "Web search provided by Anthropic.",
    displayName: "Anthropic Search",
    kind: "web_search",
    routes: [{
      adapterKind: "answer_provider_hosted",
      config: {
        allowedCallers: ["direct"],
        maxUses: 3,
        tool: "web_search_20250305"
      },
      credentialMode: "answer_provider",
      executionModes: ["model_choice"],
      kind: "anthropic_native_web_search",
      physicalStrategyId: "anthropic-web-search",
      protocol: "anthropic_web_search",
      revisionId: "template:anthropic-web-search:v1",
      searchStrategyRowId: "anthropic-web-search"
    }],
    sourceConnectionId: "anthropic",
    strategyId: "anthropic-web-search"
  },
  {
    description: "Web evidence from OpenAI Search.",
    displayName: "OpenAI Search",
    kind: "web_search",
    routes: [{
      adapterKind: "answer_provider_hosted",
      config: { tool: "web_search" },
      credentialMode: "answer_provider",
      executionModes: ["model_choice"],
      kind: "openai_native_web_search",
      physicalStrategyId: "openai-native-web-search",
      protocol: "openai_responses_web_search",
      revisionId: "template:openai-native-web-search:v1",
      searchStrategyRowId: "openai-native-web-search"
    }],
    sourceConnectionId: "openai",
    strategyId: "openai-native-web-search"
  },
  {
    description: "Web search provided by DeepSeek. DeepSeek currently returns findings without source URLs.",
    displayName: "DeepSeek Search",
    kind: "web_search",
    routes: [{
      adapterKind: "answer_provider_hosted",
      config: { sourceAttribution: "provider_unavailable", tool: "web_search" },
      credentialMode: "answer_provider",
      executionModes: ["model_choice"],
      kind: "deepseek_native_web_search",
      physicalStrategyId: "deepseek-native-web-search",
      protocol: "deepseek_responses_web_search",
      revisionId: "template:deepseek-native-web-search:v1",
      searchStrategyRowId: "deepseek-native-web-search"
    }],
    sourceConnectionId: "deepseek",
    strategyId: "deepseek-native-web-search"
  },
  {
    description: "Google Search grounding for eligible Gemini models.",
    displayName: "Google Search",
    kind: "gemini_google_search",
    routes: [{
      adapterKind: "answer_provider_hosted",
      config: { liveOnly: true, tool: "google_search" },
      credentialMode: "answer_provider",
      executionModes: ["model_choice"],
      kind: "gemini_google_search",
      physicalStrategyId: "gemini-google-search",
      protocol: "gemini_google_search",
      revisionId: "template:gemini-google-search:v1",
      searchStrategyRowId: "gemini-google-search"
    }],
    sourceConnectionId: "gemini",
    strategyId: "gemini-google-search"
  },
  {
    description: "Web evidence from Perplexity through OpenRouter.",
    displayName: "Perplexity",
    kind: "perplexity_tool_search",
    routes: [{
      adapterKind: "provider_model_client",
      config: {
        executor: { modelId: "perplexity/sonar-pro-search", provider: "openrouter" },
        params: { maxOutputTokens: 1024, temperature: 0 },
        routeProvider: {
          allowFallbacks: true,
          dataCollection: "deny",
          order: ["perplexity"],
          requireParameters: false,
          sort: "throughput",
          zdr: false
        }
      },
      credentialMode: "provider_model",
      executionModes: ["all_selected", "model_choice"],
      kind: "perplexity_tool_search",
      physicalStrategyId: "perplexity-tool-search",
      protocol: "openrouter_perplexity_chat",
      providerModelId: "perplexity/sonar-pro-search",
      revisionId: "template:perplexity-tool-search:v1",
      searchStrategyRowId: "perplexity-tool-search"
    }],
    sourceConnectionId: "openrouter",
    strategyId: "perplexity-tool-search"
  }
];
