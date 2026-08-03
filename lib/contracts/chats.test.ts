import { describe, expect, it } from "vitest";
import {
  decodeChatDetailResponse,
  decodeChatSummaryResponse,
  decodeChatUpdateData,
  decodeWorkspaceChatsResponse
} from "./chats";

const summary = {
  activeLeafMessageId: "message-1",
  createdAt: "2026-07-14T08:00:00.000Z",
  defaultModelId: "gpt-5.5",
  defaultPromptPresetId: null,
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
        chat: { ...nullDefaultSummary, messages: [message], usageStats: null }
      })
    ).toEqual({ ...nullDefaultSummary, messages: [message], usageStats: null });
    expect(
      decodeChatUpdateData({
        chat: { ...nullDefaultSummary, usageStats: null },
        messages: [message]
      })
    ).toEqual({
      chat: { ...nullDefaultSummary, usageStats: null },
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

  it("rejects missing or malformed required summary fields", () => {
    for (const malformed of [
      { ...summary, activeLeafMessageId: undefined },
      { ...summary, defaultModelId: undefined },
      { ...summary, defaultProvider: undefined },
      { ...summary, defaultPromptPresetId: undefined },
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
          ...summary,
          messages: [{ ...message, artifactSummary }],
          usageStats
        }
      })
    ).toEqual({
      ...summary,
      messages: [{ ...message, artifactSummary }],
      usageStats
    });
    expect(
      decodeChatDetailResponse({ chat: { ...summary, messages: [message], usageStats: null } })
    ).toEqual({ ...summary, messages: [message], usageStats: null });
    expect(decodeChatDetailResponse({ chat: { ...summary, usageStats } })).toBeNull();
    expect(
      decodeChatDetailResponse({ chat: { ...summary, messages: [message] } })
    ).toBeNull();
    expect(
      decodeChatDetailResponse({
        chat: { ...summary, messages: [{ ...message, createdAt: undefined }], usageStats }
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
          chat: { ...summary, messages: [malformedMessage], usageStats }
        })
      ).toBeNull();
    }
  });

  it("keeps legacy messages without a run usage projection readable", () => {
    const { runUsage: _runUsage, ...legacyMessage } = message;

    expect(
      decodeChatDetailResponse({
        chat: { ...summary, messages: [legacyMessage], usageStats: null }
      })?.messages[0]
    ).toEqual(legacyMessage);
  });

  it("decodes terminal updates only when both owners are complete", () => {
    expect(
      decodeChatUpdateData({
        chat: { ...summary, usageStats },
        messages: [message]
      })
    ).toEqual({
      chat: { ...summary, usageStats },
      messages: [message]
    });
    expect(
      decodeChatUpdateData({ chat: { ...summary, usageStats }, messages: {} })
    ).toBeNull();
    expect(
      decodeChatUpdateData({ chat: summary, messages: [message] })
    ).toBeNull();
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
          ...summary,
          messages: [{ ...message, artifactSummary }],
          usageStats
        }
      })?.messages[0]?.artifactSummary
    ).toEqual(artifactSummary);

    expect(
      decodeChatDetailResponse({
        chat: {
          ...summary,
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
      status: "complete"
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
        ...summary,
        messages: [{ ...message, artifactSummary }],
        usageStats
      }
    })?.messages[0]?.artifactSummary;

    expect(decoded?.searchActivity).toEqual([{
      displayName: "Company Gateway Search",
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
      status: "complete"
    }]);
    expect(JSON.stringify(decoded)).not.toMatch(/secret|provider\.example|provider-operation-id|rawPayload|route-1|rawProviderResponse/);
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
        ...summary,
        messages: [{ ...message, artifactSummary }],
        usageStats
      }
    })).toBeNull();
  });
});
