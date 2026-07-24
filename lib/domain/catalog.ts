import {
  defaultAnthropicMessagesParams,
  defaultFakeProviderParams,
  defaultOpenRouterParams,
  defaultOpenAIResponsesParams,
  type ProviderId
} from "./providerParams";
import type { ModelParameterControls } from "../contracts/catalog";

export type { ModelParameterControls } from "../contracts/catalog";

export type CatalogAdapterKind =
  | "anthropic_messages"
  | "fake"
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
  contextWindow: number;
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

export type SearchStrategyCatalogEntry = {
  strategyId: string;
  provider: string;
  modelId?: string;
  providerModelId?: string;
  displayName: string;
  kind: "none" | "openai_native_web_search" | "perplexity_tool_search";
  description: string;
  config: Record<string, unknown>;
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
      toolCalling: false,
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
      nativeSearch: false,
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
  fake: "Fake",
  openai: "OpenAI",
  openrouter: "OpenRouter"
};

const providerAdapterKinds: Record<ProviderId, CatalogAdapterKind> = {
  anthropic: "anthropic_messages",
  fake: "fake",
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
  defaultParams: Record<string, unknown>;
  providerFamily: string;
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
    provider: input.providerFamily,
    supportsReasoning: input.supportsReasoning,
    supportsStreaming: input.supportsStreaming
  });
}

export function fallbackParameterControls(input: {
  adapterKind?: CatalogAdapterKind;
  defaultParams?: Record<string, unknown>;
  provider: string;
  supportsReasoning: boolean;
  supportsStreaming?: boolean;
}): ModelParameterControls {
  const defaultParams = input.defaultParams ?? {};
  const reasoning = isRecord(defaultParams.reasoning) ? defaultParams.reasoning : {};
  const maxOutputTokens =
    numberValue(defaultParams.maxOutputTokens, 0) ||
    numberValue(defaultParams.maxTokens, 0) ||
    numberValue(defaultParams.max_output_tokens, 1024);
  const nativeResponses = input.adapterKind === "openai_responses_native";
  const openRouter = input.adapterKind === "openrouter_chat_completions";
  const streamDefault = booleanValue(defaultParams.stream, openRouter);
  const rawReasoningEffort = reasoning.effort;
  const defaultReasoningEffort =
    typeof rawReasoningEffort === "string" &&
    fallbackReasoningEfforts.includes(rawReasoningEffort as (typeof fallbackReasoningEfforts)[number])
      ? rawReasoningEffort
      : "medium";

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
          options: ["none", "low", "medium", "high"],
          supported: true
        }
      : noReasoningControls,
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
    reasoning?: boolean;
    streaming?: boolean;
  };
  modelId: string;
  provider: string;
  supportsReasoning?: boolean;
}): ModelParameterControls {
  const defaultEntry = defaultProviderModels.find(
    (entry) => entry.providerFamily === input.provider && entry.upstreamModelId === input.modelId
  );

  if (defaultEntry) {
    return defaultEntry.parameterControls;
  }

    return fallbackParameterControls({
      adapterKind: input.adapterKind,
      defaultParams:
      input.defaultParams ??
      (typeof input.modelCapabilities?.defaultMaxOutputTokens === "number"
        ? { maxOutputTokens: input.modelCapabilities.defaultMaxOutputTokens }
        : {}),
    provider: input.provider,
    supportsReasoning: input.supportsReasoning ?? Boolean(input.modelCapabilities?.reasoning),
    supportsStreaming: Boolean(input.modelCapabilities?.streaming)
  });
}

export const defaultSearchStrategies: SearchStrategyCatalogEntry[] = [
  {
    strategyId: "search-disabled",
    provider: "fake",
    displayName: "No Search",
    kind: "none",
    description: "Question directly to Answer with no search tool.",
    config: {}
  },
  {
    strategyId: "openai-native-web-search",
    provider: "openai",
    modelId: "gpt-5.5",
    displayName: "OpenAI web_search",
    kind: "openai_native_web_search",
    description: "OpenAI Responses API web_search tool for direct OpenAI models.",
    config: {
      tool: "web_search"
    }
  },
  {
    strategyId: "perplexity-tool-search",
    provider: "openrouter",
    modelId: "perplexity/sonar-pro-search",
    providerModelId: "perplexity/sonar-pro-search",
    displayName: "Perplexity tool",
    kind: "perplexity_tool_search",
    description: "Provider-neutral web-search tool backed by Perplexity through OpenRouter.",
    config: {
      executor: {
        provider: "openrouter",
        modelId: "perplexity/sonar-pro-search"
      },
      params: {
        maxOutputTokens: 1024,
        temperature: 0
      },
      routeProvider: {
        allowFallbacks: true,
        dataCollection: "deny",
        order: ["perplexity"],
        requireParameters: false,
        sort: "throughput",
        zdr: false
      },
      tool: {
        capability: "web_search",
        name: "search_via_perplexity"
      }
    }
  }
];
