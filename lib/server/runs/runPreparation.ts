import { textMessageContent } from "../../domain/content";
import { decodeKnowledgePlan, type KnowledgePlan } from "../../contracts/knowledge";
import { resolveStandardChatBaseline } from "../../domain/promptTemplates";
import { materializeAssistantRunParams } from "../assistants/runControlMaterialization";
import type {
  AssistantRunMaterialization,
  AssistantRunResolver
} from "../assistants/runMaterialization";
import {
  parameterControlsForModel,
  type CatalogAdapterKind
} from "../../domain/catalog";
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
import {
  decodeSearchPlan,
  legacySearchStrategyFromPlan
} from "../../domain/search";
import {
  ProviderAdmissionError,
  type ProviderAdmissionPlan
} from "../providerRuntime/admission";
import { createProviderPreviewRuntimeBinding } from "../providers/runtimeFactory";
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
import {
  KnowledgeRunAdmissionError,
  type KnowledgeRunAdmissionPlan
} from "../knowledge/runAdmission";
import type { McpRunPlanBinding, McpRunPlanResult } from "../mcp/runPlan";
import { mcpRunTools } from "../mcp/toolExecutor";
import { providerToolBridges } from "../tools/bridges";
import type { ProviderToolBridge } from "../tools/types";
import { perplexityWebSearchTool } from "../tools/perplexitySearch";
import { createSearchPlanToolRouter } from "../search/toolExecutor";
import { knowledgeRetrievalTool } from "../knowledge/toolExecutor";
import { applyProviderRequestContextBudget } from "./runContextBudget";
import {
  getRunAttachmentLimits,
  type RunAttachmentLimits
} from "./attachmentLimits";
import {
  attachmentIdsFromContentBlocks,
  enforceAttachmentReferenceLimit,
  isAttachmentMaterializationError,
  loadProviderAttachments,
  type AttachmentLimitNumericFacts
} from "./runAttachmentMaterialization";
import type {
  AcceptedRunDefaults,
  RunModelConfiguration,
  RunRepository,
  RunSearchStrategyConfiguration
} from "./runRepositoryContract";

const visibleAnswerContract =
  "Visible answer contract: answer the user directly in the chat message. Do not include debug sections such as Question, Search, Provider Parameters, Request Preview, Artifacts, Usage, or Errors. Provider/search/request/usage/error details are displayed by AIQSA Details summaries or model-run APIs. Include citations naturally only when they help the answer.";
const perplexityToolSearchStrategyId = "perplexity-tool-search";
const geminiGoogleSearchStrategyId = "gemini-google-search";
const currentSendMessageId = "current-user-message";
const pdfTextUnavailableMessage =
  "No extractable text was found. Choose a model with native PDF support or remove this file.";
const zeroEmittedPdfTextUnavailableMessage =
  "No PDF text could be retained within the configured limit. Choose a model with native PDF support or remove this file.";

function legacyAdapterKind(provider: string): CatalogAdapterKind {
  if (provider === "anthropic") return "anthropic_messages";
  if (provider === "gemini") return "gemini_interactions_native";
  if (provider === "openrouter") return "openrouter_chat_completions";
  if (provider === "fake") return "fake";
  return "openai_responses_native";
}

function parameterDialect(adapterKind: CatalogAdapterKind, providerFamily: string): string {
  if (providerFamily === "gemini") return "gemini";
  if (adapterKind === "anthropic_messages") return "anthropic";
  if (adapterKind === "openrouter_chat_completions") return "openrouter";
  if (adapterKind === "fake") return "fake";
  return "openai";
}

type RunPreparationRepository = Pick<
  RunRepository,
  | "loadAttachments"
  | "loadConversationContextForExpectedLeaf"
  | "loadConversationContextForLeaf"
  | "loadEntitlements"
  | "loadModelConfiguration"
  | "loadSearchStrategyConfiguration"
  | "isSearchStrategyEnabled"
>;

