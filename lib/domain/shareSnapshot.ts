import { getVisibleMessagePath, type BranchMessage } from "./branching";

export type ShareSnapshotMessageInput = BranchMessage & {
  content: unknown;
};

export type PublicShareSnapshot = {
  messages: {
    content: {
      blocks: { text: string; type: "text" }[];
    };
    role: "assistant" | "user";
  }[];
  title: string;
  version: 1;
};

function textBlock(text: string): { text: string; type: "text" } {
  return {
    text,
    type: "text"
  };
}

function sanitizeContent(content: unknown): PublicShareSnapshot["messages"][number]["content"] {
  if (typeof content !== "object" || content === null || !("blocks" in content)) {
    return {
      blocks: []
    };
  }

  const blocks = (content as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) {
    return {
      blocks: []
    };
  }

  return {
    blocks: blocks.flatMap((block) => {
      if (typeof block !== "object" || block === null || !("type" in block)) {
        return [];
      }

      if (block.type === "text" && "text" in block && typeof block.text === "string") {
        return [textBlock(block.text)];
      }

      if (block.type === "image") {
        return [textBlock("[Image attachment omitted]")];
      }

      if (block.type === "file") {
        return [textBlock("[Attachment omitted]")];
      }

      return [];
    })
  };
}

export function buildPublicShareSnapshot(input: {
  activeLeafMessageId: string;
  messages: ShareSnapshotMessageInput[];
  title: string;
}): PublicShareSnapshot {
  const visiblePath = getVisibleMessagePath(input.messages, input.activeLeafMessageId);

  return {
    messages: visiblePath.flatMap((message) => {
      if (message.role !== "assistant" && message.role !== "user") {
        return [];
      }

      return [
        {
          content: sanitizeContent(message.content),
          role: message.role
        }
      ];
    }),
    title: input.title,
    version: 1
  };
}
