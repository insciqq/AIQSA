import type { ChatPdfAttachmentAdmission, ChatPdfRouteAdmission } from "../uploads/chatPdfAdmission";
import type { ProviderAdmissionRole } from "../providerRuntime/admission";
import { randomUUID } from "node:crypto";
import { textMessageContent } from "../../domain/content";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import {
  decodeKnowledgePlan,
  decodeKnowledgeSelection,
  EMPTY_KNOWLEDGE_SELECTION,
  type KnowledgePlan
} from "../../contracts/knowledge";
import { decodeMcpRunSelection } from "../../contracts/mcp";
import { decodeSkillIds, SKILL_MAX_SELECTED } from "../../contracts/skills";
import { resolveStandardChatBaseline } from "../../domain/promptTemplates";
import type { AssistantRunControls } from "../../contracts/assistants";
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
  resolveAcceptedRunReasoningEffort,
  validateRunParams
} from "../../domain/runParams";
import {
  canonicalizeMaxOutputTokenParams
} from "../../domain/providerParams";
import { decodeSearchPlan } from "../../domain/search";
import {
  ProviderAdmissionError,
  type ProviderAdmissionPlan
} from "../providerRuntime/admission";
import { createProviderPreviewRuntimeBinding } from "../providers/runtimeFactory";
import { MEMORY_ACTION_NO_COMMIT_RESULT } from "../providers/memoryActionAnswer";
import type {
  NormalizedRunRequest,
  ProviderAdapter,
  ProviderAttachment,
  ProviderConversationMessage,
  ProviderModelCapabilities,
  ProviderRunRequest
} from "../providers/types";
import type { StorageAdapter } from "../uploads/storage";
import {
  decodeMemoryInitialChatMode,
  type MemoryInitialChatMode
} from "../../contracts/memory";
import {
  knowledgeRunAdmissionHasReadySources,
  KnowledgeRunAdmissionError,
  type KnowledgeRunAdmissionPlan
} from "../knowledge/runAdmission";
import type {
  McpCapabilityCatalog,
  McpRunPlanBinding,
  McpRunPlanResult
} from "../mcp/runPlan";
import type { McpSemanticRouter } from "../mcp/router";
import { mcpFindToolsTool } from "../mcp/discovery";
import { mcpRunTools } from "../mcp/toolExecutor";
import type { ProviderToolBridge } from "../tools/types";
import type {
  SkillRunMaterialization,
  SkillRunResolver
} from "../skills/runMaterialization";
import { withSelectedSkillContext } from "../skills/userContext";
import { createSearchPlanToolRouter } from "../search/toolExecutor";
import { knowledgeRetrievalTool } from "../knowledge/knowledgeTools";
import {
  knowledgeAdmissionMayFitFullContext,
  knowledgeAnsweringRequestSnapshot,
  KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT,
  planKnowledgeAnswering,
  type KnowledgeAnsweringPlan
} from "../knowledge/fullContext";
import {
  knowledgeEvidenceMessageFromDispatchDraft,
  withAutomaticKnowledgeEvidence
} from "../knowledge/automaticEvidence";
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
  AcceptedSkillRun,
  ProjectRunAdmission,
  RunModelConfiguration,
  RunRepository
} from "./runRepositoryContract";
import {
  DEFAULT_TOOL_RUN_BUDGETS,
  type ToolRunBudgets
} from "./toolBudgets";
import type {
  WorkspaceAdmissionService,
  WorkspaceRunAdmissionPlan
} from "../workspace/admission";

const visibleAnswerContract =
  "Visible answer contract: answer the user directly in the chat message. Do not include debug sections such as Question, Search, Provider Parameters, Request Preview, Artifacts, Usage, or Errors, and do not expose provider, retrieval, tool, request, usage, or event internals. Include citations naturally only when they help the answer.";
const currentSendMessageId = "current-user-message";
const pdfTextUnavailableMessage =
  "No extractable text was found. Choose a model with native PDF support or remove this file.";
const zeroEmittedPdfTextUnavailableMessage =
  "No PDF text could be retained within the configured limit. Choose a model with native PDF support or remove this file.";

