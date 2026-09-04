import { Prisma } from "@prisma/client";
import {
  estimateApproxTokensFromProjectedParts,
  type ApproxTokenProjectedPart
} from "../../domain/contextBudget";
import { safeExternalHref } from "../../domain/links";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import {
  WORKSPACE_MCP_TOOL_ALLOWLIST,
  isRetryableWorkspaceExportErrorCode
} from "../../domain/workspace";
import {
  WORKSPACE_ACTIVITY_MAX_ENTRIES,
  decodeThreadWorkspaceActivityEntry,
  isWorkspaceErrorCode,
  type ThreadWorkspaceActivity,
  type ThreadWorkspaceActivityEntry,
  type ThreadWorkspaceOutputStatus
} from "../../contracts/workspace";
import { foldWorkspaceActivityEntries } from "../workspace/activityProjection";
import { projectThreadSearchSources } from "../../domain/searchSources";
import { decodeAssistantAvatarRecipe } from "../../contracts/assistants";
import {
  ARCHIVED_CHAT_CURSOR_MAX_LENGTH,
  ARCHIVED_CHAT_PAGE_SIZE,
  CHAT_BRANCH_PREVIEW_MAX_LENGTH,
  CHAT_HISTORY_CURSOR_MAX_LENGTH,
  CHAT_HISTORY_PAGE_SIZE,
  boundedChatBranchPreview,
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
import { ActiveRunConflictError } from "../runs/runRepositoryContract";
import { resolveChatAccess } from "../projects/access";
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
import { loadChatCreationDefaults } from "./chatCreationDefaults";
import { defaultChatTitle } from "./titlePolicy";
import { workspaceAvailabilityService as defaultWorkspaceAvailabilityService } from "../workspace/defaultServices";
import type {
  WorkspaceAvailabilityService,
  WorkspaceAvailabilitySnapshot
} from "../workspace/availability";
import { workspaceModelSupportsTools } from "../workspace/availability";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";
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
  answerStartedAt: true,
  assistantId: true,
  assistantMessageId: true,
  assistantRevision: {
    select: {
      avatar: true,
      name: true,
      revisionNumber: true
    }
  },
  events: {
    orderBy: {
      sequence: "asc"
    },
    select: {
      payload: true
    },
    where: {
      eventType: "artifact"
    }
  },
  createdAt: true,
  errorPayload: true,
  id: true,
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
      artifacts: true
    }
  },
  normalizedRequest: true,
  status: true,
  toolCalls: {
    orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }],
    select: {
      completedAt: true,
      ordinal: true,
      roundIndex: true,
      startedAt: true,
      state: true,
      toolName: true
    }
  },
  updatedAt: true,
  workspaceRunBinding: {
    select: { exportState: true, lastExportErrorCode: true }
  },
  workspaceProducedAttachments: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      byteSize: true,
      fileName: true,
      id: true,
      mimeType: true,
      workspaceRunOutput: { select: { relativePath: true } }
    }
  }
} satisfies Prisma.ModelRunSelect;

const hydratedMessageSelect = {
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
  status: true
} satisfies Prisma.MessageSelect;

const lightweightMessageSelect = {
  assistantModelRuns: {
    orderBy: { createdAt: "desc" },
    select: {
      cachedInputTokens: true,
      cacheWriteInputTokens: true,
      inputTokens: true,
      outputTokens: true,
      status: true,
      totalTokens: true
    },
    take: 1
  },
  id: true,
  parentMessageId: true,
  role: true
} satisfies Prisma.MessageSelect;

const chatSummarySelect = {
  _count: {
    select: {
      messages: true
    }
  },
  activeLeafMessageId: true,
  createdAt: true,
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
}>;
type LightweightMessageRow = Prisma.MessageGetPayload<{ select: typeof lightweightMessageSelect }>;
type ArtifactSummaryRun = {
  answerStartedAt?: Date | null;
  createdAt?: Date;
  events: { payload: unknown }[];
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
  errorPayload: unknown;
  normalizedRequest: unknown;
  status: string;
  toolCalls: {
    completedAt: Date | null;
    ordinal: number;
    roundIndex: number;
    startedAt: Date | null;
    state: string;
    toolName: string;
  }[];
};

