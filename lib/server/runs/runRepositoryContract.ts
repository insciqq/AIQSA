import type { AssistantIdentity, AssistantRunRowProvenance } from "../../contracts/assistants";
import type { AssistantRowContext, AssistantRowResourceIds } from "../assistants/rowContext";
import type { ChatPdfPreparationWire } from "../../contracts/chatPdfPreparation";
import type { ChatPdfAttachmentAdmission } from "../uploads/chatPdfAdmission";
import type {
  ChatAssistantOverridesPatch,
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
import type { ImageFailureEvidence } from "../images/errors";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import type { ModelTokenPricing } from "../../domain/usage";
import type { RunUsageAttributionPurpose } from "../../domain/usagePurpose";
import type { ProviderModelCostBasis } from "../usage";
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
  ContextSummaryReceiptWrite,
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
import type { ContextCompactionCheckpoint } from "../../contracts/contextCompaction";
import type { BranchContextCheckpoints } from "./contextCompactionContract";
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
  answerComplete?: true;
  workspaceWaitPending?: boolean;
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

export type RunOutcomeRecord = Pick<DurableRunControlRecord, "id" | "status"> & {
  followups?: import("../../contracts/runFollowups").RunFollowupState;
  answerComplete?: true;
  workspacePreparation?: true;
  pdfPreparation?: readonly ChatPdfPreparationWire[];
};

export type StaleRunControlRecord = RunControlRecord & {
  updatedAt: Date | string;
};

export type InstallationRecoverableRunRecord = StaleRunControlRecord & {
  userId: string;
};

export type RunChatUpdateRecord = {
  chat: {
    titlePending?: boolean;
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
    followups?: ChatMessageWire["followups"];
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
    systemTurnKind?: ChatMessageWire["systemTurnKind"];
    answerReview?: ChatMessageWire["answerReview"];
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

/**
 * A same-chat task's previous shown result carried into its rotated chat:
 * the answer text, bounded, owned by the task's owner, with the personal MCP
 * servers it relied on and its source in the previous chat.
 */
export type ScheduledResultCopy = Readonly<{
  answer: string;
  reliedServerIds: readonly string[];
  sourceAssistantMessageId: string;
  sourceChatId: string;
}>;

/**
 * The scheduled task occurrence a send admits; a server dependency, never a
 * request field. The accepted run persists the task, occurrence and generation
 * as its scheduled origin. Memory never applies to such a run.
 */
export type ScheduledOccurrenceAdmission = Readonly<{
  occurrenceId: string;
  taskId: string;
  /** Frozen on the accepted occurrence and run. */
  taskGeneration: number;
  /**
   * The task revision read before preparation: an owner edit or pause since
   * then refuses the link, so the occurrence is admitted again under the
   * current task.
   */
  taskRevision: number;
  /**
   * The task's chat epoch read with `taskRevision`: run creation links only
   * while it is current, and a link that moves the task to another chat (this
   * run's new one) advances it. Absent: an admission prepared before epochs,
   * read as 0.
   */
  taskChatEpoch?: number;
  /**
   * The calendar month (task zone) of the occurrence's instant, recorded as
   * the month the task's chat takes when this run moves the task to a new
   * chat or the task has none recorded yet.
   */
  chatPeriod?: string | null;
  /**
   * A chat this run creates: the title it is created with (no later rename)
   * and, committed with it, the task as its origin for history retention.
   */
  newChat?: Readonly<{ title: string }>;
  /**
   * The monthly rotation this run starts in a same-chat task: its link moves
   * the task off `fromChatId` (still the task's chat under the epoch read),
   * keeps `previousResultCopy` as the new chat's carried result and transfers
   * the Workspace seed captured from the old chat, all or nothing.
   */
  rotation?: Readonly<{ fromChatId: string; seedId: string | null }>;
  /**
   * The only earlier turn the run's context keeps besides its prompt: the
   * task's previous shown result (same-chat mode), used only while both
   * messages lie on the path the run appends to. Null: the prompt alone.
   */
  previousResult: Readonly<{ assistantMessageId: string; userMessageId: string }> | null;
  /**
   * The previous shown result as a frozen copy carried from the task's
   * previous chat, used when `previousResult` is not on the path: the run
   * sees the task prompt and this answer. Never message ids of another chat:
   * the link rechecks that the copy is still the task's for this epoch and
   * generation and that its source answer is still there.
   */
  previousResultCopy?: ScheduledResultCopy;
  /**
   * The personal MCP servers whose absence makes this run incomplete: those
   * the task's previous shown result called, or relied on but already missed.
   * Null: every server (the task has no previous shown result to judge by).
   */
  relevantMcpServerIds: readonly string[] | null;
  /**
   * The task is a monitoring task: the run is a check that must be able to
   * report its outcome through the built-in verdict tool, or it is refused
   * with `model_cannot_report`. The task revision fence keeps it current.
   */
  monitoring?: true;
  /**
   * The prompt's page-reading snapshot (`ScheduledTask.promptUrlDigests`),
   * read with `taskRevision`: the only prompt links the run may read with
   * `fetch_url`, frozen at admission. Absent: none.
   */
  promptUrlDigests?: readonly string[];
  /**
   * The task has Memory on: the run reads the owner's Memory like an
   * ordinary personal turn (standing context and, with a tool-calling
   * model, Memory search) in whatever Memory mode its chat has, and never
   * adds to it. The task revision fence keeps it current.
   */
  memory?: true;
}>;

/**
 * A relevant personal MCP server a scheduled run's Auto catalog could not
 * offer, frozen at admission on the run's occurrence as its source health.
 */
export type ScheduledUnavailableSource = Readonly<{
  name: string;
  reason: "mcp_reauthorization_required" | "mcp_server_unavailable";
  /**
   * The task's previous result relied on this server, so it stays relevant
   * for the next run while it is missing. False when the run had no previous
   * result to judge by and counted every server: such a guess is not carried.
   */
  relied: boolean;
  serverId: string;
}>;

/**
 * Why a chat run's `create_scheduled_task` call created nothing: an owner
 * create rule's code, `scheduled_task_answer_limit` when this answer already
 * created its one task, `scheduled_task_already_created` when another answer
 * to the same message did and the owner still has that task, or
 * `scheduled_task_call_unavailable` when the call cannot create at all (a
 * scheduled, settled or missing run, another answer to a scheduled task's own
 * turn, or a call that is not this run's claimed creation).
 */
export type ScheduledTaskCallRefusal = import("../../contracts/scheduledTasks").ScheduledTaskErrorCode |
  "scheduled_task_already_created" | "scheduled_task_answer_limit" | "scheduled_task_call_unavailable";

export type ScheduledTaskCallCreation =
  /** Created; the call settled with `result` in the creation's transaction. */
  | Readonly<{ kind: "created"; result: import("../tools/types").ToolExecutionResult;
    task: import("../../contracts/scheduledTasks").ScheduledTask }>
  /** The call had settled before (a recovered replay): its stored result, null when unreadable. Nothing was created. */
  | Readonly<{ kind: "settled"; result: import("../tools/types").ToolExecutionResult | null }>
  | Readonly<{ kind: "refused"; code: ScheduledTaskCallRefusal }>;

/** What a `manage_scheduled_task` call does: reads, a change through the owner's edit rules, or a deletion proposal. */
export type ScheduledTaskManagementAction = "list" | "get" | "update" | "pause" | "resume" | "propose_delete";

/**
 * What a settled management call found or did, for its result: the owner's
 * tasks (`list`), one task (`get`, `propose_delete`) or the task as a change
 * left it, `changed` false when the task already was as asked.
 */
export type ScheduledTaskManagementOutcome =
  | Readonly<{ action: "list"; tasks: readonly import("../../contracts/scheduledTasks").ScheduledTask[] }>
  | Readonly<{ action: "get" | "propose_delete"; task: import("../../contracts/scheduledTasks").ScheduledTask }>
  | Readonly<{ action: "update" | "pause" | "resume"; changed: boolean;
    task: import("../../contracts/scheduledTasks").ScheduledTask }>;

/**
 * Why a chat run's `manage_scheduled_task` call settled nothing: an owner edit
 * rule's code (`scheduled_task_not_found` also for another owner's task),
 * `scheduled_task_answer_limit` when this answer already changed or proposed
 * deleting five other tasks, `scheduled_task_read_required` when a new prompt
 * was sent for a task this answer has not read with `get`,
 * `scheduled_task_arguments_invalid` when the arguments do not fit the task as
 * it is, or `scheduled_task_call_unavailable` as for a creation.
 */
export type ScheduledTaskCallManagementRefusal = import("../../contracts/scheduledTasks").ScheduledTaskErrorCode |
  "scheduled_task_answer_limit" | "scheduled_task_arguments_invalid" | "scheduled_task_call_unavailable" |
  "scheduled_task_read_required";

export type ScheduledTaskCallManagement =
  /** Done; the call settled with `result` in the same transaction as any change and its card. */
  | Readonly<{ kind: "managed"; result: import("../tools/types").ToolExecutionResult }>
  /** The call had settled before (a recovered replay): its stored result, null when unreadable. Nothing was applied. */
  | Readonly<{ kind: "settled"; result: import("../tools/types").ToolExecutionResult | null }>
  | Readonly<{ kind: "refused"; code: ScheduledTaskCallManagementRefusal; detail?: string }>;

/** The occurrence is gone, already has its run, or its task changed since preparation; the admission rolled back. */
export class ScheduledOccurrenceConflictError extends Error {
  constructor() {
    super("scheduled_task_occurrence_unavailable");
    this.name = "ScheduledOccurrenceConflictError";
  }
}

/** An answer review step's admission found its session no longer running, or its step already claimed. */
export class AnswerReviewStepConflictError extends Error {
  readonly code: "answer_review_ended" | "answer_review_step_unavailable";

  constructor(code: "answer_review_ended" | "answer_review_step_unavailable") {
    super(code);
    this.code = code;
    this.name = "AnswerReviewStepConflictError";
  }
}

/**
 * A send that is a step of an answer review session (server-only, never a
 * request field): its turn claims the step once, both of its messages carry
 * the session, and the session must still be running.
 */
export type AnswerReviewStepAdmission = Readonly<{ round: number; sessionId: string; step: number }>;

/** Which answer review session a run belongs to: its own chain stays whole in its context. */
export type ConversationContextOptions = Readonly<{ answerReviewSessionId?: string | null }>;

/**
 * A send or regeneration with automatic answer review on, resolved on the
 * server before admission: the answer's model and the admitted reviewers with
 * their display snapshots, the rounds, and the controls frozen for every step.
 * The admitting transaction creates the answer's automatic session with them
 * and stores the chat's choice.
 */
export type AnswerReviewAutoAdmission = Readonly<{
  authorModel: Readonly<{ modelId: string; name: string; provider: string }>;
  /** `AnswerReviewAutoControls`: the send's step controls and each reviewer's Search. */
  controls: Readonly<Record<string, unknown>>;
  maxRounds: 1 | 2 | 3;
  reviewers: readonly Readonly<{ modelId: string; name: string; provider: string }>[];
}>;

/** Exact accepted Assistant provenance persisted with the run. */
export type AcceptedAssistantRun = {
  assistantId: string;
  definitionVersion: number;
  identity: AssistantIdentity;
  /** Where each row's value came from; absent in snapshots frozen before rows existed. */
  rows?: AssistantRunRowProvenance;
};

/**
 * An Assistant run's chat binding, in a personal or Project chat. Admission
 * rechecks that the chat is still bound as prepared, binds it when `bind` is
 * set (a first message creates the chat bound), and applies the override
 * change (stored controls follow their model) in the same transaction.
 */
export type AcceptedChatAssistant = {
  assistantId: string;
  /** The chat had no binding when the run was prepared. */
  bind: boolean;
  overridesPatch: ChatAssistantOverridesPatch;
};

export type AcceptedSkillRun = {
  alias?: string;
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
  /** Exact admitted catalogue identity: of an external harness's usage, and of
   * every Knowledge retrieval call (its prices cost the row). */
  providerModelId?: string;
  /** Retained contribution count for subtracting saved answer rounds during recovery. */
  operationCount?: number | null;
  /** The row's cost, settled per call (`hasSettledRunUsageCost`): a
   * provider-reported cost, or the cost an earlier write of a Knowledge
   * retrieval or Search row recorded, is kept by every rewrite, and an absent
   * cost is priced when the row is written (from the deployment, or from the
   * model's token prices and per-search fee). An answer call has a cost only
   * when its provider reported one (`costReported`). */
  estimatedCostMicros?: number | null;
  /** An answer row whose cost is the charge its provider reported for its
   * calls (OpenRouter), kept by every rewrite. Other answer rows are priced
   * from token prices whenever they are written. */
  costReported?: true;
  modelId: string;
  provider: string;
  /** What the attributed call paid for; set where the attribution is produced. */
  purpose: RunUsageAttributionPurpose;
  usage: ModelRunUsage;
};

export type PersistedRunUsageAttribution = RunUsageAttribution & {
  recordedAt: string;
};

export type RunCompletionInput = {
  followupRevision?: number;
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
};

export type ProviderResponseIdPublication = "cancelled" | "published" | "terminal";

export type CreateRunInput = {
  followupAdmission?: import("./runFollowups").RunFollowupAdmission;
  workspaceFollowup?: Readonly<{ admissionKey: string; predecessorRunId: string; snapshot: unknown }>;
  chatPdfAdmissions?: readonly ChatPdfAttachmentAdmission[];
  deferredPdf?: Readonly<{ admissionKey: string; snapshot: unknown }>;
  assistant?: AcceptedAssistantRun;
  chatAssistant?: AcceptedChatAssistant;
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
  /** A scheduled task's personal send: the run links this occurrence in its
   * creating transaction or is not created, records its scheduled origin,
   * marks its user message as the task's prompt, bypasses Personal Memory,
   * and leaves the owner's saved composer controls and an existing chat's
   * Workspace switch unchanged. */
  scheduledOccurrence?: ScheduledOccurrenceAdmission;
  /** With `scheduledOccurrence`: the relevant sources its plan lacked, frozen on the occurrence. */
  scheduledUnavailableSources?: readonly ScheduledUnavailableSource[];
  signal?: AbortSignal;
  /** The user message is a turn the server wrote for the user (`Message.systemTurnKind`). */
  systemTurnKind?: import("../../contracts/mcpApprovals").MessageSystemTurnKind;
  /**
   * An answer review step: the turn claims its step in the admitting
   * transaction, writes no message-window row, keeps the owner's saved
   * composer controls and queues no Memory command. Set with `systemTurnKind`.
   */
  answerReviewStep?: AnswerReviewStepAdmission;
  /** Automatic answer review of this send's answer. */
  answerReviewAuto?: AnswerReviewAutoAdmission;
  userId: string;
  workspaceAdmissionPlan?: WorkspaceRunAdmissionPlan;
  workspaceEnabled?: boolean;
};

export type CreateRegenerationRunInput = {
  /** Automatic answer review of the new answer (never of a turn the server wrote). */
  answerReviewAuto?: AnswerReviewAutoAdmission;
  followupAdmission?: import("./runFollowups").RunFollowupAdmission;
  workspaceFollowup?: never;
  chatPdfAdmissions?: readonly ChatPdfAttachmentAdmission[];
  deferredPdf?: Readonly<{ admissionKey: string; snapshot: unknown }>;
  assistant?: AcceptedAssistantRun;
  chatAssistant?: AcceptedChatAssistant;
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

export type DeferredRunMemorySource = Readonly<{
    activeLeafMessageId: string | null;
    memoryBranchGeneration: number;
    memorySourceRevision: number;
    preSendActiveLeafMessageId: string | null;
}>;

export type PreparingRunAdmissionResult = Readonly<{
  deferredPdf?: true;
  deferredWorkspace?: true;
  pdfMemorySource?: DeferredRunMemorySource;
  workspaceMemorySource?: DeferredRunMemorySource;
  assistantMessageId: string;
  attemptId: string;
  chatMemoryMode: "NORMAL" | "EXCLUDED" | "TEMPORARY";
  folderId: string | null;
  memoryGeneration: number;
  memoryCommandQueued?: boolean;
  memoryRevision: number;
  runId: string;
  /** The run answers a scheduled task's prompt, as its user message read in the
   * admitting transaction says: it never changes Personal Memory. Without the
   * standing read its admission froze it was made dispatchable without Memory;
   * with it, its Memory attempt reads in whatever mode the chat has. */
  scheduledPrompt?: true;
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
  deferredWorkspace?: true;
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
  /** The chat's Assistant binding (`Chat.assistantId`); personal chats run with it. */
  assistantId?: string | null;
  /** Raw `Chat.assistantOverrides`, decoded by admission. */
  assistantOverrides?: unknown;
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
  followups?: import("./runFollowups").RunFollowupOperations;
  hasPendingWorkspacePreparation?(runId: string): Promise<boolean>;
  continueWorkspacePreparedRun?(input: Readonly<{
    admission: PreparingRunAdmissionInput;
    claimToken: string;
    created: PreparingRunAdmissionResult;
  }>): Promise<CreatedRun>;
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
    /** Claim a single corrective request after a terminal no-tool response. */
    requiredToolCorrectionOfRound?: number;
    /** Claim the one tool-free synthesis round after round R's batch exceeded
     * the remaining call budget: only from R's provider round with terminal
     * usage and no persisted calls, with a `budget_exhausted` continuation.
     * The same continuation with `synthesisDispatched` then marks that claimed
     * round dispatched, before it has usage of its own. */
    finalSynthesisOfRound?: number;
    contextCompaction?: ContextCompactionCheckpoint;
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
    /** The clarification revision used by the provider that planned this call. */
    followupRevision?: number;
    /** The call needs its run initiator's approval: the claim consumes one
     * matching one-shot approval in its transaction, or settles the call as
     * an undispatched `mcp_approval_required` error with a pending request. */
    mcpApproval?: import("../mcp/writeApproval").McpApprovalRequest;
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
  completeRun(input: RunCompletionInput): Promise<boolean>;
  /** Publish verified text while the run still owns its Workspace cleanup. */
  publishRunAnswer?(input: RunCompletionInput): Promise<boolean>;
  /** Resume settlement from the publication checkpoint without provider I/O. */
  loadPublishedRunAnswer?(input: { runId: string; userId: string }): Promise<RunCompletionInput | null>;
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
  groundKnowledgeEvidenceAnswer?(input: Readonly<{
    followupRevision?: number;
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
    error: { code: string; imageFailure?: ImageFailureEvidence; message: string },
    options?: Readonly<{ recoveryTerminal?: boolean; workspaceClaimToken?: string }>
  ): Promise<boolean>;
  findOwnedChat(chatId: string, userId: string): Promise<RunOwnedChatRecord | null>;
  /** Chain inputs of a personal Assistant run: the user's Chat defaults and usable resources. */
  loadAssistantRowContext?(input: Readonly<{
    ids: AssistantRowResourceIds;
    userId: string;
  }>): Promise<AssistantRowContext | null>;
  /** Chain inputs of a Project chat's Assistant: the Project's defaults and resources only. */
  loadProjectAssistantRowContext?(input: Readonly<{ projectId: string }>): Promise<AssistantRowContext | null>;
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
    followups?: import("./runFollowups").RegenerationFollowups;
    artifactEdit?: unknown;
    artifactIntent?: unknown;
    assistantMessage: {
      id: string;
      modelId: string | null;
      provider: string | null;
    } | null;
    chat: {
      assistantId?: string | null;
      assistantOverrides?: unknown;
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
      /** The stored message is a scheduled task's prompt (`Message.scheduledTaskPrompt`). */
      scheduledTaskPrompt: boolean;
      /**
       * The prompt's task, found through the scheduled run that posted it in
       * this chat, still exists and has Memory on. Never on a branch copy,
       * which has no such run.
       */
      scheduledTaskMemory?: true;
    };
  } | null>;
  loadConversationContext(chatId: string, userId: string): Promise<ProviderConversationMessage[]>;
  /**
   * The branch path to the leaf as the model reads it: every answer review
   * session on it but `options.answerReviewSessionId` reads as its source
   * question followed by the group's latest version.
   */
  loadConversationContextForExpectedLeaf(
    chatId: string,
    userId: string,
    expectedActiveLeafMessageId: string | null,
    options?: ConversationContextOptions
  ): Promise<ProviderConversationMessage[] | null>;
  loadConversationContextForLeaf(
    chatId: string,
    userId: string,
    leafMessageId: string,
    options?: ConversationContextOptions
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
  loadWorkspaceFileFacts(input: import("../workspace/inboxFacts").WorkspaceInboxFactsInput): Promise<import("../workspace/inboxFacts").WorkspaceInboxFacts>;
  loadKnowledgeFullContextPassages?(
    sources: readonly KnowledgeRunAdmissionSource[]
  ): Promise<readonly KnowledgeFullContextPassage[] | null>;
  /** Purpose-bound recovery loader for a full-context manifest accepted into
   * the evidence session before any current Draft provider operation exists. */
  loadKnowledgeFullContextDispatchRecovery?(input: {
    knowledgeEvidencePackingVersion?: 2 | 3 | 4 | 5;
    maximumTokens: number;
    modelId: string;
    provider: string;
    runId: string;
    userId: string;
  }): Promise<KnowledgeFullContextDispatchRecovery | null>;
  loadEntitlements(userId: string): Promise<ResolvedEntitlements>;
  loadModelPricing(provider: string, modelId: string, providerModelId?: string): Promise<ModelTokenPricing | null>;
  /** A deployment's own class and stored token prices, which price system
   * attributions it reported no cost for; null when the model no longer exists. */
  loadProviderModelCostBasis(providerModelId: string): Promise<ProviderModelCostBasis | null>;
  interruptExpiredAgentRun?(input: { runId: string; userId: string; now: Date }): Promise<
    { kind: "not_agent" } | { kind: "active" } | { kind: "interrupted"; failureCode: import("../agents/failures").AgentFailureCode; usage: RunUsageAttribution[] }>;
  loadRunUsageAttributions(input: {
    runId: string;
    userId: string;
  }): Promise<PersistedRunUsageAttribution[]>;
  finalizePreparingRun(input: PreparingRunFinalizationInput): Promise<boolean>;
  loadCheckpointedToolLoopRun(input: {
    runId: string;
    userId: string;
  }): Promise<CheckpointedToolLoopRun | null>;
  /** The message ancestry of `leafMessageId` in one chat (oldest first, any
   * message status) and the decoded compaction checkpoints holding notes of the
   * user's settled runs whose answers are the newest on it; bounded.
   * Admission decides compatibility; this performs no other I/O. */
  loadBranchContextCheckpoints?(input: {
    chatId: string;
    leafMessageId: string;
    userId: string;
  }): Promise<BranchContextCheckpoints>;
  /** Cross-turn tool history frozen at admission: references and digests of
   * the eligible calls of the branch from `leafMessageId` (its turns and the
   * earlier attempts of each user message on it). No payload is read. */
  loadToolHistory?(input: {
    chatId: string;
    leafMessageId: string | null;
    userId: string;
  }): Promise<import("./toolHistoryContract").ToolHistorySnapshot>;
  /** One request's records of a frozen history under the reader's current
   * authority; see `createPrismaToolHistoryOperations`. */
  projectToolHistory?(input: {
    actor: import("./prismaRepositoryToolHistory").ToolHistoryActor;
    readers: import("./toolHistoryRecords").ToolHistoryReaders;
    toolHistory: import("./toolHistoryContract").ToolHistorySnapshot;
    cache?: import("./toolHistoryContract").ToolHistoryCache;
    /** The request's current user message: names the record of its earlier
     * attempts when the reader's context cannot be read. */
    currentUserMessageId?: string | null;
  }): Promise<import("./toolHistory").ToolHistoryProjection>;
  /**
   * Records the outcome a monitoring check's run reported on the scheduled
   * occurrence that admitted it, while that occurrence is running; repeatable,
   * the last report wins. False when the run has no running occurrence.
   */
  recordMonitoringVerdict?(input: Readonly<{
    runId: string;
    userId: string;
    verdict: import("../scheduledTasks/runnerPolicy").MonitoringVerdict;
  }>): Promise<boolean>;
  /**
   * Creates the scheduled task a run's `create_scheduled_task` call asked
   * for, as the owner's own create (`body` is validated exactly as
   * `POST /api/me/scheduled-tasks` validates it), and settles the call with
   * `result(task)` and appends that result's output events in the same
   * transaction. A recovered call therefore finds it settled or finds nothing
   * created; the call must be running, and the run active, unscheduled and
   * without another created task.
   */
  createScheduledTaskForCall?(input: Readonly<{
    body: unknown;
    /** The persisted `ModelRunToolCall` id. */
    callId: string;
    result(task: import("../../contracts/scheduledTasks").ScheduledTask): import("../tools/types").ToolExecutionResult;
    runId: string;
    /**
     * The creating run's frozen user-authored link digests
     * (`FetchUrlPlan.userUrlDigests`): the only links of the tool-written
     * prompt its scheduled runs may read.
     */
    userUrlDigests: readonly string[];
    userId: string;
  }>): Promise<ScheduledTaskCallCreation>;
  /**
   * Saves the Skill a run's `save_skill` call asked for through the shared
   * Skill revision write core (`commitSkillSaveInTransaction`) and, when it
   * saved, settles the call with `result(card, version)` and appends that
   * result's card in the same transaction. A recovered call therefore finds
   * it settled or finds nothing saved; the call must be running and the run
   * active, personal and unscheduled. Refusals write nothing and leave the
   * call for the caller to settle.
   */
  saveSkillForCall?(input: Readonly<{
    /** The persisted `ModelRunToolCall` id: the save's operation key. */
    callId: string;
    runId: string;
    userId: string;
    target: import("../skills/skillSave").SkillSaveTarget;
    /** Null exactly for a restore target. */
    bundle: import("../skills/bundle").SkillBundle | null;
    changeNote: string | null;
    result(card: import("../../contracts/skillSaves").SkillSaveCard, version: number): import("../tools/types").ToolExecutionResult;
  }>): Promise<import("../tools/skillSave").SkillSaveCommitOutcome>;
  /**
   * `fetch_url` provenance: the source and citation URLs the run's own Search
   * persisted so far (its Search executions and its hosted Search output
   * events), unnormalized, bounded. Another run's Search never counts.
   */
  loadRunSearchSourceUrls?(input: Readonly<{ runId: string; userId: string }>): Promise<readonly string[]>;
  /**
   * Every persisted `fetch_url` call of the run, in round and call order, so a
   * recovered run keeps its page cap and cache. No bound below the run's
   * accepted tool-call budget: a hidden sent call could be sent again.
   */
  loadRunFetchUrlCalls?(input: Readonly<{ runId: string; userId: string }>): Promise<readonly Readonly<{
    id: string; result: unknown; state: string;
  }>[]>;
  /**
   * Which of these messages of the chat are scheduled task prompts
   * (`Message.scheduledTaskPrompt`): their text authorizes no `fetch_url` link.
   */
  loadScheduledPromptMessageIds?(input: Readonly<{
    chatId: string; messageIds: readonly string[]; userId: string;
  }>): Promise<ReadonlySet<string>>;
  /**
   * Which of these messages of the chat are turns the server wrote for the
   * user (`Message.systemTurnKind`): their text authorizes no `fetch_url` link.
   */
  loadSystemTurnMessageIds?(input: Readonly<{
    chatId: string; messageIds: readonly string[]; userId: string;
  }>): Promise<ReadonlySet<string>>;
  /** The servers among `serverIds` the user always allows (MCP write approval), read at admission. */
  loadMcpToolConsentServerIds?(input: Readonly<{ serverIds: readonly string[]; userId: string }>): Promise<readonly string[]>;
  /**
   * The approval a continuation turn names, while it may continue: the
   * user's own Allow in this chat within the approval window; null otherwise.
   */
  loadMcpApprovalContinuation?(input: Readonly<{ approvalId: string; chatId: string; userId: string }>): Promise<Readonly<{
    serverName: string; toolName: string;
  }> | null>;
  /** The approval cards of a run, as its initiator's live stream shows them. */
  loadRunMcpApprovalCards?(input: Readonly<{ runId: string; userId: string }>): Promise<
    readonly import("../../contracts/mcpApprovals").McpApprovalCard[]>;
  /**
   * Whether the owner has a saved scheduled task a chat answer may manage
   * (null: none), and the task whose own chat `chatId` is: the one that posts
   * into it now, else the one whose newest run posted into it.
   */
  loadScheduledTaskManagement?(input: Readonly<{ chatId: string; userId: string }>): Promise<Readonly<{
    chatTask: Readonly<{ taskId: string; title: string }> | null;
  }> | null>;
  /**
   * Performs a run's `manage_scheduled_task` call as the owner and settles it
   * with `result(outcome)` in the same transaction as any change and the
   * output events of that result (the task's card), as a creation does. A
   * change goes through the owner's edit rules against the task's current
   * revision, read by the server: `change` maps the task as it is now to the
   * owner API's update body (without `expectedRevision`), or to why the
   * arguments do not fit it. A task already as asked settles unchanged,
   * without a card. One answer changes or proposes deleting at most five
   * distinct tasks.
   */
  manageScheduledTaskForCall?(input: Readonly<{
    action: ScheduledTaskManagementAction;
    /** The persisted `ModelRunToolCall` id. */
    callId: string;
    change?(current: import("../../contracts/scheduledTasks").ScheduledTask): Readonly<Record<string, unknown>> | string;
    result(outcome: ScheduledTaskManagementOutcome): import("../tools/types").ToolExecutionResult;
    runId: string;
    /** Null only for `list`. */
    taskId: string | null;
    /**
     * The run's frozen user-authored link digests
     * (`scheduledTaskManagementTool.userUrlDigests`): with the task's stored
     * snapshot, the only links a changed prompt keeps for its scheduled runs.
     */
    userUrlDigests: readonly string[];
    userId: string;
  }>): Promise<ScheduledTaskCallManagement>;
  /** The authorized record `read_tool_call` returns, or null when unavailable. */
  readToolCall?(
    actor: Readonly<{ runId: string; userId: string }>,
    ref: string
  ): Promise<import("./toolHistoryRecords").ToolHistoryRecord | null>;
  /** Whether every referenced call is still readable by this run. */
  toolCallsAvailable?(actor: Readonly<{ runId: string; userId: string }>, refs: readonly string[]): Promise<boolean>;
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
  /** Rewrites the run's cumulative usage events. Answer-round usage and a
   * context-summary receipt reach the checkpoint in the same transaction, so a
   * settled paid call and its usage become durable together. A receipt claim,
   * and its `dispatched` mark written immediately before the provider request,
   * additionally require an active run in the round being prepared. */
  recordRunUsageEvents(input: {
    answerRoundUsage?: PersistedAnswerRoundUsage;
    chatId: string;
    contextSummaryReceipt?: ContextSummaryReceiptWrite;
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
    workspaceClaimToken?: string;
    retryable?: boolean;
    attemptId?: string;
    errorCode: string;
    message: string;
    runId: string;
    state: "CANCELLED" | "EXPIRED" | "FAILED" | "STALE";
    userId: string;
  }>): Promise<boolean>;
  settleRecoveredRunError(input: {
    error: { code: string; imageFailure?: ImageFailureEvidence; message: string };
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