export type RunPreparationDeps = Readonly<{
  allowFakeProvider?: boolean;
  assistants?: AssistantRunResolver;
  getAttachmentLimits?: () => RunAttachmentLimits;
  knowledgeAdmission?: Readonly<{
    load(input: { knowledgePlan: KnowledgePlan; userId: string }): Promise<KnowledgeRunAdmissionPlan>;
  }>;
  mcp?: Readonly<{
    prepare(
      userId: string,
      options?: Readonly<{ allowedServerIds?: readonly string[] }>
    ): Promise<McpRunPlanResult>;
  }>;
  providers: Readonly<Record<string, ProviderAdapter>>;
  providerAdmission?: Readonly<{
    load(input: {
      providerConnectionId: string;
      providerModelId: string;
      requiresClientToolCoexistence?: boolean;
      searchPlan?: import("../../domain/search").SearchPlan;
      searchPreferencePlan?: import("../../domain/search").SearchPlan | null;
      searchPreferenceSource?: "organization" | "personal";
      searchStrategyId: string;
      userId: string;
    }): Promise<ProviderAdmissionPlan>;
  }>;
  repository: RunPreparationRepository;
  searchProviders?: Readonly<Record<string, ProviderSearchAdapter>>;
  storage?: Pick<StorageAdapter, "getObject">;
}>;

