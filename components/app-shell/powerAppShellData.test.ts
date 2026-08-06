import { describe, expect, it } from "vitest";
import { decodeWorkspaceChatsResponse } from "@/lib/contracts/chats";
import { chatDetailFromApi, chatSummaryFromApi } from "./shellApi";
import {
  chatDetailBodyFromUnknown,
  chatUpdateFromEvent
} from "./powerAppShellData";
import type { RunEventView } from "./types";

const usageStats = {
  activeBranchMessageCount: 1,
  cachedInputTokens: 3,
  cacheWriteInputTokens: 2,
  totalTokens: 13
};

const assistantMessage = {
  artifactSummary: null,
  content: {
    blocks: [{ text: "Canonical answer", type: "text" }]
  },
  createdAt: "2026-07-12T08:00:30.000Z",
  errorMessage: null,
  id: "assistant-1",
  modelId: "gpt-5.5",
  modelRunId: "run-1",
  parentMessageId: null,
  provider: "openai",
  role: "assistant",
  status: "complete"
};

const summaryWire = {
  activeLeafMessageId: "assistant-1",
  createdAt: "2026-07-12T08:00:00.000Z",
  defaultModelId: "gpt-5.5",
  defaultProvider: "openai",
  folderId: null,
  id: "chat-1",
  messageCount: 1,
  pinned: true,
  title: "Summary boundary",
  updatedAt: "2026-07-12T08:01:00.000Z"
};

const detailWire = {
  ...summaryWire,
  messages: [assistantMessage],
  usageStats
};

describe("chat wire decoding", () => {
  it("projects workspace chat payloads into summary-only client state", () => {
    const workspace = decodeWorkspaceChatsResponse({
      chats: [summaryWire],
      contentMatches: [],
      folders: []
    });

    expect(workspace).not.toBeNull();
    const summary = chatSummaryFromApi(workspace!.chats[0]!);

    expect(summary).toEqual({
      activeLeafMessageId: "assistant-1",
      createdAt: "2026-07-12T08:00:00.000Z",
      defaultModelId: "gpt-5.5",
      defaultProvider: "openai",
      folderId: null,
      id: "chat-1",
      messageCount: 1,
      pinned: true,
      title: "Summary boundary",
      updatedAt: "2026-07-12T08:01:00.000Z"
    });
    expect(summary).not.toHaveProperty("messages");
    expect(summary).not.toHaveProperty("usageStats");
  });

  it("normalizes an absent wire default into the existing empty client selection", () => {
    const decoded = decodeWorkspaceChatsResponse({
      chats: [
        {
          ...summaryWire,
          defaultModelId: null,
          defaultProvider: null
        }
      ],
      contentMatches: [],
      folders: []
    });

    expect(decoded).not.toBeNull();
    expect(chatSummaryFromApi(decoded!.chats[0]!)).toMatchObject({
      defaultModelId: "",
      defaultProvider: "",
      id: summaryWire.id
    });
  });

  it("requires messages for chat detail and preserves decoded detail for its converter", () => {
    const malformedMessageWire = {
      ...detailWire,
      messages: [{ ...assistantMessage, id: undefined }]
    };

    expect(chatDetailBodyFromUnknown({ chat: summaryWire })).toBeNull();
    expect(chatDetailBodyFromUnknown({ chat: malformedMessageWire })).toBeNull();

    const decodedDetail = chatDetailBodyFromUnknown({ chat: detailWire });
    expect(decodedDetail).not.toBeNull();

    const detail = chatDetailFromApi(decodedDetail!);
    expect(detail).toMatchObject({
      activeLeafMessageId: "assistant-1",
      id: "chat-1",
      messages: [
        {
          content: assistantMessage.content,
          id: "assistant-1",
          role: "assistant",
          runId: "run-1",
          status: "complete"
        }
      ],
      usageStats
    });
  });

  it("keeps chat_update summary, messages, and usage in separate ownership fields", () => {
    const event = {
      data: {
        chat: {
          ...summaryWire,
          usageStats
        },
        messages: [assistantMessage]
      },
      type: "chat_update"
    } satisfies RunEventView;

    const update = chatUpdateFromEvent(event);

    expect(update).not.toBeNull();
    expect(update!.chat).not.toHaveProperty("messages");
    expect(update!.chat).not.toHaveProperty("usageStats");
    expect(update!.chat).toMatchObject({
      activeLeafMessageId: "assistant-1",
      id: "chat-1",
      messageCount: 1,
      title: "Summary boundary"
    });
    expect(update!.messages).toEqual([
      expect.objectContaining({
        content: assistantMessage.content,
        id: "assistant-1",
        role: "assistant",
        runId: "run-1",
        status: "complete"
      })
    ]);
    expect(update!.usageStats).toEqual(usageStats);

    expect(
      chatUpdateFromEvent({
        data: {
          chat: {
            ...summaryWire,
            usageStats
          },
          messages: [{ ...assistantMessage, role: undefined }]
        },
        type: "chat_update"
      })
    ).toBeNull();
    expect(
      chatUpdateFromEvent({
        data: {
          chat: {
            ...summaryWire,
            usageStats
          }
        },
        type: "chat_update"
      })
    ).toBeNull();
    expect(
      chatUpdateFromEvent({
        data: {
          chat: {
            ...summaryWire,
            usageStats
          },
          messages: {}
        },
        type: "chat_update"
      })
    ).toBeNull();
  });
});
