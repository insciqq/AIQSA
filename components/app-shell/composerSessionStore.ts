import type { ComposerAttachment } from "@/components/chat/Composer";
import { create } from "zustand";

type StateUpdate<T> = T | ((current: T) => T);

const blankRootSessionKey = "blank:root" as const;
const blankFolderSessionPrefix = "blank:folder:";
const savedChatSessionPrefix = "chat:";

export type ComposerSessionKey =
  | typeof blankRootSessionKey
  | `blank:folder:${string}`
  | `chat:${string}`;

export type ComposerPendingEdit = {
  editRevision: number;
  generation: number;
  messageId: string;
};

export type ComposerSessionSnapshot = {
  attachments: ComposerAttachment[];
  draft: string;
  draftBeforeEdit: string | null;
  editGeneration: number;
  editRevision: number;
  editingMessageId: string | null;
  latestUploadGeneration: number;
  operationError: string | null;
  operationErrorLive: boolean;
  pendingEdit: ComposerPendingEdit | null;
  pendingSend: {
    attachments: ComposerAttachment[];
    clearedRevision: number;
    draft: string;
    generation: number;
  } | null;
  pendingUploadGenerations: number[];
  revision: number;
};

export type ComposerEditToken = ComposerPendingEdit & {
  sourceKey: ComposerSessionKey;
};

export type ComposerSendToken = {
  attachments: ComposerAttachment[];
  draft: string;
  generation: number;
  sourceKey: ComposerSessionKey;
};

export type ComposerSendOutcome = "cancelled" | "failed" | "succeeded";

export type ComposerSessionPatch = Partial<
  Pick<ComposerSessionSnapshot, "attachments" | "draft" | "editingMessageId" | "operationError">
>;

type ComposerSessionPatchUpdate =
  | ComposerSessionPatch
  | ((current: ComposerSessionSnapshot) => ComposerSessionPatch);

type ComposerSessionStore = {
  activeSessionKey: ComposerSessionKey;
  activateSession(key: ComposerSessionKey): void;
  appendUploadedAttachment(
    key: ComposerSessionKey,
    generation: number,
    attachment: ComposerAttachment
  ): boolean;
  beginEdit(key: ComposerSessionKey, messageId: string): ComposerEditToken | null;
  beginSend(key: ComposerSessionKey): ComposerSendToken | null;
  beginUpload(key: ComposerSessionKey): number | null;
  cancelEdit(key: ComposerSessionKey, expectedMessageId?: string): void;
  editGenerationCounter: number;
  finishEdit(token: ComposerEditToken, error: string | null): boolean;
  finishSend(
    token: ComposerSendToken,
    outcome: ComposerSendOutcome,
    error?: string | null,
    operationErrorLive?: boolean
  ): boolean;
  finishUpload(key: ComposerSessionKey, generation: number, error: string | null): boolean;
  isEditCurrent(token: ComposerEditToken): boolean;
  removeSession(key: ComposerSessionKey): boolean;
  sendGenerationCounter: number;
  sessionsByKey: Partial<Record<ComposerSessionKey, ComposerSessionSnapshot>>;
  setAttachments(update: StateUpdate<ComposerAttachment[]>): void;
  setDraft(value: string): void;
  setEditingMessageId(value: string | null): void;
  startEdit(messageId: string, draft: string): void;
  transferSession(sourceKey: ComposerSessionKey, targetKey: ComposerSessionKey): boolean;
  updateUploadedAttachment(key: ComposerSessionKey, attachment: ComposerAttachment): boolean;
  updateSession(
    key: ComposerSessionKey,
    update: ComposerSessionPatchUpdate
  ): boolean;
  uploadGenerationCounter: number;
};

const emptyAttachments = Object.freeze([]) as unknown as ComposerAttachment[];
const emptyUploadGenerations = Object.freeze([]) as unknown as number[];

