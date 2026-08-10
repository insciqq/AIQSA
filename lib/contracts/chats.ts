import type {
  ErrorResponse,
  MutationOriginErrorCode,
  SessionErrorCode
} from "./http";
import {
  decodeAssistantAvatarRecipe,
  type AssistantAvatarRecipe
} from "./assistants";
import {
  decodeThreadSearchProviderOperation,
  decodeThreadSearchSource,
  decodeThreadToolActivity,
  threadSearchProviderOperationTraceWithinLimit,
  type ThreadSearchExecution,
  type ThreadSearchProviderOperation,
  type ThreadSearchSource,
  type ThreadToolActivity,
  type ThreadToolActivityStatus
} from "./toolActivity";
import { decodeKnowledgePlan, type KnowledgePlan } from "./knowledge";
import {
  MEMORY_TEMPORARY_RETENTION_POLICY_VERSION,
  decodeMemoryActionFeedback,
  decodeMemoryReceipt,
  type MemoryActionFeedback,
  type MemoryChatMode,
  type MemoryReceipt
} from "./memory";

export const CHAT_HISTORY_PAGE_SIZE = 50;
export const CHAT_HISTORY_CURSOR_MAX_LENGTH = 2_048;
export const CHAT_BRANCH_PREVIEW_MAX_LENGTH = 160;
export const ARCHIVED_CHAT_PAGE_SIZE = 20;
export const ARCHIVED_CHAT_CURSOR_MAX_LENGTH = 2_048;

export function boundedChatBranchPreview(value: string): string {
  if (value.length <= CHAT_BRANCH_PREVIEW_MAX_LENGTH) return value;
  let end = CHAT_BRANCH_PREVIEW_MAX_LENGTH;
  const finalCodeUnit = value.charCodeAt(end - 1);
  const nextCodeUnit = value.charCodeAt(end);
  if (
    finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff
  ) {
    end -= 1;
  }
  return value.slice(0, end);
}

export type {
  ThreadSearchExecution,
  ThreadSearchProviderOperation,
  ThreadSearchSource,
  ThreadToolActivity,
  ThreadToolActivityStatus
};

export type ThreadMessage = {
  artifactSummary?: ThreadArtifactSummary | null;
  assistantIdentity?: ThreadAssistantIdentity | null;
  content: unknown;
  id: string;
  modelId?: string;
  parentMessageId: string | null;
  provider?: string;
  role: "assistant" | "user";
  runId?: string | null;
  runUsage?: ThreadRunUsage | null;
  status: "cancelled" | "complete" | "error" | "streaming";
};

export type ThreadRunUsage = {
  totalTokens: number;
};

/**
 * Snapshot-bound Assistant identity from the accepted revision. Later renames,
 * archives, or access changes never alter this historical projection.
 */
export type ThreadAssistantIdentity = {
  avatar: AssistantAvatarRecipe;
  name: string;
  revisionNumber: number;
};

export type ThreadArtifactSummary = {
  citationCount: number;
  citations: ThreadCitation[];
  contextTruncation?: {
    approxDroppedTokens: number;
    droppedMessages: number;
  } | null;
  groundingDisplay?: ThreadGroundingDisplay | null;
  knowledgeCitations?: ThreadKnowledgeCitation[];
  knowledgeInvocationCount?: number;
  knowledgeOutcomes?: ThreadKnowledgeOutcome[];
  memoryAction?: MemoryActionFeedback;
  memoryReceipt?: MemoryReceipt;
  reasoningCount: number;
  reasoningText: string[];
  searchActivity?: ThreadSearchActivity[];
  searchCount: number;
  searchDisplayName?: string | null;
  searchStrategy: string | null;
  toolCallCount: number;
  toolCalls: ThreadToolActivity[];
};

export type ThreadKnowledgeCitation = {
  baseName: string;
  documentVersionNumber: number | null;
  fileName: string;
  handle: string;
  knowledgeBaseId: string;
  page: number;
};

export type ThreadKnowledgeOutcome = {
  invocationOrdinal: number;
  outcome:
    | "base_empty"
    | "base_indexing"
    | "complete"
    | "embedding_model_unavailable"
    | "zero_above_threshold";
};

export type ThreadSearchActivityStatus =
  | "cancelled"
  | "complete"
  | "error"
  | "partial"
  | "running"
  | "unknown";

export type ThreadSearchOperation = Omit<ThreadSearchProviderOperation, "id">;

export type ThreadSearchActivity = {
  displayName: string;
  failureReason?: string | null;
  providerOperations: ThreadSearchOperation[] | null;
  providerOperationsTruncated: boolean;
  query: string | null;
  sourceCount: number | null;
  sources: ThreadSearchSource[];
  status: ThreadSearchActivityStatus;
};

export type ThreadGroundingDisplay = {
  callCount: number;
  provider: "gemini";
  queryCount: number;
  suggestionsHtml: string;
};

export type ThreadCitation = {
  index: number;
  snippet?: string;
  source?: string;
  title: string;
  url: string;
};

export type WorkspaceChatSummary = {
  activeLeafMessageId: string | null;
  createdAt: string;
  defaultModelId: string;
  defaultKnowledgePlan?: KnowledgePlan | null;
  defaultProvider: string;
  folderId: string | null;
  id: string;
  messageCount: number;
  /** Client-owned lifecycle metadata loaded from the private Memory state route. */
  memoryMode?: MemoryChatMode;
  memorySourceRevision?: number;
  pendingInitialMemoryMode?: "TEMPORARY";
  pinned?: boolean;
  temporaryRetentionDeadline?: string | null;
  title: string;
  updatedAt: string;
};

export type ChatUsageStats = {
  activeBranchMessageCount: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  totalTokens: number;
};

export type ChatContextStats = {
  approximateActiveBranchInputTokens: number;
};

