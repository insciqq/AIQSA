export const defaultChatTitle = "New Chat";
const maxGeneratedTitleLength = 56;

export function messageTextFromContent(content: unknown): string {
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
  const normalized = messageTextFromContent(content).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return defaultChatTitle;
  }

  const characters = Array.from(normalized);
  if (characters.length <= maxGeneratedTitleLength) {
    return normalized;
  }

  const bounded = characters.slice(0, maxGeneratedTitleLength).join("");
  if (characters[maxGeneratedTitleLength] === " " || bounded.endsWith(" ")) {
    return bounded.trimEnd();
  }

  const lastWordBoundary = bounded.lastIndexOf(" ");
  return lastWordBoundary > 0 ? bounded.slice(0, lastWordBoundary).trimEnd() : bounded;
}
