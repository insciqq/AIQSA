import { createHash } from "node:crypto";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import type { ProviderConversationMessage, ProviderRunRequest } from "./types";

export type TextConversationMessage = {
  content: string;
  id: string;
  role: "assistant" | "user";
};

export function textFromConversationMessage(message: ProviderConversationMessage): string {
  return textFromContentBlocks(message.content);
}

function hasAttachmentContent(message: ProviderConversationMessage): boolean {
  return message.content.blocks.some(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      "attachmentId" in block &&
      typeof block.attachmentId === "string"
  );
}

export function conversationMessagesForRequest(request: ProviderRunRequest): ProviderConversationMessage[] {
  const messages = request.context?.messages ?? [];

  if (messages.length === 0) {
    return [
      {
        content: request.content,
        id: "current-user-message",
        role: "user"
      }
    ];
  }

  return messages;
}

export function textConversationForRequest(request: ProviderRunRequest): TextConversationMessage[] {
  return conversationMessagesForRequest(request)
    .map((message) => ({
      content: textFromConversationMessage(message),
      hasAttachmentContent: hasAttachmentContent(message),
      id: message.id,
      role: message.role
    }))
    .filter((message) => message.content.trim() || (message.role === "user" && message.hasAttachmentContent))
    .map(({ hasAttachmentContent: _hasAttachmentContent, ...message }) => message);
}

export function mergeAdjacentTextMessages(messages: TextConversationMessage[]): TextConversationMessage[] {
  const merged: TextConversationMessage[] = [];

  for (const message of messages) {
    const previous = merged.at(-1);
    if (previous?.role === message.role) {
      previous.content = `${previous.content}\n\n${message.content}`;
      previous.id = `${previous.id},${message.id}`;
      continue;
    }

    merged.push({ ...message });
  }

  return merged;
}

export function conversationPreview(request: ProviderRunRequest) {
  return textConversationForRequest(request).map((message) => ({
    id: message.id,
    role: message.role,
    text: message.content.length > 240 ? `${message.content.slice(0, 237)}...` : message.content
  }));
}

export function providerPromptCacheKey(chatId: string): string {
  const digest = createHash("sha256").update(chatId).digest("hex").slice(0, 32);

  return `aiqsa-chat-${digest}`;
}
