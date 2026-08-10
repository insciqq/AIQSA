import { describe, expect, it } from "vitest";
import {
  CHAT_BRANCH_PREVIEW_MAX_LENGTH,
  CHAT_HISTORY_PAGE_SIZE,
  boundedChatBranchPreview,
  decodeChatBranchesResponse,
  decodeChatDetailResponse,
  decodeChatMessagesPageResponse,
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
  content: { blocks: [{ text: "Answer", type: "text" }] },
  createdAt: "2026-07-14T08:00:30.000Z",
  errorMessage: null,
  id: "message-1",
  modelId: "gpt-5.5",
  modelRunId: "run-1",
  parentMessageId: null,
  provider: "openai",
  role: "assistant",
  runUsage: { totalTokens: 10 },
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

const toolActivity = {
  argumentsPreview: { query: "memory" },
  callId: "call-1",
  capability: "mcp",
  credentialSources: ["personal"],
  durationMs: 42,
  errorMessage: null,
  externalAccountLabel: null,
  ordinal: 0,
  resultPreview: { content: [{ text: "found", type: "text" }] },
  round: 1,
  serverName: "Mem0",
  status: "complete",
  toolName: "search"
};

describe("chat wire contracts", () => {
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

  it("normalizes the legacy paired empty chat default and rejects inconsistent pairs", () => {
    expect(
      decodeChatSummaryResponse({
        chat: { ...summary, defaultModelId: "", defaultProvider: "" }
      })
    ).toEqual({
      ...summary,
      defaultModelId: null,
      defaultProvider: null
    });

    for (const [defaultModelId, defaultProvider] of [
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
      chats: [{ ...summary, defaultKnowledgePlan: knowledgePlan }],
      contentMatches: [],
      folders: [folder]
    });
    expect(decodeWorkspaceChatsResponse({
      chats: [{ ...summary, defaultKnowledgePlan: { baseIds: ["same", "same"] } }],
      contentMatches: [],
      folders: []
    })).toBeNull();
    expect(decodeWorkspaceChatsResponse({
      chats: [summary],
      contentMatches: [],
      folders: [{ ...folder, defaultKnowledgePlan: { baseIds: ["a", "b", "c", "d"] } }]
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

  it("requires a valid message array and nullable usage projection for detail", () => {
    const artifactSummary = {
      citationCount: 0,
      citations: [],
      reasoningCount: 1,
      reasoningText: ["Checked reasoning"],
      searchActivity: [],
      searchCount: 0,
      searchDisplayName: "Company Gateway Search",
      searchStrategy: null,
      toolCallCount: 0,
      toolCalls: []
    };
    expect(
      decodeChatDetailResponse({
        chat: {
          ...detailChat(),
          messages: [{ ...message, artifactSummary }],
          usageStats
        }
      })
    ).toEqual({
      ...detailChat(),
      messages: [{ ...message, artifactSummary }],
      usageStats
    });
    expect(
      decodeChatDetailResponse({ chat: detailChat({ messages: [message], usageStats: null }) })
    ).toEqual(detailChat({ messages: [message], usageStats: null }));
    expect(decodeChatDetailResponse({ chat: detailChat({ usageStats }) })).toBeNull();
    expect(
      decodeChatDetailResponse({ chat: detailChat({ messages: [message] }) })
    ).toBeNull();
    expect(
      decodeChatDetailResponse({
        chat: detailChat({ messages: [{ ...message, createdAt: undefined }], usageStats })
      })
    ).toBeNull();
    for (const malformedMessage of [
      { ...message, role: "owner" },
      { ...message, status: "finished" },
      { ...message, runUsage: { totalTokens: -1 } },
      { ...message, artifactSummary: { ...artifactSummary, searchDisplayName: 7 } },
      { ...message, artifactSummary: { ...artifactSummary, reasoningText: "not-an-array" } }
    ]) {
      expect(
        decodeChatDetailResponse({
          chat: detailChat({ messages: [malformedMessage], usageStats })
        })
      ).toBeNull();
    }
  });

  it("keeps legacy messages without a run usage projection readable", () => {
    const { runUsage: _runUsage, ...legacyMessage } = message;

    expect(
      decodeChatDetailResponse({
        chat: detailChat({ messages: [legacyMessage], usageStats: null })
      })?.messages[0]
    ).toEqual(legacyMessage);
  });

  it("requires a complete, sequential Knowledge artifact projection", () => {
    const knowledgeSummary = {
      citationCount: 0,
      citations: [],
      knowledgeCitations: [{
        baseName: "Policies",
        documentVersionNumber: 3,
        fileName: "handbook.pdf",
        handle: "K1.1",
        knowledgeBaseId: "base-policies",
        page: 12
      }],
      knowledgeInvocationCount: 2,
      knowledgeOutcomes: [
        { invocationOrdinal: 1, outcome: "complete" },
        { invocationOrdinal: 2, outcome: "zero_above_threshold" }
      ],
      reasoningCount: 0,
      reasoningText: [],
      searchCount: 0,
      searchStrategy: null,
      toolCallCount: 0,
      toolCalls: []
    };
    const decode = (artifactSummary: unknown) => decodeChatDetailResponse({
      chat: detailChat({ messages: [{ ...message, artifactSummary }], usageStats })
    });

    expect(decode(knowledgeSummary)?.messages[0]?.artifactSummary).toEqual(knowledgeSummary);
    for (const malformed of [
      { ...knowledgeSummary, knowledgeOutcomes: undefined },
      {
        ...knowledgeSummary,
        knowledgeOutcomes: [
          { invocationOrdinal: 1, outcome: "complete" },
          { invocationOrdinal: 3, outcome: "zero_above_threshold" }
        ]
      },
      {
        ...knowledgeSummary,
        knowledgeCitations: [
          knowledgeSummary.knowledgeCitations[0],
          knowledgeSummary.knowledgeCitations[0]
        ]
      },
      {
        ...knowledgeSummary,
        knowledgeCitations: [{ ...knowledgeSummary.knowledgeCitations[0], handle: "K3.1" }]
      }
    ]) {
      expect(decode(malformed)).toBeNull();
    }
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

  it("decodes complete tool activity summaries and fails closed on inconsistent counts", () => {
    const artifactSummary = {
      citationCount: 0,
      citations: [],
      reasoningCount: 0,
      reasoningText: [],
      searchCount: 0,
      searchStrategy: null,
      toolCallCount: 1,
      toolCalls: [toolActivity]
    };

    expect(
      decodeChatDetailResponse({
        chat: {
          ...detailChat(),
          messages: [{ ...message, artifactSummary }],
          usageStats
        }
      })?.messages[0]?.artifactSummary
    ).toEqual(artifactSummary);

    expect(
      decodeChatDetailResponse({
        chat: {
          ...detailChat(),
          messages: [{
            ...message,
            artifactSummary: { ...artifactSummary, toolCallCount: 0 }
          }],
          usageStats
        }
      })
    ).toBeNull();
  });

  it("keeps only bounded friendly Search disclosure facts in chat messages", () => {
    const searchActivity = [{
      credential: "secret",
      displayName: "Company Gateway Search",
      endpoint: "https://provider.example/v1/responses",
      failure: { code: "private_provider_code", raw: "private" },
      failureReason: "Search reached its output limit before completing.",
      providerOperations: [{
        id: "provider-operation-id",
        kind: "search",
        ordinal: 0,
        pattern: null,
        queries: ["current evidence"],
        status: "complete",
        url: null
      }],
      providerOperationsTruncated: false,
      query: "current evidence",
      rawPayload: { private: true },
      routeId: "route-1",
      sourceCount: 1,
      sources: [{
        rank: 1,
        snippet: "Safe summary",
        title: "Evidence",
        url: "https://example.com/evidence"
      }],
      status: "error"
    }];
    const artifactSummary = {
      citationCount: 0,
      citations: [],
      reasoningCount: 0,
      reasoningText: [],
      searchActivity,
      searchCount: 1,
      searchDetails: [{ rawProviderResponse: "private" }],
      searchStrategy: "custom-web-search:connection-1",
      toolCallCount: 0,
      toolCalls: []
    };

    const decoded = decodeChatDetailResponse({
      chat: {
        ...detailChat(),
        messages: [{ ...message, artifactSummary }],
        usageStats
      }
    })?.messages[0]?.artifactSummary;

    expect(decoded?.searchActivity).toEqual([{
      displayName: "Company Gateway Search",
      failureReason: "Search reached its output limit before completing.",
      providerOperations: [{
        kind: "search",
        ordinal: 0,
        pattern: null,
        queries: ["current evidence"],
        status: "complete",
        url: null
      }],
      providerOperationsTruncated: false,
      query: "current evidence",
      sourceCount: 1,
      sources: [{
        rank: 1,
        snippet: "Safe summary",
        title: "Evidence",
        url: "https://example.com/evidence"
      }],
      status: "error"
    }]);
    expect(JSON.stringify(decoded)).not.toMatch(/secret|provider\.example|provider-operation-id|private_provider_code|rawPayload|route-1|rawProviderResponse/);
  });

  it("rejects an unbounded Search failure reason", () => {
    const artifactSummary = {
      citationCount: 0,
      citations: [],
      reasoningCount: 0,
      reasoningText: [],
      searchActivity: [{
        displayName: "Company Gateway Search",
        failureReason: "x".repeat(257),
        providerOperations: [],
        providerOperationsTruncated: false,
        query: "current evidence",
        sourceCount: 0,
        sources: [],
        status: "error"
      }],
      searchCount: 1,
      searchStrategy: "custom-web-search:connection-1",
      toolCallCount: 0,
      toolCalls: []
    };

    expect(decodeChatDetailResponse({
      chat: {
        ...detailChat(),
        messages: [{ ...message, artifactSummary }],
        usageStats
      }
    })).toBeNull();
  });

  it("rejects a Search provider-operation trace above the wire inspection limit", () => {
    const providerOperations = Array.from({ length: 32 }, (_, ordinal) => ({
      kind: "search",
      ordinal,
      pattern: null,
      queries: ["q".repeat(512)],
      status: "complete",
      url: null
    }));
    const artifactSummary = {
      citationCount: 0,
      citations: [],
      reasoningCount: 0,
      reasoningText: [],
      searchActivity: [{
        displayName: "Company Gateway Search",
        providerOperations,
        providerOperationsTruncated: false,
        query: "current evidence",
        sourceCount: 0,
        sources: [],
        status: "complete"
      }],
      searchCount: 1,
      searchStrategy: "custom-web-search:connection-1",
      toolCallCount: 0,
      toolCalls: []
    };

    expect(decodeChatDetailResponse({
      chat: {
        ...detailChat(),
        messages: [{ ...message, artifactSummary }],
        usageStats
      }
    })).toBeNull();
  });

  it("strictly decodes message-bound Memory receipt and committed action feedback", () => {
    const artifactSummary = {
      citationCount: 0,
      citations: [],
      memoryAction: { operation: "UPDATE", status: "COMMITTED" },
      memoryReceipt: {
        degradationCode: null,
        itemCount: 1,
        items: [{
          includedText: "Frozen answer-bound memory.",
          itemType: "FACT_VERSION",
          lifecycleState: "LATER_FORGOTTEN",
          ordinal: 0,
          scopeType: "GLOBAL_USER",
          selectionReason: "explicit_lexical_relevance",
          sourceChatId: null,
          sourceMessageIds: [],
          sourceMode: "EXPLICIT",
          versionId: "version-1"
        }],
        outcome: "USED",
        summary: "memory_receipt:used:1"
      },
      reasoningCount: 0,
      reasoningText: [],
      searchCount: 0,
      searchStrategy: null,
      toolCallCount: 0,
      toolCalls: []
    };
    const decode = (value: unknown) => decodeChatDetailResponse({
      chat: detailChat({ messages: [{ ...message, artifactSummary: value }], usageStats })
    });

    expect(decode(artifactSummary)?.messages[0]?.artifactSummary).toEqual(artifactSummary);
    expect(decode({
      ...artifactSummary,
      memoryReceipt: { ...artifactSummary.memoryReceipt, itemCount: 2 }
    })).toBeNull();
    expect(decode({
      ...artifactSummary,
      memoryAction: { ...artifactSummary.memoryAction, targetId: "private" }
    })).toBeNull();
  });
});
