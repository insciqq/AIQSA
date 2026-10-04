import {
  CHAT_EXPORT_FORMAT,
  CHAT_EXPORT_MESSAGE_STATUSES,
  CHAT_EXPORT_VERSION,
  type ChatExportDocument,
  type ChatExportDocumentAttachment,
  type ChatExportDocumentChat,
  type ChatExportDocumentMessage,
  type ChatExportMessageStatus
} from "../contracts/chatExport";
import type { RunFollowupState } from "../contracts/runFollowups";
import { chatExportMarkdown, chatExportText } from "./chatExport";
import { followupHistoryTurns } from "./runFollowupContext";

/** One persisted message as the export reads it; `key` never leaves the server. */
export type ChatExportSourceMessage = Readonly<{
  key: string;
  parentKey: string | null;
  role: string;
  status: string;
  content: unknown;
  createdAt: Date;
  provider: string | null;
  modelId: string | null;
  followups?: RunFollowupState | null;
}>;

export type ChatExportSourceChat = Readonly<{
  title: string;
  createdAt: Date;
  updatedAt: Date;
  archived: boolean;
  pinned: boolean;
  activeLeafKey: string | null;
}>;

export type ChatExportAttachmentMetadata = Readonly<{
  name: string;
  mimeType: string;
  byteSize: number;
}>;

export type ChatExportSource = Readonly<{
  chat: ChatExportSourceChat;
  messages: readonly ChatExportSourceMessage[];
  /** Metadata of the chat's attachments by attachment id. */
  attachments: ReadonlyMap<string, ChatExportAttachmentMetadata>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Attachment ids referenced by a persisted content document, in block order. */
export function chatExportAttachmentIds(content: unknown): string[] {
  if (!isRecord(content) || !Array.isArray(content.blocks)) return [];
  return content.blocks.flatMap((block) =>
    isRecord(block) && (block.type === "image" || block.type === "file") &&
    typeof block.attachmentId === "string" && block.attachmentId
      ? [block.attachmentId]
      : []);
}

function messageAttachments(
  content: unknown,
  attachments: ReadonlyMap<string, ChatExportAttachmentMetadata>
): ChatExportDocumentAttachment[] {
  if (!isRecord(content) || !Array.isArray(content.blocks)) return [];
  return content.blocks.flatMap((block): ChatExportDocumentAttachment[] => {
    if (!isRecord(block) || (block.type !== "image" && block.type !== "file") || typeof block.attachmentId !== "string") return [];
    const row = attachments.get(block.attachmentId);
    if (row) return [{ name: row.name, mimeType: row.mimeType, byteSize: row.byteSize }];
    // A removed attachment keeps the name its block recorded, nothing more.
    return block.type === "file" && typeof block.fileName === "string" && block.fileName ? [{ name: block.fileName }] : [];
  });
}

function exportStatus(status: string): ChatExportMessageStatus {
  return CHAT_EXPORT_MESSAGE_STATUSES.includes(status as ChatExportMessageStatus)
    ? status as ChatExportMessageStatus
    : "complete";
}

function bySourceOrder(left: ChatExportSourceMessage, right: ChatExportSourceMessage): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

/**
 * The `chat` object of an `aiqsa.chat` document: every branch in depth-first
 * parent-before-child order, siblings oldest first, with export-local ids.
 * Durable follow-ups become ordinary turns between the request and the
 * answer, which keeps its own node and stays the active leaf. Tool, artifact
 * and attachment bytes, ids, token counts and errors never appear.
 */
export function chatExportDocumentChat(source: ChatExportSource): ChatExportDocumentChat {
  const children = new Map<string | null, ChatExportSourceMessage[]>();
  const keys = new Set(source.messages.map((message) => message.key));
  for (const message of source.messages) {
    // A parent outside the loaded rows cannot exist under the message foreign key.
    const parent = message.parentKey !== null && keys.has(message.parentKey) ? message.parentKey : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(message);
    children.set(parent, siblings);
  }
  for (const siblings of children.values()) siblings.sort(bySourceOrder);

  const output: ChatExportDocumentMessage[] = [];
  const exportIds = new Map<string, string>();
  const nextId = () => `m${output.length + 1}`;
  const stack: Array<{ message: ChatExportSourceMessage; parentId: string | null }> =
    [...(children.get(null) ?? [])].reverse().map((message) => ({ message, parentId: null }));
  while (stack.length > 0) {
    const { message, parentId: requestId } = stack.pop()!;
    if (exportIds.has(message.key)) continue;
    const model = message.provider && message.modelId ? { provider: message.provider, modelId: message.modelId } : undefined;
    let parentId = requestId;
    for (const entry of message.followups?.entries ?? []) {
      const entryDate = new Date(entry.createdAt);
      const createdAt = (Number.isFinite(entryDate.getTime()) ? entryDate : message.createdAt).toISOString();
      for (const turn of followupHistoryTurns([entry])) {
        const id = nextId();
        output.push({
          id,
          parentId,
          role: turn.role,
          createdAt,
          status: "complete",
          text: turn.text,
          ...(turn.role === "assistant" && model ? { model } : {})
        });
        parentId = id;
      }
    }
    const id = nextId();
    exportIds.set(message.key, id);
    const attachments = messageAttachments(message.content, source.attachments);
    output.push({
      id,
      parentId,
      role: message.role === "assistant" ? "assistant" : "user",
      createdAt: message.createdAt.toISOString(),
      status: exportStatus(message.status),
      text: chatExportText(message.content),
      ...(model ? { model } : {}),
      ...(attachments.length ? { attachments } : {})
    });
    const descendants = children.get(message.key) ?? [];
    for (let index = descendants.length - 1; index >= 0; index -= 1) {
      stack.push({ message: descendants[index]!, parentId: id });
    }
  }
  return {
    title: source.chat.title,
    createdAt: source.chat.createdAt.toISOString(),
    updatedAt: source.chat.updatedAt.toISOString(),
    archived: source.chat.archived,
    pinned: source.chat.pinned,
    activeLeafId: source.chat.activeLeafKey ? exportIds.get(source.chat.activeLeafKey) ?? null : null,
    messages: output
  };
}

export function chatExportDocument(source: ChatExportSource, exportedAt: Date): ChatExportDocument {
  return {
    format: CHAT_EXPORT_FORMAT,
    version: CHAT_EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    chat: chatExportDocumentChat(source)
  };
}

/** Root-to-leaf path of the active branch; empty without a reachable leaf. */
export function chatExportActiveBranch(source: ChatExportSource): ChatExportSourceMessage[] {
  const byKey = new Map(source.messages.map((message) => [message.key, message]));
  const path: ChatExportSourceMessage[] = [];
  const seen = new Set<string>();
  let cursor = source.chat.activeLeafKey;
  while (cursor) {
    const message = byKey.get(cursor);
    if (!message || seen.has(cursor)) return [];
    seen.add(cursor);
    path.push(message);
    cursor = message.parentKey;
  }
  return path.reverse();
}

/**
 * The readable Markdown of the active branch, as the chat shows it: a
 * stopped answer without text reads "Stopped.".
 */
export function chatExportActiveBranchMarkdown(source: ChatExportSource): string {
  return chatExportMarkdown(source.chat.title, chatExportActiveBranch(source).map((message) => ({
    content: message.status === "cancelled" ? chatExportText(message.content) || "Stopped." : message.content,
    role: message.role,
    ...(message.followups ? { followups: message.followups } : {})
  })));
}