function parameterDialect(adapterKind: CatalogAdapterKind, providerFamily: string): string {
  if (providerFamily === "deepseek") return "deepseek";
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
> & Partial<Pick<RunRepository, "loadKnowledgeFullContextPassages">>;

export type RunPreparationDeps = Readonly<{
  allowFakeProvider?: boolean;
  assistants?: AssistantRunResolver;
  getAttachmentLimits?: () => RunAttachmentLimits;
  knowledgeAdmission?: Readonly<{
    load(input: {
      executionScope?: "project";
      knowledgePlan: KnowledgePlan;
      preferredProfileRevisionId?: string;
      projectId?: string;
      userId: string;
    }): Promise<KnowledgeRunAdmissionPlan>;
  }>;
  mcp?: Readonly<{
    catalog?(userId: string): Promise<McpCapabilityCatalog>;
    materialize?(
      userId: string,
      tools: readonly Readonly<{
        namespacedName: string;
        revisionId: string;
        serverId: string;
      }>[]
    ): Promise<McpRunPlanResult>;
    prepare(
      userId: string,
      options?: Readonly<{ allowedServerIds?: readonly string[] }>
    ): Promise<McpRunPlanResult>;
    /** Project MCP admission is intentionally independent of the initiating
     * user's grants, personal slots, and OAuth connections. */
    prepareProject?(serverIds: readonly string[]): Promise<McpRunPlanResult>;
    router?: McpSemanticRouter;
  }>;
  providers: Readonly<Record<string, ProviderAdapter>>;
  providerAdmission?: Readonly<{
    load(input: {
      executionScope?: "project";
      providerConnectionId: string;
      providerModelId: string;
      requiresClientToolCoexistence?: boolean;
      searchPlan: import("../../domain/search").SearchPlan;
      searchPreferencePlan?: import("../../domain/search").SearchPlan | null;
      searchPreferenceSource?: "organization" | "personal";
      userId: string;
    }): Promise<ProviderAdmissionPlan>;
  }>;
  chatPdf?: Readonly<{ resolve(answer: ProviderAdmissionRole): Promise<ChatPdfRouteAdmission> }>;
  repository: RunPreparationRepository;
  runPolicy?: Readonly<{
    load(): Promise<ToolRunBudgets>;
  }>;
  skills?: SkillRunResolver;
  storage?: Pick<StorageAdapter, "getObject">;
  workspace?: WorkspaceAdmissionService;
}>;

export type SendRunPreparationSource = Readonly<{
  chat: Readonly<{
    activeLeafMessageId: string | null;
    defaultKnowledgePlan?: unknown;
    defaultModelId: string;
    defaultProvider: string;
    folderDefaultKnowledgePlan?: unknown;
    id: string;
    memoryMode?: "NORMAL" | "EXCLUDED" | "TEMPORARY";
    messageCount?: number;
    projectMemory: string | null;
    project?: ProjectRunAdmission;
    workspaceEnabled?: boolean;
  }>;
  draftProjectChat?: boolean;
  draftPersonalChat?: boolean;
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
      memoryMode?: "NORMAL" | "EXCLUDED" | "TEMPORARY";
      projectMemory: string | null;
      project?: ProjectRunAdmission;
      workspaceEnabled?: boolean;
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

export type MaterializedPreparedRunData = {
  assistant?: { assistantId: string; revisionId: string };
  chatPdfAdmissions?: ChatPdfAttachmentAdmission[];
  contextTruncation: ContextTruncationSummary | null;
  defaults: PreparedRunDefaultsData | null;
  expectedActiveLeafId: string | null;
  initialChatMode?: MemoryInitialChatMode;
  knowledgeAdmissionPlan?: KnowledgeRunAdmissionPlan;
  mcpBindings?: McpRunPlanBinding[];
  skillBindings?: AcceptedSkillRun[];
  workspaceAdmissionPlan?: WorkspaceRunAdmissionPlan;
  normalizedRequest: NormalizedRunRequest;
  providerAdmissionPlan: ProviderAdmissionPlan;
  providerRequest: ProviderRunRequest;
  providerRequestPreview: Record<string, unknown>;
  sourceKind: RunPreparationInput["source"]["kind"];
  project?: ProjectRunAdmission;
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

type ResolvedRunChatMode = Readonly<{
  initialChatMode?: MemoryInitialChatMode;
  mode: "NORMAL" | "EXCLUDED" | "TEMPORARY";
}>;

function resolveRunChatMode(
  body: Readonly<Record<string, unknown>> | null,
  source: RunPreparationInput["source"]
): ResolvedRunChatMode | RunPreparationFailure {
  const hasMode = body !== null && Object.hasOwn(body, "chatMode");
  const hasPolicy = body !== null && Object.hasOwn(body, "temporaryRetentionPolicyVersion");
  if (source.kind === "regenerate") {
    if (hasMode || hasPolicy) {
      return failure("memory_temporary_chat_forbidden", 409);
    }
    return { mode: source.source.chat.memoryMode ?? "NORMAL" };
  }

  const currentMode = source.chat.memoryMode ?? "NORMAL";
  let requested: MemoryInitialChatMode;
  if (hasMode || hasPolicy) {
    const decoded = decodeMemoryInitialChatMode({
      ...(hasMode ? { chatMode: body?.chatMode } : {}),
      ...(hasPolicy
        ? { temporaryRetentionPolicyVersion: body?.temporaryRetentionPolicyVersion }
        : {})
    });
    if (!decoded.ok) {
      return failure("memory_temporary_policy_review_required", 409);
    }
    requested = decoded.value;
  } else {
    return { mode: currentMode };
  }

  const requestedMode = requested.chatMode;
  const firstSend = (source.chat.messageCount ?? 0) === 0;
  const conversionAllowed = firstSend && currentMode === "NORMAL";
  const matchesCurrent = requestedMode === currentMode;
  if (!matchesCurrent && !(requestedMode === "TEMPORARY" && conversionAllowed)) {
    return failure("memory_temporary_chat_forbidden", 409);
  }
  return {
    initialChatMode: requested,
    mode: requestedMode
  };
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
    ...(prepared.chatPdfAdmissions
      ? { chatPdfAdmissions: mutablePreparedData<ChatPdfAttachmentAdmission[]>(prepared.chatPdfAdmissions) }
      : {}),
    ...(prepared.assistant
      ? { assistant: mutablePreparedData<{ assistantId: string; revisionId: string }>(prepared.assistant) }
      : {}),
    contextTruncation: mutablePreparedData<ContextTruncationSummary | null>(prepared.contextTruncation),
    defaults: mutablePreparedData<PreparedRunDefaultsData | null>(prepared.defaults),
    expectedActiveLeafId: prepared.expectedActiveLeafId,
    ...(prepared.project ? { project: mutablePreparedData<ProjectRunAdmission>(prepared.project) } : {}),
    ...(prepared.initialChatMode
      ? { initialChatMode: mutablePreparedData<MemoryInitialChatMode>(prepared.initialChatMode) }
      : {}),
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
    ...(prepared.skillBindings
      ? { skillBindings: mutablePreparedData<AcceptedSkillRun[]>(prepared.skillBindings) }
      : {}),
    ...(prepared.workspaceAdmissionPlan
      ? {
          workspaceAdmissionPlan: mutablePreparedData<WorkspaceRunAdmissionPlan>(
            prepared.workspaceAdmissionPlan
          )
        }
      : {}),
    normalizedRequest: mutablePreparedData<NormalizedRunRequest>(prepared.normalizedRequest),
    providerAdmissionPlan: mutablePreparedData<ProviderAdmissionPlan>(
      prepared.providerAdmissionPlan
    ),
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

function resolveWorkspaceEnabled(
  body: Readonly<Record<string, unknown>> | null,
  persisted: boolean | undefined
): boolean | null {
  if (!body || !Object.hasOwn(body, "workspace")) return persisted === true;
  const value = body.workspace;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("enabled" in value) ||
    typeof (value as { enabled?: unknown }).enabled !== "boolean"
  ) {
    return null;
  }
  return (value as { enabled: boolean }).enabled;
}

function promptWithWorkspaceContract(
  prompt: NormalizedRunRequest["prompt"],
  workspace: WorkspaceRunAdmissionPlan,
  attachments: readonly ProviderAttachment[]
): NormalizedRunRequest["prompt"] {
  const files = attachments.slice(0, 64).map((attachment) =>
    `- ${attachment.fileName.slice(0, 256)} (${attachment.mimeType.slice(0, 128)}, ${attachment.byteSize} bytes)`
  );
  const contract = [
    "Workspace is active.",
    `Working directory: ${workspace.normalized.projectDirectory}`,
    "Original attachments: /workspace/inbox",
    `Attachment index: ${workspace.normalized.inboxIndexPath}`,
    `Current message manifest: ${workspace.normalized.messageManifestPath}`,
    "Do not modify originals in inbox; copy files that need changes into project.",
    `Internet inside the workspace: ${workspace.normalized.internetEnabled ? "enabled (public destinations only)" : "disabled"}.`,
    "You may install required packages through available package managers.",
    `Put user-downloadable files only in ${workspace.normalized.outputDirectory}.`,
    "After changes, run appropriate tests or checks.",
    "Do not claim that a file was created or a check passed until a tool verified it.",
    ...(files.length > 0 ? ["Current message attachments:", ...files] : [])
  ].join("\n");
  return {
    ...prompt,
    system: [prompt.system, contract]
      .filter((part): part is string => Boolean(part?.trim()))
      .join("\n\n") || null
  };
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

function projectRunControlsFromDefaults(
  values: Readonly<Record<string, boolean | string>>
): AssistantRunControls | null {
  const allowed = new Set([
    "backgroundMode",
    "maxOutputTokens",
    "reasoningEffort",
    "reasoningMode",
    "streamMode",
    "temperature"
  ]);
  if (Object.keys(values).some((key) => !allowed.has(key))) return null;
  const controls: AssistantRunControls = {};
  if (values.backgroundMode !== undefined) {
    if (typeof values.backgroundMode !== "boolean") return null;
    controls.backgroundMode = values.backgroundMode;
  }
  if (values.streamMode !== undefined) {
    if (typeof values.streamMode !== "boolean") return null;
    controls.streamMode = values.streamMode;
  }
  if (values.maxOutputTokens !== undefined) {
    const parsed = numberFromDraft(values.maxOutputTokens);
    if (parsed === null || !Number.isInteger(parsed) || parsed < 1) return null;
    controls.maxOutputTokens = parsed;
  }
  if (values.temperature !== undefined) {
    const parsed = numberFromDraft(values.temperature);
    if (parsed === null) return null;
    controls.temperature = parsed;
  }
  if (values.reasoningEffort !== undefined) {
    if (typeof values.reasoningEffort !== "string" || !values.reasoningEffort) return null;
    controls.reasoningEffort = values.reasoningEffort;
  }
  if (values.reasoningMode !== undefined) {
    if (typeof values.reasoningMode !== "string" || !values.reasoningMode) return null;
    controls.reasoningMode = values.reasoningMode;
  }
  return controls;
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
 * browser cannot replace the baseline or supply rendered date/time text;
 * client-sent prompt fields have no authority.
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
  "mcp",
  "knowledgePlan",
  "params",
  "prompt",
  "provider",
  "searchPlan",
  "searchPreferencePlan",
  "searchPreferenceSource",
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
    return decodeKnowledgeSelection(body.knowledgePlan);
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
  return decodeKnowledgeSelection(EMPTY_KNOWLEDGE_SELECTION);
}

function promptWithSharedProjectContext(
  prompt: NormalizedRunRequest["prompt"],
  project: ProjectRunAdmission
): NormalizedRunRequest["prompt"] {
  const instructions = project.instructions.trim();
  return {
    ...prompt,
    system: [
      prompt.system,
      ...(instructions ? [`Project Instructions:\n${instructions}`] : [])
    ].filter((part): part is string => Boolean(part?.trim())).join("\n\n") || null
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
  capabilities: ProviderModelCapabilities,
  workspaceEnabled = false
): { code: string; status: 400 } | null {
  const hasPdf = attachments.some((attachment) => attachment.kind === "pdf");
  const hasImage = attachments.some((attachment) => attachment.kind === "image");

  if (!workspaceEnabled && attachments.some((attachment) => attachment.kind === "file")) {
    return { code: "unsupported_attachment_type", status: 400 };
  }

  if (hasPdf && !workspaceEnabled && !capabilities.pdf && !capabilities.nativePdfInput) {
    return { code: "pdf_attachment_not_supported", status: 400 };
  }

  if (hasImage && !workspaceEnabled && !capabilities.vision) {
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
  capabilities: ProviderModelCapabilities,
  workspaceEnabled = false
): { code: string; message: string; status: 400 } | null {
  if (workspaceEnabled || capabilities.nativePdfInput || !capabilities.pdf) {
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

function validateKnowledgeCapabilities(input: Readonly<{
  bridge?: ProviderToolBridge;
  capabilities: ProviderModelCapabilities;
  enabled: boolean;
  modelId: string;
  provider: string;
}>): { code: string; status: 400 } | null {
  if (!input.enabled) return null;
  return input.bridge?.supportsToolCalling({
    modelId: input.modelId,
    provider: input.provider
  }) && input.capabilities.toolCalling === true
    ? null
    : { code: "knowledge_tool_calling_not_supported", status: 400 };
}

export async function prepareRun(
  deps: RunPreparationDeps,
  input: RunPreparationInput
): Promise<RunPreparationResult> {
  const body = input.body;
  const toolBudgets = deps.runPolicy
    ? await deps.runPolicy.load()
    : DEFAULT_TOOL_RUN_BUDGETS;
  const chat = input.source.kind === "send" ? input.source.chat : input.source.source.chat;
  const workspaceEnabled = resolveWorkspaceEnabled(body, chat.workspaceEnabled);
  if (workspaceEnabled === null) {
    return failure("workspace_intent_invalid", 400);
  }
  // Keep the persisted Project Memory contract intact while making the
  // admission snapshot explicitly dormant. This prevents callers supplying a
  // stale/enabled in-memory snapshot from reintroducing Project Memory text or
  // bindings into a new send or regeneration.
  const project = chat.project
    ? { ...chat.project, memoryEnabled: false, memoryItems: [] }
    : undefined;

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
    const resolution = project
      ? deps.assistants.resolveForProject
        ? await deps.assistants.resolveForProject(project.projectId, body.assistantId.trim())
        : { code: "assistant_not_available" as const, ok: false as const, status: 404 as const }
      : await deps.assistants.resolveForRun(input.userId, body.assistantId.trim());
    if (!resolution.ok) {
      return failure(resolution.code, resolution.status);
    }
    assistantRun = resolution.assistant;
  }

  if (!assistantRun && project?.defaults.assistantId &&
    !assistantGovernedBodyKeys.some((key) => Object.hasOwn(body ?? {}, key))) {
    if (!deps.assistants?.resolveForProject) return failure("assistant_not_available", 503);
    const resolution = await deps.assistants.resolveForProject(
      project.projectId,
      project.defaults.assistantId
    );
    if (!resolution.ok) return failure(resolution.code, resolution.status);
    assistantRun = resolution.assistant;
  }

  let manualSkillIds: string[] = [];
  if (body && Object.prototype.hasOwnProperty.call(body, "skillIds")) {
    const decoded = decodeSkillIds(body.skillIds);
    if (!decoded.ok) return failure(decoded.code, 400);
    manualSkillIds = decoded.ids;
  }
  const effectiveSkillIds = [...(assistantRun?.skillIds ?? []), ...manualSkillIds]
    .filter((skillId, index, values) => values.indexOf(skillId) === index);
  if (effectiveSkillIds.length > SKILL_MAX_SELECTED) {
    return failure("skills_invalid", 400);
  }
  let skillRuns: SkillRunMaterialization[] = [];
  if (effectiveSkillIds.length > 0) {
    if (!deps.skills) return failure("skill_not_available", 404);
    if (project && effectiveSkillIds.some((skillId) => !project.skillIds?.includes(skillId))) {
      return failure("skill_not_available", 404);
    }
    const resolution = project
      ? deps.skills.resolveForProject
        ? await deps.skills.resolveForProject(project.projectId, effectiveSkillIds)
        : { code: "skill_not_available" as const, ok: false as const, status: 404 as const }
      : await deps.skills.resolveForRun(input.userId, effectiveSkillIds);
    if (!resolution.ok) return failure(resolution.code, resolution.status);
    skillRuns = resolution.skills;
  }

  if (project && (
    Object.hasOwn(body ?? {}, "chatMode") ||
    Object.hasOwn(body ?? {}, "temporaryRetentionPolicyVersion")
  )) {
    return failure("memory_temporary_chat_forbidden", 409);
  }
  const resolvedChatMode = project
    ? { mode: "EXCLUDED" as const }
    : resolveRunChatMode(body, input.source);
  if ("ok" in resolvedChatMode) {
    return resolvedChatMode;
  }
  const decodedKnowledgePlan = assistantRun
    ? { ok: true as const, plan: assistantRun.knowledgeSelection }
    : resolvedOrdinaryKnowledgePlan(body, chat);
  if (!decodedKnowledgePlan.ok) {
    return failure(decodedKnowledgePlan.code, 400);
  }
  if (body && Object.hasOwn(body, "knowledgePlan") &&
    decodedKnowledgePlan.plan.mode === "inherited") {
    return failure("knowledge_plan_invalid", 400);
  }
  if (decodedKnowledgePlan.plan.mode === "inherited" &&
    (!project || decodedKnowledgePlan.plan.inheritedFrom !== "project")) {
    return failure("knowledge_plan_invalid", 400);
  }
  if (project && decodedKnowledgePlan.plan.mode === "all_my_knowledge") {
    return failure("knowledge_base_not_available", 404);
  }
  if (project && (
    decodedKnowledgePlan.plan.baseIds.some((id) => !project.knowledgeBaseIds.includes(id)) ||
    (project.knowledgeBaseIds.length === 0 && decodedKnowledgePlan.plan.baseIds.length > 0)
  )) {
    return failure("knowledge_base_not_available", 404);
  }
  let knowledgeAdmissionPlan: KnowledgeRunAdmissionPlan | undefined;
  if (decodedKnowledgePlan.plan.mode !== "none") {
    if (!deps.knowledgeAdmission) {
      return failure("knowledge_base_not_available", 503);
    }
    try {
      knowledgeAdmissionPlan = await deps.knowledgeAdmission.load({
        ...(project ? { executionScope: "project" as const } : {}),
        knowledgePlan: decodedKnowledgePlan.plan,
        ...(project ? { projectId: project.projectId } : {}),
        userId: input.userId
      });
    } catch (error) {
      if (error instanceof KnowledgeRunAdmissionError) {
        return failure(error.code, 404);
      }
      throw error;
    }
    if (!knowledgeRunAdmissionHasReadySources(knowledgeAdmissionPlan)) {
      return failure(
        "sources_processing",
        409,
        "Selected Knowledge documents are still processing."
      );
    }
  }
  const knowledgeRequested = decodedKnowledgePlan.plan.mode !== "none";

  const decodedSearchPlan = assistantRun
    ? null
    : decodeSearchPlan(body?.searchPlan ?? (project ? project.defaults.searchPlan : undefined));
  if (!assistantRun && body?.searchPlan === undefined && !project) {
    return failure("search_plan_invalid", 400);
  }
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
  if (project && body && (
    "searchPreferencePlan" in body || "searchPreferenceSource" in body
  )) {
    return failure("search_preference_invalid", 400);
  }
  if (!assistantRun && body &&
    ("searchPreferencePlan" in body || "searchPreferenceSource" in body)) {
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
  const firstProjectSend = Boolean(
    project && input.source.kind === "send" && input.source.draftProjectChat
  );
  if (firstProjectSend && !project?.defaults.providerModelId) {
    return failure(
      "project_setup_required",
      409,
      "Choose a Project default model before starting a shared chat."
    );
  }
  if (firstProjectSend && project && (
    !project.modelIds.includes(project.defaults.providerModelId!) ||
    chat.defaultModelId !== project.defaults.providerModelId ||
    !chat.defaultProvider
  )) {
    return failure(
      "project_default_model_unavailable",
      409,
      "The Project default model is unavailable."
    );
  }
  if (project && !project.modelIds.includes(selectedModelId)) {
    return failure("provider_not_available", 403);
  }
  if (project && assistantRun && !project.assistantBindings.some((binding) =>
    binding.assistantId === assistantRun.assistantId && binding.revisionId === assistantRun.revisionId
  )) {
    return failure("assistant_not_available", 404);
  }
  if (project && (
    requestedSearchPlan.optionIds.some((id) => !project.searchOptionIds.includes(id)) ||
    (project.searchOptionIds.length === 0 && requestedSearchPlan.optionIds.length > 0)
  )) {
    return failure("search_plan_invalid", 404);
  }
  const providerAdmission = deps.providerAdmission;
  if (!providerAdmission) {
    return firstProjectSend
      ? failure("project_default_model_unavailable", 409, "The Project default model is unavailable.")
      : failure("provider_not_available", 503);
  }
  if (firstProjectSend && project?.defaults.providerModelId) {
    try {
      await providerAdmission.load({
        executionScope: "project",
        providerConnectionId: chat.defaultProvider,
        providerModelId: project.defaults.providerModelId,
        searchPlan: { mode: "all_selected", optionIds: [] },
        userId: input.userId
      });
    } catch (error) {
      if (error instanceof ProviderAdmissionError) {
        return failure(
          "project_default_model_unavailable",
          409,
          "The Project default model is unavailable."
        );
      }
      throw error;
    }
  }
  let admissionPlan: ProviderAdmissionPlan;
  let executionProvider = selectedProvider;
  let executionModelId = selectedModelId;
  let modelConfiguration: RunModelConfiguration;
  try {
    admissionPlan = await providerAdmission.load({
      ...(project ? { executionScope: "project" as const } : {}),
      providerConnectionId: selectedProvider,
      providerModelId: selectedModelId,
      ...(knowledgeRequested || workspaceEnabled
        ? { requiresClientToolCoexistence: true }
        : {}),
      searchPlan: requestedSearchPlan,
      ...(requestedSearchPreference && !project
        ? {
            searchPreferencePlan: requestedSearchPreference.plan,
            searchPreferenceSource: requestedSearchPreference.source
          }
        : {}),
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
  let acceptedSearchPlan = admissionPlan.requestedSearchPlan;
  requestedSearchPlan = acceptedSearchPlan;
  if (project && requestedSearchPlan.optionIds.some((id) =>
    !project.searchOptionIds.includes(id)
  )) {
    return failure("search_plan_invalid", 404);
  }
  if (requestedSearchPreference) {
    requestedSearchPreference = {
      plan: admissionPlan.requestedSearchPreferencePlan !== undefined
        ? admissionPlan.requestedSearchPreferencePlan
        : requestedSearchPreference.plan,
      source: requestedSearchPreference.source
    };
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

  const ordinaryMcpSelection = project || assistantRun || body?.tools === "none"
    ? null
    : body?.mcp === undefined
      ? { mode: "auto" as const }
      : decodeMcpRunSelection(body.mcp);
  if (!project && !assistantRun && body?.tools !== "none" &&
    ordinaryMcpSelection === null) {
    return failure("mcp_selection_invalid", 400);
  }
  const assistantMcpUnavailable = Boolean(
    assistantRun && assistantRun.mcpServerIds.length > 0 && !deps.mcp
  );
  const ordinaryLoadAllMcpUnavailable = Boolean(
    ordinaryMcpSelection?.mode === "load_all" && !deps.mcp
  );
  const projectMcpSelection = project && body?.tools !== "none"
    ? body?.mcp === undefined
      ? { mode: project.defaults.mcpMode }
      : decodeMcpRunSelection(body.mcp)
    : null;
  if (project && body?.tools !== "none" &&
    projectMcpSelection === null) {
    return failure("mcp_selection_invalid", 400);
  }
  const projectMcpServerIds = project
    ? assistantRun
      ? assistantRun.mcpServerIds
      : projectMcpSelection?.mode === "off"
        ? []
        : project.mcpServerIds
    : [];
  if (project && assistantRun && projectMcpServerIds.some((id) => !project.mcpServerIds.includes(id))) {
    return failure("assistant_tools_not_available", 409, "Required MCP tools are unavailable.");
  }
  if (project && !project.policy.externalToolsEnabled && (
    requestedSearchPlan.optionIds.length > 0 || projectMcpServerIds.length > 0
  )) {
    return failure("project_external_tools_disabled", 403);
  }
  const mcpPlan = project
    ? projectMcpServerIds.length > 0 && deps.mcp
      ? deps.mcp.prepareProject
        ? await deps.mcp.prepareProject(projectMcpServerIds)
        : process.env.NODE_ENV === "production"
          ? null
          : await deps.mcp.prepare(input.userId, { allowedServerIds: projectMcpServerIds })
      : null
    : assistantRun
    ? assistantRun.mcpServerIds.length > 0 && deps.mcp
      ? await deps.mcp.prepare(input.userId, {
          allowedServerIds: assistantRun.mcpServerIds
        })
      : null
    : ordinaryMcpSelection?.mode === "load_all" && deps.mcp
      ? await deps.mcp.prepare(input.userId)
      : null;
  const mcpCatalog = ordinaryMcpSelection?.mode === "auto" &&
    deps.mcp?.catalog
    ? await deps.mcp.catalog(input.userId)
    : null;
  if (project && projectMcpServerIds.length > 0 && !mcpPlan) {
    return failure(
      "project_mcp_not_configured",
      503,
      "Project shared MCP execution is not configured."
    );
  }
  const mcpDiscoveryEnabled = !project && Boolean(mcpCatalog?.servers.length);
  if (project && mcpPlan?.ok && mcpPlan.snapshot.servers.some((server) =>
    server.credentialSources?.some((source) => source === "oauth" || source === "personal")
  )) {
    return failure(
      "project_mcp_personal_credentials_forbidden",
      403,
      "Project chats can use only shared or no-auth MCP credentials."
    );
  }
  if (project && mcpPlan && !mcpPlan.ok && mcpPlan.issues.some((issue) =>
    issue.errorCode === "mcp_project_credentials_unavailable"
  )) {
    return failure(
      "project_mcp_personal_credentials_forbidden",
      403,
      "Project chats can use only shared or no-auth MCP credentials."
    );
  }

  const mcpToolsEnabled = mcpDiscoveryEnabled ||
    Boolean(mcpPlan?.ok && mcpPlan.snapshot.tools.length > 0);
  const requiresClientToolCoexistence = knowledgeRequested || mcpToolsEnabled || workspaceEnabled;
  if (
    requiresClientToolCoexistence &&
    admissionPlan.searches.some((candidate) =>
      candidate.configuration.adapterKind === "answer_provider_hosted")
  ) {
    try {
      admissionPlan = await providerAdmission.load({
        ...(project ? { executionScope: "project" as const } : {}),
        providerConnectionId: selectedProvider,
        providerModelId: selectedModelId,
        requiresClientToolCoexistence: true,
        searchPlan: requestedSearchPlan,
        ...(requestedSearchPreference && !project
          ? {
              searchPreferencePlan: requestedSearchPreference.plan,
              searchPreferenceSource: requestedSearchPreference.source
            }
          : {}),
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
    acceptedSearchPlan = admissionPlan.requestedSearchPlan;
    requestedSearchPlan = acceptedSearchPlan;
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
  if (project && requestedSearchPlan.optionIds.some((id) =>
    !project.searchOptionIds.includes(id)
  )) {
    return failure("search_plan_invalid", 404);
  }
  if (project && !project.policy.externalToolsEnabled && requestedSearchPlan.optionIds.length > 0) {
    return failure("project_external_tools_disabled", 403);
  }

  // The first plan may only establish that hosted Search conflicts with the
  // admitted client tools. Derive every runtime field once, from the final
  // plan whose exact answer binding will be persisted and revalidated.
  const answerPreview = createProviderPreviewRuntimeBinding(
    admissionPlan.answer.snapshot,
    deps.allowFakeProvider === true
  );
  const previewRuntime = {
    adapter: answerPreview.adapter,
    ...(answerPreview.toolBridge ? { toolBridge: answerPreview.toolBridge } : {})
  };
  executionProvider = admissionPlan.answer.snapshot.providerFamily;
  executionModelId = admissionPlan.answer.snapshot.model.upstreamModelId;
  modelConfiguration = admissionPlan.answer.modelConfiguration;

  const { adapter, toolBridge } = previewRuntime;
  const { capabilities: modelCapabilities, defaultParams } = modelConfiguration;
  const executionAdapterKind = modelConfiguration.adapterKind;
  const parameterProvider = parameterDialect(executionAdapterKind, executionProvider);

  const normalizedPrompt = assistantRun ? assistantPrompt(assistantRun) : standardChatPrompt(body);
  // Project Memory (both the legacy folder field and the newer Project
  // Memory facts) is dormant for Personal Memory v1. Project instructions
  // remain part of the Project contract; no memory text crosses this
  // provider boundary for send or regeneration.
  const scopedPrompt = project
    ? promptWithSharedProjectContext(normalizedPrompt, project)
    : normalizedPrompt;
  let prompt: NormalizedRunRequest["prompt"] = {
    ...scopedPrompt,
    memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT
  };
  const sendContext =
    input.source.kind === "send"
      ? input.source.draftProjectChat || input.source.draftPersonalChat
        ? []
        : await deps.repository.loadConversationContextForExpectedLeaf(
            chat.id,
            input.userId,
            input.source.chat.activeLeafMessageId
          )
      : null;
  if (input.source.kind === "send" && !sendContext) {
    return failure("active_leaf_changed", 409);
  }
  const conversationMessages: ProviderConversationMessage[] =
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
  const contextMessages = withSelectedSkillContext(conversationMessages, skillRuns);
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
  } else if (project) {
    const projectControls = projectRunControlsFromDefaults(project.defaults.controlValues);
    if (!projectControls) return failure("project_configuration_unavailable", 409);
    const materialized = materializeAssistantRunParams({
      baseParams: defaultParams,
      controls: parameterControls,
      parameterProvider,
      runControls: projectControls
    });
    if (!materialized.ok) return failure("project_configuration_unavailable", 409);
    paramsBody = mergeParamObjects(materialized.params, normalizeParams(body));
  } else {
    paramsBody = normalizeParams(body);
  }
  const paramValidation = validateRunParams({
    controls: parameterControls,
    params: paramsBody,
    provider: parameterProvider
  });
  if (!paramValidation.ok) {
    return failure(invalidRunParamsError, 400);
  }
  const runParams = mergeModelParams(parameterProvider, defaultParams, paramValidation.params);
  const acceptedReasoning = resolveAcceptedRunReasoningEffort({
    controls: parameterControls,
    params: runParams,
    provider: parameterProvider
  });
  if (!acceptedReasoning.ok) {
    return failure(acceptedReasoning.code, 400);
  }

  if (assistantMcpUnavailable) {
    return failure("assistant_tools_not_available", 409, "Required MCP tools are unavailable.");
  }
  if (ordinaryLoadAllMcpUnavailable) {
    return failure("mcp_not_ready", 409, "Enabled MCP tools are unavailable.");
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
    enabled: mcpToolsEnabled,
    modelId: executionModelId,
    params: runParams,
    provider: executionProvider
  });
  if (mcpCompatibility) return failure(mcpCompatibility.code, mcpCompatibility.status);

  const pdfRoute = deps.chatPdf && attachmentIds.length
    ? await deps.chatPdf.resolve(admissionPlan.answer) : undefined;
  let chatPdfAdmissions: ChatPdfAttachmentAdmission[] = [];
  let attachments: ProviderAttachment[];
  try {
    attachments = await loadProviderAttachments(deps, input.userId, attachmentIds, {
      capabilities: modelCapabilities,
      ...(pdfRoute ? { pdfRoute, onPdfAdmissions: (items: ChatPdfAttachmentAdmission[]) => { chatPdfAdmissions = items; } } : {}),
      limits: attachmentLimits,
      ...(project ? { projectId: project.projectId } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      workspaceEnabled
    });
  } catch (error) {
    const rejected = attachmentFailure(error);
    if (rejected) return rejected;
    throw error;
  }

  if (attachments.length !== attachmentIds.length) {
    return failure("attachment_not_found", 400);
  }

  const attachmentAccess = validateAttachmentCapabilities(
    attachments,
    pdfRoute ? { ...modelCapabilities, pdf: true } : modelCapabilities,
    workspaceEnabled
  );
  if (attachmentAccess) {
    return failure(attachmentAccess.code, attachmentAccess.status);
  }

  const pdfTextAvailability = pdfRoute ? null : validatePdfTextAvailability(
    attachments,
    modelCapabilities,
    workspaceEnabled
  );
  if (pdfTextAvailability) {
    return failure(
      pdfTextAvailability.code,
      pdfTextAvailability.status,
      pdfTextAvailability.message
    );
  }

  let workspaceAdmissionPlan: WorkspaceRunAdmissionPlan | undefined;
  let workspaceTools: readonly import("../tools/types").RunTool[] = [];
  if (workspaceEnabled) {
    if (!deps.workspace) return failure("workspace_runtime_unavailable", 503);
    const runId = randomUUID();
    const userMessageId = input.source.kind === "send"
      ? randomUUID()
      : input.source.source.userMessage.id;
    const assistantMessageId = randomUUID();
    const workspaceAdmission = await deps.workspace.prepare({
      assistantMessageId,
      chatId: chat.id,
      enabled: true,
      modelSupportsTools: modelCapabilities.toolCalling === true &&
        toolBridge?.supportsToolCalling({
          modelId: executionModelId,
          provider: executionProvider
        }) === true,
      runId,
      ...(input.signal ? { signal: input.signal } : {}),
      userMessageId
    });
    if (!workspaceAdmission.ok) {
      return failure(workspaceAdmission.code, workspaceAdmission.status);
    }
    workspaceAdmissionPlan = workspaceAdmission.plan;
    workspaceTools = workspaceAdmission.tools;
    prompt = promptWithWorkspaceContract(prompt, workspaceAdmission.plan, attachments);
  }

  const baseNormalizedRequest: NormalizedRunRequest = {
    attachmentIds,
    chatId: chat.id,
    content,
    context: { messages: contextMessages, mode: "branch_path" },
    ...(knowledgeRequested ? { knowledgeEvidencePackingVersion: 2 as const } : {}),
    knowledgePlan: decodedKnowledgePlan.plan,
    modelCapabilities,
    modelId: executionModelId,
    ...(mcpDiscoveryEnabled && mcpCatalog
      ? {
          mcpDiscovery: {
            catalog: mcpCatalog,
            epochs: [],
            version: 2 as const
          }
        }
      : {}),
    ...(mcpPlan?.ok && mcpPlan.snapshot.servers.length
      ? { mcp: mcpPlan.snapshot }
      : {}),
    ...(skillRuns.length > 0
      ? {
          skills: skillRuns.map((skill) => ({
            name: skill.name,
            revisionId: skill.revisionId,
            skillId: skill.skillId
          }))
        }
      : {}),
    params: runParams,
    prompt,
    provider: executionProvider,
    reasoningEffort: acceptedReasoning.reasoningEffort,
    searchPlan: {
      mode: requestedSearchPlan.mode,
      options: admissionPlan.searches.map((candidate) => ({
        adapterKind: candidate.configuration.adapterKind,
        config: candidate.configuration.config,
        credentialMode: candidate.configuration.credentialMode,
        displayName: candidate.configuration.displayName,
        executionModes: candidate.configuration.executionModes,
        modelId: candidate.configuration.modelId,
        optionId: candidate.optionId,
        protocol: candidate.configuration.protocol,
        provider: candidate.configuration.provider,
        providerModelId: candidate.configuration.providerModelId,
        revisionId: candidate.revisionId,
        searchStrategyRowId: candidate.integrationId
      }))
    },
    toolBudgets: {
      mcpAutoDiscoveryTimeoutSeconds: toolBudgets.mcpAutoDiscoveryTimeoutSeconds,
      maxMcpToolsPerDiscovery: toolBudgets.maxMcpToolsPerDiscovery,
      maxToolCalls: workspaceEnabled
        ? Math.max(
            toolBudgets.maxToolCalls,
            workspaceAdmissionPlan?.normalized.maxToolCalls ?? toolBudgets.maxToolCalls
          )
        : toolBudgets.maxToolCalls,
      maxToolRounds: workspaceEnabled
        ? Math.max(
            toolBudgets.maxToolRounds,
            workspaceAdmissionPlan?.normalized.maxToolRounds ?? toolBudgets.maxToolRounds
          )
        : toolBudgets.maxToolRounds
    },
    toolMode: workspaceEnabled || knowledgeRequested || body?.tools !== "none" ? "auto" : "none",
    ...(workspaceAdmissionPlan ? { workspace: workspaceAdmissionPlan.normalized } : {})
  };
  const plannedSearchTools = createSearchPlanToolRouter({
    plan: baseNormalizedRequest.searchPlan,
    runtimes: {}
  })?.tools ?? [];
  const nonKnowledgeClientTools = baseNormalizedRequest.toolMode === "none"
    ? []
    : [
        ...plannedSearchTools,
        ...(mcpDiscoveryEnabled ? [mcpFindToolsTool] : []),
        ...mcpRunTools(baseNormalizedRequest.mcp),
        ...workspaceTools
      ];

  let answeringPlan: KnowledgeAnsweringPlan | undefined;
  if (knowledgeAdmissionPlan) {
    // Knowledge context injection is independent from Search and MCP tool
    // availability. Those tools remain callable without forcing a small,
    // otherwise admissible Knowledge corpus through iterative retrieval.
    const fullContextEligible = knowledgeAdmissionMayFitFullContext(
      knowledgeAdmissionPlan,
      modelCapabilities.contextWindow
    );
    const passages = !chatPdfAdmissions.some(({ route }) => route !== "direct_pdf") &&
      fullContextEligible && deps.repository.loadKnowledgeFullContextPassages &&
      knowledgeAdmissionPlan.sources
      ? await deps.repository.loadKnowledgeFullContextPassages(knowledgeAdmissionPlan.sources)
      : null;
    answeringPlan = planKnowledgeAnswering({
      admissionPlan: knowledgeAdmissionPlan,
      passages,
      request: {
        ...baseNormalizedRequest,
        attachments,
        ...(nonKnowledgeClientTools.length > 0 ? { tools: nonKnowledgeClientTools } : {})
      }
    });
  }

  const budgetAnsweringRequest = (plan: KnowledgeAnsweringPlan | undefined) => {
    const fullContext = plan?.route === KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT;
    const requiresInitialKnowledgeCall = Boolean(
      plan && !fullContext && knowledgeRequested
    );
    const clientTools = baseNormalizedRequest.toolMode === "none"
      ? []
      : [
          ...(!fullContext && knowledgeRequested ? [knowledgeRetrievalTool] : []),
          ...nonKnowledgeClientTools
        ];
    const normalized: NormalizedRunRequest = {
      ...baseNormalizedRequest,
      ...(plan ? { knowledgeAnswering: knowledgeAnsweringRequestSnapshot(plan) } : {})
    };
    const unbudgeted: ProviderRunRequest = {
      ...normalized,
      attachments,
      ...(requiresInitialKnowledgeCall ? { toolChoice: "required" as const } : {}),
      ...(clientTools.length > 0 ? { tools: clientTools } : {})
    };
    const withEvidence = fullContext
      ? withAutomaticKnowledgeEvidence(
          unbudgeted,
          knowledgeEvidenceMessageFromDispatchDraft(plan.dispatchDraft)
        )
      : unbudgeted;
    const budget = applyProviderRequestContextBudget({
      ...(toolBridge ? { bridge: toolBridge } : {}),
      request: withEvidence
    });
    const retainedEvidence = fullContext && budget.ok
      ? budget.request.context?.messages.find((message) =>
          message.purpose === "knowledge_evidence")
      : null;
    const exactEvidenceRetained = !fullContext || Boolean(
      retainedEvidence &&
      textFromContentBlocks(retainedEvidence.content) === plan.dispatchDraft.message
    );
    const normalizedWithEvidence: NormalizedRunRequest = {
      ...normalized,
      ...(withEvidence.context ? { context: withEvidence.context } : {}),
      prompt: withEvidence.prompt
    };
    return { budget, exactEvidenceRetained, normalized: normalizedWithEvidence };
  };

  let budgetedAnswer = budgetAnsweringRequest(answeringPlan);
  if (answeringPlan?.route === KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT &&
    (!budgetedAnswer.budget.ok || !budgetedAnswer.exactEvidenceRetained)) {
    answeringPlan = planKnowledgeAnswering({
      admissionPlan: knowledgeAdmissionPlan!,
      passages: null,
      request: { ...baseNormalizedRequest, attachments }
    });
    budgetedAnswer = budgetAnsweringRequest(answeringPlan);
  }
  if (!budgetedAnswer.budget.ok) {
    return failure(
      budgetedAnswer.budget.error.code,
      budgetedAnswer.budget.status,
      budgetedAnswer.budget.error.message
    );
  }
  if (!budgetedAnswer.exactEvidenceRetained) {
    return failure("context_too_large", 400, "The exact Knowledge evidence did not fit.");
  }
  if (answeringPlan?.route !== KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT) {
    const knowledgeCompatibility = validateKnowledgeCapabilities({
      ...(toolBridge ? { bridge: toolBridge } : {}),
      capabilities: modelCapabilities,
      enabled: knowledgeRequested,
      modelId: executionModelId,
      provider: executionProvider
    });
    if (knowledgeCompatibility) {
      return failure(knowledgeCompatibility.code, knowledgeCompatibility.status);
    }
  }
  if (knowledgeAdmissionPlan && answeringPlan) {
    knowledgeAdmissionPlan = Object.freeze({ ...knowledgeAdmissionPlan, answeringPlan });
  }
  const providerBudget = budgetedAnswer.budget;
  const normalizedRequest: NormalizedRunRequest = {
    ...budgetedAnswer.normalized,
    context: providerBudget.request.context!
  };
  const providerRequest: ProviderRunRequest = providerBudget.request;
  const providerRequestPreview = adapter.buildRequestPreview(providerRequest);
  // Assistant-derived values never overwrite the user's ordinary manual
  // defaults, so an Assistant run persists no accepted-defaults update.
  const defaults: PreparedRunDefaultsData | null = assistantRun || project
    ? null
    : {
        controlDefaults: runControlDefaultsFromBody(body, parameterControls),
        modelId: selectedModelId,
        provider: selectedProvider,
        searchPlan: acceptedSearchPlan,
        ...(requestedSearchPreference
          ? { searchPreferencePlan: requestedSearchPreference.plan }
          : {}),
        userId: input.userId
      };

  const prepared = immutablePreparedData<MaterializedPreparedRunData>({
    ...(chatPdfAdmissions.length ? { chatPdfAdmissions } : {}),
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
    ...(resolvedChatMode.initialChatMode
      ? { initialChatMode: resolvedChatMode.initialChatMode }
      : {}),
    ...(knowledgeAdmissionPlan ? { knowledgeAdmissionPlan } : {}),
    ...(mcpPlan?.ok ? { mcpBindings: [...mcpPlan.bindings] } : {}),
    ...(skillRuns.length > 0
      ? {
          skillBindings: skillRuns.map((skill) => ({
            revisionId: skill.revisionId,
            skillId: skill.skillId
          }))
        }
      : {}),
    ...(workspaceAdmissionPlan ? { workspaceAdmissionPlan } : {}),
    normalizedRequest,
    providerAdmissionPlan: admissionPlan,
    providerRequest,
    providerRequestPreview,
    sourceKind: input.source.kind,
    ...(project ? { project } : {})
  });

  return Object.freeze({
    adapter,
    ok: true,
    prepared,
    toolBridge
  });
}
