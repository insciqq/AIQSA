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
  decodeThreadSearchSource,
  type ThreadSearchSource
} from "./searchSources";
import { decodeKnowledgePlan, type KnowledgePlan } from "./knowledge";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  MEMORY_DELETION_STATES,
  MEMORY_TEMPORARY_RETENTION_POLICY_VERSION,
  decodeMemoryActionFeedback,
  type MemoryActionFeedback,
  type MemoryChatMode,
  type MemoryDeletionState
} from "./memory";

export const CHAT_HISTORY_PAGE_SIZE = 50;
export const CHAT_HISTORY_CURSOR_MAX_LENGTH = 2_048;
export const CHAT_BRANCH_PREVIEW_MAX_LENGTH = 160;
export const ARCHIVED_CHAT_PAGE_SIZE = 20;
export const ARCHIVED_CHAT_CURSOR_MAX_LENGTH = 2_048;
export const CHAT_NAVIGATION_CURSOR_MAX_LENGTH = 2_048;
export const CHAT_NAVIGATION_DEFAULT_PAGE_SIZE = 30;
export const CHAT_NAVIGATION_MAX_PAGE_SIZE = 50;
export const CHAT_NAVIGATION_QUERY_MAX_LENGTH = 120;
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
  ThreadSearchSource
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
  status: "cancelled" | "complete" | "error" | "streaming";
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
  citations: ThreadCitation[];
  groundingDisplay?: ThreadGroundingDisplay | null;
  knowledgeCitations?: ThreadKnowledgeCitation[];
  memoryAction?: MemoryActionFeedback;
  reasoningText: string[];
  sources: ThreadSearchSource[];
};