export const emptyComposerSessionSnapshot = Object.freeze({
  attachments: emptyAttachments,
  draft: "",
  draftBeforeEdit: null,
  editGeneration: 0,
  editRevision: 0,
  editingMessageId: null,
  latestUploadGeneration: 0,
  operationError: null,
  operationErrorLive: true,
  pendingEdit: null,
  pendingSend: null,
  pendingUploadGenerations: emptyUploadGenerations,
  revision: 0
}) as ComposerSessionSnapshot;

function newSession(): ComposerSessionSnapshot {
  return {
    ...emptyComposerSessionSnapshot,
    attachments: [],
    pendingUploadGenerations: []
  };
}

function decodeKeySegment(value: string): string | null {
  try {
    return decodeURIComponent(value) || null;
  } catch {
    return null;
  }
}

export function composerSessionKey(
  chatId: string | null,
  folderId: string | null = null
): ComposerSessionKey {
  if (chatId) {
    return `${savedChatSessionPrefix}${encodeURIComponent(chatId)}`;
  }

  return folderId
    ? `${blankFolderSessionPrefix}${encodeURIComponent(folderId)}`
    : blankRootSessionKey;
}

export function chatIdFromComposerSessionKey(key: ComposerSessionKey): string | null {
  return key.startsWith(savedChatSessionPrefix)
    ? decodeKeySegment(key.slice(savedChatSessionPrefix.length))
    : null;
}

export function folderIdFromComposerSessionKey(key: ComposerSessionKey): string | null {
  return key.startsWith(blankFolderSessionPrefix)
    ? decodeKeySegment(key.slice(blankFolderSessionPrefix.length))
    : null;
}

function hasOwn<Key extends PropertyKey>(value: object, key: Key): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function patchedSession(
  current: ComposerSessionSnapshot,
  patch: ComposerSessionPatch
): ComposerSessionSnapshot {
  const attachmentsChanged =
    hasOwn(patch, "attachments") && patch.attachments !== current.attachments;
  const draftChanged = hasOwn(patch, "draft") && patch.draft !== current.draft;
  const editChanged =
    hasOwn(patch, "editingMessageId") && patch.editingMessageId !== current.editingMessageId;
  const errorChanged =
    hasOwn(patch, "operationError") && patch.operationError !== current.operationError;

  if (!attachmentsChanged && !draftChanged && !editChanged && !errorChanged) {
    return current;
  }

  return {
    ...current,
    ...(attachmentsChanged ? { attachments: [...(patch.attachments ?? [])] } : {}),
    ...(draftChanged ? { draft: patch.draft ?? "" } : {}),
    ...(editChanged ? { editingMessageId: patch.editingMessageId ?? null } : {}),
    ...(errorChanged ? { operationError: patch.operationError ?? null } : {}),
    ...(errorChanged ? { operationErrorLive: true } : {}),
    editRevision: current.editRevision + (draftChanged || editChanged ? 1 : 0),
    revision: current.revision + (attachmentsChanged || draftChanged || editChanged ? 1 : 0)
  };
}

function editOperationIsCurrent(
  session: ComposerSessionSnapshot | undefined,
  token: ComposerEditToken
): boolean {
  const pendingEdit = session?.pendingEdit;
  return Boolean(
    pendingEdit &&
      session.editGeneration === token.generation &&
      pendingEdit.generation === token.generation &&
      pendingEdit.messageId === token.messageId &&
      pendingEdit.editRevision === token.editRevision
  );
}

const initialSessionState = () => ({
  activeSessionKey: blankRootSessionKey as ComposerSessionKey,
  editGenerationCounter: 0,
  sendGenerationCounter: 0,
  sessionsByKey: {
    [blankRootSessionKey]: newSession()
  } as Partial<Record<ComposerSessionKey, ComposerSessionSnapshot>>,
  uploadGenerationCounter: 0
});