export type ChatMessagePageInfo = {
  activeLeafMessageId: string | null;
  beforeCursor: string | null;
  hasOlder: boolean;
  snapshotUpdatedAt: string;
};

export type ChatDetail = WorkspaceChatSummary & {
  contextStats: ChatContextStats;
  messages: ThreadMessage[];
  pageInfo: ChatMessagePageInfo;
  usageStats: ChatUsageStats | null;
};

/** Prefer the explicit workspace name in new code; this alias is summary-only. */
export type ChatSummary = WorkspaceChatSummary;

export type ChatMessageWire = {
  artifactSummary?: ThreadArtifactSummary | null;
  assistantIdentity?: ThreadAssistantIdentity | null;
  content: unknown;
  createdAt: string;
  errorMessage: string | null;
  id: string;
  modelId: string | null;
  modelRunId: string | null;
  parentMessageId: string | null;
  provider: string | null;
  role: string;
  runUsage?: ThreadRunUsage | null;
  status: string;
};

export type WorkspaceChatSummaryWire = Omit<
  WorkspaceChatSummary,
  | "defaultModelId"
  | "defaultProvider"
  | "memoryMode"
  | "memorySourceRevision"
  | "pendingInitialMemoryMode"
  | "pinned"
  | "temporaryRetentionDeadline"
> & {
  defaultModelId: string | null;
  defaultProvider: string | null;
  pinned: boolean;
};

export type ChatDetailWire = WorkspaceChatSummaryWire & {
  contextStats: ChatContextStats;
  messages: ChatMessageWire[];
  pageInfo: ChatMessagePageInfo;
  usageStats: ChatUsageStats | null;
};

export type ChatSummaryResponseWire = {
  chat: WorkspaceChatSummaryWire;
};

export type ChatDetailResponseWire = {
  chat: ChatDetailWire;
};

export type ChatMessagesPageWire = {
  messages: ChatMessageWire[];
  pageInfo: ChatMessagePageInfo;
};

export type ChatBranchNodeWire = {
  id: string;
  parentMessageId: string | null;
  preview: string;
  role: "assistant" | "user";
  status: "cancelled" | "complete" | "error" | "queued" | "streaming";
};

export type ChatBranchGraphWire = {
  activeLeafMessageId: string | null;
  nodes: ChatBranchNodeWire[];
  snapshotUpdatedAt: string;
};

export type ChatBranchesResponseWire = {
  branchGraph: ChatBranchGraphWire;
};

export type RetainedChatMemoryMode = Exclude<MemoryChatMode, "TEMPORARY">;

export type ChatLifecycleRequestWire = {
  expectedChatRevision: number;
};

export type ChatLifecycleStateWire = {
  archived: boolean;
  id: string;
  memoryMode: RetainedChatMemoryMode;
  sourceRevision: number;
  updatedAt: string;
};

export type ChatLifecycleResponseWire = {
  chat: ChatLifecycleStateWire;
};

export type ChatMemoryStateWire = {
  archived: boolean;
  chatId: string;
  mode: MemoryChatMode;
  sourceRevision: number;
  temporaryRetentionDeadline: string | null;
  temporaryRetentionPolicyVersion: typeof MEMORY_TEMPORARY_RETENTION_POLICY_VERSION | null;
  updatedAt: string;
};

export type ChatMemoryStateResponseWire = {
  chat: ChatMemoryStateWire;
};

export type ArchivedChatSummaryWire = WorkspaceChatSummaryWire & {
  archived: true;
  memoryMode: RetainedChatMemoryMode;
  sourceRevision: number;
};

export type ArchivedChatsResponseWire = {
  chats: ArchivedChatSummaryWire[];
  nextCursor: string | null;
};

export type ArchivedChatDetailWire = ChatDetailWire & {
  archived: true;
  memoryMode: RetainedChatMemoryMode;
  sourceRevision: number;
};

export type ArchivedChatDetailResponseWire = {
  chat: ArchivedChatDetailWire;
};

export type ChatSourceResolutionWire = {
  chatId: string;
  location: "ACTIVE_CHAT" | "ARCHIVED_PREVIEW";
  memoryMode: RetainedChatMemoryMode;
  sourceRevision: number;
  updatedAt: string;
};

export type ChatSourceResolutionResponseWire = {
  source: ChatSourceResolutionWire;
};

export type CreateChatRequestWire = {
  folderId?: string | null;
  title?: string | null;
};

export type UpdateChatRequestWire = {
  activeLeafMessageId?: string | null;
  defaultKnowledgePlan?: KnowledgePlan | null;
  folderId?: string | null;
  pinned?: boolean;
  title?: string | null;
};

export type ChatRouteServerErrorCode =
  | SessionErrorCode
  | MutationOriginErrorCode
  | "active_run_in_progress"
  | "archived_chat_cursor_invalid"
  | "chat_page_cursor_invalid"
  | "chat_page_stale"
  | "chat_lifecycle_invalid"
  | "chat_not_created"
  | "chat_not_found"
  | "chat_revision_stale"
  | "knowledge_plan_invalid"
  | "workspace_not_found";

export type ChatRouteErrorResponse = ErrorResponse<ChatRouteServerErrorCode>;

export type ChatContentMatchWire = {
  chatId: string;
  snippet: string | null;
};

export type FolderWire = {
  defaultKnowledgePlan?: KnowledgePlan | null;
  id: string;
  name: string;
  parentId: string | null;
  projectMemory: string;
  sortOrder: number;
};

export type UpdateFolderRequestWire = {
  defaultKnowledgePlan?: KnowledgePlan | null;
  name?: string | null;
  parentId?: string | null;
  projectMemory?: string;
};

export type WorkspaceChatsResponseWire = {
  chats: WorkspaceChatSummaryWire[];
  contentMatches: ChatContentMatchWire[];
  folders: FolderWire[];
};

export type DecodedWorkspaceChatsResponse = {
  chats: WorkspaceChatSummaryWire[];
  contentMatches: ChatContentMatchWire[];
  folders: FolderWire[];
};

