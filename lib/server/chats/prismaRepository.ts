import { Prisma } from "@prisma/client";
import type { ContextTruncationSummary } from "../../domain/contextBudget";
import { safeExternalHref } from "../../domain/links";
import { normalizeTokenUsage } from "../../domain/usage";
import {
  mergeThreadToolActivity,
  projectThreadToolActivity
} from "../../domain/toolActivity";
import {
  projectClientSearchActivity,
  projectHostedSearchActivity
} from "../../domain/searchDisclosure";
import { decodeAssistantAvatarRecipe } from "../../contracts/assistants";
import { prisma } from "../prisma";
import { ActiveRunConflictError } from "../runs/runRepositoryContract";
import { persistedToolCallActivity } from "../runs/toolInspection";
import type {
  ChatDetailRecord,
  ChatRepository,
  ChatSummaryRecord,
  ChatUsageStats,
  ThreadArtifactSummary,
  ThreadCitation
} from "./handlers";
import { loadChatCreationDefaults } from "./chatCreationDefaults";
import { defaultChatTitle } from "./titlePolicy";

const chatDetailInclude = {
  defaultProviderModel: {
    select: {
      connectionId: true,
      id: true
    }
  },
  messages: {
    include: {
      assistantModelRuns: {
        orderBy: {
          createdAt: "desc"
        },
        select: {
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
        },
        take: 1
      }
    },
    orderBy: {
      createdAt: "asc"
    }
  }
} satisfies Prisma.ChatInclude;

const chatSummarySelect = {
  _count: {
    select: {
      messages: true
    }
  },
  activeLeafMessageId: true,
  createdAt: true,
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

type ChatDetailRow = Prisma.ChatGetPayload<{ include: typeof chatDetailInclude }>;
type ChatSummaryRow = Prisma.ChatGetPayload<{ select: typeof chatSummarySelect }>;
type ArtifactSummaryRun = {
  events: { payload: unknown }[];
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

function serializeChatDetail(chat: ChatDetailRow): ChatDetailRecord {
  return {
    activeLeafMessageId: chat.activeLeafMessageId,
    createdAt: chat.createdAt,
    defaultModelId: chat.defaultProviderModel?.id ?? null,
    defaultProvider: chat.defaultProviderModel?.connectionId ?? null,
    folderId: chat.folderId,
    id: chat.id,
    messageCount: chat.messages.length,
    messages: chat.messages.map((message) => {
      const modelRun = message.assistantModelRuns[0];

      return {
        artifactSummary: modelRun ? summarizeMessageRunArtifacts(modelRun) : null,
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
    }),
    pinned: chat.pinned,
    title: chat.title,
    updatedAt: chat.updatedAt,
    usageStats: summarizeChatUsageStats(chat)
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

export function summarizeMessageRunArtifacts(run: ArtifactSummaryRun): ThreadArtifactSummary | null {
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

  if (searchCount === 0 && reasoningPayloads.length === 0 && citationCount === 0 && !contextTruncation && toolCalls.length === 0) {
    return null;
  }

  return {
    citationCount,
    citations,
    contextTruncation,
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

export function createPrismaChatRepository(prismaClient = prisma): ChatRepository {
  return {
    archiveChat: async ({ chatId, userId }) => {
      return prismaClient.$transaction(async (tx) => {
        const chats = await tx.$queryRaw<Array<{ archived: boolean; id: string }>>`
          SELECT "id", "archived"
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
              in: ["streaming", "queued", "in_progress"]
            }
          }
        });
        if (activeRun) {
          throw new ActiveRunConflictError();
        }

        await tx.chat.update({
          data: {
            archived: true
          },
          where: {
            id: chatId
          }
        });
        return true;
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
        return await prismaClient.folder.create({
          data: {
            name: trimmed,
            parentId: parentId ?? null,
            sortOrder: (aggregate._max.sortOrder ?? 0) + 10,
            userId
          },
          select: {
            id: true,
            name: true,
            parentId: true,
            projectMemory: true,
            sortOrder: true
          }
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return null;
        }

        throw error;
      }
    },
    deleteFolder: async ({ folderId, userId }) => {
      const result = await prismaClient.folder.deleteMany({
        where: {
          id: folderId,
          userId
        }
      });

      return result.count > 0;
    },
    getChat: async ({ chatId, userId }) => {
      const chat = await prismaClient.chat.findFirst({
        include: chatDetailInclude,
        where: {
          archived: false,
          id: chatId,
          userId
        }
      });

      return chat ? serializeChatDetail(chat) : null;
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
    updateFolder: async ({ folderId, name, parentId, projectMemory, userId }) => {
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

            return tx.folder.findFirst({
              select: {
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
        folders
      };
    },
    updateChat: async ({ activeLeafMessageId, chatId, folderId, pinned, title, userId }) =>
      prismaClient.$transaction(async (tx) => {
        const chats = await tx.$queryRaw<Array<{ archived: boolean; id: string }>>`
          SELECT "id", "archived"
          FROM "Chat"
          WHERE "id" = ${chatId}
            AND "userId" = ${userId}
          FOR UPDATE
        `;
        if (!chats[0] || chats[0].archived) {
          return null;
        }

        if (folderId) {
          const folder = await findOwnedFolder(tx, folderId, userId);
          if (!folder) {
            return null;
          }
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
                in: ["streaming", "queued", "in_progress"]
              }
            }
          });
          if (activeRun) {
            throw new ActiveRunConflictError();
          }
        }

        const updated = await tx.chat.update({
          data: {
            ...(activeLeafMessageId !== undefined ? { activeLeafMessageId } : {}),
            ...(folderId !== undefined ? { folderId } : {}),
            ...(pinned !== undefined ? { pinned } : {}),
            ...(title ? { title: title.trim().slice(0, 80) } : {})
          },
          select: chatSummarySelect,
          where: {
            id: chatId
          }
        });

        return serializeChatSummary(updated);
      })
  };
}
