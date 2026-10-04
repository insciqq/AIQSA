import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetComposerControlStoreForTest,
  resetComposerSessionStoreForTest
} from "@/tests/support/appShellStores";
import { reconcileCurrentComposerAttachments, reportRejectedAttachments } from "./attachmentReconciliation";
import { useComposerControlStore } from "./composerControlStore";
import {
  composerSessionKey,
  selectComposerSession,
  useComposerSessionStore
} from "./composerSessionStore";
import { resetImageModelStoreForTest } from "./imageModelStore";
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
    resetImageModelStoreForTest();
    vi.unstubAllGlobals();
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
      .toBe("Removed an attachment unsupported by Text model: scan.png. Text model can't read images. To use images, choose a model that supports images.");
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

  describe("refused files", () => {
    const toolModel: CatalogModel = {
      ...textOnlyModel,
      capabilities: { ...textOnlyModel.capabilities, toolCalling: true, imageRoutes: { systemVision: false, imageEditing: false } }
    };
    const imageModel = (id: string, editing: boolean, unavailableReason: string | null = null) =>
      ({ id, displayName: id, providerName: "Images", generation: true, editing, unavailableReason });
    const settings = (models: unknown[]) => ({ imageModel: { models, organizationDefaultId: "creates",
      selectedId: null, effective: { id: "creates", source: "organization" } } });
    const plain = "Text model does not support this attachment: scan.png. Text model can't read images, " +
      "and no Vision Model is available to analyze them. To use images, choose a model that supports images or ask an administrator to assign the Vision Model.";
    const errorOf = (key: ReturnType<typeof composerSessionKey>) =>
      selectComposerSession(useComposerSessionStore.getState(), key).operationError;

    it("points a personal chat to Chat defaults once a published image model can edit", async () => {
      const session = composerSessionKey("chat-a");
      useComposerSessionStore.getState().activateSession(session);
      const fetchMock = vi.fn(async () => Response.json(settings([imageModel("creates", false), imageModel("edits", true)])));
      vi.stubGlobal("fetch", fetchMock);
      const pending = reportRejectedAttachments(["scan.png"], toolModel, { personalChat: true, workspaceAvailable: false });
      expect(errorOf(session)).toBe(plain);
      await pending;
      expect(errorOf(session)).toBe("Text model does not support this attachment: scan.png. Text model can't read images, " +
        "and no Vision Model is available to analyze them. To use images, choose a model that supports images, " +
        "pick an image model that can edit in Studio → Chat defaults → Image model or ask an administrator to assign the Vision Model.");
      // Known settings answer at once without another read.
      useComposerSessionStore.getState().updateSession(session, { operationError: null });
      await reportRejectedAttachments(["scan.png"], toolModel, { personalChat: true, workspaceAvailable: false });
      expect(errorOf(session)).toContain("Studio → Chat defaults → Image model");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("never suggests a choice that cannot help", async () => {
      const session = composerSessionKey("chat-a");
      useComposerSessionStore.getState().activateSession(session);
      // No usable editing model: the plain recovery stays.
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(settings([
        imageModel("creates", false), imageModel("edits", true, "credential_unavailable")]))));
      await reportRejectedAttachments(["scan.png"], toolModel, { personalChat: true, workspaceAvailable: false });
      expect(errorOf(session)).toBe(plain);
      // A Project chat follows the organization default; a model without tools has no editing route.
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      resetImageModelStoreForTest();
      await reportRejectedAttachments(["scan.png"], toolModel, { personalChat: false, workspaceAvailable: false });
      expect(errorOf(session)).toBe(plain);
      await reportRejectedAttachments(["scan.png"], textOnlyModel, { personalChat: true, workspaceAvailable: false });
      expect(errorOf(session)).toBe("Text model does not support this attachment: scan.png. Text model can't read images. " +
        "To use images, choose a model that supports images.");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("leaves a newer message alone when the image models arrive late", async () => {
      const session = composerSessionKey("chat-a");
      useComposerSessionStore.getState().activateSession(session);
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(settings([imageModel("edits", true)]))));
      const pending = reportRejectedAttachments(["scan.png"], toolModel, { personalChat: true, workspaceAvailable: false });
      useComposerSessionStore.getState().updateSession(session, { operationError: "Upload failed." });
      await pending;
      expect(errorOf(session)).toBe("Upload failed.");
    });
  });
});