export type ChatUpdateDataWire = {
  chat: WorkspaceChatSummaryWire & {
    contextStats: ChatContextStats;
    usageStats: ChatUsageStats | null;
  };
  messages: ChatMessageWire[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function boundedRequiredString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= maxLength
    ? value.trim()
    : null;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === "string" ? value : undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableId(value: unknown): string | null | undefined {
  return value === null
    ? null
    : typeof value === "string" && value.length > 0
      ? value
      : undefined;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function decodeUsageStats(value: unknown): ChatUsageStats | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const activeBranchMessageCount = nonNegativeInteger(value.activeBranchMessageCount);
  const cachedInputTokens = nonNegativeInteger(value.cachedInputTokens);
  const cacheWriteInputTokens = nonNegativeInteger(value.cacheWriteInputTokens);
  const totalTokens = nonNegativeInteger(value.totalTokens);
  if (
    activeBranchMessageCount === null ||
    cachedInputTokens === null ||
    cacheWriteInputTokens === null ||
    totalTokens === null
  ) {
    return undefined;
  }

  return {
    activeBranchMessageCount,
    cachedInputTokens,
    cacheWriteInputTokens,
    totalTokens
  };
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.toISOString() !== value ? null : value;
}

function decodeContextStats(value: unknown): ChatContextStats | null {
  if (!isRecord(value) || !hasExactKeys(value, ["approximateActiveBranchInputTokens"])) {
    return null;
  }
  const approximateActiveBranchInputTokens = nonNegativeInteger(
    value.approximateActiveBranchInputTokens
  );
  return approximateActiveBranchInputTokens === null
    ? null
    : { approximateActiveBranchInputTokens };
}

function decodeMessagePageInfo(value: unknown): ChatMessagePageInfo | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "activeLeafMessageId",
      "beforeCursor",
      "hasOlder",
      "snapshotUpdatedAt"
    ])
  ) return null;
  const activeLeafMessageId = nullableId(value.activeLeafMessageId);
  const beforeCursor = nullableId(value.beforeCursor);
  const snapshotUpdatedAt = isoTimestamp(value.snapshotUpdatedAt);
  if (
    activeLeafMessageId === undefined ||
    beforeCursor === undefined ||
    (typeof beforeCursor === "string" && (
      beforeCursor.length > CHAT_HISTORY_CURSOR_MAX_LENGTH ||
      !/^[A-Za-z0-9_-]+$/u.test(beforeCursor)
    )) ||
    typeof value.hasOlder !== "boolean" ||
    !snapshotUpdatedAt ||
    value.hasOlder !== (beforeCursor !== null)
  ) {
    return null;
  }
  return {
    activeLeafMessageId,
    beforeCursor,
    hasOlder: value.hasOlder,
    snapshotUpdatedAt
  };
}

function decodeMessagePage(
  messagesValue: unknown,
  pageInfoValue: unknown,
  options: { requireActiveLeaf: boolean }
): { messages: ChatMessageWire[]; pageInfo: ChatMessagePageInfo } | null {
  if (!Array.isArray(messagesValue) || messagesValue.length > CHAT_HISTORY_PAGE_SIZE) {
    return null;
  }
  const pageInfo = decodeMessagePageInfo(pageInfoValue);
  const decodedMessages = messagesValue.map(decodeChatMessageWire);
  if (!pageInfo || decodedMessages.some((message) => message === null)) return null;
  const messages = decodedMessages.filter(
    (message): message is ChatMessageWire => message !== null
  );
  if (new Set(messages.map((message) => message.id)).size !== messages.length) return null;
  if (
    messages.some((message, index) =>
      index > 0 && message.parentMessageId !== messages[index - 1]?.id
    ) ||
    (messages.length === 0 && (pageInfo.activeLeafMessageId !== null || pageInfo.hasOlder)) ||
    (messages.length > 0 && pageInfo.activeLeafMessageId === null) ||
    (messages.length > 0 && pageInfo.hasOlder !== (messages[0]?.parentMessageId !== null))
  ) return null;
  if (
    options.requireActiveLeaf &&
    (messages.at(-1)?.id ?? null) !== pageInfo.activeLeafMessageId
  ) return null;
  return { messages, pageInfo };
}

function decodeThreadRunUsage(value: unknown): ThreadRunUsage | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const totalTokens = nonNegativeInteger(value.totalTokens);
  return totalTokens === null ? undefined : { totalTokens };
}

function validOptionalString(record: Record<string, unknown>, key: string): boolean {
  return !(key in record) || typeof record[key] === "string";
}

function decodeThreadCitation(value: unknown): ThreadCitation | null {
  if (!isRecord(value)) {
    return null;
  }

  const index = nonNegativeInteger(value.index);
  const title = requiredString(value.title);
  const url = requiredString(value.url);
  if (
    index === null ||
    !title ||
    !url ||
    !validOptionalString(value, "snippet") ||
    !validOptionalString(value, "source")
  ) {
    return null;
  }

  return {
    index,
    ...(typeof value.snippet === "string" ? { snippet: value.snippet } : {}),
    ...(typeof value.source === "string" ? { source: value.source } : {}),
    title,
    url
  };
}

function decodeThreadSearchActivityStatus(value: unknown): ThreadSearchActivityStatus | null {
  return value === "cancelled" ||
    value === "complete" ||
    value === "error" ||
    value === "partial" ||
    value === "running" ||
    value === "unknown"
    ? value
    : null;
}

function decodeThreadSearchOperation(value: unknown): ThreadSearchOperation | null {
  if (!isRecord(value)) return null;
  const decoded = decodeThreadSearchProviderOperation({ ...value, id: null });
  if (!decoded) return null;
  const { id: _id, ...operation } = decoded;
  return operation;
}

