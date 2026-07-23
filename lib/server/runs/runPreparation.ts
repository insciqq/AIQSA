import { textMessageContent } from "../../domain/content";
import { parameterControlsForModel } from "../../domain/catalog";
import type { ContextTruncationSummary } from "../../domain/contextBudget";
import {
  invalidRunParamsError,
  validateRunParams,
  validateSearchRunParams
} from "../../domain/runParams";
import {
  canonicalizeMaxOutputTokenParams,
  normalizeOpenRouterParams
} from "../../domain/providerParams";
import { validateRunAccess } from "../auth/entitlements";
import type {
  NormalizedRunRequest,
  ProviderAdapter,
  ProviderAttachment,
  ProviderConversationMessage,
  ProviderModelCapabilities,
  ProviderRunRequest,
  ProviderSearchAdapter,
  ProviderSearchPolicy
} from "../providers/types";
import type { StorageAdapter } from "../uploads/storage";
import type { McpRunPlanBinding, McpRunPlanResult } from "../mcp/runPlan";
import { mcpRunTools } from "../mcp/toolExecutor";
import { providerToolBridges } from "../tools/bridges";
import { perplexityWebSearchTool } from "../tools/perplexitySearch";
import { applyProviderRequestContextBudget } from "./runContextBudget";
import type {
  AcceptedRunDefaults,
  RunModelConfiguration,
  RunRepository,
  RunSearchStrategyConfiguration
} from "./runRepositoryContract";

const visibleAnswerContract =
  "Visible answer contract: answer the user directly in the chat message. Do not include debug sections such as Question, Search, Provider Parameters, Request Preview, Artifacts, Usage, or Errors. Provider/search/request/usage/error details are displayed by AIQSA Details summaries or model-run APIs. Include citations naturally only when they help the answer.";
const perplexityToolSearchStrategyId = "perplexity-tool-search";
const currentSendMessageId = "current-user-message";

type RunPreparationRepository = Pick<
  RunRepository,
  | "isPromptPresetAvailable"
  | "loadAttachments"
  | "loadConversationContextForExpectedLeaf"
  | "loadConversationContextForLeaf"
  | "loadEntitlements"
  | "loadModelConfiguration"
  | "loadSearchStrategyConfiguration"
  | "isSearchStrategyEnabled"
>;

export type RunPreparationDeps = Readonly<{
  mcp?: Readonly<{
    prepare(userId: string): Promise<McpRunPlanResult>;
  }>;
  providers: Readonly<Record<string, ProviderAdapter>>;
  repository: RunPreparationRepository;
  searchProviders?: Readonly<Record<string, ProviderSearchAdapter>>;
  storage?: Pick<StorageAdapter, "getObject">;
}>;

export type SendRunPreparationSource = Readonly<{
  chat: Readonly<{
    activeLeafMessageId: string | null;
    defaultModelId: string;
    defaultProvider: string;
    id: string;
    projectMemory: string | null;
  }>;
  kind: "send";
}>;

export type RegenerateRunPreparationSource = Readonly<{
  kind: "regenerate";
  source: Readonly<{
    assistantMessage: Readonly<{
      modelId: string | null;
      provider: string | null;
    }>;
    chat: Readonly<{
      defaultModelId: string;
      defaultProvider: string;
      id: string;
      projectMemory: string | null;
    }>;
    userMessage: Readonly<{
      content: unknown;
      id: string;
    }>;
  }>;
}>;

export type RunPreparationInput = Readonly<{
  body: Readonly<Record<string, unknown>> | null;
  source: SendRunPreparationSource | RegenerateRunPreparationSource;
  userId: string;
}>;

type Primitive = bigint | boolean | null | number | string | symbol | undefined;

export type DeepReadonly<Value> = Value extends Primitive
  ? Value
  : Value extends Buffer
    ? Value
    : Value extends (...arguments_: never[]) => unknown
      ? Value
      : Value extends ReadonlyMap<infer Key, infer Entry>
        ? ReadonlyMap<DeepReadonly<Key>, DeepReadonly<Entry>>
        : Value extends ReadonlySet<infer Entry>
          ? ReadonlySet<DeepReadonly<Entry>>
          : Value extends readonly (infer Entry)[]
            ? readonly DeepReadonly<Entry>[]
            : Value extends object
              ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
              : Value;

