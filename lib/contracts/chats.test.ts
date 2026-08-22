import { describe, expect, it } from "vitest";
import {
  CHAT_BRANCH_PREVIEW_MAX_LENGTH,
  CHAT_HISTORY_PAGE_SIZE,
  boundedChatBranchPreview,
  decodeArchivedChatDetailResponse,
  decodeArchivedChatsResponse,
  decodeChatBranchesResponse,
  decodeChatDetailResponse,
  decodeChatLifecycleRequest,
  decodeChatLifecycleResponse,
  decodeChatMemoryStateResponse,
  decodeChatNavigationPage,
  decodeChatMessagesPageResponse,
  decodeChatSourceResolutionResponse,
  decodeChatSummaryResponse,
  decodeChatUpdateData,
  decodeWorkspaceChatsResponse
} from "./chats";

const summary = {
  activeLeafMessageId: "message-1",
  createdAt: "2026-07-14T08:00:00.000Z",
  defaultKnowledgePlan: null,
  defaultModelId: "gpt-5.5",
  defaultProvider: "openai",
  folderId: null,
  id: "chat-1",
  messageCount: 1,
  pinned: false,
  projectId: null,
  title: "Exact boundary",
  updatedAt: "2026-07-14T08:01:00.000Z"
};

const nullDefaultSummary = {
  ...summary,
  defaultModelId: null,
  defaultProvider: null,
  id: "chat-without-default",
  title: "Choose a model when ready"
};

const message = {
  artifactSummary: null,
  citationMessageId: null,
  content: { blocks: [{ text: "Answer", type: "text" }] },
  createdAt: "2026-07-14T08:00:30.000Z",
  errorMessage: null,
  id: "message-1",
  modelId: "gpt-5.5",
  modelRunId: "run-1",
  parentMessageId: null,
  provider: "openai",
  role: "assistant",
  status: "complete"
};

const usageStats = {
  activeBranchMessageCount: 1,
  cachedInputTokens: 2,
  cacheWriteInputTokens: 3,
  totalTokens: 10
};

const contextStats = { approximateActiveBranchInputTokens: 7 };
const pageInfo = {
  activeLeafMessageId: summary.activeLeafMessageId,
  beforeCursor: null,
  hasOlder: false,
  snapshotUpdatedAt: summary.updatedAt
};

function detailChat(overrides: Record<string, unknown> = {}) {
  return { ...summary, contextStats, pageInfo, ...overrides };
}

