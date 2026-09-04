import type { ComposerAttachment } from "@/components/app-shell/attachmentContracts";
import { create } from "zustand";

type StateUpdate<T> = T | ((current: T) => T);

const blankRootSessionKey = "blank:root" as const;
const blankFolderSessionPrefix = "blank:folder:";
const excludedRootSessionKey = "blank:excluded:root" as const;
const excludedFolderSessionPrefix = "blank:excluded:folder:";
const temporaryRootSessionKey = "blank:temporary:root" as const;
const temporaryFolderSessionPrefix = "blank:temporary:folder:";
const projectBlankSessionPrefix = "blank:project:";
const savedChatSessionPrefix = "chat:";

export type ComposerBlankMemoryMode = "EXCLUDED" | "NORMAL" | "TEMPORARY";

export type ComposerSessionKey =
  | typeof blankRootSessionKey
  | `blank:folder:${string}`
  | typeof excludedRootSessionKey
  | `blank:excluded:folder:${string}`
  | typeof temporaryRootSessionKey
  | `blank:temporary:folder:${string}`
  | `blank:project:${string}:root`
  | `blank:project:${string}:folder:${string}`
  | `chat:${string}`;

export type ComposerPendingEdit = {
  editRevision: number;
  generation: number;
  messageId: string;
};

export type ComposerSessionSnapshot = {
  attachments: ComposerAttachment[];
  draft: string;
  editGeneration: number;
  editRevision: number;
  editingDraft: string;
  editingError: string | null;
  editingMessageId: string | null;
  latestUploadGeneration: number;
  operationError: string | null;
  operationErrorLive: boolean;
  operationErrorRetryable: boolean;
  pendingEdit: ComposerPendingEdit | null;
  pendingSend: {
    attachments: ComposerAttachment[];
    clearedRevision: number;
    draft: string;
    generation: number;
  } | null;
  pendingUploadGenerations: number[];
  revision: number;
  /** Chat-scoped execution intent. For blank sessions this is committed with
   * the first send; saved-chat sessions mirror the canonical chat flag. */
  workspaceEnabled: boolean;
};

export type ComposerEditToken = ComposerPendingEdit & {
  sourceKey: ComposerSessionKey;
};

export type ComposerSendToken = {
  attachments: ComposerAttachment[];
  draft: string;
  generation: number;
  sourceKey: ComposerSessionKey;
  workspaceEnabled: boolean;
};

export type ComposerSendOutcome = "cancelled" | "failed" | "succeeded";

export type ComposerSendOptions = Readonly<{
  attachmentBlocksSend?(attachment: ComposerAttachment): boolean;
}>;

export type ComposerSessionPatch = Partial<
  Pick<
    ComposerSessionSnapshot,
    | "attachments"
    | "draft"
    | "editingDraft"
    | "editingError"
    | "editingMessageId"
    | "operationError"
    | "workspaceEnabled"
  >
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
  beginSend(key: ComposerSessionKey, options?: ComposerSendOptions): ComposerSendToken | null;
  beginUpload(key: ComposerSessionKey): number | null;
  cancelEdit(key: ComposerSessionKey, expectedMessageId?: string): void;
  editGenerationCounter: number;
  finishEdit(token: ComposerEditToken, error: string | null): boolean;
  finishSend(
    token: ComposerSendToken,
    outcome: ComposerSendOutcome,
    error?: string | null,
    operationErrorLive?: boolean,
    runId?: string | null
  ): boolean;
  finishUpload(key: ComposerSessionKey, generation: number, error: string | null): boolean;
  isEditCurrent(token: ComposerEditToken): boolean;
  removeSession(key: ComposerSessionKey): boolean;
  sendGenerationCounter: number;
  sessionsByKey: Partial<Record<ComposerSessionKey, ComposerSessionSnapshot>>;
  setAttachments(update: StateUpdate<ComposerAttachment[]>): void;
  setDraft(value: string): void;
  setEditingDraft(value: string): void;
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
  editGeneration: 0,
  editRevision: 0,
  editingDraft: "",
  editingError: null,
  editingMessageId: null,
  latestUploadGeneration: 0,
  operationError: null,
  operationErrorLive: true,
  operationErrorRetryable: false,
  pendingEdit: null,
  pendingSend: null,
  pendingUploadGenerations: emptyUploadGenerations,
  revision: 0,
  workspaceEnabled: false
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
  folderId: string | null = null,
  memoryMode: ComposerBlankMemoryMode = "NORMAL"
): ComposerSessionKey {
  if (chatId) {
    return `${savedChatSessionPrefix}${encodeURIComponent(chatId)}`;
  }

  if (memoryMode === "TEMPORARY") {
    return folderId
      ? `${temporaryFolderSessionPrefix}${encodeURIComponent(folderId)}`
      : temporaryRootSessionKey;
  }
  if (memoryMode === "EXCLUDED") {
    return folderId
      ? `${excludedFolderSessionPrefix}${encodeURIComponent(folderId)}`
      : excludedRootSessionKey;
  }
  return folderId ? `${blankFolderSessionPrefix}${encodeURIComponent(folderId)}` : blankRootSessionKey;
}

