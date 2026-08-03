import { safeExternalHref } from "../../domain/links";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import {
  OPENAI_RESPONSES_REASONING_REQUEST_MAPPING,
  type ProviderReasoningRequestMapping
} from "../../contracts/providerReasoningRequestMapping";
import {
  applyProviderReasoningRequestMapping,
  isCanonicalResponsesReasoningRequestMapping
} from "./reasoningRequestMapping";
import {
  extractOpenAIUsage,
  normalizeCompletedOpenAIResponse,
  openAIResponseStatus
} from "./openaiResponsesResponse";
import type { OpenAIResponsesClient } from "./openaiResponsesTransport";
import {
  normalizeSearchFindings,
  normalizeSearchSources,
  searchSourcesFromCitationArtifacts
} from "../search/evidence";
import {
  ProviderSearchExecutionError,
  type ProviderModelCapabilities,
  type ProviderSearchAdapter,
  type ProviderSearchRequest,
  type ProviderSearchResult
} from "./types";

export const OPENAI_RESPONSES_SEARCH_DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
export const OPENAI_RESPONSES_SEARCH_MIN_OUTPUT_TOKENS = 1_024;
export const OPENAI_RESPONSES_SEARCH_MAX_OUTPUT_TOKENS = 32_768;

const effortOrder = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const operationLimit = 32;
const operationStringLimit = 512;
const operationUrlLimit = 2_048;

type OpenAIResponsesSearchProvider = "openai" | "openai_compatible";

export type OpenAIResponsesSearchRequestBody = Readonly<{
  background: false;
  include: readonly ["web_search_call.action.sources"];
  input: readonly [{
    content: readonly [{ text: string; type: "input_text" }];
    role: "user";
  }];
  instructions: string;
  max_output_tokens: number;
  model: string;
  reasoning?: Readonly<{ effort: string }>;
  store: false;
  stream: false;
  tool_choice: "auto";
  tools: readonly [{ type: "web_search" }];
}>;

export type OpenAIResponsesSearchAdapterOptions = Readonly<{
  client: OpenAIResponsesClient;
  provider: OpenAIResponsesSearchProvider;
  reasoningRequestMapping?: ProviderReasoningRequestMapping;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : undefined;
}

