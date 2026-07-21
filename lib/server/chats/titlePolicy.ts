export const defaultChatTitle = "New Chat";

function textFromContent(content: unknown): string {
  if (typeof content !== "object" || content === null || !("blocks" in content)) {
    return "";
  }

  const blocks = (content as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) {
    return "";
  }

  return blocks
    .map((block) =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
        ? block.text
        : ""
    )
    .filter(Boolean)
    .join(" ")
    .trim();
}

export function titleFromMessageContent(content: unknown): string {
  const normalized = textFromContent(content).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return defaultChatTitle;
  }

  return normalized.length > 56 ? `${normalized.slice(0, 53)}...` : normalized;
}
