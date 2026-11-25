import { admittedOutputAllowance } from "./modelOutputAllowance";
import { dispatchSearchRequest } from "./searchDispatch";
import {
  adminSearchExecutionLimits
} from "../../contracts/adminSearch";
import {
  extractGeminiSearchUsage,
  normalizeGeminiInteractionsSearchResponse,
  withResolvedGeminiSearchSources
} from "./geminiInteractionsResponse";
import { GEMINI_GROUNDING_REDIRECT_LIMITS, resolveGeminiGroundingRedirects } from "./geminiGroundingRedirect";
import type { GeminiInteractionsClient } from "./geminiInteractionsTransport";
import { citedSearchSources } from "../search/evidence";
import { geminiConfiguredThinkingLevels } from "./providerModelCapabilities";
import {
  ProviderSearchExecutionError,
  type ProviderModelCapabilities,
  type ProviderSearchAdapter,
  type ProviderSearchRequest
} from "./types";

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
  /** Test seam: the grounding redirect resolver (`resolveGeminiGroundingRedirects`). */
  resolveRedirects?: (
    urls: readonly string[],
    options: Readonly<{ signal?: AbortSignal; totalTimeoutMs: number }>
  ) => Promise<ReadonlyMap<string, string>>;
}>;

/**
 * Redirect resolution runs inside the search's own deadline (the `timeoutMs`
 * the Search tool gives this attempt): it ends this long before it, so the
 * completed search is returned in time, and it is skipped when less than the
 * minimum window would remain. Skipped or cut short, the findings keep
 * Gemini's own links.
 */
export const GEMINI_REDIRECT_DEADLINE_MARGIN_MS = 1_000;
export const GEMINI_REDIRECT_MIN_WINDOW_MS = 500;

/** How long resolution may take, or null when it must be skipped. */
function redirectResolutionWindowMs(timeoutMs: number | undefined, startedAt: number): number | null {
  const ceiling = GEMINI_GROUNDING_REDIRECT_LIMITS.totalTimeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return ceiling;
  const left = timeoutMs - (performance.now() - startedAt) - GEMINI_REDIRECT_DEADLINE_MARGIN_MS;
  return left >= GEMINI_REDIRECT_MIN_WINDOW_MS ? Math.min(ceiling, Math.floor(left)) : null;
}

/** The resolved addresses, or none once the window ends, Stop is pressed or
 * the resolver fails: the completed search is returned either way. */
function withinWindow(
  resolution: Promise<ReadonlyMap<string, string>>,
  windowMs: number,
  signal: AbortSignal | undefined
): Promise<ReadonlyMap<string, string>> {
  const none: ReadonlyMap<string, string> = new Map();
  return new Promise((resolve) => {
    const finish = (value: ReadonlyMap<string, string>) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(none);
    const timer = setTimeout(onAbort, windowMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    resolution.then(finish, () => finish(none));
  });
}

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

/** Saved capability levels narrowed to the deployment's configured reasoning
 * control: a reviewed catalog model never receives a level its template
 * excludes, even when stale saved capabilities still list it. Catalog
 * deployments save no levels, so the control's lowest level applies; without
 * one the provider's default thinking may skip the search entirely. */
function lowestSupportedThinkingLevel(
  modelId: string,
  capabilities: ProviderModelCapabilities
): string | undefined {
  if (!capabilities.reasoning) return undefined;
  const configured = geminiConfiguredThinkingLevels(modelId, capabilities);
  if (!capabilities.reasoningEfforts?.length) return configured[0];
  const saved = new Set(capabilities.reasoningEfforts);
  return configured.find((level) => saved.has(level));
}

export function buildGeminiInteractionsSearchRequest(
  request: ProviderSearchRequest
): GeminiInteractionsSearchRequestBody {
  const policy = geminiSearchPolicy(request);
  const thinkingLevel = policy.reasoningPolicy === "lowest_supported"
    ? lowestSupportedThinkingLevel(policy.modelId.trim(), policy.modelCapabilities)
    : undefined;
  const body: GeminiInteractionsSearchRequestBody = {
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
  return request.generationBudget ? { ...body, generation_config: { ...body.generation_config,
    max_output_tokens: admittedOutputAllowance(request.generationBudget, body) } } : body;
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
  const resolveRedirects = options.resolveRedirects ??
    ((urls, { signal, totalTimeoutMs }) =>
      resolveGeminiGroundingRedirects(urls, { limits: { totalTimeoutMs }, ...(signal ? { signal } : {}) }));
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
      const startedAt = performance.now();
      const body = buildGeminiInteractionsSearchRequest(request);
      const response = await dispatchSearchRequest(searchOptions, {
        body, execute: () => options.client.createInteraction(body, {
          signal: searchOptions.signal,
          ...(typeof searchOptions.timeoutMs === "number"
            ? { timeoutMs: searchOptions.timeoutMs }
            : {})
        }), usage: extractGeminiSearchUsage
      });
      let normalized: ReturnType<typeof normalizeGeminiInteractionsSearchResponse>;
      try {
        normalized = normalizeGeminiInteractionsSearchResponse(response, {
          groundingExpected: true,
          modelId: body.model
        });
      } catch (error) {
        const providerStatus = safeProviderStatus(response);
        throw new ProviderSearchExecutionError({
          artifacts: [],
          code: safeFailureCode(error),
          ...(providerStatus ? { providerStatus } : {}),
          usage: extractGeminiSearchUsage(response)
        });
      }
      // Google's redirect links become the pages they name; resolution is
      // bounded by what the search's deadline leaves and never fails the
      // search (`geminiGroundingRedirect.ts`).
      const windowMs = redirectResolutionWindowMs(searchOptions.timeoutMs, startedAt);
      const resolved = windowMs === null || searchOptions.signal?.aborted
        ? new Map<string, string>()
        : await withinWindow(Promise.resolve().then(() => resolveRedirects(normalized.sources.map((source) => source.url), {
            ...(searchOptions.signal ? { signal: searchOptions.signal } : {}),
            totalTimeoutMs: windowMs
          })), windowMs, searchOptions.signal);
      const result = withResolvedGeminiSearchSources(normalized, resolved);
      return {
        ...result,
        requestPreview: adapter.buildRequestPreview(request),
        sourceAttribution: "available" as const,
        // Every grounding source is cited by the findings.
        sources: citedSearchSources(result.sources)
      };
    }
  };
  return adapter;
}
