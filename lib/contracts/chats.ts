import { isMemorySearchActivityOutcome, type MemorySearchActivityOutcome } from "./memorySearchActivity";
import { decodeSearchPlan, type SearchPlan } from "./search";
import { decodeRunFollowupState, type RunFollowupState } from "./runFollowups";
import { decodeThreadGeneratedImage, type ThreadGeneratedImage } from "./imageGeneration";
import { decodeSessionContextStatus, type SessionContextStatus } from "./sessionStatus";
import { decodeChatPdfPreparations, type ChatPdfPreparationWire } from "./chatPdfPreparation";
import type {
  ErrorResponse,
  MutationOriginErrorCode,
  SessionErrorCode
} from "./http";
import {
  ASSISTANT_ROW_KEYS,
  decodeAssistantAvailability,
  decodeAssistantAvatarRecipe,
  decodeAssistantIdentity,
  decodeAssistantKnowledgeValue,
  decodeAssistantModelValue,
  decodeAssistantRowDeviation,
  decodeAssistantRowKey,
  decodeAssistantRowPolicy,
  decodeAssistantRowProvenance,
  decodeAssistantRunControls,
  decodeAssistantSearchValue,
  decodeAssistantSkillsValue,
  decodeAssistantToolsValue,
  type AssistantAvailability,
  type AssistantAvatarRecipe,
  type AssistantIdentity,
  type AssistantKnowledgeValue,
  type AssistantModelValue,
  type AssistantRowDeviation,
  type AssistantRowKey,
  type AssistantRowPolicy,
  type AssistantRowProvenance,
  type AssistantRowValues,
  type AssistantRunControls,
  type AssistantSearchValue,
  type AssistantSkillsValue,
  type AssistantToolsValue
} from "./assistants";
import { isAssistantReferenceId } from "./chatDefaults";
import { decodeMcpRunSelection, type McpRunSelection } from "./mcp";
import type { SearchPlanMode } from "./search";
import { decodeSkillsSelection, type SkillsSelection } from "./skills";
import {
  decodeThreadSearchSource,
  type ThreadSearchSource
} from "./searchSources";
import {
  decodeKnowledgeCitationHandle,
  decodeKnowledgePlan,
  type KnowledgePlan
} from "./knowledge";
import {
  MEMORY_ANSWER_SOURCE_MAX_ITEMS,
  MEMORY_TEMPORARY_RETENTION_POLICY_VERSION,
  decodeMemoryActionFeedback,
  decodeMemoryAnswerSource,
  type MemoryActionFeedback,
  type MemoryAnswerSource,
  type MemoryChatMode
} from "./memoryClient";
import {
  decodeChatWorkspaceState,
  decodeThreadGeneratedFiles,
  decodeThreadWorkspaceActivity,
  type ChatWorkspaceState,
  type ThreadGeneratedFile,
  type ThreadWorkspaceActivity
} from "./workspace";
import { decodeContextCompactionStatus, type ContextCompactionStatus } from "./contextCompaction";
import {
  SCHEDULED_TASK_CARDS_LIMIT,
  decodeScheduledTaskCard,
  isScheduledTaskCheckOutcome,
  type ScheduledTaskCard,
  type ScheduledTaskCheckOutcome
} from "./scheduledTasks";

export const CHAT_HISTORY_PAGE_SIZE = 50;
export const CHAT_HISTORY_CURSOR_MAX_LENGTH = 2_048;
export const CHAT_BRANCH_PREVIEW_MAX_LENGTH = 160;
export const ARCHIVED_CHAT_PAGE_SIZE = 20;
export const ARCHIVED_CHAT_CURSOR_MAX_LENGTH = 2_048;
export const CHAT_NAVIGATION_CURSOR_MAX_LENGTH = 2_048;
export const CHAT_NAVIGATION_DEFAULT_PAGE_SIZE = 30;
export const CHAT_NAVIGATION_MAX_PAGE_SIZE = 50;
export const CHAT_NAVIGATION_QUERY_MAX_LENGTH = 120;
/** Message text matching starts at this many characters of the normalized query; title search has no minimum. */
export const CHAT_MESSAGE_SEARCH_MIN_QUERY_LENGTH = 3;
/** Characters of readable text a message snippet keeps on each side of the first match. */
export const CHAT_MESSAGE_MATCH_SNIPPET_CONTEXT = 80;
/** Decoder bound on a snippet: both contexts around a longest query, astral characters and ellipses included. */
export const CHAT_MESSAGE_MATCH_SNIPPET_MAX_LENGTH = 600;
/**
 * Reader portions of one answer's outputs. The server summary stays within
 * them and marks what it leaves out; the decoder applies the same bounds and
 * drops an invalid optional item on its own, never the message. Citations
 * allow the agreed 500 per provider response across the default eight tool
 * rounds; Search results accumulate across rounds under the same bound.
 */
export const THREAD_REASONING_MAX_CHARACTERS = 256 * 1_024;
export const THREAD_REASONING_MAX_ENTRIES = 100;
export const THREAD_CITATION_MAX_ITEMS = 4_000;
export const THREAD_SEARCH_SOURCE_MAX_ITEMS = 4_000;
/**
 * User-entered chat titles (personal and Project chats) and personal folder
 * names, counted in Unicode code points. Stored columns are unbounded: the
 * server rejects longer input (`chat_title_too_long`/`folder_name_too_long`)
 * instead of truncating, so a saved name is exactly what was submitted.
 * Project folders keep their own contract. Browser `maxLength` counts UTF-16
 * code units, so any input the field accepts also fits here.
 */
export const CHAT_TITLE_MAX_LENGTH = 120;
export const PERSONAL_FOLDER_NAME_MAX_LENGTH = 80;
export function codePointLength(value: string): number {
  return Array.from(value).length;
}
/** Server-composed titles (e.g. continuations) cut on a code-point boundary. */
export function boundedChatTitle(value: string): string {
  return codePointLength(value) <= CHAT_TITLE_MAX_LENGTH
    ? value
    : Array.from(value).slice(0, CHAT_TITLE_MAX_LENGTH).join("").trimEnd();
}
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

/**
 * Bounds merged thinking entries for a reader. Entries past the entry bound
 * join the last kept one (the reader shows them joined anyway), so only text
 * past the character budget is cut, at a code-point boundary, and marked.
 */
export function boundThreadReasoningText(
  entries: readonly string[]
): Readonly<{ reasoningText: string[]; truncated: boolean }> {
  const merged = entries.length > THREAD_REASONING_MAX_ENTRIES
    ? [
        ...entries.slice(0, THREAD_REASONING_MAX_ENTRIES - 1),
        entries.slice(THREAD_REASONING_MAX_ENTRIES - 1).join("\n\n")
      ]
    : entries;
  const reasoningText: string[] = [];
  let remaining = THREAD_REASONING_MAX_CHARACTERS;
  for (const entry of merged) {
    if (entry.length <= remaining) {
      reasoningText.push(entry);
      remaining -= entry.length;
      continue;
    }
    const finalCodeUnit = entry.charCodeAt(remaining - 1);
    const end = finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff ? remaining - 1 : remaining;
    const kept = entry.slice(0, Math.max(0, end)).trimEnd();
    if (kept) reasoningText.push(kept);
    return { reasoningText, truncated: true };
  }
  return { reasoningText, truncated: false };
}

export type {
  ThreadSearchSource
};
import { decodeThreadSearchEngineActivity, type ThreadSearchEngineActivity } from "./searchActivity";
export type { ThreadWorkspaceActivity } from "./workspace";

export type ThreadMessage = {
  followups?: RunFollowupState;
  workspacePreparation?: true;
  workspaceSettling?: true;
  errorMessage?: string | null;
  pdfPreparation?: readonly ChatPdfPreparationWire[];
  artifactSummary?: ThreadArtifactSummary | null;
  assistantIdentity?: ThreadAssistantIdentity | null;
  author?: ProjectMessageAuthorWire | null;
  citationMessageId?: string | null;
  content: unknown;
  id: string;
  modelId?: string;
  parentMessageId: string | null;
  provider?: string;
  role: "assistant" | "user";
  runId?: string | null;
  scheduledTask?: ChatMessageScheduledTaskWire | null;
  /** See `ChatMessageWire.scheduledOutcome`. */
  scheduledOutcome?: ScheduledTaskCheckOutcome;
  status: "cancelled" | "complete" | "error" | "streaming";
  toolActivity?: ThreadToolActivity | null;
  workspaceActivity?: ThreadWorkspaceActivity | null;
};

