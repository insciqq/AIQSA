import type {
  KnowledgeBaseDetail,
  KnowledgeBaseListResponse,
  KnowledgeDocumentStatus,
  KnowledgeIngestionStatusResponse
} from "@/lib/contracts/knowledge";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildKnowledgeLibraryView,
  createKnowledgeLibraryActions
} from "./knowledgeLibraryController";
import {
  initialKnowledgeLibrarySnapshot,
  resetKnowledgeLibraryStoreForTest,
  useKnowledgeLibraryStore
} from "./knowledgeLibraryStore";

const mocks = vi.hoisted(() => ({
  archiveKnowledgeDocument: vi.fn(),
  createKnowledgeBase: vi.fn(),
  fetchKnowledgeBaseDetail: vi.fn(),
  fetchKnowledgeBaseList: vi.fn(),
  fetchKnowledgeDocuments: vi.fn(),
  publishKnowledgeBase: vi.fn(),
  replaceKnowledgeDocument: vi.fn(),
  retryKnowledgeDocumentVersion: vi.fn(),
  revokeKnowledgeBasePublication: vi.fn(),
  startKnowledgeReindex: vi.fn(),
  updateKnowledgeBase: vi.fn(),
  uploadKnowledgeDocument: vi.fn()
}));

vi.mock("@/components/knowledge/knowledgeApi", () => mocks);

function base(overrides: Partial<KnowledgeBaseDetail> = {}): KnowledgeBaseDetail {
  return {
    activeGeneration: {
      chunkingProfileVersion: 1,
      embeddingDeployment: {
        connectionDisplayName: "Embedding connection",
        id: "embedding-1",
        indexSupported: true,
        modelDisplayName: "Embed model",
        provider: "openai",
        targetDimension: 1536
      },
      embeddingDeploymentId: "embedding-1",
      id: "generation-1",
      indexedContentRevision: 1,
      targetDimension: 1536,
      vectorSpaceFingerprint: "vector-space-1"
    },
    archived: false,
    contentRevision: 1,
    description: "Product references",
    documentCount: 1,
    id: "base-1",
    name: "Product docs",
    owned: true,
    ownerDisplayName: "Owner",
    publications: [],
    published: false,
    scope: { kind: "owner" },
    updatedAt: "2026-08-08T10:00:00.000Z",
    version: 1,
    ...overrides
  };
}

function documentStatus(overrides: Partial<KnowledgeDocumentStatus> = {}): KnowledgeDocumentStatus {
  return {
    archived: false,
    currentVersionId: "version-1",
    id: "document-1",
    versions: [{
      byteSize: 12,
      completedAt: null,
      createdAt: "2026-08-08T10:00:00.000Z",
      current: true,
      embeddedChunks: 0,
      errorCode: null,
      fileName: "guide.md",
      id: "version-1",
      mimeType: "text/markdown",
      pageCount: null,
      payloadAvailable: true,
      state: "queued",
      totalChunks: null,
      updatedAt: "2026-08-08T10:00:00.000Z",
      versionNumber: 1,
      visibleFromRevision: null,
      visibleUntilRevision: null
    }],
    ...overrides
  };
}

function ingestion(overrides: Partial<KnowledgeIngestionStatusResponse> = {}): KnowledgeIngestionStatusResponse {
  const documents = overrides.documents ?? [documentStatus()];
  return {
    documents,
    owned: overrides.owned ?? true,
    pagination: overrides.pagination ?? {
      page: 1,
      pageSize: 25,
      query: "",
      totalItems: documents.length,
      totalPages: documents.length > 0 ? 1 : 0
    },
    reindex: overrides.reindex ?? null
  };
}

function listData(overrides: Partial<KnowledgeBaseListResponse> = {}): KnowledgeBaseListResponse {
  const detail = base();
  const { documentCount: _count, publications: _publications, ...summary } = detail;
  return {
    embeddingDeployments: [detail.activeGeneration.embeddingDeployment!],
    knowledgeBases: [summary],
    publishableGroups: [{ id: "group-1", name: "Research" }],
    viewer: { canPublishInstallation: true },
    ...overrides
  };
}

