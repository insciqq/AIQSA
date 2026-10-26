import { checkpointOutputsTool, WORKSPACE_CHECKPOINT_GUIDANCE } from "../tools/checkpointOutputs";
import { analyzeImageTools, visionAnalysisGuidance } from "../tools/analyzeImage";
import { viewWorkspaceImageTool } from "../tools/viewWorkspaceImage";
import { supportsWorkspaceImageView } from "../workspace/directImageView";
import { IMAGE_EDITING_GUIDANCE, imageGenerationTool, imageGenerationUnavailableGuidance, imageReferenceInstructions } from "../tools/imageGeneration";
import { artifactFileInstructions, artifactTool, describeArtifactTool, readArtifactTool } from "../tools/artifact";
import { getArtifactResourcePolicy } from "../artifacts/resourcePolicy";
import { decodeArtifactEdit } from "../../contracts/artifacts";
import { admitModelGenerationBudget } from "../providers/modelOutputAllowance";
import { isChatPdfPolicyUnavailableError, type ChatPdfAttachmentAdmission, type ChatPdfRouteAdmission } from "../uploads/chatPdfAdmission";
import type { ProviderAdmissionRole } from "../providerRuntime/admission";
import { randomUUID } from "node:crypto";
import { workspaceFileContext, workspaceFileReferences } from "../workspace/fileContext";
import { workspacePromptContract, WORKSPACE_GUIDANCE_VERSION } from "../workspace/promptContract";
import { textMessageContent } from "../../domain/content";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { decodeMcpRunSelection, MCP_RUN_PLAN_LIMITS } from "../../contracts/mcp";
import { mcpPersonalCredentialRejectedMessage } from "../../contracts/runs";
import { decodeSkillIds, resolveEffectiveSkillIds, SKILL_MAX_PINNED, SKILL_MAX_AVAILABLE, type SkillBudgetFacts, type SkillValidationError } from "../../contracts/skills";
import { resolveAssistantChatBaseline, resolveStandardChatBaseline, VISIBLE_ANSWER_CONTRACT } from "../../domain/promptTemplates";
import { renderAssistantInstructions, renderInstructionPreset } from "../../domain/instructionTemplates";
import { materializeAssistantRowControls, assistantRunRowProvenance } from "../assistants/rowResolution";
import type {
  AssistantRunMaterialization,
  AssistantRunResolver
} from "../assistants/runMaterialization";
import {
  parameterControlsForModel,
  type CatalogAdapterKind
} from "../../domain/catalog";
import {
  admitChatAssistant,
  assistantRowFailure,
  chatAssistantSource,
  chatAssistantWithPatch,
  searchPlanFromRow,
  type ChatAssistantAdmission
} from "./assistantRunAdmission";
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
import { memorySearchTool, type MemorySearchSnapshot } from "../memory/search/contract";
import { hasExplicitMemoryCommandBoundary } from "../memory/actions/actionAdmission";
import { logEvent } from "../observability";
import type {
  ConversationFileReference,
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
  mcpPersonalCredentialRejections,
  type McpCapabilityCatalog,
  type McpCatalogOmission,
  type McpRunPlanBinding,
  type McpRunPlanResult
} from "../mcp/runPlan";
import { mcpToolIndexGuidance, mcpFindToolsTool } from "../mcp/discovery";
import { sessionStatusTool } from "../tools/sessionStatus";
import { monitoringCheckInstruction, monitoringVerdictTool } from "../tools/monitoringVerdict";
import { isScheduledTaskToolSettings, scheduledTaskToolsForRequest } from "../tools/scheduledTaskCreation";
import { skillSaveToolsForRequest } from "../tools/skillSave";
import { mcpApprovalAdmission } from "../mcp/writeApproval";
import { admitScheduledTaskManagement, scheduledTaskManagementToolsForRequest } from "../tools/scheduledTaskManagement";
import {
  FETCH_URL_LIMITS,
  fetchUrlAuthoringMessages,
  fetchUrlToolsForRequest,
  taskInstructionFetchUrlDigests,
  userAuthoredFetchUrlDigests,
  type FetchUrlPlan
} from "../tools/fetchUrlPlan";
import { isFetchUrlDigest } from "../webFetch/urls";
import { databaseFailureCode } from "../observability/databaseFailure";
import { readToolResultTool } from "../tools/readToolResult";
import { mcpRunTools } from "../mcp/toolExecutor";
import type { ProviderToolBridge } from "../tools/types";
import type {
  SkillRunMaterialization,
  SkillRunCatalogEntry,
  SkillRunResolver
} from "../skills/runMaterialization";
import { withSelectedSkillContext } from "../skills/userContext";
import { freezeSkillManifest } from "../skills/runManifest";
import { skillCatalogAuthorization, usesPersonalSkillCatalog } from "../skills/catalogRelevanceAuthority";
import { SkillCatalogAuthorityChangedError, type SkillCatalogRelevanceService } from "../skills/catalogRelevanceService";
import { scheduledUnavailableSources, scheduledUnavailableSourcesNotice } from "../scheduledTasks/sourceHealth";
import { skillWorkspacePath } from "../../domain/skillBundlePaths";
import { skillToolsForRequest } from "../tools/skill";
import { AGENT_MODE_REMOVED, isRetiredAgentRequest } from "./retiredAgent";
import { ANSWER_REVIEW_REMOVED, requestsAnswerReview } from "./retiredAnswerReview";
import { createSearchPlanToolRouter } from "../search/toolExecutor";
import { applyProviderRequestContextBudget } from "./requestContextBudget";
import {
  followupAdmissionBudgetTokens, followupTokenCost, requestWithRunFollowups, type RunFollowupAdmission, type RegenerationFollowups
} from "./runFollowups";
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
  AcceptedAssistantRun,
  AcceptedChatAssistant,
  AcceptedRunDefaults,
  AcceptedSkillRun,
  RunModelConfiguration,
  RunRepository,
  ScheduledOccurrenceAdmission,
  ScheduledUnavailableSource
} from "./runRepositoryContract";
import {
  DEFAULT_TOOL_RUN_BUDGETS,
  normalizeToolObservationPolicy,
  toolRunBudgetsForRequest,
  workspaceToolLimit,
  type ToolRunBudgets
} from "./toolBudgets";
import type {
  WorkspaceAdmissionService,
  WorkspaceRunAdmissionPlan
} from "../workspace/admission";

const currentSendMessageId = "current-user-message";
const pdfTextUnavailableMessage =
  "No extractable text was found. Choose a model with native PDF support or remove this file.";
const zeroEmittedPdfTextUnavailableMessage =
  "No PDF text could be retained within the configured limit. Choose a model with native PDF support or remove this file.";