/**
 * Immutable Assistant identity from the accepted run. Later renames,
 * archives, or access changes never alter this historical projection.
 */
export type ThreadAssistantIdentity = AssistantIdentity;

export type ThreadArtifactSummary = {
  contextCompaction?: ContextCompactionStatus;
  skillCatalogOmittedCount?: number;
  citations: ThreadCitation[];
  /** Unique cited links beyond THREAD_CITATION_MAX_ITEMS were left out. */
  citationsTruncated?: true;
  generatedArtifacts?: ThreadGeneratedArtifact[];
  generatedFiles?: ThreadGeneratedFile[];
  generatedImages?: ThreadGeneratedImage[];
  groundingDisplay?: ThreadGroundingDisplay | null;
  knowledgeState?: ThreadKnowledgeAnswerState;
  knowledgeCitations?: ThreadKnowledgeCitation[];
  memoryAction?: MemoryActionFeedback;
  memoryStatus?: "INPUT_TOO_LONG" | "LIMITED" | "UNAVAILABLE";
  memorySources?: MemoryAnswerSource[];
  /** Merged thinking entries, THREAD_REASONING_MAX_CHARACTERS in total at most. */
  reasoningText: string[];
  /** Part of the thinking was too long to keep or show. */
  reasoningTruncated?: true;
  /** Scheduled tasks the answer created; see `ScheduledTaskCard`. */
  scheduledTasks?: ScheduledTaskCard[];
  sources: ThreadSearchSource[];
  /** Search results beyond THREAD_SEARCH_SOURCE_MAX_ITEMS were left out. */
  sourcesTruncated?: true;
  /** Admission → first answer token, in ms; present only when reasoning or tool steps ran. */
  workDurationMs?: number;
};

export type ThreadGeneratedArtifact = Readonly<{
  byteSize?: number;
  artifactId: string;
  entrypoint: string | null;
  kind: "chart" | "game" | "html" | "image" | "slides" | "svg";
  title: string;
  versionId: string;
  versionNumber: number;
}>;

export type ThreadKnowledgeAnswerState = Readonly<{
  answer: "answered" | "insufficient_evidence";
  scope: "partial_sources_ready" | "ready";
}>;

export type ThreadToolActivity = {
  calls: ThreadToolActivityCall[];
  searchEngines?: ThreadSearchEngineActivity[];
  warning?: ThreadToolBudgetWarning;
};

export type ThreadToolActivityOrigin =
  | "artifact"
  | "image"
  | "discovery"
  | "knowledge"
  | "mcp"
  | "memory"
  | "session"
  | "skill"
  | "tool"
  | "web_search"
  | "workspace";

export function isThreadToolActivityOrigin(value: unknown): value is ThreadToolActivityOrigin {
  return value === "artifact" || value === "image" || value === "discovery" || value === "knowledge" || value === "mcp" ||
    value === "memory" || value === "session" || value === "skill" || value === "tool" ||
    value === "web_search" || value === "workspace";
}

export type ThreadToolActivityCall = {
  details?: { roundIndex: number; ordinal: number };
  memorySearchCall?: number;
  memorySearchOutcome?: MemorySearchActivityOutcome;
  skillId?: string;
  skillName?: string;
  skillPath?: string;
  durationMs?: number;
  origin?: ThreadToolActivityOrigin;
  round: number;
  serverName?: string;
  status: "cancelled" | "complete" | "error" | "running";
  toolName: string;
};

export type ThreadToolBudgetWarning = {
  kind: "calls" | "rounds";
  limit: number;
};

export function decodeThreadToolBudgetWarning(value: unknown): ThreadToolBudgetWarning | null {
  if (!isRecord(value) || (value.kind !== "calls" && value.kind !== "rounds") ||
    !Number.isSafeInteger(value.limit) || Number(value.limit) < 1) return null;
  return { kind: value.kind, limit: Number(value.limit) };
}

export type ThreadKnowledgeCitation =
  | {
      deleted?: false;
      handle: string;
    }
  | {
      deleted: true;
      handle: string;
    };

export type ThreadKnowledgeOutcome = {
  invocationOrdinal: number;
  outcome:
    | "base_empty"
    | "base_indexing"
    | "complete"
    | "embedding_model_unavailable";
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
  titlePending?: boolean;
  hasContinuationSource?: boolean;
  activeLeafMessageId: string | null;
  /** The Assistant bound for the next messages; absent on unsaved local drafts. */
  assistantId?: string | null;
  createdAt: string;
  defaultModelId: string;
  defaultSearchPlan?: SearchPlan | null;
  defaultKnowledgePlan?: KnowledgePlan | null;
  defaultProvider: string;
  folderId: string | null;
  id: string;
  messageCount: number;
  /** Client-owned lifecycle metadata loaded from the private Memory state route. */
  memoryMode?: MemoryChatMode;
  memorySourceRevision?: number;
  pendingInitialMemoryMode?: "TEMPORARY";
  /** Local-only first-send reservation. The server creates this Project chat
   * atomically with its first message/run and never serializes this field. */
  pendingProjectDraft?: Readonly<{ folderId: string | null; projectId: string }>;
  /** Local-only personal first-send reservation. The server creates the chat
   * atomically with its first message/run and never serializes this field. */
  pendingPersonalDraft?: Readonly<{
    folderId: string | null;
    memoryMode: "EXCLUDED" | "NORMAL" | "TEMPORARY";
  }>;
  pinned?: boolean;
  projectId?: string | null;
  temporaryRetentionDeadline?: string | null;
  title: string;
  updatedAt: string;
  /** Required on server wires; optional only for unsaved local drafts and
   * previously cached in-memory objects created before Workspace existed. */
  workspace?: ChatWorkspaceState;
};

export type ChatUsageStats = {
  hasCompletedAnswer: boolean;
  /** A title receipt may settle after its presentation no longer says pending. */
  titleUsagePending?: boolean;
  recordCount: number;
  knownCostRecordCount: number;
  incompleteRecordCount: number;
  estimatedCostMicros: number | null;
  totalTokens: number | null;
};

export type ChatContextStats = {
  approximateActiveBranchInputTokens: number;
  session?: SessionContextStatus | null;
  sessionMessageId?: string | null;
  sessionBranchLeafId?: string | null;
  approximateInputTokensAfterSession?: number;
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
  followups?: RunFollowupState;
  workspacePreparation?: true;
  workspaceSettling?: true;
  pdfPreparation?: readonly ChatPdfPreparationWire[];
  artifactSummary?: ThreadArtifactSummary | null;
  assistantIdentity?: ThreadAssistantIdentity | null;
  author?: ProjectMessageAuthorWire | null;
  citationMessageId: string | null;
  content: unknown;
  createdAt: string;
  errorMessage: string | null;
  id: string;
  modelId: string | null;
  modelRunId: string | null;
  parentMessageId: string | null;
  provider: string | null;
  role: string;
  /** Present on current responses; absent (stale caches, fixtures) means none. */
  scheduledTask?: ChatMessageScheduledTaskWire | null;
  /**
   * The settled outcome of the monitoring check this message belongs to: its
   * scheduled user turn or that turn's answer. Kept on the check's run, so it
   * outlives the occurrence history and the task. Absent for other messages
   * and while the check runs; the transcript collapses `no_update` turns.
   */
  scheduledOutcome?: ScheduledTaskCheckOutcome;
  status: string;
  toolActivity?: ThreadToolActivity | null;
  workspaceActivity?: ThreadWorkspaceActivity | null;
};

/**
 * A user turn posted by a scheduled task occurrence: the task and its current
 * title, the run's id (`ScheduledTaskRun.id`) and whether its result is
 * unread. Deleting the task removes its occurrences, so the marker disappears.
 */
