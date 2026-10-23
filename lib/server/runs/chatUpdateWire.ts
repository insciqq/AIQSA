import type { ChatUpdateDataWire } from "../../contracts/chats";
import { UNAVAILABLE_CHAT_WORKSPACE_STATE } from "../../contracts/workspace";
import type { ModelRunChatUpdateData } from "../../domain/modelRunEvents";
import type { RunChatUpdateRecord } from "./runRepositoryContract";

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** The `chat_update` event a run sends: the chat row and the messages its answer changed. */
export function serializeChatUpdate(
  update: RunChatUpdateRecord
): ModelRunChatUpdateData {
  return {
    chat: {
      activeLeafMessageId: update.chat.activeLeafMessageId,
      contextStats: update.chat.contextStats,
      createdAt: iso(update.chat.createdAt),
      defaultModelId: update.chat.defaultModelId,
      defaultProvider: update.chat.defaultProvider,
      folderId: update.chat.folderId,
      id: update.chat.id,
      messageCount: update.chat.messageCount,
      pinned: update.chat.pinned,
      title: update.chat.title,
      ...(update.chat.titlePending ? { titlePending: true } : {}),
      updatedAt: iso(update.chat.updatedAt),
      usageStats: update.chat.usageStats ?? null,
      workspace: update.chat.workspace ?? UNAVAILABLE_CHAT_WORKSPACE_STATE
    },
    messages: update.messages.map((message) => ({
      ...(message.followups ? { followups: message.followups } : {}),
      artifactSummary: message.artifactSummary ?? null,
      assistantIdentity: message.assistantIdentity ?? null,
      citationMessageId: message.citationMessageId ?? null,
      content: message.content,
      createdAt: iso(message.createdAt),
      errorMessage: message.errorMessage ?? null,
      id: message.id,
      modelId: message.modelId,
      modelRunId: message.modelRunId ?? null,
      parentMessageId: message.parentMessageId,
      provider: message.provider,
      role: message.role,
      status: message.status,
      ...(message.systemTurnKind ? { systemTurnKind: message.systemTurnKind } : {}),
      ...(message.answerReview ? { answerReview: message.answerReview } : {}),
      ...(message.pdfPreparation ? { pdfPreparation: message.pdfPreparation } : {}),
      toolActivity: message.toolActivity ?? null,
      workspaceActivity: message.workspaceActivity ?? null
    }))
  } satisfies ChatUpdateDataWire;
}