/**
 * A blank Project is local until first-send admission, but its draft and
 * attachments already belong to that Project. Keep it separate from every
 * personal blank composer so leaving the Project cannot leak either scope.
 */
export function projectComposerSessionKey(
  projectId: string,
  folderId: string | null = null
): ComposerSessionKey {
  const encodedProjectId = encodeURIComponent(projectId);
  return folderId
    ? `${projectBlankSessionPrefix}${encodedProjectId}:folder:${encodeURIComponent(folderId)}`
    : `${projectBlankSessionPrefix}${encodedProjectId}:root`;
}

export function projectIdFromComposerSessionKey(key: ComposerSessionKey): string | null {
  if (!key.startsWith(projectBlankSessionPrefix)) return null;
  const remainder = key.slice(projectBlankSessionPrefix.length);
  const boundary = remainder.endsWith(":root")
    ? remainder.length - ":root".length
    : remainder.indexOf(":folder:");
  return boundary >= 0 ? decodeKeySegment(remainder.slice(0, boundary)) : null;
}

export function composerSessionModeFromKey(key: ComposerSessionKey): ComposerBlankMemoryMode {
  if (key === temporaryRootSessionKey || key.startsWith(temporaryFolderSessionPrefix)) {
    return "TEMPORARY";
  }
  return key === excludedRootSessionKey || key.startsWith(excludedFolderSessionPrefix)
    ? "EXCLUDED"
    : "NORMAL";
}

export function chatIdFromComposerSessionKey(key: ComposerSessionKey): string | null {
  return key.startsWith(savedChatSessionPrefix)
    ? decodeKeySegment(key.slice(savedChatSessionPrefix.length))
    : null;
}

