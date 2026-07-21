import type { ComposerAttachment } from "@/components/chat/Composer";
import { afterEach, describe, expect, it } from "vitest";
import {
  chatIdFromComposerSessionKey,
  composerSessionKey,
  emptyComposerSessionSnapshot,
  folderIdFromComposerSessionKey,
  resetComposerSessionStoreForTest,
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
    store.setEditingMessageId("message-a");
    store.activateSession(chatB);
    store.setDraft("Draft B");

    expect(session(root)).toMatchObject({ draft: "Root draft" });
    expect(session(folder)).toMatchObject({
      attachments: [attachment("folder")],
      draft: "Folder draft"
    });
    expect(session(chatA)).toMatchObject({
      draft: "Draft A",
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
      draftBeforeEdit: null,
      pendingSend: expect.objectContaining({ generation: send.generation })
    });
    expect(store.beginUpload(source)).toBeNull();

    expect(store.transferSession(source, target)).toBe(true);
    expect(useComposerSessionStore.getState().activeSessionKey).toBe(target);
    expect(session(source)).toBe(emptyComposerSessionSnapshot);
    expect(store.finishSend(send, "failed", "send failed")).toBe(true);
    expect(session(target)).toMatchObject({
      attachments: [attachment("source")],
      draft: "First question",
      operationError: "send failed",
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
    store.setEditingMessageId("message-a");
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
      draftBeforeEdit: null,
      editGeneration: 0,
      editRevision: 0,
      editingMessageId: null,
      latestUploadGeneration: 0,
      operationError: null,
      pendingEdit: null,
      pendingSend: null,
      pendingUploadGenerations: [],
      revision: 0
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

  it("owns one pending edit per source while other sessions keep independent send and edit work", () => {
    const chatA = composerSessionKey("chat-a");
    const chatB = composerSessionKey("chat-b");
    const store = useComposerSessionStore.getState();
    store.activateSession(chatA);
    store.setDraft("Edit one");
    store.setEditingMessageId("message-a");
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
      draft: "Edit one",
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
      editingMessageId: "message-a",
      pendingEdit: null
    });
    expect(store.finishEdit(editA, null)).toBe(false);
    expect(store.finishEdit(editB, null)).toBe(true);
    expect(session(chatB)).toMatchObject({
      draft: "",
      editingMessageId: null,
      pendingEdit: null
    });

    store.activateSession(chatA);
    store.setAttachments([attachment("kept")]);
    const failedToken = store.beginEdit(chatA, "message-a")!;
    expect(store.finishEdit(failedToken, "edit failed")).toBe(true);
    expect(store.finishEdit(failedToken, null)).toBe(false);
    expect(session(chatA)).toMatchObject({
      attachments: [attachment("kept")],
      draft: "Newer draft",
      editingMessageId: "message-a",
      operationError: "edit failed",
      pendingEdit: null
    });

    const retryToken = store.beginEdit(chatA, "message-a")!;
    expect(store.finishEdit(retryToken, null)).toBe(true);
    expect(session(chatA)).toMatchObject({
      attachments: [attachment("kept")],
      draft: "",
      editingMessageId: null,
      operationError: null,
      pendingEdit: null
    });

    store.startEdit("message-cancel", "Cancel me");
    store.cancelEdit(chatA, "wrong-message");
    expect(session(chatA).draft).toBe("Cancel me");
    store.cancelEdit(chatA, "message-cancel");
    expect(session(chatA)).toMatchObject({
      attachments: [attachment("kept")],
      draft: "",
      editingMessageId: null,
      operationError: null
    });
  });

  it("restores the exact pre-edit draft on cancel without changing attachments", () => {
    const chat = composerSessionKey("chat-a");
    const store = useComposerSessionStore.getState();
    store.activateSession(chat);
    store.setDraft("Unsent question\nwith a second line");
    store.setAttachments([attachment("kept")]);

    store.startEdit("message-a", "Earlier message text");
    expect(session(chat)).toMatchObject({
      draft: "Earlier message text",
      draftBeforeEdit: "Unsent question\nwith a second line",
      editingMessageId: "message-a"
    });
    store.cancelEdit(chat, "message-a");

    expect(session(chat)).toMatchObject({
      attachments: [attachment("kept")],
      draft: "Unsent question\nwith a second line",
      draftBeforeEdit: null,
      editingMessageId: null
    });
  });
});