function decodeThreadSearchActivity(value: unknown): ThreadSearchActivity | null {
  if (!isRecord(value)) return null;
  const displayName = boundedRequiredString(value.displayName, 256);
  let failureReason: string | null | undefined;
  if (value.failureReason === undefined || value.failureReason === null) {
    failureReason = value.failureReason;
  } else {
    failureReason = boundedRequiredString(value.failureReason, 256) ?? undefined;
  }
  const query = value.query === null ? null : boundedRequiredString(value.query, 2_000);
  const sourceCount = value.sourceCount === null ? null : nonNegativeInteger(value.sourceCount);
  const status = decodeThreadSearchActivityStatus(value.status);
  if (
    !displayName ||
    (value.failureReason !== undefined && failureReason === undefined) ||
    (query === null && value.query !== null) ||
    (sourceCount === null && value.sourceCount !== null) ||
    (sourceCount !== null && sourceCount > 100) ||
    !status ||
    (typeof failureReason === "string" && status !== "error" && status !== "partial") ||
    typeof value.providerOperationsTruncated !== "boolean" ||
    !Array.isArray(value.sources) ||
    value.sources.length > 20
  ) {
    return null;
  }

  const sources = value.sources.map(decodeThreadSearchSource);
  if (
    sources.some((source) => source === null) ||
    (sourceCount !== null && sources.length > sourceCount)
  ) {
    return null;
  }

  let providerOperations: ThreadSearchOperation[] | null;
  if (value.providerOperations === null) {
    providerOperations = null;
  } else if (Array.isArray(value.providerOperations) && value.providerOperations.length <= 32) {
    const decodedOperations = value.providerOperations.map(decodeThreadSearchOperation);
    if (decodedOperations.some((operation) => operation === null)) return null;
    providerOperations = decodedOperations.filter(
      (operation): operation is ThreadSearchOperation => operation !== null
    );
    if (!threadSearchProviderOperationTraceWithinLimit(providerOperations)) return null;
  } else {
    return null;
  }

  return {
    displayName,
    ...(failureReason !== undefined ? { failureReason } : {}),
    providerOperations,
    providerOperationsTruncated: value.providerOperationsTruncated,
    query,
    sourceCount,
    sources: sources.filter((source): source is ThreadSearchSource => source !== null),
    status
  };
}

function decodeThreadArtifactSummary(value: unknown): ThreadArtifactSummary | null {
  if (!isRecord(value)) {
    return null;
  }

  const citationCount = nonNegativeInteger(value.citationCount);
  const reasoningCount = nonNegativeInteger(value.reasoningCount);
  const searchCount = nonNegativeInteger(value.searchCount);
  const toolCallCount = nonNegativeInteger(value.toolCallCount);
  const hasKnowledgeProjection = value.knowledgeInvocationCount !== undefined ||
    value.knowledgeCitations !== undefined || value.knowledgeOutcomes !== undefined;
  const hasCompleteKnowledgeProjection = !hasKnowledgeProjection || (
    value.knowledgeInvocationCount !== undefined &&
    value.knowledgeCitations !== undefined &&
    value.knowledgeOutcomes !== undefined
  );
  const knowledgeInvocationCount = value.knowledgeInvocationCount === undefined
    ? 0
    : nonNegativeInteger(value.knowledgeInvocationCount);
  const searchDisplayName = value.searchDisplayName === undefined
    ? undefined
    : nullableString(value.searchDisplayName);
  const searchStrategy = nullableId(value.searchStrategy);
  if (
    citationCount === null ||
    reasoningCount === null ||
    searchCount === null ||
    toolCallCount === null || !hasCompleteKnowledgeProjection ||
    knowledgeInvocationCount === null || knowledgeInvocationCount > 3 ||
    (value.searchDisplayName !== undefined && searchDisplayName === undefined) ||
    searchStrategy === undefined ||
    !Array.isArray(value.citations) ||
    !Array.isArray(value.reasoningText) ||
    !Array.isArray(value.toolCalls) ||
    value.reasoningText.some((text) => typeof text !== "string")
  ) {
    return null;
  }

  const citations = value.citations.map(decodeThreadCitation);
  if (citations.some((citation) => citation === null)) {
    return null;
  }

  const toolCalls = value.toolCalls.map(decodeThreadToolActivity);
  if (toolCalls.some((toolCall) => toolCall === null) || toolCalls.length !== toolCallCount) {
    return null;
  }

  const knowledgeCitationsInput = value.knowledgeCitations ?? [];
  const knowledgeOutcomesInput = value.knowledgeOutcomes ?? [];
  if (
    !Array.isArray(knowledgeCitationsInput) || knowledgeCitationsInput.length > 24 ||
    !Array.isArray(knowledgeOutcomesInput) || knowledgeOutcomesInput.length > 3
  ) return null;
  const knowledgeCitations = knowledgeCitationsInput.map(decodeThreadKnowledgeCitation);
  const knowledgeOutcomes = knowledgeOutcomesInput.map(decodeThreadKnowledgeOutcome);
  if (
    knowledgeCitations.some((citation) => citation === null) ||
    knowledgeOutcomes.some((outcome) => outcome === null) ||
    knowledgeOutcomes.length !== knowledgeInvocationCount ||
    knowledgeOutcomes.some((outcome, index) => outcome?.invocationOrdinal !== index + 1)
  ) return null;
  const decodedKnowledgeCitations = knowledgeCitations.filter(
    (citation): citation is ThreadKnowledgeCitation => citation !== null
  );
  if (
    new Set(decodedKnowledgeCitations.map((citation) => citation.handle)).size !==
      decodedKnowledgeCitations.length ||
    decodedKnowledgeCitations.some((citation) => Number(citation.handle[1]) > knowledgeInvocationCount)
  ) return null;

  let contextTruncation: ThreadArtifactSummary["contextTruncation"];
  if (value.contextTruncation === null || value.contextTruncation === undefined) {
    contextTruncation = value.contextTruncation;
  } else if (isRecord(value.contextTruncation)) {
    const approxDroppedTokens = nonNegativeInteger(value.contextTruncation.approxDroppedTokens);
    const droppedMessages = nonNegativeInteger(value.contextTruncation.droppedMessages);
    if (approxDroppedTokens === null || droppedMessages === null) {
      return null;
    }
    contextTruncation = { approxDroppedTokens, droppedMessages };
  } else {
    return null;
  }

  let searchActivity: ThreadSearchActivity[] | undefined;
  if (value.searchActivity !== undefined) {
    if (!Array.isArray(value.searchActivity) || value.searchActivity.length > 12) {
      return null;
    }
    const decodedSearchActivity = value.searchActivity.map(decodeThreadSearchActivity);
    if (decodedSearchActivity.some((activity) => activity === null)) {
      return null;
    }
    searchActivity = decodedSearchActivity.filter(
      (activity): activity is ThreadSearchActivity => activity !== null
    );
  }

  let memoryAction: MemoryActionFeedback | undefined;
  if (value.memoryAction !== undefined) {
    const decoded = decodeMemoryActionFeedback(value.memoryAction);
    if (!decoded.ok) return null;
    memoryAction = decoded.value;
  }
  let memoryReceipt: MemoryReceipt | undefined;
  if (value.memoryReceipt !== undefined) {
    const decoded = decodeMemoryReceipt(value.memoryReceipt);
    if (!decoded.ok) return null;
    memoryReceipt = decoded.value;
  }

  return {
    citationCount,
    citations: citations.filter((citation): citation is ThreadCitation => citation !== null),
    ...(contextTruncation !== undefined ? { contextTruncation } : {}),
    ...(hasKnowledgeProjection ? {
      knowledgeCitations: decodedKnowledgeCitations,
      knowledgeInvocationCount,
      knowledgeOutcomes: knowledgeOutcomes.filter(
        (outcome): outcome is ThreadKnowledgeOutcome => outcome !== null
      )
    } : {}),
    ...(memoryAction ? { memoryAction } : {}),
    ...(memoryReceipt ? { memoryReceipt } : {}),
    reasoningCount,
    reasoningText: value.reasoningText as string[],
    ...(searchActivity !== undefined ? { searchActivity } : {}),
    searchCount,
    ...(searchDisplayName !== undefined ? { searchDisplayName } : {}),
    searchStrategy,
    toolCallCount,
    toolCalls: toolCalls.filter((toolCall): toolCall is ThreadToolActivity => toolCall !== null)
  };
}