function installDetail(detail = base(), status = ingestion()) {
  useKnowledgeLibraryStore.setState({
    ...initialKnowledgeLibrarySnapshot,
    data: listData(),
    dataState: "ready",
    detail: {
      actionId: null,
      base: detail,
      baseId: detail.id,
      baseline: JSON.stringify([detail.description, detail.name]),
      dataError: null,
      dataState: "ready",
      documentPage: status.pagination.page,
      documentQuery: status.pagination.query,
      draft: { description: detail.description, name: detail.name },
      error: null,
      ingestion: status,
      requestId: 0,
      upload: null
    },
    open: true,
    task: "detail"
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  resetKnowledgeLibraryStoreForTest();
  mocks.fetchKnowledgeBaseList.mockResolvedValue({ data: listData(), ok: true });
  mocks.fetchKnowledgeBaseDetail.mockResolvedValue({ data: base(), ok: true });
  mocks.fetchKnowledgeDocuments.mockResolvedValue({ data: ingestion(), ok: true });
});

describe("knowledgeLibraryController", () => {
  it("loads the server-authorized list and creates with the exact selected embedding deployment", async () => {
    const created = base({ id: "base-new", name: "Runbooks" });
    mocks.createKnowledgeBase.mockResolvedValue({ data: created, ok: true });
    mocks.fetchKnowledgeBaseDetail.mockResolvedValue({ data: created, ok: true });
    const actions = createKnowledgeLibraryActions();

    actions.openLibrary();
    await vi.waitFor(() => expect(useKnowledgeLibraryStore.getState().dataState).toBe("ready"));
    actions.openCreate();
    let view = buildKnowledgeLibraryView(actions, useKnowledgeLibraryStore.getState())!;
    expect(view.create?.draft.embeddingDeploymentId).toBe("embedding-1");
    view.create?.onChange({ description: "Operational references", name: "Runbooks" });
    view = buildKnowledgeLibraryView(actions, useKnowledgeLibraryStore.getState())!;

    await actions.saveCreate();

    expect(mocks.createKnowledgeBase).toHaveBeenCalledWith({
      description: "Operational references",
      embeddingDeploymentId: "embedding-1",
      name: "Runbooks"
    });
    expect(useKnowledgeLibraryStore.getState()).toMatchObject({
      task: "detail",
      detail: { baseId: "base-new" },
      notice: { kind: "success" }
    });
  });

  it("ignores a late detail response after another base becomes current", async () => {
    const firstDetail = deferred<{ data: KnowledgeBaseDetail; ok: true }>();
    const firstIngestion = deferred<{ data: KnowledgeIngestionStatusResponse; ok: true }>();
    mocks.fetchKnowledgeBaseDetail
      .mockReturnValueOnce(firstDetail.promise)
      .mockResolvedValueOnce({ data: base({ id: "base-2", name: "Second" }), ok: true });
    mocks.fetchKnowledgeDocuments
      .mockReturnValueOnce(firstIngestion.promise)
      .mockResolvedValueOnce({ data: ingestion(), ok: true });
    const actions = createKnowledgeLibraryActions();
    useKnowledgeLibraryStore.setState({
      ...initialKnowledgeLibrarySnapshot,
      data: listData(),
      dataState: "ready",
      open: true
    });

    actions.openDetail("base-1");
    await vi.waitFor(() => expect(mocks.fetchKnowledgeBaseDetail).toHaveBeenCalledOnce());
    actions.openDetail("base-2");
    await vi.waitFor(() => expect(useKnowledgeLibraryStore.getState().detail?.base?.id).toBe("base-2"));
    firstDetail.resolve({ data: base({ id: "base-1", name: "Late first" }), ok: true });
    firstIngestion.resolve({ data: ingestion(), ok: true });
    await vi.waitFor(() => expect(mocks.fetchKnowledgeBaseDetail).toHaveBeenCalledTimes(2));

    expect(useKnowledgeLibraryStore.getState().detail).toMatchObject({
      baseId: "base-2",
      base: { name: "Second" }
    });
  });

  it("refreshes lifecycle evidence without overwriting a dirty CAS baseline", async () => {
    installDetail();
    useKnowledgeLibraryStore.getState().patchDetail({
      draft: { description: "Unsaved", name: "Local edit" }
    });
    mocks.fetchKnowledgeBaseDetail.mockResolvedValue({
      data: base({ description: "External", name: "External edit", version: 2 }),
      ok: true
    });
    const ready = documentStatus({
      versions: [{ ...documentStatus().versions[0], embeddedChunks: 2, state: "ready", totalChunks: 2 }]
    });
    mocks.fetchKnowledgeDocuments.mockResolvedValue({ data: ingestion({ documents: [ready] }), ok: true });
    const actions = createKnowledgeLibraryActions();

    await actions.refreshDetail("base-1", true);

    expect(useKnowledgeLibraryStore.getState().detail).toMatchObject({
      base: { version: 1 },
      draft: { description: "Unsaved", name: "Local edit" },
      ingestion: { documents: [{ versions: [{ state: "ready" }] }] }
    });
  });

  it("keeps the active filename query and page in refreshes", async () => {
    installDetail(base(), ingestion({
      pagination: {
        page: 1,
        pageSize: 25,
        query: "",
        totalItems: 51,
        totalPages: 3
      }
    }));
    const actions = createKnowledgeLibraryActions();
    const pageTwo = ingestion({
      pagination: {
        page: 2,
        pageSize: 25,
        query: "",
        totalItems: 51,
        totalPages: 3
      }
    });
    mocks.fetchKnowledgeDocuments.mockResolvedValueOnce({ data: pageTwo, ok: true });

    actions.setDocumentPage(2);
    await vi.waitFor(() => expect(mocks.fetchKnowledgeDocuments).toHaveBeenCalledWith(
      "base-1",
      { page: 2, pageSize: 25, query: "" }
    ));
    await vi.waitFor(() => expect(useKnowledgeLibraryStore.getState().detail?.documentPage).toBe(2));

    const searched = ingestion({
      documents: [],
      pagination: {
        page: 1,
        pageSize: 25,
        query: "incident",
        totalItems: 0,
        totalPages: 0
      }
    });
    mocks.fetchKnowledgeDocuments.mockResolvedValueOnce({ data: searched, ok: true });
    actions.setDocumentQuery("incident");
    await vi.waitFor(() => expect(mocks.fetchKnowledgeDocuments).toHaveBeenLastCalledWith(
      "base-1",
      { page: 1, pageSize: 25, query: "incident" }
    ));
    await vi.waitFor(() => expect(useKnowledgeLibraryStore.getState().detail).toMatchObject({
      documentPage: 1,
      documentQuery: "incident",
      ingestion: { documents: [] }
    }));
  });

  it("uploads multiple files sequentially and keeps partial failure truthful", async () => {
    installDetail(base({ documentCount: 0 }), ingestion({ documents: [] }));
    const first = deferred<{ data: KnowledgeDocumentStatus; ok: true }>();
    mocks.uploadKnowledgeDocument
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ code: "unsupported_type", message: "raw", ok: false });
    const actions = createKnowledgeLibraryActions();
    const files = [
      new File(["first"], "first.md", { type: "text/markdown" }),
      new File(["second"], "second.svg", { type: "image/svg+xml" })
    ];

    const pending = actions.uploadFiles(files);
    await vi.waitFor(() => expect(mocks.uploadKnowledgeDocument).toHaveBeenCalledTimes(1));
    expect(mocks.uploadKnowledgeDocument).toHaveBeenNthCalledWith(1, "base-1", files[0]);
    expect(useKnowledgeLibraryStore.getState().detail?.upload).toMatchObject({ current: 1, total: 2 });
    first.resolve({ data: documentStatus(), ok: true });
    await pending;

    expect(mocks.uploadKnowledgeDocument).toHaveBeenNthCalledWith(2, "base-1", files[1]);
    expect(useKnowledgeLibraryStore.getState().notice?.text).toContain("1 document queued; 1 could not be uploaded");
    expect(useKnowledgeLibraryStore.getState().notice?.text).toContain("not supported");
    expect(useKnowledgeLibraryStore.getState().notice?.text).not.toContain("raw");
  });

  it("drives retry, reindex, publication, revocation, document removal, and archive through their owners", async () => {
    const failed = documentStatus({
      versions: [{ ...documentStatus().versions[0], errorCode: "embedding_failed", state: "failed" }]
    });
    installDetail(base(), ingestion({ documents: [failed] }));
    const retried = documentStatus();
    mocks.retryKnowledgeDocumentVersion.mockResolvedValue({ data: retried, ok: true });
    mocks.startKnowledgeReindex.mockResolvedValue({
      data: {
        completedDocuments: 0,
        createdAt: "2026-08-08T10:00:00.000Z",
        errorCode: null,
        failedDocuments: 0,
        generationId: "generation-2",
        status: "building",
        targetContentRevision: 1,
        totalDocuments: 1
      },
      ok: true
    });
    mocks.publishKnowledgeBase.mockResolvedValue({
      data: {
        groupId: "group-1",
        groupName: "Research",
        id: "publication-1",
        scope: "group",
        updatedAt: "2026-08-08T10:01:00.000Z"
      },
      ok: true
    });
    mocks.revokeKnowledgeBasePublication.mockResolvedValue({ data: undefined, ok: true });
    mocks.archiveKnowledgeDocument.mockResolvedValue({ data: undefined, ok: true });
    mocks.updateKnowledgeBase.mockResolvedValue({ data: base({ archived: true, version: 2 }), ok: true });
    const actions = createKnowledgeLibraryActions();

    await actions.retryDocument("document-1", "version-1");
    await actions.reindex("embedding-1");
    await actions.publish({ groupId: "group-1", scope: "group" });
    await actions.revokePublication("publication-1");
    await actions.removeDocument("document-1");
    await actions.setArchived("base-1", true);

    expect(mocks.retryKnowledgeDocumentVersion).toHaveBeenCalledWith("base-1", "document-1", "version-1");
    expect(mocks.startKnowledgeReindex).toHaveBeenCalledWith("base-1", "embedding-1");
    expect(mocks.publishKnowledgeBase).toHaveBeenCalledWith("base-1", { groupId: "group-1", scope: "group" });
    expect(mocks.revokeKnowledgeBasePublication).toHaveBeenCalledWith("base-1", "publication-1");
    expect(mocks.archiveKnowledgeDocument).toHaveBeenCalledWith("base-1", "document-1");
    expect(mocks.updateKnowledgeBase).toHaveBeenCalledWith("base-1", { archived: true, expectedVersion: 1 });
  });

  it("keeps shared bases read-only and exposes only the list entries authorized by the server", async () => {
    const shared = base({
      activeGeneration: { ...base().activeGeneration, embeddingDeployment: null, embeddingDeploymentId: null },
      owned: false,
      ownerDisplayName: "Publisher",
      publications: null,
      scope: { groupNames: ["Research"], kind: "group" }
    });
    installDetail(shared, ingestion({ owned: false }));
    const actions = createKnowledgeLibraryActions();
    const view = buildKnowledgeLibraryView(actions, useKnowledgeLibraryStore.getState())!;

    view.detail?.onArchiveToggle(true);
    view.detail?.onUpload([new File(["x"], "x.md")]);
    view.detail?.onPublish({ groupId: "group-1", scope: "group" });
    await Promise.resolve();

    expect(mocks.updateKnowledgeBase).not.toHaveBeenCalled();
    expect(mocks.uploadKnowledgeDocument).not.toHaveBeenCalled();
    expect(mocks.publishKnowledgeBase).not.toHaveBeenCalled();
    expect(view.list.knowledgeBases.map((candidate) => candidate.id)).toEqual(["base-1"]);
  });
});
