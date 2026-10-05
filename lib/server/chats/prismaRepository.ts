import { decodeSearchPlan } from "../../domain/search";
import { runFollowupSelect } from "../runs/prismaRepositoryFollowups";
import { projectMessageFollowups } from "../runs/runFollowups";
import { loadChatUsageTotals } from "./usageTotals";
import { chatTitleMetadataSelect, chatTitlePending } from "./titleMetadata";
import { decodeThreadGeneratedImage } from "../../contracts/imageGeneration";
import { decodeContextCompactionStatus, mergeContextCompactionStatus, type ContextCompactionStatus } from "../../contracts/contextCompaction";
import { decodeThreadGeneratedArtifact } from "../../contracts/chats";
import {
  decodeScheduledTaskCard,
  foldScheduledTaskCards,
  isScheduledTaskCheckOutcome,
  scheduledTaskCard,
  type ScheduledTask,
  type ScheduledTaskCard
} from "../../contracts/scheduledTasks";
import { isMonitoringVerdictCall } from "../tools/monitoringVerdict";
import { scheduledTaskRowSelect, toScheduledTask } from "../scheduledTasks/store";
import { projectGroundingDisplay } from "../runs/runOutputEvents";
import { displayedToolCallState } from "../runs/toolLoopPersistence";
import { decodeSessionContextStatus } from "../../contracts/sessionStatus";
import { projectChatPdfPreparation } from "../uploads/chatPdfProjection";
import { Prisma } from "@prisma/client";
import { mergeWorkspaceActivity } from "@/lib/domain/workspaceActivity";
import { workspaceActivitySnapshot, WORKSPACE_ACTIVITY_SNAPSHOT } from "../runs/workspaceActivityPersistence";
import {
  estimateApproxTokensFromProjectedParts,
  type ApproxTokenProjectedPart
} from "../../domain/contextBudget";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import {
  answerCitationsFromGrounding,
  foldAnswerCitations,
  projectAnswerCitation
} from "../../domain/answerCitations";
import {
  foldReasoningEntries,
  storedReasoningFoldItem,
  type ReasoningFoldItem
} from "../../domain/answerReasoning";
import {
  WORKSPACE_EXPORT_MAX_ATTEMPTS,
  isRetryableWorkspaceExportErrorCode
} from "../../domain/workspace";
import {
  decodeThreadWorkspaceActivityEntry,
  isWorkspaceErrorCode,
  type ThreadWorkspaceActivity,
  type ThreadWorkspaceActivityEntry,
  type ThreadWorkspaceOutputStatus
} from "../../contracts/workspace";
import { foldWorkspaceActivityEntries, workspaceActivityEntryId, workspaceLifecycleActivity } from "../workspace/activityProjection";
import { collectThreadSearchSources } from "../../domain/searchSources";
import { projectSearchEngineActivity } from "../search/activityProjection";
import { decodeThreadSearchActivitySnapshot } from "../../contracts/searchActivity";
import { latestGeneratedArtifactsForAnswer } from "../../domain/generatedArtifacts";
import { decodeAssistantIdentity } from "../../contracts/assistants";
import {
  ARCHIVED_CHAT_CURSOR_MAX_LENGTH,
  ARCHIVED_CHAT_PAGE_SIZE,
  CHAT_BRANCH_PREVIEW_MAX_LENGTH,
  CHAT_HISTORY_CURSOR_MAX_LENGTH,
  CHAT_HISTORY_PAGE_SIZE,
  THREAD_SEARCH_SOURCE_MAX_ITEMS,
  boundedChatBranchPreview,
  decodeStoredChatAssistantOverrides,
  storedChatAssistantOverrides,
  type ChatAssistantOverrides,
  type ChatAssistantOverridesPatch,
  type ChatContextStats
} from "../../contracts/chats";
import {
  decodeKnowledgeCitationHandle,
  decodeKnowledgePlan,
  knowledgeCitationHandlesFromText,
  KNOWLEDGE_CITATION_INVOCATION_MAX,
  type KnowledgePlan
} from "../../contracts/knowledge";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  MEMORY_TEMPORARY_RETENTION_POLICY_VERSION,
  type MemoryActionFeedback,
  type MemoryAnswerSource
} from "../../contracts/memoryClient";
import { loadMemoryRunSources } from "../memory/sources/runProjection";
import {
  loadMemoryRunPresentationStatuses,
  type MemoryRunPresentationStatus
} from "../memory/retrieval/runProjection";
import { prisma } from "../prisma";
import { isAssistantAvailable, type AssistantBindingScope } from "../assistants/bindingAccess";
import type { CatalogData } from "../catalog/currentUserCatalog";
import { createPrismaCatalogDataLoader } from "../catalog/prismaCatalogData";
import { ActiveRunConflictError } from "../runs/runRepositoryContract";
import { resolveChatAccess } from "../projects/access";
import { loadProjectAssistantAuthority } from "../projects/prismaRepository";
import {
  loadProjectChatDefaultAuthority,
  projectChatDefaultsProjection,
  type ProjectChatDefaultAuthority
} from "../projects/chatDefaults";
import { projectRoleAtLeast } from "../../domain/projects";
import type {
  ChatBranchGraphRecord,
  ChatDetailRecord,
  ChatRepository,
  ChatSummaryRecord,
  ChatUsageStats,
  ThreadArtifactSummary,
  ThreadCitation,
  ThreadToolActivity
} from "./handlers";
import type {
  ArchivedChatDetailRecord,
  ArchivedChatSummaryRecord,
  ChatLifecycleMutationResult,
  ChatLifecycleRepository
} from "./lifecycleHandlers";
import {
  chatAssistantOverrideCatalog,
  chatAssistantOverridesIssue,
  knowledgeOverrideAvailable,
  loadAssistantRows,
  nextChatAssistantOverrides,
  overridesNeedCatalog,
  projectKnowledgeOverrideAvailable,
  projectOverridesNeedAuthority,
  type ChatAssistantOverrideCatalog
} from "./assistantOverrides";
import {
  loadChatAssistantProjection,
  loadProjectChatAssistant,
  type ProjectChatAssistantLoader
} from "./assistantProjection";
import { ChatAssistantUpdateError } from "./assistantUpdateError";
import { loadChatCreationDefaults } from "./chatCreationDefaults";
import { defaultChatTitle } from "./titlePolicy";
import { workspaceAvailabilityService as defaultWorkspaceAvailabilityService } from "../workspace/defaultServices";
import type {
  WorkspaceAvailabilityService,
  WorkspaceAvailabilitySnapshot
} from "../workspace/availability";
import { workspaceModelSupportsTools } from "../workspace/availability";
import { activityName, toolActivityDescriptors, skillToolActivityFacts, memorySearchActivityFacts } from "../tools/activityDescriptors";
import { fetchUrlActivityFacts } from "../tools/fetchUrlPlan";
import { acceptedMcpCallIdentity } from "../mcp/callDetailsAuthority";
import { decodeFrozenSkillManifest } from "../skills/runManifest";
import { loadMemoryRunActions } from "../memory/actions/runProjection";
import {
  applyMemoryScopedTargetOwnerLifecycle,
  applyMemorySourceMutations,
  type LockedMemorySourceChat,
  type MemorySourceMutation,
  type MemorySourceMutationHooks
} from "../memory/sourceState";
import { defaultMemorySourceMutationHooks } from "../memory/sourceHooks";
import { lockMemorySettings } from "../memory/persistence/transaction";
import {
  loadMemorySuppressionKeyring,
  preflightMemorySuppressionKeys
} from "../memory/suppressionKeyring";

const assistantRunDetailSelect = {
  ...runFollowupSelect,
  answerCompletedAt: true,
  workspaceWaitPending: true,
  chatPdfPreparation: { select: { retryable: true, state: true } },
  chatPdfAttachments: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: {
    completedPages: true, pageCount: true, retryable: true, route: true, state: true,
    readerModelName: true, answerModelName: true
  } },
  answerStartedAt: true,
  assistantId: true,
  assistantMessageId: true,
  assistantIdentity: true,
  events: {
    orderBy: {
      sequence: "asc"
    },
    select: {
      eventType: true,
      payload: true
    },
    where: {
      eventType: { in: ["artifact", "grounding_display", WORKSPACE_ACTIVITY_SNAPSHOT] }
    }
  },
  createdAt: true,
  errorPayload: true,
  id: true,
  scheduledOutcome: true,
  knowledgeRuns: {
    orderBy: { invocationOrdinal: "asc" },
    select: {
      invocationOrdinal: true,
      results: true
    }
  },
  knowledgeRetrievalSession: {
    select: {
      degradedFlags: true,
      evidenceItems: {
        orderBy: { ordinal: "asc" },
        select: { handle: true, state: true }
      },
      groundingResult: { select: { outcome: true } }
    }
  },
  searchRuns: {
    orderBy: {
      createdAt: "asc"
    },
    select: {
      artifacts: true,
      invocationId: true,
      status: true,
      strategyId: true
    }
  },
  normalizedRequest: true,
  userId: true,
  status: true,
  toolCalls: {
    orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }],
    select: {
      arguments: true,
      mcpRunBinding: { select: { runtimeGenerationFingerprint: true } },
      completedAt: true,
      ordinal: true,
      result: true,
      roundIndex: true,
      startedAt: true,
      state: true,
      toolName: true
    }
  },
  updatedAt: true,
  workspaceExecutions: { take: 512, orderBy: { startedAt: "desc" },
    select: { modelRunToolCallId: true, state: true, lastErrorCode: true } },
  workspaceRunBinding: {
    select: { exportAttemptCount: true, exportLeaseExpiresAt: true, exportState: true, lastExportErrorCode: true,
      outputCapture: true, updatedAt: true }
  },
  workspaceProducedAttachments: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      byteSize: true,
      fileName: true,
      id: true,
      mimeType: true,
      origin: true, metadata: true,
      workspaceRunOutput: { select: { relativePath: true } },
      workspaceCheckpointFile: { select: { relativePath: true, checkpoint: { select: { id: true, description: true, createdAt: true, state: true } } } }
    }
  }
} satisfies Prisma.ModelRunSelect;

const hydratedMessageSelect = {
  branchFollowups: true,
  assistantModelRuns: {
    orderBy: {
      createdAt: "desc"
    },
    select: assistantRunDetailSelect,
    take: 1
  },
  branchSourceModelRun: {
    select: assistantRunDetailSelect
  },
  content: true,
  createdAt: true,
  authorDisplayName: true,
  authorProjectRole: true,
  authorUserId: true,
  errorMessage: true,
  id: true,
  modelId: true,
  parentMessageId: true,
  provider: true,
  role: true,
  // A user turn a scheduled task posted: the task's current title labels it,
  // and its run's id and unread state let the viewer mark it seen.
  scheduledTaskOccurrences: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, task: { select: { id: true, title: true } }, unseenAt: true },
    take: 1
  },
  // The settled monitoring outcome of the scheduled turn this user message
  // started, kept on its run so it outlives the pruned occurrence history.
  userModelRuns: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { scheduledOutcome: true },
    take: 1,
    where: { scheduledOccurrenceId: { not: null } }
  },
  status: true
} satisfies Prisma.MessageSelect;

const sessionStatusEventsSelect = {
  orderBy: { sequence: "desc" as const },
  select: { payload: true },
  take: 1,
  where: { eventType: "artifact", payload: { path: ["artifactType"], equals: "context_status" } }
};

function latestSessionStatus(messages: readonly {
  id: string;
  role: string;
  assistantModelRuns?: readonly { events?: readonly { payload: unknown }[] }[];
  branchSourceModelRun?: { events?: readonly { payload: unknown }[] } | null;
}[]): Pick<ChatContextStats, "session" | "sessionMessageId"> {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    const run = message.assistantModelRuns?.[0] ?? message.branchSourceModelRun;
    for (const event of run?.events ?? []) {
      if (isRecord(event.payload) && event.payload.artifactType === "context_status") {
        const status = decodeSessionContextStatus(event.payload.payload);
        if (status) return { session: status, sessionMessageId: message.id };
      }
    }
  }
  return { session: null, sessionMessageId: null };
}

const lightweightMessageSelect = {
  assistantModelRuns: {
    orderBy: { createdAt: "desc" },
    select: {
      events: sessionStatusEventsSelect,
    },
    take: 1
  },
  id: true,
  branchSourceModelRun: { select: { events: sessionStatusEventsSelect } },
  parentMessageId: true,
  role: true
} satisfies Prisma.MessageSelect;