export type ChatMessageScheduledTaskWire = Readonly<{
  taskId: string;
  taskRunId: string;
  title: string;
  unseen: boolean;
}>;

export type ProjectMessageAuthorWire = Readonly<{
  displayName: string;
  role: "CONTRIBUTOR" | "MANAGER" | "OWNER" | "VIEWER";
  userId: string | null;
}>;

export type WorkspaceChatSummaryWire = Omit<
  WorkspaceChatSummary,
  | "defaultModelId"
  | "defaultProvider"
  | "memoryMode"
  | "memorySourceRevision"
  | "pendingInitialMemoryMode"
  | "pinned"
  | "temporaryRetentionDeadline"
  | "workspace"
> & {
  /** Present on current responses; absent (stale caches, fixtures) means none. */
  assistantId?: string | null;
  defaultModelId: string | null;
  defaultProvider: string | null;
  pinned: boolean;
  projectId?: string | null;
  /** Present on current responses; optional only for stale caches/fixtures. */
  workspace?: ChatWorkspaceState;
};

export type ChatDetailWire = WorkspaceChatSummaryWire & {
  /** The chat's Assistant as the viewer may see it; null for a chat without one. */
  assistant: ChatAssistantProjection | null;
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
  lastMessageAt: string | null;
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
  workspaceEnabled?: boolean;
};

export type UpdateChatRequestWire = {
  /** Binds the Assistant for the next messages; null removes it. Either clears the overrides. */
  assistantId?: string | null;
  assistantOverrides?: ChatAssistantOverridesPatch;
  defaultSearchPlan?: SearchPlan | null;
  activeLeafMessageId?: string | null;
  defaultKnowledgePlan?: KnowledgePlan | null;
  folderId?: string | null;
  pinned?: boolean;
  title?: string | null;
  workspaceEnabled?: boolean;
};

/** Assistant errors of chat updates and message sends; only a send reports a binding conflict. */
export type ChatAssistantErrorCode =
  | "assistant_binding_conflict"
  | "assistant_not_available"
  | "assistant_overrides_invalid"
  | "assistant_overrides_not_allowed";

export type ChatRouteServerErrorCode =
  | SessionErrorCode
  | MutationOriginErrorCode
  | ChatAssistantErrorCode
  | "active_run_in_progress"
  | "archived_chat_cursor_invalid"
  | "chat_page_cursor_invalid"
  | "chat_page_stale"
  | "chat_lifecycle_invalid"
  | "chat_memory_mode_invalid"
  | "chat_not_created"
  | "chat_not_found"
  | "chat_revision_stale"
  | "chat_title_too_long"
  | "knowledge_plan_invalid"
  | "search_plan_invalid"
  | "workspace_state_invalid"
  | "workspace_not_found";

export type ChatRouteErrorResponse = ErrorResponse<ChatRouteServerErrorCode>;

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
  folders: FolderWire[];
};

/**
 * Content-free sidebar projection. Message counts, model identities, defaults,
 * prompts, and message snippets deliberately do not cross this boundary. The
 * one exception is the display identity of the chat's Assistant, present only
 * while that Assistant is available to the viewer.
 */
export type ChatNavigationSummaryWire = {
  activeRun: boolean;
  assistant: AssistantIdentity | null;
  folderId: string | null;
  id: string;
  /**
   * The scheduled task that posts or posted into this chat, with this chat's
   * unread marker. Present on current responses; absent (local upserts,
   * fixtures) means none.
   */
  scheduledTask?: ChatNavigationScheduledTaskWire | null;
  title: string;
  updatedAt: string;
};

export type ChatNavigationScheduledTaskWire = Readonly<{
  taskId: string;
  /** A result in this chat (an answer or a failure that paused the task) has not been seen yet. */
  unseen: boolean;
}>;

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

/**
 * A chat in the sidebar scope whose message text contains the query: its
 * newest matching message on any branch, how many of its messages match, and
 * plain readable text around the first match in that message. The browser
 * highlights the query; the server sends no markup.
 */
export type ChatMessageMatchWire = {
  chatId: string;
  /** When the matching message was written. */
  createdAt: string;
  matchCount: number;
  messageId: string;
  snippet: string;
  title: string;
};

/**
 * A page of `/api/chats/search/messages`, requested beside the title search
 * so a broad message query never delays or fails the title results. Matches
 * are ordered and paged like the title results: newest chat first.
 */
export type ChatMessageMatchPageWire = {
  matches: ChatMessageMatchWire[];
  nextCursor: string | null;
};

export type DecodedWorkspaceChatsResponse = {
  chats: WorkspaceChatSummaryWire[];
  folders: FolderWire[];
};

export type ChatNavigationErrorCode =
  | SessionErrorCode
  | "chat_navigation_cursor_invalid"
  | "chat_navigation_query_invalid"
  | "chat_navigation_search_timeout";

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

export function decodeChatUsageStats(value: unknown): ChatUsageStats | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const recordCount = nonNegativeInteger(value.recordCount);
  const knownCostRecordCount = nonNegativeInteger(value.knownCostRecordCount);
  const incompleteRecordCount = nonNegativeInteger(value.incompleteRecordCount);
  const fields = ["estimatedCostMicros", "totalTokens"] as const;
  if (typeof value.hasCompletedAnswer !== "boolean" || value.titleUsagePending !== undefined && typeof value.titleUsagePending !== "boolean" ||
    recordCount === null || knownCostRecordCount === null || incompleteRecordCount === null ||
    ![recordCount, knownCostRecordCount, incompleteRecordCount].every(Number.isSafeInteger) ||
    knownCostRecordCount > recordCount || incompleteRecordCount > recordCount ||
    (knownCostRecordCount === 0) !== (value.estimatedCostMicros === null) ||
    fields.some((field) => value[field] !== null && (nonNegativeInteger(value[field]) === null || !Number.isSafeInteger(value[field])))) return undefined;
  return { hasCompletedAnswer: value.hasCompletedAnswer, recordCount, knownCostRecordCount, incompleteRecordCount,
    ...(value.titleUsagePending === true ? { titleUsagePending: true } : {}),
    estimatedCostMicros: value.estimatedCostMicros as number | null,
    totalTokens: value.totalTokens as number | null };
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.toISOString() !== value ? null : value;
}

function decodeContextStats(value: unknown): ChatContextStats | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "approximateActiveBranchInputTokens",
    ...["session", "sessionMessageId", "sessionBranchLeafId", "approximateInputTokensAfterSession"]
      .filter((key) => key in value)
  ])) {
    return null;
  }
  const approximateActiveBranchInputTokens = nonNegativeInteger(
    value.approximateActiveBranchInputTokens
  );
  const session = value.session == null ? null : decodeSessionContextStatus(value.session);
  if (value.session != null && session === null) return null;
  const sessionMessageId = value.sessionMessageId === undefined ? null : nullableId(value.sessionMessageId);
  if (sessionMessageId === undefined || (sessionMessageId !== null && !session)) return null;
  const sessionBranchLeafId = value.sessionBranchLeafId === undefined ? null : nullableId(value.sessionBranchLeafId);
  const approximateInputTokensAfterSession = value.approximateInputTokensAfterSession === undefined
    ? 0 : nonNegativeInteger(value.approximateInputTokensAfterSession);
  if (sessionBranchLeafId === undefined || approximateInputTokensAfterSession === null ||
    !Number.isSafeInteger(approximateInputTokensAfterSession) ||
    ((sessionBranchLeafId !== null || approximateInputTokensAfterSession > 0) && (!session || !sessionMessageId))) return null;
  return approximateActiveBranchInputTokens === null
    ? null
    : { approximateActiveBranchInputTokens, ...(session ? { session } : {}),
        ...(sessionMessageId ? { sessionMessageId } : {}),
        ...(sessionBranchLeafId ? { sessionBranchLeafId } : {}),
        ...(session ? { approximateInputTokensAfterSession } : {}) };
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

function boundedText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= maxLength ? value : null;
}