export type SendRunPreparationSource = Readonly<{
  chat: Readonly<{
    activeLeafMessageId: string | null;
    defaultKnowledgePlan?: unknown;
    defaultModelId: string;
    defaultProvider: string;
    folderDefaultKnowledgePlan?: unknown;
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
    }> | null;
    chat: Readonly<{
      defaultKnowledgePlan?: unknown;
      defaultModelId: string;
      defaultProvider: string;
      folderDefaultKnowledgePlan?: unknown;
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
  signal?: AbortSignal;
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
  assistant?: { assistantId: string; revisionId: string };
  contextTruncation: ContextTruncationSummary | null;
  defaults: PreparedRunDefaultsData | null;
  expectedActiveLeafId: string | null;
  knowledgeAdmissionPlan?: KnowledgeRunAdmissionPlan;
  mcpBindings?: McpRunPlanBinding[];
  normalizedRequest: NormalizedRunRequest;
  providerAdmissionPlan?: ProviderAdmissionPlan;
  providerRequest: ProviderRunRequest;
  providerRequestPreview: Record<string, unknown>;
  sourceKind: RunPreparationInput["source"]["kind"];
};

export type PreparedRun = DeepReadonly<MaterializedPreparedRunData>;

export type RunPreparationFailure = Readonly<{
  actual?: AttachmentLimitNumericFacts;
  code: string;
  limits?: AttachmentLimitNumericFacts;
  message?: string;
  ok: false;
  status: 400 | 403 | 404 | 409 | 413 | 503;
}>;

export type RunPreparationResult =
  | RunPreparationFailure
  | Readonly<{
      adapter: ProviderAdapter;
      ok: true;
      prepared: PreparedRun;
      searchAdapter: ProviderSearchAdapter | undefined;
      toolBridge: ProviderToolBridge | undefined;
    }>;

function failure(
  code: string,
  status: 400 | 403 | 404 | 409 | 413 | 503,
  message?: string,
  facts: Readonly<{
    actual?: AttachmentLimitNumericFacts;
    limits?: AttachmentLimitNumericFacts;
  }> = {}
): RunPreparationFailure {
  return Object.freeze({
    ...(facts.actual ? { actual: facts.actual } : {}),
    code,
    ...(facts.limits ? { limits: facts.limits } : {}),
    ...(message ? { message } : {}),
    ok: false,
    status
  });
}

function attachmentFailure(error: unknown): RunPreparationFailure | null {
  if (!isAttachmentMaterializationError(error)) {
    return null;
  }

  return failure(error.code, error.status, error.message, {
    ...(Object.keys(error.actual).length > 0 ? { actual: error.actual } : {}),
    ...(Object.keys(error.limits).length > 0 ? { limits: error.limits } : {})
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
    ...(prepared.assistant
      ? { assistant: mutablePreparedData<{ assistantId: string; revisionId: string }>(prepared.assistant) }
      : {}),
    contextTruncation: mutablePreparedData<ContextTruncationSummary | null>(prepared.contextTruncation),
    defaults: mutablePreparedData<PreparedRunDefaultsData | null>(prepared.defaults),
    expectedActiveLeafId: prepared.expectedActiveLeafId,
    ...(prepared.knowledgeAdmissionPlan
      ? {
          knowledgeAdmissionPlan: mutablePreparedData<KnowledgeRunAdmissionPlan>(
            prepared.knowledgeAdmissionPlan
          )
        }
      : {}),
    ...(prepared.mcpBindings
      ? { mcpBindings: mutablePreparedData<McpRunPlanBinding[]>(prepared.mcpBindings) }
      : {}),
    normalizedRequest: mutablePreparedData<NormalizedRunRequest>(prepared.normalizedRequest),
    ...(prepared.providerAdmissionPlan
      ? {
          providerAdmissionPlan: mutablePreparedData<ProviderAdmissionPlan>(
            prepared.providerAdmissionPlan
          )
        }
      : {}),
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
  controls: ReturnType<typeof parameterControlsForModel>
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

  return next;
}

/**
 * Ordinary no-Assistant runs receive the code-owned standard-chat baseline
 * resolved from the server clock and a validated client time-zone hint. The
 * browser cannot replace the baseline or supply rendered date/time text; a
 * legacy client-sent `prompt` object has no authority and is ignored.
 */
function standardChatPrompt(body: Readonly<Record<string, unknown>> | null): NormalizedRunRequest["prompt"] {
  const baseline = resolveStandardChatBaseline({ timeZone: body?.timeZone });

  return {
    baseline: {
      source: "standard_chat",
      timeZone: baseline.timeZone,
      timeZoneSource: baseline.timeZoneSource
    },
    developer: visibleAnswerContract,
    system: baseline.renderedSystemPrompt
  };
}

/**
 * Assistant runs use the selected immutable revision's own instructions and do
 * not inherit the standard-chat baseline; the cross-cutting visible-answer
 * contract remains explicit in the resolved developer prompt for both modes.
 */
function assistantPrompt(assistant: AssistantRunMaterialization): NormalizedRunRequest["prompt"] {
  return {
    developer: [assistant.developerPrompt, visibleAnswerContract]
      .filter((part): part is string => Boolean(part?.trim()))
      .join("\n\n"),
    system: assistant.systemPrompt.trim() ? assistant.systemPrompt : null
  };
}

const assistantGovernedBodyKeys = [
  "controlDefaults",
  "modelId",
  "knowledgePlan",
  "params",
  "prompt",
  "provider",
  "searchPlan",
  "searchPreferencePlan",
  "searchPreferenceSource",
  "searchStrategy",
  "tools"
] as const;

function resolvedOrdinaryKnowledgePlan(
  body: Readonly<Record<string, unknown>> | null,
  chat: Readonly<{
    defaultKnowledgePlan?: unknown;
    folderDefaultKnowledgePlan?: unknown;
  }>
): ReturnType<typeof decodeKnowledgePlan> {
  if (body && "knowledgePlan" in body) {
    return decodeKnowledgePlan(body.knowledgePlan);
  }
  if (chat.defaultKnowledgePlan !== null && chat.defaultKnowledgePlan !== undefined) {
    return decodeKnowledgePlan(chat.defaultKnowledgePlan);
  }
  if (
    chat.folderDefaultKnowledgePlan !== null &&
    chat.folderDefaultKnowledgePlan !== undefined
  ) {
    return decodeKnowledgePlan(chat.folderDefaultKnowledgePlan);
  }
  return decodeKnowledgePlan(undefined);
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

function hasNoTextPdfProcessingStatus(metadata: unknown): boolean {
  if (!isRecord(metadata) || !isRecord(metadata.pdf)) {
    return false;
  }

  return metadata.pdf.status === "no_text";
}

function hasZeroEmittedPartialPdfStatus(metadata: unknown): boolean {
  if (!isRecord(metadata) || !isRecord(metadata.pdf)) {
    return false;
  }

  return metadata.pdf.status === "partial" && metadata.pdf.extractedCharacterCount === 0;
}

function validatePdfTextAvailability(
  attachments: ProviderAttachment[],
  capabilities: ProviderModelCapabilities
): { code: string; message: string; status: 400 } | null {
  if (capabilities.nativePdfInput || !capabilities.pdf) {
    return null;
  }

  const unavailable = attachments.find(
    (attachment) =>
      attachment.kind === "pdf" &&
      (hasNoTextPdfProcessingStatus(attachment.metadata) ||
        hasZeroEmittedPartialPdfStatus(attachment.metadata) ||
        !attachment.extractedText?.trim())
  );

  return unavailable
    ? {
        code: "pdf_text_unavailable",
        message: hasZeroEmittedPartialPdfStatus(unavailable.metadata)
          ? zeroEmittedPdfTextUnavailableMessage
          : pdfTextUnavailableMessage,
        status: 400
      }
    : null;
}

function validateSearchStrategyForModel(
  adapterKind: CatalogAdapterKind,
  _modelId: string,
  searchStrategy: string | null,
  capabilities: ProviderModelCapabilities
): { code: string; status: 400 } | null {
  if (!searchStrategy || searchStrategy === "search-disabled") {
    return null;
  }

  if (searchStrategy === "openai-native-web-search") {
    return (adapterKind === "openai_responses_native" ||
      adapterKind === "openai_responses_compatible") && capabilities.nativeSearch
      ? null
      : { code: "search_strategy_not_supported_by_model", status: 400 };
  }

  if (searchStrategy === geminiGoogleSearchStrategyId) {
    return adapterKind === "gemini_interactions_native" && capabilities.nativeSearch
      ? null
      : { code: "search_strategy_not_supported_by_model", status: 400 };
  }

  if (searchStrategy === perplexityToolSearchStrategyId) {
    return (
      adapterKind === "openai_responses_native" ||
      adapterKind === "openai_responses_compatible" ||
      adapterKind === "openai_chat_completions_compatible" ||
      adapterKind === "openrouter_chat_completions"
    )
      ? null
      : { code: "search_strategy_not_supported_by_model", status: 400 };
  }

  return { code: "search_strategy_unknown", status: 400 };
}

function validateMcpCapabilities(input: Readonly<{
  bridge?: ProviderToolBridge;
  capabilities: ProviderModelCapabilities;
  enabled: boolean;
  modelId: string;
  params: Readonly<Record<string, unknown>>;
  provider: string;
}>): { code: string; status: 400 } | null {
  if (!input.enabled) return null;
  if (
    !input.bridge?.supportsToolCalling({ modelId: input.modelId, provider: input.provider }) ||
    input.capabilities.toolCalling !== true
  ) {
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

export async function prepareRun(
  deps: RunPreparationDeps,
  input: RunPreparationInput
): Promise<RunPreparationResult> {
  const body = input.body;

  let assistantRun: AssistantRunMaterialization | null = null;
  if (body && "assistantId" in body && body.assistantId !== undefined && body.assistantId !== null) {
    if (
      typeof body.assistantId !== "string" ||
      !body.assistantId.trim() ||
      body.assistantId.length > 64
    ) {
      return failure("assistant_not_available", 404);
    }
    // There is no per-run override patch: a request that both selects an
    // Assistant and carries Assistant-governed controls is rejected instead of
    // silently preferring either side.
    for (const key of assistantGovernedBodyKeys) {
      if (key in body) {
        return failure("assistant_overrides_not_allowed", 400);
      }
    }
    if (!deps.assistants) {
      return failure("assistant_not_available", 404);
    }
    const resolution = await deps.assistants.resolveForRun(
      input.userId,
      body.assistantId.trim()
    );
    if (!resolution.ok) {
      return failure(resolution.code, resolution.status);
    }
    assistantRun = resolution.assistant;
  }

  const chat = input.source.kind === "send" ? input.source.chat : input.source.source.chat;
  const decodedKnowledgePlan = assistantRun
    ? { ok: true as const, plan: { baseIds: [...assistantRun.knowledgeBaseIds] } }
    : resolvedOrdinaryKnowledgePlan(body, chat);
  if (!decodedKnowledgePlan.ok) {
    return failure(decodedKnowledgePlan.code, 400);
  }
  let knowledgeAdmissionPlan: KnowledgeRunAdmissionPlan | undefined;
  if (decodedKnowledgePlan.plan.baseIds.length > 0) {
    if (!deps.knowledgeAdmission) {
      return failure("knowledge_base_not_available", 503);
    }
    try {
      knowledgeAdmissionPlan = await deps.knowledgeAdmission.load({
        knowledgePlan: decodedKnowledgePlan.plan,
        userId: input.userId
      });
    } catch (error) {
      if (error instanceof KnowledgeRunAdmissionError) {
        return failure(error.code, 404);
      }
      throw error;
    }
  }

  const decodedSearchPlan = assistantRun
    ? null
    : decodeSearchPlan(body?.searchPlan, body?.searchStrategy);
  if (decodedSearchPlan && !decodedSearchPlan.ok) {
    return failure(decodedSearchPlan.code, 400);
  }
  let requestedSearchPlan = assistantRun
    ? assistantRun.searchPlan
    : decodedSearchPlan && decodedSearchPlan.ok
      ? decodedSearchPlan.plan
      : { mode: "all_selected" as const, optionIds: [] as string[] };
  let requestedSearchPreference: {
    plan: import("../../domain/search").SearchPlan | null;
    source: "organization" | "personal";
  } | null = null;
  if (!assistantRun && body && ("searchPreferencePlan" in body || "searchPreferenceSource" in body)) {
    if (body.searchPreferenceSource === "organization") {
      requestedSearchPreference = { plan: null, source: "organization" };
    } else if (body.searchPreferenceSource === "personal") {
      const decodedPreference = decodeSearchPlan(body.searchPreferencePlan);
      if (!decodedPreference.ok) return failure(decodedPreference.code, 400);
      requestedSearchPreference = { plan: decodedPreference.plan, source: "personal" };
    } else {
      return failure("search_preference_invalid", 400);
    }
  }
  const selectedProvider = assistantRun
    ? assistantRun.provider
    : typeof body?.provider === "string"
      ? body.provider
      : input.source.kind === "send"
        ? chat.defaultProvider
        : input.source.source.assistantMessage?.provider ?? chat.defaultProvider;
  const selectedModelId = assistantRun
    ? assistantRun.providerModelId
    : typeof body?.modelId === "string"
      ? body.modelId
      : input.source.kind === "send"
        ? chat.defaultModelId
        : input.source.source.assistantMessage?.modelId ?? chat.defaultModelId;
  let requestedSearchStrategy = legacySearchStrategyFromPlan(requestedSearchPlan);
  let admissionPlan: ProviderAdmissionPlan | undefined;
  let executionProvider = selectedProvider;
  let executionModelId = selectedModelId;
  let modelConfiguration: RunModelConfiguration | null;
  let previewRuntime: Readonly<{
    adapter: ProviderAdapter;
    toolBridge?: ProviderToolBridge;
  }> | undefined;

  if (deps.providerAdmission) {
    try {
      admissionPlan = await deps.providerAdmission.load({
        providerConnectionId: selectedProvider,
        providerModelId: selectedModelId,
        searchPlan: requestedSearchPlan,
        ...(requestedSearchPreference
          ? {
              searchPreferencePlan: requestedSearchPreference.plan,
              searchPreferenceSource: requestedSearchPreference.source
            }
          : {}),
        searchStrategyId: requestedSearchStrategy,
        userId: input.userId
      });
    } catch (error) {
      if (error instanceof ProviderAdmissionError) {
        return failure(
          error.code,
          error.code === "credential_assignment_ambiguous" ? 409 : 403
        );
      }
      throw error;
    }
    modelConfiguration = admissionPlan.answer.modelConfiguration;
    requestedSearchPlan = admissionPlan.requestedSearchPlan ?? requestedSearchPlan;
    requestedSearchStrategy = admissionPlan.requestedSearchStrategyId;
    if (requestedSearchPreference) {
      requestedSearchPreference = {
        plan: admissionPlan.requestedSearchPreferencePlan !== undefined
          ? admissionPlan.requestedSearchPreferencePlan
          : requestedSearchPreference.plan,
        source: requestedSearchPreference.source
      };
    }
  } else {
    const selectedAdapter = deps.providers[selectedProvider];
    if (!selectedAdapter) {
      return failure("provider_not_available", 400);
    }
    const legacyToolBridge = providerToolBridges[
      selectedProvider as keyof typeof providerToolBridges
    ];
    previewRuntime = {
      adapter: selectedAdapter,
      ...(legacyToolBridge ? { toolBridge: legacyToolBridge } : {})
    };
    const entitlements = await deps.repository.loadEntitlements(input.userId);
    for (const searchStrategy of requestedSearchPlan.optionIds.length
      ? requestedSearchPlan.optionIds
      : ["search-disabled"]) {
      const access = validateRunAccess(entitlements, {
        modelId: selectedModelId,
        provider: selectedProvider,
        searchStrategy
      });
      if (!access.ok) {
        return failure(access.code, 403);
      }
    }
    modelConfiguration = null;
  }

  const content =
    input.source.kind === "send"
      ? normalizeContent(body ?? {})
      : contentFromStored(input.source.source.userMessage.content);
  const attachmentLimits = deps.getAttachmentLimits?.() ?? getRunAttachmentLimits();
  let attachmentIds: string[];
  try {
    attachmentIds = attachmentIdsFromContentBlocks(content.blocks);
    enforceAttachmentReferenceLimit(attachmentIds, attachmentLimits);
  } catch (error) {
    const rejected = attachmentFailure(error);
    if (rejected) return rejected;
    throw error;
  }
  if (input.source.kind === "send" && !hasTextContent(content) && attachmentIds.length === 0) {
    return failure("content_required", 400);
  }

  if (!admissionPlan) {
    modelConfiguration = await deps.repository.loadModelConfiguration(
      selectedProvider,
      selectedModelId
    );
  }
  if (!modelConfiguration) {
    return failure("model_not_available", 403);
  }

  const assistantMcpUnavailable = Boolean(
    assistantRun && assistantRun.mcpServerIds.length > 0 && !deps.mcp
  );
  const mcpPlan = assistantRun
    ? assistantRun.mcpServerIds.length > 0 && deps.mcp
      ? await deps.mcp.prepare(input.userId, {
          allowedServerIds: assistantRun.mcpServerIds
        })
      : null
    : deps.mcp && body?.tools !== "none"
      ? await deps.mcp.prepare(input.userId)
      : null;

  const admittedKnowledgeToolsEnabled =
    body?.tools !== "none" &&
    modelConfiguration.capabilities.toolCalling === true &&
    Boolean(knowledgeAdmissionPlan);
  const mcpToolsEnabled = Boolean(mcpPlan?.ok && mcpPlan.snapshot.tools.length > 0);
  const requiresClientToolCoexistence = admittedKnowledgeToolsEnabled || mcpToolsEnabled;
  if (
    admissionPlan &&
    deps.providerAdmission &&
    requiresClientToolCoexistence &&
    admissionPlan.searches?.some((candidate) =>
      candidate.configuration.adapterKind === "answer_provider_hosted")
  ) {
    try {
      admissionPlan = await deps.providerAdmission.load({
        providerConnectionId: selectedProvider,
        providerModelId: selectedModelId,
        requiresClientToolCoexistence: true,
        searchPlan: requestedSearchPlan,
        ...(requestedSearchPreference
          ? {
              searchPreferencePlan: requestedSearchPreference.plan,
              searchPreferenceSource: requestedSearchPreference.source
            }
          : {}),
        searchStrategyId: requestedSearchStrategy,
        userId: input.userId
      });
    } catch (error) {
      if (error instanceof ProviderAdmissionError) {
        return failure(
          error.code,
          error.code === "credential_assignment_ambiguous" ? 409 : 403
        );
      }
      throw error;
    }
    requestedSearchPlan = admissionPlan.requestedSearchPlan ?? requestedSearchPlan;
    requestedSearchStrategy = admissionPlan.requestedSearchStrategyId;
    if (requestedSearchPreference) {
      requestedSearchPreference = {
        plan: admissionPlan.requestedSearchPreferencePlan !== undefined
          ? admissionPlan.requestedSearchPreferencePlan
          : requestedSearchPreference.plan,
        source: requestedSearchPreference.source
      };
    }
    modelConfiguration = admissionPlan.answer.modelConfiguration;
  }

  // The first plan may only establish that hosted Search conflicts with the
  // admitted client tools. Derive every runtime field once, from the final
  // plan whose exact answer binding will be persisted and revalidated.
  if (admissionPlan) {
    const answerPreview = createProviderPreviewRuntimeBinding(
      admissionPlan.answer.snapshot,
      deps.allowFakeProvider === true
    );
    previewRuntime = {
      adapter: answerPreview.adapter,
      ...(answerPreview.toolBridge ? { toolBridge: answerPreview.toolBridge } : {})
    };
    executionProvider = admissionPlan.answer.snapshot.providerFamily;
    executionModelId = admissionPlan.answer.snapshot.model.upstreamModelId;
    modelConfiguration = admissionPlan.answer.modelConfiguration;
  }
  if (!previewRuntime) {
    return failure("provider_not_available", 400);
  }

  const { adapter, toolBridge } = previewRuntime;
  const { capabilities: modelCapabilities, defaultParams } = modelConfiguration;
  const knowledgeToolsEnabled =
    body?.tools !== "none" &&
    modelCapabilities.toolCalling === true &&
    Boolean(knowledgeAdmissionPlan);
  const executionAdapterKind =
    modelConfiguration.adapterKind ?? legacyAdapterKind(executionProvider);
  const parameterProvider = parameterDialect(executionAdapterKind, executionProvider);

  if (!admissionPlan) {
    const enabled = await Promise.all(
      (requestedSearchPlan.optionIds.length
        ? requestedSearchPlan.optionIds
        : ["search-disabled"]
      ).map((strategyId) => deps.repository.isSearchStrategyEnabled(strategyId))
    );
    if (enabled.some((value) => !value)) {
      return failure("search_strategy_not_available", 403);
    }
  }

  const normalizedPrompt = assistantRun ? assistantPrompt(assistantRun) : standardChatPrompt(body);
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
  const parameterControls = parameterControlsForModel({
    adapterKind: executionAdapterKind,
    defaultParams,
    modelCapabilities,
    modelId: executionModelId,
    provider: parameterProvider,
    supportsReasoningMode:
      executionAdapterKind === "openai_responses_native" ||
      Boolean(modelConfiguration.reasoningRequestMapping?.modePath)
  });
  if (
    requestedSearchStrategy === perplexityToolSearchStrategyId &&
    !admissionPlan &&
    !deps.searchProviders?.openrouter
  ) {
    return failure("search_provider_not_available", 400);
  }
  // Provider-admitted plans use the provider-neutral Search router, including
  // the migrated Perplexity option. Keep the singleton policy path only for
  // installations still using the legacy repository admission boundary.
  const legacyPerplexitySearch = !admissionPlan &&
    requestedSearchStrategy === perplexityToolSearchStrategyId;
  let searchPolicy: ProviderSearchPolicy | undefined;
  if (legacyPerplexitySearch) {
    const strategyConfiguration =
      await deps.repository.loadSearchStrategyConfiguration(requestedSearchStrategy);
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
  let paramsBody: Record<string, unknown>;
  if (assistantRun) {
    const materialized = materializeAssistantRunParams({
      baseParams: defaultParams,
      controls: parameterControls,
      parameterProvider,
      runControls: assistantRun.runControls
    });
    if (!materialized.ok) {
      // A saved control the current model no longer supports is never clamped
      // or silently dropped; the run fails closed with a stable conflict.
      return failure("assistant_configuration_unavailable", 409);
    }
    paramsBody = materialized.params;
  } else {
    paramsBody = normalizeParams(body);
  }
  const paramValidation = validateRunParams({
    controls: parameterControls,
    params: paramsBody,
    provider: parameterProvider,
    ...(searchPolicy?.provider === "openrouter"
      ? { searchControls: searchPolicy.controls }
      : {})
  });
  if (!paramValidation.ok) {
    return failure(invalidRunParamsError, 400);
  }
  const runParams = mergeModelParams(parameterProvider, defaultParams, paramValidation.params);
  const searchStrategy = requestedSearchStrategy;
  const searchAdapter =
    legacyPerplexitySearch && searchStrategy === perplexityToolSearchStrategyId
      ? deps.searchProviders?.openrouter
      : undefined;

  const searchCompatibility = admissionPlan ? null : validateSearchStrategyForModel(
    executionAdapterKind,
    executionModelId,
    searchStrategy,
    modelCapabilities
  );
  if (searchCompatibility) {
    return failure(searchCompatibility.code, searchCompatibility.status);
  }

  if (legacyPerplexitySearch && !searchAdapter) {
    return failure("search_provider_not_available", 400);
  }

  if (assistantMcpUnavailable) {
    return failure("assistant_tools_not_available", 409, "Required MCP tools are unavailable.");
  }
  if (mcpPlan && !mcpPlan.ok) {
    if (assistantRun) {
      // Consumers may lack visibility into a required server, so the failure
      // is privacy-neutral and never names the affected servers.
      return failure("assistant_tools_not_available", 409, "Required MCP tools are unavailable.");
    }
    const affected = mcpPlan.issues.map((issue) => issue.name).join(", ");
    return failure(
      mcpPlan.code,
      409,
      affected ? `MCP tools are not ready: ${affected}.` : "MCP tools are not ready."
    );
  }
  const mcpCompatibility = validateMcpCapabilities({
    ...(toolBridge ? { bridge: toolBridge } : {}),
    capabilities: modelCapabilities,
    enabled: Boolean(mcpPlan?.ok && mcpPlan.snapshot.tools.length),
    modelId: executionModelId,
    params: runParams,
    provider: executionProvider
  });
  if (mcpCompatibility) return failure(mcpCompatibility.code, mcpCompatibility.status);

  let attachments: ProviderAttachment[];
  try {
    attachments = await loadProviderAttachments(deps, input.userId, attachmentIds, {
      capabilities: modelCapabilities,
      limits: attachmentLimits,
      ...(input.signal ? { signal: input.signal } : {})
    });
  } catch (error) {
    const rejected = attachmentFailure(error);
    if (rejected) return rejected;
    throw error;
  }

  if (attachments.length !== attachmentIds.length) {
    return failure("attachment_not_found", 400);
  }

  const attachmentAccess = validateAttachmentCapabilities(attachments, modelCapabilities);
  if (attachmentAccess) {
    return failure(attachmentAccess.code, attachmentAccess.status);
  }

  const pdfTextAvailability = validatePdfTextAvailability(attachments, modelCapabilities);
  if (pdfTextAvailability) {
    return failure(
      pdfTextAvailability.code,
      pdfTextAvailability.status,
      pdfTextAvailability.message
    );
  }

  const unbudgetedNormalizedRequest: NormalizedRunRequest = {
    attachmentIds,
    chatId: chat.id,
    content,
    context: { messages: contextMessages, mode: "branch_path" },
    knowledgePlan: { baseIds: [...decodedKnowledgePlan.plan.baseIds] },
    modelCapabilities,
    modelId: executionModelId,
    ...(mcpPlan?.ok && mcpPlan.snapshot.servers.length ? { mcp: mcpPlan.snapshot } : {}),
    params: runParams,
    prompt,
    provider: executionProvider,
    ...(searchPolicy ? { searchPolicy } : {}),
    ...(admissionPlan?.searches
      ? {
          searchPlan: {
            mode: requestedSearchPlan.mode,
            options: admissionPlan.searches.map((candidate) => ({
              adapterKind: candidate.configuration.adapterKind!,
              config: candidate.configuration.config,
              credentialMode: candidate.configuration.credentialMode!,
              displayName: candidate.configuration.displayName ?? "Search source",
              executionModes: candidate.configuration.executionModes ?? [],
              modelId: candidate.configuration.modelId,
              optionId: candidate.optionId,
              protocol: candidate.configuration.protocol!,
              provider: candidate.configuration.provider,
              providerModelId: candidate.configuration.providerModelId ?? null,
              revisionId: candidate.revisionId,
              searchStrategyRowId: candidate.integrationId
            }))
          }
        }
      : {}),
    searchStrategy,
    toolMode: body?.tools === "none" ? "none" : "auto"
  };
  const plannedSearchTools = unbudgetedNormalizedRequest.searchPlan
    ? createSearchPlanToolRouter({
        plan: unbudgetedNormalizedRequest.searchPlan,
        runtimes: {}
      })?.tools ?? []
    : [];
  const clientTools = unbudgetedNormalizedRequest.toolMode === "none"
    ? []
    : [
        ...(
          knowledgeToolsEnabled
            ? [knowledgeRetrievalTool]
            : []
        ),
        ...(plannedSearchTools.length
          ? plannedSearchTools
          : searchStrategy === perplexityToolSearchStrategyId
            ? [perplexityWebSearchTool]
            : []),
        ...mcpRunTools(unbudgetedNormalizedRequest.mcp)
      ];
  const unbudgetedProviderRequest: ProviderRunRequest = {
    ...unbudgetedNormalizedRequest,
    attachments,
    ...(clientTools.length > 0 ? { tools: clientTools } : {})
  };
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
    attachments: providerBudget.request.attachments,
    ...(clientTools.length > 0 ? { tools: clientTools } : {})
  };
  const providerRequestPreview = adapter.buildRequestPreview(providerRequest);
  // Assistant-derived values never overwrite the user's ordinary manual
  // defaults, so an Assistant run persists no accepted-defaults update.
  const defaults: PreparedRunDefaultsData | null = assistantRun
    ? null
    : {
        controlDefaults: runControlDefaultsFromBody(body, parameterControls),
        modelId: selectedModelId,
        provider: selectedProvider,
        searchStrategy: requestedSearchStrategy,
        searchPlan: requestedSearchPlan,
        ...(requestedSearchPreference && deps.providerAdmission
          ? { searchPreferencePlan: requestedSearchPreference.plan }
          : {}),
        userId: input.userId
      };

  const prepared = immutablePreparedData<MaterializedPreparedRunData>({
    ...(assistantRun
      ? {
          assistant: {
            assistantId: assistantRun.assistantId,
            revisionId: assistantRun.revisionId
          }
        }
      : {}),
    contextTruncation: providerBudget.contextTruncation,
    defaults,
    expectedActiveLeafId: input.source.kind === "send" ? input.source.chat.activeLeafMessageId : null,
    ...(knowledgeAdmissionPlan ? { knowledgeAdmissionPlan } : {}),
    ...(mcpPlan?.ok ? { mcpBindings: [...mcpPlan.bindings] } : {}),
    normalizedRequest,
    ...(admissionPlan ? { providerAdmissionPlan: admissionPlan } : {}),
    providerRequest,
    providerRequestPreview,
    sourceKind: input.source.kind
  });

  return Object.freeze({
    adapter,
    ok: true,
    prepared,
    searchAdapter,
    toolBridge
  });
}
