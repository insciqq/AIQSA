export type MatrixModel = {
  capabilities: {
    background: boolean;
    documentInputMode: "native_pdf" | "none" | "pdf_text_extraction";
    imageInput: boolean;
    nativeWebSearch: boolean;
    openRouterPerplexitySearch: boolean;
    reasoning: boolean;
    streaming: boolean;
    toolCalling: boolean;
  };
  contextWindow: number;
  defaultParams: Record<string, unknown>;
  displayName: string;
  modelId: string;
  parameterControls: {
    background: {
      defaultValue: boolean;
      supported: boolean;
    };
    maxOutputTokens: {
      defaultValue: number;
      maxValue: number;
    };
    reasoningEffort: {
      defaultValue: string;
      options: string[];
      supported: boolean;
    };
    reasoningMode?: {
      defaultValue: string;
      options: string[];
      supported: boolean;
    };
    stream: {
      defaultValue: boolean;
      supported: boolean;
    };
    temperature: {
      defaultValue: number;
      maxValue: number;
      minValue: number;
      supported: boolean;
    };
  };
  provider: string;
  providerFamily: string;
  searchStrategyIds: string[];
  upstreamModelId: string;
};

function matrixModel(input: {
  background?: boolean;
  displayName: string;
  maxTokens: number;
  modelId: string;
  provider: string;
  reasoningDefault: string;
  reasoningModes?: string[];
  reasoningOptions: string[];
  temperatureSupported?: boolean;
}): MatrixModel {
  return {
    capabilities: {
      background: Boolean(input.background),
      documentInputMode: "pdf_text_extraction",
      imageInput: true,
      nativeWebSearch: input.provider === "openai",
      openRouterPerplexitySearch: true,
      reasoning: true,
      streaming: true,
      toolCalling: true
    },
    contextWindow: 200000,
    defaultParams: {
      maxTokens: input.maxTokens,
      maxOutputTokens: input.maxTokens,
      reasoning: {
        effort: input.reasoningDefault,
        ...(input.reasoningModes ? { mode: input.reasoningModes[0] ?? "standard" } : {})
      },
      stream: input.provider !== "openai",
      temperature: 1
    },
    displayName: input.displayName,
    modelId: input.modelId,
    parameterControls: {
      background: {
        defaultValue: Boolean(input.background),
        supported: Boolean(input.background)
      },
      maxOutputTokens: {
        defaultValue: input.maxTokens,
        maxValue: input.maxTokens
      },
      reasoningEffort: {
        defaultValue: input.reasoningDefault,
        options: input.reasoningOptions,
        supported: true
      },
      ...(input.reasoningModes
        ? {
            reasoningMode: {
              defaultValue: input.reasoningModes[0] ?? "standard",
              options: input.reasoningModes,
              supported: true
            }
          }
        : {}),
      stream: {
        defaultValue: input.provider !== "openai",
        supported: input.provider === "openai" || input.provider === "openrouter"
      },
      temperature: {
        defaultValue: 1,
        maxValue: input.temperatureSupported === false ? 1 : 2,
        minValue: 0,
        supported: input.temperatureSupported !== false
      }
    },
    provider: input.provider,
    providerFamily: input.provider,
    searchStrategyIds: ["search-disabled", "perplexity-tool-search"],
    upstreamModelId: input.modelId
  };
}

export const matrixCatalog = {
  defaults: {
    controlValues: {},
    hasPersonalModelDefault: true,
    modelId: "gpt-5.5",
    modelPreferenceSource: "personal" as const,
    organizationModelDefault: null,
    organizationSearchPlan: { mode: "all_selected", optionIds: [] },
    personalModelDefault: { modelId: "gpt-5.5", provider: "openai" },
    provider: "openai",
    searchPlan: { mode: "all_selected", optionIds: [] },
    searchPreferenceSource: "personal",
    searchStrategyId: "search-disabled",
    showCitations: true,
    showReasoningBlocks: false,
    showToolActivity: true,
  },
  models: [
    matrixModel({
      background: true,
      displayName: "GPT-5.5",
      maxTokens: 128000,
      modelId: "gpt-5.5",
      provider: "openai",
      reasoningDefault: "medium",
      reasoningOptions: ["none", "minimal", "low", "medium", "high", "xhigh"]
    }),
    matrixModel({
      background: true,
      displayName: "GPT-5.6 Sol",
      maxTokens: 128000,
      modelId: "gpt-5.6-sol",
      provider: "openai",
      reasoningDefault: "medium",
      reasoningModes: ["standard", "pro"],
      reasoningOptions: ["none", "low", "medium", "high", "xhigh", "max"]
    }),
    matrixModel({
      displayName: "Claude Opus 4.8",
      maxTokens: 128000,
      modelId: "claude-opus-4-8",
      provider: "anthropic",
      reasoningDefault: "high",
      reasoningOptions: ["low", "medium", "high", "xhigh", "max"],
      temperatureSupported: false
    }),
    matrixModel({
      displayName: "Claude Opus 4.8",
      maxTokens: 128000,
      modelId: "anthropic/claude-opus-4.8",
      provider: "openrouter",
      reasoningDefault: "high",
      reasoningOptions: ["low", "medium", "high", "xhigh", "max"],
      temperatureSupported: false
    }),
    matrixModel({
      displayName: "Gemini 3.5 Flash",
      maxTokens: 65536,
      modelId: "google/gemini-3.5-flash",
      provider: "openrouter",
      reasoningDefault: "medium",
      reasoningOptions: ["none", "minimal", "low", "medium", "high"]
    }),
    matrixModel({
      displayName: "Gemini Pro Latest",
      maxTokens: 65536,
      modelId: "~google/gemini-pro-latest",
      provider: "openrouter",
      reasoningDefault: "high",
      reasoningOptions: ["none", "minimal", "low", "medium", "high"]
    })
  ],
  providers: [
    {
      family: "openai",
      id: "openai",
      models: ["gpt-5.5", "gpt-5.6-sol"],
      name: "OpenAI"
    },
    {
      family: "anthropic",
      id: "anthropic",
      models: ["claude-opus-4-8"],
      name: "Anthropic"
    },
    {
      family: "openrouter",
      id: "openrouter",
      models: ["anthropic/claude-opus-4.8", "google/gemini-3.5-flash", "~google/gemini-pro-latest"],
      name: "OpenRouter"
    }
  ],
  searchStrategies: [
    {
      config: {},
      description: "No Search tool",
      displayName: "No Search",
      kind: "none",
      provider: "fake",
      strategyId: "search-disabled"
    },
    {
      config: {},
      description: "Provider-neutral Perplexity search tool",
      displayName: "Perplexity tool",
      kind: "perplexity_tool_search",
      modelId: "perplexity/sonar-pro-search",
      provider: "openrouter",
      strategyId: "perplexity-tool-search"
    }
  ]
};