/** The server's citation projection: an http(s) or mailto link of at most 2,048 characters. */
function citationHref(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2_048 ||
    value.startsWith("//") ||
    /[\u0000-\u001F\u007F\s]/u.test(value)
  ) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:"
      ? value
      : null;
  } catch {
    return null;
  }
}

function decodeThreadCitation(value: unknown): ThreadCitation | null {
  if (!isRecord(value)) {
    return null;
  }

  const index = nonNegativeInteger(value.index);
  const title = boundedText(value.title, 500);
  const url = citationHref(value.url);
  if (index === null || !title || !url) {
    return null;
  }
  const snippet = boundedText(value.snippet, 2_000);
  const source = boundedText(value.source, 200);

  return {
    index,
    ...(snippet ? { snippet } : {}),
    ...(source ? { source } : {}),
    title,
    url
  };
}

/** Keeps each decodable, first-seen item up to the bound; the rest is dropped one by one. */
function decodeOptionalItems<T>(
  value: unknown,
  decode: (item: unknown) => T | null,
  maxItems: number,
  key?: (item: T) => string
): Readonly<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  if (!Array.isArray(value)) return { items, truncated: false };
  const seen = new Set<string>();
  for (const candidate of value) {
    const item = decode(candidate);
    if (item === null || key && seen.has(key(item))) continue;
    if (items.length >= maxItems) return { items, truncated: true };
    if (key) seen.add(key(item));
    items.push(item);
  }
  return { items, truncated: false };
}

/** Keeps each file whose addition still satisfies the Workspace list rules. */
function decodeOptionalGeneratedFiles(value: unknown): ThreadGeneratedFile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const whole = decodeThreadGeneratedFiles(value);
  if (whole) return whole;
  let files: ThreadGeneratedFile[] = [];
  for (const candidate of value) {
    files = decodeThreadGeneratedFiles([...files, candidate]) ?? files;
  }
  return files;
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

/**
 * Decode both the camel-case durable/client projection and the snake-case
 * receipt emitted by the artifact tool. The latter is accepted only at this
 * internal boundary; callers always receive the client-safe shape.
 */
export function decodeThreadGeneratedArtifact(value: unknown): ThreadGeneratedArtifact | null {
  if (!isRecord(value)) return null;
  const candidate = "artifactId" in value || "versionId" in value
    ? value
    : {
        byteSize: value.byte_size,
        artifactId: value.artifact_id,
        entrypoint: value.entrypoint,
        kind: value.kind,
        title: value.title,
        versionId: value.version_id,
        versionNumber: value.version_number
      };
  if (candidate.byteSize !== undefined && (!Number.isSafeInteger(candidate.byteSize) || Number(candidate.byteSize) < 0 || Number(candidate.byteSize) > 32 * 1024 * 1024)) return null;
  if (!requiredString(candidate.artifactId) || !requiredString(candidate.versionId) ||
    !requiredString(candidate.title) || !Number.isSafeInteger(candidate.versionNumber) ||
    (candidate.versionNumber as number) < 1 ||
    !["chart", "game", "html", "image", "slides", "svg"].includes(String(candidate.kind)) ||
    candidate.entrypoint !== null && candidate.entrypoint !== undefined && !requiredString(candidate.entrypoint)) return null;
  return {
    ...(candidate.byteSize !== undefined ? { byteSize: Number(candidate.byteSize) } : {}),
    artifactId: candidate.artifactId as string,
    entrypoint: candidate.entrypoint === undefined ? null : candidate.entrypoint as string | null,
    kind: candidate.kind as ThreadGeneratedArtifact["kind"],
    title: candidate.title as string,
    versionId: candidate.versionId as string,
    versionNumber: candidate.versionNumber as number
  };
}

/**
 * Every summary field is optional presentation data. An invalid or over-limit
 * value is dropped, or cut and marked, on its own; it never invalidates the
 * message, its history page or a terminal chat update. Unknown values (a newer
 * server's enum member, a private field) are left out rather than guessed.
 */
function decodeThreadArtifactSummary(value: unknown): ThreadArtifactSummary | null {
  if (!isRecord(value)) {
    return null;
  }

  const citations = decodeOptionalItems(value.citations, decodeThreadCitation, THREAD_CITATION_MAX_ITEMS);
  const sources = decodeOptionalItems(value.sources, decodeThreadSearchSource, THREAD_SEARCH_SOURCE_MAX_ITEMS);
  const reasoning = boundThreadReasoningText(Array.isArray(value.reasoningText)
    ? value.reasoningText.filter((text): text is string => typeof text === "string" && text.trim().length > 0)
    : []);
  const contextCompaction = value.contextCompaction === undefined
    ? null
    : decodeContextCompactionStatus(value.contextCompaction);
  const groundingDisplay: ThreadGroundingDisplay | null | undefined = value.groundingDisplay === null
    ? null
    : value.groundingDisplay === undefined
      ? undefined
      : decodeThreadGroundingDisplay(value.groundingDisplay) ?? undefined;
  const generatedImages = Array.isArray(value.generatedImages)
    ? decodeOptionalItems(value.generatedImages, decodeThreadGeneratedImage, 16, (image) => image.attachmentId).items
    : undefined;
  const generatedFiles = decodeOptionalGeneratedFiles(value.generatedFiles);
  const generatedArtifacts = Array.isArray(value.generatedArtifacts)
    ? decodeOptionalItems(value.generatedArtifacts, decodeThreadGeneratedArtifact, 16, (artifact) => artifact.versionId).items
    : undefined;
  const knowledgeCitations = Array.isArray(value.knowledgeCitations)
    ? decodeOptionalItems(value.knowledgeCitations, decodeThreadKnowledgeCitation, 24, (citation) => citation.handle).items
    : undefined;
  const knowledgeState: ThreadKnowledgeAnswerState | undefined = isRecord(value.knowledgeState) &&
    (value.knowledgeState.answer === "answered" || value.knowledgeState.answer === "insufficient_evidence") &&
    (value.knowledgeState.scope === "ready" || value.knowledgeState.scope === "partial_sources_ready")
    ? { answer: value.knowledgeState.answer, scope: value.knowledgeState.scope }
    : undefined;
  const memoryActionResult = value.memoryAction === undefined ? null : decodeMemoryActionFeedback(value.memoryAction);
  const memoryAction: MemoryActionFeedback | undefined = memoryActionResult?.ok ? memoryActionResult.value : undefined;
  const memorySources = Array.isArray(value.memorySources)
    ? decodeOptionalItems(value.memorySources, (source) => {
        const decoded = decodeMemoryAnswerSource(source);
        return decoded.ok ? decoded.value : null;
      }, MEMORY_ANSWER_SOURCE_MAX_ITEMS).items
    : undefined;
  const memoryStatus = value.memoryStatus === "INPUT_TOO_LONG" || value.memoryStatus === "LIMITED" ||
    value.memoryStatus === "UNAVAILABLE"
    ? value.memoryStatus
    : undefined;
  const skillCatalogOmittedCount = Number.isSafeInteger(value.skillCatalogOmittedCount) &&
    (value.skillCatalogOmittedCount as number) >= 0
    ? value.skillCatalogOmittedCount as number
    : undefined;
  const workDurationMs = Number.isSafeInteger(value.workDurationMs) && (value.workDurationMs as number) >= 0
    ? value.workDurationMs as number
    : undefined;
  const scheduledTasks = Array.isArray(value.scheduledTasks)
    ? decodeOptionalItems(value.scheduledTasks, decodeScheduledTaskCard, SCHEDULED_TASK_CARDS_LIMIT, (card) => card.taskId).items
    : undefined;

  return {
    citations: citations.items,
    ...(citations.truncated || value.citationsTruncated === true ? { citationsTruncated: true as const } : {}),
    ...(contextCompaction ? { contextCompaction } : {}),
    ...(skillCatalogOmittedCount !== undefined ? { skillCatalogOmittedCount } : {}),
    ...(generatedArtifacts ? { generatedArtifacts } : {}),
    ...(generatedImages ? { generatedImages } : {}),
    ...(generatedFiles !== undefined ? { generatedFiles } : {}),
    ...(groundingDisplay !== undefined ? { groundingDisplay } : {}),
    ...(knowledgeState ? { knowledgeState } : {}),
    ...(knowledgeCitations !== undefined ? { knowledgeCitations } : {}),
    ...(memoryAction ? { memoryAction } : {}),
    ...(memoryStatus ? { memoryStatus } : {}),
    ...(memorySources !== undefined ? { memorySources } : {}),
    reasoningText: reasoning.reasoningText,
    ...(reasoning.truncated || value.reasoningTruncated === true ? { reasoningTruncated: true as const } : {}),
    ...(scheduledTasks?.length ? { scheduledTasks } : {}),
    sources: sources.items,
    ...(sources.truncated || value.sourcesTruncated === true ? { sourcesTruncated: true as const } : {}),
    ...(workDurationMs !== undefined ? { workDurationMs } : {})
  };
}