type UsageStatsMessage = {
  assistantModelRuns: {
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    inputTokens: number;
    outputTokens: number;
    status: string;
    totalTokens: number;
  }[];
  id: string;
  parentMessageId: string | null;
  role: string;
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
      messages: []
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
  const [memoryActionsByRun, memorySourcesByRun, memoryStatusesByRun] = await Promise.all([
    loadMemoryRunActions(tx, { runIds, userId }),
    loadMemoryRunSources(tx, { runIds, userId }),
    loadMemoryRunPresentationStatuses(tx, { runIds, userId })
  ]);
  return { memoryActionsByRun, memorySourcesByRun, memoryStatusesByRun, messages: ordered };
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

function summarizeChatUsageStats(input: {
  activeLeafMessageId: string | null;
  messages: UsageStatsMessage[];
}): ChatUsageStats {
  const activeMessages = activeBranchPath(input.messages, input.activeLeafMessageId);
  const completedRuns = activeMessages.flatMap((message) => {
    if (message.role !== "assistant") {
      return [];
    }

    const run = message.assistantModelRuns[0];
    return run?.status === "complete" ? [run] : [];
  });

  return completedRuns.reduce<ChatUsageStats>(
    (total, run) => ({
      activeBranchMessageCount: total.activeBranchMessageCount,
      cachedInputTokens: total.cachedInputTokens + run.cachedInputTokens,
      cacheWriteInputTokens: total.cacheWriteInputTokens + run.cacheWriteInputTokens,
      totalTokens: total.totalTokens + (run.totalTokens > 0 ? run.totalTokens : run.inputTokens + run.outputTokens)
    }),
    {
      activeBranchMessageCount: activeMessages.length,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      totalTokens: 0
    }
  );
}

function serializeHydratedMessage(
  message: HydratedMessageRow,
  memoryActionsByRun: ReadonlyMap<string, MemoryActionFeedback>,
  memorySourcesByRun: ReadonlyMap<string, readonly MemoryAnswerSource[]>,
  memoryStatusesByRun: ReadonlyMap<string, MemoryRunPresentationStatus>
): ChatDetailRecord["messages"][number] {
  const modelRun = message.assistantModelRuns[0] ?? message.branchSourceModelRun ?? undefined;
  const artifactSummary = modelRun
    ? summarizeMessageRunArtifacts(
        modelRun,
        message.content,
        memoryActionsByRun.get(modelRun.id) ?? null,
        memorySourcesByRun.get(modelRun.id) ?? [],
        memoryStatusesByRun.get(modelRun.id)
      )
    : null;
  return {
    artifactSummary,
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
    status: message.status,
    toolActivity: modelRun ? summarizeMessageRunToolActivity(modelRun) : null,
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
    session: input.chat.workspaceSession
  });
}

