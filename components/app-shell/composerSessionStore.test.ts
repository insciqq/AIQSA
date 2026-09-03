import type { ComposerAttachment } from "@/components/app-shell/attachmentContracts";
import { resetComposerSessionStoreForTest } from "@/tests/support/appShellStores";
import { afterEach, describe, expect, it } from "vitest";
import {
  chatIdFromComposerSessionKey,
  composerSessionKey,
  composerSessionModeFromKey,
  emptyComposerSessionSnapshot,
  folderIdFromComposerSessionKey,
  projectComposerSessionKey,
  projectIdFromComposerSessionKey,
  selectActiveComposerSession,
  selectComposerSession,
  useComposerSessionStore
} from "./composerSessionStore";

function attachment(id: string): ComposerAttachment {
  return {
    fileName: `${id}.pdf`,
    id,
    kind: "pdf"
  };
}

function session(key: ReturnType<typeof composerSessionKey>) {
  return selectComposerSession(useComposerSessionStore.getState(), key);
}

describe("composer session store", () => {
  afterEach(() => {
    resetComposerSessionStoreForTest();
  });

  it("isolates saved chats, blank root, and blank folders behind explicit keys", () => {
    const root = composerSessionKey(null);
    const folder = composerSessionKey(null, "folder/one");
    const chatA = composerSessionKey("chat/a");
    const chatB = composerSessionKey("chat-b");

    expect(chatIdFromComposerSessionKey(chatA)).toBe("chat/a");
    expect(chatIdFromComposerSessionKey(folder)).toBeNull();
    expect(folderIdFromComposerSessionKey(folder)).toBe("folder/one");
    expect(folderIdFromComposerSessionKey(root)).toBeNull();

    const store = useComposerSessionStore.getState();
    store.setDraft("Root draft");
    store.activateSession(folder);
    store.setDraft("Folder draft");
    store.setAttachments([attachment("folder")]);
    store.activateSession(chatA);
    store.setDraft("Draft A");
    store.startEdit("message-a", "Edit A");
    store.activateSession(chatB);
    store.setDraft("Draft B");

    expect(session(root)).toMatchObject({ draft: "Root draft" });
    expect(session(folder)).toMatchObject({
      attachments: [attachment("folder")],
      draft: "Folder draft"
    });
    expect(session(chatA)).toMatchObject({
      draft: "Draft A",
      editingDraft: "Edit A",
      editingMessageId: "message-a"
    });
    expect(selectActiveComposerSession(useComposerSessionStore.getState())).toMatchObject({
      draft: "Draft B",
      editingMessageId: null
    });

    const missing = composerSessionKey("missing");
    expect(session(missing)).toBe(emptyComposerSessionSnapshot);
    expect(session(missing)).toBe(session(composerSessionKey("also-missing")));
  });

  it("keeps local Project blanks distinct from personal drafts and preserves their scope", () => {
    const personal = composerSessionKey(null);
    const projectRoot = projectComposerSessionKey("project/one");
    const projectFolder = projectComposerSessionKey("project/one", "folder/two");
    const otherProject = projectComposerSessionKey("project-two");
    const store = useComposerSessionStore.getState();

    expect(new Set([personal, projectRoot, projectFolder, otherProject]).size).toBe(4);
    expect(chatIdFromComposerSessionKey(projectRoot)).toBeNull();
    expect(projectIdFromComposerSessionKey(projectRoot)).toBe("project/one");
    expect(projectIdFromComposerSessionKey(projectFolder)).toBe("project/one");
    expect(projectIdFromComposerSessionKey(personal)).toBeNull();
    expect(folderIdFromComposerSessionKey(projectRoot)).toBeNull();
    expect(folderIdFromComposerSessionKey(projectFolder)).toBe("folder/two");
    expect(composerSessionModeFromKey(projectRoot)).toBe("NORMAL");

    store.setDraft("Personal draft");
    store.activateSession(projectRoot);
    store.setDraft("Shared draft");
    store.setAttachments([attachment("shared")]);
    store.activateSession(personal);

    expect(session(personal)).toMatchObject({ attachments: [], draft: "Personal draft" });
    expect(session(projectRoot)).toMatchObject({
      attachments: [attachment("shared")],
      draft: "Shared draft"
    });
  });

  it("keeps Normal, Memory-off, and Temporary drafts in distinct keyed sessions", () => {
    const normalRoot = composerSessionKey(null);
    const excludedRoot = composerSessionKey(null, null, "EXCLUDED");
    const temporaryRoot = composerSessionKey(null, null, "TEMPORARY");
    const normalFolder = composerSessionKey(null, "folder/one");
    const excludedFolder = composerSessionKey(null, "folder/one", "EXCLUDED");
    const temporaryFolder = composerSessionKey(null, "folder/one", "TEMPORARY");
    const store = useComposerSessionStore.getState();

    expect(new Set([
      normalRoot,
      excludedRoot,
      temporaryRoot,
      normalFolder,
      excludedFolder,
      temporaryFolder
    ]).size).toBe(6);
    expect(composerSessionModeFromKey(normalRoot)).toBe("NORMAL");
    expect(composerSessionModeFromKey(excludedRoot)).toBe("EXCLUDED");
    expect(composerSessionModeFromKey(excludedFolder)).toBe("EXCLUDED");
    expect(composerSessionModeFromKey(temporaryRoot)).toBe("TEMPORARY");
    expect(composerSessionModeFromKey(temporaryFolder)).toBe("TEMPORARY");
    expect(folderIdFromComposerSessionKey(temporaryFolder)).toBe("folder/one");
    expect(folderIdFromComposerSessionKey(excludedFolder)).toBe("folder/one");

    for (const [key, draft] of [
      [normalRoot, "Normal root"],
      [excludedRoot, "Memory-off root"],
      [temporaryRoot, "Temporary root"],
      [normalFolder, "Normal folder"],
      [excludedFolder, "Memory-off folder"],
      [temporaryFolder, "Temporary folder"]
    ] as const) {
      store.activateSession(key);
      store.setDraft(draft);
    }

    expect(session(normalRoot).draft).toBe("Normal root");
    expect(session(excludedRoot).draft).toBe("Memory-off root");
    expect(session(temporaryRoot).draft).toBe("Temporary root");
    expect(session(normalFolder).draft).toBe("Normal folder");
    expect(session(excludedFolder).draft).toBe("Memory-off folder");
    expect(session(temporaryFolder).draft).toBe("Temporary folder");
  });

  it("atomically owns send content across upload exclusion, transfer, failure, and newer work", () => {
    const source = composerSessionKey(null, "folder-a");
    const target = composerSessionKey("chat-created");
    const store = useComposerSessionStore.getState();
    store.activateSession(source);
    store.setDraft("First question");
    store.setAttachments([attachment("source")]);
    const upload = store.beginUpload(source)!;
    expect(store.beginSend(source)).toBeNull();
    expect(store.finishUpload(source, upload, null)).toBe(true);

    const send = store.beginSend(source)!;
    expect(send).toMatchObject({
      attachments: [attachment("source")],
      draft: "First question",
      sourceKey: source
    });
    expect(session(source)).toMatchObject({
      attachments: [],
      draft: "",
      pendingSend: expect.objectContaining({ generation: send.generation })
    });
    expect(store.beginUpload(source)).toBeNull();

    expect(store.transferSession(source, target)).toBe(true);
    expect(useComposerSessionStore.getState().activeSessionKey).toBe(target);
    expect(session(source)).toBe(emptyComposerSessionSnapshot);
    expect(store.finishSend(send, "failed", "send failed", false)).toBe(true);
    expect(session(target)).toMatchObject({
      attachments: [attachment("source")],
      draft: "First question",
      operationError: "send failed",
      operationErrorLive: false,
      operationErrorRetryable: true,
      pendingSend: null
    });
    expect(store.transferSession(source, target)).toBe(false);

    const retry = store.beginSend(target)!;
    store.setDraft("Newer question");
    store.setAttachments([attachment("newer")]);
    expect(store.finishSend(retry, "failed", "retry failed")).toBe(true);
    expect(session(target)).toMatchObject({
      attachments: [attachment("newer")],
      draft: "Newer question",
      operationError: "retry failed",
      operationErrorLive: true,
      operationErrorRetryable: false,
      pendingSend: null
    });

    const finalSend = store.beginSend(target)!;
    expect(store.finishSend(finalSend, "succeeded")).toBe(true);
    expect(session(target)).toMatchObject({ attachments: [], draft: "", operationError: null });
  });

  it("ignores late upload and edit writes after a source is removed and recreated", () => {
    const chat = composerSessionKey("chat-a");
    const store = useComposerSessionStore.getState();
    store.activateSession(chat);
    store.setDraft("Edit A");
    store.startEdit("message-a", "Edit A");
    const uploadGeneration = store.beginUpload(chat);
    const editToken = store.beginEdit(chat, "message-a");
    expect(uploadGeneration).not.toBeNull();
    expect(editToken).not.toBeNull();

    expect(store.removeSession(chat)).toBe(true);
    store.activateSession(chat);
    expect(store.appendUploadedAttachment(chat, uploadGeneration!, attachment("late"))).toBe(false);
    expect(store.finishUpload(chat, uploadGeneration!, "late failure")).toBe(false);
    expect(store.finishEdit(editToken!, null)).toBe(false);
    expect(store.updateSession(composerSessionKey("deleted"), { draft: "resurrected" })).toBe(false);
    expect(session(chat)).toEqual({
      attachments: [],
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
      pendingUploadGenerations: [],
      revision: 0
    });
  });

  it("does not restore a failed send once a durable run id exists", () => {
    const chat = composerSessionKey("chat-a");
    const store = useComposerSessionStore.getState();
    store.activateSession(chat);
    store.setDraft("Question accepted by the server");
    store.setAttachments([attachment("accepted")]);

    const send = store.beginSend(chat)!;
    expect(store.finishSend(send, "failed", "run failed", true, "run-accepted")).toBe(true);

    expect(session(chat)).toMatchObject({
      attachments: [],
      draft: "",
      operationError: null,
      operationErrorRetryable: false,
      pendingSend: null
    });
  });

  it("settles overlapping uploads once while the newest batch owns feedback", () => {
    const chat = composerSessionKey("chat-a");
    const store = useComposerSessionStore.getState();
    store.activateSession(chat);
    const first = store.beginUpload(chat)!;
    const second = store.beginUpload(chat)!;

    expect(store.appendUploadedAttachment(chat, first, attachment("first"))).toBe(true);
    expect(store.appendUploadedAttachment(chat, first, attachment("first"))).toBe(true);
    expect(store.appendUploadedAttachment(chat, second, attachment("second"))).toBe(true);
    expect(store.finishUpload(chat, second, "newest failed")).toBe(true);
    expect(session(chat)).toMatchObject({
      operationError: "newest failed",
      pendingUploadGenerations: [first]
    });

    expect(store.finishUpload(chat, first, null)).toBe(true);
    expect(store.finishUpload(chat, first, null)).toBe(false);
    expect(session(chat)).toMatchObject({
      attachments: [attachment("first"), attachment("second")],
      operationError: "newest failed",
      pendingUploadGenerations: []
    });
  });

  it("updates lifecycle state only in the source session and blocks send until ready", () => {
    const source = composerSessionKey("chat-a");
    const other = composerSessionKey("chat-b");
    const store = useComposerSessionStore.getState();
    store.activateSession(source);
    store.setDraft("Question");
    store.setAttachments([{ ...attachment("report"), status: "processing" }]);
    store.activateSession(other);
    store.setAttachments([attachment("other")]);

    expect(store.beginSend(source)).toBeNull();
    expect(store.updateUploadedAttachment(source, {
      ...attachment("report"),
      processingErrorCode: "parser_unavailable",
      status: "failed"
    })).toBe(true);
    expect(session(other).attachments).toEqual([attachment("other")]);
    expect(store.beginSend(source)).toBeNull();

    expect(store.updateUploadedAttachment(source, {
      ...attachment("report"),
      extractedText: "ready text",
      processingErrorCode: null,
      status: "ready"
    })).toBe(true);
    expect(store.beginSend(source)).toMatchObject({
      attachments: [expect.objectContaining({ id: "report", status: "ready" })],
      draft: "Question"
    });
    expect(store.updateUploadedAttachment(source, {
      ...attachment("report"),
      status: "failed"
    })).toBe(false);
  });

  it("owns one pending edit per source while other sessions keep independent send and edit work", () => {
    const chatA = composerSessionKey("chat-a");
    const chatB = composerSessionKey("chat-b");
    const store = useComposerSessionStore.getState();
    store.activateSession(chatA);
    store.setDraft("Composer A");
    store.startEdit("message-a", "Edit one");
    expect(store.beginEdit(chatA, "other-message")).toBeNull();

    const editA = store.beginEdit(chatA, "message-a")!;
    expect(store.beginEdit(chatA, "message-a")).toBeNull();
    expect(store.isEditCurrent(editA)).toBe(true);
    expect(session(chatA).pendingEdit).toEqual({
      editRevision: editA.editRevision,
      generation: editA.generation,
      messageId: "message-a"
    });

    store.startEdit("replacement-a", "Replacement edit");
    store.cancelEdit(chatA, "message-a");
    expect(session(chatA)).toMatchObject({
      draft: "Composer A",
      editingDraft: "Edit one",
      editingMessageId: "message-a",
      pendingEdit: expect.objectContaining({ generation: editA.generation })
    });

    store.setDraft("Newer draft");
    store.activateSession(chatB);
    store.setDraft("Question B");
    const sendB = store.beginSend(chatB)!;
    expect(sendB).toMatchObject({ draft: "Question B", sourceKey: chatB });
    expect(store.finishSend(sendB, "succeeded")).toBe(true);
    store.startEdit("message-b", "Edit B");
    const editB = store.beginEdit(chatB, "message-b")!;

    expect(store.finishEdit(editA, null)).toBe(true);
    expect(session(chatA)).toMatchObject({
      draft: "Newer draft",
      editingDraft: "",
      editingMessageId: null,
      pendingEdit: null
    });
    expect(store.finishEdit(editA, null)).toBe(false);
    expect(store.finishEdit(editB, null)).toBe(true);
    expect(session(chatB)).toMatchObject({
      draft: "",
      editingDraft: "",
      editingMessageId: null,
      pendingEdit: null
    });

    store.activateSession(chatA);
    store.setAttachments([attachment("kept")]);
    store.startEdit("message-a", "Re-edit A");
    const failedToken = store.beginEdit(chatA, "message-a")!;
    expect(store.finishEdit(failedToken, "edit failed")).toBe(true);
    expect(store.finishEdit(failedToken, null)).toBe(false);
    expect(session(chatA)).toMatchObject({
      attachments: [attachment("kept")],
      draft: "Newer draft",
      editingDraft: "Re-edit A",
      editingError: "edit failed",
      editingMessageId: "message-a",
      pendingEdit: null
    });

    const retryToken = store.beginEdit(chatA, "message-a")!;
    expect(store.finishEdit(retryToken, null)).toBe(true);
    expect(session(chatA)).toMatchObject({
      attachments: [attachment("kept")],
      draft: "Newer draft",
      editingDraft: "",
      editingError: null,
      editingMessageId: null,
      pendingEdit: null
    });

    store.startEdit("message-cancel", "Cancel me");
    store.cancelEdit(chatA, "wrong-message");
    expect(session(chatA).editingDraft).toBe("Cancel me");
    store.cancelEdit(chatA, "message-cancel");
    expect(session(chatA)).toMatchObject({
      attachments: [attachment("kept")],
      draft: "Newer draft",
      editingDraft: "",
      editingError: null,
      editingMessageId: null,
    });
  });

  it("keeps the exact composer draft and attachments untouched throughout editing", () => {
    const chat = composerSessionKey("chat-a");
    const store = useComposerSessionStore.getState();
    store.activateSession(chat);
    store.setDraft("Unsent question\nwith a second line");
    store.setAttachments([attachment("kept")]);

    store.startEdit("message-a", "Earlier message text");
    expect(session(chat)).toMatchObject({
      draft: "Unsent question\nwith a second line",
      editingDraft: "Earlier message text",
      editingMessageId: "message-a"
    });
    store.setEditingDraft("Rewritten earlier message");
    store.cancelEdit(chat, "message-a");

    expect(session(chat)).toMatchObject({
      attachments: [attachment("kept")],
      draft: "Unsent question\nwith a second line",
      editingDraft: "",
      editingError: null,
      editingMessageId: null
    });
  });
});
