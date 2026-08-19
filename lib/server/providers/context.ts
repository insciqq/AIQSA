import { createHash } from "node:crypto";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { SKILL_CONTEXT_PREVIEW_PLACEHOLDER } from "../skills/userContext";
import { KNOWLEDGE_EVIDENCE_PREVIEW_PLACEHOLDER } from "../knowledge/evidenceContext";
import type { ProviderConversationMessage, ProviderRunRequest } from "./types";

export type TextConversationMessage = {
  content: string;
  id: string;
  purpose?: "knowledge_evidence" | "skill_context";
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

export function textConversationForRequest(
  request: ProviderRunRequest,
  options: Readonly<{ redactSkillContext?: boolean }> = {}
): TextConversationMessage[] {
  return conversationMessagesForRequest(request)
    .map((message) => ({
      content: options.redactSkillContext && message.purpose === "skill_context"
        ? SKILL_CONTEXT_PREVIEW_PLACEHOLDER
        : options.redactSkillContext && message.purpose === "knowledge_evidence"
          ? KNOWLEDGE_EVIDENCE_PREVIEW_PLACEHOLDER
          : textFromConversationMessage(message),
      hasAttachmentContent: hasAttachmentContent(message),
      id: message.id,
      ...(message.purpose ? { purpose: message.purpose } : {}),
      role: message.role
    }))
    .filter((message) => message.content.trim() || (message.role === "user" && message.hasAttachmentContent))
    .map(({ hasAttachmentContent: _hasAttachmentContent, ...message }) => message);
}

export function conversationPreview(request: ProviderRunRequest) {
  return textConversationForRequest(request, { redactSkillContext: true }).map((message) => ({
    id: message.id,
    role: message.role,
    text: message.content.length > 240 ? `${message.content.slice(0, 237)}...` : message.content
  }));
}

export function providerPromptCacheKey(chatId: string): string {
  const digest = createHash("sha256").update(chatId).digest("hex").slice(0, 32);

  return `aiqsa-chat-${digest}`;
}