const chatSummarySelect = {
  ...chatTitleMetadataSelect,
  continuationSource: { select: { id: true } },
  importSource: true,
  importSourceModel: true,
  receivedWorkspaceSeeds: { select: { status: true, failureCode: true }, take: 1 },
  _count: {
    select: {
      messages: true
    }
  },
  activeLeafMessageId: true,
  assistantId: true,
  createdAt: true,
  defaultSearchPlan: true,
  defaultKnowledgePlan: true,
  defaultProviderModel: {
    select: {
      activeConfig: true,
      activeVersion: true,
      connectionId: true,
      enabled: true,
      id: true,
      modelClass: true
    }
  },
  folderId: true,
  id: true,
  pinned: true,
  projectFolderId: true,
  projectId: true,
  title: true,
  updatedAt: true,
  workspaceEnabled: true,
  workspaceSession: {
    select: {
      internetEnabled: true,
      state: true
    }
  }
} satisfies Prisma.ChatSelect;

const archivedChatSummarySelect = {
  ...chatSummarySelect,
  archived: true,
  memoryMode: true,
  memorySourceRevision: true,
  messages: {
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      createdAt: true
    },
    take: 1
  }
} satisfies Prisma.ChatSelect;

type ChatSummaryRow = Prisma.ChatGetPayload<{ select: typeof chatSummarySelect }>;
type ArchivedChatSummaryRow = Prisma.ChatGetPayload<{
  select: typeof archivedChatSummarySelect;
}>;
type HydratedMessageRow = Prisma.MessageGetPayload<{ select: typeof hydratedMessageSelect }>;
type HydratedMessagePath = Readonly<{
  memoryActionsByRun: ReadonlyMap<string, MemoryActionFeedback>;
  memoryStatusesByRun: ReadonlyMap<string, MemoryRunPresentationStatus>;
  memorySourcesByRun: ReadonlyMap<string, readonly MemoryAnswerSource[]>;
  messages: HydratedMessageRow[];
  scheduledTasks: CurrentScheduledTasks;
}>;
/**
 * The reader's current tasks among those the page's answers created, by id; a
 * created task missing here is gone (or never was the reader's) and shows as
 * deleted.
 */
type CurrentScheduledTasks = ReadonlyMap<string, ScheduledTask>;
type LightweightMessageRow = Prisma.MessageGetPayload<{ select: typeof lightweightMessageSelect }>;
type ArtifactSummaryRun = {
  normalizedRequest?: unknown;
  answerStartedAt?: Date | null;
  createdAt?: Date;
  events: { eventType?: string; payload: unknown }[];
  knowledgeRetrievalSession?: {
    degradedFlags?: string[];
    evidenceItems: { handle: string; state: string }[];
    groundingResult?: { outcome: string } | null;
  } | null;
  knowledgeRuns?: {
    invocationOrdinal: number;
    results: unknown;
  }[];
  searchRuns: {
    artifacts?: unknown;
    invocationId?: string | null;
    status?: string;
    strategyId?: string;
  }[];
  status?: string;
  toolCalls?: readonly object[];
  updatedAt?: Date;
  workspaceProducedAttachments?: readonly {
    byteSize: number;
    fileName: string;
    id: string;
    mimeType: string;
    workspaceRunOutput: { relativePath: string } | null;
    workspaceCheckpointFile?: { relativePath: string; checkpoint: { id: string; description: string; createdAt: Date; state: string } } | null;
    origin?: string;
    metadata?: unknown;
  }[];
};

/**
 * The one user-facing timing fact of a run: admission to the first answer
 * token, or to the terminal state when no answer text arrived. It is never
 * derived from event timelines or elapsed wall time on the client.
 */
function runWorkDurationMs(run: ArtifactSummaryRun): number | null {
  if (!run.createdAt) return null;
  const terminal = run.status === "complete" || run.status === "cancelled" ||
    run.status === "error";
  const end = run.answerStartedAt ?? (terminal ? run.updatedAt ?? null : null);
  if (!end) return null;
  const duration = end.getTime() - run.createdAt.getTime();
  return Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : null;
}

type ToolActivityRun = {
  userId?: string | null;
  errorPayload: unknown;
  events?: readonly Readonly<{ payload: unknown }>[];
  normalizedRequest: unknown;
  status: string;
  searchRuns?: readonly Readonly<{ invocationId?: string | null; status?: string; strategyId?: string }>[];
  toolCalls: {
    mcpRunBinding?: { runtimeGenerationFingerprint: string } | null;
    arguments?: unknown;
    result?: unknown;
    completedAt: Date | null;
    ordinal: number;
    roundIndex: number;
    startedAt: Date | null;
    state: string;
    toolName: string;
  }[];
};

function storedKnowledgeDefault(value: unknown): KnowledgePlan | null {
  if (value === null || value === undefined) return null;
  const decoded = decodeKnowledgePlan(value);
  if (!decoded.ok) throw new Error("knowledge_default_integrity_invalid");
  return decoded.plan;
}

function knowledgeDefaultJson(
  value: KnowledgePlan | null
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : {
    ...value,
    baseIds: [...value.baseIds],
    sourceIds: [...value.sourceIds]
  } as Prisma.InputJsonValue;
}

function activeBranchPath<TMessage extends { id: string; parentMessageId: string | null }>(
  messages: TMessage[],
  activeLeafMessageId: string | null
): TMessage[] {
  if (!activeLeafMessageId) {
    return [];
  }

  const byId = new Map(messages.map((message) => [message.id, message]));
  const path: TMessage[] = [];
  const seen = new Set<string>();
  let cursor: string | null = activeLeafMessageId;

  while (cursor) {
    if (seen.has(cursor)) {
      return [];
    }

    const message = byId.get(cursor);
    if (!message) {
      return [];
    }

    seen.add(cursor);
    path.push(message);
    cursor = message.parentMessageId;
  }

  return path.reverse();
}

type ChatHistoryCursor = {
  activeLeafMessageId: string;
  beforeMessageId: string;
  chatId: string;
  snapshotUpdatedAt: string;
  v: 1;
};

type ArchivedChatCursor = {
  id: string;
  updatedAt: string;
  v: 1;
};

function encodeHistoryCursor(cursor: ChatHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeHistoryCursor(value: string): ChatHistoryCursor | null {
  if (
    !value ||
    value.length > CHAT_HISTORY_CURSOR_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) return null;
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join("|") !==
        "activeLeafMessageId|beforeMessageId|chatId|snapshotUpdatedAt|v" ||
      record.v !== 1 ||
      typeof record.activeLeafMessageId !== "string" || !record.activeLeafMessageId ||
      typeof record.beforeMessageId !== "string" || !record.beforeMessageId ||
      typeof record.chatId !== "string" || !record.chatId ||
      typeof record.snapshotUpdatedAt !== "string" ||
      new Date(record.snapshotUpdatedAt).toISOString() !== record.snapshotUpdatedAt
    ) return null;
    return record as ChatHistoryCursor;
  } catch {
    return null;
  }
}

function encodeArchivedChatCursor(cursor: ArchivedChatCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeArchivedChatCursor(value: string): ArchivedChatCursor | null {
  if (
    !value ||
    value.length > ARCHIVED_CHAT_CURSOR_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) return null;
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join("|") !== "id|updatedAt|v" ||
      record.v !== 1 ||
      typeof record.id !== "string" ||
      !record.id ||
      typeof record.updatedAt !== "string" ||
      new Date(record.updatedAt).toISOString() !== record.updatedAt
    ) return null;
    return record as ArchivedChatCursor;
  } catch {
    return null;
  }
}

function pageCursor(input: {
  chatId: string;
  chatUpdatedAt: Date;
  activeLeafMessageId: string | null;
  beforeMessageId: string | undefined;
  hasOlder: boolean;
}): string | null {
  if (!input.hasOlder || !input.activeLeafMessageId || !input.beforeMessageId) return null;
  return encodeHistoryCursor({
    activeLeafMessageId: input.activeLeafMessageId,
    beforeMessageId: input.beforeMessageId,
    chatId: input.chatId,
    snapshotUpdatedAt: input.chatUpdatedAt.toISOString(),
    v: 1
  });
}

async function hydrateMessagePath(
  tx: Prisma.TransactionClient,
  chatId: string,
  messages: Array<{ id: string }>,
  userId: string
): Promise<HydratedMessagePath> {
  if (messages.length === 0) {
    return {
      memoryActionsByRun: new Map(),
      memorySourcesByRun: new Map(),
      memoryStatusesByRun: new Map(),
      messages: [],
      scheduledTasks: new Map()
    };
  }
  const hydrated = await tx.message.findMany({
    select: hydratedMessageSelect,
    where: {
      chatId,
      id: { in: messages.map((message) => message.id) }
    }
  });
  const byId = new Map(hydrated.map((message) => [message.id, message]));
  const ordered = messages.flatMap((message) => {
    const found = byId.get(message.id);
    return found ? [found] : [];
  });
  const runIds = ordered.flatMap((message) =>
    message.assistantModelRuns[0]?.id
      ? [message.assistantModelRuns[0].id]
      : message.branchSourceModelRun?.id
        ? [message.branchSourceModelRun.id]
        : []);
  const [memoryActionsByRun, memorySourcesByRun, memoryStatusesByRun, scheduledTasks] = await Promise.all([
    loadMemoryRunActions(tx, { runIds, userId }),
    loadMemoryRunSources(tx, { runIds, userId }),
    loadMemoryRunPresentationStatuses(tx, { runIds, userId }),
    loadCurrentScheduledTasks(tx, ordered.flatMap((message) =>
      (message.assistantModelRuns[0] ?? message.branchSourceModelRun)?.events ?? []), userId)
  ]);
  return { memoryActionsByRun, memorySourcesByRun, memoryStatusesByRun, messages: ordered, scheduledTasks };
}

/** The reader's current tasks among those the given answers' cards name; one read per page, none without cards. */
async function loadCurrentScheduledTasks(
  tx: Prisma.TransactionClient,
  events: readonly Readonly<{ payload: unknown }>[],
  userId: string
): Promise<CurrentScheduledTasks> {
  const taskIds = [...new Set(events.flatMap((event) => {
    const card = artifactType(event.payload) === "scheduled_task" ? decodeScheduledTaskCard(artifactInnerPayload(event.payload)) : null;
    return card ? [card.taskId] : [];
  }))];
  if (taskIds.length === 0) return new Map();
  const rows = await tx.scheduledTask.findMany({ select: scheduledTaskRowSelect, where: { id: { in: taskIds }, userId } });
  // A card needs the task's own fields only, never its run history.
  return new Map(rows.map((row) => [row.id, toScheduledTask(row, { lastRun: null, running: false, unseen: false })]));
}

async function approximateActiveBranchInputTokens(
  tx: Prisma.TransactionClient,
  activeMessages: Array<{ id: string }>
): Promise<number> {
  if (activeMessages.length === 0) return 0;
  // Keep off-page text bodies in PostgreSQL while preserving the shared
  // estimator exactly: text becomes code-point counts, while bounded
  // non-text blocks retain the JSON.stringify semantics used by the client.
  const ids = activeMessages.map((message) => message.id);
  const rows = await tx.$queryRaw<Array<{
    blockOrdinal: number;
    blockValue: unknown;
    codePoint: number | null;
    kind: "code_points" | "value";
    messageId: string;
    occurrences: number | null;
  }>>(Prisma.sql`
    WITH "message_blocks" AS (
      SELECT
        message."id" AS "messageId",
        block.ordinality::int AS "blockOrdinal",
        block.value AS "blockValue",
        COALESCE(
          jsonb_typeof(block.value) = 'object'
            AND block.value->>'type' = 'text'
            AND jsonb_typeof(block.value->'text') = 'string',
          false
        ) AS "isText"
      FROM "Message" AS message
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(message."content"->'blocks') = 'array'
            THEN message."content"->'blocks'
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS block(value, ordinality)
      WHERE message."id" IN (${Prisma.join(ids)})
    ),
    "projected_parts" AS (
      SELECT
        message_blocks."blockOrdinal",
        message_blocks."blockValue",
        NULL::int AS "codePoint",
        'value'::text AS "kind",
        message_blocks."messageId",
        NULL::int AS "occurrences"
      FROM "message_blocks" AS message_blocks
      WHERE NOT message_blocks."isText"

      UNION ALL

      SELECT
        message_blocks."blockOrdinal",
        NULL::jsonb AS "blockValue",
        ascii(split_character.value)::int AS "codePoint",
        'code_points'::text AS "kind",
        message_blocks."messageId",
        count(*)::int AS "occurrences"
      FROM "message_blocks" AS message_blocks
      CROSS JOIN LATERAL regexp_split_to_table(
        message_blocks."blockValue"->>'text',
        ''
      ) AS split_character(value)
      WHERE message_blocks."isText"
        AND message_blocks."blockValue"->>'text' <> ''
      GROUP BY
        message_blocks."blockOrdinal",
        message_blocks."messageId",
        ascii(split_character.value)
    )
    SELECT
      "blockOrdinal",
      "blockValue",
      "codePoint",
      "kind",
      "messageId",
      "occurrences"
    FROM "projected_parts"
    ORDER BY "messageId", "blockOrdinal", "kind", "codePoint"
  `);
  const partsByMessage = new Map<string, Map<number, ApproxTokenProjectedPart>>();
  for (const row of rows) {
    const parts = partsByMessage.get(row.messageId) ?? new Map<number, ApproxTokenProjectedPart>();
    if (row.kind === "value") {
      parts.set(row.blockOrdinal, { kind: "value", value: row.blockValue });
    } else if (row.codePoint !== null && row.occurrences !== null) {
      const existing = parts.get(row.blockOrdinal);
      const counts = existing?.kind === "code_points" ? [...existing.counts] : [];
      counts.push({
        codePoint: Number(row.codePoint),
        occurrences: Number(row.occurrences)
      });
      parts.set(row.blockOrdinal, { counts, kind: "code_points" });
    }
    partsByMessage.set(row.messageId, parts);
  }
  return activeMessages.reduce(
    (total, message) => {
      const parts = [...(partsByMessage.get(message.id)?.entries() ?? [])]
        .sort(([left], [right]) => left - right)
        .map(([, part]) => part);
      return total + estimateApproxTokensFromProjectedParts(parts);
    },
    0
  );
}