function serializeChatDetail(input: {
  availability: WorkspaceAvailabilityService;
  chat: ChatSummaryRow;
  contextInputTokens: number;
  hasOlder: boolean;
  lightweightMessages: LightweightMessageRow[];
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
    createdAt: chat.createdAt,
    defaultKnowledgePlan: projectDefaults
      ? projectDefaults.defaultKnowledgePlan
      : storedKnowledgeDefault(chat.defaultKnowledgePlan),
    defaultModelId: projectDefaults
      ? projectDefaults.defaultModelId
      : chat.defaultProviderModel?.id ?? null,
    defaultProvider: projectDefaults
      ? projectDefaults.defaultProvider
      : chat.defaultProviderModel?.connectionId ?? null,
    folderId: chat.projectFolderId ?? chat.folderId,
    id: chat.id,
    contextStats: {
      approximateActiveBranchInputTokens: input.contextInputTokens
    },
    messageCount: chat._count.messages,
    messages: input.messages.messages.map((message) =>
      serializeHydratedMessage(
        message,
        input.messages.memoryActionsByRun,
        input.messages.memorySourcesByRun,
        input.messages.memoryStatusesByRun
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
    updatedAt: chat.updatedAt,
    usageStats: summarizeChatUsageStats({
      activeLeafMessageId: chat.activeLeafMessageId,
      messages: input.lightweightMessages
    }),
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
  assistantRevision: { avatar: unknown; name: string; revisionNumber: number } | null;
} | undefined): NonNullable<ChatDetailRecord["messages"][number]["assistantIdentity"]> | null {
  const revision = modelRun?.assistantRevision;
  if (!revision) return null;
  const avatar = decodeAssistantAvatarRecipe(revision.avatar);
  if (!avatar) return null;
  return {
    avatar,
    name: revision.name,
    revisionNumber: revision.revisionNumber
  };
}

function serializeChatSummary(
  chat: ChatSummaryRow,
  availability: WorkspaceAvailabilityService,
  workspaceSnapshot: WorkspaceAvailabilitySnapshot
): ChatSummaryRecord {
  return {
    activeLeafMessageId: chat.activeLeafMessageId,
    createdAt: chat.createdAt,
    defaultKnowledgePlan: storedKnowledgeDefault(chat.defaultKnowledgePlan),
    defaultModelId: chat.defaultProviderModel?.id ?? null,
    defaultProvider: chat.defaultProviderModel?.connectionId ?? null,
    folderId: chat.projectFolderId ?? chat.folderId,
    id: chat.id,
    messageCount: chat._count.messages,
    pinned: chat.pinned,
    projectId: chat.projectId,
    title: chat.title,
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
  availability: WorkspaceAvailabilityService;
  chat: ArchivedChatSummaryRow;
  contextInputTokens: number;
  hasOlder: boolean;
  lightweightMessages: LightweightMessageRow[];
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

function activityName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized.slice(0, 160)
    : fallback;
}

function toolActivityDescriptors(normalizedRequest: unknown): Map<string, {
  serverName?: string;
  toolName: string;
}> {
  const descriptors = new Map<string, { serverName?: string; toolName: string }>();
  if (!isRecord(normalizedRequest)) return descriptors;

  const mcp = isRecord(normalizedRequest.mcp) ? normalizedRequest.mcp : null;
  if (mcp && Array.isArray(mcp.tools)) {
    for (const value of mcp.tools) {
      if (!isRecord(value) || typeof value.namespacedName !== "string") continue;
      descriptors.set(value.namespacedName, {
        serverName: activityName(value.serverName, "MCP server"),
        toolName: activityName(value.originalName, "Tool")
      });
    }
  }

  const discovery = isRecord(normalizedRequest.mcpDiscovery)
    ? normalizedRequest.mcpDiscovery
    : null;
  const catalog = discovery && isRecord(discovery.catalog) ? discovery.catalog : null;
  if (catalog && Array.isArray(catalog.servers)) {
    for (const server of catalog.servers) {
      if (!isRecord(server) || !Array.isArray(server.tools)) continue;
      for (const value of server.tools) {
        if (!isRecord(value) || typeof value.namespacedName !== "string") continue;
        if (!descriptors.has(value.namespacedName)) {
          descriptors.set(value.namespacedName, {
            serverName: activityName(server.serverName, "MCP server"),
            toolName: activityName(value.originalName, "Tool")
          });
        }
      }
    }
  }

  const searchPlan = isRecord(normalizedRequest.searchPlan) ? normalizedRequest.searchPlan : null;
  if (searchPlan && Array.isArray(searchPlan.options)) {
    searchPlan.options.forEach((option, index) => {
      descriptors.set(`search_engine_${index + 1}`, {
        serverName: isRecord(option)
          ? activityName(option.displayName, "Web search")
          : "Web search",
        toolName: "search"
      });
    });
  }

  if (isRecord(normalizedRequest.workspace) && normalizedRequest.workspace.enabled === true) {
    for (const name of WORKSPACE_MCP_TOOL_ALLOWLIST) {
      descriptors.set(namespacedWorkspaceToolName(name), {
        serverName: "Workspace",
        toolName: name
      });
    }
  }

  descriptors.set("find_tools", { serverName: "Auto tools", toolName: "find_tools" });
  descriptors.set("search_knowledge", { serverName: "Knowledge", toolName: "search_knowledge" });
  descriptors.set("retrieve_knowledge", { serverName: "Knowledge", toolName: "search_knowledge" });
  for (const name of [
    "forget_memory",
    "list_memories",
    "mark_memory_incorrect",
    "save_memory",
    "search_memory",
    "update_memory"
  ]) {
    descriptors.set(name, { serverName: "Memory", toolName: name });
  }
  return descriptors;
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
  if (!budgets || run.status !== "complete") return undefined;
  if (run.toolCalls.length >= budgets.maxToolCalls) {
    return { kind: "calls", limit: budgets.maxToolCalls };
  }
  const rounds = new Set(run.toolCalls.map((call) => call.roundIndex)).size;
  return rounds >= budgets.maxToolRounds
    ? { kind: "rounds", limit: budgets.maxToolRounds }
    : undefined;
}

/** Owner-safe activity only: no arguments, results, internal ids, or raw events. */
export function summarizeMessageRunToolActivity(
  run: ToolActivityRun
): ThreadToolActivity | null {
  const descriptors = toolActivityDescriptors(run.normalizedRequest);
  const calls = run.toolCalls.map((call) => {
    const descriptor = descriptors.get(call.toolName) ?? {
      toolName: call.toolName.startsWith("mcp_")
        ? "MCP tool"
        : activityName(call.toolName, "Tool")
    };
    const duration = call.startedAt && call.completedAt
      ? call.completedAt.getTime() - call.startedAt.getTime()
      : null;
    const status = call.state === "complete" || call.state === "error" ||
      call.state === "cancelled"
      ? call.state
      : "running";
    return {
      ...(duration !== null && duration >= 0 ? { durationMs: duration } : {}),
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
  return calls.length > 0 || warning
    ? { calls, ...(warning ? { warning } : {}) }
    : null;
}

type WorkspaceActivityRun = {
  events: { payload: unknown }[];
  status: string;
  workspaceRunBinding?: {
    exportState: string;
    lastExportErrorCode: string | null;
  } | null;
};

function workspaceOutputStatus(run: WorkspaceActivityRun): ThreadWorkspaceOutputStatus | undefined {
  const binding = run.workspaceRunBinding;
  if (!binding) return undefined;
  const code = isWorkspaceErrorCode(binding.lastExportErrorCode) ? binding.lastExportErrorCode : undefined;
  if (binding.exportState === "COMPLETE") return { state: "complete" };
  if (binding.exportState === "EXPORTING") return { state: "exporting" };
  if (binding.exportState === "FAILED") {
    return isRetryableWorkspaceExportErrorCode(binding.lastExportErrorCode)
      ? { ...(code ? { errorCode: code } : {}), state: "retrying" }
      : { ...(code ? { errorCode: code } : {}), state: "failed" };
  }
  // PENDING: the export is owed once the answer is complete; before that it has not started.
  return run.status === "complete" ? { state: "retrying" } : undefined;
}

/**
 * Reloadable Workspace timeline: exact persisted `workspace_activity` entries
 * folded to their latest state, with entries a stopped or crashed run left
 * running settled from the run outcome, plus the export status of the binding.
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
  if (entries.length === 0 && !outputStatus) return null;
  const terminal = run.status === "cancelled"
    ? "cancelled" as const
    : run.status === "error" ? "failed" as const : null;
  return {
    entries: foldWorkspaceActivityEntries(entries, terminal).slice(0, WORKSPACE_ACTIVITY_MAX_ENTRIES),
    ...(outputStatus ? { outputStatus } : {})
  };
}

function safeJsonSnippet(value: unknown): string {
  if (typeof value === "string") {
    return value.trim().slice(0, 1200);
  }

  try {
    return JSON.stringify(value, null, 2).slice(0, 1200);
  } catch {
    return "";
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function reasoningTextFromValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }

  if (Array.isArray(value)) {
    const parts = value.map(reasoningTextFromValue).filter((text): text is string => Boolean(text));
    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  if (!isRecord(value)) {
    const text = safeJsonSnippet(value);
    return text || null;
  }

  for (const key of ["delta", "summary", "reasoning", "text"]) {
    if (key in value) {
      return reasoningTextFromValue(value[key]);
    }
  }

  if (Object.keys(value).length === 0) {
    return null;
  }

  const text = safeJsonSnippet(value);
  return text || null;
}

function artifactType(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.artifactType === "string" ? payload.artifactType : null;
}

function artifactInnerPayload(payload: unknown): unknown {
  return isRecord(payload) && "payload" in payload ? payload.payload : null;
}

function reasoningText(payload: unknown): string | null {
  const inner = artifactInnerPayload(payload);
  return reasoningTextFromValue(inner);
}

function citationFromPayload(payload: unknown, fallbackIndex: number): ThreadCitation | null {
  const inner = artifactInnerPayload(payload);
  if (typeof inner === "string" && inner.trim()) {
    const url = safeExternalHref(inner);
    if (!url) return null;
    return {
      index: fallbackIndex,
      title: `Source ${fallbackIndex}`,
      url
    };
  }

  if (!isRecord(inner)) return null;
  const url = safeExternalHref(optionalString(inner.url) ?? optionalString(inner.href));
  if (!url) return null;
  const index = typeof inner.index === "number" && Number.isSafeInteger(inner.index) &&
    inner.index >= 0
    ? inner.index
    : fallbackIndex;
  const snippet = optionalString(inner.snippet);
  const source = optionalString(inner.source);
  return {
    index,
    ...(snippet ? { snippet } : {}),
    ...(source ? { source } : {}),
    title: optionalString(inner.title) ?? `Source ${index}`,
    url
  };
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

export function summarizeMessageRunArtifacts(
  run: ArtifactSummaryRun,
  answerContent?: unknown,
  memoryAction: MemoryActionFeedback | null = null,
  memorySources: readonly MemoryAnswerSource[] = [],
  memoryStatus?: MemoryRunPresentationStatus
): ThreadArtifactSummary | null {
  const artifactPayloads = run.events.map((event) => event.payload);
  const reasoningPayloads = artifactPayloads.filter(
    (payload) => artifactType(payload) === "reasoning"
  );
  const reasoningTexts = reasoningPayloads
    .map(reasoningText)
    .filter((text): text is string => Boolean(text));
  const citationPayloads = artifactPayloads.filter(
    (payload) => artifactType(payload) === "citation"
  );
  const citations = citationPayloads
    .map((payload, index) => citationFromPayload(payload, index + 1))
    .filter((citation): citation is ThreadCitation => Boolean(citation));
  const searchPayloads = artifactPayloads.filter(
    (payload) => artifactType(payload) === "search"
  );
  const sources = projectThreadSearchSources([
    ...run.searchRuns.flatMap((searchRun) =>
      sourceValuesFromSearchRun(searchRun.artifacts)
    ),
    ...searchPayloads.flatMap(sourceValuesFromSearchPayload)
  ]);
  const generatedFiles = (run.workspaceProducedAttachments ?? []).flatMap((attachment) =>
    attachment.workspaceRunOutput
      ? [{
          attachmentId: attachment.id,
          byteSize: attachment.byteSize,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          relativePath: attachment.workspaceRunOutput.relativePath
        }]
      : []
  );

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
    generatedFiles.length === 0 &&
    sources.length === 0 &&
    reasoningTexts.length === 0 &&
    knowledgeCitations.length === 0 &&
    !knowledgeState &&
    !memoryAction &&
    !memoryStatus &&
    memorySources.length === 0 &&
    workDurationMs === null
  ) {
    return null;
  }

  return {
    citations,
    ...(generatedFiles.length > 0 ? { generatedFiles } : {}),
    ...(knowledgeState ? { knowledgeState } : {}),
    knowledgeCitations,
    ...(memoryAction ? { memoryAction } : {}),
    ...(memoryStatus ? { memoryStatus } : {}),
    ...(memorySources.length > 0 ? { memorySources: [...memorySources] } : {}),
    reasoningText: reasoningTexts,
    sources,
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
    contextStats: {
      approximateActiveBranchInputTokens: await approximateActiveBranchInputTokens(
        tx,
        activeMessages
      )
    },
    usageStats: summarizeChatUsageStats({
      activeLeafMessageId: input.activeLeafMessageId,
      messages
    })
  };
}

export function createPrismaChatRepository(
  prismaClient = prisma,
  options: Readonly<{
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
      const trimmed = name.trim().slice(0, 60);
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
        const [messages, contextInputTokens] = await Promise.all([
          hydrateMessagePath(tx, chatId, pageMessages, userId),
          approximateActiveBranchInputTokens(tx, activeMessages)
        ]);
        return serializeArchivedChatDetail({
          availability: workspaceAvailability,
          chat,
          contextInputTokens,
          hasOlder: activeMessages.length > CHAT_HISTORY_PAGE_SIZE,
          lightweightMessages,
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
                messages.memoryStatusesByRun
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
      return prismaClient.$transaction(async (tx) => {
        const access = await resolveChatAccess(tx, { chatId, userId });
        if (!access) return null;
        const chat = await tx.chat.findFirst({
          select: chatSummarySelect,
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
        const [messages, contextInputTokens] = await Promise.all([
          hydrateMessagePath(tx, chatId, pageMessages, userId),
          approximateActiveBranchInputTokens(tx, activeMessages)
        ]);
        const projectDefaultAuthority = access.kind === "project"
          ? await loadProjectChatDefaultAuthority(tx, access.project.projectId)
          : undefined;
        return serializeChatDetail({
          availability: workspaceAvailability,
          chat,
          contextInputTokens,
          hasOlder: activeMessages.length > CHAT_HISTORY_PAGE_SIZE,
          lightweightMessages,
          messages,
          ...(projectDefaultAuthority ? { projectDefaultAuthority } : {}),
          workspaceSnapshot
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    },
    getChatMemoryState: async ({ chatId, userId }) => {
      const chat = await prismaClient.chat.findFirst({
        select: {
          archived: true,
          id: true,
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
                messages.memoryStatusesByRun
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
    searchChatContent: async ({ limit, query, userId }) => {
      const trimmed = query.trim();
      if (!trimmed) {
        return [];
      }

      const normalizedLimit = Number.isFinite(limit) ? Math.floor(limit) : 50;
      const boundedLimit = Math.min(Math.max(normalizedLimit, 1), 50);
      const pattern = `%${trimmed}%`;
      const rows = await prismaClient.$queryRaw<{ chatId: string; snippet: string | null }[]>`
        SELECT
          m."chatId" AS "chatId",
          MIN(substring(m."content"::text FROM 1 FOR 180)) AS "snippet"
        FROM "Message" m
        INNER JOIN "Chat" c ON c."id" = m."chatId"
        WHERE c."userId" = ${userId}
          AND c."archived" = false
          AND c."memoryMode" <> 'TEMPORARY'::"MemoryChatMode"
          AND c."permanentDeletionAt" IS NULL
          AND c."projectId" IS NULL
          AND m."content"::text ILIKE ${pattern}
        GROUP BY m."chatId", c."updatedAt"
        ORDER BY c."updatedAt" DESC
        LIMIT ${boundedLimit}
      `;

      return rows.map((row) => ({
        chatId: row.chatId,
        snippet: row.snippet
      }));
    },
    updateFolder: async ({ defaultKnowledgePlan, folderId, name, parentId, projectMemory, userId }) => {
      const trimmed = typeof name === "string" ? name.trim().slice(0, 60) : undefined;
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
        const chat = chats[0];
        if (!chat) return { kind: "not_found" as const };
        if (chat.memoryMode === "TEMPORARY") return { kind: "temporary" as const };
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
      chatId,
      defaultKnowledgePlan,
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
      if (access.kind === "project") {
        return prismaClient.$transaction(async (tx) => {
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
          if (activeLeafMessageId !== undefined || workspaceEnabled !== undefined) {
            const activeRun = await tx.modelRun.findFirst({
              select: { id: true },
              where: {
                chatId,
                status: { in: ["preparing", "streaming", "queued", "in_progress"] }
              }
            });
            if (activeRun) throw new ActiveRunConflictError();
          }
          const updated = await tx.chat.update({
            data: {
              ...(activeLeafMessageId !== undefined ? { activeLeafMessageId } : {}),
              ...(defaultKnowledgePlan !== undefined
                ? { defaultKnowledgePlan: knowledgeDefaultJson(defaultKnowledgePlan) }
                : {}),
              ...(folderId !== undefined ? { projectFolderId: folderId } : {}),
              ...(pinned !== undefined ? { pinned } : {}),
              ...(title ? { title: title.trim().slice(0, 80) } : {}),
              ...(workspaceEnabled === undefined ? {} : { workspaceEnabled })
            },
            select: chatSummarySelect,
            where: { id: chatId }
          });
          return serializeChatSummary(updated, workspaceAvailability, workspaceSnapshot);
        });
      }
      return prismaClient.$transaction(async (tx) => {
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

        if (activeLeafMessageId !== undefined || workspaceEnabled !== undefined) {
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

        const hasMetadataUpdate = defaultKnowledgePlan !== undefined ||
          pinned !== undefined || Boolean(title) || workspaceEnabled !== undefined;
        const updated = hasMetadataUpdate
          ? await tx.chat.update({
              data: {
                ...(defaultKnowledgePlan !== undefined
                  ? { defaultKnowledgePlan: knowledgeDefaultJson(defaultKnowledgePlan) }
                  : {}),
                ...(pinned !== undefined ? { pinned } : {}),
                ...(title ? { title: title.trim().slice(0, 80) } : {}),
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
