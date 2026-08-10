import { Prisma } from "@prisma/client";
import {
  estimateApproxTokensFromProjectedParts,
  type ApproxTokenProjectedPart,
  type ContextTruncationSummary
} from "../../domain/contextBudget";
import { safeExternalHref } from "../../domain/links";
import { normalizeTokenUsage } from "../../domain/usage";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import {
  mergeThreadToolActivity,
  projectThreadToolActivity
} from "../../domain/toolActivity";
import {
  projectClientSearchActivity,
  projectHostedSearchActivity
} from "../../domain/searchDisclosure";
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
import { decodeKnowledgePlan, type KnowledgePlan } from "../../contracts/knowledge";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../contracts/memory";
import { prisma } from "../prisma";
import { ActiveRunConflictError } from "../runs/runRepositoryContract";
import { persistedToolCallActivity } from "../runs/toolInspection";
import type {
  ChatBranchGraphRecord,
  ChatDetailRecord,
  ChatRepository,
  ChatSummaryRecord,
  ChatUsageStats,
  ThreadArtifactSummary,
  ThreadCitation
} from "./handlers";
import type {
  ArchivedChatDetailRecord,
  ArchivedChatSummaryRecord,
  ChatLifecycleMutationResult,
  ChatLifecycleRepository
} from "./lifecycleHandlers";
import { loadChatCreationDefaults } from "./chatCreationDefaults";
import { defaultChatTitle } from "./titlePolicy";
import {
  loadMemoryRunEvidence,
  type MemoryRunEvidenceProjection
} from "../memory/receipts/projection";
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
  assistantId: true,
  assistantRevision: {
    select: {
      avatar: true,
      name: true,
      revisionNumber: true
    }
  },
  cachedInputTokens: true,
  cacheWriteInputTokens: true,
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
  id: true,
  inputTokens: true,
  knowledgeRuns: {
    orderBy: { invocationOrdinal: "asc" },
    select: {
      invocationOrdinal: true,
      outcome: true,
      results: true
    }
  },
  normalizedRequest: true,
  outputTokens: true,
  searchRuns: {
    orderBy: {
      createdAt: "asc"
    },
    select: {
      artifacts: true,
      query: true,
      status: true,
      strategyId: true
    }
  },
  status: true,
  toolCalls: {
    orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }],
    select: {
      arguments: true,
      completedAt: true,
      mcpRunBindingId: true,
      ordinal: true,
      providerCallId: true,
      result: true,
      roundIndex: true,
      startedAt: true,
      state: true,
      toolName: true
    }
  },
  totalTokens: true
} satisfies Prisma.ModelRunSelect;

const hydratedMessageSelect = {
  assistantModelRuns: {
    orderBy: {
      createdAt: "desc"
    },
    select: assistantRunDetailSelect,
    take: 1
  },
  content: true,
  createdAt: true,
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
      connectionId: true,
      id: true
    }
  },
  folderId: true,
  id: true,
  pinned: true,
  title: true,
  updatedAt: true
} satisfies Prisma.ChatSelect;

const archivedChatSummarySelect = {
  ...chatSummarySelect,
  archived: true,
  memoryMode: true,
  memorySourceRevision: true
} satisfies Prisma.ChatSelect;

