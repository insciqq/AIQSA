import type { AssistantIdentity } from "../../contracts/assistants";
import type { ChatPdfPreparationWire } from "../../contracts/chatPdfPreparation";
import type { ChatPdfAttachmentAdmission } from "../uploads/chatPdfAdmission";
import type {
  ChatMessageWire,
  ChatContextStats,
  ChatUsageStats,
  ThreadArtifactSummary,
  ThreadAssistantIdentity,
  ThreadToolActivity,
  ThreadWorkspaceActivity
} from "../../contracts/chats";
import type { ChatWorkspaceState } from "../../contracts/workspace";
import type { WorkspaceRunAdmissionPlan } from "../workspace/admission";
import type { CatalogAdapterKind } from "../../domain/catalog";
import type { ModelRunStatus } from "../../contracts/runs";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import type { ModelTokenPricing } from "../../domain/usage";
import type { ResolvedEntitlements } from "../auth/entitlements";
import type {
  McpDiscoveryState,
  McpRunPlanBinding,
  McpRunPlanSnapshot
} from "../mcp/runPlan";
import type {
  KnowledgeRunAdmissionAuthorizationSnapshot,
  KnowledgeRunAdmissionExclusion,
  KnowledgeRunAdmissionPlan
} from "../knowledge/runAdmission";
import type {
  KnowledgeFullContextDispatchRecovery,
  KnowledgeRunFinalizationEnvelope
} from "../knowledge/evidenceRepository";
import type { KnowledgeAnswerContractVersions } from "../knowledge/answerGroundingV5";
import type { ProviderAdmissionPlan } from "../providerRuntime/admission";
import type {
  SearchAdapterKind,
  SearchCredentialMode,
  SearchPlanMode,
  SearchProtocol
} from "../../domain/search";
import type { SearchPlan } from "../../domain/search";
import type {
  AdvanceToolLoopCallBatchResult,
  BeginToolLoopProviderRoundResult,
  CheckpointedToolLoopRun,
  ClaimToolLoopCallResult,
  PersistedAnswerRoundUsage,
  PersistedToolLoopCall,
  PrepareAutomaticKnowledgeCallBatchInput,
  PrepareAutomaticKnowledgeCallBatchResult,
  PersistToolLoopCallBatchInput,
  PersistToolLoopCallBatchResult,
  ProjectRunRecoveryAuthority,
  SettleToolLoopCallResult,
  ToolLoopJsonValue
} from "./toolLoopPersistence";
import type {
  NormalizedRunRequest,
  ProviderAttachment,
  ProviderConversationMessage,
  ProviderModelCapabilities,
  ProviderRunRequest
} from "../providers/types";
import type { ContextTruncationSummary } from "../../domain/contextBudget";
import type { RunOutputArtifactEvent } from "./runOutputEvents";
import type { ProviderReasoningRequestMapping } from "../../contracts/providerReasoningRequestMapping";
import type {
  MemoryPreparingAttemptResult,
  MemoryPreparingSettingsSnapshot
} from "./preparingRun";
import type { MemoryInitialChatMode } from "../../contracts/memory";
import type { ProjectDefaultsWire, ProjectPolicyWire } from "../../contracts/projects";
import type { KnowledgeFullContextPassage } from "../knowledge/fullContext";
import type { KnowledgeRunAdmissionSource } from "../knowledge/runAdmission";

export type ProjectRunMemoryItem = Readonly<{
  factId: string;
  factVersionId: string;
  includedText: string;
  ordinal: number;
}>;

export type FocusedKnowledgeRecoveryScope = KnowledgeRunAdmissionAuthorizationSnapshot &
  Readonly<{ exclusions: readonly KnowledgeRunAdmissionExclusion[] }>;