function decodeThreadKnowledgeCitation(value: unknown): ThreadKnowledgeCitation | null {
  if (!isRecord(value)) return null;
  const handle = requiredString(value.handle);
  if (!handle || !decodeKnowledgeCitationHandle(handle)) return null;
  if (value.deleted === true) return { deleted: true, handle };
  return { handle };
}

const decodeThreadAssistantIdentity = decodeAssistantIdentity;

function decodeThreadToolActivity(value: unknown): ThreadToolActivity | null {
  if (!isRecord(value) || !Array.isArray(value.calls)) return null;
  const calls: ThreadToolActivityCall[] = [];
  for (const candidate of value.calls) {
    if (!isRecord(candidate)) return null;
    if (candidate.origin !== undefined && !isThreadToolActivityOrigin(candidate.origin)) return null;
    const toolName = boundedRequiredString(candidate.toolName, 160);
    const serverName = candidate.serverName === undefined
      ? undefined
      : boundedRequiredString(candidate.serverName, 160);
    const round = nonNegativeInteger(candidate.round);
    const durationMs = candidate.durationMs === undefined
      ? undefined
      : nonNegativeInteger(candidate.durationMs);
    const status = candidate.status === "cancelled" || candidate.status === "complete" ||
      candidate.status === "error" || candidate.status === "running"
      ? candidate.status
      : null;
    if (!toolName || round === null || round < 1 || !status ||
      (candidate.serverName !== undefined && !serverName) ||
      (candidate.durationMs !== undefined && durationMs === null)) return null;
    if (candidate.memorySearchCall !== undefined &&
      (!Number.isSafeInteger(candidate.memorySearchCall) || Number(candidate.memorySearchCall) < 1)) return null;
    if (candidate.memorySearchOutcome !== undefined && !isMemorySearchActivityOutcome(candidate.memorySearchOutcome)) return null;
    let details: ThreadToolActivityCall["details"];
    if (candidate.details !== undefined) {
      if (candidate.origin !== "mcp" || !isRecord(candidate.details)) return null;
      const roundIndex = nonNegativeInteger(candidate.details.roundIndex);
      const ordinal = nonNegativeInteger(candidate.details.ordinal);
      if (roundIndex === null || !Number.isSafeInteger(roundIndex) || roundIndex < 1 || roundIndex !== round ||
        ordinal === null || !Number.isSafeInteger(ordinal)) return null;
      details = { roundIndex, ordinal };
    }
    calls.push({
      ...(details ? { details } : {}),
      ...(candidate.origin === "memory" && candidate.toolName === "memory_search" ? {
        ...(candidate.memorySearchCall !== undefined ? { memorySearchCall: Number(candidate.memorySearchCall) } : {}),
        ...(isMemorySearchActivityOutcome(candidate.memorySearchOutcome) ? { memorySearchOutcome: candidate.memorySearchOutcome } : {})
      } : {}),
      ...(candidate.origin === "skill" && typeof candidate.skillId === "string" && candidate.skillId.length <= 64 ? { skillId: candidate.skillId } : {}),
      ...(candidate.origin === "skill" && typeof candidate.skillName === "string" && candidate.skillName.length <= 160 ? { skillName: candidate.skillName } : {}),
      ...(candidate.origin === "skill" && typeof candidate.skillPath === "string" && candidate.skillPath.length <= 256 ? { skillPath: candidate.skillPath } : {}),
      ...(typeof durationMs === "number" ? { durationMs } : {}),
      ...(candidate.origin !== undefined ? { origin: candidate.origin } : {}),
      round,
      ...(serverName ? { serverName } : {}),
      status,
      toolName
    });
  }

  let warning: ThreadToolBudgetWarning | undefined;
  if (value.warning !== undefined) {
    const decoded = decodeThreadToolBudgetWarning(value.warning);
    if (!decoded) return null;
    warning = decoded;
  }
  let searchEngines: ThreadSearchEngineActivity[] | undefined;
  if (value.searchEngines !== undefined) {
    if (!Array.isArray(value.searchEngines) || value.searchEngines.length > 3) return null;
    const decoded = value.searchEngines.map(decodeThreadSearchEngineActivity);
    if (decoded.some(row => row === null) ||
      new Set(decoded.map(row => row?.engine)).size !== decoded.length) return null;
    searchEngines = decoded as ThreadSearchEngineActivity[];
  }
  return { calls, ...(searchEngines ? { searchEngines } : {}),
    ...(warning ? { warning } : {}) };
}