type ChatSummaryRow = Prisma.ChatGetPayload<{ select: typeof chatSummarySelect }>;
type ArchivedChatSummaryRow = Prisma.ChatGetPayload<{
  select: typeof archivedChatSummarySelect;
}>;
type HydratedMessageRow = Prisma.MessageGetPayload<{ select: typeof hydratedMessageSelect }>;
type HydratedMessagePath = Readonly<{
  memoryEvidenceByRun: ReadonlyMap<string, MemoryRunEvidenceProjection>;
  messages: HydratedMessageRow[];
}>;
type LightweightMessageRow = Prisma.MessageGetPayload<{ select: typeof lightweightMessageSelect }>;
type ArtifactSummaryRun = {
  events: { payload: unknown }[];
  knowledgeRuns?: {
    invocationOrdinal: number;
    outcome: string;
    results: unknown;
  }[];
  normalizedRequest?: unknown;
  searchRuns: {
    artifacts?: unknown;
    modelId?: string | null;
    provider?: string;
    query?: string | null;
    requestPreview?: unknown;
    status: string;
    strategyId: string;
  }[];
  status?: string;
  toolCalls?: {
    arguments: unknown;
    completedAt: Date | string | null;
    mcpRunBindingId?: string | null;
    ordinal: number;
    providerCallId: string;
    result: unknown;
    roundIndex: number;
    startedAt: Date | string | null;
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
  return value === null ? Prisma.DbNull : { baseIds: [...value.baseIds] };
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
    return { memoryEvidenceByRun: new Map(), messages: [] };
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
    message.assistantModelRuns[0]?.id ? [message.assistantModelRuns[0].id] : []);
  return {
    memoryEvidenceByRun: await loadMemoryRunEvidence(tx, { runIds, userId }),
    messages: ordered
  };
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
  memoryEvidenceByRun: ReadonlyMap<string, MemoryRunEvidenceProjection>
): ChatDetailRecord["messages"][number] {
  const modelRun = message.assistantModelRuns[0];
  return {
    artifactSummary: modelRun
      ? summarizeMessageRunArtifacts(
          modelRun,
          message.content,
          memoryEvidenceByRun.get(modelRun.id) ?? null
        )
      : null,
    assistantIdentity: serializeAssistantIdentity(modelRun),
    content: message.content,
    createdAt: message.createdAt,
    errorMessage: message.errorMessage,
    id: message.id,
    modelId: message.modelId,
    modelRunId: modelRun?.id ?? null,
    parentMessageId: message.parentMessageId,
    provider: message.provider,
    role: message.role,
    runUsage: modelRun
      ? {
          totalTokens: normalizeTokenUsage({
            inputTokens: modelRun.inputTokens,
            outputTokens: modelRun.outputTokens,
            reasoningTokens: 0,
            totalTokens: modelRun.totalTokens
          }).totalTokens
        }
      : null,
    status: message.status
  };
}