function decodeThreadKnowledgeCitation(value: unknown): ThreadKnowledgeCitation | null {
  if (!isRecord(value)) return null;
  const baseName = requiredString(value.baseName);
  const fileName = requiredString(value.fileName);
  const handle = requiredString(value.handle);
  const knowledgeBaseId = requiredString(value.knowledgeBaseId);
  const page = nonNegativeInteger(value.page);
  const documentVersionNumber = value.documentVersionNumber === null
    ? null
    : nonNegativeInteger(value.documentVersionNumber);
  if (
    !baseName || !fileName || !handle || !/^K[1-3]\.[1-8]$/u.test(handle) ||
    !knowledgeBaseId || page === null || page < 1 ||
    (documentVersionNumber !== null && documentVersionNumber < 1)
  ) return null;
  return {
    baseName,
    documentVersionNumber,
    fileName,
    handle,
    knowledgeBaseId,
    page
  };
}

function decodeThreadKnowledgeOutcome(value: unknown): ThreadKnowledgeOutcome | null {
  if (!isRecord(value)) return null;
  const invocationOrdinal = nonNegativeInteger(value.invocationOrdinal);
  const outcome = value.outcome === "base_empty" || value.outcome === "base_indexing" ||
    value.outcome === "complete" || value.outcome === "embedding_model_unavailable" ||
    value.outcome === "zero_above_threshold"
    ? value.outcome
    : null;
  return invocationOrdinal !== null && invocationOrdinal >= 1 && invocationOrdinal <= 3 && outcome
    ? { invocationOrdinal, outcome }
    : null;
}

function decodeThreadAssistantIdentity(value: unknown): ThreadAssistantIdentity | null {
  if (!isRecord(value)) {
    return null;
  }
  const avatar = decodeAssistantAvatarRecipe(value.avatar);
  const name = requiredString(value.name);
  if (
    !avatar ||
    !name ||
    typeof value.revisionNumber !== "number" ||
    !Number.isInteger(value.revisionNumber) ||
    value.revisionNumber < 1
  ) {
    return null;
  }
  return {
    avatar,
    name,
    revisionNumber: value.revisionNumber
  };
}

function decodeChatMessageWire(value: unknown): ChatMessageWire | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = requiredString(value.id);
  const createdAt = requiredString(value.createdAt);
  const errorMessage = nullableString(value.errorMessage);
  const modelId = nullableString(value.modelId);
  const modelRunId = nullableString(value.modelRunId);
  const parentMessageId = nullableId(value.parentMessageId);
  const provider = nullableString(value.provider);
  const runUsage = decodeThreadRunUsage(value.runUsage);
  const role = value.role === "assistant" || value.role === "user" ? value.role : null;
  const status =
    value.status === "queued" ||
    value.status === "streaming" ||
    value.status === "complete" ||
    value.status === "cancelled" ||
    value.status === "error"
      ? value.status
      : null;
  let artifactSummary: ThreadArtifactSummary | null | undefined;
  if (value.artifactSummary === undefined || value.artifactSummary === null) {
    artifactSummary = value.artifactSummary;
  } else {
    artifactSummary = decodeThreadArtifactSummary(value.artifactSummary);
    if (!artifactSummary) {
      return null;
    }
  }
  let assistantIdentity: ThreadAssistantIdentity | null | undefined;
  if (value.assistantIdentity === undefined || value.assistantIdentity === null) {
    assistantIdentity = value.assistantIdentity;
  } else {
    assistantIdentity = decodeThreadAssistantIdentity(value.assistantIdentity);
    if (!assistantIdentity) {
      return null;
    }
  }
  if (
    !id ||
    !createdAt ||
    errorMessage === undefined ||
    modelId === undefined ||
    modelRunId === undefined ||
    parentMessageId === undefined ||
    provider === undefined ||
    ("runUsage" in value && runUsage === undefined) ||
    !role ||
    !status ||
    !("content" in value)
  ) {
    return null;
  }

  return {
    artifactSummary,
    ...(assistantIdentity !== undefined ? { assistantIdentity } : {}),
    content: value.content,
    createdAt,
    errorMessage,
    id,
    modelId,
    modelRunId,
    parentMessageId,
    provider,
    role,
    ...(runUsage !== undefined ? { runUsage } : {}),
    status
  };
}