/** Immutable, server-loaded Project context carried into run admission. */
export type ProjectRunAdmission = Readonly<{
  accessRevision: number;
  assistantBindings: readonly Readonly<{ assistantId: string }>[];
  defaults: ProjectDefaultsWire;
  instructions: string;
  instructionsRevision: number;
  knowledgeBaseIds: readonly string[];
  mcpServerIds: readonly string[];
  memoryEnabled: boolean;
  memoryItems: readonly ProjectRunMemoryItem[];
  memoryRevision: number;
  modelIds: readonly string[];
  policy: ProjectPolicyWire;
  policyRevision: number;
  projectId: string;
  /** Project runs always resolve installation/shared provider authority. */
  executionScope?: "project";
  role: "CONTRIBUTOR" | "MANAGER" | "OWNER" | "VIEWER";
  searchOptionIds: readonly string[];
  skillIds?: readonly string[];
}>;

export type RunAttachmentRecord = ProviderAttachment & {
  preparedPdf?: Readonly<{ byteSize: number; checksum: string; pageCount: number; sourceChecksum: string; storageKey: string }>;
  workspaceOriginalOnly?: boolean;
  checksum: string | null;
  processingErrorCode: string | null;
  storageKey: string;
};

export type RunModelConfiguration = {
  adapterKind: CatalogAdapterKind;
  capabilities: ProviderModelCapabilities;
  defaultParams: Record<string, unknown>;
  reasoningRequestMapping?: ProviderReasoningRequestMapping;
};

export type RunSearchStrategyConfiguration = {
  adapterKind: SearchAdapterKind;
  config: Record<string, unknown>;
  credentialMode: SearchCredentialMode;
  displayName: string;
  executionModes: SearchPlanMode[];
  kind: string;
  modelId: string | null;
  protocol: SearchProtocol;
  provider: string;
  providerModelId: string | null;
  revisionId: string;
  searchStrategyRowId: string;
  strategyId: string;
};

export type RunControlRecord = {
  assistantMessageId: string | null;
  chatId: string;
  id: string;
  modelId: string;
  project?: ProjectRunRecoveryAuthority;
  /** Legacy ProjectRunBinding rows with incomplete immutable authority. Active
   * recovery must fail these closed; terminal history remains readable. */
  projectRecoveryInvalid?: true;
  provider: string;
  providerResponseId: string | null;
  recoverySettled?: boolean;
  status: string;
};

export type DurableRunControlRecord = Omit<RunControlRecord, "status"> & {
  status: ModelRunStatus;
};

export type RunOutcomeRecord = Pick<DurableRunControlRecord, "id" | "status"> & { pdfPreparation?: readonly ChatPdfPreparationWire[] };

export type StaleRunControlRecord = RunControlRecord & {
  updatedAt: Date | string;
};

export type InstallationRecoverableRunRecord = StaleRunControlRecord & {
  userId: string;
};

export type RunChatUpdateRecord = {
  chat: {
    activeLeafMessageId: string | null;
    contextStats: ChatContextStats;
    createdAt: Date | string;
    defaultModelId: string | null;
    defaultProvider: string | null;
    folderId: string | null;
    id: string;
    messageCount: number;
    pinned: boolean;
    projectId?: string | null;
    title: string;
    updatedAt: Date | string;
    usageStats?: ChatUsageStats | null;
    workspace?: ChatWorkspaceState;
  };
  messages: {
    pdfPreparation?: readonly ChatPdfPreparationWire[];
    artifactSummary?: ThreadArtifactSummary | null;
    assistantIdentity?: ThreadAssistantIdentity | null;
    citationMessageId?: string | null;
    content: unknown;
    createdAt: Date | string;
    errorMessage?: string | null;
    id: string;
    modelId: string | null;
    modelRunId?: string | null;
    author?: ChatMessageWire["author"];
    parentMessageId: string | null;
    provider: string | null;
    role: string;
    status: string;
    toolActivity?: ThreadToolActivity | null;
    workspaceActivity?: ThreadWorkspaceActivity | null;
  }[];
};

export class ActiveRunConflictError extends Error {
  constructor() {
    super("active_run_in_progress");
    this.name = "ActiveRunConflictError";
  }
}

export class ActiveLeafConflictError extends Error {
  constructor() {
    super("active_leaf_changed");
    this.name = "ActiveLeafConflictError";
  }
}

export class AttachmentLinkConflictError extends Error {
  constructor() {
    super("attachment_not_available");
    this.name = "AttachmentLinkConflictError";
  }
}