function safeOperationHttpHref(value: unknown): string | undefined {
  const href = safeExternalHref(value);
  if (!href || href.length > operationUrlLimit) return undefined;
  try {
    const url = new URL(href);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
      ? href
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizedProviderLabel(provider: OpenAIResponsesSearchProvider): string {
  return provider === "openai" ? "openai" : "openai-compatible";
}

function openAISearchPolicy(request: ProviderSearchRequest) {
  const policy = request.searchPolicy;
  if (
    (policy.provider !== "openai" && policy.provider !== "openai_compatible") ||
    policy.strategyId !== "openai-responses-web-search" ||
    !boundedString(policy.modelId, 256) ||
    !boundedString(request.strategyId, 512) ||
    !Number.isSafeInteger(policy.maxOutputTokens) ||
    policy.maxOutputTokens < OPENAI_RESPONSES_SEARCH_MIN_OUTPUT_TOKENS ||
    policy.maxOutputTokens > OPENAI_RESPONSES_SEARCH_MAX_OUTPUT_TOKENS ||
    (policy.reasoningPolicy !== "lowest_supported" &&
      policy.reasoningPolicy !== "provider_default")
  ) {
    throw new Error("openai_search_policy_invalid");
  }
  return policy;
}

export function lowestSupportedOpenAIResponsesSearchEffort(
  capabilities: ProviderModelCapabilities
): string | undefined {
  if (!capabilities.reasoning) return undefined;
  const supported = new Set(
    Array.isArray(capabilities.reasoningEfforts)
      ? capabilities.reasoningEfforts.filter((value): value is string =>
          typeof value === "string" && value.trim().length > 0)
      : []
  );
  return effortOrder.find((effort) => supported.has(effort));
}

export function buildOpenAIResponsesSearchRequest(
  request: ProviderSearchRequest
): OpenAIResponsesSearchRequestBody {
  const policy = openAISearchPolicy(request);
  const effort = policy.reasoningPolicy === "lowest_supported"
    ? lowestSupportedOpenAIResponsesSearchEffort(policy.modelCapabilities)
    : undefined;
  return {
    background: false,
    include: ["web_search_call.action.sources"],
    input: [{
      content: [{ text: request.query, type: "input_text" }],
      role: "user"
    }],
    instructions: "Search the web for the query. Return concise source-backed findings.",
    max_output_tokens: policy.maxOutputTokens,
    model: policy.modelId.trim(),
    ...(effort ? { reasoning: { effort } } : {}),
    store: false,
    stream: false,
    tool_choice: "auto",
    tools: [{ type: "web_search" }]
  };
}

function compatibleBody(
  body: OpenAIResponsesSearchRequestBody,
  mapping: ProviderReasoningRequestMapping
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...body };
  if (body.reasoning && !isCanonicalResponsesReasoningRequestMapping(mapping)) {
    delete output.reasoning;
    applyProviderReasoningRequestMapping(output, mapping, {
      effort: body.reasoning.effort
    });
  }
  return output;
}

function requestBody(
  request: ProviderSearchRequest,
  options: OpenAIResponsesSearchAdapterOptions
): Record<string, unknown> {
  const policy = openAISearchPolicy(request);
  if (policy.provider !== options.provider) {
    throw new Error("openai_search_policy_invalid");
  }
  const body = buildOpenAIResponsesSearchRequest(request);
  return options.provider === "openai"
    ? { ...body }
    : compatibleBody(
        body,
        options.reasoningRequestMapping ?? OPENAI_RESPONSES_REASONING_REQUEST_MAPPING
      );
}

function safeAction(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const type = value.type === "search" || value.type === "open_page" || value.type === "find_in_page"
    ? value.type
    : undefined;
  const query = boundedString(value.query, operationStringLimit);
  const pattern = boundedString(value.pattern, operationStringLimit);
  const url = safeOperationHttpHref(value.url);
  const queries = Array.isArray(value.queries)
    ? value.queries.flatMap((candidate) => {
        const normalized = boundedString(candidate, operationStringLimit);
        return normalized ? [normalized] : [];
      }).slice(0, 8)
    : [];
  const action = {
    ...(type ? { type } : {}),
    ...(query ? { query } : {}),
    ...(queries.length ? { queries } : {}),
    ...(pattern ? { pattern } : {}),
    ...(url ? { url } : {})
  };
  return Object.keys(action).length ? action : undefined;
}

function operationTruncationMarker(provider: OpenAIResponsesSearchProvider): ModelRunSseEvent {
  return {
    data: {
      artifactType: "search",
      payload: {
        outputIndex: Number.MAX_SAFE_INTEGER,
        provider: normalizedProviderLabel(provider),
        type: "web_search_call"
      }
    },
    type: "artifact"
  };
}

function safeSearchArtifacts(
  response: Readonly<Record<string, unknown>>,
  provider: OpenAIResponsesSearchProvider
): ModelRunSseEvent[] {
  const output = Array.isArray(response.output) ? response.output : [];
  const artifacts: ModelRunSseEvent[] = [];
  let truncated = false;
  for (const [outputIndex, item] of output.entries()) {
    if (!isRecord(item) || item.type !== "web_search_call") {
      continue;
    }
    if (artifacts.length >= operationLimit) {
      truncated = true;
      break;
    }
    const id = boundedString(item.id, 256);
    const status = boundedString(item.status, 64);
    const action = safeAction(item.action);
    artifacts.push({
      data: {
        artifactType: "search",
        payload: {
          ...(action ? { action } : {}),
          ...(id ? { id } : {}),
          outputIndex,
          provider: normalizedProviderLabel(provider),
          ...(status ? { status } : {}),
          type: "web_search_call"
        }
      },
      type: "artifact"
    });
  }
  if (truncated) artifacts.push(operationTruncationMarker(provider));
  return artifacts;
}

function safeActionSources(response: Readonly<Record<string, unknown>>) {
  const output = Array.isArray(response.output) ? response.output : [];
  return normalizeSearchSources(output.flatMap((item) =>
    isRecord(item) && item.type === "web_search_call" && isRecord(item.action) &&
      Array.isArray(item.action.sources)
      ? item.action.sources
      : []
  ), 20);
}

function incompleteReason(response: Readonly<Record<string, unknown>>): string | undefined {
  if (openAIResponseStatus(response) !== "incomplete" || !isRecord(response.incomplete_details)) {
    return undefined;
  }
  const reason = response.incomplete_details.reason;
  return reason === "max_output_tokens" || reason === "content_filter" ? reason : undefined;
}

function responseId(response: Readonly<Record<string, unknown>>): string | undefined {
  return boundedString(response.id, 256);
}

function failureCode(status: string): string {
  return status === "incomplete" || status === "failed" || status === "cancelled"
    ? `openai_response_${status}`
    : "openai_response_not_completed";
}

export function createOpenAIResponsesSearchAdapter(
  options: OpenAIResponsesSearchAdapterOptions
): ProviderSearchAdapter {
  const adapter: ProviderSearchAdapter = {
    buildRequestPreview(request) {
      const canonicalBody = buildOpenAIResponsesSearchRequest(request);
      const body = requestBody(request, options);
      return {
        body: {
          background: body.background,
          max_output_tokens: body.max_output_tokens,
          model: body.model,
          reasoning: canonicalBody.reasoning,
          store: body.store,
          stream: body.stream,
          tool: "web_search"
        },
        provider: normalizedProviderLabel(options.provider),
        queryCharacters: request.query.length,
        redactions: ["search_query"],
        stage: "tool_search"
      };
    },
    async search(request, searchOptions = {}): Promise<ProviderSearchResult> {
      const body = requestBody(request, options);
      const response = await options.client.create(body, {
        signal: searchOptions.signal,
        ...(typeof searchOptions.timeoutMs === "number"
          ? { timeoutMs: searchOptions.timeoutMs }
          : {})
      });
      const status = openAIResponseStatus(response);
      if (status !== "completed") {
        const reason = incompleteReason(response);
        throw new ProviderSearchExecutionError({
          artifacts: safeSearchArtifacts(response, options.provider),
          code: failureCode(status),
          ...(status === "unknown" ? {} : { providerStatus: status }),
          ...(reason ? { reason } : {}),
          usage: extractOpenAIUsage(response)
        });
      }

      const providerResponseId = responseId(response);
      const completed = normalizeCompletedOpenAIResponse(
        response,
        providerResponseId,
        normalizedProviderLabel(options.provider)
      );
      const artifacts = [
        ...safeSearchArtifacts(response, options.provider),
        ...completed.events.filter((event) =>
          event.type === "artifact" && event.data.artifactType !== "search"
        )
      ];
      let findings: string;
      try {
        findings = normalizeSearchFindings(completed.result.finalText);
      } catch {
        throw new ProviderSearchExecutionError({
          artifacts,
          code: "openai_search_findings_invalid",
          usage: completed.result.usage
        });
      }
      return {
        artifacts,
        finalProviderResponsePreview: completed.result.finalProviderResponsePreview,
        findings,
        ...(providerResponseId ? { providerResponseId } : {}),
        requestPreview: adapter.buildRequestPreview(request),
        sources: normalizeSearchSources([
          ...safeActionSources(response),
          ...searchSourcesFromCitationArtifacts(artifacts)
        ], 20),
        usage: completed.result.usage
      };
    }
  };
  return adapter;
}