export type ThreadKnowledgeCitation = {
  baseName: string;
  fileName: string;
  handle: string;
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

export type ThreadGroundingDisplay = {
  provider: "gemini";
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

export type ChatPermanentDeleteAuthorizationRequestWire = {
  alsoForgetOriginMemories: boolean;
  confirmationCopyVersion: typeof MEMORY_CONFIRMATION_COPY_VERSION;
  expectedActiveLeafMessageId: string | null;
  expectedChatRevision: number;
  requestNonce: string;
};

export type ChatPermanentDeleteAuthorizationResponseWire = {
  expiresAt: string;
  mutationAuthorizationId: string;
};

export type ChatPermanentDeleteRequestWire = {
  alsoForgetOriginMemories: boolean;
  expectedActiveLeafMessageId: string | null;
  expectedChatRevision: number;
  mutationAuthorizationId: string;
};

export type ChatPermanentDeleteAdmissionResponseWire = {
  deletionId: string;
  fencedAt: string;
  state: MemoryDeletionState;
};

export type ChatPermanentDeleteStatusResponseWire = {
  attemptCount: number;
  cleanupComplete: boolean;
  deletionId: string;
  errorCode: string | null;
  fencedAt: string;
  lastAuditAt: string | null;
  state: MemoryDeletionState;
  updatedAt: string;
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
  memoryMode?: "EXCLUDED";
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
  | "chat_memory_mode_invalid"
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

/**
 * Content-free sidebar projection. Message counts, model identities, defaults,
 * prompts, and message snippets deliberately do not cross this boundary.
 */
export type ChatNavigationSummaryWire = {
  activeRun: boolean;
  folderId: string | null;
  id: string;
  title: string;
  updatedAt: string;
};

export type ChatNavigationFolderWire = {
  id: string;
  name: string;
  parentId: string | null;
};

export type ChatNavigationPageWire = {
  chats: ChatNavigationSummaryWire[];
  folders: ChatNavigationFolderWire[];
  nextCursor: string | null;
};

export type DecodedWorkspaceChatsResponse = {
  chats: WorkspaceChatSummaryWire[];
  contentMatches: ChatContentMatchWire[];
  folders: FolderWire[];
};

export type ChatNavigationErrorCode =
  | SessionErrorCode
  | "chat_navigation_cursor_invalid"
  | "chat_navigation_query_invalid";

export type ChatNavigationErrorResponse = ErrorResponse<ChatNavigationErrorCode>;

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

function decodeThreadGroundingDisplay(
  value: unknown
): ThreadGroundingDisplay | null {
  if (
    !isRecord(value) ||
    value.provider !== "gemini" ||
    typeof value.suggestionsHtml !== "string" ||
    value.suggestionsHtml.length === 0 ||
    new TextEncoder().encode(value.suggestionsHtml).byteLength > 256 * 1_024
  ) {
    return null;
  }
  return {
    provider: "gemini",
    suggestionsHtml: value.suggestionsHtml
  };
}

function decodeThreadArtifactSummary(value: unknown): ThreadArtifactSummary | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.citations) ||
    value.citations.length > 100 ||
    !Array.isArray(value.reasoningText) ||
    value.reasoningText.length > 100 ||
    value.reasoningText.some((text) => typeof text !== "string") ||
    !Array.isArray(value.sources) ||
    value.sources.length > 20
  ) {
    return null;
  }

  const citations = value.citations.map(decodeThreadCitation);
  const sources = value.sources.map(decodeThreadSearchSource);
  if (
    citations.some((citation) => citation === null) ||
    sources.some((source) => source === null)
  ) {
    return null;
  }

  let groundingDisplay: ThreadGroundingDisplay | null | undefined;
  if (value.groundingDisplay === undefined || value.groundingDisplay === null) {
    groundingDisplay = value.groundingDisplay;
  } else {
    groundingDisplay = decodeThreadGroundingDisplay(value.groundingDisplay);
    if (!groundingDisplay) return null;
  }

  let knowledgeCitations: ThreadKnowledgeCitation[] | undefined;
  if (value.knowledgeCitations !== undefined) {
    if (!Array.isArray(value.knowledgeCitations) || value.knowledgeCitations.length > 24) {
      return null;
    }
    const decoded = value.knowledgeCitations.map(decodeThreadKnowledgeCitation);
    if (decoded.some((citation) => citation === null)) return null;
    knowledgeCitations = decoded.filter(
      (citation): citation is ThreadKnowledgeCitation => citation !== null
    );
    if (
      new Set(knowledgeCitations.map((citation) => citation.handle)).size !==
      knowledgeCitations.length
    ) {
      return null;
    }
  }

  let memoryAction: MemoryActionFeedback | undefined;
  if (value.memoryAction !== undefined) {
    const decoded = decodeMemoryActionFeedback(value.memoryAction);
    if (!decoded.ok) return null;
    memoryAction = decoded.value;
  }

  return {
    citations: citations.filter(
      (citation): citation is ThreadCitation => citation !== null
    ),
    ...(groundingDisplay !== undefined ? { groundingDisplay } : {}),
    ...(knowledgeCitations !== undefined ? { knowledgeCitations } : {}),
    ...(memoryAction ? { memoryAction } : {}),
    reasoningText: value.reasoningText as string[],
    sources: sources.filter(
      (source): source is ThreadSearchSource => source !== null
    )
  };
}

function decodeThreadKnowledgeCitation(value: unknown): ThreadKnowledgeCitation | null {
  if (!isRecord(value)) return null;
  const baseName = requiredString(value.baseName);
  const fileName = requiredString(value.fileName);
  const handle = requiredString(value.handle);
  const page = nonNegativeInteger(value.page);
  if (
    !baseName ||
    !fileName ||
    !handle ||
    !/^K[1-3]\.[1-8]$/u.test(handle) ||
    page === null ||
    page < 1
  ) {
    return null;
  }
  return {
    baseName,
    fileName,
    handle,
    page
  };
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
    status
  };
}