function decodeChatMessageWire(value: unknown): ChatMessageWire | null {
  if (!isRecord(value)) {
    return null;
  }

  const pdfPreparation = value.pdfPreparation === undefined ? undefined : decodeChatPdfPreparations(value.pdfPreparation);
  const followups = value.followups === undefined ? undefined : decodeRunFollowupState(value.followups);
  if (followups === null) return null;
  if (pdfPreparation === null) return null;
  const id = requiredString(value.id);
  const citationMessageId = value.citationMessageId === undefined
    ? null
    : nullableId(value.citationMessageId);
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
  if ((value.workspacePreparation !== undefined && value.workspacePreparation !== true) ||
    (value.workspaceSettling !== undefined && value.workspaceSettling !== true) ||
    (value.workspacePreparation === true && (role !== "assistant" || !["queued", "streaming"].includes(status ?? ""))) ||
    (value.workspaceSettling === true && (role !== "assistant" || status !== "complete"))) return null;
  // Optional answer outputs never decide whether the message itself is valid:
  // a summary that is not even an object is dropped, the message is kept.
  const artifactSummary: ThreadArtifactSummary | null | undefined =
    value.artifactSummary === undefined || value.artifactSummary === null
      ? value.artifactSummary
      : decodeThreadArtifactSummary(value.artifactSummary);
  let assistantIdentity: ThreadAssistantIdentity | null | undefined;
  if (value.assistantIdentity === undefined || value.assistantIdentity === null) {
    assistantIdentity = value.assistantIdentity;
  } else {
    assistantIdentity = decodeThreadAssistantIdentity(value.assistantIdentity);
    if (!assistantIdentity) {
      return null;
    }
  }
  let toolActivity: ThreadToolActivity | null | undefined;
  if (value.toolActivity === undefined || value.toolActivity === null) {
    toolActivity = value.toolActivity;
  } else {
    toolActivity = decodeThreadToolActivity(value.toolActivity);
    if (!toolActivity) return null;
  }
  let workspaceActivity: ThreadWorkspaceActivity | null | undefined;
  if (value.workspaceActivity === undefined || value.workspaceActivity === null) {
    workspaceActivity = value.workspaceActivity;
  } else {
    workspaceActivity = decodeThreadWorkspaceActivity(value.workspaceActivity);
    if (!workspaceActivity) return null;
  }
  let scheduledTask: ChatMessageScheduledTaskWire | null | undefined;
  if (value.scheduledTask === undefined || value.scheduledTask === null) {
    scheduledTask = value.scheduledTask;
  } else {
    const marker = isRecord(value.scheduledTask) && hasExactKeys(value.scheduledTask, ["taskId", "taskRunId", "title", "unseen"])
      ? value.scheduledTask : null;
    const taskId = marker ? requiredString(marker.taskId) : null;
    const taskRunId = marker ? requiredString(marker.taskRunId) : null;
    const title = marker ? requiredString(marker.title) : null;
    if (!marker || !taskId || taskId.length > 128 || !taskRunId || taskRunId.length > 128 || !title ||
      codePointLength(title) > CHAT_TITLE_MAX_LENGTH || typeof marker.unseen !== "boolean") return null;
    scheduledTask = { taskId, taskRunId, title, unseen: marker.unseen };
  }
  const scheduledOutcome: ScheduledTaskCheckOutcome | undefined = isScheduledTaskCheckOutcome(value.scheduledOutcome)
    ? value.scheduledOutcome : undefined;
  if (value.scheduledOutcome !== undefined && scheduledOutcome === undefined) return null;
  let author: ProjectMessageAuthorWire | null | undefined;
  if (value.author === undefined || value.author === null) {
    author = value.author;
  } else if (
    isRecord(value.author) &&
    typeof value.author.displayName === "string" &&
    (value.author.userId === null || typeof value.author.userId === "string") &&
    ["CONTRIBUTOR", "MANAGER", "OWNER", "VIEWER"].includes(String(value.author.role))
  ) {
    author = {
      displayName: value.author.displayName,
      role: value.author.role as ProjectMessageAuthorWire["role"],
      userId: value.author.userId as string | null
    };
  } else {
    return null;
  }
  if (
    !id ||
    citationMessageId === undefined ||
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
    ...(pdfPreparation ? { pdfPreparation } : {}),
    ...(followups ? { followups } : {}),
    ...(value.workspacePreparation === true ? { workspacePreparation: true as const } : {}),
    ...(value.workspaceSettling === true ? { workspaceSettling: true as const } : {}),
    artifactSummary,
    ...(assistantIdentity !== undefined ? { assistantIdentity } : {}),
    ...(author !== undefined ? { author } : {}),
    citationMessageId,
    content: value.content,
    createdAt,
    errorMessage,
    id,
    modelId,
    modelRunId,
    parentMessageId,
    provider,
    role,
    ...(scheduledTask !== undefined ? { scheduledTask } : {}),
    ...(scheduledOutcome !== undefined ? { scheduledOutcome } : {}),
    status,
    ...(toolActivity !== undefined ? { toolActivity } : {}),
    ...(workspaceActivity !== undefined ? { workspaceActivity } : {})
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
  if (!isRecord(value) || (value.titlePending !== undefined && typeof value.titlePending !== "boolean") || (value.hasContinuationSource !== undefined && typeof value.hasContinuationSource !== "boolean")) {
    return null;
  }

  const activeLeafMessageId = nullableId(value.activeLeafMessageId);
  const assistantId = value.assistantId === undefined ? undefined : nullableId(value.assistantId);
  const id = requiredString(value.id);
  const createdAt = requiredString(value.createdAt);
  const defaultSelection = decodeChatDefaultSelection(
    value.defaultModelId,
    value.defaultProvider
  );
  const defaultKnowledgePlan = decodeKnowledgeDefault(value.defaultKnowledgePlan);
  const search = value.defaultSearchPlan == null ? null : decodeSearchPlan(value.defaultSearchPlan);
  if (search && !search.ok) return null;
  const folderId = nullableId(value.folderId);
  const messageCount = nonNegativeInteger(value.messageCount);
  const projectId = value.projectId === undefined ? null : nullableId(value.projectId);
  const title = requiredString(value.title);
  const updatedAt = requiredString(value.updatedAt);
  const workspace = value.workspace === undefined
    ? undefined
    : decodeChatWorkspaceState(value.workspace);
  if (
    activeLeafMessageId === undefined ||
    (value.assistantId !== undefined && assistantId === undefined) ||
    !id ||
    !createdAt ||
    defaultKnowledgePlan === undefined ||
    !defaultSelection ||
    folderId === undefined ||
    messageCount === null ||
    projectId === undefined ||
    typeof value.pinned !== "boolean" ||
    !title ||
    !updatedAt ||
    workspace === null
  ) {
    return null;
  }

  return {
    activeLeafMessageId,
    ...(assistantId !== undefined ? { assistantId } : {}),
    createdAt,
    ...(value.hasContinuationSource === true ? { hasContinuationSource: true } : {}),
    ...(value.titlePending === true ? { titlePending: true } : {}),
    defaultKnowledgePlan,
    ...(search?.ok ? { defaultSearchPlan: search.plan } : {}),
    defaultModelId: defaultSelection.defaultModelId,
    defaultProvider: defaultSelection.defaultProvider,
    folderId,
    id,
    messageCount,
    pinned: value.pinned,
    projectId,
    title,
    updatedAt,
    ...(workspace ? { workspace } : {})
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

const CHAT_NAVIGATION_SUMMARY_KEYS = ["activeRun", "assistant", "folderId", "id", "title", "updatedAt"] as const;

function decodeChatNavigationScheduledTask(value: unknown): ChatNavigationScheduledTaskWire | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ["taskId", "unseen"])) return undefined;
  const taskId = requiredString(value.taskId);
  return taskId && taskId.length <= 128 && typeof value.unseen === "boolean"
    ? { taskId, unseen: value.unseen }
    : undefined;
}

function decodeChatNavigationSummaryWire(
  value: unknown
): ChatNavigationSummaryWire | null {
  if (
    !isRecord(value) ||
    (!hasExactKeys(value, CHAT_NAVIGATION_SUMMARY_KEYS) &&
      !hasExactKeys(value, [...CHAT_NAVIGATION_SUMMARY_KEYS, "scheduledTask"]))
  ) {
    return null;
  }
  const scheduledTask = "scheduledTask" in value
    ? decodeChatNavigationScheduledTask(value.scheduledTask)
    : null;
  if (scheduledTask === undefined) return null;
  const assistant = value.assistant === null ? null : decodeAssistantIdentity(value.assistant);
  const folderId = nullableId(value.folderId);
  const id = requiredString(value.id);
  const title = requiredString(value.title);
  const updatedAt = isoTimestamp(value.updatedAt);
  if (
    typeof value.activeRun !== "boolean" ||
    (value.assistant !== null && !assistant) ||
    folderId === undefined ||
    !id ||
    !title ||
    !updatedAt
  ) {
    return null;
  }
  return {
    activeRun: value.activeRun,
    assistant,
    folderId,
    id,
    ...(scheduledTask ? { scheduledTask } : {}),
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

/**
 * The form a sidebar query is matched in: compatibility characters folded,
 * trimmed and lowercased.
 */
export function normalizeChatNavigationQuery(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

/**
 * Whether message text matching applies to a query: at least
 * CHAT_MESSAGE_SEARCH_MIN_QUERY_LENGTH characters of its normalized form.
 */
export function chatMessageSearchApplies(query: string): boolean {
  return Array.from(normalizeChatNavigationQuery(query)).length >= CHAT_MESSAGE_SEARCH_MIN_QUERY_LENGTH;
}

function decodeNavigationCursor(value: unknown): string | null | undefined {
  const cursor = nullableId(value);
  return cursor === undefined || (cursor !== null && (
    cursor.length > CHAT_NAVIGATION_CURSOR_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(cursor)
  ))
    ? undefined
    : cursor;
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
  const nextCursor = decodeNavigationCursor(value.nextCursor);
  if (nextCursor === undefined) return null;
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

function decodeChatMessageMatchWire(value: unknown): ChatMessageMatchWire | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["chatId", "createdAt", "matchCount", "messageId", "snippet", "title"])
  ) {
    return null;
  }
  const chatId = requiredString(value.chatId);
  const createdAt = isoTimestamp(value.createdAt);
  const matchCount = nonNegativeInteger(value.matchCount);
  const messageId = requiredString(value.messageId);
  const title = requiredString(value.title);
  const snippet = typeof value.snippet === "string" &&
    value.snippet.length <= CHAT_MESSAGE_MATCH_SNIPPET_MAX_LENGTH
    ? value.snippet
    : null;
  return chatId && createdAt && messageId && title && snippet !== null &&
    matchCount !== null && matchCount > 0 && Number.isSafeInteger(matchCount)
    ? { chatId, createdAt, matchCount, messageId, snippet, title }
    : null;
}

export function decodeChatMessageMatchPage(
  value: unknown
): ChatMessageMatchPageWire | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["matches", "nextCursor"]) ||
    !Array.isArray(value.matches) ||
    value.matches.length > CHAT_NAVIGATION_MAX_PAGE_SIZE
  ) {
    return null;
  }
  const nextCursor = decodeNavigationCursor(value.nextCursor);
  const matches = value.matches.map(decodeChatMessageMatchWire);
  const decoded = matches.filter((match): match is ChatMessageMatchWire => match !== null);
  // One match per chat: a repeated chat means a malformed page, not two results.
  return nextCursor !== undefined && decoded.length === matches.length &&
    new Set(decoded.map((match) => match.chatId)).size === decoded.length
    ? { matches: decoded, nextCursor }
    : null;
}

