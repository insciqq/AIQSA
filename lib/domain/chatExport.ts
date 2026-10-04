import type { RunFollowupState } from "../contracts/runFollowups";
import { followupHistoryTurns } from "./runFollowupContext";

export type ChatExportMessage = Readonly<{
  content: unknown;
  role: string;
  followups?: RunFollowupState;
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
  const turns = messages.flatMap((message) => {
    const speaker = message.role === "assistant" ? "Assistant" : "User";
    return [
      ...followupHistoryTurns(message.followups?.entries ?? []).map(turn => `## ${turn.role === "assistant" ? "Assistant" : "User"}\n\n${turn.text}`),
      `## ${speaker}\n\n${chatExportText(message.content).trim()}`
    ];
  });
  return `# ${title}\n\n${turns.join("\n\n")}\n`;
}

const SLUG_MAX_CODE_POINTS = 64;
/**
 * A bulk-archive entry name is a ustar name of at most 100 UTF-8 bytes: the
 * slug leaves room for the date (11), a collision suffix (up to 7) and the
 * extension (up to 5).
 */
const SLUG_MAX_UTF8_BYTES = 72;

function utf8Length(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}

/**
 * Deterministic export base name: a unicode-aware slug of the chat title plus
 * the ISO date, e.g. `release-checklist-032-2026-08-13`. The extension is
 * appended by the caller per export format. The slug is cut on code points,
 * within a UTF-8 byte budget: a half surrogate pair would break the download
 * header, and a long non-ASCII name would not fit an archive entry.
 */
export function chatExportFileBaseName(title: string, date: Date = new Date()): string {
  const characters = Array.from(title
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")).slice(0, SLUG_MAX_CODE_POINTS);
  let bytes = 0;
  let kept = 0;
  while (kept < characters.length && bytes + utf8Length(characters[kept]!) <= SLUG_MAX_UTF8_BYTES) {
    bytes += utf8Length(characters[kept]!);
    kept += 1;
  }
  const slug = characters.slice(0, kept).join("").replace(/-+$/g, "");
  return `${slug || "chat"}-${date.toISOString().slice(0, 10)}`;
}