function decodeChatDefaultSelection(
  modelValue: unknown,
  providerValue: unknown
): Pick<WorkspaceChatSummaryWire, "defaultModelId" | "defaultProvider"> | null {
  if (
    (modelValue === null && providerValue === null) ||
    (modelValue === "" && providerValue === "")
  ) {
    return {
      defaultModelId: null,
      defaultProvider: null
    };
  }

  const defaultModelId = requiredString(modelValue);
  const defaultProvider = requiredString(providerValue);
  return defaultModelId && defaultProvider
    ? {
        defaultModelId,
        defaultProvider
      }
    : null;
}

function decodeWorkspaceChatSummaryWire(value: unknown): WorkspaceChatSummaryWire | null {
  if (!isRecord(value)) {
    return null;
  }

  const activeLeafMessageId = nullableId(value.activeLeafMessageId);
  const id = requiredString(value.id);
  const createdAt = requiredString(value.createdAt);
  const defaultSelection = decodeChatDefaultSelection(
    value.defaultModelId,
    value.defaultProvider
  );
  const defaultKnowledgePlan = decodeKnowledgeDefault(value.defaultKnowledgePlan);
  const folderId = nullableId(value.folderId);
  const messageCount = nonNegativeInteger(value.messageCount);
  const title = requiredString(value.title);
  const updatedAt = requiredString(value.updatedAt);
  if (
    activeLeafMessageId === undefined ||
    !id ||
    !createdAt ||
    defaultKnowledgePlan === undefined ||
    !defaultSelection ||
    folderId === undefined ||
    messageCount === null ||
    typeof value.pinned !== "boolean" ||
    !title ||
    !updatedAt
  ) {
    return null;
  }

  return {
    activeLeafMessageId,
    createdAt,
    defaultKnowledgePlan,
    defaultModelId: defaultSelection.defaultModelId,
    defaultProvider: defaultSelection.defaultProvider,
    folderId,
    id,
    messageCount,
    pinned: value.pinned,
    title,
    updatedAt
  };
}

function decodeKnowledgeDefault(value: unknown): KnowledgePlan | null | undefined {
  if (value === undefined || value === null) return null;
  const decoded = decodeKnowledgePlan(value);
  return decoded.ok ? decoded.plan : undefined;
}

function decodeFolderWire(value: unknown): FolderWire | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = requiredString(value.id);
  const defaultKnowledgePlan = decodeKnowledgeDefault(value.defaultKnowledgePlan);
  const name = requiredString(value.name);
  const parentId = nullableId(value.parentId);
  const projectMemory = typeof value.projectMemory === "string" ? value.projectMemory : null;
  const sortOrder = finiteNumber(value.sortOrder);
  if (
    defaultKnowledgePlan === undefined ||
    !id ||
    !name ||
    parentId === undefined ||
    projectMemory === null ||
    sortOrder === null
  ) {
    return null;
  }

  return {
    defaultKnowledgePlan,
    id,
    name,
    parentId,
    projectMemory,
    sortOrder
  };
}

function decodeChatContentMatchWire(value: unknown): ChatContentMatchWire | null {
  if (!isRecord(value)) {
    return null;
  }

  const chatId = requiredString(value.chatId);
  const snippet = nullableString(value.snippet);
  if (!chatId || snippet === undefined) {
    return null;
  }

  return {
    chatId,
    snippet
  };
}

export function decodeWorkspaceChatsResponse(
  value: unknown
): DecodedWorkspaceChatsResponse | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.chats) ||
    !Array.isArray(value.contentMatches) ||
    !Array.isArray(value.folders)
  ) {
    return null;
  }

  const chats = value.chats.map(decodeWorkspaceChatSummaryWire);
  const folders = value.folders.map(decodeFolderWire);
  const contentMatches = value.contentMatches.map(decodeChatContentMatchWire);
  if (
    chats.some((chat) => !chat) ||
    folders.some((folder) => !folder) ||
    contentMatches.some((match) => !match)
  ) {
    return null;
  }

  return {
    chats: chats.filter((chat): chat is WorkspaceChatSummaryWire => Boolean(chat)),
    contentMatches: contentMatches.filter(
      (match): match is ChatContentMatchWire => Boolean(match)
    ),
    folders: folders.filter((folder): folder is FolderWire => Boolean(folder))
  };
}

export function decodeChatSummaryResponse(value: unknown): WorkspaceChatSummaryWire | null {
  return isRecord(value) ? decodeWorkspaceChatSummaryWire(value.chat) : null;
}

