import {
  adminSearchExecutionLimits
} from "../../contracts/adminSearch";
import {
  extractGeminiInteractionsUsage,
  normalizeGeminiInteractionsSearchResponse
} from "./geminiInteractionsResponse";
import type { GeminiInteractionsClient } from "./geminiInteractionsTransport";
import {
  ProviderSearchExecutionError,
  type ProviderModelCapabilities,
  type ProviderSearchAdapter,
  type ProviderSearchRequest
} from "./types";

const thinkingLevelOrder = ["minimal", "low", "medium", "high"] as const;

export type GeminiInteractionsSearchRequestBody = Readonly<{
  generation_config: Readonly<{
    max_output_tokens: number;
    thinking_level?: string;
    thinking_summaries: "none";
    tool_choice: "auto";
  }>;
  input: readonly [{
    content: readonly [{ text: string; type: "text" }];
    type: "user_input";
  }];
  model: string;
  store: false;
  stream: false;
  system_instruction: string;
  tools: readonly [{ type: "google_search" }];
}>;

export type GeminiInteractionsSearchAdapterOptions = Readonly<{
  client: GeminiInteractionsClient;
}>;

function boundedModelId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function geminiSearchPolicy(request: ProviderSearchRequest) {
  const policy = request.searchPolicy;
  if (
    policy.provider !== "gemini" ||
    policy.strategyId !== "gemini-google-search" ||
    !boundedModelId(policy.modelId) ||
    !Number.isSafeInteger(policy.maxOutputTokens) ||
    policy.maxOutputTokens < adminSearchExecutionLimits.maxOutputTokens.minimum ||
    policy.maxOutputTokens > adminSearchExecutionLimits.maxOutputTokens.maximum ||
    (policy.reasoningPolicy !== "lowest_supported" &&
      policy.reasoningPolicy !== "provider_default")
  ) {
    throw new Error("gemini_search_policy_invalid");
  }
  return policy;
}

function lowestSupportedThinkingLevel(
  capabilities: ProviderModelCapabilities
): string | undefined {
  if (!capabilities.reasoning) return undefined;
  const supported = new Set(capabilities.reasoningEfforts ?? []);
  return thinkingLevelOrder.find((level) => supported.has(level));
}

export function buildGeminiInteractionsSearchRequest(
  request: ProviderSearchRequest
): GeminiInteractionsSearchRequestBody {
  const policy = geminiSearchPolicy(request);
  const thinkingLevel = policy.reasoningPolicy === "lowest_supported"
    ? lowestSupportedThinkingLevel(policy.modelCapabilities)
    : undefined;
  return {
    generation_config: {
      max_output_tokens: policy.maxOutputTokens,
      ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
      thinking_summaries: "none",
      tool_choice: "auto"
    },
    input: [{
      content: [{ text: request.query, type: "text" }],
      type: "user_input"
    }],
    model: policy.modelId.trim(),
    store: false,
    stream: false,
    system_instruction: "Use Google Search for the query and return concise source-backed findings.",
    tools: [{ type: "google_search" }]
  };
}

function safeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[a-z][a-z0-9_]{0,127}$/u.test(message)
    ? message
    : "gemini_search_response_invalid";
}

function safeProviderStatus(response: Readonly<Record<string, unknown>>): string | undefined {
  return response.status === "failed" || response.status === "cancelled" ||
    response.status === "incomplete" || response.status === "requires_action"
    ? response.status
    : undefined;
}

export function createGeminiInteractionsSearchAdapter(
  options: GeminiInteractionsSearchAdapterOptions
): ProviderSearchAdapter {
  const adapter: ProviderSearchAdapter = {
    buildRequestPreview(request) {
      const body = buildGeminiInteractionsSearchRequest(request);
      return {
        body: {
          generation_config: body.generation_config,
          model: body.model,
          store: body.store,
          stream: body.stream,
          tool: "google_search"
        },
        provider: "gemini",
        queryCharacters: request.query.length,
        redactions: [
          "search_query",
          "grounding_suggestions",
          "provider_signatures",
          "provider_response_body"
        ],
        stage: "tool_search"
      };
    },
    async search(request, searchOptions = {}) {
      const body = buildGeminiInteractionsSearchRequest(request);
      const response = await options.client.createInteraction(body, {
        signal: searchOptions.signal,
        ...(typeof searchOptions.timeoutMs === "number"
          ? { timeoutMs: searchOptions.timeoutMs }
          : {})
      });
      try {
        return {
          ...normalizeGeminiInteractionsSearchResponse(response, {
            groundingExpected: true,
            modelId: body.model
          }),
          requestPreview: adapter.buildRequestPreview(request),
          sourceAttribution: "available" as const
        };
      } catch (error) {
        const providerStatus = safeProviderStatus(response);
        throw new ProviderSearchExecutionError({
          artifacts: [],
          code: safeFailureCode(error),
          ...(providerStatus ? { providerStatus } : {}),
          usage: extractGeminiInteractionsUsage(response.usage)
        });
      }
    }
  };
  return adapter;
}
