import type { CatalogAdapterKind } from "../../domain/catalog";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import { normalizeOpenRouterParams } from "../../domain/providerParams";
import { applyProviderReasoningRequestMapping } from "./reasoningRequestMapping";
import type { OpenAIResponsesClient } from "./openaiResponsesTransport";
import { extractOpenAIUsage } from "./openaiResponsesResponse";
import {
  assertValidOpenRouterTerminalResponse,
  extractOpenRouterText,
  extractOpenRouterUsage
} from "./openRouterChatResponse";
import type { OpenRouterChatClient } from "./openRouterChatTransport";
import type { ProviderModelConfiguration } from "./providerConfiguration";

export const STRUCTURED_OUTPUT_SUPPORTED_ADAPTERS = [
  "openai_responses_native",
  "openai_responses_compatible",
  "openrouter_chat_completions"
] as const;

export type StructuredOutputAdapterKind =
  typeof STRUCTURED_OUTPUT_SUPPORTED_ADAPTERS[number];

export type ProviderStructuredOutputRequest = Readonly<{
  maxOutputTokens?: number;
  name: string;
  reasoningEffort?: string | null;
  schema: Readonly<Record<string, unknown>>;
  systemPrompt: string;
  userPrompt: string;
}>;

export type ProviderStructuredOutputOptions = Readonly<{
  onUsage?(usage: ModelRunUsage): void;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export type ProviderStructuredOutputAdapter = Readonly<{
  execute(
    request: ProviderStructuredOutputRequest,
    options?: ProviderStructuredOutputOptions
  ): Promise<Record<string, unknown>>;
}>;

export const STRUCTURED_OUTPUT_LIMITS = Object.freeze({
  maxNameCharacters: 64,
  maxOutputCharacters: 32_768,
  maxOutputTokens: 4_096,
  maxPromptCharacters: 64_000,
  maxSchemaBytes: 32 * 1024,
  minOutputTokens: 16
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function supportsStructuredOutputAdapter(
  adapterKind: CatalogAdapterKind | string
): adapterKind is StructuredOutputAdapterKind {
  return (STRUCTURED_OUTPUT_SUPPORTED_ADAPTERS as readonly string[]).includes(adapterKind);
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Infinity;
  }
}

const SCHEMA_CHILD_KEYS = new Set([
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then"
]);
const SCHEMA_CHILD_ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

/** OpenAI's strict-schema wire subset rejects `uniqueItems`. Keep uniqueness
 * in the provider-neutral contract and authoritative server decoder, while
 * removing only that unsupported annotation from schema nodes sent upstream. */
function schemaForProvider(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const visit = (node: unknown): unknown => {
    if (!isRecord(node)) return node;
    const mapped: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      if (key === "uniqueItems") continue;
      if (key === "properties" && isRecord(child)) {
        mapped[key] = Object.fromEntries(
          Object.entries(child).map(([propertyName, propertySchema]) => [
            propertyName,
            visit(propertySchema)
          ])
        );
      } else if (SCHEMA_CHILD_KEYS.has(key) && isRecord(child)) {
        mapped[key] = visit(child);
      } else if (SCHEMA_CHILD_ARRAY_KEYS.has(key) && Array.isArray(child)) {
        mapped[key] = child.map(visit);
      } else {
        mapped[key] = child;
      }
    }
    return mapped;
  };
  return visit(value) as Record<string, unknown>;
}

function normalizeRequest(
  request: ProviderStructuredOutputRequest
): Required<Omit<ProviderStructuredOutputRequest, "reasoningEffort">> &
  Pick<ProviderStructuredOutputRequest, "reasoningEffort"> {
  const maxOutputTokens = request.maxOutputTokens ?? 512;
  if (
    !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(request.name) ||
    request.name.length > STRUCTURED_OUTPUT_LIMITS.maxNameCharacters ||
    !isRecord(request.schema) ||
    jsonBytes(request.schema) > STRUCTURED_OUTPUT_LIMITS.maxSchemaBytes ||
    typeof request.systemPrompt !== "string" ||
    typeof request.userPrompt !== "string" ||
    !request.systemPrompt.trim() ||
    !request.userPrompt.trim() ||
    request.systemPrompt.length + request.userPrompt.length >
      STRUCTURED_OUTPUT_LIMITS.maxPromptCharacters ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < STRUCTURED_OUTPUT_LIMITS.minOutputTokens ||
    maxOutputTokens > STRUCTURED_OUTPUT_LIMITS.maxOutputTokens ||
    (request.reasoningEffort !== undefined && request.reasoningEffort !== null &&
      (typeof request.reasoningEffort !== "string" || !request.reasoningEffort.trim() ||
        request.reasoningEffort.length > 32))
  ) {
    throw new Error("structured_output_request_invalid");
  }
  return {
    maxOutputTokens,
    name: request.name,
    ...(request.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: request.reasoningEffort }),
    schema: request.schema,
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt
  };
}

