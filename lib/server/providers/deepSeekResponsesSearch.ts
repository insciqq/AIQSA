import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { adminSearchExecutionLimits } from "../../contracts/adminSearch";
import {
  deepSeekResponseError,
  type DeepSeekResponsesClient
} from "./deepSeekResponsesTransport";
import {
  extractOpenAIUsage,
  normalizeCompletedOpenAIResponse,
  openAIResponseStatus
} from "./openaiResponsesResponse";
import {
  normalizeSearchFindings
} from "../search/evidence";
import {
  ProviderSearchExecutionError,
  type ProviderModelCapabilities,
  type ProviderSearchAdapter,
  type ProviderSearchRequest
} from "./types";

const effortOrder = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type DeepSeekResponsesSearchRequestBody = Readonly<{
  input: readonly [{
    content: readonly [{ text: string; type: "input_text" }];
    role: "user";
  }];
  instructions: string;
  max_output_tokens: number;
  model: string;
  reasoning?: Readonly<{ effort: string }>;
  stream: false;
  tool_choice: "auto";
  tools: readonly [{ type: "web_search" }];
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

function policy(request: ProviderSearchRequest) {
  const value = request.searchPolicy;
  if (
    value.provider !== "deepseek" ||
    value.strategyId !== "deepseek-responses-web-search" ||
    !boundedString(value.modelId, 256) ||
    !Number.isSafeInteger(value.maxOutputTokens) ||
    value.maxOutputTokens < adminSearchExecutionLimits.maxOutputTokens.minimum ||
    value.maxOutputTokens > adminSearchExecutionLimits.maxOutputTokens.maximum ||
    (value.reasoningPolicy !== "lowest_supported" &&
      value.reasoningPolicy !== "provider_default")
  ) {
    throw new Error("deepseek_search_policy_invalid");
  }
  return value;
}

function lowestSupportedEffort(capabilities: ProviderModelCapabilities): string | undefined {
  if (!capabilities.reasoning) return undefined;
  const supported = new Set(capabilities.reasoningEfforts ?? []);
  return effortOrder.find((effort) => supported.has(effort));
}

export function buildDeepSeekResponsesSearchRequest(
  request: ProviderSearchRequest
): DeepSeekResponsesSearchRequestBody {
  const configured = policy(request);
  const effort = configured.reasoningPolicy === "lowest_supported"
    ? lowestSupportedEffort(configured.modelCapabilities)
    : undefined;
  return {
    input: [{
      content: [{ text: request.query, type: "input_text" }],
      role: "user"
    }],
    instructions: "Use the web_search tool for the query and return concise findings.",
    max_output_tokens: configured.maxOutputTokens,
    model: configured.modelId.trim(),
    ...(effort ? { reasoning: { effort } } : {}),
    stream: false,
    tool_choice: "auto",
    tools: [{ type: "web_search" }]
  };
}

function searchArtifacts(response: Readonly<Record<string, unknown>>): ModelRunSseEvent[] {
  const output = Array.isArray(response.output) ? response.output : [];
  return output.flatMap((item, outputIndex): ModelRunSseEvent[] => {
    if (!isRecord(item) || item.type !== "web_search_call") return [];
    const id = boundedString(item.id, 256);
    const status = boundedString(item.status, 64);
    return [{
      data: {
        artifactType: "search",
        payload: {
          ...(id ? { id } : {}),
          outputIndex,
          provider: "deepseek",
          sourceAttribution: "provider_unavailable",
          ...(status ? { status } : {}),
          type: "web_search_call"
        }
      },
      type: "artifact"
    }];
  }).slice(0, 32);
}

function searchOperationCount(response: Readonly<Record<string, unknown>>): number {
  const output = Array.isArray(response.output) ? response.output : [];
  return output.filter((item) => isRecord(item) && item.type === "web_search_call").length;
}

function failureCode(status: string): string {
  return status === "incomplete" || status === "failed" || status === "cancelled"
    ? `deepseek_response_${status}`
    : "deepseek_response_not_completed";
}

export function createDeepSeekResponsesSearchAdapter(input: Readonly<{
  client: DeepSeekResponsesClient;
}>): ProviderSearchAdapter {
  const adapter: ProviderSearchAdapter = {
    buildRequestPreview(request) {
      const body = buildDeepSeekResponsesSearchRequest(request);
      return {
        body: {
          max_output_tokens: body.max_output_tokens,
          model: body.model,
          reasoning: body.reasoning,
          stream: false,
          tool: "web_search",
          tool_choice: "auto"
        },
        provider: "deepseek",
        queryCharacters: request.query.length,
        redactions: ["search_query"],
        stage: "tool_search"
      };
    },
    async search(request, options = {}) {
      const response = await input.client.create(
        buildDeepSeekResponsesSearchRequest(request),
        {
          signal: options.signal,
          ...(typeof options.timeoutMs === "number" ? { timeoutMs: options.timeoutMs } : {})
        }
      );
      const status = openAIResponseStatus(response);
      const artifacts = searchArtifacts(response);
      const usage = extractOpenAIUsage(response);
      if (status !== "completed") {
        throw new ProviderSearchExecutionError({
          artifacts,
          code: failureCode(status),
          ...(status === "unknown" ? {} : { providerStatus: status }),
          usage
        });
      }
      const operationCount = searchOperationCount(response);
      if (operationCount === 0) {
        throw new ProviderSearchExecutionError({
          artifacts,
          code: "deepseek_search_operation_missing",
          providerStatus: status,
          usage
        });
      }
      const providerResponseId = boundedString(response.id, 256);
      let completed;
      try {
        completed = normalizeCompletedOpenAIResponse(
          response,
          providerResponseId,
          "deepseek"
        );
      } catch (error) {
        throw deepSeekResponseError(error);
      }
      let findings: string;
      try {
        findings = normalizeSearchFindings(completed.result.finalText);
      } catch {
        throw new ProviderSearchExecutionError({
          artifacts,
          code: "deepseek_search_findings_invalid",
          usage
        });
      }
      return {
        artifacts,
        finalProviderResponsePreview: {
          findingsCharacters: findings.length,
          operationCount,
          provider: "deepseek",
          sourceAttribution: "provider_unavailable",
          sourceCount: 0,
          status,
          usage
        },
        findings,
        ...(providerResponseId ? { providerResponseId } : {}),
        requestPreview: adapter.buildRequestPreview(request),
        sourceAttribution: "provider_unavailable",
        sources: [],
        usage
      };
    }
  };
  return adapter;
}
