import type { CatalogAdapterKind } from "../../domain/catalog";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import { normalizeOpenRouterParams } from "../../domain/providerParams";
import { applyProviderReasoningRequestMapping } from "./reasoningRequestMapping";
import type { OpenAIResponsesClient } from "./openaiResponsesTransport";
import type { DeepSeekResponsesClient } from "./deepSeekResponsesTransport";
import { extractOpenAIUsage } from "./openaiResponsesResponse";
import {
  assertValidOpenRouterTerminalResponse,
  extractOpenRouterUsage
} from "./openRouterChatResponse";
import type { OpenRouterChatClient } from "./openRouterChatTransport";
import type { ProviderModelConfiguration } from "./providerConfiguration";
import {
  STRUCTURED_OUTPUT_LIMITS,
  structuredOutputPromptFits
} from "./structuredOutputLimits";
import { openRouterChatToolBridge } from "../tools/bridges";

export { STRUCTURED_OUTPUT_LIMITS } from "./structuredOutputLimits";

export const STRUCTURED_OUTPUT_SUPPORTED_ADAPTERS = [
  "deepseek_responses_native",
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
  onProviderResponseId?(providerResponseId: string | null): void;
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

// Responses max_output_tokens and OpenRouter max_tokens include hidden
// reasoning tokens. A tiny schema payload can therefore be truncated before
// the required JSON or tool call exists. This is only a wire-budget floor: the
// accepted JSON remains bounded by the provider-neutral output-size limit and
// the strict schema.
const REASONING_STRUCTURED_OUTPUT_MIN_TOKENS = 1_024;

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
const SCHEMA_CHILD_ARRAY_KEYS = new Set(["allOf", "anyOf", "prefixItems"]);

const PROVIDER_ROOT_WRAPPER_KEY = "__aiqsa_payload";

type ProviderSchemaProjection = Readonly<{
  rootWrapped: boolean;
  schema: Record<string, unknown>;
}>;

function scalarConstKey(value: unknown): string | null {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return `${typeof value}:${JSON.stringify(value)}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `number:${JSON.stringify(value)}`;
  }
  return null;
}

/** `oneOf` and `anyOf` are equivalent only when at most one branch can match.
 * Prove that property here from the tuple of shared required scalar const
 * properties before projecting into the provider subset; otherwise fail
 * closed. A single discriminator is the common case, while contracts such as
 * `(decision, coverage)` require the joint tuple to distinguish every branch. */
function hasExclusiveConstDiscriminator(branches: readonly unknown[]): boolean {
  if (branches.length < 2 || !branches.every(isRecord)) return false;
  const records = branches as readonly Record<string, unknown>[];
  const firstProperties = records[0]?.properties;
  if (!isRecord(firstProperties)) return false;
  const discriminatorProperties = Object.keys(firstProperties).filter((propertyName) =>
    records.every((branch) => {
      if (!Array.isArray(branch.required) ||
        !branch.required.includes(propertyName) ||
        !isRecord(branch.properties)) return false;
      const property = branch.properties[propertyName];
      return isRecord(property) && Object.hasOwn(property, "const") &&
        scalarConstKey(property.const) !== null;
    })
  ).sort();
  if (discriminatorProperties.length === 0) return false;
  const signatures = records.map((branch) => discriminatorProperties.map((propertyName) => {
    const properties = branch.properties as Record<string, unknown>;
    const property = properties[propertyName] as Record<string, unknown>;
    return `${propertyName}:${scalarConstKey(property.const)!}`;
  }).join("\u0000"));
  return new Set(signatures).size === records.length;
}

/** Project the provider-neutral schema into the portable strict-schema wire
 * subset used by Responses-compatible and OpenRouter transports. The
 * canonical schema and authoritative server decoder retain `oneOf`
 * exclusivity and `uniqueItems`; the provider wire subset supports `anyOf`
 * but requires an object root. */
function schemaForProvider(
  value: Readonly<Record<string, unknown>>
): ProviderSchemaProjection {
  const visit = (node: unknown): unknown => {
    if (!isRecord(node)) return node;
    const mapped: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      if (key === "uniqueItems") continue;
      if (key === "oneOf") {
        if (!Array.isArray(child) || Object.hasOwn(node, "anyOf") ||
          !hasExclusiveConstDiscriminator(child)) {
          throw new Error("structured_output_schema_unsupported");
        }
        mapped.anyOf = child.map(visit);
        continue;
      }
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
  const projected = visit(value) as Record<string, unknown>;
  const rootWrapped = Array.isArray(value.oneOf) || Array.isArray(value.anyOf);
  const schema = rootWrapped
    ? {
        additionalProperties: false,
        properties: {
          [PROVIDER_ROOT_WRAPPER_KEY]: projected
        },
        required: [PROVIDER_ROOT_WRAPPER_KEY],
        type: "object"
      }
    : projected;
  if (jsonBytes(schema) > STRUCTURED_OUTPUT_LIMITS.maxSchemaBytes) {
    throw new Error("structured_output_request_invalid");
  }
  return { rootWrapped, schema };
}

function decodeProviderStructuredOutput(
  request: ProviderStructuredOutputRequest,
  output: Record<string, unknown>
): Record<string, unknown> {
  if (!schemaForProvider(request.schema).rootWrapped) return output;
  if (Object.keys(output).length !== 1 ||
    !Object.hasOwn(output, PROVIDER_ROOT_WRAPPER_KEY) ||
    !isRecord(output[PROVIDER_ROOT_WRAPPER_KEY])) {
    throw new Error("structured_output_invalid");
  }
  return output[PROVIDER_ROOT_WRAPPER_KEY];
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
    !structuredOutputPromptFits(request) ||
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

export function parseProviderStructuredOutputObject(text: string): Record<string, unknown> {
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

function boundedProviderResponseId(value: unknown): string | null {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,255}$/u.test(value)
    ? value
    : null;
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
  const maxOutputTokens = normalized.reasoningEffort &&
    normalized.reasoningEffort !== "none"
    ? Math.max(
        normalized.maxOutputTokens,
        REASONING_STRUCTURED_OUTPUT_MIN_TOKENS
      )
    : normalized.maxOutputTokens;
  const body: Record<string, unknown> = {
    ...(model.adapterKind === "openai_responses_native" ? { background: false } : {}),
    input: [{
      content: [{ text: normalized.userPrompt, type: "input_text" }],
      role: "user"
    }],
    instructions: normalized.systemPrompt,
    max_output_tokens: maxOutputTokens,
    model: model.upstreamModelId,
    store: false,
    stream: false,
    text: {
      format: {
        name: normalized.name,
        schema: schemaForProvider(normalized.schema).schema,
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

export function buildDeepSeekResponsesStructuredOutputRequest(
  model: Pick<ProviderModelConfiguration, "adapterKind" | "upstreamModelId">,
  request: ProviderStructuredOutputRequest
): Record<string, unknown> {
  if (model.adapterKind !== "deepseek_responses_native") {
    throw new Error("structured_output_adapter_unsupported");
  }
  const normalized = normalizeRequest(request);
  const maxOutputTokens = normalized.reasoningEffort &&
    normalized.reasoningEffort !== "none"
    ? Math.max(normalized.maxOutputTokens, REASONING_STRUCTURED_OUTPUT_MIN_TOKENS)
    : normalized.maxOutputTokens;
  return {
    input: [{
      content: [{ text: normalized.userPrompt, type: "input_text" }],
      role: "user"
    }],
    instructions: normalized.systemPrompt,
    max_output_tokens: maxOutputTokens,
    model: model.upstreamModelId,
    ...(normalized.reasoningEffort
      ? { reasoning: { effort: normalized.reasoningEffort } }
      : {}),
    stream: false,
    text: {
      format: {
        name: normalized.name,
        schema: schemaForProvider(normalized.schema).schema,
        strict: true,
        type: "json_schema"
      }
    }
  };
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
  const reasoningDisabled = normalized.reasoningEffort === "none";
  const reasoningActive = !reasoningDisabled && (
    params.reasoning.enabled || Boolean(normalized.reasoningEffort) ||
      params.reasoning.maxTokens > 0
  );
  const maxTokens = reasoningActive || params.reasoning.exclude
    ? Math.max(
        normalized.maxOutputTokens,
        REASONING_STRUCTURED_OUTPUT_MIN_TOKENS
      )
    : normalized.maxOutputTokens;
  const reasoning: Record<string, unknown> = {};
  if (reasoningActive) reasoning.enabled = true;
  const effort = reasoningDisabled ? null : normalized.reasoningEffort ??
    (params.reasoning.enabled ? params.reasoning.effort : null);
  if (effort && effort !== "none") reasoning.effort = effort;
  if (params.reasoning.exclude) reasoning.exclude = true;
  if (!reasoningDisabled && params.reasoning.maxTokens > 0) {
    reasoning.max_tokens = params.reasoning.maxTokens;
  }
  return {
    max_tokens: maxTokens,
    messages: [
      {
        content: [
          normalized.systemPrompt,
          "Call the single supplied function exactly once and do not return a free-form answer."
        ].join("\n\n"),
        role: "system"
      },
      { content: normalized.userPrompt, role: "user" }
    ],
    model: model.upstreamModelId,
    provider: openRouterProviderRouting(model),
    ...(Object.keys(reasoning).length > 0 ? { reasoning } : {}),
    stream: false,
    tool_choice: params.provider.structuredOutputToolChoice ?? "required",
    tools: [{
      function: {
        description: "Return the structured result required by the system instruction.",
        name: normalized.name,
        parameters: schemaForProvider(normalized.schema).schema,
        strict: true
      },
      type: "function"
    }],
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
      const responseText = openAIResponseText(response);
      options?.onProviderResponseId?.(boundedProviderResponseId(response.id));
      if (isRecord(response.usage)) {
        options?.onUsage?.(extractOpenAIUsage(response));
      }
      return decodeProviderStructuredOutput(
        request,
        parseProviderStructuredOutputObject(responseText)
      );
    }
  };
}

export function createDeepSeekResponsesStructuredOutputAdapter(input: Readonly<{
  client: DeepSeekResponsesClient;
  model: Pick<ProviderModelConfiguration, "adapterKind" | "upstreamModelId">;
}>): ProviderStructuredOutputAdapter {
  return {
    async execute(request, options) {
      const response = await input.client.create(
        buildDeepSeekResponsesStructuredOutputRequest(input.model, request),
        options
      );
      const responseText = openAIResponseText(response);
      options?.onProviderResponseId?.(boundedProviderResponseId(response.id));
      if (isRecord(response.usage)) {
        options?.onUsage?.(extractOpenAIUsage(response));
      }
      return decodeProviderStructuredOutput(
        request,
        parseProviderStructuredOutputObject(responseText)
      );
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
      assertValidOpenRouterTerminalResponse(response, { allowToolCalls: true });
      options?.onProviderResponseId?.(boundedProviderResponseId(response.id));
      if (isRecord(response.usage)) {
        options?.onUsage?.(extractOpenRouterUsage(response));
      }
      let calls;
      try {
        calls = openRouterChatToolBridge.parseToolCalls(response);
      } catch {
        throw new Error("structured_output_invalid");
      }
      if (calls.length !== 1 || calls[0]?.name !== request.name ||
        !isRecord(calls[0].arguments) ||
        jsonBytes(calls[0].arguments) > STRUCTURED_OUTPUT_LIMITS.maxOutputCharacters * 4) {
        throw new Error("structured_output_invalid");
      }
      return decodeProviderStructuredOutput(request, calls[0].arguments);
    }
  };
}