function parseObject(text: string): Record<string, unknown> {
  if (
    !text.trim() ||
    text.length > STRUCTURED_OUTPUT_LIMITS.maxOutputCharacters ||
    Buffer.byteLength(text, "utf8") > STRUCTURED_OUTPUT_LIMITS.maxOutputCharacters * 4
  ) {
    throw new Error("structured_output_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("structured_output_invalid");
  }
  if (!isRecord(parsed)) throw new Error("structured_output_invalid");
  return parsed;
}

function openAIResponseText(response: Record<string, unknown>): string {
  if (response.status !== undefined && response.status !== "completed") {
    throw new Error("structured_output_provider_incomplete");
  }
  if (typeof response.output_text === "string") return response.output_text;
  const output = Array.isArray(response.output) ? response.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && content.type === "output_text" &&
        typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("");
}

export function buildOpenAIResponsesStructuredOutputRequest(
  model: Pick<ProviderModelConfiguration, "adapterKind" | "reasoningRequestMapping" | "upstreamModelId">,
  request: ProviderStructuredOutputRequest
): Record<string, unknown> {
  if (model.adapterKind !== "openai_responses_native" &&
    model.adapterKind !== "openai_responses_compatible") {
    throw new Error("structured_output_adapter_unsupported");
  }
  const normalized = normalizeRequest(request);
  const body: Record<string, unknown> = {
    background: false,
    input: [{
      content: [{ text: normalized.userPrompt, type: "input_text" }],
      role: "user"
    }],
    instructions: normalized.systemPrompt,
    max_output_tokens: normalized.maxOutputTokens,
    model: model.upstreamModelId,
    store: false,
    stream: false,
    text: {
      format: {
        name: normalized.name,
        schema: schemaForProvider(normalized.schema),
        strict: true,
        type: "json_schema"
      }
    }
  };
  if (normalized.reasoningEffort) {
    if (model.adapterKind === "openai_responses_compatible" &&
      model.reasoningRequestMapping) {
      applyProviderReasoningRequestMapping(body, model.reasoningRequestMapping, {
        effort: normalized.reasoningEffort
      });
    } else {
      body.reasoning = { effort: normalized.reasoningEffort };
    }
  }
  return body;
}

function openRouterProviderRouting(
  model: Pick<ProviderModelConfiguration, "defaultParams" | "openRouterRouting">
): Record<string, unknown> {
  const params = normalizeOpenRouterParams(model.defaultParams);
  const configured = model.openRouterRouting;
  const providers = configured?.providers ?? [];
  return {
    ...(params.provider.order.length > 0 ? { order: params.provider.order } : {}),
    ...(configured?.mode === "only_selected"
      ? { only: providers }
      : params.provider.only.length > 0 ? { only: params.provider.only } : {}),
    allow_fallbacks: params.provider.allowFallbacks,
    data_collection: params.provider.dataCollection,
    require_parameters: true,
    sort: params.provider.sort,
    ...(params.provider.zdr ? { zdr: true } : {})
  };
}

export function buildOpenRouterStructuredOutputRequest(
  model: Pick<ProviderModelConfiguration,
    "adapterKind" | "defaultParams" | "openRouterRouting" | "upstreamModelId">,
  request: ProviderStructuredOutputRequest
): Record<string, unknown> {
  if (model.adapterKind !== "openrouter_chat_completions") {
    throw new Error("structured_output_adapter_unsupported");
  }
  const normalized = normalizeRequest(request);
  const params = normalizeOpenRouterParams(model.defaultParams);
  return {
    max_completion_tokens: normalized.maxOutputTokens,
    messages: [
      { content: normalized.systemPrompt, role: "system" },
      { content: normalized.userPrompt, role: "user" }
    ],
    model: model.upstreamModelId,
    provider: openRouterProviderRouting(model),
    ...(normalized.reasoningEffort
      ? { reasoning: { effort: normalized.reasoningEffort } }
      : {}),
    response_format: {
      json_schema: {
        name: normalized.name,
        schema: schemaForProvider(normalized.schema),
        strict: true
      },
      type: "json_schema"
    },
    stream: false,
    ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {})
  };
}

export function createOpenAIResponsesStructuredOutputAdapter(input: Readonly<{
  client: OpenAIResponsesClient;
  model: Pick<ProviderModelConfiguration,
    "adapterKind" | "reasoningRequestMapping" | "upstreamModelId">;
}>): ProviderStructuredOutputAdapter {
  return {
    async execute(request, options) {
      const response = await input.client.create(
        buildOpenAIResponsesStructuredOutputRequest(input.model, request),
        options
      );
      const output = parseObject(openAIResponseText(response));
      options?.onUsage?.(extractOpenAIUsage(response));
      return output;
    }
  };
}

export function createOpenRouterStructuredOutputAdapter(input: Readonly<{
  client: OpenRouterChatClient;
  model: Pick<ProviderModelConfiguration,
    "adapterKind" | "defaultParams" | "openRouterRouting" | "upstreamModelId">;
}>): ProviderStructuredOutputAdapter {
  return {
    async execute(request, options) {
      const response = await input.client.createChatCompletion(
        buildOpenRouterStructuredOutputRequest(input.model, request),
        options
      );
      assertValidOpenRouterTerminalResponse(response);
      const output = parseObject(extractOpenRouterText(response));
      options?.onUsage?.(extractOpenRouterUsage(response));
      return output;
    }
  };
}