type PreparedRunDefaultsData = AcceptedRunDefaults;

export type PreparedRunDefaults = DeepReadonly<PreparedRunDefaultsData>;

export type MaterializedPreparedRunData = {
  contextTruncation: ContextTruncationSummary | null;
  defaults: PreparedRunDefaultsData;
  expectedActiveLeafId: string | null;
  mcpBindings?: McpRunPlanBinding[];
  normalizedRequest: NormalizedRunRequest;
  providerRequest: ProviderRunRequest;
  providerRequestPreview: Record<string, unknown>;
  sourceKind: RunPreparationInput["source"]["kind"];
};

export type PreparedRun = DeepReadonly<MaterializedPreparedRunData>;

export type RunPreparationFailure = Readonly<{
  code: string;
  message?: string;
  ok: false;
  status: 400 | 403 | 409;
}>;

export type RunPreparationResult =
  | RunPreparationFailure
  | Readonly<{
      adapter: ProviderAdapter;
      ok: true;
      prepared: PreparedRun;
      searchAdapter: ProviderSearchAdapter | undefined;
    }>;

function failure(code: string, status: 400 | 403 | 409, message?: string): RunPreparationFailure {
  return Object.freeze({
    code,
    ...(message ? { message } : {}),
    ok: false,
    status
  });
}

function isPlainDataObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unsupportedPreparedData(): never {
  throw new TypeError("prepared_run_snapshot_requires_plain_data");
}

function clonePreparedData<Value>(
  value: Value,
  clones = new Map<object, object>(),
  visiting = new WeakSet<object>()
): Value {
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    return unsupportedPreparedData();
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    return unsupportedPreparedData();
  }

  const existing = clones.get(value);
  if (existing) {
    if (visiting.has(value)) {
      return unsupportedPreparedData();
    }
    return existing as Value;
  }

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    clones.set(value, clone);
    visiting.add(value);
    for (const entry of value) {
      clone.push(clonePreparedData(entry, clones, visiting));
    }
    visiting.delete(value);
    return clone as Value;
  }

  if (!isPlainDataObject(value)) {
    return unsupportedPreparedData();
  }

  const clone = Object.create(Object.getPrototypeOf(value)) as Record<PropertyKey, unknown>;
  clones.set(value, clone);
  visiting.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || typeof key === "symbol" || !("value" in descriptor)) {
      return unsupportedPreparedData();
    }

    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: descriptor.enumerable,
      value: clonePreparedData(descriptor.value, clones, visiting),
      writable: true
    });
  }
  visiting.delete(value);

  return clone as Value;
}

function deepFreezePreparedData<Value>(value: Value, visited = new WeakSet<object>()): DeepReadonly<Value> {
  if (
    typeof value !== "object" ||
    value === null ||
    (!Array.isArray(value) && !isPlainDataObject(value))
  ) {
    return value as DeepReadonly<Value>;
  }

  if (visited.has(value)) {
    return value as DeepReadonly<Value>;
  }
  visited.add(value);

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) {
      deepFreezePreparedData(descriptor.value, visited);
    }
  }

  return Object.freeze(value) as DeepReadonly<Value>;
}

function immutablePreparedData<Value>(value: Value): DeepReadonly<Value> {
  return deepFreezePreparedData(clonePreparedData(value));
}

function mutablePreparedData<Value>(value: DeepReadonly<Value>): Value {
  return clonePreparedData(value) as Value;
}