export function decodeWorkspaceChatsResponse(
  value: unknown
): DecodedWorkspaceChatsResponse | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.chats) ||
    !Array.isArray(value.folders)
  ) {
    return null;
  }

  const chats = value.chats.map(decodeWorkspaceChatSummaryWire);
  const folders = value.folders.map(decodeFolderWire);
  if (
    chats.some((chat) => !chat) ||
    folders.some((folder) => !folder)
  ) {
    return null;
  }

  return {
    chats: chats.filter((chat): chat is WorkspaceChatSummaryWire => Boolean(chat)),
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
  // Absent only in fixtures that predate the projection.
  const assistant = value.chat.assistant === undefined || value.chat.assistant === null
    ? null
    : decodeChatAssistantProjection(value.chat.assistant);
  const contextStats = decodeContextStats(value.chat.contextStats);
  const usageStats = decodeChatUsageStats(value.chat.usageStats);
  const page = decodeMessagePage(value.chat.messages, value.chat.pageInfo, {
    requireActiveLeaf: true
  });
  if (
    !chat ||
    (value.chat.assistant != null && !assistant) ||
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
    assistant,
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
      "lastMessageAt",
      "memoryMode",
      "messageCount",
      "pinned",
      "projectId",
      "sourceRevision",
      "title",
      "updatedAt",
      ...(Object.hasOwn(value, "assistantId") ? ["assistantId"] : []),
      ...(Object.hasOwn(value, "defaultSearchPlan") ? ["defaultSearchPlan"] : []),
      ...(Object.hasOwn(value, "workspace") ? ["workspace"] : [])
    ])
  ) return null;
  if (value.projectId !== null) return null;
  const summary = decodeWorkspaceChatSummaryWire(value);
  const lastMessageAt = value.lastMessageAt === null
    ? null
    : isoTimestamp(value.lastMessageAt);
  const memoryMode = retainedMemoryMode(value.memoryMode);
  const sourceRevision = nonNegativeInteger(value.sourceRevision);
  return summary &&
    (value.lastMessageAt === null || lastMessageAt !== null) &&
    memoryMode &&
    sourceRevision !== null &&
    Number.isSafeInteger(sourceRevision)
    ? { ...summary, archived: true, lastMessageAt, memoryMode, sourceRevision }
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
  // A read-only archived preview never carries Assistant state.
  if (!detail || !isRecord(value) || !isRecord(value.chat) || value.chat.archived !== true ||
    detail.assistant !== null) {
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
    "projectId",
    "sourceRevision",
    "title",
    "updatedAt",
    "usageStats",
    ...(Object.hasOwn(value.chat, "assistant") ? ["assistant"] : []),
    ...(Object.hasOwn(value.chat, "assistantId") ? ["assistantId"] : []),
    ...(Object.hasOwn(value.chat, "hasContinuationSource") ? ["hasContinuationSource"] : []),
    ...(Object.hasOwn(value.chat, "defaultSearchPlan") ? ["defaultSearchPlan"] : []),
    ...(Object.hasOwn(value.chat, "workspace") ? ["workspace"] : [])
  ])) return null;
  if (value.chat.projectId !== null) return null;
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
  const usageStats = decodeChatUsageStats(value.chat.usageStats);
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

/*
 * Chat Assistant binding. A chat stores the rows the user changed for it in
 * the vocabulary of an ordinary chat; a present key means "changed for this
 * chat". Only adjustable rows can be changed.
 */
export type ChatAssistantOverrideValues = {
  controls: AssistantRunControls;
  knowledge:
    | { mode: "all_my_knowledge" }
    | { mode: "none" }
    | { baseIds: string[]; mode: "explicit"; sourceIds: string[] };
  model: { mode: "model"; modelId: string };
  search: { mode: "off" } | { mode: SearchPlanMode; optionIds: string[] };
  skills: SkillsSelection;
  tools: McpRunSelection;
};

export type ChatAssistantOverrides = Partial<ChatAssistantOverrideValues>;

/** A value changes the row for this chat; null returns the row to the Assistant. */
export type ChatAssistantOverridesPatch = {
  [Key in AssistantRowKey]?: ChatAssistantOverrideValues[Key] | null;
};

/**
 * Stored in place of the overrides when the chat's Assistant was deleted;
 * the chat then projects the `deleted` state. No other key accompanies it.
 */
export const CHAT_ASSISTANT_DELETED_MARKER: Readonly<{ assistantDeleted: true }> =
  Object.freeze({ assistantDeleted: true });

export type StoredChatAssistantOverrides =
  | { kind: "deleted" }
  | { kind: "overrides"; overrides: ChatAssistantOverrides };

/** Effective values may also be the user's own defaults, in ordinary chat vocabulary. */
export type ChatAssistantRowValues = {
  controls: AssistantRunControls;
  knowledge: Exclude<AssistantKnowledgeValue, { mode: "inherit" }> | { mode: "all_my_knowledge" };
  model: Exclude<AssistantModelValue, { mode: "inherit" }>;
  search: Exclude<AssistantSearchValue, { mode: "inherit" }>;
  skills: AssistantSkillsValue;
  tools: Exclude<AssistantToolsValue, { mode: "inherit" }> | McpRunSelection;
};

export type ChatAssistantRow<Key extends AssistantRowKey> = {
  /** The Assistant's own value, for "Reset to Assistant"; redacted like Assistant content. */
  assistantValue: AssistantRowValues[Key];
  /** Set when the Assistant's adjustable value is unavailable to the viewer. */
  deviation: AssistantRowDeviation | null;
  policy: AssistantRowPolicy;
  provenance: AssistantRowProvenance;
  /** The value the next message uses. */
  value: ChatAssistantRowValues[Key];
};

export type ChatAssistantRows = { [Key in AssistantRowKey]: ChatAssistantRow<Key> };

export type ChatAssistantProjection =
  | {
      availability: AssistantAvailability;
      avatar: AssistantAvatarRecipe;
      id: string;
      name: string;
      owned: boolean;
      ownerDisplayName: string;
      rows: ChatAssistantRows;
      state: "bound";
    }
  /**
   * Bound to an Assistant the viewer can no longer use; nothing about it is
   * disclosed beyond `archived` when its owner archived one the viewer still has.
   */
  | { reason?: "archived"; state: "unavailable" }
  /** The bound Assistant was deleted; answers keep their identity snapshots. */
  | { state: "deleted" };

export type ChatAssistantUpdate = {
  assistantId?: string | null;
  assistantOverrides?: ChatAssistantOverridesPatch;
};

function withoutInherit<T extends { mode: string }>(value: T | null): Exclude<T, { mode: "inherit" }> | null {
  return value && value.mode !== "inherit" ? value as Exclude<T, { mode: "inherit" }> : null;
}

function allMyKnowledge(value: unknown): { mode: "all_my_knowledge" } | null {
  return isRecord(value) && value.mode === "all_my_knowledge" && Object.keys(value).length === 1
    ? { mode: "all_my_knowledge" }
    : null;
}

