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

  // This is a positive public-schema projection. Knowledge receipts, handles,
  // passages, citations, and future structured blocks are omitted by default.
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

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Re-projects stored JSON through the public schema. This deliberately ignores
 * every extra field rather than trusting a broad persistence cast.
 */
export function projectPublicShareSnapshot(value: unknown): PublicShareSnapshot | null {
  const candidate = record(value);
  if (
    !candidate || candidate.version !== 1 || typeof candidate.title !== "string" ||
    !Array.isArray(candidate.messages)
  ) return null;

  const messages: PublicShareSnapshot["messages"] = [];
  for (const rawMessage of candidate.messages) {
    const message = record(rawMessage);
    if (!message || (message.role !== "assistant" && message.role !== "user")) return null;
    const content = record(message.content);
    if (!content || !Array.isArray(content.blocks)) return null;
    messages.push({
      content: {
        blocks: content.blocks.flatMap((rawBlock) => {
          const block = record(rawBlock);
          return block?.type === "text" && typeof block.text === "string"
            ? [textBlock(block.text)]
            : [];
        })
      },
      role: message.role
    });
  }
  return { messages, title: candidate.title, version: 1 };
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
