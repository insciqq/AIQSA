import { describe, expect, it } from "vitest";
import { textConversationForRequest } from "./context";
import type { ProviderConversationMessage, ProviderRunRequest } from "./types";

function requestWithMessages(messages: ProviderConversationMessage[]): ProviderRunRequest {
  return {
    attachmentIds: ["attachment-1"],
    attachments: [],
    chatId: "chat-1",
    content: {
      blocks: [
        {
          attachmentId: "attachment-1",
          fileName: "brief.pdf",
          type: "file"
        }
      ]
    },
    context: {
      messages,
      mode: "branch_path"
    },
    knowledgePlan: { baseIds: [] },
    toolMode: "auto",
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: true,
      reasoning: false,
      vision: false
    },
    modelId: "fake-qsa",
    params: {},
    prompt: {
      developer: null,
      system: null
    },
    provider: "fake",
    searchPlan: { mode: "all_selected", options: [] }
  };
}

describe("provider context helpers", () => {
  it("keeps attachment-only user turns so adapters can attach files to the latest user message", () => {
    const conversation = textConversationForRequest(
      requestWithMessages([
        {
          content: {
            blocks: [{ text: "Earlier answer", type: "text" }]
          },
          id: "assistant-1",
          role: "assistant"
        },
        {
          content: {
            blocks: [{ attachmentId: "attachment-1", fileName: "brief.pdf", type: "file" }]
          },
          id: "current-user-message",
          role: "user"
        }
      ])
    );

    expect(conversation).toEqual([
      {
        content: "Earlier answer",
        id: "assistant-1",
        role: "assistant"
      },
      {
        content: "",
        id: "current-user-message",
        role: "user"
      }
    ]);
  });
});