/** The parameter dialect params are materialized and validated in for a model. */
export function parameterDialect(adapterKind: CatalogAdapterKind, providerFamily: string): string {
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
  | "loadWorkspaceFileFacts"
  | "loadConversationContextForExpectedLeaf"
  | "loadConversationContextForLeaf"
> & Partial<Pick<
  RunRepository,
  /** Present where a run can create a scheduled task: admission offers the tool only then. */
  | "createScheduledTaskForCall"
  /** Present where a run can save a Workspace folder as a Skill: admission offers `save_skill` only then. */
  | "saveSkillForCall"
  /** Without it a step's link authority excludes only its own server-written turn. */
  | "loadSystemTurnMessageIds"
  /** Present where a run can manage scheduled tasks: admission offers that tool only then. */
  | "loadScheduledTaskManagement"
  | "manageScheduledTaskForCall"
  | "loadAssistantRowContext"
  /** Without it only the current message's links are authorized for `fetch_url`. */
  | "loadScheduledPromptMessageIds"
  /** Without it an interactive run freezes no "Always allow" consent: every write is asked. */
  | "loadMcpToolConsentServerIds"
>>;

/**
 * The earlier turns a scheduled run's model sees: only the task's previous
 * shown result (its user message and final answer) while both still lie, in
 * order, on the path the run appends to; otherwise, after a monthly rotation,
 * the frozen copy carried from the previous chat (the task's prompt, the same
 * for its generation, and the copied answer, under synthetic ids that name no
 * message); otherwise none, as for a first run. Turns the user wrote between
 * runs, follow-ups and older results stay out, so the context is flat however
 * long the task's chat grows.
 */
export function scheduledRunContext(
  path: readonly ProviderConversationMessage[],
  occurrence: Pick<ScheduledOccurrenceAdmission, "previousResult" | "previousResultCopy" | "taskChatEpoch" | "taskId">,
  prompt: ProviderConversationMessage["content"]
): Readonly<{ messages: ProviderConversationMessage[]; source: "carried" | "none" | "path" }> {
  const previousResult = occurrence.previousResult;
  const selected = previousResult ? path.filter((message) =>
    message.id === previousResult.userMessageId || message.id === previousResult.assistantMessageId) : [];
  if (previousResult && selected.length === 2 && selected[0]!.id === previousResult.userMessageId &&
    selected[0]!.role === "user" && selected[1]!.role === "assistant") return { messages: selected, source: "path" };
  const copy = occurrence.previousResultCopy;
  if (!copy) return { messages: [], source: "none" };
  const key = `scheduled-carryover:${occurrence.taskId}:${occurrence.taskChatEpoch ?? 0}`;
  return {
    messages: [
      { content: prompt, id: `${key}:prompt`, role: "user" },
      { content: textMessageContent(copy.answer), id: `${key}:answer`, role: "assistant" }
    ],
    source: "carried"
  };
}

export type RunPreparationDeps = Readonly<{
  memorySearchAdmission?: Readonly<{ admit(userId: string, assistantId?: string | null): Promise<MemorySearchSnapshot | null> }>;
  artifacts?: import("../artifacts/service").ArtifactService;
  vision?: Pick<import("../vision/service").VisionAnalysisService, "resolve">;
  images?: Pick<import("../images/service").ImageGenerationService, "resolveFor">;
  allowFakeProvider?: boolean;
  assistants?: AssistantRunResolver;
  instructions?: Pick<import("../instructions/store").InstructionPresetStore, "resolveForRun">;
  getAttachmentLimits?: () => RunAttachmentLimits;
  mcp?: Readonly<{
    filterTools: import("../mcp/toolAccess").McpToolAccessFilter;
    catalog?(userId: string): Promise<McpCapabilityCatalog>;
    /** The Auto catalog and the personal servers it left out, from one read; scheduled runs use it. */
    catalogWithOmissions?(userId: string): Promise<Readonly<{
      catalog: McpCapabilityCatalog;
      omitted: readonly McpCatalogOmission[];
    }>>;
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
  }>;
  providers: Readonly<Record<string, ProviderAdapter>>;
  providerAdmission?: Readonly<{
    load(input: {
      providerConnectionId: string;
      providerModelId: string;
      requiresClientToolCoexistence?: boolean;
      requiresClientSearchRoutes?: boolean;
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
  skillCatalogRelevance?: SkillCatalogRelevanceService;
  storage?: Pick<StorageAdapter, "getObject">;
  workspace?: WorkspaceAdmissionService;
}>;

export type SendRunPreparationSource = Readonly<{
  chat: Readonly<{
    activeLeafMessageId: string | null;
    assistantId?: string | null;
    assistantOverrides?: unknown;
    defaultModelId: string;
    defaultProvider: string;
    id: string;
    memoryMode?: "NORMAL" | "EXCLUDED" | "TEMPORARY";
    messageCount?: number;
    projectMemory: string | null;
    workspaceEnabled?: boolean;
  }>;
  draftPersonalChat?: boolean;
  kind: "send";
  /** Server-only: the scheduled task occurrence this send admits. */
  scheduledOccurrence?: ScheduledOccurrenceAdmission;
}>;

export type RegenerateRunPreparationSource = Readonly<{
  kind: "regenerate";
  source: Readonly<{
    followups?: RegenerationFollowups;
    artifactEdit?: unknown;
    artifactIntent?: unknown;
    assistantMessage: Readonly<{
      modelId: string | null;
      provider: string | null;
    }> | null;
    chat: Readonly<{
      assistantId?: string | null;
      assistantOverrides?: unknown;
      defaultModelId: string;
      defaultProvider: string;
      id: string;
      memoryMode?: "NORMAL" | "EXCLUDED" | "TEMPORARY";
      projectMemory: string | null;
      workspaceEnabled?: boolean;
    }>;
    userMessage: Readonly<{
      content: unknown;
      id: string;
      /** Server-only: the stored message is a scheduled task's prompt, in its chat or a branch copy. */
      scheduledTaskPrompt: boolean;
      /** Server-only: the prompt's task still exists with Memory on (never for a branch copy). */
      scheduledTaskMemory?: true;
    }>;
  }>;
}>;

export type RunPreparationInput = Readonly<{
  body: Readonly<Record<string, unknown>> | null;
  skillCatalogDecision?: Readonly<{ operationKey: string; authorizeScope(): Promise<void> }>;
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
  followupAdmission?: RunFollowupAdmission;
  /** Kept beside `normalizedRequest`; `rows` is absent in snapshots frozen before rows existed. */
  assistant?: AcceptedAssistantRun;
  /** Assistant runs: the chat binding to recheck and the override change to store at admission. */
  chatAssistant?: AcceptedChatAssistant;
  chatPdfAdmissions?: ChatPdfAttachmentAdmission[];
  contextTruncation: ContextTruncationSummary | null;
  defaults: PreparedRunDefaultsData | null;
  expectedActiveLeafId: string | null;
  initialChatMode?: MemoryInitialChatMode;
  mcpBindings?: McpRunPlanBinding[];
  /** A scheduled send: the relevant personal sources its Auto catalog could not offer. */
  scheduledUnavailableSources?: ScheduledUnavailableSource[];
  skillBindings?: AcceptedSkillRun[];
  workspaceAdmissionPlan?: WorkspaceRunAdmissionPlan;
  normalizedRequest: NormalizedRunRequest;
  providerAdmissionPlan: ProviderAdmissionPlan;
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
  skillBudget?: SkillBudgetFacts;
  skillValidation?: SkillValidationError;
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
    ...(prepared.followupAdmission ? { followupAdmission: mutablePreparedData<RunFollowupAdmission>(prepared.followupAdmission) } : {}),
    ...(prepared.chatPdfAdmissions
      ? { chatPdfAdmissions: mutablePreparedData<ChatPdfAttachmentAdmission[]>(prepared.chatPdfAdmissions) }
      : {}),
    ...(prepared.assistant
      ? { assistant: mutablePreparedData<NonNullable<MaterializedPreparedRunData["assistant"]>>(prepared.assistant) }
      : {}),
    ...(prepared.chatAssistant
      ? { chatAssistant: mutablePreparedData<AcceptedChatAssistant>(prepared.chatAssistant) }
      : {}),
    contextTruncation: mutablePreparedData<ContextTruncationSummary | null>(prepared.contextTruncation),
    defaults: mutablePreparedData<PreparedRunDefaultsData | null>(prepared.defaults),
    expectedActiveLeafId: prepared.expectedActiveLeafId,
    ...(prepared.initialChatMode
      ? { initialChatMode: mutablePreparedData<MemoryInitialChatMode>(prepared.initialChatMode) }
      : {}),
    ...(prepared.mcpBindings
      ? { mcpBindings: mutablePreparedData<McpRunPlanBinding[]>(prepared.mcpBindings) }
      : {}),
    ...(prepared.scheduledUnavailableSources
      ? { scheduledUnavailableSources: mutablePreparedData<ScheduledUnavailableSource[]>(prepared.scheduledUnavailableSources) }
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

/** Explicit document retry retains the accepted reader/answer authority and tool
 * limits, but a sibling needs its own current Workspace admission and derived request. */
export async function preparePdfRetry(
  deps: Pick<RunPreparationDeps, "workspace">,
  input: Readonly<{
    adapter: ProviderAdapter;
    prepared: PreparedRun;
    signal?: AbortSignal;
    toolBridge?: ProviderToolBridge;
    userId: string;
    userMessageId: string;
  }>
): Promise<RunPreparationResult> {
  const prepared = materializePreparedRunData(input.prepared);
  // A retired Codex Agent turn has no engine left to run it again.
  if (isRetiredAgentRequest(prepared.normalizedRequest)) return failure(AGENT_MODE_REMOVED, 409);
  prepared.sourceKind = "regenerate";
  prepared.defaults = null;
  prepared.expectedActiveLeafId = null;
  delete prepared.initialChatMode;
  const prior = prepared.workspaceAdmissionPlan;
  if (Boolean(prior) !== Boolean(prepared.normalizedRequest.workspace?.enabled) ||
    prior && (prior.userMessageId !== input.userMessageId || prior.chatId !== prepared.normalizedRequest.chatId)) {
    return failure("pdf_preparation_unavailable", 409);
  }
  if (prior) {
    if (!deps.workspace) return failure("workspace_runtime_unavailable", 503);
    const request = prepared.normalizedRequest;
    const admission = await deps.workspace.prepare({
      assistantMessageId: randomUUID(), chatId: request.chatId, enabled: true,
      modelSupportsTools: request.modelCapabilities.toolCalling === true &&
        input.toolBridge?.supportsToolCalling({ modelId: request.modelId, provider: request.provider }) === true,
      runId: randomUUID(), ...(input.signal ? { signal: input.signal } : {}), userMessageId: input.userMessageId
    });
    if (!admission.ok) return failure(admission.code, admission.status);
    // Only the current contract version can be rebuilt; the sibling keeps it.
    if (prior.normalized.guidanceVersion !== WORKSPACE_GUIDANCE_VERSION) return failure("pdf_preparation_unavailable", 409);
    const plan = { ...admission.plan, normalized: { ...admission.plan.normalized, guidanceVersion: WORKSPACE_GUIDANCE_VERSION } };
    // Changing admission values (tool names, per-run paths, network) render
    // only in the stable part and the leading turn lines. Chat facts (file
    // references, exports, Search) follow them and stay frozen, so neutral
    // facts render exactly the replaced parts.
    const segments = (workspace: WorkspaceRunAdmissionPlan) => {
      const contract = workspacePromptContract({ workspace,
        currentAttachmentCount: request.attachmentIds.length, hasIndexedFiles: false,
        hasEarlierExports: false, searchEnabled: false, fileContext: "" });
      return [contract.stable, contract.turn] as const;
    };
    const newSegments = segments(plan);
    let system = request.prompt.system ?? "";
    // Replace only the server-owned segments; the accepted user/Assistant
    // instructions, file references and unrelated tool authority stay frozen.
    for (const [index, oldSegment] of segments(prior).entries()) {
      const at = system.indexOf(oldSegment);
      if (at < 0 || at !== system.lastIndexOf(oldSegment)) return failure("pdf_preparation_unavailable", 409);
      system = system.slice(0, at) + newSegments[index] + system.slice(at + oldSegment.length);
    }
    // The retry keeps the run's accepted tool limits, on or off, never the installation's current ones; only the
    // Workspace allowance comes from this admission, and it raises only a limit that is on.
    const accepted = toolRunBudgetsForRequest(request);
    const toolBudgets = { ...request.toolBudgets,
      maxToolCalls: workspaceToolLimit(accepted.maxToolCalls, plan.normalized.maxToolCalls),
      maxToolRounds: workspaceToolLimit(accepted.maxToolRounds, plan.normalized.maxToolRounds) };
    const prompt = { ...request.prompt, system };
    prepared.workspaceAdmissionPlan = plan;
    prepared.normalizedRequest = { ...request, prompt, toolBudgets, workspace: plan.normalized };
    const priorWorkspaceToolNames = new Set(prior.toolDefinitions.map(tool => tool.namespacedName));
    const providerRequest: ProviderRunRequest = { ...prepared.providerRequest, ...prepared.normalizedRequest,
      tools: [...(prepared.providerRequest.tools ?? []).filter(tool => !priorWorkspaceToolNames.has(tool.name)), ...admission.tools] };
    const budget = applyProviderRequestContextBudget({ request: providerRequest,
      ...(input.toolBridge ? { bridge: input.toolBridge } : {}) });
    if (!budget.ok) return { ...failure(budget.error.code, budget.status, budget.error.message),
      ...(budget.error.skillBudget ? { skillBudget: budget.error.skillBudget } : {}) };
    prepared.contextTruncation = budget.contextTruncation;
    prepared.normalizedRequest = { ...prepared.normalizedRequest, context: budget.request.context! };
    prepared.providerRequest = budget.request;
    prepared.providerRequestPreview = input.adapter.buildRequestPreview(budget.request);
  }
  return Object.freeze({ ok: true, adapter: input.adapter, toolBridge: input.toolBridge,
    prepared: immutablePreparedData(prepared) });
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

function clamp(value: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
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
function standardChatPrompt(body: Readonly<Record<string, unknown>> | null, now: Date): NormalizedRunRequest["prompt"] {
  const baseline = resolveStandardChatBaseline({ timeZone: body?.timeZone, now });

  return {
    baseline: {
      source: "standard_chat",
      timeZone: baseline.timeZone,
      timeZoneSource: baseline.timeZoneSource
    },
    developer: VISIBLE_ANSWER_CONTRACT,
    system: baseline.renderedSystemPrompt
  };
}

/**
 * Assistant runs receive the code-owned date and time sentence without the
 * generic persona, followed by the Assistant's own instructions, rendered once
 * at admission from the same clock and validated zone as the ordinary baseline;
 * recovery reuses the accepted text. The author's answer rules replace the
 * visible-answer contract, and the reminder is rendered with the same values.
 * Null means a rendered text exceeds its limit.
 */
function assistantPrompt(
  assistant: AssistantRunMaterialization,
  body: Readonly<Record<string, unknown>> | null,
  now: Date
): NormalizedRunRequest["prompt"] | null {
  const baseline = resolveAssistantChatBaseline({ timeZone: body?.timeZone, now });
  const rendered = renderAssistantInstructions(assistant, { now, timeZone: baseline.timeZone });
  if (!rendered) return null;

  return {
    baseline: {
      source: "assistant_chat",
      timeZone: baseline.timeZone,
      timeZoneSource: baseline.timeZoneSource
    },
    developer: rendered.answerRules ?? VISIBLE_ANSWER_CONTRACT,
    responseReminder: rendered.responseReminder,
    system: [baseline.renderedSystemPrompt, rendered.systemPrompt]
      .filter((part) => part.trim()).join("\n\n")
  };
}

/**
 * Knowledge was removed (operator decision 2026-10-23): a run never carries
 * it. A browser bundle from before the removal still sends an explicit
 * "none", which is accepted; any other selection is refused visibly.
 */
function legacyKnowledgePlanRefused(body: Readonly<Record<string, unknown>> | null): boolean {
  if (!body || !Object.hasOwn(body, "knowledgePlan")) return false;
  const plan = body.knowledgePlan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return true;
  const fields = plan as Record<string, unknown>;
  return Object.keys(fields).sort().join(",") !== "baseIds,mode,sourceIds,version" || fields.version !== 1 ||
    fields.mode !== "none" || !Array.isArray(fields.baseIds) || fields.baseIds.length > 0 ||
    !Array.isArray(fields.sourceIds) || fields.sourceIds.length > 0;
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
  workspaceEnabled = false,
  imageEditing = false,
  systemVision = false
): { code: string; status: 400 } | null {
  const hasPdf = attachments.some((attachment) => attachment.kind === "pdf");
  const hasImage = attachments.some((attachment) => attachment.kind === "image");

  if (!workspaceEnabled && attachments.some((attachment) => attachment.kind === "file")) {
    return { code: "unsupported_attachment_type", status: 400 };
  }

  if (hasPdf && !workspaceEnabled && !capabilities.pdf && !capabilities.nativePdfInput) {
    return { code: "pdf_attachment_not_supported", status: 400 };
  }

  if (hasImage && !workspaceEnabled && !capabilities.vision && !imageEditing && !systemVision) {
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

/** Prepares a run. */
export async function prepareRun(
  deps: RunPreparationDeps,
  input: RunPreparationInput
): Promise<RunPreparationResult> {
  const body = input.body;
  const artifactIntentValue = body && Object.hasOwn(body, "artifactIntent") ? body.artifactIntent
    : input.source.kind === "regenerate" ? input.source.source.artifactIntent : undefined;
  if (artifactIntentValue !== undefined && artifactIntentValue !== "create") return failure("artifact_intent_invalid", 400);
  const artifactIntent = artifactIntentValue as "create" | undefined;
  const artifactEditValue = body && Object.hasOwn(body, "artifactEdit")
    ? body.artifactEdit
    : input.source.kind === "regenerate" ? input.source.source.artifactEdit : undefined;
  const artifactEdit = artifactEditValue === undefined ? undefined : decodeArtifactEdit(artifactEditValue);
  if (artifactEdit === null) return failure("artifact_edit_invalid", 400);
  const toolBudgets = deps.runPolicy
    ? await deps.runPolicy.load()
    : DEFAULT_TOOL_RUN_BUDGETS;
  const observationPolicy = normalizeToolObservationPolicy(toolBudgets.toolObservationPolicy);
  const chat = input.source.kind === "send" ? input.source.chat : input.source.source.chat;
  // A scheduled task's send: a flat selected context, whatever the chat's mode.
  const scheduledOccurrence = input.source.kind === "send" ? input.source.scheduledOccurrence : undefined;
  // Any answer to a scheduled task's prompt, which the model may have written: the scheduled run
  // itself or a regeneration, in its chat or a branch copy. It never learns into Personal Memory
  // and never gets the scheduled task creation tool.
  const scheduledPromptAnswer = scheduledOccurrence !== undefined ||
    (input.source.kind === "regenerate" && input.source.source.userMessage.scheduledTaskPrompt === true);
  // Such an answer reads Memory only while its task has Memory on: the scheduled run by its
  // occurrence, a regeneration by the task that posted the prompt (never in a branch copy).
  const scheduledMemoryRead = scheduledOccurrence ? scheduledOccurrence.memory === true
    : input.source.kind === "regenerate" && input.source.source.userMessage.scheduledTaskMemory === true;
  // The Codex Agent mode is removed (operator decision 2026-10-23): a client
  // that still asks for it is refused visibly, never answered without it.
  if (body?.agentEnabled !== undefined && body.agentEnabled !== false) return failure(AGENT_MODE_REMOVED, 409);
  // So is Answer Review (operator decision 2026-10-25): a tab of the previous
  // release that still asks for automatic review is told to reload.
  if (requestsAnswerReview(body)) return failure(ANSWER_REVIEW_REMOVED, 409);
  const workspaceEnabled = resolveWorkspaceEnabled(body, chat.workspaceEnabled);
  if (workspaceEnabled === null) {
    return failure("workspace_intent_invalid", 400);
  }
  // A chat runs with its bound Assistant; the request may only bind an
  // unbound chat or repeat the binding.
  const assistantSource = chatAssistantSource(body, chat);
  if (!assistantSource.ok) return failure(assistantSource.code, assistantSource.status);

  let assistantRun: AssistantRunMaterialization | null = null;
  let chatAssistant: ChatAssistantAdmission | null = null;
  if (assistantSource.assistantId) {
    const admitted = await admitChatAssistant(deps, {
      body,
      source: { ...assistantSource, assistantId: assistantSource.assistantId },
      storedOverrides: chat.assistantOverrides,
      userId: input.userId
    });
    if (!admitted.ok) return failure(admitted.code, admitted.status);
    chatAssistant = admitted;
    assistantRun = admitted.assistant;
  }

  let manualSkillIds: string[] = [];
  if (body && Object.prototype.hasOwnProperty.call(body, "skillIds")) {
    const decoded = decodeSkillIds(body.skillIds);
    if (!decoded.ok) return { ...failure(decoded.code, 400), skillValidation: decoded };
    manualSkillIds = decoded.ids;
  }
  const rawSkillsMode = body?.skills;
  if (rawSkillsMode !== undefined && (!isRecord(rawSkillsMode) ||
    Object.keys(rawSkillsMode).some((key) => key !== "mode") ||
    (rawSkillsMode.mode !== "auto" && rawSkillsMode.mode !== "off"))) return failure("skills_mode_invalid", 400);
  const skillsMode = chatAssistant?.resolution.rows.skills.value.mode ??
    (isRecord(rawSkillsMode) && rawSkillsMode.mode === "off" ? "off" : "auto");
  const assistantPinnedIds = assistantRun?.skillIds.filter((id) => assistantRun.skillModes?.[id] !== "available") ?? [];
  const assistantAvailableIds = assistantRun?.skillIds.filter((id) => assistantRun.skillModes?.[id] === "available") ?? [];
  const effectiveSkillIds = resolveEffectiveSkillIds(assistantPinnedIds, manualSkillIds);
  if (effectiveSkillIds.length > SKILL_MAX_PINNED) {
    return { ...failure("skills_count_exceeded", 400), skillValidation: {
      code: "skills_count_exceeded", field: "pinned", actual: effectiveSkillIds.length, limit: SKILL_MAX_PINNED
    } };
  }
  const catalogIds = assistantRun ? assistantAvailableIds : [];
  const requiredSkillIds = resolveEffectiveSkillIds(effectiveSkillIds, catalogIds);
  let skillRuns: SkillRunMaterialization[] = [];
  let availableSkillRuns: SkillRunCatalogEntry[] = [];
  if (requiredSkillIds.length > 0) {
    if (!deps.skills) return failure("skill_not_available", 404);
    const resolution = await deps.skills.resolveForRun(input.userId, requiredSkillIds);
    if (!resolution.ok) return failure(resolution.code, resolution.status);
    skillRuns = effectiveSkillIds.map((id) => resolution.skills.find((skill) => skill.skillId === id)!);
    if (skillRuns.some((skill) => !skill)) return failure("skill_not_available", 404);
    availableSkillRuns = resolution.skills.filter((skill) => !effectiveSkillIds.includes(skill.skillId));
  }

  const resolvedChatMode = resolveRunChatMode(body, input.source);
  if ("ok" in resolvedChatMode) {
    return resolvedChatMode;
  }
  if (legacyKnowledgePlanRefused(body)) return failure("knowledge_plan_invalid", 400);

  const decodedSearchPlan = assistantRun
    ? null
    : decodeSearchPlan(body?.searchPlan);
  if (!assistantRun && body?.searchPlan === undefined) {
    return failure("search_plan_invalid", 400);
  }
  if (decodedSearchPlan && !decodedSearchPlan.ok) {
    return failure(decodedSearchPlan.code, 400);
  }
  let requestedSearchPlan = chatAssistant
    ? searchPlanFromRow(chatAssistant.resolution.rows.search.value)
    : decodedSearchPlan && decodedSearchPlan.ok
      ? decodedSearchPlan.plan
      : { mode: "all_selected" as const, optionIds: [] as string[] };
  let requestedSearchPreference: {
    plan: import("../../domain/search").SearchPlan | null;
    source: "organization" | "personal";
  } | null = null;
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
  const selectedProvider = chatAssistant
    ? chatAssistant.modelProvider
    : typeof body?.provider === "string"
      ? body.provider
      : input.source.kind === "send"
        ? chat.defaultProvider
        : input.source.source.assistantMessage?.provider ?? chat.defaultProvider;
  const selectedModelId = chatAssistant
    ? chatAssistant.resolution.rows.model.value.modelId
    : typeof body?.modelId === "string"
      ? body.modelId
      : input.source.kind === "send"
        ? chat.defaultModelId
        : input.source.source.assistantMessage?.modelId ?? chat.defaultModelId;
  const providerAdmission = deps.providerAdmission;
  if (!providerAdmission) {
    return failure("provider_not_available", 503);
  }
  let admissionPlan: ProviderAdmissionPlan;
  let executionProvider = selectedProvider;
  let executionModelId = selectedModelId;
  let modelConfiguration: RunModelConfiguration;
  try {
    admissionPlan = await providerAdmission.load({
      providerConnectionId: selectedProvider,
      providerModelId: selectedModelId,
      // Chat models always call tools, so hosted Search must coexist with them.
      requiresClientToolCoexistence: true,
      searchPlan: requestedSearchPlan,
      ...(requestedSearchPreference
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
  if (requestedSearchPreference) {
    requestedSearchPreference = {
      plan: admissionPlan.requestedSearchPreferencePlan !== undefined
        ? admissionPlan.requestedSearchPreferencePlan
        : requestedSearchPreference.plan,
      source: requestedSearchPreference.source
    };
  }

  const promptContent =
    input.source.kind === "send"
      ? normalizeContent(body ?? {})
      : contentFromStored(input.source.source.userMessage.content);
  // A webhook occurrence's event follows its prompt as its own labelled block,
  // from the server-only occurrence, never from the request.
  const content: NormalizedRunRequest["content"] = scheduledOccurrence?.webhookEvent
    ? { blocks: [...promptContent.blocks, { text: scheduledOccurrence.webhookEvent.text, type: "text" }] }
    : promptContent;
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

  // An Assistant's Tools row is its exact allowlist (Load all semantics) or
  // an ordinary chat mode over the runner's own servers.
  const assistantTools = chatAssistant && body?.tools !== "none"
    ? chatAssistant.resolution.rows.tools.value
    : null;
  const assistantMcpServerIds = assistantTools?.mode === "exact" ? assistantTools.serverIds : [];
  const assistantMcpMode = assistantTools && assistantTools.mode !== "exact" ? { mode: assistantTools.mode } : null;
  const ordinaryMcpSelection = body?.tools === "none"
    ? null
    : chatAssistant
      ? assistantMcpMode
      : body?.mcp === undefined
        ? { mode: "auto" as const }
        : decodeMcpRunSelection(body.mcp);
  if (!assistantRun && body?.tools !== "none" &&
    ordinaryMcpSelection === null) {
    return failure("mcp_selection_invalid", 400);
  }
  const assistantMcpUnavailable = Boolean(
    assistantRun && assistantMcpServerIds.length > 0 && !deps.mcp
  );
  const ordinaryLoadAllMcpUnavailable = Boolean(
    ordinaryMcpSelection?.mode === "load_all" && !deps.mcp
  );
  const mcpPlan = assistantMcpServerIds.length > 0
    ? deps.mcp
      ? await deps.mcp.prepare(input.userId, {
          allowedServerIds: assistantMcpServerIds
        })
      : null
    : ordinaryMcpSelection?.mode === "load_all" && deps.mcp
      ? await deps.mcp.prepare(input.userId)
      : null;
  // A scheduled run reads the same catalog together with the personal servers
  // it had to leave out: a relevant one makes the run incomplete, never silently.
  const mcpCatalogRead = ordinaryMcpSelection?.mode === "auto"
    ? scheduledOccurrence && deps.mcp?.catalogWithOmissions
      ? await deps.mcp.catalogWithOmissions(input.userId)
      : deps.mcp?.catalog ? { catalog: await deps.mcp.catalog(input.userId), omitted: [] } : null
    : null;
  const mcpCatalog = mcpCatalogRead?.catalog ?? null;
  const scheduledMissingSources = scheduledOccurrence && mcpCatalogRead
    ? scheduledUnavailableSources(mcpCatalogRead.omitted, scheduledOccurrence.relevantMcpServerIds)
    : [];
  const mcpDiscoveryEnabled = Boolean(mcpCatalog?.servers.length);

  const mcpToolsEnabled = mcpDiscoveryEnabled ||
    Boolean(mcpPlan?.ok && mcpPlan.snapshot.tools.length > 0);
  // Derive every runtime field once, from the plan whose exact answer binding
  // will be persisted and revalidated.
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

  const instructionTime = new Date();
  const normalizedPrompt = assistantRun
    ? assistantPrompt(assistantRun, body, instructionTime)
    : standardChatPrompt(body, instructionTime);
  if (!normalizedPrompt) {
    return failure("assistant_instructions_expansion_too_large", 400, "This Assistant's instructions exceed the text limit after date and time substitution. They must be shortened before it can answer.");
  }
  let personalInstructions: import("../instructions/store").PersonalInstructionSnapshot | undefined;
  if (!assistantRun && deps.instructions) {
    try { personalInstructions = await deps.instructions.resolveForRun(input.userId); }
    catch { return failure("instruction_presets_unavailable", 409); }
  }
  const renderedInstructions = personalInstructions
    ? renderInstructionPreset(personalInstructions, { now: instructionTime, timeZone: body?.timeZone })
    : null;
  if (personalInstructions && !renderedInstructions) {
    return failure("instruction_preset_expansion_too_large", 400, "Your instructions exceed the text limit after date and time substitution. Shorten the preset and try again.");
  }
  let prompt: NormalizedRunRequest["prompt"] = {
    ...normalizedPrompt,
    ...(renderedInstructions ? { personalInstructions: renderedInstructions.personalInstructions,
      ...(renderedInstructions.overridesAnswerRules ? { developer: null } : {}) } : {}),
    responseReminder: normalizedPrompt.responseReminder ?? renderedInstructions?.responseReminder ?? "",
    memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT
  };
  const branchContext =
    input.source.kind === "send"
      ? input.source.draftPersonalChat
        ? []
        : await deps.repository.loadConversationContextForExpectedLeaf(
            chat.id,
            input.userId,
            input.source.chat.activeLeafMessageId
          )
      : null;
  if (input.source.kind === "send" && !branchContext) {
    return failure("active_leaf_changed", 409);
  }
  // The new turn still appends to the active leaf; only the model's view is selected.
  // A carried result answered the prompt, never this run's event.
  const scheduledContext = branchContext && scheduledOccurrence
    ? scheduledRunContext(branchContext, scheduledOccurrence, promptContent)
    : null;
  const sendContext = scheduledContext ? scheduledContext.messages : branchContext;
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
  const skillToolsSupported = body?.tools !== "none" && modelCapabilities.toolCalling === true &&
    toolBridge?.supportsToolCalling({ modelId: executionModelId, provider: executionProvider }) === true;
  // A monitoring check reports its outcome through one built-in tool, frozen
  // only from the server-only occurrence of a monitoring task. A check that
  // could not call it is refused before anything is accepted.
  const monitoringCheck = scheduledOccurrence?.monitoring === true && body?.tools !== "none" &&
    modelCapabilities.toolCalling === true &&
    toolBridge?.supportsToolCalling({ modelId: executionModelId, provider: executionProvider }) === true;
  if (scheduledOccurrence?.monitoring === true && !monitoringCheck) {
    return failure("model_cannot_report", 409, "This model cannot report the outcome of a monitoring check.");
  }
  const skillCatalogSupported = skillToolsSupported;
  if (skillsMode === "auto" && skillCatalogSupported && usesPersonalSkillCatalog(assistantRun) && deps.skills?.listEnabledForRun) {
    availableSkillRuns = (await deps.skills.listEnabledForRun(input.userId)).filter((skill) => !effectiveSkillIds.includes(skill.skillId));
  }
  if (skillsMode === "auto" && skillCatalogSupported && availableSkillRuns.length > SKILL_MAX_AVAILABLE) {
    return { ...failure("skills_count_exceeded", 400), skillValidation: {
      code: "skills_count_exceeded", field: "available", actual: availableSkillRuns.length, limit: SKILL_MAX_AVAILABLE
    } };
  }
  let rankedAvailableSkillIds: readonly string[] | undefined;
  if (skillsMode === "auto" && skillCatalogSupported && deps.skills && deps.skillCatalogRelevance && input.skillCatalogDecision) {
    try {
      rankedAvailableSkillIds = await deps.skillCatalogRelevance({
        userId: input.userId, operationKey: input.skillCatalogDecision.operationKey,
        // The task, not a webhook event's data, decides which Skills are relevant.
        query: textFromContentBlocks(promptContent), candidates: availableSkillRuns, signal: input.signal,
        authorize: skillCatalogAuthorization({
          userId: input.userId,
          assistant: assistantRun, assistants: deps.assistants, skills: deps.skills,
          pinned: skillRuns, available: availableSkillRuns, authorizeScope: input.skillCatalogDecision.authorizeScope
        })
      }) ?? undefined;
    } catch (error) {
      if (error instanceof SkillCatalogAuthorityChangedError) return failure("skill_not_available", 404);
      throw error;
    }
  }
  const loadedBefore = deps.skills?.loadedBeforeForMessages && availableSkillRuns.length > 0
    ? new Set(await deps.skills.loadedBeforeForMessages(input.userId, chat.id, conversationMessages.map((message) => message.id))) : undefined;
  const frozenSkills = freezeSkillManifest({
    mode: skillsMode, pinned: skillRuns, available: availableSkillRuns, toolsSupported: skillToolsSupported,
    contextWindow: modelCapabilities.contextWindow, loadedBefore, rankedAvailableSkillIds
  });
  skillRuns = frozenSkills.pinned.map(skill => workspaceEnabled && skill.alias
    ? { ...skill, workspacePath: skillWorkspacePath(skill.alias)! } : skill);
  const contextMessages = withSelectedSkillContext(conversationMessages, skillRuns, {
    canReadFiles: Boolean(frozenSkills.manifest.tools), catalog: frozenSkills.catalog
  });
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
  let rowResolution = chatAssistant?.resolution ?? null;
  if (chatAssistant) {
    // The chat's controls over the Assistant's (when the effective model is
    // its model) over the user's saved values for the model, over built-ins.
    const materialized = materializeAssistantRowControls(chatAssistant.resolution, {
      baseParams: defaultParams,
      controls: parameterControls,
      parameterProvider
    });
    if (!materialized.ok) {
      // A request value the model does not support is refused like an
      // ordinary invalid param; an Assistant control that no longer fits
      // fails closed with a stable conflict, never clamped or dropped.
      const rejected = assistantRowFailure(materialized);
      return failure(rejected.code, rejected.status);
    }
    paramsBody = materialized.params;
    rowResolution = materialized.resolution;
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
  const runParams = mergeModelParams(parameterProvider, {
    ...canonicalizeMaxOutputTokenParams(defaultParams),
    maxOutputTokens: parameterControls.maxOutputTokens.defaultValue,
    ...(parameterControls.temperature.supported ? { temperature: parameterControls.temperature.defaultValue } : {})
  }, paramValidation.params);
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
    if (assistantMcpServerIds.length > 0) {
      // Consumers may lack visibility into a required server, so the failure
      // is privacy-neutral and never names the affected servers.
      return failure("assistant_tools_not_available", 409, "Required MCP tools are unavailable.");
    }
    if (ordinaryMcpSelection?.mode === "load_all" && mcpPlan.code === "mcp_plan_too_large" &&
      mcpPlan.limit === "maxTools") {
      return failure(
        mcpPlan.code,
        409,
        `Load all can offer at most ${MCP_RUN_PLAN_LIMITS.maxTools} MCP tools to one message. Use MCP Auto or switch some tools off.`
      );
    }
    const rejected = mcpPlan.code === "mcp_not_ready" ? mcpPersonalCredentialRejections(mcpPlan.issues) : [];
    if (rejected.length) {
      return failure(mcpPlan.code, 409, mcpPersonalCredentialRejectedMessage(rejected.length === 1 ? rejected[0] : null));
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

  // Every run (with or without any Assistant or Workspace) uses the
  // initiating user's effective image model. An unusable model is never
  // substituted: the run gets no image tool and the answer model is told why.
  // An installation without image generation stays silent.
  const imageResolution = body?.tools !== "none" && modelCapabilities.toolCalling === true &&
    toolBridge?.supportsToolCalling({ modelId: executionModelId, provider: executionProvider })
    ? await deps.images?.resolveFor({ kind: "personal", userId: input.userId }) ?? null : null;
  const imagePlan = imageResolution?.ok ? imageResolution.plan : null;
  const imageUnavailableGuidance = imageResolution && !imageResolution.ok && imageResolution.reason !== "not_configured"
    ? imageGenerationUnavailableGuidance({ reason: imageResolution.reason, source: imageResolution.source })
    : null;
  const artifactToolAvailable = resolvedChatMode.mode !== "TEMPORARY" && body?.tools !== "none" && Boolean(deps.artifacts) &&
    modelCapabilities.toolCalling === true && toolBridge?.supportsToolCalling({ modelId: executionModelId, provider: executionProvider }) === true;
  const artifactResourcePolicy = artifactToolAvailable ? getArtifactResourcePolicy() : undefined;
  const artifactToolDescription = artifactResourcePolicy ? describeArtifactTool(artifactResourcePolicy) : undefined;
  if (artifactIntent && (!artifactToolAvailable || artifactEdit)) return failure("artifact_intent_unavailable", 409, "Artifact creation is unavailable with this message configuration.");
  if (artifactEdit) {
    if (!artifactToolAvailable || !deps.artifacts) {
      return failure("artifact_edit_unavailable", 409, "This artifact is unavailable for editing in this chat.");
    }
    const target = await deps.artifacts.validateEditTarget({ ...artifactEdit, chatId: chat.id, ownerUserId: input.userId });
    if (!target.ok) {
      return target.code === "artifact_version_conflict"
        ? failure(target.code, 409, "The artifact changed. Open its current version and try the edit again.")
        : failure("artifact_edit_unavailable", 404, "This artifact is unavailable for editing in this chat.");
    }
  }
  let pdfRoute: ChatPdfRouteAdmission | undefined;
  let chatPdfAdmissions: ChatPdfAttachmentAdmission[] = [];
  let attachments: ProviderAttachment[];
  try {
    attachments = await loadProviderAttachments(deps, input.userId, attachmentIds, {
      capabilities: modelCapabilities,
      ...(deps.chatPdf ? {
        resolvePdfRoute: async () => { pdfRoute = await deps.chatPdf!.resolve(admissionPlan.answer); return pdfRoute; },
        onPdfAdmissions: (items: ChatPdfAttachmentAdmission[]) => { chatPdfAdmissions = items; }
      } : {}),
      limits: attachmentLimits,
      ...(input.signal ? { signal: input.signal } : {}),
      workspaceEnabled
    });
  } catch (error) {
    if (isChatPdfPolicyUnavailableError(error)) return failure(error.code, 409,
      "PDF processing is not configured for this model. Ask an administrator to assign and verify the selected PDF reader.");
    const rejected = attachmentFailure(error);
    if (rejected) return rejected;
    throw error;
  }

  if (attachments.length !== attachmentIds.length) {
    return failure("attachment_not_found", 400);
  }

  // The conversation path already ends with the current message; appending it
  // again would list each of its images twice.
  const currentReferenceMessageId = input.source.kind === "send" ? currentSendMessageId : input.source.source.userMessage.id;
  const referenceMessages = contextMessages.some((message) => message.id === currentReferenceMessageId)
    ? contextMessages
    : [...contextMessages, { id: currentReferenceMessageId, role: "user" as const, content }];
  const imageReferenceIds = [...new Set(referenceMessages.flatMap((message) => attachmentIdsFromContentBlocks(message.content.blocks)))].slice(-256);
  // Answer models without verified vision ask the separately assigned System
  // Vision Model about conversation images on demand (chat System Vision).
  // Workspace keeps its own form. Only an available plan is admitted in chat;
  // nothing substitutes another model.
  const chatVisionEligible = !workspaceEnabled && modelCapabilities.vision !== true &&
    body?.tools !== "none" && modelCapabilities.toolCalling === true &&
    toolBridge?.supportsToolCalling({ modelId: executionModelId, provider: executionProvider }) === true &&
    (imageReferenceIds.length > 0 || Boolean(imagePlan));
  const chatVisionResolution = chatVisionEligible ? await deps.vision?.resolve() : undefined;
  const chatVisionPlan = chatVisionResolution?.available ? chatVisionResolution : undefined;

  const attachmentAccess = validateAttachmentCapabilities(
    attachments,
    pdfRoute ? { ...modelCapabilities, pdf: true } : modelCapabilities,
    workspaceEnabled,
    imagePlan?.snapshot.model.capabilities.imageEditing === true,
    Boolean(chatVisionPlan)
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

  const imageRecords = (imagePlan || artifactToolAvailable || workspaceEnabled || chatVisionPlan) && imageReferenceIds.length
    ? await deps.repository.loadAttachments(input.userId, imageReferenceIds)
    : [];
  const imageReferences = referenceMessages.flatMap((message) => attachmentIdsFromContentBlocks(message.content.blocks).flatMap((id) => {
    const row = imageRecords.find((entry) => entry.id === id && entry.kind === "image" && entry.status === "ready");
    return row ? [{ attachmentId: id, messageId: message.id, fileName: row.fileName, origin: message.role === "assistant" ? "generated" as const : "upload" as const }] : [];
  })).slice(-256);
  // Any conversation file with stored bytes, extraction outcome aside; ready
  // images always stay referenceable. The artifact service rechecks each use.
  const listedFileIds = new Set<string>();
  const fileReferences: ConversationFileReference[] = artifactToolAvailable
    ? referenceMessages.flatMap((message) => attachmentIdsFromContentBlocks(message.content.blocks).flatMap((id) => {
      const row = imageRecords.find((entry) => entry.id === id);
      // Unusable stored metadata (over-long name or MIME) is left out, never truncated.
      if (!row || listedFileIds.has(id) || !(row.checksum?.trim() || row.kind === "image" && row.status === "ready") ||
        !row.fileName || row.fileName.length > 256 || !row.mimeType || row.mimeType.length > 255 ||
        `${row.fileName}${row.mimeType}`.includes("\u0000")) return [];
      listedFileIds.add(id);
      return [{ attachmentId: id, messageId: message.id, fileName: row.fileName, mimeType: row.mimeType, byteSize: row.byteSize,
        kind: row.kind, origin: message.role === "assistant" ? "generated" as const : "upload" as const }];
    })).slice(-256)
    : [];
  // Admitted only with something to analyze: a conversation image, or an
  // image this run may generate. A text-only chat keeps its plain tool set.
  const chatVision = chatVisionPlan && (imageReferences.length > 0 || imagePlan) ? chatVisionPlan : undefined;
  let hasWorkspaceIndexedFiles = false;
  let workspaceAdmissionPlan: WorkspaceRunAdmissionPlan | undefined;
  let workspaceTurnContract = "";
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
    workspaceAdmissionPlan = { ...workspaceAdmission.plan, normalized: { ...workspaceAdmission.plan.normalized,
      guidanceVersion: WORKSPACE_GUIDANCE_VERSION } };
    workspaceTools = workspaceAdmission.tools;
    const references = workspaceFileReferences(conversationMessages).map(reference => ({
      ...reference,
      messageId: reference.messageId === currentSendMessageId ? userMessageId : reference.messageId
    }));
    const historicalIds = references.map(reference => reference.attachmentId).filter(id => !attachmentIds.includes(id));
    const historicalFiles = historicalIds.length
      ? await deps.repository.loadAttachments(input.userId, historicalIds)
      : [];
    const fileContext = workspaceFileContext({
      references,
      attachments: [...attachments, ...historicalFiles.filter(file => Boolean(file.checksum))],
      currentMessageId: userMessageId,
      inboxIndexPath: workspaceAdmission.plan.normalized.inboxIndexPath
    });
    const facts = await deps.repository.loadWorkspaceFileFacts({ chatId: chat.id, userId: input.userId,
      leafMessageId: input.source.kind === "send" ? input.source.chat.activeLeafMessageId : input.source.source.userMessage.id,
      imageIds: imageReferences.map(reference => reference.attachmentId) });
    hasWorkspaceIndexedFiles = attachments.length > 0 || facts.hasFiles;
    const contract = workspacePromptContract({ workspace: workspaceAdmissionPlan,
      currentAttachmentCount: attachments.length, hasIndexedFiles: hasWorkspaceIndexedFiles,
      hasEarlierExports: facts.hasEarlierExports, searchEnabled: admissionPlan.searches.length > 0, fileContext });
    prompt = { ...prompt, system: [prompt.system, contract.stable].filter(part => Boolean(part?.trim())).join("\n\n") || null };
    workspaceTurnContract = contract.turn;
  }

  // What holds only for this turn (its paths, the current message's facts, the chat's images, files and
  // artifacts as they stand now) is appended like the rest and also recorded as it was appended
  // (`prompt.turnGuidance`): the native engine sends it with the run's input instead, so its system
  // prompt stays the same across the chat's turns and provider caches keep reading it.
  const turnGuidance: string[] = [];
  const appendTurnGuidance = (part: string | null | undefined) => {
    if (!part?.trim()) return;
    turnGuidance.push(part);
    prompt = { ...prompt, system: [prompt.system, part].filter(Boolean).join("\n\n") };
  };
  const workspaceCheckpoints = Boolean(workspaceAdmissionPlan && body?.tools !== "none");
  if (workspaceCheckpoints) prompt = { ...prompt, system: [prompt.system, WORKSPACE_CHECKPOINT_GUIDANCE].filter(Boolean).join("\n\n") };
  const workspaceVision = workspaceAdmissionPlan && body?.tools !== "none" && modelCapabilities.toolCalling === true
    ? await deps.vision?.resolve() : undefined;
  // A chat model with verified vision looks at Workspace images itself (operator decision 2026-10-26), frozen with the
  // run's other bindings; System Vision stays for every model.
  const workspaceImageView = Boolean(workspaceAdmissionPlan) && body?.tools !== "none" && modelCapabilities.toolCalling === true &&
    supportsWorkspaceImageView(executionAdapterKind, admissionPlan.answer.verifiedVisionInput === true);
  if (workspaceVision) appendTurnGuidance(visionAnalysisGuidance(workspaceVision, workspaceImageView, {
    nativeCurrentImages: modelCapabilities.vision && attachments.some(file => file.kind === "image" && Boolean(file.base64Data || file.dataUrl)),
    hasIndexedFiles: hasWorkspaceIndexedFiles
  }));
  const visionAnalysis = workspaceVision ?? chatVision;
  // Turn paths and chat facts follow the stable checkpoint and Vision guidance.
  appendTurnGuidance(workspaceTurnContract);
  if (imagePlan || imageReferences.length > 0) {
    prompt = { ...prompt, system: [prompt.system, IMAGE_EDITING_GUIDANCE].filter(Boolean).join("\n\n") };
  }
  if (imageUnavailableGuidance) {
    prompt = { ...prompt, system: [prompt.system, imageUnavailableGuidance].filter(Boolean).join("\n\n") };
  }
  if (imagePlan || chatVision) {
    appendTurnGuidance(imageReferenceInstructions(imageReferences, modelCapabilities.vision === true, Boolean(chatVision)));
  }
  const artifactFileGuidance = artifactToolAvailable ? artifactFileInstructions(fileReferences, workspaceCheckpoints) : null;
  appendTurnGuidance(artifactFileGuidance);
  // Auto discloses the frozen catalog's bounded tool index; the accepted prompt keeps it through recovery.
  const mcpServicesGuidance = mcpDiscoveryEnabled ? mcpToolIndexGuidance(mcpCatalog) : null;
  if (mcpServicesGuidance) prompt = { ...prompt, system: [prompt.system, mcpServicesGuidance].filter(Boolean).join("\n\n") };
  // The frozen prompt names a scheduled run's missing sources through recovery.
  appendTurnGuidance(scheduledUnavailableSourcesNotice(scheduledMissingSources));
  if (artifactIntent) appendTurnGuidance("The user explicitly asked for an artifact: call create_artifact for this message.");
  // The check's server-owned instruction, frozen with the accepted prompt: it
  // compares with the previous shown result only while the context holds it.
  if (monitoringCheck) {
    prompt = { ...prompt, system: [prompt.system, monitoringCheckInstruction({ previousResult: (sendContext?.length ?? 0) > 0 })]
      .filter(Boolean).join("\n\n") };
  }
  let artifactReferences: NormalizedRunRequest["artifactReferences"];
  let artifactFocus: NormalizedRunRequest["artifactFocus"];
  let artifactCompactPrompt: Pick<NormalizedRunRequest["prompt"], "system" | "turnGuidance"> | undefined;
  const beforeArtifactSystem = prompt.system;
  const beforeArtifactTurnGuidance = [...turnGuidance];
  // A scheduled run's context is its selection alone: the chat's other artifacts stay out of it.
  if (artifactToolAvailable && deps.artifacts && !scheduledOccurrence) {
    const artifactContext = await deps.artifacts.contextForChat({ chatId: chat.id, ownerUserId: input.userId,
      ...(artifactEdit ? { requiredArtifactId: artifactEdit.artifactId } : {}) }).catch(() => []);
    if (artifactEdit && !artifactContext.some((artifact) =>
      artifact.artifact_id === artifactEdit.artifactId && artifact.base_version_id === artifactEdit.versionId)) {
      return failure("artifact_edit_unavailable", 409, "This artifact is unavailable for editing in this chat.");
    }
    if (artifactContext.length > 0) {
      artifactReferences = artifactContext.map((artifact) => ({ artifactId: artifact.artifact_id, versionId: artifact.base_version_id }));
      artifactFocus = artifactReferences[0];
      const guidance = "Artifacts already created in this chat are private server-owned context. Use read_artifact for omitted file text, and edits with the exact base_version_id for changes; unmentioned files and assets are preserved. Never invent asset references or URLs.";
      const editGuidance = artifactEdit ? `The user's current message edits artifact_id=${JSON.stringify(artifactEdit.artifactId)} from base_version_id=${JSON.stringify(artifactEdit.versionId)}; update that artifact with intent=update unless the message clearly asks for something else.` : "";
      const compactContext = guidance + "\n" + JSON.stringify(artifactContext.map(artifact => ({ ...artifact,
        files: artifact.files.map(file => { const { text: _text, ...metadata } = file; return metadata; }) })));
      artifactCompactPrompt = { system: [beforeArtifactSystem, compactContext, editGuidance].filter(Boolean).join("\n\n"),
        turnGuidance: [...beforeArtifactTurnGuidance, compactContext, ...(editGuidance ? [editGuidance] : [])] };
      appendTurnGuidance("Artifacts already created in this chat are private server-owned context. For an edit, use intent=update and the exact base_version_id; preserve useful files unless the user asks to replace them. Never invent asset references or URLs.\n" + JSON.stringify(artifactContext));
      appendTurnGuidance(editGuidance);
    }
  }
  if (turnGuidance.length > 0) prompt = { ...prompt, turnGuidance };
  const observationCapable = modelCapabilities.toolCalling === true &&
    toolBridge?.supportsToolCalling({
      modelId: executionModelId,
      provider: executionProvider
    }) === true;
  const toolObservationVersion: 0 | 1 = observationPolicy === "v1" && observationCapable ? 1 : 0;
  const generationBudget = admitModelGenerationBudget(admissionPlan.answer.snapshot);
  // A task turn with Memory reads it like an ordinary personal turn whatever its chat's mode (an
  // excluded chat keeps it out of learning, not its own reads), and never as a `/memory` command:
  // its admission reads standing facts only, so such a prompt is answered as text.
  const memoryStandingEligible = resolvedChatMode.mode !== "TEMPORARY" && (scheduledPromptAnswer
    ? scheduledMemoryRead
    : resolvedChatMode.mode === "NORMAL" && !hasExplicitMemoryCommandBoundary(textFromContentBlocks(content)));
  const memorySearchAdmission = memoryStandingEligible && body?.tools !== "none" &&
    modelCapabilities.toolCalling === true && toolBridge?.supportsToolCalling({
      modelId: executionModelId, provider: executionProvider
    }) === true ? deps.memorySearchAdmission : undefined;
  let memorySearch: MemorySearchSnapshot | null = null;
  if (memorySearchAdmission) {
    try {
      memorySearch = await memorySearchAdmission.admit(input.userId, assistantRun?.assistantId ?? null);
    } catch (error) {
      // Nothing is frozen before acceptance: the run proceeds without the
      // optional tool, standing preparation is unchanged, and users see nothing.
      logEvent("service_operation", { error, subsystem: "memory_search", stage: "preflight",
        outcome: "degraded", action: "degrade", code: "memory_search_admission_skipped" });
    }
  }
  // The owner's own message in an ordinary personal chat may create one
  // scheduled task. Never an answer to a scheduled task's prompt, a temporary,
  // or Assistant run, nor one without tool calling.
  // Frozen here: the settings the task takes from this run, never mutable chat
  // state read later, and only in the shape recovery decodes. The task reads
  // Memory only when this run itself was admitted to read it: an eligible
  // chat, and the owner's Memory on (search admission, which every run that
  // may create a task attempts, reads exactly that).
  const scheduledTaskSettings = !scheduledPromptAnswer && !assistantRun &&
    resolvedChatMode.mode !== "TEMPORARY" && body?.tools !== "none" &&
    typeof deps.repository.createScheduledTaskForCall === "function" && modelCapabilities.toolCalling === true &&
    toolBridge?.supportsToolCalling({ modelId: executionModelId, provider: executionProvider }) === true
    ? {
        modelId: selectedModelId,
        provider: selectedProvider,
        searchEnabled: admissionPlan.searches.length > 0,
        toolsEnabled: ordinaryMcpSelection !== null && ordinaryMcpSelection.mode !== "off",
        workspaceEnabled: workspaceAdmissionPlan !== undefined,
        memoryEnabled: memoryStandingEligible && memorySearch !== null
      }
    : undefined;
  const scheduledTaskTool = isScheduledTaskToolSettings(scheduledTaskSettings) ? scheduledTaskSettings : undefined;
  // The owner's own interactive personal chat with Workspace on may save one
  // Workspace folder per answer as a personal Skill (operator exception,
  // 2026-10-07). Never an answer to a scheduled task's prompt, a temporary or
  // Assistant run: there the tool is absent, not refused late.
  const skillSaveTool = !scheduledPromptAnswer && !assistantRun &&
    resolvedChatMode.mode !== "TEMPORARY" && workspaceAdmissionPlan !== undefined &&
    typeof deps.repository.saveSkillForCall === "function" && modelCapabilities.toolCalling === true &&
      toolBridge?.supportsToolCalling({ modelId: executionModelId, provider: executionProvider }) === true;
  // One page reader for every tool-calling model. Frozen here: the links
  // user-authored text on this branch authorizes (never a scheduled prompt's),
  // or a scheduled run's task snapshot, read with the task revision the link
  // fences.
  const fetchUrlOffered = body?.tools !== "none" &&
    modelCapabilities.toolCalling === true &&
    toolBridge?.supportsToolCalling({ modelId: executionModelId, provider: executionProvider }) === true;
  let fetchUrlPlan: FetchUrlPlan | undefined;
  if (fetchUrlOffered && scheduledOccurrence) {
    fetchUrlPlan = { version: 1, userUrlDigests: [], taskUrlDigests: (scheduledOccurrence.promptUrlDigests ?? [])
      .filter(isFetchUrlDigest).slice(0, FETCH_URL_LIMITS.authorizedUrls) };
  } else if (fetchUrlOffered) {
    const storedIds = fetchUrlAuthoringMessages(conversationMessages).map((message) => message.id)
      .filter((id) => id !== currentSendMessageId);
    let promptIds: ReadonlySet<string> | null = null;
    let systemTurnIds: ReadonlySet<string> | null = new Set();
    try {
      // Without the marks, only the current message (never a stored prompt) authorizes links.
      promptIds = deps.repository.loadScheduledPromptMessageIds
        ? await deps.repository.loadScheduledPromptMessageIds({ chatId: chat.id, messageIds: storedIds, userId: input.userId })
        : null;
      // Turns the server wrote for the user (review steps, approval continuations) authorize nothing.
      systemTurnIds = deps.repository.loadSystemTurnMessageIds
        ? await deps.repository.loadSystemTurnMessageIds({ chatId: chat.id, messageIds: storedIds, userId: input.userId })
        : new Set();
    } catch (error) {
      promptIds = null;
      systemTurnIds = null;
      logEvent("service_operation", { error, subsystem: "database", stage: "projection", outcome: "degraded", action: "degrade",
        code: "fetch_url_authority_unavailable", prisma_code: databaseFailureCode(error) });
    }
    // Known prompts only: messages refused for lack of marks are not called instructions.
    const instructionIds = new Set(promptIds ?? []);
    if (input.source.kind === "regenerate" && input.source.source.userMessage.scheduledTaskPrompt) {
      instructionIds.add(input.source.source.userMessage.id);
    }
    const excludedIds = new Set([...(promptIds ?? storedIds), ...instructionIds, ...(systemTurnIds ?? storedIds)]);
    const userUrlDigests = userAuthoredFetchUrlDigests(conversationMessages, excludedIds);
    const instructionUrlDigests = taskInstructionFetchUrlDigests(conversationMessages, instructionIds, userUrlDigests);
    fetchUrlPlan = { version: 1, userUrlDigests, ...(instructionUrlDigests.length > 0 ? { instructionUrlDigests } : {}) };
  }
  // Where it may create one, it may also manage the owner's saved tasks, once
  // there is one; in a task's own chat the tool names that task. Frozen here,
  // with the links this run's user text authorized for a prompt it rewrites.
  const scheduledTaskManagementTool = scheduledTaskTool && deps.repository.manageScheduledTaskForCall
    ? await admitScheduledTaskManagement(deps.repository, { chatId: chat.id, userId: input.userId,
      userUrlDigests: fetchUrlPlan?.userUrlDigests ?? [] }) : undefined;
  // A run a user started asks its initiator before an MCP tool that may change
  // data runs (operator decision 2026-10-08); a scheduled task's own run is its
  // owner's standing authority. The initiator's "Always allow" consents for the
  // run's servers are frozen here: a revocation applies to later runs.
  const approvalServerIds = [...new Set([
    ...(mcpPlan?.ok ? mcpPlan.snapshot.servers.map((server) => server.serverId) : []),
    ...(mcpDiscoveryEnabled && mcpCatalog ? mcpCatalog.servers.map((server) => server.serverId) : [])
  ])];
  const mcpApproval = !scheduledOccurrence && approvalServerIds.length > 0
    ? mcpApprovalAdmission(await deps.repository.loadMcpToolConsentServerIds?.({
        serverIds: approvalServerIds, userId: input.userId }) ?? [])
    : undefined;
  const baseNormalizedRequest: NormalizedRunRequest = {
    ...(memoryStandingEligible ? { memoryStandingVersion: 1 as const } : {}),
    ...(memorySearch ? { memorySearch } : {}),
    toolObservationVersion,
    ...(workspaceCheckpoints ? { workspaceCheckpoints: true as const,
      workspaceCheckpointToolDescription: checkpointOutputsTool.description } : {}),
    ...(visionAnalysis ? { visionAnalysis } : {}),
    ...(workspaceImageView ? { workspaceImageView: true as const } : {}),
    ...(artifactToolAvailable ? { artifactTool: true as const, artifactToolDescription, artifactResourcePolicy } : {}),
    ...(artifactReferences?.length ? { artifactReferences } : {}),
    ...(artifactEdit ? { artifactEdit } : {}),
    ...(artifactIntent ? { artifactIntent } : {}),
    ...(artifactFocus ? { artifactFocus } : {}),
    ...(personalInstructions ? { instructionPreset: { presetId: personalInstructions.presetId,
      revision: personalInstructions.revision, selectionVersion: personalInstructions.selectionVersion } } : {}),
    ...(imagePlan ? { imagePlan } : {}),
    ...(imageReferences.length > 0 ? { imageReferences } : {}),
    ...(fileReferences.length > 0 ? { fileReferences } : {}),
    ...(modelCapabilities.toolCalling === true && toolBridge?.supportsToolCalling({
      modelId: executionModelId, provider: executionProvider
    }) === true ? { sessionStatusTool: true as const } : {}),
    ...(monitoringCheck ? { monitoringVerdictTool: true as const } : {}),
    ...(scheduledTaskTool ? { scheduledTaskTool } : {}),
    ...(scheduledTaskManagementTool ? { scheduledTaskManagementTool } : {}),
    ...(skillSaveTool ? { skillSaveTool: true as const } : {}),
    ...(mcpApproval ? { mcpApproval } : {}),
    ...(fetchUrlPlan ? { fetchUrl: fetchUrlPlan } : {}),
    attachmentIds,
    chatId: chat.id,
    content,
    context: { messages: contextMessages, mode: "branch_path" },
    generationBudget,
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
    skills: frozenSkills.manifest,
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
      maxMcpToolsPerDiscovery: toolBudgets.maxMcpToolsPerDiscovery,
      maxToolCalls: workspaceEnabled
        ? workspaceToolLimit(toolBudgets.maxToolCalls, workspaceAdmissionPlan?.normalized.maxToolCalls)
        : toolBudgets.maxToolCalls,
      maxToolRounds: workspaceEnabled
        ? workspaceToolLimit(toolBudgets.maxToolRounds, workspaceAdmissionPlan?.normalized.maxToolRounds)
        : toolBudgets.maxToolRounds
    },
    toolMode: workspaceEnabled || body?.tools !== "none" ? "auto" : "none",
    ...(workspaceAdmissionPlan ? { workspace: workspaceAdmissionPlan.normalized } : {})
  };
  const plannedSearchTools = createSearchPlanToolRouter({
    plan: baseNormalizedRequest.searchPlan,
    runtimes: {}
  })?.tools ?? [];
  const clientTools = [
    ...skillToolsForRequest(baseNormalizedRequest),
    ...(baseNormalizedRequest.sessionStatusTool ? [sessionStatusTool] : []),
    ...(baseNormalizedRequest.toolObservationVersion === 1 ? [readToolResultTool] : []),
    ...(baseNormalizedRequest.monitoringVerdictTool ? [monitoringVerdictTool] : []),
    ...scheduledTaskToolsForRequest(baseNormalizedRequest),
    ...scheduledTaskManagementToolsForRequest(baseNormalizedRequest),
    ...skillSaveToolsForRequest(baseNormalizedRequest),
    ...fetchUrlToolsForRequest(baseNormalizedRequest),
    ...(baseNormalizedRequest.toolMode === "none" ? [] : [
        ...(memorySearch ? [memorySearchTool(memorySearch)] : []),
        ...(workspaceCheckpoints ? [checkpointOutputsTool] : []),
        ...analyzeImageTools(baseNormalizedRequest),
        ...(workspaceImageView ? [viewWorkspaceImageTool] : []),
        ...(imagePlan ? [imageGenerationTool(imagePlan)] : []),
        ...(baseNormalizedRequest.artifactTool ? [artifactTool(baseNormalizedRequest.artifactToolDescription), ...(artifactReferences?.length ? [readArtifactTool()] : [])] : []),
        ...plannedSearchTools,
        ...(mcpDiscoveryEnabled ? [mcpFindToolsTool] : []),
        ...mcpRunTools(baseNormalizedRequest.mcp),
        ...workspaceTools
      ])
  ];

  const inheritedFollowups = input.source.kind === "regenerate" ? input.source.source.followups : undefined;
  const budgetAnsweringRequest = () => applyProviderRequestContextBudget({
    ...(toolBridge ? { bridge: toolBridge } : {}),
    request: requestWithRunFollowups({
      ...baseNormalizedRequest,
      attachments,
      ...(clientTools.length > 0 ? { tools: clientTools } : {})
    }, inheritedFollowups?.entries ?? [])
  });

  let providerBudget = budgetAnsweringRequest();
  if (!providerBudget.ok && artifactCompactPrompt) {
    baseNormalizedRequest.prompt = { ...baseNormalizedRequest.prompt, ...artifactCompactPrompt };
    providerBudget = budgetAnsweringRequest();
  }
  if (!providerBudget.ok) {
    return { ...failure(
      providerBudget.error.code,
      providerBudget.status,
      providerBudget.error.message
    ), ...(providerBudget.error.skillBudget ? { skillBudget: providerBudget.error.skillBudget } : {}) };
  }
  const normalizedRequest: NormalizedRunRequest = {
    ...baseNormalizedRequest,
    context: providerBudget.request.context!
  };
  const providerRequest: ProviderRunRequest = { ...providerBudget.request };
  // Regeneration copies receipts atomically at admission. Only the new
  // executor appends them; the temporary request above budgets them once.
  if (inheritedFollowups?.entries.length) delete providerRequest.providerToolMessages;
  const followupAdmission: RunFollowupAdmission = {
    budgetTokens: followupAdmissionBudgetTokens(providerBudget.request, toolBridge),
    ...(inheritedFollowups ? { inherited: { messageId: inheritedFollowups.messageId, revision: inheritedFollowups.revision } } : {})
  };
  if (followupAdmission) {
    const reserve = followupAdmission.budgetTokens + (inheritedFollowups?.entries.reduce((sum, entry) => sum + followupTokenCost(entry.text), 0) ?? 0);
    normalizedRequest.followupContextReserveTokens = reserve;
    providerRequest.followupContextReserveTokens = reserve;
  }
  const providerRequestPreview = adapter.buildRequestPreview(providerRequest);
  // Assistant-derived values never overwrite the user's ordinary manual
  // defaults or the chat's ordinary default columns, so an Assistant run
  // persists no accepted-defaults update; its chat changes are overrides.
  const defaults: PreparedRunDefaultsData | null = assistantRun
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
    ...(followupAdmission ? { followupAdmission } : {}),
    ...(chatPdfAdmissions.length ? { chatPdfAdmissions } : {}),
    ...(chatAssistant && rowResolution
      ? {
          assistant: {
            assistantId: chatAssistant.assistant.assistantId,
            definitionVersion: chatAssistant.assistant.definitionVersion,
            identity: chatAssistant.assistant.identity,
            rows: assistantRunRowProvenance(rowResolution)
          },
          chatAssistant: chatAssistantWithPatch(chatAssistant.chatAssistant, rowResolution.overridesPatch)
        }
      : {}),
    contextTruncation: providerBudget.contextTruncation,
    defaults,
    expectedActiveLeafId: input.source.kind === "send" ? input.source.chat.activeLeafMessageId : null,
    ...(resolvedChatMode.initialChatMode
      ? { initialChatMode: resolvedChatMode.initialChatMode }
      : {}),
    ...(mcpPlan?.ok ? { mcpBindings: [...mcpPlan.bindings] } : {}),
    ...(scheduledMissingSources.length > 0 ? { scheduledUnavailableSources: scheduledMissingSources } : {}),
    ...(skillRuns.length > 0
      ? {
          skillBindings: skillRuns.map((skill) => ({
            alias: skill.alias!,
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
    sourceKind: input.source.kind
  });

  return Object.freeze({
    adapter,
    ok: true,
    prepared,
    toolBridge
  });
}
