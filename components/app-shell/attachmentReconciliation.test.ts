import { afterEach, describe, expect, it } from "vitest";
import {
  resetComposerControlStoreForTest,
  resetComposerSessionStoreForTest
} from "@/tests/support/appShellStores";
import { reconcileCurrentComposerAttachments } from "./attachmentReconciliation";
import { useComposerControlStore } from "./composerControlStore";
import {
  composerSessionKey,
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
    streaming: true,
    toolCalling: false
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
    store.setAttachments([{ fileName: "scan.png", id: "image-a", kind: "image" }]);
    store.activateSession(sessionB);
    store.setAttachments([{ fileName: "notes.txt", id: "text-b", kind: "document" }]);

    expect(reconcileCurrentComposerAttachments(sessionA, textOnlyModel)).toBe(false);
    expect(selectComposerSession(useComposerSessionStore.getState(), sessionA).attachments).toEqual([
      { fileName: "scan.png", id: "image-a", kind: "image" }
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
    store.setAttachments([{ fileName: "scan.png", id: "image-a", kind: "image" }]);
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
      operationError: expect.stringContaining("scan.png")
    });
  });

  it("drops stale limit copy before composing model-capability removal feedback", () => {
    const sessionA = composerSessionKey("chat-a");
    const store = useComposerSessionStore.getState();
    useComposerControlStore.setState({
      selectedModelId: textOnlyModel.modelId,
      selectedProvider: textOnlyModel.provider
    });
    store.activateSession(sessionA);
    store.updateSession(sessionA, {
      attachments: [{ fileName: "scan.png", id: "image-a", kind: "image" }],
      operationError: "This run contains 24 attachments; the limit is 20."
    });

    expect(reconcileCurrentComposerAttachments(sessionA, textOnlyModel)).toBe(true);
    expect(selectComposerSession(useComposerSessionStore.getState(), sessionA).operationError)
      .toBe("Removed an attachment unsupported by Text model: scan.png");
  });

  it("clears resolved binary-limit feedback only after a model-limit context change", () => {
    const sessionA = composerSessionKey("chat-a");
    const extractionModel: CatalogModel = {
      ...textOnlyModel,
      capabilities: {
        ...textOnlyModel.capabilities,
        documentInputMode: "pdf_text_extraction"
      }
    };
    const store = useComposerSessionStore.getState();
    useComposerControlStore.setState({
      selectedModelId: extractionModel.modelId,
      selectedProvider: extractionModel.provider
    });
    store.activateSession(sessionA);
    store.updateSession(sessionA, {
      attachments: [{ byteSize: 101, fileName: "paper.pdf", id: "pdf-a", kind: "pdf" }],
      operationError: "Selected attachments require 101 source bytes; the limit is 100."
    });

    expect(reconcileCurrentComposerAttachments(sessionA, extractionModel)).toBe(false);
    expect(reconcileCurrentComposerAttachments(sessionA, extractionModel, {
      clearResolvedLimitFeedback: true
    })).toBe(true);
    expect(selectComposerSession(useComposerSessionStore.getState(), sessionA).operationError)
      .toBeNull();
  });

  it("defers context cleanup during upload and applies it after settlement", () => {
    const sessionA = composerSessionKey("chat-a");
    const extractionModel: CatalogModel = {
      ...textOnlyModel,
      capabilities: {
        ...textOnlyModel.capabilities,
        documentInputMode: "pdf_text_extraction"
      }
    };
    const store = useComposerSessionStore.getState();
    useComposerControlStore.setState({
      selectedModelId: extractionModel.modelId,
      selectedProvider: extractionModel.provider
    });
    store.activateSession(sessionA);
    store.updateSession(sessionA, {
      attachments: [{ byteSize: 101, fileName: "paper.pdf", id: "pdf-a", kind: "pdf" }]
    });
    const generation = store.beginUpload(sessionA)!;
    store.updateSession(sessionA, {
      operationError: "Selected attachments require 101 source bytes; the limit is 100."
    });

    expect(reconcileCurrentComposerAttachments(sessionA, extractionModel, {
      clearResolvedLimitFeedback: true
    })).toBe(false);
    expect(selectComposerSession(useComposerSessionStore.getState(), sessionA).operationError)
      .toContain("101 source bytes");

    expect(store.finishUpload(sessionA, generation, null)).toBe(true);
    expect(reconcileCurrentComposerAttachments(sessionA, extractionModel, {
      clearResolvedLimitFeedback: true
    })).toBe(true);
    expect(selectComposerSession(useComposerSessionStore.getState(), sessionA).operationError)
      .toBeNull();
  });
});
