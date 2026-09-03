export type ChatExportMessage = Readonly<{
  content: unknown;
  role: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Readable text of a message: the joined text blocks of a persisted content
 * document, or a bare string as is. Attachment and tool blocks carry no text.
 */
export function chatExportText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!isRecord(content) || !Array.isArray(content.blocks)) {
    return "";
  }
  return content.blocks
    .map((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? block.text
        : ""
    )
    .filter(Boolean)
    .join("\n");
}

/**
 * Default export document: the readable Markdown projection of the visible
 * branch — title heading, then each turn under a User/Assistant heading.
 * Deterministic for a given branch; token counts, ids, and provider internals
 * never appear.
 */
export function chatExportMarkdown(
  title: string,
  messages: readonly ChatExportMessage[]
): string {
  const turns = messages.map((message) => {
    const speaker = message.role === "assistant" ? "Assistant" : "User";
    return `## ${speaker}\n\n${chatExportText(message.content).trim()}`;
  });
  return `# ${title}\n\n${turns.join("\n\n")}\n`;
}

/**
 * Deterministic export base name: a unicode-aware slug of the chat title plus
 * the ISO date, e.g. `release-checklist-032-2026-08-13`. The extension is
 * appended by the caller per export format.
 */
export function chatExportFileBaseName(title: string, date: Date = new Date()): string {
  const slug = title
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return `${slug || "chat"}-${date.toISOString().slice(0, 10)}`;
}