function decodeChatDefaultSelection(
  modelValue: unknown,
  providerValue: unknown
): Pick<WorkspaceChatSummaryWire, "defaultModelId" | "defaultProvider"> | null {
  if (modelValue === null && providerValue === null) {
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

function decodeChatNavigationSummaryWire(
  value: unknown
): ChatNavigationSummaryWire | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["activeRun", "folderId", "id", "title", "updatedAt"])
  ) {
    return null;
  }
  const folderId = nullableId(value.folderId);
  const id = requiredString(value.id);
  const title = requiredString(value.title);
  const updatedAt = isoTimestamp(value.updatedAt);
  if (
    typeof value.activeRun !== "boolean" ||
    folderId === undefined ||
    !id ||
    !title ||
    !updatedAt
  ) {
    return null;
  }
  return {
    activeRun: value.activeRun,
    folderId,
    id,
    title,
    updatedAt
  };
}

function decodeChatNavigationFolderWire(
  value: unknown
): ChatNavigationFolderWire | null {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "name", "parentId"])) {
    return null;
  }
  const id = requiredString(value.id);
  const name = requiredString(value.name);
  const parentId = nullableId(value.parentId);
  return id && name && parentId !== undefined ? { id, name, parentId } : null;
}

export function decodeChatNavigationPage(
  value: unknown
): ChatNavigationPageWire | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["chats", "folders", "nextCursor"]) ||
    !Array.isArray(value.chats) ||
    value.chats.length > CHAT_NAVIGATION_MAX_PAGE_SIZE ||
    !Array.isArray(value.folders)
  ) {
    return null;
  }
  const nextCursor = nullableId(value.nextCursor);
  if (
    nextCursor === undefined ||
    (nextCursor !== null && (
      nextCursor.length > CHAT_NAVIGATION_CURSOR_MAX_LENGTH ||
      !/^[A-Za-z0-9_-]+$/u.test(nextCursor)
    ))
  ) {
    return null;
  }
  const chats = value.chats.map(decodeChatNavigationSummaryWire);
  const folders = value.folders.map(decodeChatNavigationFolderWire);
  if (
    chats.some((chat) => chat === null) ||
    folders.some((folder) => folder === null)
  ) {
    return null;
  }
  const decodedChats = chats.filter(
    (chat): chat is ChatNavigationSummaryWire => chat !== null
  );
  const decodedFolders = folders.filter(
    (folder): folder is ChatNavigationFolderWire => folder !== null
  );
  if (
    new Set(decodedChats.map((chat) => chat.id)).size !== decodedChats.length ||
    new Set(decodedFolders.map((folder) => folder.id)).size !== decodedFolders.length
  ) {
    return null;
  }
  return { chats: decodedChats, folders: decodedFolders, nextCursor };
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

function permanentDeleteLeaf(value: unknown): string | null | undefined {
  return value === null ? null : boundedRequiredString(value, 256) ?? undefined;
}

export function decodeChatPermanentDeleteAuthorizationRequest(
  value: unknown
): ChatPermanentDeleteAuthorizationRequestWire | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "alsoForgetOriginMemories",
    "confirmationCopyVersion",
    "expectedActiveLeafMessageId",
    "expectedChatRevision",
    "requestNonce"
  ])) return null;
  const expectedChatRevision = nonNegativeInteger(value.expectedChatRevision);
  const expectedActiveLeafMessageId = permanentDeleteLeaf(
    value.expectedActiveLeafMessageId
  );
  const requestNonce = boundedRequiredString(value.requestNonce, 256);
  if (
    typeof value.alsoForgetOriginMemories !== "boolean" ||
    value.confirmationCopyVersion !== MEMORY_CONFIRMATION_COPY_VERSION ||
    expectedActiveLeafMessageId === undefined ||
    expectedChatRevision === null ||
    !Number.isSafeInteger(expectedChatRevision) ||
    !requestNonce
  ) return null;
  return {
    alsoForgetOriginMemories: value.alsoForgetOriginMemories,
    confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
    expectedActiveLeafMessageId,
    expectedChatRevision,
    requestNonce
  };
}