function decodeChatAssistantOverrideValue<Key extends AssistantRowKey>(
  key: Key,
  value: unknown
): ChatAssistantOverrideValues[Key] | null {
  const decoded: ChatAssistantOverrideValues[AssistantRowKey] | null =
    key === "controls" ? decodeAssistantRunControls(value)
      : key === "model" ? withoutInherit(decodeAssistantModelValue(value)) as ChatAssistantOverrideValues["model"] | null
        : key === "search" ? withoutInherit(decodeAssistantSearchValue(value))
          : key === "tools" ? decodeMcpRunSelection(value)
            : key === "knowledge" ? allMyKnowledge(value) ?? withoutInherit(decodeAssistantKnowledgeValue(value))
              : isRecord(value) ? decodeSkillsSelection(value) : null;
  return decoded as ChatAssistantOverrideValues[Key] | null;
}

function decodeOverrideEntries(
  value: Record<string, unknown>,
  allowNull: boolean
): { ok: true; value: ChatAssistantOverridesPatch } | { ok: false; row?: AssistantRowKey } {
  const decoded: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value)) {
    const key = decodeAssistantRowKey(name);
    if (!key) return { ok: false };
    if (entry === null && allowNull) {
      decoded[key] = null;
      continue;
    }
    const override = decodeChatAssistantOverrideValue(key, entry);
    if (!override) return { ok: false, row: key };
    decoded[key] = override;
  }
  return { ok: true, value: decoded as ChatAssistantOverridesPatch };
}

/** Reads `Chat.assistantOverrides`; null means the stored value is not a valid shape. */
export function decodeStoredChatAssistantOverrides(value: unknown): StoredChatAssistantOverrides | null {
  if (value === null || value === undefined) return { kind: "overrides", overrides: {} };
  if (!isRecord(value)) return null;
  if ("assistantDeleted" in value) {
    return Object.keys(value).length === 1 && value.assistantDeleted === true ? { kind: "deleted" } : null;
  }
  const decoded = decodeOverrideEntries(value, false);
  return decoded.ok ? { kind: "overrides", overrides: decoded.value as ChatAssistantOverrides } : null;
}

/** The column value for a set of overrides: null when no row was changed. */
export function storedChatAssistantOverrides(overrides: ChatAssistantOverrides): ChatAssistantOverrides | null {
  return Object.keys(overrides).length > 0 ? overrides : null;
}

/** Applies a PATCH: values replace rows, null removes them. */
export function applyChatAssistantOverridesPatch(
  current: ChatAssistantOverrides,
  patch: ChatAssistantOverridesPatch
): ChatAssistantOverrides {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return next as ChatAssistantOverrides;
}

/**
 * Decodes the two Assistant fields of a chat update when present. A malformed
 * id gets the same neutral code as an Assistant the requester cannot use.
 */
export function decodeChatAssistantUpdate(
  body: Readonly<Record<string, unknown>>
):
  | { ok: true; update: ChatAssistantUpdate }
  | { code: "assistant_not_available" | "assistant_overrides_invalid"; ok: false; row?: AssistantRowKey } {
  const update: ChatAssistantUpdate = {};
  if ("assistantId" in body && body.assistantId !== undefined) {
    if (body.assistantId !== null && !isAssistantReferenceId(body.assistantId)) {
      return { code: "assistant_not_available", ok: false };
    }
    update.assistantId = body.assistantId;
  }
  if ("assistantOverrides" in body && body.assistantOverrides !== undefined) {
    const patch = isRecord(body.assistantOverrides)
      ? decodeOverrideEntries(body.assistantOverrides, true)
      : { ok: false as const };
    if (!patch.ok) {
      return { code: "assistant_overrides_invalid", ok: false, ...(patch.row ? { row: patch.row } : {}) };
    }
    update.assistantOverrides = patch.value;
  }
  return { ok: true, update };
}

function decodeChatEffectiveValue<Key extends AssistantRowKey>(
  key: Key,
  value: unknown
): ChatAssistantRowValues[Key] | null {
  const decoded: ChatAssistantRowValues[AssistantRowKey] | null =
    key === "controls" ? decodeAssistantRunControls(value)
      : key === "model" ? withoutInherit(decodeAssistantModelValue(value, "projection"))
        : key === "search" ? withoutInherit(decodeAssistantSearchValue(value, "projection"))
          : key === "tools" ? decodeMcpRunSelection(value) ??
            withoutInherit(decodeAssistantToolsValue(value, "projection"))
            : key === "knowledge" ? allMyKnowledge(value) ??
              withoutInherit(decodeAssistantKnowledgeValue(value, "projection"))
              : decodeAssistantSkillsValue(value, "projection");
  return decoded as ChatAssistantRowValues[Key] | null;
}

function decodeAssistantOwnValue<Key extends AssistantRowKey>(
  key: Key,
  value: unknown
): AssistantRowValues[Key] | null {
  const decoded: AssistantRowValues[AssistantRowKey] | null =
    key === "controls" ? decodeAssistantRunControls(value)
      : key === "model" ? decodeAssistantModelValue(value, "projection")
        : key === "search" ? decodeAssistantSearchValue(value, "projection")
          : key === "tools" ? decodeAssistantToolsValue(value, "projection")
            : key === "knowledge" ? decodeAssistantKnowledgeValue(value, "projection")
              : decodeAssistantSkillsValue(value, "projection");
  return decoded as AssistantRowValues[Key] | null;
}

function decodeChatAssistantRow<Key extends AssistantRowKey>(
  key: Key,
  value: unknown,
  owned: boolean
): ChatAssistantRow<Key> | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["assistantValue", "deviation", "policy", "provenance", "value"])
  ) {
    return null;
  }
  const assistantValue = decodeAssistantOwnValue(key, value.assistantValue);
  const deviation = value.deviation === null ? null : decodeAssistantRowDeviation(key, value.deviation, owned);
  const policy = decodeAssistantRowPolicy(value.policy);
  const provenance = decodeAssistantRowProvenance(value.provenance);
  const effective = decodeChatEffectiveValue(key, value.value);
  if (!assistantValue || (value.deviation !== null && !deviation) || !policy || !provenance || !effective) {
    return null;
  }
  const inherits = "mode" in assistantValue && assistantValue.mode === "inherit";
  const hasMode = key !== "controls" && key !== "skills";
  if (
    // Only adjustable rows can be changed for a chat or fall back.
    (policy === "fixed" && (provenance === "chat" || provenance === "fallback" || deviation !== null)) ||
    (provenance === "fallback") !== (deviation !== null && provenance !== "chat") ||
    (hasMode && provenance === "default" && !inherits) ||
    (hasMode && provenance === "assistant" && inherits)
  ) {
    return null;
  }
  return { assistantValue, deviation, policy, provenance, value: effective };
}

export function decodeChatAssistantProjection(value: unknown): ChatAssistantProjection | null {
  if (!isRecord(value)) return null;
  if (value.state === "unavailable" && value.reason === "archived") {
    return Object.keys(value).length === 2 ? { reason: "archived", state: "unavailable" } : null;
  }
  if (value.state === "deleted" || value.state === "unavailable") {
    return Object.keys(value).length === 1 ? { state: value.state } : null;
  }
  if (
    value.state !== "bound" ||
    !hasExactKeys(value, ["availability", "avatar", "id", "name", "owned", "ownerDisplayName", "rows", "state"]) ||
    typeof value.owned !== "boolean" ||
    !isRecord(value.rows) ||
    !hasExactKeys(value.rows, ASSISTANT_ROW_KEYS)
  ) {
    return null;
  }
  const availability = decodeAssistantAvailability(value.availability);
  const avatar = decodeAssistantAvatarRecipe(value.avatar);
  const id = requiredString(value.id);
  const name = requiredString(value.name);
  if (
    !availability ||
    (!value.owned && !availability.ok && availability.dependencies !== undefined) ||
    !avatar ||
    !id ||
    !name ||
    typeof value.ownerDisplayName !== "string"
  ) {
    return null;
  }
  const rows: Partial<Record<AssistantRowKey, unknown>> = {};
  for (const key of ASSISTANT_ROW_KEYS) {
    const row = decodeChatAssistantRow(key, value.rows[key], value.owned);
    if (!row) return null;
    rows[key] = row;
  }
  return {
    availability,
    avatar,
    id,
    name,
    owned: value.owned,
    ownerDisplayName: value.ownerDisplayName,
    rows: rows as ChatAssistantRows,
    state: "bound"
  };
}
