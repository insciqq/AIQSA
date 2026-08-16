import type { TokenUsage } from "./usage";

export type ModelRunUsage = {
  estimatedCostMicros?: number | null;
} & TokenUsage;

export type ModelRunChatUpdateData = {
  chat: {
    activeLeafMessageId: string | null;
    contextStats: {
      approximateActiveBranchInputTokens: number;
    };
    createdAt: string;
    defaultModelId: string | null;
    defaultProvider: string | null;
    folderId: string | null;
    id: string;
    messageCount: number;
    pinned: boolean;
    title: string;
    updatedAt: string;
    usageStats?: {
      activeBranchMessageCount: number;
      cachedInputTokens: number;
      cacheWriteInputTokens: number;
      totalTokens: number;
    } | null;
  };
  messages: {
    artifactSummary?: unknown;
    assistantIdentity?: unknown;
    content: unknown;
    createdAt: string;
    errorMessage?: string | null;
    id: string;
    modelId: string | null;
    modelRunId?: string | null;
    parentMessageId: string | null;
    provider: string | null;
    role: string;
    status: string;
    toolActivity?: unknown;
  }[];
};

export type ModelRunSseEvent =
  | {
      type: "run_start";
      data: {
        modelId: string;
        provider: string;
        runId: string;
        status: "streaming";
      };
    }
  | {
      type: "message_start";
      data: {
        assistantMessageId: string;
        userMessageId?: string;
      };
    }
  | {
      type: "token";
      data: {
        delta: string;
      };
    }
  | {
      type: "message_reset";
      data: {
        round: number;
      };
    }
  | {
      type: "grounding_display";
      data: {
        provider: "gemini";
        runSearch: {
          callCount: number;
          queryCount: number;
        };
        suggestionsHtml: string;
        citations: {
          startIndex: number;
          endIndex: number;
          url: string;
          title: string;
        }[];
      };
    }
  | {
      type: "artifact";
      data: {
        artifactType: "citation" | "context_truncated" | "reasoning" | "search" | "summary" | "tool_call" | "tool_result";
        payload: unknown;
        searchDisplayName?: string;
        searchStrategy?: string;
      };
    }
  | {
      type: "usage";
      data: ModelRunUsage;
    }
  | {
      type: "chat_update";
      data: ModelRunChatUpdateData;
    }
  | {
      type: "done";
      data: {
        runId: string;
        status: "complete";
      };
    }
  | {
      type: "error";
      data: {
        code: string;
        message: string;
      };
    };

export type GroundingDisplaySseEvent = Extract<
  ModelRunSseEvent,
  { type: "grounding_display" }
>;

export function isGroundingDisplaySseEvent(
  event: ModelRunSseEvent
): event is GroundingDisplaySseEvent {
  return event.type === "grounding_display";
}

export function encodeSseEvent(event: ModelRunSseEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export function textFromContentBlocks(content: { blocks?: unknown[] }): string {
  if (!Array.isArray(content.blocks)) {
    return "";
  }

  return content.blocks
    .map((block) => {
      if (typeof block === "object" && block && "type" in block && block.type === "text" && "text" in block) {
        return typeof block.text === "string" ? block.text : "";
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}