export function decodeChatPermanentDeleteRequest(
  value: unknown
): ChatPermanentDeleteRequestWire | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "alsoForgetOriginMemories",
    "expectedActiveLeafMessageId",
    "expectedChatRevision",
    "mutationAuthorizationId"
  ])) return null;
  const expectedChatRevision = nonNegativeInteger(value.expectedChatRevision);
  const expectedActiveLeafMessageId = permanentDeleteLeaf(
    value.expectedActiveLeafMessageId
  );
  const mutationAuthorizationId = boundedRequiredString(
    value.mutationAuthorizationId,
    256
  );
  if (
    typeof value.alsoForgetOriginMemories !== "boolean" ||
    expectedActiveLeafMessageId === undefined ||
    expectedChatRevision === null ||
    !Number.isSafeInteger(expectedChatRevision) ||
    !mutationAuthorizationId
  ) return null;
  return {
    alsoForgetOriginMemories: value.alsoForgetOriginMemories,
    expectedActiveLeafMessageId,
    expectedChatRevision,
    mutationAuthorizationId
  };
}

export function decodeChatPermanentDeleteAuthorizationResponse(
  value: unknown
): ChatPermanentDeleteAuthorizationResponseWire | null {
  if (!isRecord(value) || !hasExactKeys(value, ["expiresAt", "mutationAuthorizationId"])) {
    return null;
  }
  const expiresAt = isoTimestamp(value.expiresAt);
  const mutationAuthorizationId = boundedRequiredString(
    value.mutationAuthorizationId,
    256
  );
  return expiresAt && mutationAuthorizationId
    ? { expiresAt, mutationAuthorizationId }
    : null;
}

function permanentDeleteState(value: unknown): MemoryDeletionState | null {
  return typeof value === "string" &&
    (MEMORY_DELETION_STATES as readonly string[]).includes(value)
    ? value as MemoryDeletionState
    : null;
}

export function decodeChatPermanentDeleteAdmissionResponse(
  value: unknown
): ChatPermanentDeleteAdmissionResponseWire | null {
  if (!isRecord(value) || !hasExactKeys(value, ["deletionId", "fencedAt", "state"])) {
    return null;
  }
  const deletionId = boundedRequiredString(value.deletionId, 256);
  const fencedAt = isoTimestamp(value.fencedAt);
  const state = permanentDeleteState(value.state);
  return deletionId && fencedAt && state ? { deletionId, fencedAt, state } : null;
}

export function decodeChatPermanentDeleteStatusResponse(
  value: unknown
): ChatPermanentDeleteStatusResponseWire | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "attemptCount",
    "cleanupComplete",
    "deletionId",
    "errorCode",
    "fencedAt",
    "lastAuditAt",
    "state",
    "updatedAt"
  ])) return null;
  const attemptCount = nonNegativeInteger(value.attemptCount);
  const deletionId = boundedRequiredString(value.deletionId, 256);
  const errorCode = value.errorCode === null
    ? null
    : boundedRequiredString(value.errorCode, 64) ?? undefined;
  const fencedAt = isoTimestamp(value.fencedAt);
  const lastAuditAt = value.lastAuditAt === null
    ? null
    : isoTimestamp(value.lastAuditAt) ?? undefined;
  const state = permanentDeleteState(value.state);
  const updatedAt = isoTimestamp(value.updatedAt);
  if (
    attemptCount === null ||
    !Number.isSafeInteger(attemptCount) ||
    !deletionId ||
    errorCode === undefined ||
    !fencedAt ||
    lastAuditAt === undefined ||
    !state ||
    !updatedAt ||
    typeof value.cleanupComplete !== "boolean" ||
    value.cleanupComplete !== (state === "SUCCEEDED")
  ) return null;
  return {
    attemptCount,
    cleanupComplete: value.cleanupComplete,
    deletionId,
    errorCode,
    fencedAt,
    lastAuditAt,
    state,
    updatedAt
  };
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