describe("chat wire contracts", () => {
  it("decodes the exact content-free navigation page", () => {
    const page = {
      chats: [{
        activeRun: true,
        folderId: "folder-1",
        id: "chat-1",
        title: "Quarterly review",
        updatedAt: "2026-08-13T00:00:00.000Z"
      }],
      folders: [{ id: "folder-1", name: "Work", parentId: null }],
      nextCursor: "opaque_cursor"
    };

    expect(decodeChatNavigationPage(page)).toEqual(page);
    expect(decodeChatNavigationPage({
      ...page,
      chats: [{ ...page.chats[0], messageCount: 10 }]
    })).toBeNull();
    expect(decodeChatNavigationPage({ ...page, nextCursor: "bad!" })).toBeNull();
    expect(decodeChatNavigationPage({
      ...page,
      chats: [...page.chats, page.chats[0]]
    })).toBeNull();
  });

  it("decodes workspace summaries without allowing additive thread fields into the result", () => {
    const workspace = decodeWorkspaceChatsResponse({
      chats: [{ ...summary, messages: [message], usageStats }],
      contentMatches: [{ chatId: summary.id, snippet: null }],
      folders: []
    });
    const mutation = decodeChatSummaryResponse({
      chat: { ...summary, messages: [message], usageStats }
    });

    expect(workspace).toEqual({
      chats: [summary],
      contentMatches: [{ chatId: summary.id, snippet: null }],
      folders: []
    });
    expect(mutation).toEqual(summary);
    expect(mutation).not.toHaveProperty("messages");
    expect(mutation).not.toHaveProperty("usageStats");
  });

  it("keeps a paired absent chat default readable across every chat response", () => {
    expect(
      decodeWorkspaceChatsResponse({
        chats: [summary, nullDefaultSummary],
        contentMatches: [],
        folders: []
      })
    ).toEqual({
      chats: [summary, nullDefaultSummary],
      contentMatches: [],
      folders: []
    });
    expect(decodeChatSummaryResponse({ chat: nullDefaultSummary })).toEqual(
      nullDefaultSummary
    );
    expect(
      decodeChatDetailResponse({
        chat: detailChat({ ...nullDefaultSummary, messages: [message], usageStats: null })
      })
    ).toEqual(detailChat({ ...nullDefaultSummary, messages: [message], usageStats: null }));
    expect(
      decodeChatUpdateData({
        chat: { ...nullDefaultSummary, contextStats, usageStats: null },
        messages: [message]
      })
    ).toEqual({
      chat: { ...nullDefaultSummary, contextStats, usageStats: null },
      messages: [message]
    });
  });

  it("rejects incomplete or empty chat defaults", () => {
    for (const [defaultModelId, defaultProvider] of [
      ["", ""],
      [null, "openai"],
      ["gpt-5.5", null],
      ["", "openai"],
      ["gpt-5.5", ""],
      ["", null],
      [null, ""]
    ]) {
      expect(
        decodeChatSummaryResponse({
          chat: { ...summary, defaultModelId, defaultProvider }
        })
      ).toBeNull();
    }
  });

  it("decodes bounded chat/folder Knowledge defaults and rejects malformed persisted plans", () => {
    const knowledgePlan = { baseIds: ["base-a", "base-b"] };
    const canonicalKnowledgePlan = {
      baseIds: ["base-a", "base-b"], mode: "explicit", sourceIds: [], version: 1
    };
    const folder = {
      defaultKnowledgePlan: knowledgePlan,
      id: "folder-1",
      name: "Research",
      parentId: null,
      projectMemory: "",
      sortOrder: 0
    };
    expect(decodeWorkspaceChatsResponse({
      chats: [{ ...summary, defaultKnowledgePlan: knowledgePlan }],
      contentMatches: [],
      folders: [folder]
    })).toEqual({
      chats: [{ ...summary, defaultKnowledgePlan: canonicalKnowledgePlan }],
      contentMatches: [],
      folders: [{ ...folder, defaultKnowledgePlan: canonicalKnowledgePlan }]
    });
    expect(decodeWorkspaceChatsResponse({
      chats: [{ ...summary, defaultKnowledgePlan: { baseIds: ["same", "same"] } }],
      contentMatches: [],
      folders: []
    })).toBeNull();
    expect(decodeWorkspaceChatsResponse({
      chats: [summary],
      contentMatches: [],
      folders: [{
        ...folder,
        defaultKnowledgePlan: {
          baseIds: Array.from({ length: 129 }, (_, index) => `base-${index}`)
        }
      }]
    })).toBeNull();
  });

  it("rejects missing or malformed required summary fields", () => {
    for (const malformed of [
      { ...summary, activeLeafMessageId: undefined },
      { ...summary, defaultModelId: undefined },
      { ...summary, defaultProvider: undefined },
      { ...summary, folderId: undefined },
      { ...summary, messageCount: -1 },
      { ...summary, messageCount: 0.5 },
      { ...summary, pinned: undefined }
    ]) {
      expect(decodeChatSummaryResponse({ chat: malformed })).toBeNull();
    }
    expect(
      decodeWorkspaceChatsResponse({ chats: [summary], folders: [] })
    ).toBeNull();
  });

  it("decodes only direct answer outputs and strips retired receipt fields", () => {
    const artifactSummary = {
      citationCount: 3,
      citations: [{
        index: 1,
        privateRoute: "route-secret",
        title: "Direct citation",
        url: "https://example.com/citation"
      }],
      contextTruncation: { approxDroppedTokens: 100, droppedMessages: 2 },
      knowledgeCitations: [{
        baseName: "Policies",
        documentVersionNumber: 3,
        fileName: "handbook.pdf",
        handle: "K1.1",
        knowledgeBaseId: "private-base-id",
        page: 12
      }],
      knowledgeState: {
        answer: "insufficient_evidence",
        privateReason: "private-retrieval-diagnostic",
        scope: "partial_sources_ready"
      },
      knowledgeInvocationCount: 1,
      knowledgeOutcomes: [{ invocationOrdinal: 1, outcome: "complete" }],
      memoryReceipt: { itemCount: 1, summary: "private receipt" },
      reasoningCount: 1,
      reasoningText: ["Checked reasoning"],
      searchActivity: [{ query: "private generated query" }],
      searchCount: 1,
      searchStrategy: "private-route",
      sources: [{
        rank: 1,
        snippet: "Safe summary",
        title: "Evidence",
        url: "https://example.com/evidence"
      }],
      toolCallCount: 1,
      toolCalls: [{ argumentsPreview: { secret: true } }]
    };
    const decoded = decodeChatDetailResponse({
      chat: {
        ...detailChat(),
        messages: [{
          ...message,
          evidenceSummary: { sourceCount: 99 },
          artifactSummary,
          runUsage: { totalTokens: 99 }
        }],
        usageStats
      }
    })?.messages[0];

    expect(decoded).not.toHaveProperty("evidenceSummary");
    expect(decoded).not.toHaveProperty("runUsage");
    expect(decoded?.artifactSummary).toEqual({
      citations: [{
        index: 1,
        title: "Direct citation",
        url: "https://example.com/citation"
      }],
      knowledgeCitations: [{
        handle: "K1.1"
      }],
      knowledgeState: {
        answer: "insufficient_evidence",
        scope: "partial_sources_ready"
      },
      reasoningText: ["Checked reasoning"],
      sources: [{
        rank: 1,
        snippet: "Safe summary",
        title: "Evidence",
        url: "https://example.com/evidence"
      }]
    });
    expect(JSON.stringify(decoded)).not.toMatch(
      /private-base-id|private generated query|private-route|receipt|toolCall|contextTruncation|handbook\.pdf|Policies/
    );
  });

  it("rejects malformed direct output fields and duplicate Knowledge handles", () => {
    const artifactSummary = {
      citations: [],
      knowledgeCitations: [{
        baseName: "Policies",
        fileName: "handbook.pdf",
        handle: "K1.1",
        page: 12
      }],
      reasoningText: [],
      sources: []
    };
    const decode = (value: unknown) => decodeChatDetailResponse({
      chat: detailChat({
        messages: [{ ...message, artifactSummary: value }],
        usageStats
      })
    });

    expect(decode(artifactSummary)).not.toBeNull();
    expect(decode({ ...artifactSummary, reasoningText: "not-an-array" })).toBeNull();
    expect(decode({
      ...artifactSummary,
      sources: [{ rank: 1, title: "Unsafe", url: "javascript:alert(1)" }]
    })).toBeNull();
    expect(decode({
      ...artifactSummary,
      knowledgeCitations: [
        artifactSummary.knowledgeCitations[0],
        artifactSummary.knowledgeCitations[0]
      ]
    })).toBeNull();
  });

  it("round-trips the snapshot-bound assistant identity and fails closed on malformed identities", () => {
    const assistantIdentity = {
      avatar: {
        accents: [0, 1, 2, 3],
        backgroundShape: "circle",
        foregroundShape: "diamond",
        kind: "generated",
        paletteId: "ocean",
        recipeVersion: 1,
        rotations: [0, 2]
      },
      name: "Docs helper",
      revisionNumber: 3
    };

    expect(
      decodeChatDetailResponse({
        chat: {
          ...detailChat(),
          messages: [{ ...message, assistantIdentity }],
          usageStats: null
        }
      })?.messages[0]?.assistantIdentity
    ).toEqual(assistantIdentity);
    expect(
      decodeChatDetailResponse({
        chat: {
          ...detailChat(),
          messages: [{ ...message, assistantIdentity: null }],
          usageStats: null
        }
      })?.messages[0]?.assistantIdentity
    ).toBeNull();
    for (const malformedIdentity of [
      { ...assistantIdentity, name: "" },
      { ...assistantIdentity, revisionNumber: 0 },
      { ...assistantIdentity, avatar: { kind: "uploaded" } }
    ]) {
      expect(
        decodeChatDetailResponse({
          chat: {
            ...detailChat(),
            messages: [{ ...message, assistantIdentity: malformedIdentity }],
            usageStats: null
          }
        })
      ).toBeNull();
    }
  });

  it("decodes terminal updates only when both owners are complete", () => {
    expect(
      decodeChatUpdateData({
        chat: { ...summary, contextStats, usageStats },
        messages: [message]
      })
    ).toEqual({
      chat: { ...summary, contextStats, usageStats },
      messages: [message]
    });
    expect(
      decodeChatUpdateData({ chat: { ...summary, contextStats, usageStats }, messages: {} })
    ).toBeNull();
    expect(
      decodeChatUpdateData({ chat: summary, messages: [message] })
    ).toBeNull();
  });

  it("exact-decodes snapshot-bound forward message pages and enforces the fixed cap", () => {
    const rootMessage = { ...message, id: "message-root", modelRunId: null };
    const childMessage = {
      ...message,
      id: "message-child",
      parentMessageId: rootMessage.id
    };
    const value = {
      messages: [rootMessage, childMessage],
      pageInfo: {
        activeLeafMessageId: "message-leaf",
        beforeCursor: null,
        hasOlder: false,
        snapshotUpdatedAt: summary.updatedAt
      }
    };
    expect(decodeChatMessagesPageResponse(value)).toEqual(value);
    expect(decodeChatMessagesPageResponse({ ...value, extra: true })).toBeNull();
    expect(decodeChatMessagesPageResponse({
      ...value,
      messages: [childMessage, rootMessage]
    })).toBeNull();
    expect(decodeChatMessagesPageResponse({
      ...value,
      messages: Array.from({ length: CHAT_HISTORY_PAGE_SIZE + 1 }, (_, index) => ({
        ...message,
        id: `message-${index}`,
        parentMessageId: index === 0 ? null : `message-${index - 1}`
      }))
    })).toBeNull();
    expect(decodeChatMessagesPageResponse({
      ...value,
      pageInfo: { ...value.pageInfo, unknown: true }
    })).toBeNull();
  });

  it("exact-decodes a bounded-plaintext full branch graph and rejects broken DAGs", () => {
    const value = {
      branchGraph: {
        activeLeafMessageId: "assistant-a",
        nodes: [
          {
            id: "user-root",
            parentMessageId: null,
            preview: "Question",
            role: "user" as const,
            status: "complete" as const
          },
          {
            id: "assistant-a",
            parentMessageId: "user-root",
            preview: "Answer A",
            role: "assistant" as const,
            status: "complete" as const
          },
          {
            id: "assistant-b",
            parentMessageId: "user-root",
            preview: "Answer B",
            role: "assistant" as const,
            status: "error" as const
          }
        ],
        snapshotUpdatedAt: summary.updatedAt
      }
    };
    expect(decodeChatBranchesResponse(value)).toEqual(value);
    expect(decodeChatBranchesResponse({ ...value, extra: true })).toBeNull();
    expect(decodeChatBranchesResponse({
      branchGraph: {
        ...value.branchGraph,
        nodes: [{
          ...value.branchGraph.nodes[0],
          preview: "x".repeat(CHAT_BRANCH_PREVIEW_MAX_LENGTH + 1)
        }]
      }
    })).toBeNull();
    expect(decodeChatBranchesResponse({
      branchGraph: {
        ...value.branchGraph,
        nodes: [
          { ...value.branchGraph.nodes[0], parentMessageId: "assistant-a" },
          value.branchGraph.nodes[1]
        ]
      }
    })).toBeNull();
  });

  it("bounds branch previews by UTF-16 units without splitting a surrogate pair", () => {
    const preview = boundedChatBranchPreview(
      `${"x".repeat(CHAT_BRANCH_PREVIEW_MAX_LENGTH - 1)}😀trailing`
    );

    expect(preview).toBe("x".repeat(CHAT_BRANCH_PREVIEW_MAX_LENGTH - 1));
    expect(preview.length).toBeLessThanOrEqual(CHAT_BRANCH_PREVIEW_MAX_LENGTH);
    expect(preview.charCodeAt(preview.length - 1)).not.toBeGreaterThanOrEqual(0xd800);
  });

  it("keeps committed Memory action feedback and strips retrieval receipts", () => {
    const artifactSummary = {
      citations: [],
      memoryAction: {
        memoryRef: "opaque-memory-ref",
        operation: "UPDATE",
        statement: "I prefer concise answers.",
        status: "COMMITTED"
      },
      memoryReceipt: {
        itemCount: 1,
        items: [{ includedText: "private retrieved content" }],
        outcome: "USED"
      },
      reasoningText: [],
      sources: []
    };
    const decode = (value: unknown) => decodeChatDetailResponse({
      chat: detailChat({
        messages: [{ ...message, artifactSummary: value }],
        usageStats
      })
    });

    expect(decode(artifactSummary)?.messages[0]?.artifactSummary).toEqual({
      citations: [],
      memoryAction: {
        memoryRef: "opaque-memory-ref",
        operation: "UPDATE",
        statement: "I prefer concise answers.",
        status: "COMMITTED"
      },
      reasoningText: [],
      sources: []
    });
    expect(decode({
      citations: [],
      memoryStatus: "UNAVAILABLE",
      reasoningText: [],
      sources: []
    })?.messages[0]?.artifactSummary).toEqual({
      citations: [],
      memoryStatus: "UNAVAILABLE",
      reasoningText: [],
      sources: []
    });
    expect(decode({
      citations: [],
      memoryStatus: "FAILED_SAFE",
      reasoningText: [],
      sources: []
    })).toBeNull();
    expect(decode({
      ...artifactSummary,
      memoryAction: { ...artifactSummary.memoryAction, targetId: "private" }
    })).toBeNull();
  });

  it("strictly decodes distinct lifecycle, Archived, and source-resolution wires", () => {
    const lifecycle = {
      chat: {
        archived: true,
        id: summary.id,
        memoryMode: "NORMAL",
        sourceRevision: 7,
        updatedAt: summary.updatedAt
      }
    };
    const archivedSummary = {
      ...summary,
      archived: true,
      memoryMode: "EXCLUDED",
      sourceRevision: 8
    };
    const archivedDetail = {
      chat: {
        ...detailChat(),
        archived: true,
        memoryMode: "NORMAL",
        messages: [message],
        sourceRevision: 7,
        usageStats
      }
    };
    const source = {
      source: {
        chatId: summary.id,
        location: "ARCHIVED_PREVIEW",
        memoryMode: "NORMAL",
        sourceRevision: 7,
        updatedAt: summary.updatedAt
      }
    };

    expect(decodeChatLifecycleRequest({ expectedChatRevision: 7 })).toEqual({
      expectedChatRevision: 7
    });
    expect(decodeChatLifecycleRequest({ expectedChatRevision: 7, erase: true })).toBeNull();
    expect(decodeChatLifecycleResponse(lifecycle)).toEqual(lifecycle);
    expect(decodeArchivedChatsResponse({ chats: [archivedSummary], nextCursor: "opaque" }))
      .toEqual({ chats: [archivedSummary], nextCursor: "opaque" });
    expect(decodeArchivedChatDetailResponse(archivedDetail)).toEqual(archivedDetail);
    expect(decodeChatSourceResolutionResponse(source)).toEqual(source);
    expect(decodeChatMemoryStateResponse({
      chat: {
        archived: false,
        chatId: summary.id,
        mode: "TEMPORARY",
        sourceRevision: 8,
        temporaryRetentionDeadline: "2026-07-15T08:01:00.000Z",
        temporaryRetentionPolicyVersion: "temporary-24h-v1",
        updatedAt: summary.updatedAt
      }
    })).not.toBeNull();
    expect(decodeChatMemoryStateResponse({
      chat: {
        archived: false,
        chatId: summary.id,
        mode: "TEMPORARY",
        sourceRevision: 8,
        temporaryRetentionDeadline: null,
        temporaryRetentionPolicyVersion: "temporary-24h-v1",
        updatedAt: summary.updatedAt
      }
    })).toBeNull();

    expect(decodeChatLifecycleResponse({
      chat: { ...lifecycle.chat, memoryMode: "TEMPORARY" }
    })).toBeNull();
    expect(decodeArchivedChatsResponse({
      chats: [{ ...archivedSummary, archived: false }],
      nextCursor: null
    })).toBeNull();
    expect(decodeChatSourceResolutionResponse({
      source: { ...source.source, location: "MISSING" }
    })).toBeNull();
  });

});