function serializeChatDetail(input: {
  chat: ChatSummaryRow;
  contextInputTokens: number;
  hasOlder: boolean;
  lightweightMessages: LightweightMessageRow[];
  messages: HydratedMessagePath;
}): ChatDetailRecord {
  const chat = input.chat;
  return {
    activeLeafMessageId: chat.activeLeafMessageId,
    createdAt: chat.createdAt,
    defaultKnowledgePlan: storedKnowledgeDefault(chat.defaultKnowledgePlan),
    defaultModelId: chat.defaultProviderModel?.id ?? null,
    defaultProvider: chat.defaultProviderModel?.connectionId ?? null,
    folderId: chat.folderId,
    id: chat.id,
    contextStats: {
      approximateActiveBranchInputTokens: input.contextInputTokens
    },
    messageCount: chat._count.messages,
    messages: input.messages.messages.map((message) =>
      serializeHydratedMessage(message, input.messages.memoryEvidenceByRun)),
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
    title: chat.title,
    updatedAt: chat.updatedAt,
    usageStats: summarizeChatUsageStats({
      activeLeafMessageId: chat.activeLeafMessageId,
      messages: input.lightweightMessages
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

function serializeChatSummary(chat: ChatSummaryRow): ChatSummaryRecord {
  return {
    activeLeafMessageId: chat.activeLeafMessageId,
    createdAt: chat.createdAt,
    defaultKnowledgePlan: storedKnowledgeDefault(chat.defaultKnowledgePlan),
    defaultModelId: chat.defaultProviderModel?.id ?? null,
    defaultProvider: chat.defaultProviderModel?.connectionId ?? null,
    folderId: chat.folderId,
    id: chat.id,
    messageCount: chat._count.messages,
    pinned: chat.pinned,
    title: chat.title,
    updatedAt: chat.updatedAt
  };
}

function serializeArchivedChatSummary(
  chat: ArchivedChatSummaryRow
): ArchivedChatSummaryRecord {
  if (chat.memoryMode === "TEMPORARY" || !chat.archived) {
    throw new Error("archived_chat_lifecycle_integrity_invalid");
  }
  return {
    ...serializeChatSummary(chat),
    archived: true,
    memoryMode: chat.memoryMode,
    sourceRevision: chat.memorySourceRevision
  };
}

function serializeArchivedChatDetail(input: {
  chat: ArchivedChatSummaryRow;
  contextInputTokens: number;
  hasOlder: boolean;
  lightweightMessages: LightweightMessageRow[];
  messages: HydratedMessagePath;
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

function searchStrategyFromPayload(payload: unknown): string | null {
  const inner = artifactInnerPayload(payload);
  if (!isRecord(inner)) {
    return null;
  }

  if (typeof inner.strategyId === "string") {
    return inner.strategyId;
  }

  return inner.type === "web_search_call" ? "openai-native-web-search" : null;
}

type NormalizedSearchIdentity = Readonly<{
  adapterKind: string | null;
  displayName: string | null;
  optionId: string;
}>;

function searchIdentitiesFromNormalizedRequest(value: unknown): NormalizedSearchIdentity[] {
  if (!isRecord(value) || !isRecord(value.searchPlan) || !Array.isArray(value.searchPlan.options)) {
    return [];
  }

  return value.searchPlan.options.flatMap((option) => {
    if (!isRecord(option)) return [];
    const optionId = optionalString(option.optionId);
    if (!optionId) return [];
    return [{
      adapterKind: optionalString(option.adapterKind) ?? null,
      displayName: optionalString(option.displayName) ?? null,
      optionId
    }];
  });
}

function citationFromPayload(payload: unknown, fallbackIndex: number): ThreadCitation | null {
  const inner = artifactInnerPayload(payload);
  if (typeof inner === "string" && inner.trim()) {
    const url = safeExternalHref(inner);
    if (!url) {
      return null;
    }

    return {
      index: fallbackIndex,
      title: `Source ${fallbackIndex}`,
      url
    };
  }

  if (!isRecord(inner)) {
    return null;
  }

  const url = safeExternalHref(optionalString(inner.url) ?? optionalString(inner.href));
  if (!url) {
    return null;
  }

  const index = typeof inner.index === "number" && Number.isFinite(inner.index) ? inner.index : fallbackIndex;

  return {
    index,
    snippet: optionalString(inner.snippet),
    source: optionalString(inner.source),
    title: optionalString(inner.title) ?? `Source ${index}`,
    url
  };
}

function contextTruncationFromPayload(payload: unknown): ContextTruncationSummary | null {
  const inner = artifactInnerPayload(payload);

  if (!isRecord(inner) || typeof inner.droppedMessages !== "number" || inner.droppedMessages <= 0) {
    return null;
  }

  return inner as ContextTruncationSummary;
}

function knowledgeOutcome(value: string): NonNullable<ThreadArtifactSummary["knowledgeOutcomes"]>[number]["outcome"] | null {
  return value === "base_empty" || value === "base_indexing" || value === "complete" ||
    value === "embedding_model_unavailable" || value === "zero_above_threshold"
    ? value
    : null;
}

function knowledgeCitation(value: unknown): NonNullable<ThreadArtifactSummary["knowledgeCitations"]>[number] | null {
  if (!isRecord(value)) return null;
  const baseName = optionalString(value.baseName);
  const fileName = optionalString(value.fileName);
  const handle = optionalString(value.handle);
  const knowledgeBaseId = optionalString(value.knowledgeBaseId);
  const page = typeof value.page === "number" && Number.isSafeInteger(value.page) && value.page >= 1
    ? value.page
    : null;
  const documentVersionNumber = value.documentVersionNumber === undefined
    ? null
    : typeof value.documentVersionNumber === "number" &&
        Number.isSafeInteger(value.documentVersionNumber) && value.documentVersionNumber >= 1
      ? value.documentVersionNumber
      : undefined;
  if (
    !baseName || !fileName || !handle || !/^K[1-3]\.[1-8]$/u.test(handle) ||
    !knowledgeBaseId || page === null || documentVersionNumber === undefined
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

export function summarizeMessageRunArtifacts(
  run: ArtifactSummaryRun,
  answerContent?: unknown,
  memoryEvidence: MemoryRunEvidenceProjection | null = null
): ThreadArtifactSummary | null {
  const artifactPayloads = run.events.map((event) => event.payload);
  const searchPayloads = artifactPayloads.filter((payload) => artifactType(payload) === "search");
  const searchArtifactCount = searchPayloads.length;
  const normalizedSearchIdentities = searchIdentitiesFromNormalizedRequest(run.normalizedRequest);
  const hostedSearchIdentities = normalizedSearchIdentities.filter(
    (identity) => identity.adapterKind === "answer_provider_hosted"
  );
  const hostedSearchIdentity = searchArtifactCount > 0
    ? hostedSearchIdentities.length === 1
      ? hostedSearchIdentities[0]
      : normalizedSearchIdentities.length === 1
        ? normalizedSearchIdentities[0]
        : null
    : null;
  const executedOptionIds = new Set([
    ...run.searchRuns.map((searchRun) => searchRun.strategyId),
    ...(hostedSearchIdentity ? [hostedSearchIdentity.optionId] : [])
  ]);
  const searchDisplayNames = normalizedSearchIdentities
    .filter((identity) => executedOptionIds.has(identity.optionId) && identity.displayName)
    .map((identity) => identity.displayName as string);
  const searchDisplayName = [...new Set(searchDisplayNames)].join(" + ") || null;
  const reasoningPayloads = artifactPayloads.filter((payload) => artifactType(payload) === "reasoning");
  const reasoningSnippets = reasoningPayloads
    .map(reasoningText)
    .filter((text): text is string => Boolean(text));
  const reasoningCount = reasoningSnippets.length > 0 ? reasoningSnippets.length : reasoningPayloads.length;
  const citationPayloads = artifactPayloads.filter((payload) => artifactType(payload) === "citation");
  const citations = citationPayloads
    .map((payload, index) => citationFromPayload(payload, index + 1))
    .filter((citation): citation is ThreadCitation => Boolean(citation));
  const citationCount = Math.max(citationPayloads.length, citations.length);
  const contextTruncation =
    artifactPayloads
      .filter((payload) => artifactType(payload) === "context_truncated")
      .map(contextTruncationFromPayload)
      .filter((summary): summary is ContextTruncationSummary => Boolean(summary))
      .at(-1) ?? null;
  const eventToolCalls = projectThreadToolActivity(artifactPayloads, run.status);
  const durableToolCalls = (run.toolCalls ?? []).flatMap((call) => {
    const activity = persistedToolCallActivity({
      call,
      normalizedRequest: run.normalizedRequest,
      runStatus: run.status ?? "in_progress"
    });
    return activity ? [activity] : [];
  });
  const toolCallsById = new Map(eventToolCalls.map((call) => [call.callId, call]));
  for (const call of durableToolCalls) {
    const eventCall = toolCallsById.get(call.callId);
    toolCallsById.set(
      call.callId,
      eventCall ? mergeThreadToolActivity(eventCall, call) : call
    );
  }
  const observedToolCalls = [...toolCallsById.values()].sort(
    (left, right) => left.round - right.round || left.ordinal - right.ordinal
  );
  const hostedSearchActivity = projectHostedSearchActivity({
    displayName: hostedSearchIdentity?.displayName ?? searchDisplayName,
    payloads: searchPayloads.map(artifactInnerPayload),
    runStatus: run.status
  });
  const clientSearchActivity = projectClientSearchActivity({
    fallbackDisplayName: searchDisplayName ?? "Search source",
    searchRuns: run.searchRuns.map((searchRun) => {
      const identity = normalizedSearchIdentities.find(
        (candidate) => candidate.optionId === searchRun.strategyId
      );
      return identity?.displayName
        ? {
            ...searchRun,
            artifacts: {
              ...(typeof searchRun.artifacts === "object" && searchRun.artifacts !== null &&
                !Array.isArray(searchRun.artifacts)
                ? searchRun.artifacts
                : {}),
              displayName: identity.displayName
            }
          }
        : searchRun;
    }),
    toolCalls: observedToolCalls
  });
  const searchActivity = [
    ...(hostedSearchActivity ? [hostedSearchActivity] : []),
    ...clientSearchActivity
  ].slice(0, 12);
  const toolCalls = observedToolCalls.filter((call) => call.capability === "mcp");
  const searchCount = Math.max(searchArtifactCount, run.searchRuns.length, searchActivity.length);
  const knowledgeRuns = (run.knowledgeRuns ?? [])
    .map((receipt) => ({
      invocationOrdinal: receipt.invocationOrdinal,
      outcome: knowledgeOutcome(receipt.outcome),
      results: Array.isArray(receipt.results) ? receipt.results : []
    }))
    .filter((receipt) =>
      Number.isSafeInteger(receipt.invocationOrdinal) && receipt.invocationOrdinal >= 1 &&
      receipt.invocationOrdinal <= 3 && receipt.outcome !== null)
    .sort((left, right) => left.invocationOrdinal - right.invocationOrdinal)
    .slice(0, 3);
  const answerText = isRecord(answerContent)
    ? textFromContentBlocks(answerContent as { blocks?: unknown[] })
    : "";
  const citedHandles = new Set(
    [...answerText.matchAll(/\[(K[1-3]\.[1-8])\]/gu)].map((match) => match[1]!)
  );
  const knowledgeCitations = knowledgeRuns.flatMap((receipt) =>
    receipt.results
      .map(knowledgeCitation)
      .filter((citation): citation is NonNullable<typeof citation> =>
        citation !== null && citedHandles.has(citation.handle)))
    .filter((citation, index, citations) =>
      citations.findIndex((candidate) => candidate.handle === citation.handle) === index)
    .slice(0, 24);

  if (searchCount === 0 && reasoningPayloads.length === 0 && citationCount === 0 &&
    !contextTruncation && toolCalls.length === 0 && knowledgeRuns.length === 0 &&
    !memoryEvidence?.action && !memoryEvidence?.receipt) {
    return null;
  }

  return {
    citationCount,
    citations,
    contextTruncation,
    knowledgeCitations,
    knowledgeInvocationCount: knowledgeRuns.length,
    knowledgeOutcomes: knowledgeRuns.map((receipt) => ({
      invocationOrdinal: receipt.invocationOrdinal,
      outcome: receipt.outcome!
    })),
    ...(memoryEvidence?.action ? { memoryAction: memoryEvidence.action } : {}),
    ...(memoryEvidence?.receipt ? { memoryReceipt: memoryEvidence.receipt } : {}),
    reasoningCount,
    reasoningText: reasoningSnippets,
    searchActivity,
    searchCount,
    ...(searchDisplayName ? { searchDisplayName } : {}),
    searchStrategy:
      run.searchRuns[0]?.strategyId ??
      hostedSearchIdentity?.optionId ??
      artifactPayloads.map(searchStrategyFromPayload).find((strategy): strategy is string => Boolean(strategy)) ??
      null,
    toolCallCount: toolCalls.length,
    toolCalls
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

export async function loadChatUsageStats(
  prismaClient: typeof prisma,
  input: { chatId: string; userId: string }
): Promise<ChatUsageStats | null> {
  const chat = await prismaClient.chat.findFirst({
    select: {
      activeLeafMessageId: true,
      messages: {
        select: {
          assistantModelRuns: {
            orderBy: {
              createdAt: "desc"
            },
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
        }
      }
    },
    where: {
      archived: false,
      id: input.chatId,
      userId: input.userId
    }
  });

  return chat ? summarizeChatUsageStats(chat) : null;
}

export async function loadChatContextStats(
  prismaClient: typeof prisma,
  input: { chatId: string; userId: string }
): Promise<ChatContextStats | null> {
  return prismaClient.$transaction(async (tx) => {
    const chat = await tx.chat.findFirst({
      select: { activeLeafMessageId: true },
      where: {
        archived: false,
        id: input.chatId,
        userId: input.userId
      }
    });
    if (!chat) return null;
    const messages = await tx.message.findMany({
      select: { id: true, parentMessageId: true },
      where: { chatId: input.chatId }
    });
    const activeMessages = activeBranchPath(messages, chat.activeLeafMessageId);
    return {
      approximateActiveBranchInputTokens: await approximateActiveBranchInputTokens(
        tx,
        activeMessages
      )
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export function createPrismaChatRepository(
  prismaClient = prisma,
  options: Readonly<{
    memorySourceHooks?: MemorySourceMutationHooks;
    resumeSuppressionPreflight?: (
      tx: Prisma.TransactionClient,
      userId: string
    ) => Promise<boolean>;
  }> = {}
): ChatRepository & ChatLifecycleRepository {
  const memorySourceHooks = options.memorySourceHooks ?? defaultMemorySourceMutationHooks;
  const resumeSuppressionPreflight = options.resumeSuppressionPreflight ??
    defaultResumeSuppressionPreflight;
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
          FOR UPDATE
        `;
        if (!chats[0] || chats[0].archived) {
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
    createChat: async ({ folderId, title, userId }) => {
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
            title: title?.trim() || defaultChatTitle,
            userId
          },
          select: chatSummarySelect
        });

        return serializeChatSummary(chat);
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
          WHERE "userId" = ${userId} AND "folderId" = ${folderId}
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
      return prismaClient.$transaction(async (tx) => {
        const chat = await tx.chat.findFirst({
          select: archivedChatSummarySelect,
          where: {
            archived: true,
            id: chatId,
            memoryMode: { not: "TEMPORARY" },
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
          chat,
          contextInputTokens,
          hasOlder: activeMessages.length > CHAT_HISTORY_PAGE_SIZE,
          lightweightMessages,
          messages
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
              serializeHydratedMessage(message, messages.memoryEvidenceByRun)),
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
      return prismaClient.$transaction(async (tx) => {
        const chat = await tx.chat.findFirst({
          select: chatSummarySelect,
          where: {
            archived: false,
            id: chatId,
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
        return serializeChatDetail({
          chat,
          contextInputTokens,
          hasOlder: activeMessages.length > CHAT_HISTORY_PAGE_SIZE,
          lightweightMessages,
          messages
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    },
    getMessagesPage: async ({ before, chatId, userId }) => {
      return prismaClient.$transaction(async (tx) => {
        const chat = await tx.chat.findFirst({
          select: {
            activeLeafMessageId: true,
            id: true,
            updatedAt: true
          },
          where: { archived: false, id: chatId, userId }
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
              serializeHydratedMessage(message, messages.memoryEvidenceByRun)),
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
        const chat = await tx.chat.findFirst({
          select: { activeLeafMessageId: true, updatedAt: true },
          where: { archived: false, id: chatId, userId }
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
      const cursor = cursorValue ? decodeArchivedChatCursor(cursorValue) : null;
      if (cursorValue && !cursor) return { kind: "cursor_invalid" as const };
      const rows = await prismaClient.chat.findMany({
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        select: archivedChatSummarySelect,
        take: ARCHIVED_CHAT_PAGE_SIZE + 1,
        where: {
          archived: true,
          memoryMode: { not: "TEMPORARY" },
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
        chats: page.map(serializeArchivedChatSummary),
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
            userId
          }
        })
      ]);

      return {
        chats: chats.map(serializeChatSummary),
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
      if (
        !Number.isSafeInteger(expectedChatRevision) || expectedChatRevision < 0 ||
        !Number.isSafeInteger(expectedMemoryRevision) || expectedMemoryRevision < 0 ||
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
          FOR UPDATE
        `;
        const chat = chats[0];
        if (!chat) return { kind: "not_found" as const };
        if (chat.memoryMode === "TEMPORARY") return { kind: "temporary" as const };
        if (
          chat.memorySourceRevision !== expectedChatRevision ||
          chat.memoryMode === mode
        ) return { kind: "source_stale" as const };

        const settings = await lockMemorySettings(tx, userId, false);
        if (settings.memoryRevision !== expectedMemoryRevision) {
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
      userId
    }) =>
      prismaClient.$transaction(async (tx) => {
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

        if (activeLeafMessageId !== undefined) {
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
          pinned !== undefined || Boolean(title);
        const updated = hasMetadataUpdate
          ? await tx.chat.update({
              data: {
                ...(defaultKnowledgePlan !== undefined
                  ? { defaultKnowledgePlan: knowledgeDefaultJson(defaultKnowledgePlan) }
                  : {}),
                ...(pinned !== undefined ? { pinned } : {}),
                ...(title ? { title: title.trim().slice(0, 80) } : {})
              },
              select: chatSummarySelect,
              where: { id: chatId }
            })
          : await tx.chat.findUniqueOrThrow({
              select: chatSummarySelect,
              where: { id: chatId }
            });

        return serializeChatSummary(updated);
      })
  };
}
