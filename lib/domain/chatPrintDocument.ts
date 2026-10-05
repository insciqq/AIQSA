import { chatExportFileBaseName, chatExportText } from "./chatExport";
import { chatExportActiveBranch, type ChatExportSource } from "./chatExportDocument";
import { followupHistoryTurns } from "./runFollowupContext";

/** An image the print page shows through the authorized attachment route. */
export type ChatPrintImage = Readonly<{
  attachmentId: string;
  label: string;
  width?: number;
  height?: number;
}>;

export type ChatPrintTurn = Readonly<{
  role: "assistant" | "user";
  /** Markdown, rendered exactly as the chat renders it. */
  text: string;
  images: readonly ChatPrintImage[];
  /** Names of non-image attachments. */
  files: readonly string[];
}>;

/** The client-safe print projection of a chat's visible branch. */
export type ChatPrintDocument = Readonly<{
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Proposed "Save as PDF" file name: the export base name. */
  fileBaseName: string;
  turns: readonly ChatPrintTurn[];
}>;

/** A generated image of an answer's own run, as the thread lists it. */
export type ChatPrintGeneratedImage = Readonly<{
  attachmentId: string;
  width: number;
  height: number;
}>;

export function chatPrintPath(chatId: string): string {
  return `/print/c/${encodeURIComponent(chatId)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentAttachments(
  content: unknown,
  source: ChatExportSource
): { files: string[]; images: ChatPrintImage[] } {
  const images: ChatPrintImage[] = [];
  const files: string[] = [];
  if (!isRecord(content) || !Array.isArray(content.blocks)) return { files, images };
  for (const block of content.blocks) {
    if (!isRecord(block) || typeof block.attachmentId !== "string" || !block.attachmentId) continue;
    const row = source.attachments.get(block.attachmentId);
    if (block.type === "image" && row) {
      // Only this chat's existing attachments; the thread labels them the same way.
      images.push({
        attachmentId: block.attachmentId,
        label: typeof block.alt === "string" && block.alt.trim() ? block.alt : "Image attachment"
      });
    } else if (block.type === "file") {
      const name = row?.name ?? (typeof block.fileName === "string" ? block.fileName.trim() : "");
      if (name) files.push(name);
    }
  }
  return { files, images };
}

/**
 * The visible branch as the chat shows it: durable follow-ups as the turns
 * the Markdown export writes, then each message with its text, images (its
 * own blocks plus the generated images of its run) and file names. A stopped
 * answer without text reads "Stopped.", as in the Markdown export.
 */
export function chatPrintDocument(
  source: ChatExportSource,
  generatedImages: ReadonlyMap<string, readonly ChatPrintGeneratedImage[]>,
  printedAt: Date
): ChatPrintDocument {
  const turns = chatExportActiveBranch(source).flatMap((message): ChatPrintTurn[] => {
    const role = message.role === "assistant" ? "assistant" : "user";
    const followups = followupHistoryTurns(message.followups?.entries ?? []).map((turn): ChatPrintTurn => ({
      files: [],
      images: [],
      role: turn.role,
      text: turn.text
    }));
    const attachments = contentAttachments(message.content, source);
    const shown = new Set(attachments.images.map((image) => image.attachmentId));
    const generated = (generatedImages.get(message.key) ?? [])
      .filter((image) => !shown.has(image.attachmentId))
      .map((image): ChatPrintImage => ({
        attachmentId: image.attachmentId,
        height: image.height,
        label: "Generated image",
        width: image.width
      }));
    const text = chatExportText(message.content).trim();
    return [
      ...followups,
      {
        files: attachments.files,
        images: [...attachments.images, ...generated],
        role,
        text: text || (message.status === "cancelled" ? "Stopped." : "")
      }
    ];
  });
  return {
    createdAt: source.chat.createdAt.toISOString(),
    fileBaseName: chatExportFileBaseName(source.chat.title, printedAt),
    title: source.chat.title,
    turns,
    updatedAt: source.chat.updatedAt.toISOString()
  };
}