export function decodeChatDetailResponse(value: unknown): ChatDetailWire | null {
  if (!isRecord(value) || !isRecord(value.chat) || !Array.isArray(value.chat.messages)) {
    return null;
  }

  const chat = decodeWorkspaceChatSummaryWire(value.chat);
  const contextStats = decodeContextStats(value.chat.contextStats);
  const usageStats = decodeUsageStats(value.chat.usageStats);
  const page = decodeMessagePage(value.chat.messages, value.chat.pageInfo, {
    requireActiveLeaf: true
  });
  if (
    !chat ||
    !contextStats ||
    usageStats === undefined ||
    !page ||
    page.pageInfo.activeLeafMessageId !== chat.activeLeafMessageId ||
    page.pageInfo.snapshotUpdatedAt !== chat.updatedAt
  ) {
    return null;
  }

  return {
    ...chat,
    contextStats,
    messages: page.messages,
    pageInfo: page.pageInfo,
    usageStats
  };
}

export function decodeChatMessagesPageResponse(value: unknown): ChatMessagesPageWire | null {
  if (!isRecord(value) || !hasExactKeys(value, ["messages", "pageInfo"])) return null;
  return decodeMessagePage(value.messages, value.pageInfo, { requireActiveLeaf: false });
}

export function decodeChatLifecycleRequest(value: unknown): ChatLifecycleRequestWire | null {
  if (!isRecord(value) || !hasExactKeys(value, ["expectedChatRevision"])) return null;
  const expectedChatRevision = nonNegativeInteger(value.expectedChatRevision);
  return expectedChatRevision === null || !Number.isSafeInteger(expectedChatRevision)
    ? null
    : { expectedChatRevision };
}

function retainedMemoryMode(value: unknown): RetainedChatMemoryMode | null {
  return value === "NORMAL" || value === "EXCLUDED" ? value : null;
}

function decodeChatLifecycleState(value: unknown): ChatLifecycleStateWire | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["archived", "id", "memoryMode", "sourceRevision", "updatedAt"])
  ) return null;
  const id = requiredString(value.id);
  const memoryMode = retainedMemoryMode(value.memoryMode);
  const sourceRevision = nonNegativeInteger(value.sourceRevision);
  const updatedAt = isoTimestamp(value.updatedAt);
  if (
    !id ||
    !memoryMode ||
    sourceRevision === null ||
    !Number.isSafeInteger(sourceRevision) ||
    !updatedAt ||
    typeof value.archived !== "boolean"
  ) {
    return null;
  }
  return { archived: value.archived, id, memoryMode, sourceRevision, updatedAt };
}

export function decodeChatLifecycleResponse(value: unknown): ChatLifecycleResponseWire | null {
  if (!isRecord(value) || !hasExactKeys(value, ["chat"])) return null;
  const chat = decodeChatLifecycleState(value.chat);
  return chat ? { chat } : null;
}

export function decodeChatMemoryStateResponse(
  value: unknown
): ChatMemoryStateResponseWire | null {
  if (!isRecord(value) || !hasExactKeys(value, ["chat"]) || !isRecord(value.chat)) {
    return null;
  }
  const chat = value.chat;
  if (!hasExactKeys(chat, [
    "archived",
    "chatId",
    "mode",
    "sourceRevision",
    "temporaryRetentionDeadline",
    "temporaryRetentionPolicyVersion",
    "updatedAt"
  ])) return null;
  const chatId = requiredString(chat.chatId);
  const mode = chat.mode === "NORMAL" || chat.mode === "EXCLUDED" || chat.mode === "TEMPORARY"
    ? chat.mode
    : null;
  const sourceRevision = nonNegativeInteger(chat.sourceRevision);
  const temporaryRetentionDeadline = chat.temporaryRetentionDeadline === null
    ? null
    : isoTimestamp(chat.temporaryRetentionDeadline);
  const updatedAt = isoTimestamp(chat.updatedAt);
  if (
    !chatId ||
    !mode ||
    sourceRevision === null ||
    !Number.isSafeInteger(sourceRevision) ||
    !updatedAt ||
    typeof chat.archived !== "boolean"
  ) return null;
  if (mode === "TEMPORARY") {
    if (
      chat.archived ||
      chat.temporaryRetentionPolicyVersion !== MEMORY_TEMPORARY_RETENTION_POLICY_VERSION ||
      !temporaryRetentionDeadline
    ) return null;
  } else if (
    chat.temporaryRetentionDeadline !== null ||
    chat.temporaryRetentionPolicyVersion !== null
  ) return null;
  return {
    chat: {
      archived: chat.archived,
      chatId,
      mode,
      sourceRevision,
      temporaryRetentionDeadline,
      temporaryRetentionPolicyVersion: mode === "TEMPORARY"
        ? MEMORY_TEMPORARY_RETENTION_POLICY_VERSION
        : null,
      updatedAt
    }
  };
}

function decodeArchivedChatSummary(value: unknown): ArchivedChatSummaryWire | null {
  if (
    !isRecord(value) ||
    value.archived !== true ||
    !hasExactKeys(value, [
      "activeLeafMessageId",
      "archived",
      "createdAt",
      "defaultKnowledgePlan",
      "defaultModelId",
      "defaultProvider",
      "folderId",
      "id",
      "memoryMode",
      "messageCount",
      "pinned",
      "sourceRevision",
      "title",
      "updatedAt"
    ])
  ) return null;
  const summary = decodeWorkspaceChatSummaryWire(value);
  const memoryMode = retainedMemoryMode(value.memoryMode);
  const sourceRevision = nonNegativeInteger(value.sourceRevision);
  return summary && memoryMode && sourceRevision !== null && Number.isSafeInteger(sourceRevision)
    ? { ...summary, archived: true, memoryMode, sourceRevision }
    : null;
}

export function decodeArchivedChatsResponse(value: unknown): ArchivedChatsResponseWire | null {
  if (!isRecord(value) || !hasExactKeys(value, ["chats", "nextCursor"]) || !Array.isArray(value.chats)) {
    return null;
  }
  const nextCursor = nullableId(value.nextCursor);
  const chats = value.chats.map(decodeArchivedChatSummary);
  if (
    chats.length > ARCHIVED_CHAT_PAGE_SIZE ||
    chats.some((chat) => chat === null) ||
    nextCursor === undefined ||
    (typeof nextCursor === "string" && (
      nextCursor.length > ARCHIVED_CHAT_CURSOR_MAX_LENGTH ||
      !/^[A-Za-z0-9_-]+$/u.test(nextCursor)
    ))
  ) return null;
  return {
    chats: chats.filter((chat): chat is ArchivedChatSummaryWire => chat !== null),
    nextCursor
  };
}