function serializeHydratedMessage(
  message: HydratedMessageRow,
  memoryActionsByRun: ReadonlyMap<string, MemoryActionFeedback>,
  memorySourcesByRun: ReadonlyMap<string, readonly MemoryAnswerSource[]>,
  memoryStatusesByRun: ReadonlyMap<string, MemoryRunPresentationStatus>,
  viewerUserId: string,
  scheduledTasks: CurrentScheduledTasks
): ChatDetailRecord["messages"][number] {
  const modelRun = message.assistantModelRuns[0] ?? message.branchSourceModelRun ?? undefined;
  const followups = projectMessageFollowups(message);
  const scheduledRun = message.scheduledTaskOccurrences?.[0];
  // A scheduled check's turn: the user message through its scheduled run, the answer through its own run.
  const scheduledOutcome = message.role === "user" ? message.userModelRuns?.[0]?.scheduledOutcome : modelRun?.scheduledOutcome;
  const artifactSummary = modelRun
    ? summarizeMessageRunArtifacts(
        modelRun,
        message.content,
        memoryActionsByRun.get(modelRun.id) ?? null,
        memorySourcesByRun.get(modelRun.id) ?? [],
        memoryStatusesByRun.get(modelRun.id),
        scheduledTasks
      )
    : null;
  return {
    ...(modelRun?.chatPdfAttachments?.length ? { pdfPreparation: modelRun.chatPdfAttachments.map((row) =>
      projectChatPdfPreparation(row, modelRun.chatPdfPreparation?.state === "failed" || modelRun.chatPdfPreparation?.state === "cancelled"
        ? { phase: modelRun.status === "error" ? "failed" : "cancelled",
            retryable: modelRun.status === "error" && modelRun.chatPdfPreparation?.retryable === true } : undefined)) } : {}),
    ...(message.assistantModelRuns.length && modelRun?.workspaceWaitPending && modelRun.status === "preparing"
      ? { workspacePreparation: true as const } : {}),
    ...(followups ? { followups } : {}),
    ...(message.assistantModelRuns.length && modelRun?.answerCompletedAt && message.status === "complete" &&
      ["streaming", "queued", "in_progress"].includes(modelRun.status)
      ? { workspaceSettling: true as const } : {}),
    artifactSummary: artifactSummary && !message.assistantModelRuns.length && message.branchSourceModelRun
      ? { ...artifactSummary, generatedImages: [] } : artifactSummary,
    assistantIdentity: serializeAssistantIdentity(modelRun),
    author: message.authorDisplayName && message.authorProjectRole
      ? {
          displayName: message.authorDisplayName,
          role: message.authorProjectRole,
          userId: message.authorUserId
        }
      : null,
    citationMessageId: modelRun?.assistantMessageId ?? message.id,
    content: message.content,
    createdAt: message.createdAt,
    errorMessage: message.errorMessage,
    id: message.id,
    modelId: message.modelId,
    modelRunId: modelRun?.id ?? null,
    parentMessageId: message.parentMessageId,
    provider: message.provider,
    role: message.role,
    ...(scheduledRun ? { scheduledTask: {
      taskId: scheduledRun.task.id, taskRunId: scheduledRun.id, title: scheduledRun.task.title, unseen: scheduledRun.unseenAt !== null
    } } : {}),
    ...(isScheduledTaskCheckOutcome(scheduledOutcome) ? { scheduledOutcome } : {}),
    status: message.status,
    toolActivity: modelRun ? summarizeMessageRunToolActivity(modelRun, viewerUserId) : null,
    workspaceActivity: modelRun ? summarizeMessageRunWorkspaceActivity(modelRun) : null
  };
}

function chatWorkspaceProjection(input: Readonly<{
  availability: WorkspaceAvailabilityService;
  chat: ChatSummaryRow;
  modelSupportsTools?: boolean;
  snapshot: WorkspaceAvailabilitySnapshot;
}>) {
  return input.availability.project(input.snapshot, {
    enabled: input.chat.workspaceEnabled,
    modelSupportsTools: input.modelSupportsTools ??
      workspaceModelSupportsTools(input.chat.defaultProviderModel),
    session: input.chat.workspaceSession,
    continuationSeedStatus: input.chat.receivedWorkspaceSeeds?.[0]?.status ?? null,
    continuationSeedFailureCode: input.chat.receivedWorkspaceSeeds?.[0]?.failureCode ?? null
  });
}

function serializeChatDetail(input: {
  viewerUserId: string;
  availability: WorkspaceAvailabilityService;
  chat: ChatSummaryRow;
  contextStats: ChatContextStats;
  hasOlder: boolean;
  usageStats: ChatUsageStats;
  messages: HydratedMessagePath;
  projectDefaultAuthority?: ProjectChatDefaultAuthority;
  workspaceSnapshot: WorkspaceAvailabilitySnapshot;
}): ChatDetailRecord {
  const chat = input.chat;
  const projectDefaults = input.projectDefaultAuthority
    ? projectChatDefaultsProjection(input.projectDefaultAuthority, {
        defaultKnowledgePlan: chat.defaultKnowledgePlan,
        defaultModelId: chat.defaultProviderModel?.id ?? null
      })
    : null;
  return {
    activeLeafMessageId: chat.activeLeafMessageId,
    assistantId: chat.assistantId,
    createdAt: chat.createdAt,
    defaultKnowledgePlan: projectDefaults
      ? projectDefaults.defaultKnowledgePlan
      : storedKnowledgeDefault(chat.defaultKnowledgePlan),
    defaultSearchPlan: storedSearchPlan(chat.defaultSearchPlan),
    defaultModelId: projectDefaults
      ? projectDefaults.defaultModelId
      : chat.defaultProviderModel?.id ?? null,
    defaultProvider: projectDefaults
      ? projectDefaults.defaultProvider
      : chat.defaultProviderModel?.connectionId ?? null,
    folderId: chat.projectFolderId ?? chat.folderId,
    id: chat.id,
    contextStats: input.contextStats,
    ...(chat.continuationSource ? { hasContinuationSource: true } : {}),
    ...importProjection(chat),
    messageCount: chat._count.messages,
    messages: input.messages.messages.map((message) =>
      serializeHydratedMessage(
        message,
        input.messages.memoryActionsByRun,
        input.messages.memorySourcesByRun,
        input.messages.memoryStatusesByRun,
        input.viewerUserId,
        input.messages.scheduledTasks
      )),
    pageInfo: {
      activeLeafMessageId: chat.activeLeafMessageId,
      beforeCursor: pageCursor({
        activeLeafMessageId: chat.activeLeafMessageId,
        beforeMessageId: input.messages.messages[0]?.id,
        chatId: chat.id,
        chatUpdatedAt: chat.updatedAt,
        hasOlder: input.hasOlder
      }),
      hasOlder: input.hasOlder,
      snapshotUpdatedAt: chat.updatedAt
    },
    pinned: chat.pinned,
    projectId: chat.projectId,
    title: chat.title,
    ...(chatTitlePending(chat) ? { titlePending: true } : {}),
    updatedAt: chat.updatedAt,
    usageStats: input.usageStats,
    workspace: chatWorkspaceProjection({
      availability: input.availability,
      chat,
      ...(projectDefaults ? {
        modelSupportsTools: projectDefaults.defaultModelId !== null &&
          input.projectDefaultAuthority!.toolCallingModelIds.has(
            projectDefaults.defaultModelId
          )
      } : {}),
      snapshot: input.workspaceSnapshot
    })
  };
}

function serializeAssistantIdentity(modelRun: {
  assistantIdentity: unknown;
} | undefined): NonNullable<ChatDetailRecord["messages"][number]["assistantIdentity"]> | null {
  return decodeAssistantIdentity(modelRun?.assistantIdentity);
}

function storedSearchPlan(value: unknown) {
  const decoded = decodeSearchPlan(value);
  return decoded.ok ? decoded.plan : null;
}

/** An imported chat (or a copy of one) names its source; others carry nothing. */
function importProjection(chat: Pick<ChatSummaryRow, "importSource" | "importSourceModel">) {
  return chat.importSource
    ? { importSource: chat.importSource, ...(chat.importSourceModel ? { importSourceModel: chat.importSourceModel } : {}) }
    : {};
}

function serializeChatSummary(
  chat: ChatSummaryRow,
  availability: WorkspaceAvailabilityService,
  workspaceSnapshot: WorkspaceAvailabilitySnapshot
): ChatSummaryRecord {
  return {
    ...(chat.continuationSource ? { hasContinuationSource: true } : {}),
    ...importProjection(chat),
    activeLeafMessageId: chat.activeLeafMessageId,
    assistantId: chat.assistantId,
    createdAt: chat.createdAt,
    defaultKnowledgePlan: storedKnowledgeDefault(chat.defaultKnowledgePlan),
    defaultSearchPlan: storedSearchPlan(chat.defaultSearchPlan),
    defaultModelId: chat.defaultProviderModel?.id ?? null,
    defaultProvider: chat.defaultProviderModel?.connectionId ?? null,
    folderId: chat.projectFolderId ?? chat.folderId,
    id: chat.id,
    messageCount: chat._count.messages,
    pinned: chat.pinned,
    projectId: chat.projectId,
    title: chat.title,
    ...(chatTitlePending(chat) ? { titlePending: true } : {}),
    updatedAt: chat.updatedAt,
    workspace: chatWorkspaceProjection({
      availability,
      chat,
      snapshot: workspaceSnapshot
    })
  };
}

function serializeArchivedChatSummary(
  chat: ArchivedChatSummaryRow,
  availability: WorkspaceAvailabilityService,
  workspaceSnapshot: WorkspaceAvailabilitySnapshot
): ArchivedChatSummaryRecord {
  if (chat.memoryMode === "TEMPORARY" || !chat.archived) {
    throw new Error("archived_chat_lifecycle_integrity_invalid");
  }
  return {
    ...serializeChatSummary(chat, availability, workspaceSnapshot),
    archived: true,
    lastMessageAt: chat.messages[0]?.createdAt ?? null,
    memoryMode: chat.memoryMode,
    sourceRevision: chat.memorySourceRevision
  };
}

function serializeArchivedChatDetail(input: {
  viewerUserId: string;
  availability: WorkspaceAvailabilityService;
  chat: ArchivedChatSummaryRow;
  contextStats: ChatContextStats;
  hasOlder: boolean;
  usageStats: ChatUsageStats;
  messages: HydratedMessagePath;
  workspaceSnapshot: WorkspaceAvailabilitySnapshot;
}): ArchivedChatDetailRecord {
  if (input.chat.memoryMode === "TEMPORARY" || !input.chat.archived) {
    throw new Error("archived_chat_lifecycle_integrity_invalid");
  }
  return {
    ...serializeChatDetail(input),
    archived: true,
    memoryMode: input.chat.memoryMode,
    sourceRevision: input.chat.memorySourceRevision
  };
}