export class WorkspaceRunConflictError extends Error {
  readonly code: "workspace_busy" | "workspace_disabled" | "workspace_runtime_incompatible";

  constructor(code: WorkspaceRunConflictError["code"]) {
    super(code);
    this.code = code;
    this.name = "WorkspaceRunConflictError";
  }
}

export class McpRunPlanConflictError extends Error {
  constructor() {
    super("mcp_not_ready");
    this.name = "McpRunPlanConflictError";
  }
}

export class ProviderAdmissionConflictError extends Error {
  constructor() {
    super("provider_admission_changed");
    this.name = "ProviderAdmissionConflictError";
  }
}

export class KnowledgeRunPlanConflictError extends Error {
  constructor() {
    super("knowledge_base_not_available");
    this.name = "KnowledgeRunPlanConflictError";
  }
}

export class AssistantRunConflictError extends Error {
  constructor() {
    super("assistant_not_available");
    this.name = "AssistantRunConflictError";
  }
}

export class SkillRunConflictError extends Error {
  constructor() {
    super("skill_not_available");
    this.name = "SkillRunConflictError";
  }
}

/** Exact accepted Assistant provenance persisted with the run. */
export type AcceptedAssistantRun = {
  assistantId: string;
  definitionVersion: number;
  identity: AssistantIdentity;
};

export type AcceptedSkillRun = {
  revisionId: string;
  skillId: string;
};

export type AcceptedRunDefaults = {
  controlDefaults: Record<string, boolean | string>;
  modelId: string;
  provider: string;
  searchPlan: SearchPlan;
  searchPreferencePlan?: SearchPlan | null;
  userId: string;
};

export type CancelRunResult =
  | {
      kind: "cancelled";
      run: DurableRunControlRecord & { status: "cancelled" };
    }
  | {
      kind: "current";
      run: DurableRunControlRecord;
    }
  | {
      kind: "not_found";
    };

export type RunUsageAttribution = {
  estimatedCostMicros?: number | null;
  modelId: string;
  provider: string;
  usage: ModelRunUsage;
};

export type PersistedRunUsageAttribution = RunUsageAttribution & {
  recordedAt: string;
};

export type ProviderResponseIdPublication = "cancelled" | "published" | "terminal";

export type CreateRunInput = {
  chatPdfAdmissions?: readonly ChatPdfAttachmentAdmission[];
  deferredPdf?: Readonly<{ admissionKey: string; snapshot: unknown }>;
  assistant?: AcceptedAssistantRun;
  chatId: string;
  content: { blocks: unknown[] };
  defaults?: AcceptedRunDefaults;
  expectedActiveLeafId: string | null;
  knowledgeAdmissionPlan?: KnowledgeRunAdmissionPlan;
  initialChatMode?: MemoryInitialChatMode;
  mcpBindings?: McpRunPlanBinding[];
  skillBindings?: AcceptedSkillRun[];
  modelId: string;
  memoryMaterializer?: PreparingRunMemoryMaterializer;
  normalizedRequest: NormalizedRunRequest;
  providerAdmissionPlan?: ProviderAdmissionPlan;
  provider: string;
  providerRequestPreview: Record<string, unknown>;
  project?: ProjectRunAdmission;
  /** First personal send only: the chat row is committed with messages/run in
   * the same transaction, so rejected admission cannot leave an empty chat. */
  personalChat?: Readonly<{
    defaultProviderModelId: string | null;
    folderId: string | null;
    memoryMode: "EXCLUDED" | "NORMAL" | "TEMPORARY";
  }>;
  /** First Project send only: the chat row is committed with messages/run in
   * the same transaction, so a rejected admission cannot leave an empty chat. */
  projectChat?: Readonly<{ folderId: string | null }>;
  signal?: AbortSignal;
  userId: string;
  workspaceAdmissionPlan?: WorkspaceRunAdmissionPlan;
  workspaceEnabled?: boolean;
};