export function folderIdFromComposerSessionKey(key: ComposerSessionKey): string | null {
  if (key.startsWith(projectBlankSessionPrefix)) {
    const folderBoundary = key.indexOf(":folder:", projectBlankSessionPrefix.length);
    return folderBoundary >= 0
      ? decodeKeySegment(key.slice(folderBoundary + ":folder:".length))
      : null;
  }
  if (key.startsWith(temporaryFolderSessionPrefix)) {
    return decodeKeySegment(key.slice(temporaryFolderSessionPrefix.length));
  }
  if (key.startsWith(excludedFolderSessionPrefix)) {
    return decodeKeySegment(key.slice(excludedFolderSessionPrefix.length));
  }
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
  const editingDraftChanged =
    hasOwn(patch, "editingDraft") && patch.editingDraft !== current.editingDraft;
  const editingErrorChanged =
    hasOwn(patch, "editingError") && patch.editingError !== current.editingError;
  const editingMessageChanged =
    hasOwn(patch, "editingMessageId") && patch.editingMessageId !== current.editingMessageId;
  const errorPatched = hasOwn(patch, "operationError");
  const errorChanged = errorPatched && patch.operationError !== current.operationError;
  const retryabilityChanged = errorPatched && current.operationErrorRetryable;
  const workspaceChanged = hasOwn(patch, "workspaceEnabled") &&
    patch.workspaceEnabled !== current.workspaceEnabled;

  if (
    !attachmentsChanged &&
    !draftChanged &&
    !editingDraftChanged &&
    !editingErrorChanged &&
    !editingMessageChanged &&
    !errorChanged &&
    !retryabilityChanged &&
    !workspaceChanged
  ) {
    return current;
  }

  return {
    ...current,
    ...(attachmentsChanged ? { attachments: [...(patch.attachments ?? [])] } : {}),
    ...(draftChanged ? { draft: patch.draft ?? "" } : {}),
    ...(editingDraftChanged ? { editingDraft: patch.editingDraft ?? "" } : {}),
    ...(editingErrorChanged ? { editingError: patch.editingError ?? null } : {}),
    ...(editingMessageChanged ? { editingMessageId: patch.editingMessageId ?? null } : {}),
    ...(errorChanged ? { operationError: patch.operationError ?? null } : {}),
    ...(workspaceChanged ? { workspaceEnabled: patch.workspaceEnabled ?? false } : {}),
    ...(errorPatched ? { operationErrorLive: true, operationErrorRetryable: false } : {}),
    editRevision:
      current.editRevision + (editingDraftChanged || editingMessageChanged ? 1 : 0),
    revision: current.revision + (attachmentsChanged || draftChanged || workspaceChanged ? 1 : 0)
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
    if (
      !session ||
      session.pendingEdit ||
      session.editingMessageId !== messageId ||
      !session.editingDraft.trim()
    ) {
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
          editingError: null,
          pendingEdit
        }
      }
    });
    return {
      ...pendingEdit,
      sourceKey: key
    };
  },
  beginSend(key, options) {
    const state = get();
    const session = state.sessionsByKey[key];
    if (
      !session ||
      session.pendingSend ||
      session.pendingUploadGenerations.length > 0 ||
      session.editingMessageId ||
      session.attachments.some(
        options?.attachmentBlocksSend ??
          ((attachment) => attachment.status !== undefined && attachment.status !== "ready")
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
      sourceKey: key,
      workspaceEnabled: session.workspaceEnabled
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
          operationErrorRetryable: false,
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
          operationErrorRetryable: false,
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
    const contentChanged = Boolean(
      session.editingDraft || session.editingError || session.editingMessageId
    );
    set({
      editGenerationCounter: invalidationGeneration,
      sessionsByKey: {
        ...state.sessionsByKey,
        [key]: {
          ...session,
          editGeneration: invalidationGeneration,
          editRevision: session.editRevision + (contentChanged ? 1 : 0),
          editingDraft: "",
          editingError: null,
          editingMessageId: null,
          pendingEdit: null
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
            ? {
                editingError: error
              }
            : retireEdit
              ? {
                  editRevision: session.editRevision + 1,
                  editingDraft: "",
                  editingError: null,
                  editingMessageId: null,
                  pendingEdit: null
                }
              : {
                  editingError: null
                }),
          editGeneration: invalidationGeneration,
          pendingEdit: null
        }
      }
    });
    return true;
  },
  finishSend(token, outcome, error = null, operationErrorLive = true, runId = null) {
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

    const failedBeforeRun = outcome === "failed" && runId === null;
    const restore = failedBeforeRun && session.revision === pending.clearedRevision;
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
          operationError: failedBeforeRun ? error : null,
          operationErrorLive: failedBeforeRun ? operationErrorLive : true,
          operationErrorRetryable: restore && Boolean(error),
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
          ...(ownsFeedback
            ? {
                operationError,
                operationErrorLive: true,
                operationErrorRetryable: false
              }
            : {}),
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
  setEditingDraft(value) {
    const state = get();
    const session = state.sessionsByKey[state.activeSessionKey];
    if (!session?.editingMessageId || session.pendingEdit) {
      return;
    }
    get().updateSession(state.activeSessionKey, {
      editingDraft: value,
      editingError: null
    });
  },
  startEdit(messageId, draft) {
    const state = get();
    const session = state.sessionsByKey[state.activeSessionKey];
    if (!session || session.pendingEdit || session.pendingSend || session.editingMessageId) {
      return;
    }

    const next = patchedSession(session, {
      editingDraft: draft,
      editingError: null,
      editingMessageId: messageId
    });
    set({
      sessionsByKey: {
        ...state.sessionsByKey,
        [state.activeSessionKey]: next
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