export function decodeArchivedChatDetailResponse(
  value: unknown
): ArchivedChatDetailResponseWire | null {
  const detail = decodeChatDetailResponse(value);
  if (!detail || !isRecord(value) || !isRecord(value.chat) || value.chat.archived !== true) {
    return null;
  }
  if (!hasExactKeys(value, ["chat"]) || !hasExactKeys(value.chat, [
    "activeLeafMessageId",
    "archived",
    "contextStats",
    "createdAt",
    "defaultKnowledgePlan",
    "defaultModelId",
    "defaultProvider",
    "folderId",
    "id",
    "memoryMode",
    "messageCount",
    "messages",
    "pageInfo",
    "pinned",
    "sourceRevision",
    "title",
    "updatedAt",
    "usageStats"
  ])) return null;
  const memoryMode = retainedMemoryMode(value.chat.memoryMode);
  const sourceRevision = nonNegativeInteger(value.chat.sourceRevision);
  return memoryMode && sourceRevision !== null && Number.isSafeInteger(sourceRevision)
    ? { chat: { ...detail, archived: true, memoryMode, sourceRevision } }
    : null;
}

export function decodeChatSourceResolutionResponse(
  value: unknown
): ChatSourceResolutionResponseWire | null {
  if (!isRecord(value) || !hasExactKeys(value, ["source"]) || !isRecord(value.source)) {
    return null;
  }
  const source = value.source;
  if (
    !hasExactKeys(source, ["chatId", "location", "memoryMode", "sourceRevision", "updatedAt"])
  ) return null;
  const chatId = requiredString(source.chatId);
  const memoryMode = retainedMemoryMode(source.memoryMode);
  const sourceRevision = nonNegativeInteger(source.sourceRevision);
  const updatedAt = isoTimestamp(source.updatedAt);
  const location = source.location === "ACTIVE_CHAT" || source.location === "ARCHIVED_PREVIEW"
    ? source.location
    : null;
  return chatId && location && memoryMode && sourceRevision !== null &&
    Number.isSafeInteger(sourceRevision) && updatedAt
    ? { source: { chatId, location, memoryMode, sourceRevision, updatedAt } }
    : null;
}

function decodeChatBranchNode(value: unknown): ChatBranchNodeWire | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "parentMessageId", "preview", "role", "status"])
  ) return null;
  const id = requiredString(value.id);
  const parentMessageId = nullableId(value.parentMessageId);
  if (
    !id ||
    parentMessageId === undefined ||
    typeof value.preview !== "string" ||
    value.preview.length > CHAT_BRANCH_PREVIEW_MAX_LENGTH ||
    (value.role !== "assistant" && value.role !== "user") ||
    (value.status !== "cancelled" &&
      value.status !== "complete" &&
      value.status !== "error" &&
      value.status !== "queued" &&
      value.status !== "streaming")
  ) return null;
  return {
    id,
    parentMessageId,
    preview: value.preview,
    role: value.role,
    status: value.status
  };
}

export function decodeChatBranchesResponse(value: unknown): ChatBranchesResponseWire | null {
  if (!isRecord(value) || !hasExactKeys(value, ["branchGraph"]) || !isRecord(value.branchGraph)) {
    return null;
  }
  const graph = value.branchGraph;
  if (
    !hasExactKeys(graph, ["activeLeafMessageId", "nodes", "snapshotUpdatedAt"]) ||
    !Array.isArray(graph.nodes)
  ) return null;
  const activeLeafMessageId = nullableId(graph.activeLeafMessageId);
  const snapshotUpdatedAt = isoTimestamp(graph.snapshotUpdatedAt);
  const decodedNodes = graph.nodes.map(decodeChatBranchNode);
  if (
    activeLeafMessageId === undefined ||
    !snapshotUpdatedAt ||
    decodedNodes.some((node) => node === null)
  ) return null;
  const nodes = decodedNodes.filter((node): node is ChatBranchNodeWire => node !== null);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (
    byId.size !== nodes.length ||
    (activeLeafMessageId !== null && !byId.has(activeLeafMessageId)) ||
    nodes.some((node) => node.parentMessageId !== null && !byId.has(node.parentMessageId))
  ) return null;
  for (const node of nodes) {
    const seen = new Set<string>();
    let cursor: ChatBranchNodeWire | undefined = node;
    while (cursor) {
      if (seen.has(cursor.id)) return null;
      seen.add(cursor.id);
      cursor = cursor.parentMessageId ? byId.get(cursor.parentMessageId) : undefined;
    }
  }
  return {
    branchGraph: {
      activeLeafMessageId,
      nodes,
      snapshotUpdatedAt
    }
  };
}

export function decodeChatUpdateData(value: unknown): ChatUpdateDataWire | null {
  if (!isRecord(value) || !isRecord(value.chat) || !Array.isArray(value.messages)) {
    return null;
  }

  const chat = decodeWorkspaceChatSummaryWire(value.chat);
  const contextStats = decodeContextStats(value.chat.contextStats);
  const usageStats = decodeUsageStats(value.chat.usageStats);
  if (!chat || !contextStats || usageStats === undefined) {
    return null;
  }

  const decodedMessages = value.messages.map(decodeChatMessageWire);
  if (decodedMessages.some((message) => message === null)) {
    return null;
  }

  return {
    chat: {
      ...chat,
      contextStats,
      usageStats
    },
    messages: decodedMessages.filter(
      (message): message is ChatMessageWire => message !== null
    )
  };
}