export const useComposerSessionStore = create<ComposerSessionStore>((set, get) => ({
  ...initialSessionState(),
  activateSession(key) {
    const state = get();
    set({
      activeSessionKey: key,
      sessionsByKey: state.sessionsByKey[key]
        ? state.sessionsByKey
        : { ...state.sessionsByKey, [key]: newSession() }
    });
  },
  appendUploadedAttachment(key, generation, attachment) {
    const state = get();
    const session = state.sessionsByKey[key];
    if (!session?.pendingUploadGenerations.includes(generation)) {
      return false;
    }

    if (session.attachments.some((candidate) => candidate.id === attachment.id)) {
      return true;
    }

    set({
      sessionsByKey: {
        ...state.sessionsByKey,
        [key]: {
          ...session,
          attachments: [...session.attachments, attachment],
          revision: session.revision + 1
        }
      }
    });
    return true;
  },
  beginEdit(key, messageId) {
    const state = get();
    const session = state.sessionsByKey[key];
    if (!session || session.pendingEdit || session.editingMessageId !== messageId) {
      return null;
    }

    const generation = state.editGenerationCounter + 1;
    const pendingEdit: ComposerPendingEdit = {
      editRevision: session.editRevision,
      generation,
      messageId
    };
    set({
      editGenerationCounter: generation,
      sessionsByKey: {
        ...state.sessionsByKey,
        [key]: {
          ...session,
          editGeneration: generation,
          operationError: null,
          operationErrorLive: true,
          pendingEdit
        }
      }
    });
    return {
      ...pendingEdit,
      sourceKey: key
    };
  },
  beginSend(key) {
    const state = get();
    const session = state.sessionsByKey[key];
    if (
      !session ||
      session.pendingSend ||
      session.pendingUploadGenerations.length > 0 ||
      session.editingMessageId ||
      session.attachments.some(
        (attachment) => attachment.status !== undefined && attachment.status !== "ready"
      ) ||
      (!session.draft.trim() && session.attachments.length === 0)
    ) {
      return null;
    }

    const generation = state.sendGenerationCounter + 1;
    const clearedRevision = session.revision + 1;
    const token: ComposerSendToken = {
      attachments: [...session.attachments],
      draft: session.draft,
      generation,
      sourceKey: key
    };
    set({
      sendGenerationCounter: generation,
      sessionsByKey: {
        ...state.sessionsByKey,
        [key]: {
          ...session,
          attachments: [],
          draft: "",
          editRevision: session.editRevision + (session.draft ? 1 : 0),
          operationError: null,
          operationErrorLive: true,
          pendingSend: {
            attachments: [...session.attachments],
            clearedRevision,
            draft: session.draft,
            generation
          },
          revision: clearedRevision
        }
      }
    });
    return token;
  },
  beginUpload(key) {
    const state = get();
    const session = state.sessionsByKey[key];
    if (!session || session.pendingSend) {
      return null;
    }

    const generation = state.uploadGenerationCounter + 1;
    set({
      sessionsByKey: {
        ...state.sessionsByKey,
        [key]: {
          ...session,
          latestUploadGeneration: generation,
          operationError: null,
          operationErrorLive: true,
          pendingUploadGenerations: [...session.pendingUploadGenerations, generation]
        }
      },
      uploadGenerationCounter: generation
    });
    return generation;
  },
  cancelEdit(key, expectedMessageId) {
    const state = get();
    const session = state.sessionsByKey[key];
    if (
      !session ||
      session.pendingEdit ||
      (expectedMessageId !== undefined && session.editingMessageId !== expectedMessageId)
    ) {
      return;
    }

    const invalidationGeneration = state.editGenerationCounter + 1;
    const restoredDraft = session.draftBeforeEdit ?? "";
    const contentChanged =
      session.draft !== restoredDraft || Boolean(session.editingMessageId);
    set({
      editGenerationCounter: invalidationGeneration,
      sessionsByKey: {
        ...state.sessionsByKey,
        [key]: {
          ...session,
          draft: restoredDraft,
          draftBeforeEdit: null,
          editGeneration: invalidationGeneration,
          editRevision: session.editRevision + (contentChanged ? 1 : 0),
          editingMessageId: null,
          operationError: null,
          operationErrorLive: true,
          revision: session.revision + (contentChanged ? 1 : 0)
        }
      }
    });
  },
  finishEdit(token, error) {
    const state = get();
    const session = state.sessionsByKey[token.sourceKey];
    if (!session || !editOperationIsCurrent(session, token)) {
      return false;
    }

    const invalidationGeneration = state.editGenerationCounter + 1;
    const retireEdit =
      !error &&
      session.editingMessageId === token.messageId &&
      session.editRevision === token.editRevision;
    set({
      editGenerationCounter: invalidationGeneration,
      sessionsByKey: {
        ...state.sessionsByKey,
        [token.sourceKey]: {
          ...session,
          ...(error
            ? { operationError: error, operationErrorLive: true }
            : retireEdit
              ? {
                  draft: "",
                  draftBeforeEdit: null,
                  editRevision: session.editRevision + 1,
                  editingMessageId: null,
                  operationError: null,
                  operationErrorLive: true,
                  revision: session.revision + 1
                }
              : { operationError: null, operationErrorLive: true }),
          editGeneration: invalidationGeneration,
          pendingEdit: null
        }
      }
    });
    return true;
  },
  finishSend(token, outcome, error = null, operationErrorLive = true) {
    const state = get();
    const sourceSession = state.sessionsByKey[token.sourceKey];
    const key =
      sourceSession?.pendingSend?.generation === token.generation
        ? token.sourceKey
        : (Object.keys(state.sessionsByKey) as ComposerSessionKey[]).find(
            (candidate) =>
              state.sessionsByKey[candidate]?.pendingSend?.generation === token.generation
          );
    if (!key) {
      return false;
    }

    const session = state.sessionsByKey[key];
    const pending = session?.pendingSend;
    if (!session || !pending || pending.generation !== token.generation) {
      return false;
    }

    const restore = outcome === "failed" && session.revision === pending.clearedRevision;
    set({
      sessionsByKey: {
        ...state.sessionsByKey,
        [key]: {
          ...session,
          ...(restore
            ? {
                attachments: [...pending.attachments],
                draft: pending.draft,
                editRevision: session.editRevision + (pending.draft ? 1 : 0),
                revision: session.revision + 1
              }
            : {}),
          operationError: outcome === "failed" ? error : null,
          operationErrorLive: outcome === "failed" ? operationErrorLive : true,
          pendingSend: null
        }
      }
    });
    return true;
  },
  finishUpload(key, generation, error) {
    const state = get();
    const session = state.sessionsByKey[key];
    if (!session?.pendingUploadGenerations.includes(generation)) {
      return false;
    }

    const ownsFeedback = generation === session.latestUploadGeneration;
    const operationError = !ownsFeedback
      ? session.operationError
      : error && session.operationError
        ? `${session.operationError} ${error}`
        : error ?? session.operationError;

    set({
      sessionsByKey: {
        ...state.sessionsByKey,
        [key]: {
          ...session,
          ...(ownsFeedback ? { operationError, operationErrorLive: true } : {}),
          pendingUploadGenerations: session.pendingUploadGenerations.filter(
            (candidate) => candidate !== generation
          )
        }
      }
    });
    return true;
  },
  isEditCurrent(token) {
    return editOperationIsCurrent(get().sessionsByKey[token.sourceKey], token);
  },
  removeSession(key) {
    const state = get();
    if (!state.sessionsByKey[key]) {
      return false;
    }

    const sessionsByKey = { ...state.sessionsByKey };
    delete sessionsByKey[key];
    const nextActiveKey =
      state.activeSessionKey === key ? blankRootSessionKey : state.activeSessionKey;
    if (!sessionsByKey[nextActiveKey]) {
      sessionsByKey[nextActiveKey] = newSession();
    }
    set({ activeSessionKey: nextActiveKey, sessionsByKey });
    return true;
  },
  setAttachments(update) {
    const state = get();
    const session = state.sessionsByKey[state.activeSessionKey];
    if (!session) {
      return;
    }
    get().updateSession(state.activeSessionKey, {
      attachments: typeof update === "function" ? update(session.attachments) : update
    });
  },
  setDraft(value) {
    get().updateSession(get().activeSessionKey, { draft: value });
  },
  setEditingMessageId(value) {
    const state = get();
    if (state.sessionsByKey[state.activeSessionKey]?.pendingEdit) {
      return;
    }
    get().updateSession(state.activeSessionKey, { editingMessageId: value });
  },
  startEdit(messageId, draft) {
    const state = get();
    const session = state.sessionsByKey[state.activeSessionKey];
    if (!session || session.pendingEdit) {
      return;
    }

    const next = patchedSession(session, {
      draft,
      editingMessageId: messageId,
      operationError: null
    });
    set({
      sessionsByKey: {
        ...state.sessionsByKey,
        [state.activeSessionKey]: {
          ...next,
          draftBeforeEdit:
            session.editingMessageId === null ? session.draft : session.draftBeforeEdit
        }
      }
    });
  },
  transferSession(sourceKey, targetKey) {
    const state = get();
    const source = state.sessionsByKey[sourceKey];
    if (!source || source.pendingUploadGenerations.length > 0) {
      return false;
    }
    if (sourceKey === targetKey) {
      return true;
    }

    const sessionsByKey = { ...state.sessionsByKey };
    delete sessionsByKey[sourceKey];
    sessionsByKey[targetKey] = {
      ...source,
      attachments: [...source.attachments],
      pendingEdit: source.pendingEdit ? { ...source.pendingEdit } : null,
      pendingSend: source.pendingSend
        ? {
            ...source.pendingSend,
            attachments: [...source.pendingSend.attachments]
          }
        : null,
      pendingUploadGenerations: [...source.pendingUploadGenerations]
    };
    set({
      activeSessionKey: state.activeSessionKey === sourceKey ? targetKey : state.activeSessionKey,
      sessionsByKey
    });
    return true;
  },
  updateUploadedAttachment(key, attachment) {
    const state = get();
    const session = state.sessionsByKey[key];
    if (!session || session.pendingSend) return false;
    const index = session.attachments.findIndex((candidate) => candidate.id === attachment.id);
    if (index < 0) return false;
    const attachments = [...session.attachments];
    attachments[index] = attachment;
    set({
      sessionsByKey: {
        ...state.sessionsByKey,
        [key]: {
          ...session,
          attachments,
          revision: session.revision + 1
        }
      }
    });
    return true;
  },
  updateSession(key, update) {
    const state = get();
    const session = state.sessionsByKey[key];
    if (!session) {
      return false;
    }

    const patch = typeof update === "function" ? update(session) : update;
    const next = patchedSession(session, patch);
    if (next === session) {
      return true;
    }
    set({ sessionsByKey: { ...state.sessionsByKey, [key]: next } });
    return true;
  }
}));

export function selectComposerSession(
  state: Pick<ComposerSessionStore, "sessionsByKey">,
  key: ComposerSessionKey
): ComposerSessionSnapshot {
  return state.sessionsByKey[key] ?? emptyComposerSessionSnapshot;
}

export function selectActiveComposerSession(
  state: Pick<ComposerSessionStore, "activeSessionKey" | "sessionsByKey">
): ComposerSessionSnapshot {
  return selectComposerSession(state, state.activeSessionKey);
}

export function resetComposerSessionStoreForTest() {
  useComposerSessionStore.setState(initialSessionState());
}