export function materializePreparedRunData(prepared: PreparedRun): MaterializedPreparedRunData {
  return {
    contextTruncation: mutablePreparedData<ContextTruncationSummary | null>(prepared.contextTruncation),
    defaults: mutablePreparedData<PreparedRunDefaultsData>(prepared.defaults),
    expectedActiveLeafId: prepared.expectedActiveLeafId,
    ...(prepared.mcpBindings
      ? { mcpBindings: mutablePreparedData<McpRunPlanBinding[]>(prepared.mcpBindings) }
      : {}),
    normalizedRequest: mutablePreparedData<NormalizedRunRequest>(prepared.normalizedRequest),
    providerRequest: mutablePreparedData<ProviderRunRequest>(prepared.providerRequest),
    providerRequestPreview: mutablePreparedData<Record<string, unknown>>(prepared.providerRequestPreview),
    sourceKind: prepared.sourceKind
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeContent(body: Readonly<Record<string, unknown>>): NormalizedRunRequest["content"] {
  if (typeof body.content === "object" && body.content && "blocks" in body.content) {
    const blocks = (body.content as { blocks?: unknown }).blocks;
    if (Array.isArray(blocks)) {
      return { blocks };
    }
  }

  if (typeof body.text === "string") {
    return textMessageContent(body.text);
  }

  return { blocks: [] };
}

function contentFromStored(value: unknown): NormalizedRunRequest["content"] {
  if (isRecord(value) && Array.isArray(value.blocks)) {
    return {
      blocks: value.blocks
    };
  }

  return { blocks: [] };
}

function normalizeParams(body: Readonly<Record<string, unknown>> | null): Record<string, unknown> {
  if (typeof body?.params === "object" && body.params !== null && !Array.isArray(body.params)) {
    return body.params as Record<string, unknown>;
  }

  return {};
}

function mergeParamObjects(
  defaults: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...defaults };

  for (const [key, value] of Object.entries(overrides)) {
    const defaultValue = defaults[key];
    merged[key] =
      isRecord(defaultValue) && isRecord(value)
        ? mergeParamObjects(defaultValue, value)
        : value;
  }

  return merged;
}

function mergeModelParams(
  provider: string,
  defaults: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const canonicalDefaults = canonicalizeMaxOutputTokenParams({ ...defaults });
  const merged = mergeParamObjects(canonicalDefaults, overrides);

  // OpenRouter routing, fallback, and privacy controls are catalog policy. The
  // browser may edit ordinary run controls, but it cannot replace this object.
  if (provider === "openrouter" && isRecord(canonicalDefaults.provider)) {
    merged.provider = mergeParamObjects(canonicalDefaults.provider, {});
  }

  return canonicalizeMaxOutputTokenParams(merged);
}

function buildPerplexitySearchPolicy(
  strategy: RunSearchStrategyConfiguration,
  modelConfiguration: RunModelConfiguration
): ProviderSearchPolicy | null {
  if (
    strategy.strategyId !== perplexityToolSearchStrategyId ||
    strategy.kind !== "perplexity_tool_search" ||
    strategy.provider !== "openrouter" ||
    !strategy.modelId?.trim()
  ) {
    return null;
  }

  const executor = isRecord(strategy.config.executor) ? strategy.config.executor : null;
  const routeProvider = isRecord(strategy.config.routeProvider)
    ? strategy.config.routeProvider
    : null;
  if (
    !executor ||
    executor.provider !== "openrouter" ||
    executor.modelId !== strategy.modelId ||
    !routeProvider
  ) {
    return null;
  }

  const controls = parameterControlsForModel({
    defaultParams: modelConfiguration.defaultParams,
    modelCapabilities: modelConfiguration.capabilities,
    modelId: strategy.modelId,
    provider: "openrouter"
  });
  const routeValidation = validateRunParams({
    controls,
    params: { provider: routeProvider },
    provider: "openrouter"
  });
  const configuredControls = validateSearchRunParams(strategy.config.params, {
    maxOutputTokens: controls.maxOutputTokens,
    temperature: controls.temperature
  });
  if (!routeValidation.ok || !configuredControls.ok) {
    return null;
  }

  const configuredParams = configuredControls.params ?? {};
  const defaultMaxOutputTokens =
    typeof configuredParams.maxOutputTokens === "number"
      ? configuredParams.maxOutputTokens
      : Math.min(1024, controls.maxOutputTokens.maxValue);
  const defaultTemperature =
    typeof configuredParams.temperature === "number"
      ? configuredParams.temperature
      : controls.temperature.supported &&
          controls.temperature.minValue <= 0 &&
          controls.temperature.maxValue >= 0
        ? 0
        : controls.temperature.defaultValue;
  const modelDefaults = normalizeOpenRouterParams(modelConfiguration.defaultParams);
  const providerPolicy = normalizeOpenRouterParams({ provider: routeProvider }).provider;

  return {
    controls: {
      maxOutputTokens: { ...controls.maxOutputTokens },
      temperature: { ...controls.temperature }
    },
    defaultParams: {
      maxOutputTokens: defaultMaxOutputTokens,
      provider: providerPolicy,
      reasoning: {
        ...modelDefaults.reasoning,
        enabled: false,
        exclude: true
      },
      stream: false,
      ...(controls.temperature.supported
        ? { temperature: defaultTemperature }
        : {})
    },
    modelId: strategy.modelId,
    provider: "openrouter",
    strategyId: perplexityToolSearchStrategyId
  };
}

function numberFromDraft(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function runControlDefaultsFromBody(
  body: Readonly<Record<string, unknown>> | null,
  controls: ReturnType<typeof parameterControlsForModel>,
  searchStrategy: string | null
): Record<string, boolean | string> {
  const input =
    typeof body?.controlDefaults === "object" && body.controlDefaults !== null && !Array.isArray(body.controlDefaults)
      ? (body.controlDefaults as Record<string, unknown>)
      : {};
  const next: Record<string, boolean | string> = {};

  if (typeof input.backgroundMode === "boolean" && controls.background.supported) {
    next.backgroundMode = input.backgroundMode;
  }

  const maxOutputTokens = numberFromDraft(input.maxOutputTokens);
  if (maxOutputTokens !== null) {
    next.maxOutputTokens = String(Math.round(clamp(maxOutputTokens, 1, controls.maxOutputTokens.maxValue)));
  }

  const temperature = numberFromDraft(input.temperature);
  if (temperature !== null && controls.temperature.supported) {
    next.temperature = String(clamp(temperature, controls.temperature.minValue, controls.temperature.maxValue));
  }

  if (
    typeof input.reasoningEffort === "string" &&
    controls.reasoningEffort.options.includes(input.reasoningEffort)
  ) {
    next.reasoningEffort = input.reasoningEffort;
  }

  if (
    typeof input.reasoningMode === "string" &&
    controls.reasoningMode?.supported === true &&
    controls.reasoningMode.options.includes(input.reasoningMode)
  ) {
    next.reasoningMode = input.reasoningMode;
  }

  if (typeof input.streamMode === "boolean" && controls.stream.supported) {
    next.streamMode = input.streamMode;
  }

  next.searchStrategyId = searchStrategy ?? "search-disabled";

  return next;
}

function normalizePrompt(body: Readonly<Record<string, unknown>> | null): NormalizedRunRequest["prompt"] {
  if (typeof body?.prompt !== "object" || body.prompt === null || Array.isArray(body.prompt)) {
    return {
      developer: visibleAnswerContract,
      presetId: null,
      system: null
    };
  }

  const prompt = body.prompt as Record<string, unknown>;
  const developer = typeof prompt.developer === "string" ? prompt.developer : null;

  return {
    developer: [developer, visibleAnswerContract].filter((part): part is string => Boolean(part?.trim())).join("\n\n"),
    presetId: typeof prompt.presetId === "string" && prompt.presetId.trim() ? prompt.presetId.trim() : null,
    system: typeof prompt.system === "string" ? prompt.system : null
  };
}

function promptWithProjectMemory(
  prompt: NormalizedRunRequest["prompt"],
  projectMemory: string | null | undefined
): NormalizedRunRequest["prompt"] {
  const memory = projectMemory?.trim();
  if (!memory) {
    return prompt;
  }

  return {
    ...prompt,
    system:
      [prompt.system, `Project memory:\n${memory}`]
        .filter((part): part is string => Boolean(part?.trim()))
        .join("\n\n") || null
  };
}

function extractAttachmentIds(content: NormalizedRunRequest["content"]): string[] {
  return content.blocks.flatMap((block) => {
    if (typeof block === "object" && block && "attachmentId" in block && typeof block.attachmentId === "string") {
      return [block.attachmentId];
    }

    return [];
  });
}

function hasTextContent(content: NormalizedRunRequest["content"]): boolean {
  return content.blocks.some(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string" &&
      Boolean(block.text.trim())
  );
}

function hasRunnableContent(content: NormalizedRunRequest["content"]): boolean {
  return hasTextContent(content) || extractAttachmentIds(content).length > 0;
}

function validateAttachmentCapabilities(
  attachments: ProviderAttachment[],
  capabilities: ProviderModelCapabilities
): { code: string; status: 400 } | null {
  const hasPdf = attachments.some((attachment) => attachment.kind === "pdf");
  const hasImage = attachments.some((attachment) => attachment.kind === "image");

  if (hasPdf && !capabilities.pdf && !capabilities.nativePdfInput) {
    return { code: "pdf_attachment_not_supported", status: 400 };
  }

  if (hasImage && !capabilities.vision) {
    return { code: "image_attachment_not_supported", status: 400 };
  }

  return null;
}

function validateSearchStrategyForModel(
  provider: string,
  modelId: string,
  searchStrategy: string | null,
  capabilities: ProviderModelCapabilities
): { code: string; status: 400 } | null {
  if (!searchStrategy || searchStrategy === "search-disabled") {
    return null;
  }

  if (searchStrategy === "openai-native-web-search") {
    return provider === "openai" && capabilities.nativeSearch
      ? null
      : { code: "search_strategy_not_supported_by_model", status: 400 };
  }

  if (searchStrategy === perplexityToolSearchStrategyId) {
    const isAnswerModel = modelId !== "perplexity/sonar-pro-search";

    return isAnswerModel && (provider === "openai" || provider === "openrouter")
      ? null
      : { code: "search_strategy_not_supported_by_model", status: 400 };
  }

  return { code: "search_strategy_unknown", status: 400 };
}

function validateMcpCapabilities(input: Readonly<{
  capabilities: ProviderModelCapabilities;
  enabled: boolean;
  params: Readonly<Record<string, unknown>>;
  provider: string;
}>): { code: string; status: 400 } | null {
  if (!input.enabled) return null;
  const bridge = providerToolBridges[input.provider as keyof typeof providerToolBridges];
  if (!bridge || input.capabilities.toolCalling !== true) {
    return { code: "mcp_tool_calling_not_supported", status: 400 };
  }
  if (input.params.background === true && input.capabilities.nativeBackground !== true) {
    return { code: "mcp_background_not_supported", status: 400 };
  }
  if (input.params.background === true && input.params.stream === true &&
    input.capabilities.backgroundStreaming !== true) {
    return { code: "mcp_background_streaming_not_supported", status: 400 };
  }
  return null;
}

function objectToDataUrl(contentType: string, body: Buffer): string {
  return `data:${contentType};base64,${body.toString("base64")}`;
}

export async function loadProviderAttachments(
  deps: Readonly<{
    repository: Pick<RunRepository, "loadAttachments">;
    storage?: Pick<StorageAdapter, "getObject">;
  }>,
  userId: string,
  attachmentIds: string[],
  options: { loadNativePdfData: boolean } = { loadNativePdfData: false }
): Promise<ProviderAttachment[]> {
  if (attachmentIds.length === 0) {
    return [];
  }

  const records = await deps.repository.loadAttachments(userId, attachmentIds);

  return Promise.all(
    records.map(async (record) => {
      const { storageKey, ...attachment } = record;

      if (options.loadNativePdfData && attachment.kind === "pdf" && deps.storage) {
        const object = await deps.storage.getObject(storageKey);

        return {
          ...attachment,
          base64Data: object.body.toString("base64")
        };
      }

      if (attachment.kind !== "image") {
        return attachment;
      }

      if (!deps.storage) {
        return attachment;
      }

      const object = await deps.storage.getObject(storageKey);

      return {
        ...attachment,
        dataUrl: objectToDataUrl(attachment.mimeType || object.contentType, object.body)
      };
    })
  );
}

export async function prepareRun(
  deps: RunPreparationDeps,
  input: RunPreparationInput
): Promise<RunPreparationResult> {
  const body = input.body;
  const chat = input.source.kind === "send" ? input.source.chat : input.source.source.chat;
  const provider =
    typeof body?.provider === "string"
      ? body.provider
      : input.source.kind === "send"
        ? chat.defaultProvider
        : input.source.source.assistantMessage.provider ?? chat.defaultProvider;
  const modelId =
    typeof body?.modelId === "string"
      ? body.modelId
      : input.source.kind === "send"
        ? chat.defaultModelId
        : input.source.source.assistantMessage.modelId ?? chat.defaultModelId;
  const requestedSearchStrategy =
    typeof body?.searchStrategy === "string" ? body.searchStrategy : "search-disabled";
  const adapter = deps.providers[provider];

  if (!adapter) {
    return failure("provider_not_available", 400);
  }

  const entitlements = await deps.repository.loadEntitlements(input.userId);
  const access = validateRunAccess(entitlements, {
    modelId,
    provider,
    searchStrategy: requestedSearchStrategy
  });
  if (!access.ok) {
    return failure(access.code, 403);
  }

  const content =
    input.source.kind === "send"
      ? normalizeContent(body ?? {})
      : contentFromStored(input.source.source.userMessage.content);
  if (input.source.kind === "send" && !hasRunnableContent(content)) {
    return failure("content_required", 400);
  }

  const modelConfiguration = await deps.repository.loadModelConfiguration(provider, modelId);
  if (!modelConfiguration) {
    return failure("model_not_available", 403);
  }

  const { capabilities: modelCapabilities, defaultParams } = modelConfiguration;

  if (!(await deps.repository.isSearchStrategyEnabled(requestedSearchStrategy))) {
    return failure("search_strategy_not_available", 403);
  }

  const paramsBody = normalizeParams(body);
  const normalizedPrompt = normalizePrompt(body);
  if (
    normalizedPrompt.presetId &&
    !(await deps.repository.isPromptPresetAvailable(input.userId, normalizedPrompt.presetId))
  ) {
    return failure("default_prompt_unavailable", 400);
  }
  const prompt = promptWithProjectMemory(normalizedPrompt, chat.projectMemory);
  const sendContext =
    input.source.kind === "send"
      ? await deps.repository.loadConversationContextForExpectedLeaf(
          chat.id,
          input.userId,
          input.source.chat.activeLeafMessageId
        )
      : null;
  if (input.source.kind === "send" && !sendContext) {
    return failure("active_leaf_changed", 409);
  }
  const contextMessages: ProviderConversationMessage[] =
    input.source.kind === "send"
      ? [
          ...(sendContext ?? []),
          {
            content,
            id: currentSendMessageId,
            role: "user"
          }
        ]
      : await deps.repository.loadConversationContextForLeaf(
          chat.id,
          input.userId,
          input.source.source.userMessage.id
        );
  const attachmentIds = extractAttachmentIds(content);
  const parameterControls = parameterControlsForModel({
    defaultParams,
    modelCapabilities,
    modelId,
    provider
  });
  if (
    requestedSearchStrategy === perplexityToolSearchStrategyId &&
    !deps.searchProviders?.openrouter
  ) {
    return failure("search_provider_not_available", 400);
  }
  let searchPolicy: ProviderSearchPolicy | undefined;
  if (requestedSearchStrategy === perplexityToolSearchStrategyId) {
    const strategyConfiguration = await deps.repository.loadSearchStrategyConfiguration(
      requestedSearchStrategy
    );
    if (
      !strategyConfiguration ||
      strategyConfiguration.provider !== "openrouter" ||
      !strategyConfiguration.modelId
    ) {
      return failure("search_strategy_not_available", 403);
    }

    const searchModelConfiguration = await deps.repository.loadModelConfiguration(
      strategyConfiguration.provider,
      strategyConfiguration.modelId
    );
    if (!searchModelConfiguration) {
      return failure("search_strategy_not_available", 403);
    }

    searchPolicy =
      buildPerplexitySearchPolicy(
        strategyConfiguration,
        searchModelConfiguration
      ) ?? undefined;
    if (!searchPolicy) {
      return failure("search_strategy_not_available", 403);
    }
  }
  const paramValidation = validateRunParams({
    controls: parameterControls,
    params: paramsBody,
    provider,
    ...(searchPolicy ? { searchControls: searchPolicy.controls } : {})
  });
  if (!paramValidation.ok) {
    return failure(invalidRunParamsError, 400);
  }
  const runParams = mergeModelParams(provider, defaultParams, paramValidation.params);
  const searchStrategy = requestedSearchStrategy;
  const searchAdapter =
    searchStrategy === perplexityToolSearchStrategyId ? deps.searchProviders?.openrouter : undefined;

  const searchCompatibility = validateSearchStrategyForModel(
    provider,
    modelId,
    searchStrategy,
    modelCapabilities
  );
  if (searchCompatibility) {
    return failure(searchCompatibility.code, searchCompatibility.status);
  }

  if (searchStrategy === perplexityToolSearchStrategyId && !searchAdapter) {
    return failure("search_provider_not_available", 400);
  }

  const mcpPlan = deps.mcp ? await deps.mcp.prepare(input.userId) : null;
  if (mcpPlan && !mcpPlan.ok) {
    const affected = mcpPlan.issues.map((issue) => issue.name).join(", ");
    return failure(
      mcpPlan.code,
      409,
      affected ? `MCP tools are not ready: ${affected}.` : "MCP tools are not ready."
    );
  }
  const mcpCompatibility = validateMcpCapabilities({
    capabilities: modelCapabilities,
    enabled: Boolean(mcpPlan?.ok && mcpPlan.snapshot.servers.length),
    params: runParams,
    provider
  });
  if (mcpCompatibility) return failure(mcpCompatibility.code, mcpCompatibility.status);

  const uniqueAttachmentIds = Array.from(new Set(attachmentIds));
  const attachments = await loadProviderAttachments(deps, input.userId, uniqueAttachmentIds, {
    loadNativePdfData: modelCapabilities.nativePdfInput
  });

  if (attachments.length !== uniqueAttachmentIds.length) {
    return failure("attachment_not_found", 400);
  }

  const attachmentAccess = validateAttachmentCapabilities(attachments, modelCapabilities);
  if (attachmentAccess) {
    return failure(attachmentAccess.code, attachmentAccess.status);
  }

  const unbudgetedNormalizedRequest: NormalizedRunRequest = {
    attachmentIds,
    chatId: chat.id,
    content,
    context: { messages: contextMessages, mode: "branch_path" },
    modelCapabilities,
    modelId,
    ...(mcpPlan?.ok && mcpPlan.snapshot.servers.length ? { mcp: mcpPlan.snapshot } : {}),
    params: runParams,
    prompt,
    provider,
    ...(searchPolicy ? { searchPolicy } : {}),
    searchStrategy
  };
  const clientTools = [
    ...(searchStrategy === perplexityToolSearchStrategyId ? [perplexityWebSearchTool] : []),
    ...mcpRunTools(unbudgetedNormalizedRequest.mcp)
  ];
  const unbudgetedProviderRequest: ProviderRunRequest = {
    ...unbudgetedNormalizedRequest,
    attachments,
    ...(clientTools.length > 0 ? { tools: clientTools } : {})
  };
  const toolBridge = providerToolBridges[provider as keyof typeof providerToolBridges];
  const providerBudget = applyProviderRequestContextBudget({
    ...(toolBridge ? { bridge: toolBridge } : {}),
    request: unbudgetedProviderRequest
  });
  if (!providerBudget.ok) {
    return failure(providerBudget.error.code, providerBudget.status, providerBudget.error.message);
  }
  const normalizedRequest: NormalizedRunRequest = {
    ...unbudgetedNormalizedRequest,
    context: providerBudget.request.context!
  };
  const providerRequest: ProviderRunRequest = {
    ...normalizedRequest,
    attachments,
    ...(clientTools.length > 0 ? { tools: clientTools } : {})
  };
  const providerRequestPreview = adapter.buildRequestPreview(providerRequest);
  const defaults: PreparedRunDefaultsData = {
    controlDefaults: runControlDefaultsFromBody(body, parameterControls, searchStrategy),
    modelId,
    promptPresetId: prompt.presetId,
    provider,
    searchStrategy,
    userId: input.userId
  };

  const prepared = immutablePreparedData<MaterializedPreparedRunData>({
    contextTruncation: providerBudget.contextTruncation,
    defaults,
    expectedActiveLeafId: input.source.kind === "send" ? input.source.chat.activeLeafMessageId : null,
    ...(mcpPlan?.ok ? { mcpBindings: [...mcpPlan.bindings] } : {}),
    normalizedRequest,
    providerRequest,
    providerRequestPreview,
    sourceKind: input.source.kind
  });

  return Object.freeze({
    adapter,
    ok: true,
    prepared,
    searchAdapter
  });
}