export type CreateRegenerationRunInput = {
  chatPdfAdmissions?: readonly ChatPdfAttachmentAdmission[];
  deferredPdf?: Readonly<{ admissionKey: string; snapshot: unknown }>;
  assistant?: AcceptedAssistantRun;
  chatId: string;
  defaults?: AcceptedRunDefaults;
  knowledgeAdmissionPlan?: KnowledgeRunAdmissionPlan;
  mcpBindings?: McpRunPlanBinding[];
  skillBindings?: AcceptedSkillRun[];
  modelId: string;
  memoryMaterializer?: PreparingRunMemoryMaterializer;
  normalizedRequest: NormalizedRunRequest;
  /** Null means a newly committed user branch with no Assistant child yet. */
  preSendAssistantMessageId: string | null;
  providerAdmissionPlan?: ProviderAdmissionPlan;
  provider: string;
  providerRequestPreview: Record<string, unknown>;
  project?: ProjectRunAdmission;
  signal?: AbortSignal;
  userId: string;
  userMessageId: string;
  workspaceAdmissionPlan?: WorkspaceRunAdmissionPlan;
  workspaceEnabled?: boolean;
};

export type PreparingRunAdmissionInput =
  | (CreateRunInput & { admissionKind: "NORMAL_SEND" })
  | (CreateRegenerationRunInput & { admissionKind: "REGENERATE" });

export type PreparingRunAdmissionResult = Readonly<{
  deferredPdf?: true;
  pdfMemorySource?: Readonly<{
    activeLeafMessageId: string | null;
    memoryBranchGeneration: number;
    memorySourceRevision: number;
    preSendActiveLeafMessageId: string | null;
  }>;
  assistantMessageId: string;
  attemptId: string;
  chatMemoryMode: "NORMAL" | "EXCLUDED" | "TEMPORARY";
  folderId: string | null;
  memoryGeneration: number;
  memoryRevision: number;
  runId: string;
  settingsSnapshot: MemoryPreparingSettingsSnapshot;
  userMessageId: string;
}>;

export type PreparingRunMaterializedRequest = Readonly<{
  contextTruncation: ContextTruncationSummary | null;
  normalizedRequest: NormalizedRunRequest;
  providerRequest: ProviderRunRequest;
  providerRequestPreview: Readonly<Record<string, unknown>>;
}>;

export type PreparingRunMemoryMaterializer = (
  personalContext: NonNullable<NormalizedRunRequest["personalContext"]> | null,
  memoryActionAnswerResult?: NonNullable<
    NormalizedRunRequest["prompt"]["memoryActionAnswerResult"]
  >
) => PreparingRunMaterializedRequest | null;

export type CreatedRun = Readonly<{
  deferredPdf?: true;
  assistantMessageId: string;
  materializedRequest?: PreparingRunMaterializedRequest;
  runId: string;
  userMessageId: string;
}>;

export type PreparingRunFinalizationInput = Readonly<{
  assistant?: AcceptedAssistantRun;
  attemptId: string;
  knowledgeAdmissionPlan?: KnowledgeRunAdmissionPlan;
  mcpBindings?: readonly McpRunPlanBinding[];
  project?: ProjectRunAdmission;
  skillBindings?: readonly AcceptedSkillRun[];
  normalizedRequest: NormalizedRunRequest;
  providerAdmissionPlan?: ProviderAdmissionPlan;
  providerRequestPreview: Readonly<Record<string, unknown>>;
  runId: string;
  userId: string;
}>;

export type PreparingRunRecoveryResult =
  | "deferred"
  | "finalized"
  | "not_preparing"
  | "settled";

export type RunOwnedChatRecord = Readonly<{
  activeLeafMessageId: string | null;
  defaultKnowledgePlan?: unknown;
  defaultModelId: string;
  defaultProvider: string;
  folderId?: string | null;
  folderDefaultKnowledgePlan?: unknown;
  id: string;
  memoryMode?: "NORMAL" | "EXCLUDED" | "TEMPORARY";
  messageCount: number;
  projectFolderId?: string | null;
  projectMemory: string | null;
  project?: ProjectRunAdmission;
  title: string;
  workspaceEnabled?: boolean;
}>;