async function defaultResumeSuppressionPreflight(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<boolean> {
  const required = await tx.memorySuppression.findMany({
    distinct: ["fingerprintKeyVersion"],
    orderBy: { fingerprintKeyVersion: "asc" },
    select: { fingerprintKeyVersion: true },
    where: { userId }
  });
  return preflightMemorySuppressionKeys(
    loadMemorySuppressionKeyring(),
    required.map((row) => row.fingerprintKeyVersion),
    "resume"
  ).status === "ready";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


function acceptedToolBudgets(normalizedRequest: unknown): {
  maxToolCalls: number;
  maxToolRounds: number;
} | null {
  if (!isRecord(normalizedRequest) || !isRecord(normalizedRequest.toolBudgets)) return null;
  const budgets = normalizedRequest.toolBudgets;
  return Number.isSafeInteger(budgets.maxToolCalls) && Number(budgets.maxToolCalls) > 0 &&
    Number.isSafeInteger(budgets.maxToolRounds) && Number(budgets.maxToolRounds) > 0
    ? {
        maxToolCalls: Number(budgets.maxToolCalls),
        maxToolRounds: Number(budgets.maxToolRounds)
      }
    : null;
}

function toolBudgetWarning(
  run: ToolActivityRun,
  budgets: { maxToolCalls: number; maxToolRounds: number } | null
): ThreadToolActivity["warning"] {
  const errorCode = isRecord(run.errorPayload) && typeof run.errorPayload.code === "string"
    ? run.errorPayload.code
    : null;
  if (errorCode === "tool_call_limit_exceeded") {
    return { kind: "calls", limit: budgets?.maxToolCalls ?? 16 };
  }
  if (errorCode === "tool_round_limit_exceeded") {
    return { kind: "rounds", limit: budgets?.maxToolRounds ?? 3 };
  }
  if (!budgets) return undefined;
  // A monitoring check's reserved verdict never counts against the budgets.
  const providerToolCalls = run.toolCalls.filter((call) => call.roundIndex > 0 &&
    !(isRecord(run.normalizedRequest) && isMonitoringVerdictCall(run.normalizedRequest, call.toolName)));
  if (providerToolCalls.length >= budgets.maxToolCalls) {
    return { kind: "calls", limit: budgets.maxToolCalls };
  }
  const rounds = new Set(providerToolCalls.map((call) => call.roundIndex)).size;
  return rounds >= budgets.maxToolRounds
    ? { kind: "rounds", limit: budgets.maxToolRounds }
    : undefined;
}

/** Safe activity plus initiator-only MCP references; no arguments, results, or raw events. */
export function summarizeMessageRunToolActivity(
  run: ToolActivityRun,
  viewerUserId?: string
): ThreadToolActivity | null {
  // Agent actions have one JSONL-backed Workspace feed, including MCP/search.
  if (isRecord(run.normalizedRequest) && isRecord(run.normalizedRequest.agent)) return null;
  const descriptors = toolActivityDescriptors(run.normalizedRequest);
  const calls = run.toolCalls.map((call) => {
    const descriptor = descriptors.get(call.toolName) ?? {
      origin: call.toolName.startsWith("mcp_") ? "mcp" as const : "tool" as const,
      toolName: call.toolName.startsWith("mcp_")
        ? "MCP tool"
        : activityName(call.toolName, "Tool")
    };
    const duration = call.startedAt && call.completedAt
      ? call.completedAt.getTime() - call.startedAt.getTime()
      : null;
    const memorySearch = memorySearchActivityFacts(call.toolName, call.result, call.ordinal);
    const state = displayedToolCallState(call, run.status);
    const status = memorySearch.memorySearchOutcome === "cancelled" ? "cancelled"
      : state === "complete" || state === "error" || state === "cancelled"
      ? state
      : "running";
    const fingerprint = call.mcpRunBinding?.runtimeGenerationFingerprint;
    const details = viewerUserId && viewerUserId === run.userId && descriptor.origin === "mcp" &&
      fingerprint && Number.isSafeInteger(call.roundIndex) && call.roundIndex > 0 &&
      Number.isSafeInteger(call.ordinal) && call.ordinal >= 0 &&
      acceptedMcpCallIdentity(run.normalizedRequest, call.toolName, fingerprint)
      ? { roundIndex: call.roundIndex, ordinal: call.ordinal }
      : undefined;
    return {
      ...(details ? { details } : {}),
      ...skillToolActivityFacts(run.normalizedRequest, call.toolName, call.arguments),
      ...(descriptor.origin === "web_fetch" ? fetchUrlActivityFacts(call.toolName, call.arguments, call.result) : {}),
      ...memorySearch,
      ...(duration !== null && duration >= 0 ? { durationMs: duration } : {}),
      origin: descriptor.origin,
      // Automatic Knowledge retrieval is persisted before the provider loop at
      // round index 0. The browser contract is intentionally user-facing and
      // one-based, so project that preflight activity as the first round.
      round: call.roundIndex === 0 ? 1 : call.roundIndex,
      ...(descriptor.serverName ? { serverName: descriptor.serverName } : {}),
      status,
      toolName: descriptor.toolName
    } satisfies ThreadToolActivity["calls"][number];
  });
  const warning = toolBudgetWarning(run, acceptedToolBudgets(run.normalizedRequest));
  const searchEngines = projectSearchEngineActivity({ normalizedRequest: run.normalizedRequest,
    runStatus: run.status,
    searchRuns: run.searchRuns ?? [], toolCalls: run.toolCalls,
    snapshots: (run.events ?? []).flatMap(event => artifactType(event.payload) === "search_activity"
      ? decodeThreadSearchActivitySnapshot(artifactInnerPayload(event.payload))?.engines ?? [] : []) });
  return calls.length > 0 || warning || searchEngines.length > 0
    ? { calls, ...(searchEngines.length ? { searchEngines } : {}), ...(warning ? { warning } : {}) }
    : null;
}

type WorkspaceActivityRun = {
  id?: string;
  workspaceExecutions?: { modelRunToolCallId: string; state: string; lastErrorCode: string | null }[];
  events: { payload: unknown }[];
  status: string;
  workspaceRunBinding?: {
    outputCapture?: unknown;
    updatedAt?: Date;
    exportAttemptCount: number;
    exportLeaseExpiresAt: Date | null;
    exportState: string;
    lastExportErrorCode: string | null;
  } | null;
};

function workspaceOutputStatus(run: WorkspaceActivityRun): ThreadWorkspaceOutputStatus | undefined {
  const binding = run.workspaceRunBinding;
  if (!binding) return undefined;
  const revision = binding.updatedAt ? { revision: binding.updatedAt.toISOString() } : {};
  const code = isWorkspaceErrorCode(binding.lastExportErrorCode) ? binding.lastExportErrorCode : undefined;
  if (binding.exportState === "COMPLETE") return { ...revision, state: "complete" };
  if (binding.exportState === "EXPORTING" && binding.exportLeaseExpiresAt &&
    binding.exportLeaseExpiresAt > new Date()) return { ...revision, state: "exporting" };
  if (binding.exportState === "PENDING" && binding.exportAttemptCount === 0 &&
    (run.status === "cancelled" || run.status === "error")) return undefined;
  if (binding.exportState === "PENDING" && run.status !== "complete" &&
    run.status !== "cancelled" && run.status !== "error") return undefined;
  const retryable = run.status === "complete" &&
    binding.exportAttemptCount < WORKSPACE_EXPORT_MAX_ATTEMPTS &&
    isRetryableWorkspaceExportErrorCode(binding.lastExportErrorCode);
  return { ...revision, ...(code ? { errorCode: code } : {}), state: retryable ? "retrying" : "failed" };
}

/**
 * Reloadable Workspace timeline: exact persisted `workspace_activity` entries
 * folded from exact run-owned cessation proofs. Terminal runs without proof
 * retain an unknown outcome; export status comes independently from the binding.
 */
export function summarizeMessageRunWorkspaceActivity(
  run: WorkspaceActivityRun
): ThreadWorkspaceActivity | null {
  const entries = run.events
    .map((event) => event.payload)
    .filter((payload) => artifactType(payload) === "workspace_activity")
    .map((payload) => decodeThreadWorkspaceActivityEntry(isRecord(payload) ? payload.payload : null))
    .filter((entry): entry is ThreadWorkspaceActivityEntry => entry !== null);
  const outputStatus = workspaceOutputStatus(run);
  let activity = mergeWorkspaceActivity(null, { entries, ...(outputStatus ? { outputStatus } : {}) });
  for (const event of run.events) activity = mergeWorkspaceActivity(activity, workspaceActivitySnapshot(event.payload));
  const terminal = run.status === "cancelled"
    ? "cancelled" as const
    : run.status === "error" ? "failed" as const : run.status === "complete" ? "complete" as const : null;
  // A complete run with a sealed, run-owned handoff follows the retirement
  // boundary. Never consult the current shared session for historical proof.
  const capture = run.workspaceRunBinding?.outputCapture;
  if (run.id && terminal === "complete" && isRecord(capture) && typeof capture.id === "string" && Array.isArray(capture.outputs)) {
    activity = mergeWorkspaceActivity(activity, { entries: [workspaceLifecycleActivity({
      kind: "execution_status", phase: "closed", runId: run.id
    })] });
  }
  if (!activity) return null;
  const closed = new Set((run.workspaceExecutions ?? []).filter(execution => execution.state === "CLOSED" ||
    execution.state === "LOST" && execution.lastErrorCode === "workspace_execution_stopped")
    .map(execution => workspaceActivityEntryId(execution.modelRunToolCallId)));
  const provenEntries = activity.entries.map(entry => {
    if (!closed.has(entry.id) || !(entry.phase === "running" || entry.phase === "requested" ||
      entry.phase === "unknown" || entry.runOutcome !== undefined)) return entry;
    const { runOutcome: _runOutcome, ...facts } = entry;
    return { ...facts, phase: "closed" as const };
  });
  return {
    ...activity,
    entries: foldWorkspaceActivityEntries(provenEntries, terminal).map((entry) => {
      // Background export settles after answer SSE closes, so its durable
      // binding can be newer than the last recorded lifecycle event.
      if (entry.kind !== "outputs_export") return entry;
      if (outputStatus?.state === "complete") return { ...entry, phase: "succeeded" as const };
      if (outputStatus?.state === "failed") return { ...entry, phase: "failed" as const };
      return entry;
    }),
    ...(outputStatus ? { outputStatus } : {})
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function artifactType(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.artifactType === "string" ? payload.artifactType : null;
}

function artifactInnerPayload(payload: unknown): unknown {
  return isRecord(payload) && "payload" in payload ? payload.payload : null;
}

function contextCompactionFromArtifactPayloads(
  payloads: readonly unknown[]
): ContextCompactionStatus | null {
  let latest: ContextCompactionStatus | null = null;
  for (const payload of payloads) {
    if (artifactType(payload) !== "context_compaction") continue;
    const status = decodeContextCompactionStatus(artifactInnerPayload(payload));
    if (!status) continue;
    latest = mergeContextCompactionStatus(latest, status);
  }
  return latest;
}

/** Stored rows are read through the write projection, never rewritten. */
function storedReasoningItem(payload: unknown): ReasoningFoldItem {
  return artifactType(payload) === "reasoning"
    ? storedReasoningFoldItem(artifactInnerPayload(payload))
    : { kind: "other" };
}

function storedCitation(payload: unknown): ThreadCitation[] {
  const citation = artifactType(payload) === "citation"
    ? projectAnswerCitation(artifactInnerPayload(payload))
    : null;
  return citation ? [citation] : [];
}

function knowledgeCitation(
  value: unknown
): NonNullable<ThreadArtifactSummary["knowledgeCitations"]>[number] | null {
  if (!isRecord(value)) return null;
  const handle = optionalString(value.handle);
  if (!handle || !decodeKnowledgeCitationHandle(handle)) return null;
  if (value.deleted === true) return { deleted: true, handle };
  return { handle };
}

function sourceValuesFromSearchRun(artifacts: unknown): unknown[] {
  if (!isRecord(artifacts)) return [];
  const values: unknown[] = [];
  if (Array.isArray(artifacts.sources)) values.push(artifacts.sources);
  return values;
}

function sourceValuesFromSearchPayload(payload: unknown): unknown[] {
  const inner = artifactInnerPayload(payload);
  if (!isRecord(inner)) return [];
  const action = isRecord(inner.action) ? inner.action : null;
  return Array.isArray(action?.sources) ? [action.sources] : [];
}

/**
 * The cards of the tasks an answer created or managed. With the reader's
 * current tasks each card shows its task as it is now, with the answer's last
 * action on it, or deleted once it is gone; without them (a run's own chat
 * update) the tasks show as the answer left them.
 */
function answerScheduledTaskCards(
  payloads: readonly unknown[],
  current?: CurrentScheduledTasks
): ScheduledTaskCard[] {
  return foldScheduledTaskCards(payloads.filter((payload) => artifactType(payload) === "scheduled_task")
    .map(artifactInnerPayload)).map((card) => {
    if (!current) return card;
    const task = current.get(card.taskId);
    return task ? scheduledTaskCard(task, card.timeZoneFallback, card.action) : { ...card, deleted: true as const };
  });
}

export function summarizeMessageRunArtifacts(
  run: ArtifactSummaryRun,
  answerContent?: unknown,
  memoryAction: MemoryActionFeedback | null = null,
  memorySources: readonly MemoryAnswerSource[] = [],
  memoryStatus?: MemoryRunPresentationStatus,
  currentScheduledTasks?: CurrentScheduledTasks
): ThreadArtifactSummary | null {
  const grounding = run.events.filter((event) => event.eventType === "grounding_display")
    .map((event) => projectGroundingDisplay(event.payload))
    .filter((display) => display !== null).at(-1) ?? null;
  const artifactPayloads = run.events.map((event) => event.payload);
  const contextCompaction = contextCompactionFromArtifactPayloads(artifactPayloads);
  // One entry per merged thinking block or complete provider item, however
  // many rows (or legacy per-delta rows) carry it; the reader portion is bounded.
  const reasoning = foldReasoningEntries(artifactPayloads.map(storedReasoningItem));
  const reasoningTexts = reasoning.entries;
  // Every provider response and tool round adds citations; the reader gets
  // each cited URL once, bounded and marked.
  const citationList = foldAnswerCitations(grounding
    ? answerCitationsFromGrounding(grounding.citations)
    : artifactPayloads.flatMap(storedCitation));
  const citations = citationList.citations;
  const searchPayloads = artifactPayloads.filter(
    (payload) => artifactType(payload) === "search"
  );
  const sourceList = collectThreadSearchSources([
    ...run.searchRuns.flatMap((searchRun) =>
      sourceValuesFromSearchRun(searchRun.artifacts)
    ),
    ...searchPayloads.flatMap(sourceValuesFromSearchPayload),
    ...(grounding ? [citations] : [])
  ], THREAD_SEARCH_SOURCE_MAX_ITEMS);
  const sources = sourceList.sources;
  const generatedImages = (run.workspaceProducedAttachments ?? []).flatMap((attachment) => {
    const image = attachment.origin === "IMAGE_OUTPUT" && isRecord(attachment.metadata) ? decodeThreadGeneratedImage(attachment.metadata.image) : null;
    return image && image.attachmentId === attachment.id ? [image] : [];
  });
  const generatedFiles = (run.workspaceProducedAttachments ?? []).flatMap((attachment) =>
    attachment.workspaceCheckpointFile?.checkpoint.state === "SETTLED"
      ? [{ attachmentId: attachment.id, byteSize: attachment.byteSize, fileName: attachment.fileName, mimeType: attachment.mimeType,
        relativePath: attachment.workspaceCheckpointFile.relativePath, checkpoint: { id: attachment.workspaceCheckpointFile.checkpoint.id,
          description: attachment.workspaceCheckpointFile.checkpoint.description, createdAt: attachment.workspaceCheckpointFile.checkpoint.createdAt.toISOString() } }]
      : attachment.workspaceRunOutput
      ? [{
          attachmentId: attachment.id,
          byteSize: attachment.byteSize,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          relativePath: attachment.workspaceRunOutput.relativePath
        }]
      : []
  );
  const generatedArtifacts = latestGeneratedArtifactsForAnswer(run.events
    .filter((event) => artifactType(event.payload) === "generated_artifact")
    .flatMap((event) => {
      const decoded = decodeThreadGeneratedArtifact(artifactInnerPayload(event.payload));
      return decoded ? [decoded] : [];
    }));
  const scheduledTasks = answerScheduledTaskCards(artifactPayloads, currentScheduledTasks);

  const knowledgeRuns = (run.knowledgeRuns ?? [])
    .filter((knowledgeRun) =>
      Number.isSafeInteger(knowledgeRun.invocationOrdinal) &&
      knowledgeRun.invocationOrdinal >= 1 &&
      knowledgeRun.invocationOrdinal <= KNOWLEDGE_CITATION_INVOCATION_MAX
    )
    .sort((left, right) => left.invocationOrdinal - right.invocationOrdinal);
  const answerText = isRecord(answerContent)
    ? textFromContentBlocks(answerContent as { blocks?: unknown[] })
    : "";
  const citedHandles = new Set(knowledgeCitationHandlesFromText(answerText));
  const currentEvidence = run.knowledgeRetrievalSession?.evidenceItems.map((item) => ({
    ...(item.state === "deleted" ? { deleted: true as const } : {}),
    handle: item.handle
  })) ?? null;
  const legacyEvidence = knowledgeRuns.flatMap((knowledgeRun) =>
    (Array.isArray(knowledgeRun.results) ? knowledgeRun.results : [])
      .map(knowledgeCitation)
      .filter((citation): citation is NonNullable<typeof citation> => citation !== null)
  );
  const knowledgeCitations = (currentEvidence ?? legacyEvidence)
    .filter((citation) => citedHandles.has(citation.handle))
    .filter((citation, index, all) =>
      all.findIndex((candidate) => candidate.handle === citation.handle) === index)
    .slice(0, 24);
  // Only work the reader can open (reasoning or tool steps) earns a duration.
  const workDurationMs = reasoningTexts.length > 0 || (run.toolCalls?.length ?? 0) > 0
    ? runWorkDurationMs(run)
    : null;
  const skillCatalogOmittedCount = isRecord(run.normalizedRequest)
    ? decodeFrozenSkillManifest(run.normalizedRequest.skills)?.omittedCount ?? 0 : 0;
  const groundingOutcome = run.knowledgeRetrievalSession?.groundingResult?.outcome;
  const knowledgeState = groundingOutcome === "answered" ||
    groundingOutcome === "insufficient_evidence" ||
    groundingOutcome === "passed" || groundingOutcome === "no_answer"
    ? {
        answer: groundingOutcome === "answered" || groundingOutcome === "passed"
          ? "answered" as const
          : "insufficient_evidence" as const,
        scope: run.knowledgeRetrievalSession?.degradedFlags?.includes("partial_readiness")
          ? "partial_sources_ready" as const
          : "ready" as const
      }
    : undefined;

  if (
    citations.length === 0 &&
    skillCatalogOmittedCount === 0 &&
    generatedImages.length === 0 &&
    generatedFiles.length === 0 &&
    generatedArtifacts.length === 0 &&
    scheduledTasks.length === 0 &&
    sources.length === 0 &&
    reasoningTexts.length === 0 &&
    knowledgeCitations.length === 0 &&
    !knowledgeState &&
    !grounding &&
    !memoryAction &&
    !memoryStatus &&
    memorySources.length === 0 &&
    !contextCompaction &&
    workDurationMs === null
  ) {
    return null;
  }

  return {
    citations,
    ...(citationList.truncated ? { citationsTruncated: true as const } : {}),
    ...(contextCompaction ? { contextCompaction } : {}),
    ...(skillCatalogOmittedCount > 0 ? { skillCatalogOmittedCount } : {}),
    ...(generatedArtifacts.length > 0 ? { generatedArtifacts } : {}),
    ...(generatedImages.length > 0 ? { generatedImages } : {}),
    ...(generatedFiles.length > 0 ? { generatedFiles } : {}),
    ...(grounding ? { groundingDisplay: { provider: grounding.provider, suggestionsHtml: grounding.suggestionsHtml } } : {}),
    ...(knowledgeState ? { knowledgeState } : {}),
    knowledgeCitations,
    ...(memoryAction ? { memoryAction } : {}),
    ...(memoryStatus ? { memoryStatus } : {}),
    ...(memorySources.length > 0 ? { memorySources: [...memorySources] } : {}),
    reasoningText: reasoningTexts,
    ...(reasoning.truncated ? { reasoningTruncated: true as const } : {}),
    ...(scheduledTasks.length > 0 ? { scheduledTasks } : {}),
    sources,
    ...(sourceList.truncated ? { sourcesTruncated: true as const } : {}),
    ...(workDurationMs !== null ? { workDurationMs } : {})
  };
}

async function findOwnedFolder(
  prismaClient: Pick<typeof prisma, "folder">,
  folderId: string | null | undefined,
  userId: string
) {
  if (!folderId) {
    return null;
  }

  return prismaClient.folder.findFirst({
    select: {
      id: true
    },
    where: {
      id: folderId,
      userId
    }
  });
}

async function wouldCreateFolderCycle(input: {
  folderId: string;
  parentId: string | null | undefined;
  prismaClient: Pick<typeof prisma, "folder">;
  userId: string;
}) {
  if (!input.parentId) {
    return false;
  }

  let currentParentId: string | null = input.parentId;
  const visited = new Set<string>();
  while (currentParentId) {
    if (currentParentId === input.folderId || visited.has(currentParentId)) {
      return true;
    }

    visited.add(currentParentId);
    const parent: { parentId: string | null } | null = await input.prismaClient.folder.findFirst({
      select: {
        parentId: true
      },
      where: {
        id: currentParentId,
        userId: input.userId
      }
    });

    currentParentId = parent?.parentId ?? null;
  }

  return false;
}

async function loadActiveBranchContextStats(
  tx: Prisma.TransactionClient,
  messages: LightweightMessageRow[]
): Promise<ChatContextStats> {
  const snapshot = latestSessionStatus(messages);
  const snapshotIndex = snapshot.sessionMessageId
    ? messages.findIndex((message) => message.id === snapshot.sessionMessageId) : -1;
  const [approximateActiveBranchTokens, approximateInputTokensAfterSession] = await Promise.all([
    approximateActiveBranchInputTokens(tx, messages),
    snapshotIndex >= 0 ? approximateActiveBranchInputTokens(tx, messages.slice(snapshotIndex + 1)) : 0
  ]);
  return {
    approximateActiveBranchInputTokens: approximateActiveBranchTokens,
    ...snapshot,
    ...(snapshot.session ? {
      sessionBranchLeafId: messages.at(-1)?.id ?? null,
      approximateInputTokensAfterSession
    } : {})
  };
}

export async function loadChatBranchSnapshotStats(
  tx: Prisma.TransactionClient,
  input: { activeLeafMessageId: string | null; chatId: string }
): Promise<Readonly<{
  contextStats: ChatContextStats;
  usageStats: ChatUsageStats;
}>> {
  // The caller supplies the leaf read in this same transaction so both
  // summaries remain fenced to the exact chat snapshot being serialized.
  const messages = await tx.message.findMany({
    select: lightweightMessageSelect,
    where: { chatId: input.chatId }
  });
  const activeMessages = activeBranchPath(messages, input.activeLeafMessageId);
  return {
    contextStats: await loadActiveBranchContextStats(tx, activeMessages),
    usageStats: await loadChatUsageTotals(tx, input.chatId)
  };
}

/**
 * Locks and checks an Assistant being bound before any chat, Project or
 * folder row, in the order Assistant deletion takes them. Every refusal is
 * the same neutral error.
 */
async function lockBindableAssistant(
  tx: Prisma.TransactionClient,
  assistantId: string | null | undefined,
  scope: AssistantBindingScope
): Promise<void> {
  if (typeof assistantId !== "string") return;
  if (!await isAssistantAvailable(tx, { assistantId, lock: true, scope })) {
    throw new ChatAssistantUpdateError("assistant_not_available");
  }
}

/**
 * The binding and override columns a chat update writes. Changing the
 * binding (including removing it) starts from no overrides and drops the
 * deleted marker; a patch applies on top and needs a binding. Values are
 * checked against the chat's catalog and Knowledge: the requester's own in a
 * personal chat, the Project's in a Project chat.
 */
async function assistantUpdateData(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    assistantId: string | null | undefined;
    catalog: ChatAssistantOverrideCatalog | null;
    chatId: string;
    knowledgeAvailable: (value: NonNullable<ChatAssistantOverridesPatch["knowledge"]>) => Promise<boolean> | boolean;
    patch: ChatAssistantOverridesPatch | undefined;
    scope: AssistantBindingScope;
  }>
): Promise<{ assistantId?: string | null; assistantOverrides?: Prisma.InputJsonObject | Prisma.NullTypes.DbNull }> {
  if (input.assistantId === undefined && input.patch === undefined) return {};
  let binding = input.assistantId ?? null;
  let overrides: ChatAssistantOverrides = {};
  if (input.assistantId === undefined) {
    const current = await tx.chat.findUniqueOrThrow({
      select: { assistantId: true, assistantOverrides: true },
      where: { id: input.chatId }
    });
    binding = current.assistantId;
    const stored = decodeStoredChatAssistantOverrides(current.assistantOverrides);
    overrides = stored?.kind === "overrides" ? stored.overrides : {};
  }
  if (input.patch !== undefined) {
    if (!binding) throw new ChatAssistantUpdateError("assistant_overrides_not_allowed");
    // A binding set in this request was checked under lock already.
    if (input.assistantId === undefined && !await isAssistantAvailable(tx, {
      assistantId: binding,
      scope: input.scope
    })) {
      throw new ChatAssistantUpdateError("assistant_not_available");
    }
    const next = nextChatAssistantOverrides(overrides, input.patch);
    const issue = chatAssistantOverridesIssue({
      catalog: input.catalog,
      next,
      patch: input.patch,
      rows: await loadAssistantRows(tx, binding)
    });
    if (issue) throw new ChatAssistantUpdateError(issue);
    if (input.patch.knowledge && !await input.knowledgeAvailable(input.patch.knowledge)) {
      throw new ChatAssistantUpdateError("assistant_overrides_invalid");
    }
    overrides = next;
  }
  const stored = storedChatAssistantOverrides(overrides);
  return {
    ...(input.assistantId !== undefined ? { assistantId: input.assistantId } : {}),
    assistantOverrides: stored ? stored as Prisma.InputJsonObject : Prisma.DbNull
  };
}

export function createPrismaChatRepository(
  prismaClient = prisma,
  options: Readonly<{
    /** Catalog that chat Assistant overrides are validated and projected against. */
    loadCatalogData?: (userId: string) => Promise<CatalogData | null>;
    /** The Assistant of a Project chat, resolved through the Project; the application's by default. */
    loadProjectChatAssistant?: ProjectChatAssistantLoader;
    memorySourceHooks?: MemorySourceMutationHooks;
    resumeSuppressionPreflight?: (
      tx: Prisma.TransactionClient,
      userId: string
    ) => Promise<boolean>;
    workspaceAvailability?: WorkspaceAvailabilityService;
  }> = {}
): ChatRepository & ChatLifecycleRepository {
  const memorySourceHooks = options.memorySourceHooks ?? defaultMemorySourceMutationHooks;
  const resumeSuppressionPreflight = options.resumeSuppressionPreflight ??
    defaultResumeSuppressionPreflight;
  const workspaceAvailability = options.workspaceAvailability ??
    defaultWorkspaceAvailabilityService;
  const loadCatalogData = options.loadCatalogData ??
    createPrismaCatalogDataLoader({ prisma: prismaClient });
  return {
    archiveChat: async ({ chatId, userId }) => {
      return prismaClient.$transaction(async (tx) => {
        const chats = await tx.$queryRaw<LockedMemorySourceChat[]>`
          SELECT
            "id", "userId", "activeLeafMessageId", "archived", "folderId",
            "memoryMode", "memoryBranchGeneration", "memorySourceRevision",
            "temporaryRetentionPolicyVersion", "temporaryRetentionDeadline"
          FROM "Chat"
          WHERE "id" = ${chatId}
            AND "userId" = ${userId}
            AND "projectId" IS NULL
            AND "permanentDeletionAt" IS NULL
          FOR UPDATE
        `;
        if (!chats[0] || chats[0].archived || chats[0].memoryMode === "TEMPORARY") {
          return false;
        }

        const activeRun = await tx.modelRun.findFirst({
          select: {
            id: true
          },
          where: {
            chatId,
            status: {
              in: ["preparing", "streaming", "queued", "in_progress"]
            }
          }
        });
        if (activeRun) {
          throw new ActiveRunConflictError();
        }

        await applyMemorySourceMutations(tx, {
          chat: chats[0],
          hooks: memorySourceHooks,
          mutations: ["CHAT_ARCHIVE_OR_RESTORE"],
          patch: { archived: true }
        });
        return true;
      });
    },
    setArchived: async ({ archived, chatId, expectedChatRevision, userId }) => {
      if (!Number.isSafeInteger(expectedChatRevision) || expectedChatRevision < 0) {
        return { kind: "stale" };
      }
      return prismaClient.$transaction(async (tx): Promise<ChatLifecycleMutationResult> => {
        const chats = await tx.$queryRaw<Array<LockedMemorySourceChat & { updatedAt: Date }>>`
          SELECT
            "id", "userId", "activeLeafMessageId", "archived", "folderId",
            "memoryMode", "memoryBranchGeneration", "memorySourceRevision",
            "temporaryRetentionPolicyVersion", "temporaryRetentionDeadline", "updatedAt"
          FROM "Chat"
          WHERE "id" = ${chatId}
            AND "userId" = ${userId}
            AND "projectId" IS NULL
            AND "permanentDeletionAt" IS NULL
          FOR UPDATE
        `;
        const chat = chats[0];
        if (!chat || chat.memoryMode === "TEMPORARY") return { kind: "not_found" };
        if (
          chat.archived === archived ||
          chat.memorySourceRevision !== expectedChatRevision
        ) return { kind: "stale" };

        const activeRun = await tx.modelRun.findFirst({
          select: { id: true },
          where: {
            chatId,
            status: { in: ["preparing", "streaming", "queued", "in_progress"] }
          }
        });
        if (activeRun) throw new ActiveRunConflictError();

        const snapshot = await applyMemorySourceMutations(tx, {
          chat,
          hooks: memorySourceHooks,
          mutations: ["CHAT_ARCHIVE_OR_RESTORE"],
          patch: { archived }
        });
        const updated = await tx.chat.findUniqueOrThrow({
          select: { updatedAt: true },
          where: { id: chatId }
        });
        if (snapshot.memoryMode === "TEMPORARY") {
          throw new Error("chat_lifecycle_integrity_invalid");
        }
        return {
          chat: {
            archived: snapshot.archived,
            id: snapshot.id,
            memoryMode: snapshot.memoryMode,
            sourceRevision: snapshot.memorySourceRevision,
            updatedAt: updated.updatedAt
          },
          kind: "ok"
        };
      });
    },
    createChat: async ({ folderId, memoryMode, title, userId, workspaceEnabled }) => {
      const workspaceSnapshot = await workspaceAvailability.snapshot();
      const defaults = await loadChatCreationDefaults(prismaClient, userId);
      if (!defaults) return null;

      return prismaClient.$transaction(async (tx) => {
        const folder = await findOwnedFolder(tx, folderId, userId);

        const resolvedFolderId = folderId === undefined
          ? defaults.defaultFolderId
          : folder?.id ?? null;
        if (folderId && !folder) {
          return null;
        }

        const chat = await tx.chat.create({
          data: {
            defaultProviderModelId: defaults.defaultProviderModelId,
            folderId: resolvedFolderId,
            ...(memoryMode ? { memoryMode } : {}),
            title: title?.trim() || defaultChatTitle,
            userId,
            ...(workspaceEnabled === undefined ? {} : { workspaceEnabled })
          },
          select: chatSummarySelect
        });

        return serializeChatSummary(chat, workspaceAvailability, workspaceSnapshot);
      });
    },
    createFolder: async ({ name, parentId, userId }) => {
      const trimmed = name.trim();
      if (!trimmed) {
        return null;
      }

      if (parentId) {
        const parent = await findOwnedFolder(prismaClient, parentId, userId);
        if (!parent) {
          return null;
        }
      }

      const aggregate = await prismaClient.folder.aggregate({
        _max: {
          sortOrder: true
        },
        where: {
          userId
        }
      });

      try {
        const folder = await prismaClient.folder.create({
          data: {
            name: trimmed,
            parentId: parentId ?? null,
            sortOrder: (aggregate._max.sortOrder ?? 0) + 10,
            userId
          },
          select: {
            defaultKnowledgePlan: true,
            id: true,
            name: true,
            parentId: true,
            projectMemory: true,
            sortOrder: true
          }
        });
        return {
          ...folder,
          defaultKnowledgePlan: storedKnowledgeDefault(folder.defaultKnowledgePlan)
        };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return null;
        }

        throw error;
      }
    },
    deleteFolder: async ({ folderId, userId }) =>
      prismaClient.$transaction(async (tx) => {
        const folders = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "Folder"
          WHERE "id" = ${folderId} AND "userId" = ${userId}
          FOR UPDATE
        `;
        if (!folders[0]) return false;
        const chats = await tx.$queryRaw<LockedMemorySourceChat[]>`
          SELECT
            "id", "userId", "activeLeafMessageId", "archived", "folderId",
            "memoryMode", "memoryBranchGeneration", "memorySourceRevision",
            "temporaryRetentionPolicyVersion", "temporaryRetentionDeadline"
          FROM "Chat"
          WHERE "userId" = ${userId}
            AND "folderId" = ${folderId}
            AND "permanentDeletionAt" IS NULL
          ORDER BY "id"
          FOR UPDATE
        `;
        const movedSources = [];
        for (const chat of chats) {
          movedSources.push(await applyMemorySourceMutations(tx, {
            chat,
            hooks: memorySourceHooks,
            mutations: ["FOLDER_MOVE"],
            patch: { folderId: null }
          }));
        }
        await applyMemoryScopedTargetOwnerLifecycle(tx, memorySourceHooks, {
          kind: "FOLDER_DELETE",
          sourceSnapshots: movedSources,
          targetId: folderId,
          userId
        });
        const result = await tx.folder.deleteMany({
          where: { id: folderId, userId }
        });
        return result.count === 1;
      }),
    getArchivedChat: async ({ chatId, userId }) => {
      const workspaceSnapshot = await workspaceAvailability.snapshot();
      return prismaClient.$transaction(async (tx) => {
        const chat = await tx.chat.findFirst({
          select: archivedChatSummarySelect,
          where: {
            archived: true,
            id: chatId,
            memoryMode: { not: "TEMPORARY" },
            permanentDeletionAt: null,
            projectId: null,
            userId
          }
        });
        if (!chat) return null;
        const lightweightMessages = await tx.message.findMany({
          select: lightweightMessageSelect,
          where: { chatId }
        });
        const activeMessages = activeBranchPath(lightweightMessages, chat.activeLeafMessageId);
        const pageMessages = activeMessages.slice(-CHAT_HISTORY_PAGE_SIZE);
        const [messages, contextStats, usageStats] = await Promise.all([
          hydrateMessagePath(tx, chatId, pageMessages, userId),
          loadActiveBranchContextStats(tx, activeMessages),
          loadChatUsageTotals(tx, chatId)
        ]);
        return serializeArchivedChatDetail({
          viewerUserId: userId,
          availability: workspaceAvailability,
          chat,
          contextStats,
          hasOlder: activeMessages.length > CHAT_HISTORY_PAGE_SIZE,
          usageStats,
          messages,
          workspaceSnapshot
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    },
    getArchivedMessagesPage: async ({ before, chatId, userId }) => {
      return prismaClient.$transaction(async (tx) => {
        const chat = await tx.chat.findFirst({
          select: {
            activeLeafMessageId: true,
            id: true,
            updatedAt: true
          },
          where: {
            archived: true,
            id: chatId,
            memoryMode: { not: "TEMPORARY" },
            permanentDeletionAt: null,
            projectId: null,
            userId
          }
        });
        if (!chat) return { kind: "not_found" as const };
        const cursor = decodeHistoryCursor(before);
        if (!cursor || cursor.chatId !== chatId) return { kind: "cursor_invalid" as const };
        if (
          !chat.activeLeafMessageId ||
          cursor.activeLeafMessageId !== chat.activeLeafMessageId ||
          cursor.snapshotUpdatedAt !== chat.updatedAt.toISOString()
        ) return { kind: "stale" as const };
        const lightweightMessages = await tx.message.findMany({
          select: { id: true, parentMessageId: true },
          where: { chatId }
        });
        const activeMessages = activeBranchPath(lightweightMessages, chat.activeLeafMessageId);
        const boundary = activeMessages.findIndex(
          (message) => message.id === cursor.beforeMessageId
        );
        if (boundary <= 0) return { kind: "stale" as const };
        const start = Math.max(0, boundary - CHAT_HISTORY_PAGE_SIZE);
        const pagePath = activeMessages.slice(start, boundary);
        const messages = await hydrateMessagePath(tx, chatId, pagePath, userId);
        const hasOlder = start > 0;
        return {
          kind: "ok" as const,
          page: {
            messages: messages.messages.map((message) =>
              serializeHydratedMessage(
                message,
                messages.memoryActionsByRun,
                messages.memorySourcesByRun,
                messages.memoryStatusesByRun,
                userId,
                messages.scheduledTasks
              )),
            pageInfo: {
              activeLeafMessageId: chat.activeLeafMessageId,
              beforeCursor: pageCursor({
                activeLeafMessageId: chat.activeLeafMessageId,
                beforeMessageId: messages.messages[0]?.id,
                chatId,
                chatUpdatedAt: chat.updatedAt,
                hasOlder
              }),
              hasOlder,
              snapshotUpdatedAt: chat.updatedAt
            }
          }
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    },
    getChat: async ({ chatId, userId }) => {
      const workspaceSnapshot = await workspaceAvailability.snapshot();
      const read = await prismaClient.$transaction(async (tx) => {
        const access = await resolveChatAccess(tx, { chatId, userId });
        if (!access) return null;
        const chat = await tx.chat.findFirst({
          select: { ...chatSummarySelect, assistantOverrides: true },
          where: {
            archived: false,
            id: chatId,
            permanentDeletionAt: null
          }
        });
        if (!chat) return null;
        const lightweightMessages = await tx.message.findMany({
          select: lightweightMessageSelect,
          where: { chatId }
        });
        const activeMessages = activeBranchPath(lightweightMessages, chat.activeLeafMessageId);
        const pageMessages = activeMessages.slice(-CHAT_HISTORY_PAGE_SIZE);
        const [messages, contextStats, usageStats] = await Promise.all([
          hydrateMessagePath(tx, chatId, pageMessages, userId),
          loadActiveBranchContextStats(tx, activeMessages),
          loadChatUsageTotals(tx, chatId)
        ]);
        const projectDefaultAuthority = access.kind === "project"
          ? await loadProjectChatDefaultAuthority(tx, access.project.projectId)
          : undefined;
        return {
          binding: chat,
          detail: serializeChatDetail({
            viewerUserId: userId,
            availability: workspaceAvailability,
            chat,
            contextStats,
            hasOlder: activeMessages.length > CHAT_HISTORY_PAGE_SIZE,
            usageStats,
            messages,
            ...(projectDefaultAuthority ? { projectDefaultAuthority } : {}),
            workspaceSnapshot
          })
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      if (!read) return null;
      // Outside the read transaction: an unbound chat reads nothing more, and
      // the catalog read of a bound one does not hold the history snapshot open.
      // The projection's own catalog read shares its group read.
      const assistant = await loadChatAssistantProjection(prismaClient, { chat: read.binding, userId }, {
        ...(options.loadCatalogData ? { loadCatalogData: options.loadCatalogData } : {}),
        loadProjectChatAssistant: options.loadProjectChatAssistant ?? loadProjectChatAssistant
      });
      return { ...read.detail, assistant };
    },
    getChatMemoryState: async ({ chatId, userId }) => {
      const chat = await prismaClient.chat.findFirst({
        select: {
          archived: true,
          id: true,
          importSource: true,
          memoryMode: true,
          memorySourceRevision: true,
          temporaryRetentionDeadline: true,
          temporaryRetentionPolicyVersion: true,
          updatedAt: true
        },
        where: { id: chatId, permanentDeletionAt: null, userId }
      });
      if (!chat) return null;
      if (
        chat.memoryMode === "TEMPORARY" &&
        (!chat.temporaryRetentionDeadline ||
          chat.temporaryRetentionPolicyVersion !== MEMORY_TEMPORARY_RETENTION_POLICY_VERSION)
      ) {
        throw new Error("temporary_chat_lifecycle_integrity_invalid");
      }
      return {
        archived: chat.archived,
        chatId: chat.id,
        ...(chat.importSource ? { importSource: chat.importSource } : {}),
        mode: chat.memoryMode,
        sourceRevision: chat.memorySourceRevision,
        temporaryRetentionDeadline: chat.memoryMode === "TEMPORARY"
          ? chat.temporaryRetentionDeadline
          : null,
        temporaryRetentionPolicyVersion: chat.memoryMode === "TEMPORARY"
          ? MEMORY_TEMPORARY_RETENTION_POLICY_VERSION
          : null,
        updatedAt: chat.updatedAt
      };
    },
    getMessagesPage: async ({ before, chatId, userId }) => {
      return prismaClient.$transaction(async (tx) => {
        const access = await resolveChatAccess(tx, { chatId, userId });
        if (!access) return { kind: "not_found" as const };
        const chat = await tx.chat.findFirst({
          select: {
            activeLeafMessageId: true,
            id: true,
            updatedAt: true
          },
          where: { archived: false, id: chatId, permanentDeletionAt: null }
        });
        if (!chat) return { kind: "not_found" as const };
        const cursor = decodeHistoryCursor(before);
        if (!cursor || cursor.chatId !== chatId) return { kind: "cursor_invalid" as const };
        if (
          !chat.activeLeafMessageId ||
          cursor.activeLeafMessageId !== chat.activeLeafMessageId ||
          cursor.snapshotUpdatedAt !== chat.updatedAt.toISOString()
        ) return { kind: "stale" as const };
        const lightweightMessages = await tx.message.findMany({
          select: {
            id: true,
            parentMessageId: true
          },
          where: { chatId }
        });
        const activeMessages = activeBranchPath(lightweightMessages, chat.activeLeafMessageId);
        const boundary = activeMessages.findIndex(
          (message) => message.id === cursor.beforeMessageId
        );
        if (boundary <= 0) return { kind: "stale" as const };
        const start = Math.max(0, boundary - CHAT_HISTORY_PAGE_SIZE);
        const pagePath = activeMessages.slice(start, boundary);
        const messages = await hydrateMessagePath(tx, chatId, pagePath, userId);
        const hasOlder = start > 0;
        return {
          kind: "ok" as const,
          page: {
            messages: messages.messages.map((message) =>
              serializeHydratedMessage(
                message,
                messages.memoryActionsByRun,
                messages.memorySourcesByRun,
                messages.memoryStatusesByRun,
                userId,
                messages.scheduledTasks
              )),
            pageInfo: {
              activeLeafMessageId: chat.activeLeafMessageId,
              beforeCursor: pageCursor({
                activeLeafMessageId: chat.activeLeafMessageId,
                beforeMessageId: messages.messages[0]?.id,
                chatId,
                chatUpdatedAt: chat.updatedAt,
                hasOlder
              }),
              hasOlder,
              snapshotUpdatedAt: chat.updatedAt
            }
          }
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    },
    getBranches: async ({ chatId, userId }) => {
      return prismaClient.$transaction(async (tx) => {
        const access = await resolveChatAccess(tx, { chatId, userId });
        if (!access) return null;
        const chat = await tx.chat.findFirst({
          select: { activeLeafMessageId: true, updatedAt: true },
          where: { archived: false, id: chatId, permanentDeletionAt: null }
        });
        if (!chat) return null;
        const rows = await tx.$queryRaw<Array<{
          id: string;
          parentMessageId: string | null;
          preview: string;
          role: "assistant" | "user";
          status: "cancelled" | "complete" | "error" | "queued" | "streaming";
        }>>(Prisma.sql`
          SELECT
            m."id",
            m."parentMessageId",
            LEFT(regexp_replace(COALESCE((
              SELECT string_agg(CASE
                WHEN block->>'type' IN ('text', 'input_text', 'output_text')
                  THEN COALESCE(block->>'text', '')
                ELSE ''
              END, ' ')
              FROM jsonb_array_elements(CASE
                WHEN jsonb_typeof(m."content"->'blocks') = 'array'
                  THEN m."content"->'blocks'
                ELSE '[]'::jsonb
              END) AS block
            ), ''), '\\s+', ' ', 'g'), CAST(${CHAT_BRANCH_PREVIEW_MAX_LENGTH} AS integer)) AS "preview",
            m."role",
            m."status"::text AS "status"
          FROM "Message" m
          WHERE m."chatId" = ${chatId}
          ORDER BY m."createdAt" ASC, m."id" ASC
        `);
        const graph: ChatBranchGraphRecord = {
          activeLeafMessageId: chat.activeLeafMessageId,
          nodes: rows.map((row) => ({
            ...row,
            preview: boundedChatBranchPreview(row.preview)
          })),
          snapshotUpdatedAt: chat.updatedAt
        };
        return graph;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    },
    updateFolder: async ({ defaultKnowledgePlan, folderId, name, parentId, projectMemory, userId }) => {
      const trimmed = typeof name === "string" ? name.trim() : undefined;
      if (typeof name === "string" && !trimmed) {
        return null;
      }

      if (parentId === folderId) {
        return null;
      }

      try {
        return await prismaClient.$transaction(
          async (tx) => {
            if (parentId) {
              const parent = await findOwnedFolder(tx, parentId, userId);
              if (!parent) {
                return null;
              }
            }

            if (
              await wouldCreateFolderCycle({
                folderId,
                parentId,
                prismaClient: tx,
                userId
              })
            ) {
              return null;
            }

            const result = await tx.folder.updateMany({
              data: {
                ...(defaultKnowledgePlan !== undefined
                  ? { defaultKnowledgePlan: knowledgeDefaultJson(defaultKnowledgePlan) }
                  : {}),
                ...(trimmed !== undefined ? { name: trimmed } : {}),
                ...(parentId !== undefined ? { parentId } : {}),
                ...(projectMemory !== undefined ? { projectMemory: projectMemory.slice(0, 12000) } : {})
              },
              where: {
                id: folderId,
                userId
              }
            });

            if (result.count === 0) {
              return null;
            }

            const folder = await tx.folder.findFirst({
              select: {
                defaultKnowledgePlan: true,
                id: true,
                name: true,
                parentId: true,
                projectMemory: true,
                sortOrder: true
              },
              where: {
                id: folderId,
                userId
              }
            });
            return folder
              ? { ...folder, defaultKnowledgePlan: storedKnowledgeDefault(folder.defaultKnowledgePlan) }
              : null;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable
          }
        );
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === "P2002" || error.code === "P2034")
        ) {
          return null;
        }

        throw error;
      }
    },
    listArchivedChats: async ({ cursor: cursorValue, userId }) => {
      const workspaceSnapshot = await workspaceAvailability.snapshot();
      const cursor = cursorValue ? decodeArchivedChatCursor(cursorValue) : null;
      if (cursorValue && !cursor) return { kind: "cursor_invalid" as const };
      const rows = await prismaClient.chat.findMany({
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        select: archivedChatSummarySelect,
        take: ARCHIVED_CHAT_PAGE_SIZE + 1,
        where: {
          archived: true,
          memoryMode: { not: "TEMPORARY" },
          permanentDeletionAt: null,
          projectId: null,
          userId,
          ...(cursor
            ? {
                OR: [
                  { updatedAt: { lt: new Date(cursor.updatedAt) } },
                  { id: { lt: cursor.id }, updatedAt: new Date(cursor.updatedAt) }
                ]
              }
            : {})
        }
      });
      const hasMore = rows.length > ARCHIVED_CHAT_PAGE_SIZE;
      const page = rows.slice(0, ARCHIVED_CHAT_PAGE_SIZE);
      const boundary = page.at(-1);
      return {
        chats: page.map((chat) =>
          serializeArchivedChatSummary(chat, workspaceAvailability, workspaceSnapshot)),
        kind: "ok" as const,
        nextCursor: hasMore && boundary
          ? encodeArchivedChatCursor({
              id: boundary.id,
              updatedAt: boundary.updatedAt.toISOString(),
              v: 1
            })
          : null
      };
    },
    listWorkspace: async (userId) => {
      const workspaceSnapshot = await workspaceAvailability.snapshot();
      const user = await prismaClient.user.findUnique({
        select: {
          id: true
        },
        where: {
          id: userId
        }
      });

      if (!user) {
        return null;
      }

      const [folders, chats] = await Promise.all([
        prismaClient.folder.findMany({
          orderBy: [
            {
              sortOrder: "asc"
            },
            {
              name: "asc"
            }
          ],
          select: {
            defaultKnowledgePlan: true,
            id: true,
            name: true,
            parentId: true,
            projectMemory: true,
            sortOrder: true
          },
          where: {
            userId
          }
        }),
        prismaClient.chat.findMany({
          orderBy: [
            {
              pinned: "desc"
            },
            {
              updatedAt: "desc"
            }
          ],
          select: chatSummarySelect,
          where: {
            archived: false,
            memoryMode: { not: "TEMPORARY" },
            permanentDeletionAt: null,
            projectId: null,
            userId
          }
        })
      ]);

      return {
        chats: chats.map((chat) =>
          serializeChatSummary(chat, workspaceAvailability, workspaceSnapshot)),
        folders: folders.map((folder) => ({
          ...folder,
          defaultKnowledgePlan: storedKnowledgeDefault(folder.defaultKnowledgePlan)
        }))
      };
    },
    resolveChatSource: async ({ chatId, userId }) => {
      const chat = await prismaClient.chat.findFirst({
        select: {
          archived: true,
          id: true,
          memoryMode: true,
          memorySourceRevision: true,
          updatedAt: true
        },
        where: {
          id: chatId,
          memoryMode: { not: "TEMPORARY" },
          permanentDeletionAt: null,
          projectId: null,
          userId
        }
      });
      if (!chat || chat.memoryMode === "TEMPORARY") return null;
      return {
        chatId: chat.id,
        location: chat.archived ? "ARCHIVED_PREVIEW" as const : "ACTIVE_CHAT" as const,
        memoryMode: chat.memoryMode,
        sourceRevision: chat.memorySourceRevision,
        updatedAt: chat.updatedAt
      };
    },
    setMemoryMode: async ({
      chatId,
      expectedChatRevision,
      expectedMemoryRevision,
      mode,
      resumeDisclosureCopyVersion,
      userId
    }) => {
      const hasChatFence = expectedChatRevision !== undefined;
      const hasMemoryFence = expectedMemoryRevision !== undefined;
      if (
        hasChatFence !== hasMemoryFence ||
        (hasChatFence && (!Number.isSafeInteger(expectedChatRevision) ||
          (expectedChatRevision ?? -1) < 0)) ||
        (hasMemoryFence && (!Number.isSafeInteger(expectedMemoryRevision) ||
          (expectedMemoryRevision ?? -1) < 0)) ||
        (mode === "NORMAL" &&
          resumeDisclosureCopyVersion !== MEMORY_CONFIRMATION_COPY_VERSION) ||
        (mode === "EXCLUDED" && resumeDisclosureCopyVersion !== undefined)
      ) return { kind: "contract_invalid" as const };
      return prismaClient.$transaction(async (tx) => {
        const chats = await tx.$queryRaw<Array<LockedMemorySourceChat & { importSource: string | null }>>`
          SELECT
            "id", "userId", "activeLeafMessageId", "archived", "folderId",
            "memoryMode", "memoryBranchGeneration", "memorySourceRevision",
            "temporaryRetentionPolicyVersion", "temporaryRetentionDeadline",
            "importSource"::text AS "importSource"
          FROM "Chat"
          WHERE "id" = ${chatId}
            AND "userId" = ${userId}
            AND "projectId" IS NULL
            AND "permanentDeletionAt" IS NULL
          FOR UPDATE
        `;
        const chat = chats[0];
        if (!chat) return { kind: "not_found" as const };
        if (chat.memoryMode === "TEMPORARY") return { kind: "temporary" as const };
        // An imported chat, or a copy of one, stays Excluded (a database check
        // backs this for every other writer).
        if (chat.importSource !== null && mode === "NORMAL") return { kind: "imported" as const };
        if (
          (hasChatFence && chat.memorySourceRevision !== expectedChatRevision) ||
          chat.memoryMode === mode
        ) return { kind: "source_stale" as const };

        const settings = await lockMemorySettings(tx, userId, false);
        if (hasMemoryFence && settings.memoryRevision !== expectedMemoryRevision) {
          return { kind: "memory_stale" as const };
        }
        if (mode === "NORMAL" && !(await resumeSuppressionPreflight(tx, userId))) {
          return { kind: "resume_blocked" as const };
        }

        const snapshot = await applyMemorySourceMutations(tx, {
          chat,
          hooks: memorySourceHooks,
          mutations: [mode === "EXCLUDED" ? "SOURCE_EXCLUDE" : "SOURCE_RESUME"],
          patch: { memoryMode: mode }
        });
        const advanced = await tx.userMemorySettings.findUniqueOrThrow({
          select: { memoryGeneration: true, memoryRevision: true },
          where: { userId }
        });
        return {
          kind: "ok" as const,
          response: {
            chatId: snapshot.id,
            memoryGeneration: advanced.memoryGeneration,
            memoryRevision: advanced.memoryRevision,
            mode: snapshot.memoryMode,
            sourceRevision: snapshot.memorySourceRevision
          }
        };
      });
    },
    updateChat: async ({
      activeLeafMessageId,
      assistantId,
      assistantOverrides,
      chatId,
      defaultKnowledgePlan,
      defaultSearchPlan,
      folderId,
      pinned,
      title,
      userId,
      workspaceEnabled
    }) => {
      const workspaceSnapshot = await workspaceAvailability.snapshot();
      const access = await resolveChatAccess(prismaClient, {
        chatId,
        minimumProjectRole: "CONTRIBUTOR",
        requireMutable: true,
        userId
      });
      if (!access) return null;
      // Like the other fields that shape the next run, the binding waits for
      // an active run to settle.
      const changesNextRun = activeLeafMessageId !== undefined || workspaceEnabled !== undefined ||
        assistantId !== undefined || assistantOverrides !== undefined;
      if (access.kind === "project") {
        // Chat values in a Project chat are checked against the Project's
        // own catalog and resources, never the member's personal ones.
        const authority = assistantOverrides !== undefined && projectOverridesNeedAuthority(assistantOverrides)
          ? await loadProjectAssistantAuthority(prismaClient, access.project.projectId)
          : null;
        return prismaClient.$transaction(async (tx) => {
          await lockBindableAssistant(tx, assistantId, {
            kind: "project",
            projectId: access.project.projectId
          });
          await tx.$queryRaw(Prisma.sql`
            SELECT "id" FROM "Project"
            WHERE "id" = ${access.project.projectId}
            FOR UPDATE
          `);
          const currentAccess = await resolveChatAccess(tx, {
            chatId,
            minimumProjectRole: "CONTRIBUTOR",
            requireMutable: true,
            userId
          });
          if (currentAccess?.kind !== "project") return null;
          const rows = await tx.$queryRaw<Array<{
            activeLeafMessageId: string | null;
            archived: boolean;
            createdByUserId: string | null;
            id: string;
            projectId: string;
          }>>(Prisma.sql`
            SELECT "id", "projectId", "activeLeafMessageId", "archived", "createdByUserId"
            FROM "Chat"
            WHERE "id" = ${chatId}
              AND "projectId" = ${currentAccess.project.projectId}
              AND "permanentDeletionAt" IS NULL
            FOR UPDATE
          `);
          const current = rows[0];
          if (!current || current.archived) return null;
          const manager = projectRoleAtLeast(currentAccess.project.effectiveRole, "MANAGER");
          if (!manager && (
            defaultKnowledgePlan !== undefined ||
            folderId !== undefined ||
            pinned !== undefined ||
            (title !== undefined && current.createdByUserId !== userId)
          )) return null;
          if (folderId) {
            const folder = await tx.projectFolder.findUnique({
              where: {
                projectId_id: { id: folderId, projectId: current.projectId }
              }
            });
            if (!folder) return null;
          }
          if (activeLeafMessageId) {
            const message = await tx.message.findFirst({
              select: { id: true },
              where: { chatId, id: activeLeafMessageId }
            });
            if (!message) return null;
          }
          if (changesNextRun) {
            const activeRun = await tx.modelRun.findFirst({
              select: { id: true },
              where: {
                chatId,
                status: { in: ["preparing", "streaming", "queued", "in_progress"] }
              }
            });
            if (activeRun) throw new ActiveRunConflictError();
          }
          // Validated before the write, so a refusal changes nothing. The
          // binding and its values never change the Project's defaults.
          const assistantData = await assistantUpdateData(tx, {
            assistantId,
            catalog: authority?.catalog ?? null,
            chatId,
            knowledgeAvailable: (value) => authority !== null &&
              projectKnowledgeOverrideAvailable(authority.available, value),
            patch: assistantOverrides,
            scope: { kind: "project", projectId: current.projectId }
          });
          const updated = await tx.chat.update({
            data: {
              ...(activeLeafMessageId !== undefined ? { activeLeafMessageId } : {}),
              ...assistantData,
              ...(defaultKnowledgePlan !== undefined
                ? { defaultKnowledgePlan: knowledgeDefaultJson(defaultKnowledgePlan) }
                : {}),
              ...(defaultSearchPlan !== undefined ? { defaultSearchPlan: defaultSearchPlan === null ? Prisma.DbNull : { mode: defaultSearchPlan.mode, optionIds: [...defaultSearchPlan.optionIds] } } : {}),
              ...(folderId !== undefined ? { projectFolderId: folderId } : {}),
              ...(pinned !== undefined ? { pinned } : {}),
              ...(title ? { title: title.trim(), titleRevision: { increment: 1 } } : {}),
              ...(workspaceEnabled === undefined ? {} : { workspaceEnabled })
            },
            select: chatSummarySelect,
            where: { id: chatId }
          });
          return serializeChatSummary(updated, workspaceAvailability, workspaceSnapshot);
        });
      }
      const catalog = assistantOverrides !== undefined && overridesNeedCatalog(assistantOverrides)
        ? await loadCatalogData(userId)
        : null;
      return prismaClient.$transaction(async (tx) => {
        await lockBindableAssistant(tx, assistantId, { kind: "personal", userId });
        if (folderId) {
          const folders = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM "Folder"
            WHERE "id" = ${folderId} AND "userId" = ${userId}
            FOR KEY SHARE
          `;
          if (!folders[0]) {
            return null;
          }
        }
        const chats = await tx.$queryRaw<LockedMemorySourceChat[]>`
          SELECT
            "id", "userId", "activeLeafMessageId", "archived", "folderId",
            "memoryMode", "memoryBranchGeneration", "memorySourceRevision",
            "temporaryRetentionPolicyVersion", "temporaryRetentionDeadline"
          FROM "Chat"
          WHERE "id" = ${chatId}
            AND "userId" = ${userId}
            AND "permanentDeletionAt" IS NULL
          FOR UPDATE
        `;
        if (!chats[0] || chats[0].archived) {
          return null;
        }

        if (activeLeafMessageId) {
          const message = await tx.message.findFirst({
            select: {
              id: true
            },
            where: {
              chatId,
              id: activeLeafMessageId
            }
          });
          if (!message) {
            return null;
          }
        }

        if (changesNextRun) {
          const activeRun = await tx.modelRun.findFirst({
            select: {
              id: true
            },
            where: {
              chatId,
              status: {
                in: ["preparing", "streaming", "queued", "in_progress"]
              }
            }
          });
          if (activeRun) {
            throw new ActiveRunConflictError();
          }
        }

        // Validated before any other write, so a refusal changes nothing.
        const assistantData = await assistantUpdateData(tx, {
          assistantId,
          catalog: catalog ? chatAssistantOverrideCatalog(catalog) : null,
          chatId,
          knowledgeAvailable: (value) => knowledgeOverrideAvailable(tx, userId, value),
          patch: assistantOverrides,
          scope: { kind: "personal", userId }
        });

        const mutations: MemorySourceMutation[] = [];
        if (
          activeLeafMessageId !== undefined &&
          activeLeafMessageId !== chats[0].activeLeafMessageId
        ) {
          mutations.push("BRANCH_PATH_CHANGE");
        }
        if (folderId !== undefined && folderId !== chats[0].folderId) {
          mutations.push("FOLDER_MOVE");
        }
        if (mutations.length > 0) {
          await applyMemorySourceMutations(tx, {
            chat: chats[0],
            hooks: memorySourceHooks,
            mutations,
            patch: {
              ...(activeLeafMessageId !== undefined ? { activeLeafMessageId } : {}),
              ...(folderId !== undefined ? { folderId } : {})
            }
          });
        }

        const hasMetadataUpdate = defaultSearchPlan !== undefined || defaultKnowledgePlan !== undefined ||
          pinned !== undefined || Boolean(title) || workspaceEnabled !== undefined ||
          Object.keys(assistantData).length > 0;
        const updated = hasMetadataUpdate
          ? await tx.chat.update({
              data: {
                ...assistantData,
                ...(defaultKnowledgePlan !== undefined
                  ? { defaultKnowledgePlan: knowledgeDefaultJson(defaultKnowledgePlan) }
                  : {}),
                ...(defaultSearchPlan !== undefined ? { defaultSearchPlan: defaultSearchPlan === null ? Prisma.DbNull : { mode: defaultSearchPlan.mode, optionIds: [...defaultSearchPlan.optionIds] } } : {}),
                ...(pinned !== undefined ? { pinned } : {}),
                ...(title ? { title: title.trim(), titleRevision: { increment: 1 } } : {}),
                ...(workspaceEnabled === undefined ? {} : { workspaceEnabled })
              },
              select: chatSummarySelect,
              where: { id: chatId }
            })
          : await tx.chat.findUniqueOrThrow({
              select: chatSummarySelect,
              where: { id: chatId }
            });

        return serializeChatSummary(updated, workspaceAvailability, workspaceSnapshot);
      });
    }
  };
}
