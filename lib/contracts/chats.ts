import type {
  ErrorResponse,
  MutationOriginErrorCode,
  SessionErrorCode
} from "./http";
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

export type {
  ThreadSearchExecution,
  ThreadSearchProviderOperation,
  ThreadSearchSource,
  ThreadToolActivity,
  ThreadToolActivityStatus
};

export type ThreadMessage = {
  artifactSummary?: ThreadArtifactSummary | null;
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

export type ThreadArtifactSummary = {
  citationCount: number;
  citations: ThreadCitation[];
  contextTruncation?: {
    approxDroppedTokens: number;
    droppedMessages: number;
  } | null;
  groundingDisplay?: ThreadGroundingDisplay | null;
  reasoningCount: number;
  reasoningText: string[];
  searchActivity?: ThreadSearchActivity[];
  searchCount: number;
  searchDisplayName?: string | null;
  searchStrategy: string | null;
  toolCallCount: number;
  toolCalls: ThreadToolActivity[];
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
  defaultPromptPresetId: string | null;
  defaultProvider: string;
  folderId: string | null;
  id: string;
  messageCount: number;
  pinned?: boolean;
  title: string;
  updatedAt: string;
};

export type ChatUsageStats = {
  activeBranchMessageCount: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  totalTokens: number;
};

export type ChatDetail = WorkspaceChatSummary & {
  messages: ThreadMessage[];
  usageStats: ChatUsageStats | null;
};

/** Prefer the explicit workspace name in new code; this alias is summary-only. */
export type ChatSummary = WorkspaceChatSummary;

export type ChatMessageWire = {
  artifactSummary?: ThreadArtifactSummary | null;
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
  "defaultModelId" | "defaultProvider" | "pinned"
> & {
  defaultModelId: string | null;
  defaultProvider: string | null;
  pinned: boolean;
};

export type ChatDetailWire = WorkspaceChatSummaryWire & {
  messages: ChatMessageWire[];
  usageStats: ChatUsageStats | null;
};

export type ChatSummaryResponseWire = {
  chat: WorkspaceChatSummaryWire;
};

export type ChatDetailResponseWire = {
  chat: ChatDetailWire;
};

export type CreateChatRequestWire = {
  folderId?: string | null;
  title?: string | null;
};

export type UpdateChatRequestWire = {
  activeLeafMessageId?: string | null;
  folderId?: string | null;
  pinned?: boolean;
  title?: string | null;
};

export type ChatRouteServerErrorCode =
  | SessionErrorCode
  | MutationOriginErrorCode
  | "active_run_in_progress"
  | "chat_not_created"
  | "chat_not_found"
  | "workspace_not_found";

export type ChatRouteErrorResponse = ErrorResponse<ChatRouteServerErrorCode>;

export type ChatContentMatchWire = {
  chatId: string;
  snippet: string | null;
};

export type FolderWire = {
  id: string;
  name: string;
  parentId: string | null;
  projectMemory: string;
  sortOrder: number;
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
    usageStats: ChatUsageStats | null;
  };
  messages: ChatMessageWire[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const query = value.query === null ? null : boundedRequiredString(value.query, 2_000);
  const sourceCount = value.sourceCount === null ? null : nonNegativeInteger(value.sourceCount);
  const status = decodeThreadSearchActivityStatus(value.status);
  if (
    !displayName ||
    (query === null && value.query !== null) ||
    (sourceCount === null && value.sourceCount !== null) ||
    (sourceCount !== null && sourceCount > 100) ||
    !status ||
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
  const searchDisplayName = value.searchDisplayName === undefined
    ? undefined
    : nullableString(value.searchDisplayName);
  const searchStrategy = nullableId(value.searchStrategy);
  if (
    citationCount === null ||
    reasoningCount === null ||
    searchCount === null ||
    toolCallCount === null ||
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

  return {
    citationCount,
    citations: citations.filter((citation): citation is ThreadCitation => citation !== null),
    ...(contextTruncation !== undefined ? { contextTruncation } : {}),
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
  const defaultPromptPresetId = nullableId(value.defaultPromptPresetId);
  const folderId = nullableId(value.folderId);
  const messageCount = nonNegativeInteger(value.messageCount);
  const title = requiredString(value.title);
  const updatedAt = requiredString(value.updatedAt);
  if (
    activeLeafMessageId === undefined ||
    !id ||
    !createdAt ||
    !defaultSelection ||
    defaultPromptPresetId === undefined ||
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
    defaultModelId: defaultSelection.defaultModelId,
    defaultPromptPresetId,
    defaultProvider: defaultSelection.defaultProvider,
    folderId,
    id,
    messageCount,
    pinned: value.pinned,
    title,
    updatedAt
  };
}

function decodeFolderWire(value: unknown): FolderWire | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = requiredString(value.id);
  const name = requiredString(value.name);
  const parentId = nullableId(value.parentId);
  const projectMemory = typeof value.projectMemory === "string" ? value.projectMemory : null;
  const sortOrder = finiteNumber(value.sortOrder);
  if (!id || !name || parentId === undefined || projectMemory === null || sortOrder === null) {
    return null;
  }

  return {
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
  const usageStats = decodeUsageStats(value.chat.usageStats);
  const messages = value.chat.messages.map(decodeChatMessageWire);
  if (!chat || usageStats === undefined || messages.some((message) => message === null)) {
    return null;
  }

  return {
    ...chat,
    messages: messages.filter((message): message is ChatMessageWire => message !== null),
    usageStats
  };
}

export function decodeChatUpdateData(value: unknown): ChatUpdateDataWire | null {
  if (!isRecord(value) || !isRecord(value.chat) || !Array.isArray(value.messages)) {
    return null;
  }

  const chat = decodeWorkspaceChatSummaryWire(value.chat);
  const usageStats = decodeUsageStats(value.chat.usageStats);
  if (!chat || usageStats === undefined) {
    return null;
  }

  const decodedMessages = value.messages.map(decodeChatMessageWire);
  if (decodedMessages.some((message) => message === null)) {
    return null;
  }

  return {
    chat: {
      ...chat,
      usageStats
    },
    messages: decodedMessages.filter(
      (message): message is ChatMessageWire => message !== null
    )
  };
}