export type RunRepository = {
  hasPendingPdfPreparation?(runId: string): Promise<boolean>;
  continuePdfPreparedRun?(input: Readonly<{
    admission: PreparingRunAdmissionInput;
    claimToken: string;
    created: PreparingRunAdmissionResult;
  }>): Promise<CreatedRun>;
  admitPreparingRun(input: PreparingRunAdmissionInput): Promise<PreparingRunAdmissionResult>;
  appendMcpDiscoveryEpoch?(input: {
    bindings: readonly McpRunPlanBinding[];
    goal: string;
    modelRunToolCallId: string;
    roundIndex: number;
    runId: string;
    snapshot: McpRunPlanSnapshot;
    toolIds: readonly string[];
    userId: string;
  }): Promise<Readonly<{
    discovery: McpDiscoveryState;
    snapshot: McpRunPlanSnapshot;
  }> | null>;
  advanceToolLoopCallBatch(input: {
    roundIndex: number;
    runId: string;
    userId: string;
  }): Promise<AdvanceToolLoopCallBatchResult>;
  appendAssistantText(
    assistantMessageId: string,
    text: string,
    options: Readonly<{ allowErrored?: boolean; runId: string }>
  ): Promise<void>;
  appendRunOutputEvent(runId: string, event: RunOutputArtifactEvent): Promise<RunOutputArtifactEvent>;
  beginToolLoopProviderRound(input: {
    providerContinuation: ToolLoopJsonValue | null;
    providerCursor?: number | string | null;
    roundIndex: number;
    runId: string;
    userId: string;
  }): Promise<BeginToolLoopProviderRoundResult>;
  beginPreparingRunAttempt(input: Readonly<{
    attemptId: string;
    now: Date;
    runId: string;
    userId: string;
  }>): Promise<boolean>;
  cancelPendingToolLoopCalls(input: { runId: string; userId: string }): Promise<number>;
  claimToolLoopCall(input: {
    callId: string;
    runId: string;
    userId: string;
  }): Promise<ClaimToolLoopCallResult>;
  claimAutomaticKnowledgeCall?(input: {
    callId: string;
    runId: string;
    userId: string;
  }): Promise<ClaimToolLoopCallResult>;
  sweepBootOrphanedRuns(input: { createdBefore: Date; liveRunIds: string[] }): Promise<number>;
  cancelRun(input: {
    payload: { code: string; message: string };
    runId: string;
    userId: string;
  }): Promise<CancelRunResult>;
  completePreparingRunAttempt(input: Readonly<{
    attemptId: string;
    result: MemoryPreparingAttemptResult;
    runId: string;
    userId: string;
  }>): Promise<boolean>;
  completeRun(input: {
    assistantMessageId: string;
    chatId: string;
    estimatedCostMicros: number | null;
    finalText: string;
    knowledgeGrounding?: KnowledgeRunFinalizationEnvelope;
    modelId: string;
    provider: string;
    providerResponseId?: string;
    runId: string;
    outputEvents?: RunOutputArtifactEvent[];
    usage: ModelRunUsage;
    usageAttributions?: RunUsageAttribution[];
    userId: string;
  }): Promise<boolean>;
  groundKnowledgeAnswer?(input: Readonly<{
    answer: string;
    runId: string;
    userId: string;
  }>): Promise<KnowledgeRunFinalizationEnvelope | null>;
  groundKnowledgeAnswerV5?(input: Readonly<{
    runId: string;
    userId: string;
  }> & KnowledgeAnswerContractVersions): Promise<KnowledgeRunFinalizationEnvelope>;
  groundKnowledgeAnswerV21?(input: Readonly<{
    runId: string;
    userId: string;
  }>): Promise<KnowledgeRunFinalizationEnvelope>;
  createRun(input: CreateRunInput): Promise<CreatedRun>;
  createRegenerationRun(input: CreateRegenerationRunInput): Promise<CreatedRun>;
  createSearchRun(input: {
    artifacts: unknown;
    invocationId?: string;
    modelId: string | null;
    modelRunId: string;
    provider: string;
    searchRevisionId?: string;
    status: "complete" | "error";
    strategyId: string;
  }): Promise<void>;
  failRun(
    runId: string,
    assistantMessageId: string,
    error: { code: string; message: string },
    options?: Readonly<{ recoveryTerminal?: boolean }>
  ): Promise<boolean>;
  findOwnedChat(chatId: string, userId: string): Promise<RunOwnedChatRecord | null>;
  loadProjectFirstSend?(input: Readonly<{
    chatId: string;
    folderId: string | null;
    projectId: string;
    userId: string;
  }>): Promise<RunOwnedChatRecord | null>;
  loadPersonalFirstSend?(input: Readonly<{
    chatId: string;
    folderId: string | null;
    memoryMode: "EXCLUDED" | "NORMAL" | "TEMPORARY";
    userId: string;
  }>): Promise<RunOwnedChatRecord | null>;
  findRecentActiveRunForChat(input: { chatId: string; since: Date; userId: string }): Promise<RunControlRecord | null>;
  findStaleActiveRunsForUser(input: {
    chatId?: string;
    runId?: string;
    staleBefore: Date;
    userId: string;
  }): Promise<StaleRunControlRecord[]>;
  findInstallationRecoverableRuns?(input: {
    bootedBefore: Date;
    limit: number;
    staleBefore: Date;
  }): Promise<InstallationRecoverableRunRecord[]>;
  findRegenerationSource(
    sourceMessageId: string,
    userId: string
  ): Promise<{
    assistantMessage: {
      id: string;
      modelId: string | null;
      provider: string | null;
    } | null;
    chat: {
      defaultKnowledgePlan?: unknown;
      defaultModelId: string;
      defaultProvider: string;
      folderDefaultKnowledgePlan?: unknown;
      id: string;
      memoryMode?: "NORMAL" | "EXCLUDED" | "TEMPORARY";
      projectMemory: string | null;
      project?: ProjectRunAdmission;
      workspaceEnabled?: boolean;
    };
    userMessage: {
      content: unknown;
      id: string;
    };
  } | null>;
  loadConversationContext(chatId: string, userId: string): Promise<ProviderConversationMessage[]>;
  loadConversationContextForExpectedLeaf(
    chatId: string,
    userId: string,
    expectedActiveLeafMessageId: string | null
  ): Promise<ProviderConversationMessage[] | null>;
  loadConversationContextForLeaf(
    chatId: string,
    userId: string,
    leafMessageId: string
  ): Promise<ProviderConversationMessage[]>;
  getRunControlForUser(runId: string, userId: string): Promise<RunControlRecord | null>;
  /** Internal recovery lookup. It deliberately does not depend on the
   * initiating user's current chat or Project access. */
  getRunControlForRecovery?(runId: string): Promise<RunControlRecord | null>;
  getRunOutcomeForUser(runId: string, userId: string): Promise<RunOutcomeRecord | null>;
  getChatUpdateForRun(input: {
    assistantMessageId: string;
    chatId: string;
    userId: string;
    userMessageId: string;
  }): Promise<RunChatUpdateRecord | null>;
  isProjectRunAccessCurrent?(input: {
    accessRevision: number;
    instructionsRevision: number;
    memoryRevision: number;
    policyRevision: number;
    projectId: string;
    userId: string;
  }): Promise<boolean>;
  isSearchStrategyEnabled(searchStrategyId: string): Promise<boolean>;
  loadAttachments(userId: string, attachmentIds: string[], projectId?: string, runId?: string): Promise<RunAttachmentRecord[]>;
  loadKnowledgeFullContextPassages?(
    sources: readonly KnowledgeRunAdmissionSource[]
  ): Promise<readonly KnowledgeFullContextPassage[] | null>;
  /** Purpose-bound recovery loader for a full-context manifest accepted into
   * the evidence session before any current Draft provider operation exists. */
  loadKnowledgeFullContextDispatchRecovery?(input: {
    maximumTokens: number;
    modelId: string;
    provider: string;
    runId: string;
    userId: string;
  }): Promise<KnowledgeFullContextDispatchRecovery | null>;
  loadEntitlements(userId: string): Promise<ResolvedEntitlements>;
  loadModelPricing(provider: string, modelId: string): Promise<ModelTokenPricing | null>;
  loadRunUsageAttributions(input: {
    runId: string;
    userId: string;
  }): Promise<PersistedRunUsageAttribution[]>;
  finalizePreparingRun(input: PreparingRunFinalizationInput): Promise<boolean>;
  loadCheckpointedToolLoopRun(input: {
    runId: string;
    userId: string;
  }): Promise<CheckpointedToolLoopRun | null>;
  /** Server-only checkpoint for the one focused Knowledge operation. */
  loadFocusedKnowledgeCall?(input: {
    runId: string;
    userId: string;
  }): Promise<PersistedToolLoopCall | null>;
  /** Immutable admission exclusions used when recovery must seal the focused
   * manifest after retrieval but before the first answer-provider dispatch. */
  loadFocusedKnowledgeScopeExclusions?(input: {
    runId: string;
    userId: string;
  }): Promise<readonly KnowledgeRunAdmissionExclusion[] | null>;
  /** Exact accepted Knowledge authority required before recovery retrieval and
   * again before an evidence-bearing provider dispatch. */
  loadFocusedKnowledgeRecoveryScope?(input: {
    runId: string;
    userId: string;
  }): Promise<FocusedKnowledgeRecoveryScope | null>;
  /** Purpose-bound, server-only loader for replaying an evidence-bearing
   * provider request after a crash before the first provider dispatch. */
  loadProviderDispatchRecoveryRequest?(input: {
    runId: string;
    userId: string;
  }): Promise<NormalizedRunRequest | null>;
  persistToolLoopCallBatch(input: PersistToolLoopCallBatchInput): Promise<PersistToolLoopCallBatchResult>;
  prepareAutomaticKnowledgeCallBatch?(
    input: PrepareAutomaticKnowledgeCallBatchInput
  ): Promise<PrepareAutomaticKnowledgeCallBatchResult>;
  recordRunUsageEvents(input: {
    answerRoundUsage?: PersistedAnswerRoundUsage;
    chatId: string;
    runId: string;
    usageAccountedToolCallIds?: readonly string[];
    usageAttributions: RunUsageAttribution[];
    userId: string;
  }): Promise<boolean>;
  recoverPreparingRun(input: Readonly<{
    now: Date;
    runId: string;
    userId: string;
  }>): Promise<PreparingRunRecoveryResult>;
  retryPreparingRunAttempt(input: Readonly<{
    attemptId: string;
    now: Date;
    runId: string;
    userId: string;
  }>): Promise<Readonly<{
    attemptId: string;
    memoryGeneration: number;
    memoryRevision: number;
    settingsSnapshot: MemoryPreparingSettingsSnapshot;
  }> | null>;
  settlePreparingRunFailure(input: Readonly<{
    retryable?: boolean;
    attemptId?: string;
    errorCode: string;
    message: string;
    runId: string;
    state: "CANCELLED" | "EXPIRED" | "FAILED" | "STALE";
    userId: string;
  }>): Promise<boolean>;
  settleRecoveredRunError(input: {
    error: { code: string; message: string };
    outputEvents: RunOutputArtifactEvent[];
    providerResponseId?: string;
    runId: string;
    usageAttributions: RunUsageAttribution[];
    userId: string;
  }): Promise<boolean>;
  settleToolLoopCall(input: {
    callId: string;
    result: ToolLoopJsonValue;
    runId: string;
    state: "complete" | "error";
    userId: string;
  }): Promise<SettleToolLoopCallResult>;
  resetToolLoopAssistantDraft(input: {
    roundIndex: number;
    runId: string;
    userId: string;
  }): Promise<boolean>;
  /**
   * Records when the current round's answer text began. A tool-loop round
   * reset clears the mark, so the settled value is the final answer's start.
   */
  markRunAnswerStarted(input: { at: Date; runId: string }): Promise<void>;
  updateRunProviderResponseId(
    runId: string,
    providerResponseId: string
  ): Promise<ProviderResponseIdPublication>;
};
