import type {
  ChatUsageStats,
  ThreadArtifactSummary,
  ThreadAssistantIdentity,
  ThreadRunUsage
} from "../../contracts/chats";
import type { CatalogAdapterKind } from "../../domain/catalog";
import type { ModelRunResponseProjection, ModelRunStatus } from "../../contracts/runs";
import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import type { ModelTokenPricing } from "../../domain/usage";
import type { ResolvedEntitlements } from "../auth/entitlements";
import type { McpRunPlanBinding } from "../mcp/runPlan";
import type { KnowledgeRunAdmissionPlan } from "../knowledge/runAdmission";
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
  PersistToolLoopCallBatchInput,
  PersistToolLoopCallBatchResult,
  SettleToolLoopCallResult,
  ToolLoopJsonValue
} from "./toolLoopPersistence";
import type {
  NormalizedRunRequest,
  ProviderAttachment,
  ProviderConversationMessage,
  ProviderModelCapabilities
} from "../providers/types";
import type { ProviderReasoningRequestMapping } from "../../contracts/providerReasoningRequestMapping";

export type RunAttachmentRecord = ProviderAttachment & {
  storageKey: string;
};

export type RunModelConfiguration = {
  adapterKind?: CatalogAdapterKind;
  capabilities: ProviderModelCapabilities;
  defaultParams: Record<string, unknown>;
  reasoningRequestMapping?: ProviderReasoningRequestMapping;
};

export type RunSearchStrategyConfiguration = {
  adapterKind?: SearchAdapterKind;
  config: Record<string, unknown>;
  credentialMode?: SearchCredentialMode;
  displayName?: string;
  executionModes?: SearchPlanMode[];
  kind: string;
  modelId: string | null;
  protocol?: SearchProtocol;
  provider: string;
  providerModelId?: string | null;
  revisionId?: string;
  searchStrategyRowId?: string;
  strategyId: string;
};

export type RunControlRecord = {
  assistantMessageId: string | null;
  chatId: string;
  id: string;
  modelId: string;
  provider: string;
  providerResponseId: string | null;
  recoverySettled?: boolean;
  status: string;
};

export type DurableRunControlRecord = Omit<RunControlRecord, "status"> & {
  status: ModelRunStatus;
};

export type StaleRunControlRecord = RunControlRecord & {
  updatedAt: Date | string;
};

export type InstallationRecoverableRunRecord = StaleRunControlRecord & {
  userId: string;
};

