import { normalizeThreadStatus, shellFetch } from "@/components/app-shell/shellApi";
import { errorMessage, responseErrorMessage } from "@/components/app-shell/shellFormatting";
import { textFromPersistedContent } from "@/components/app-shell/threadContent";
import {
  selectComposerSession,
  useComposerSessionStore,
  type ComposerSessionKey
} from "@/components/app-shell/composerSessionStore";
import { selectThreadSnapshot, useThreadStore } from "@/components/app-shell/threadStore";
import type { ChatDetail, ThreadMessage } from "@/components/app-shell/types";
import { decodeEditMessageResponse } from "@/lib/contracts/messages";

type MutableRef<T> = { current: T };

type MessageEditActionInput = {
  activeChatIdRef: MutableRef<string | null>;
  refreshActiveChat(
    chatId: string | null,
    options?: { preserveControls?: boolean; resumeRuns?: boolean }
  ): Promise<ChatDetail | null>;
  resetThreadToLatest(): void;
  sourceChatId: string;
  sourceSessionKey: ComposerSessionKey;
  activeChatStreaming: boolean;
};

export type CommittedEditedMessage = {
  id: string;
  role: string;
};

export async function editMessageBranchAction({
  activeChatIdRef,
  activeChatStreaming,
  refreshActiveChat,
  resetThreadToLatest,
  sourceChatId,
  sourceSessionKey
}: MessageEditActionInput): Promise<CommittedEditedMessage | null> {
  const sourceSession = selectComposerSession(
    useComposerSessionStore.getState(),
    sourceSessionKey
  );
  const text = sourceSession.editingDraft.trim();
  const editingMessageId = sourceSession.editingMessageId;
  if (!text || !editingMessageId || activeChatStreaming) {
    return null;
  }

  const operation = useComposerSessionStore
    .getState()
    .beginEdit(sourceSessionKey, editingMessageId);
  if (!operation) {
    return null;
  }

  let editedMessage: NonNullable<ReturnType<typeof decodeEditMessageResponse>>["message"];
  try {
    const response = await shellFetch(`/api/messages/${editingMessageId}`, {
      body: JSON.stringify({
        text
      }),
      headers: {
        "content-type": "application/json"
      },
      method: "PATCH"
    });

    if (!response.ok) {
      throw new Error(await responseErrorMessage(response, `edit_failed_${response.status}`));
    }

    const body = decodeEditMessageResponse(await response.json());
    if (!body || body.message.chatId !== sourceChatId) {
      throw new Error("edit_malformed");
    }
    editedMessage = body.message;
  } catch (error) {
    useComposerSessionStore.getState().finishEdit(operation, errorMessage(error));
    return null;
  }

  if (!useComposerSessionStore.getState().isEditCurrent(operation)) {
    return null;
  }

  let committed: CommittedEditedMessage | null = null;
  try {
    let refreshed: ChatDetail | null = null;
    try {
      refreshed = await refreshActiveChat(sourceChatId, { preserveControls: true });
    } catch {
      // The edit is already committed; the decoded response is the safe local fallback.
    }
    if (!refreshed && useComposerSessionStore.getState().isEditCurrent(operation)) {
      const message: ThreadMessage = {
        content: textFromPersistedContent(editedMessage.content) || text,
        id: editedMessage.id,
        modelId: editedMessage.modelId ?? undefined,
        parentMessageId: editedMessage.parentMessageId,
        provider: editedMessage.provider ?? undefined,
        role: editedMessage.role,
        status: normalizeThreadStatus(editedMessage.status)
      };
      const currentThread = selectThreadSnapshot(
        useThreadStore.getState(),
        sourceChatId
      );
      if (currentThread.messages.some((candidate) => candidate.id === message.id)) {
        useThreadStore.getState().checkoutBranch(sourceChatId, message.id);
      } else {
        useThreadStore.getState().appendMessage(sourceChatId, message, { activate: true });
      }
    }
  } finally {
    const settled = useComposerSessionStore.getState().finishEdit(operation, null);
    if (settled) {
      committed = { id: editedMessage.id, role: editedMessage.role };
    }
    if (
      settled &&
      activeChatIdRef.current === sourceChatId &&
      useComposerSessionStore.getState().activeSessionKey === sourceSessionKey
    ) {
      resetThreadToLatest();
    }
  }

  return committed;
}
