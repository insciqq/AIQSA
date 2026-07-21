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
  status: "complete"
};

const usageStats = {
  activeBranchMessageCount: 1,
  cachedInputTokens: 2,
  cacheWriteInputTokens: 3,
  totalTokens: 10
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

  it("rejects missing or malformed required summary fields", () => {
    for (const malformed of [
      { ...summary, activeLeafMessageId: undefined },
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
      searchCount: 0,
      searchDetails: [],
      searchStrategy: null
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
      { ...message, artifactSummary: { ...artifactSummary, reasoningText: "not-an-array" } }
    ]) {
      expect(
        decodeChatDetailResponse({
          chat: { ...summary, messages: [malformedMessage], usageStats }
        })
      ).toBeNull();
    }
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
});