export type RunChatUpdateRecord = {
  chat: {
    activeLeafMessageId: string | null;
    createdAt: Date | string;
    defaultModelId: string | null;
    defaultProvider: string | null;
    folderId: string | null;
    id: string;
    messageCount: number;
    pinned: boolean;
    title: string;
    updatedAt: Date | string;
    usageStats?: ChatUsageStats | null;
  };
  messages: {
    artifactSummary?: ThreadArtifactSummary | null;
    assistantIdentity?: ThreadAssistantIdentity | null;
    content: unknown;
    createdAt: Date | string;
    errorMessage?: string | null;
    id: string;
    modelId: string | null;
    modelRunId?: string | null;
    parentMessageId: string | null;
    provider: string | null;
    role: string;
    runUsage?: ThreadRunUsage | null;
    status: string;
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

/** Exact accepted Assistant provenance persisted with the run. */
export type AcceptedAssistantRun = {
  assistantId: string;
  revisionId: string;
};

export type AcceptedRunDefaults = {
  controlDefaults: Record<string, boolean | string>;
  modelId: string;
  provider: string;
  searchStrategy: string | null;
  searchPlan?: SearchPlan;
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

export type RunRepository = {
  advanceToolLoopCallBatch(input: {
    roundIndex: number;
    runId: string;
    userId: string;
  }): Promise<AdvanceToolLoopCallBatchResult>;
  appendAssistantText(
    assistantMessageId: string,
    text: string,
    options?: Readonly<{ allowErrored?: boolean }>
  ): Promise<void>;
  appendRunEvent(runId: string, sequence: number, event: ModelRunSseEvent): Promise<void>;
  beginToolLoopProviderRound(input: {
    providerContinuation: ToolLoopJsonValue | null;
    providerCursor?: number | string | null;
    roundIndex: number;
    runId: string;
    userId: string;
  }): Promise<BeginToolLoopProviderRoundResult>;
  cancelPendingToolLoopCalls(input: { runId: string; userId: string }): Promise<number>;
  claimToolLoopCall(input: {
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
  completeRun(input: {
    assistantMessageId: string;
    chatId: string;
    estimatedCostMicros: number | null;
    finalProviderResponsePreview: Record<string, unknown>;
    finalText: string;
    modelId: string;
    provider: string;
    providerResponseId?: string;
    runId: string;
    eventsBeforeTerminal?: ModelRunSseEvent[];
    usage: ModelRunUsage;
    usageAttributions?: RunUsageAttribution[];
    userId: string;
  }): Promise<boolean>;
  createRun(input: {
    assistant?: AcceptedAssistantRun;
    chatId: string;
    content: { blocks: unknown[] };
    defaults?: AcceptedRunDefaults;
    expectedActiveLeafId: string | null;
    knowledgeAdmissionPlan?: KnowledgeRunAdmissionPlan;
    mcpBindings?: McpRunPlanBinding[];
    modelId: string;
    normalizedRequest: NormalizedRunRequest;
    providerAdmissionPlan?: ProviderAdmissionPlan;
    provider: string;
    providerRequestPreview: Record<string, unknown>;
    userId: string;
  }): Promise<{
    assistantMessageId: string;
    runId: string;
    userMessageId: string;
  }>;
  createRegenerationRun(input: {
    assistant?: AcceptedAssistantRun;
    chatId: string;
    defaults?: AcceptedRunDefaults;
    knowledgeAdmissionPlan?: KnowledgeRunAdmissionPlan;
    mcpBindings?: McpRunPlanBinding[];
    modelId: string;
    normalizedRequest: NormalizedRunRequest;
    providerAdmissionPlan?: ProviderAdmissionPlan;
    provider: string;
    providerRequestPreview: Record<string, unknown>;
    userId: string;
    userMessageId: string;
  }): Promise<{
    assistantMessageId: string;
    runId: string;
    userMessageId: string;
  }>;
  createSearchRun(input: {
    artifacts: unknown;
    durationMs?: number;
    invocationId?: string;
    modelId: string | null;
    modelRunId: string;
    provider: string;
    query?: string;
    requestPreview: Record<string, unknown>;
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
  findOwnedChat(chatId: string, userId: string): Promise<{
    activeLeafMessageId: string | null;
    defaultKnowledgePlan?: unknown;
    defaultModelId: string;
    defaultProvider: string;
    folderDefaultKnowledgePlan?: unknown;
    id: string;
    messageCount: number;
    projectMemory: string | null;
    title: string;
  } | null>;
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
      projectMemory: string | null;
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
  getRunForUser(runId: string, userId: string): Promise<ModelRunResponseProjection | null>;
  getChatUpdateForRun(input: {
    assistantMessageId: string;
    chatId: string;
    userId: string;
    userMessageId: string;
  }): Promise<RunChatUpdateRecord | null>;
  isSearchStrategyEnabled(searchStrategyId: string): Promise<boolean>;
  loadSearchStrategyConfiguration(
    searchStrategyId: string
  ): Promise<RunSearchStrategyConfiguration | null>;
  loadAttachments(userId: string, attachmentIds: string[]): Promise<RunAttachmentRecord[]>;
  loadEntitlements(userId: string): Promise<ResolvedEntitlements>;
  loadModelConfiguration(provider: string, modelId: string): Promise<RunModelConfiguration | null>;
  loadModelPricing(provider: string, modelId: string): Promise<ModelTokenPricing | null>;
  loadRunUsageAttributions(input: {
    runId: string;
    userId: string;
  }): Promise<PersistedRunUsageAttribution[]>;
  loadCheckpointedToolLoopRun(input: {
    runId: string;
    userId: string;
  }): Promise<CheckpointedToolLoopRun | null>;
  markAssistantMessageGroundedLiveOnly(input: {
    assistantMessageId: string;
    groundedAt: Date;
    provider: string;
    runId: string;
    strategy: string;
  }): Promise<boolean>;
  nextRunEventSequence(runId: string): Promise<number>;
  persistToolLoopCallBatch(input: PersistToolLoopCallBatchInput): Promise<PersistToolLoopCallBatchResult>;
  recordRunUsageEvents(input: {
    chatId: string;
    runId: string;
    usageAttributions: RunUsageAttribution[];
    userId: string;
  }): Promise<boolean>;
  settleRecoveredRunError(input: {
    error: { code: string; message: string };
    events: ModelRunSseEvent[];
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
  /**
   * A true result atomically persists `message_reset` at `sequence`; only then
   * may the caller advance its existing in-memory sequence owner.
   */
  resetToolLoopAssistantDraft(input: {
    roundIndex: number;
    runId: string;
    sequence: number;
    userId: string;
  }): Promise<boolean>;
  updateRunProviderResponseId(
    runId: string,
    providerResponseId: string
  ): Promise<ProviderResponseIdPublication>;
  updateRunProviderRequestPreview(runId: string, providerRequestPreview: Record<string, unknown>): Promise<void>;
  updateCancelledRunProviderPreview(input: {
    providerCancelPreview: Record<string, unknown>;
    runId: string;
    userId: string;
  }): Promise<boolean>;
};
