import { afterEach, describe, expect, it } from "vitest";
import { reconcileCurrentComposerAttachments } from "./attachmentReconciliation";
import { resetComposerControlStoreForTest, useComposerControlStore } from "./composerControlStore";
import {
  composerSessionKey,
  resetComposerSessionStoreForTest,
  selectComposerSession,
  useComposerSessionStore
} from "./composerSessionStore";
import type { CatalogModel } from "./types";

const textOnlyModel: CatalogModel = {
  capabilities: {
    background: false,
    documentInputMode: "none",
    imageInput: false,
    nativeWebSearch: false,
    openRouterPerplexitySearch: false,
    reasoning: false,
    streaming: true
  },
  contextWindow: 4096,
  defaultParams: {},
  displayName: "Text model",
  modelId: "text-model",
  parameterControls: {
    background: { defaultValue: false, supported: false },
    maxOutputTokens: { defaultValue: 1024, maxValue: 4096 },
    reasoningEffort: { defaultValue: "none", options: ["none"], supported: false },
    stream: { defaultValue: true, supported: true },
    temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
  },
  provider: "test",
  searchStrategyIds: ["search-disabled"]
};

describe("attachment reconciliation", () => {
  afterEach(() => {
    resetComposerControlStoreForTest();
    resetComposerSessionStoreForTest();
  });

  it("never writes rendered session A attachments into newly active session B", () => {
    const sessionA = composerSessionKey("chat-a");
    const sessionB = composerSessionKey("chat-b");
    const store = useComposerSessionStore.getState();
    useComposerControlStore.setState({
      selectedModelId: textOnlyModel.modelId,
      selectedProvider: textOnlyModel.provider
    });
    store.activateSession(sessionA);
    store.setAttachments([{ fileName: "paper.pdf", id: "pdf-a", kind: "pdf" }]);
    store.activateSession(sessionB);
    store.setAttachments([{ fileName: "notes.txt", id: "text-b", kind: "document" }]);

    expect(reconcileCurrentComposerAttachments(sessionA, textOnlyModel)).toBe(false);
    expect(selectComposerSession(useComposerSessionStore.getState(), sessionA).attachments).toEqual([
      { fileName: "paper.pdf", id: "pdf-a", kind: "pdf" }
    ]);
    expect(selectComposerSession(useComposerSessionStore.getState(), sessionB).attachments).toEqual([
      { fileName: "notes.txt", id: "text-b", kind: "document" }
    ]);
  });

  it("defers until upload settlement, then preserves the late supported file and removal feedback", () => {
    const sessionA = composerSessionKey("chat-a");
    const store = useComposerSessionStore.getState();
    useComposerControlStore.setState({
      selectedModelId: textOnlyModel.modelId,
      selectedProvider: textOnlyModel.provider
    });
    store.activateSession(sessionA);
    store.setAttachments([{ fileName: "paper.pdf", id: "pdf-a", kind: "pdf" }]);
    const uploadGeneration = store.beginUpload(sessionA)!;
    store.appendUploadedAttachment(sessionA, uploadGeneration, {
      fileName: "late-notes.txt",
      id: "text-late",
      kind: "document"
    });

    expect(reconcileCurrentComposerAttachments(sessionA, textOnlyModel)).toBe(false);
    expect(store.finishUpload(sessionA, uploadGeneration, null)).toBe(true);
    expect(reconcileCurrentComposerAttachments(sessionA, textOnlyModel)).toBe(true);
    expect(selectComposerSession(useComposerSessionStore.getState(), sessionA)).toMatchObject({
      attachments: [{ fileName: "late-notes.txt", id: "text-late", kind: "document" }],
      operationError: expect.stringContaining("paper.pdf")
    });
  });
});
