import type {
  KnowledgeBaseDetail,
  KnowledgeBaseListResponse,
  KnowledgeReadiness,
  KnowledgeSourceDetail,
  KnowledgeSourceListResponse
} from "@/lib/contracts/knowledge";
import type {
  KnowledgeUploadBatch,
  KnowledgeUploadItem
} from "@/lib/contracts/knowledgeUploads";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetKnowledgeLibraryStoreForTest } from "@/tests/support/appShellStores";
import {
  buildKnowledgeLibraryView,
  createKnowledgeLibraryActions,
  mergeKnowledgeUploadBatch
} from "./knowledgeLibraryController";
import {
  initialKnowledgeLibrarySnapshot,
  useKnowledgeLibraryStore
} from "./knowledgeLibraryStore";

const mocks = vi.hoisted(() => ({
  addKnowledgeSourceMemberships: vi.fn(),
  cancelKnowledgeUploadItem: vi.fn(),
  checkpointKnowledgeUploadPart: vi.fn(),
  createKnowledgeBase: vi.fn(),
  createKnowledgeUploadBatch: vi.fn(),
  fetchKnowledgeBaseDetail: vi.fn(),
  fetchKnowledgeBaseList: vi.fn(),
  fetchKnowledgeSourceDetail: vi.fn(),
  fetchKnowledgeSources: vi.fn(),
  fetchKnowledgeUploadBatches: vi.fn(),
  moveKnowledgeSource: vi.fn(),
  publishKnowledgeBase: vi.fn(),
  replaceKnowledgeSource: vi.fn(),
  retryKnowledgeUploadItem: vi.fn(),
  removeKnowledgeSourceMembership: vi.fn(),
  reprocessKnowledgeSource: vi.fn(),
  revokeKnowledgeBasePublication: vi.fn(),
  settleKnowledgeUploadItem: vi.fn(),
  startKnowledgeUploadItem: vi.fn(),
  updateKnowledgeBase: vi.fn(),
  updateKnowledgeSource: vi.fn(),
  uploadKnowledgeMultipartPart: vi.fn(),
  uploadKnowledgeProxyContent: vi.fn()
}));

vi.mock("@/components/knowledge/knowledgeApi", () => mocks);

function readiness(
  state: KnowledgeReadiness["state"] = "ready",
  totalSources = 1
): KnowledgeReadiness {
  const attentionSources = state === "needs_attention" ? 1 : 0;
  const processingSources = state === "processing" ? 1 : 0;
  const readySources = Math.max(0, totalSources - attentionSources - processingSources);
  return {
    attentionSources,
    processingSources,
    readySources,
    state,
    supportReference: state === "needs_attention" ? "K-0123456789AB" : null,
    totalSources
  };
}

function base(overrides: Partial<KnowledgeBaseDetail> = {}): KnowledgeBaseDetail {
  return {
    archived: false,
    deletionPending: false,
    description: "Product references",
    sourceCount: 1,
    id: "base-1",
    name: "Product docs",
    owned: true,
    ownerDisplayName: "Owner",
    purgeScheduledAt: null,
    publications: [],
    readiness: readiness(),
    scope: { kind: "owner" },
    trashed: false,
    trashedAt: null,
    updatedAt: "2026-08-18T10:00:00.000Z",
    version: 1,
    ...overrides
  };
}

function uploadItem(
  id: string,
  fileName: string,
  clientFileId: string,
  overrides: Partial<KnowledgeUploadItem> = {}
): KnowledgeUploadItem {
  return {
    attemptNumber: 1,
    byteSize: fileName.startsWith("first") ? 5 : fileName.startsWith("second") ? 6 : 7,
    clientFileId,
    failureCode: null,
    fileName,
    id,
    sourceId: null,
    state: "queued",
    transport: { kind: "proxy", uploadUrl: `/api/upload/${id}` },
    updatedAt: "2026-08-18T10:00:00.000Z",
    uploadedBytes: 0,
    ...overrides
  };
}

function uploadBatch(
  items: KnowledgeUploadItem[],
  id = "batch-1"
): KnowledgeUploadBatch {
  return {
    createdAt: "2026-08-18T10:00:00.000Z",
    id,
    items,
    updatedAt: "2026-08-18T10:00:00.000Z"
  };
}

function listData(overrides: Partial<KnowledgeBaseListResponse> = {}): KnowledgeBaseListResponse {
  const detail = base();
  const { publications: _publications, ...summary } = detail;
  return {
    knowledgeBases: [summary],
    publishableGroups: [{ id: "group-1", name: "Research" }],
    viewer: { canCreate: true, canPublishInstallation: true, maxUploadBytes: 50_000_000 },
    ...overrides
  };
}

function source(overrides: Partial<KnowledgeSourceDetail> = {}): KnowledgeSourceDetail {
  const currentVersion = {
    byteSize: 2_400,
    createdAt: "2026-08-18T10:00:00.000Z",
    fileName: "product-guide.pdf",
    isCurrent: true,
    isPending: false,
    pageCount: 8,
    readiness: { state: "ready" as const, supportReference: null, warningCodes: [] },
    versionNumber: 2
  };
  return {
    currentVersion,
    deletionPending: false,
    description: "Canonical product guidance",
    eligibleBases: [{ archived: false, id: "base-2", name: "Assistant docs" }],
    id: "source-1",
    membershipCount: 1,
    memberships: [{ archived: false, id: "base-1", name: "Product docs" }],
    name: "Product guide",
    owned: true,
    ownerDisplayName: "Owner",
    purgeScheduledAt: null,
    readiness: { state: "ready", supportReference: null, warningCodes: [] },
    replacement: { state: "none", supportReference: null },
    tags: ["product", "onboarding"],
    trashed: false,
    trashedAt: null,
    updatedAt: "2026-08-18T10:00:00.000Z",
    version: 3,
    versions: [currentVersion],
    ...overrides
  };
}

function sourceList(
  value: KnowledgeSourceDetail = source(),
  overrides: Partial<KnowledgeSourceListResponse> = {}
): KnowledgeSourceListResponse {
  const { eligibleBases: _eligibleBases, memberships: _memberships, versions: _versions, ...summary } = value;
  return {
    pagination: { page: 1, pageSize: 25, query: "", totalItems: 1, totalPages: 1 },
    sources: [summary],
    ...overrides
  };
}

function emptySourceList(query = ""): KnowledgeSourceListResponse {
  return {
    pagination: { page: 1, pageSize: 25, query, totalItems: 0, totalPages: 0 },
    sources: []
  };
}

function installDetail(detail = base(), sources = sourceList()) {
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
      draft: { description: detail.description, name: detail.name },
      error: null,
      requestId: 0,
      sourcePage: sources.pagination.page,
      sourceQuery: sources.pagination.query,
      sources,
      uploadBatches: [],
      uploadErrors: {},
      uploadProgress: {}
    },
    open: true,
    task: "detail"
  });
}

function installSourceDetail(value = source()) {
  const draft = {
    description: value.description,
    name: value.name,
    tags: value.tags.join(", ")
  };
  useKnowledgeLibraryStore.setState({
    ...initialKnowledgeLibrarySnapshot,
    catalog: "sources",
    data: listData(),
    dataState: "ready",
    open: true,
    sourceData: sourceList(value),
    sourceDataState: "ready",
    sourceDetail: {
      actionId: null,
      baseline: JSON.stringify([draft.description, draft.name, draft.tags]),
      dataError: null,
      dataState: "ready",
      draft,
      error: null,
      requestId: 0,
      returnBaseId: null,
      source: value,
      sourceId: value.id
    },
    task: "source-detail"
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
  mocks.fetchKnowledgeSourceDetail.mockResolvedValue({ data: source(), ok: true });
  mocks.fetchKnowledgeSources.mockResolvedValue({ data: sourceList(), ok: true });
  mocks.fetchKnowledgeUploadBatches.mockResolvedValue({ data: { batches: [] }, ok: true });
});

describe("knowledgeLibraryController", () => {
  it("does not let an out-of-order batch response regress a sibling or replacement attempt", () => {
    const current = uploadBatch([
      uploadItem("item-1", "first.md", "file-1", {
        sourceId: "source-1",
        state: "ready",
        transport: null,
        updatedAt: "2026-08-18T10:02:00.000Z",
        uploadedBytes: 5
      }),
      uploadItem("item-2", "second.md", "file-2", {
        attemptNumber: 2,
        state: "queued",
        updatedAt: "2026-08-18T10:03:00.000Z"
      })
    ]);
    const stale = uploadBatch([
      uploadItem("item-1", "first.md", "file-1", {
        state: "uploading",
        updatedAt: "2026-08-18T10:01:00.000Z"
      }),
      uploadItem("item-2", "second.md", "file-2", {
        attemptNumber: 1,
        failureCode: "knowledge_storage_unavailable",
        state: "needs_attention",
        transport: null,
        updatedAt: "2026-08-18T10:04:00.000Z"
      })
    ]);

    expect(mergeKnowledgeUploadBatch(current, stale).items).toMatchObject([
      { id: "item-1", state: "ready" },
      { attemptNumber: 2, id: "item-2", state: "queued" }
    ]);

    const afterDeletion = {
      ...current,
      items: [current.items[1]!],
      updatedAt: "2026-08-18T10:05:00.000Z"
    };
    expect(mergeKnowledgeUploadBatch(afterDeletion, {
      ...stale,
      updatedAt: "2026-08-18T10:04:00.000Z"
    }).items.map(({ id }) => id)).toEqual(["item-2"]);
  });

  it("creates from name, description, and optional files without technical authority", async () => {
    const created = base({
      sourceCount: 0,
      id: "base-new",
      name: "Runbooks",
      readiness: readiness("empty", 0)
    });
    mocks.createKnowledgeBase.mockResolvedValue({ data: created, ok: true });
    mocks.fetchKnowledgeBaseDetail.mockResolvedValue({ data: created, ok: true });
    mocks.fetchKnowledgeSources.mockResolvedValue({ data: emptySourceList(), ok: true });
    let admittedBatch: KnowledgeUploadBatch;
    mocks.createKnowledgeUploadBatch.mockImplementation(async (_baseId, input) => {
      const candidate = input as {
        files: Array<{ byteSize: number; clientFileId: string; fileName: string }>;
      };
      admittedBatch = uploadBatch(candidate.files.map((file, index) => uploadItem(
        `item-${index + 1}`,
        file.fileName,
        file.clientFileId,
        { byteSize: file.byteSize }
      )));
      return { data: admittedBatch, ok: true };
    });
    mocks.startKnowledgeUploadItem.mockImplementation(async () => ({
      data: uploadBatch(admittedBatch.items.map((item) => ({ ...item, state: "uploading" }))),
      ok: true
    }));
    mocks.uploadKnowledgeProxyContent.mockImplementation(async () => ({
      data: uploadBatch(admittedBatch.items.map((item) => ({
        ...item,
        state: "upload_complete",
        transport: null,
        uploadedBytes: item.byteSize
      }))),
      ok: true
    }));
    mocks.settleKnowledgeUploadItem.mockImplementation(async () => ({
      data: uploadBatch(admittedBatch.items.map((item) => ({
        ...item,
        sourceId: "source-new",
        state: "processing",
        transport: null,
        uploadedBytes: item.byteSize
      }))),
      ok: true
    }));
    const actions = createKnowledgeLibraryActions();

    actions.openLibrary();
    await vi.waitFor(() => expect(useKnowledgeLibraryStore.getState().dataState).toBe("ready"));
    actions.openCreate();
    const file = new File(["runbook"], "runbook.md", { type: "text/markdown" });
    const view = buildKnowledgeLibraryView(actions, useKnowledgeLibraryStore.getState())!;
    expect(view.create?.maxUploadBytes).toBe(50_000_000);
    view.create?.onChange({
      description: "Operational references",
      files: [file],
      name: "Runbooks"
    });

    await actions.saveCreate();

    expect(mocks.createKnowledgeBase).toHaveBeenCalledWith({
      description: "Operational references",
      name: "Runbooks"
    });
    await vi.waitFor(() => expect(mocks.settleKnowledgeUploadItem).toHaveBeenCalledOnce());
    expect(mocks.createKnowledgeUploadBatch).toHaveBeenCalledWith("base-new", {
      clientBatchId: expect.stringMatching(/^batch-/u),
      files: [{
        byteSize: file.size,
        clientFileId: expect.stringMatching(/^file-/u),
        fileName: "runbook.md",
        mimeType: "text/markdown"
      }]
    });
    expect(JSON.stringify(mocks.createKnowledgeBase.mock.calls[0]?.[0])).not.toMatch(
      /embedding|generation|dimension|fingerprint/u
    );
    expect(useKnowledgeLibraryStore.getState()).toMatchObject({
      task: "detail",
      detail: { baseId: "base-new" },
      notice: { kind: "success", text: expect.stringContaining("1 file uploaded") }
    });
  });

  it("keeps the create action unavailable when installation processing is unavailable", async () => {
    const actions = createKnowledgeLibraryActions();
    useKnowledgeLibraryStore.setState({
      ...initialKnowledgeLibrarySnapshot,
      data: listData({
        viewer: {
          canCreate: false,
          canPublishInstallation: false,
          maxUploadBytes: 50_000_000
        }
      }),
      dataState: "ready",
      open: true
    });

    actions.openCreate();

    expect(useKnowledgeLibraryStore.getState()).toMatchObject({
      task: "list",
      notice: { text: "Knowledge is temporarily unavailable. Contact your administrator." }
    });
  });

  it("ignores a late detail response after another base becomes current", async () => {
    const firstDetail = deferred<{ data: KnowledgeBaseDetail; ok: true }>();
    const firstSources = deferred<{ data: KnowledgeSourceListResponse; ok: true }>();
    mocks.fetchKnowledgeBaseDetail
      .mockReturnValueOnce(firstDetail.promise)
      .mockResolvedValueOnce({ data: base({ id: "base-2", name: "Second" }), ok: true });
    mocks.fetchKnowledgeSources
      .mockReturnValueOnce(firstSources.promise)
      .mockResolvedValueOnce({ data: sourceList(), ok: true });
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
    firstSources.resolve({ data: sourceList(), ok: true });

    expect(useKnowledgeLibraryStore.getState().detail).toMatchObject({
      baseId: "base-2",
      base: { name: "Second" }
    });
  });

  it("refreshes processing state without overwriting a dirty settings draft", async () => {
    installDetail();
    useKnowledgeLibraryStore.getState().patchDetail({
      draft: { description: "Unsaved", name: "Local edit" }
    });
    mocks.fetchKnowledgeBaseDetail.mockResolvedValue({
      data: base({ description: "External", name: "External edit", version: 2 }),
      ok: true
    });
    mocks.fetchKnowledgeSources.mockResolvedValue({ data: sourceList(), ok: true });
    const actions = createKnowledgeLibraryActions();

    await actions.refreshDetail("base-1", true);

    expect(useKnowledgeLibraryStore.getState().detail).toMatchObject({
      base: { version: 1 },
      draft: { description: "Unsaved", name: "Local edit" },
      sources: { sources: [{ readiness: { state: "ready" } }] }
    });
  });

  it("uploads files concurrently and keeps a partial transfer failure file-scoped", async () => {
    installDetail(base({ sourceCount: 0, readiness: readiness("empty", 0) }), emptySourceList());
    const actions = createKnowledgeLibraryActions();
    const files = [
      new File(["first"], "first.md", { type: "text/markdown" }),
      new File(["second"], "second.md", { type: "text/markdown" })
    ];
    let admittedBatch!: KnowledgeUploadBatch;
    mocks.createKnowledgeUploadBatch.mockImplementation(async (_baseId, input) => {
      const candidate = input as {
        files: Array<{ byteSize: number; clientFileId: string; fileName: string }>;
      };
      admittedBatch = uploadBatch(candidate.files.map((file, index) => uploadItem(
        `item-${index + 1}`,
        file.fileName,
        file.clientFileId,
        { byteSize: file.byteSize }
      )));
      return { data: admittedBatch, ok: true };
    });
    mocks.startKnowledgeUploadItem.mockImplementation(async () => ({
      data: uploadBatch(admittedBatch.items.map((item) => ({ ...item, state: "uploading" }))),
      ok: true
    }));
    const uploadedBatch = uploadBatch([]);
    const first = deferred<{ data: KnowledgeUploadBatch; ok: true }>();
    mocks.uploadKnowledgeProxyContent
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ code: "unsupported_type", message: "raw", ok: false });
    mocks.settleKnowledgeUploadItem.mockImplementation(async (_baseId, _batchId, itemId) => ({
      data: uploadBatch(admittedBatch.items.map((item) => item.id === itemId
        ? {
            ...item,
            sourceId: "source-1",
            state: "processing",
            transport: null,
            uploadedBytes: item.byteSize
          }
        : item)),
      ok: true
    }));

    const pending = actions.uploadFiles(files);
    await vi.waitFor(() => expect(mocks.uploadKnowledgeProxyContent).toHaveBeenCalledTimes(2));
    first.resolve({
      data: {
        ...uploadedBatch,
        id: admittedBatch.id,
        items: admittedBatch.items.map((item) => item.id === "item-1"
          ? {
              ...item,
              state: "upload_complete",
              transport: null,
              uploadedBytes: item.byteSize
            }
          : item)
      },
      ok: true
    });
    await pending;

    expect(mocks.uploadKnowledgeProxyContent).toHaveBeenNthCalledWith(
      2,
      "/api/upload/item-2",
      files[1],
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(useKnowledgeLibraryStore.getState().notice?.text).toContain("1 file needs attention");
    expect(useKnowledgeLibraryStore.getState().notice?.text).not.toContain("raw");
  });

  it("checkpoints multipart parts before settling one file", async () => {
    installDetail(base({ sourceCount: 0, readiness: readiness("empty", 0) }), emptySourceList());
    const actions = createKnowledgeLibraryActions();
    const file = new File(["0123456789"], "large.md", { type: "text/markdown" });
    const queued = uploadItem("item-multipart", file.name, "client-file", {
      byteSize: file.size,
      transport: {
        kind: "multipart",
        parts: [
          { byteOffset: 0, byteSize: 5, complete: false, partNumber: 1, uploadUrl: "https://storage.test/part-1" },
          { byteOffset: 5, byteSize: 5, complete: false, partNumber: 2, uploadUrl: "https://storage.test/part-2" }
        ]
      }
    });
    let admitted = uploadBatch([queued], "batch-multipart");
    mocks.createKnowledgeUploadBatch.mockImplementation(async (_baseId, input) => {
      const clientFileId = (input as { files: Array<{ clientFileId: string }> }).files[0]!.clientFileId;
      admitted = uploadBatch([{ ...queued, clientFileId }], "batch-multipart");
      return { data: admitted, ok: true };
    });
    mocks.startKnowledgeUploadItem.mockImplementation(async () => ({
      data: uploadBatch([{ ...admitted.items[0]!, state: "uploading" }], admitted.id),
      ok: true
    }));
    mocks.uploadKnowledgeMultipartPart
      .mockResolvedValueOnce({ data: "etag-1", ok: true })
      .mockResolvedValueOnce({ data: "etag-2", ok: true });
    mocks.checkpointKnowledgeUploadPart.mockImplementation(async (
      _baseId,
      _batchId,
      _itemId,
      partNumber
    ) => ({
      data: uploadBatch([{
        ...queued,
        state: "uploading",
        transport: {
          kind: "multipart",
          parts: (queued.transport as Extract<KnowledgeUploadItem["transport"], { kind: "multipart" }>).parts
            .map((part) => part.partNumber <= Number(partNumber)
              ? { ...part, complete: true, uploadUrl: null }
              : part)
        },
        uploadedBytes: Number(partNumber) * 5
      }], admitted.id),
      ok: true
    }));
    mocks.settleKnowledgeUploadItem.mockResolvedValue({
      data: uploadBatch([{
        ...queued,
        sourceId: "source-multipart",
        state: "processing",
        transport: null,
        uploadedBytes: file.size
      }], admitted.id),
      ok: true
    });

    await actions.uploadFiles([file]);

    expect(mocks.uploadKnowledgeMultipartPart).toHaveBeenCalledTimes(2);
    expect((mocks.uploadKnowledgeMultipartPart.mock.calls[0]?.[1] as Blob).size).toBe(5);
    expect((mocks.uploadKnowledgeMultipartPart.mock.calls[1]?.[1] as Blob).size).toBe(5);
    expect(mocks.checkpointKnowledgeUploadPart).toHaveBeenNthCalledWith(
      1,
      "base-1",
      "batch-multipart",
      "item-multipart",
      1,
      { attemptNumber: 1, byteSize: 5, etag: "etag-1" }
    );
    expect(mocks.settleKnowledgeUploadItem).toHaveBeenCalledWith(
      "base-1",
      "batch-multipart",
      "item-multipart",
      1
    );
    expect(useKnowledgeLibraryStore.getState().detail?.uploadProgress).toEqual({});
  });

  it("settles an upload-complete receipt after reload without reselecting bytes", async () => {
    installDetail(base({ sourceCount: 0, readiness: readiness("empty", 0) }), emptySourceList());
    const stored = uploadItem("item-stored", "stored.md", "client-stored", {
      sourceId: null,
      state: "upload_complete",
      transport: null,
      uploadedBytes: 7
    });
    const batch = uploadBatch([stored], "batch-stored");
    mocks.fetchKnowledgeUploadBatches.mockResolvedValue({ data: { batches: [batch] }, ok: true });
    mocks.settleKnowledgeUploadItem.mockResolvedValue({
      data: uploadBatch([{
        ...stored,
        sourceId: "source-stored",
        state: "processing"
      }], batch.id),
      ok: true
    });
    const actions = createKnowledgeLibraryActions();

    await actions.refreshDetail("base-1", true);
    await vi.waitFor(() => expect(mocks.settleKnowledgeUploadItem).toHaveBeenCalledOnce());

    expect(mocks.uploadKnowledgeProxyContent).not.toHaveBeenCalled();
    expect(mocks.uploadKnowledgeMultipartPart).not.toHaveBeenCalled();
    expect(mocks.settleKnowledgeUploadItem).toHaveBeenCalledWith(
      "base-1",
      "batch-stored",
      "item-stored",
      1
    );
  });

  it("restarts an interrupted proxy stream with a fenced attempt after reload", async () => {
    installDetail(base({ sourceCount: 0, readiness: readiness("empty", 0) }), emptySourceList());
    const file = new File(["resume"], "resume.md", { type: "text/markdown" });
    const interrupted = uploadItem("item-interrupted", file.name, "client-interrupted", {
      byteSize: file.size,
      state: "uploading",
      transport: { kind: "proxy", uploadUrl: "/api/upload/item-interrupted?attempt=1" }
    });
    const batch = uploadBatch([interrupted], "batch-interrupted");
    useKnowledgeLibraryStore.getState().patchDetail({ uploadBatches: [batch] });
    const restarted = uploadBatch([{
      ...interrupted,
      attemptNumber: 2,
      state: "queued",
      transport: { kind: "proxy", uploadUrl: "/api/upload/item-interrupted?attempt=2" }
    }], batch.id);
    mocks.retryKnowledgeUploadItem.mockResolvedValue({ data: restarted, ok: true });
    mocks.startKnowledgeUploadItem.mockResolvedValue({
      data: uploadBatch([{ ...restarted.items[0]!, state: "uploading" }], batch.id),
      ok: true
    });
    mocks.uploadKnowledgeProxyContent.mockResolvedValue({
      data: uploadBatch([{
        ...restarted.items[0]!,
        state: "upload_complete",
        transport: null,
        uploadedBytes: file.size
      }], batch.id),
      ok: true
    });
    mocks.settleKnowledgeUploadItem.mockResolvedValue({
      data: uploadBatch([{
        ...restarted.items[0]!,
        sourceId: "source-resumed",
        state: "processing",
        transport: null,
        uploadedBytes: file.size
      }], batch.id),
      ok: true
    });
    const actions = createKnowledgeLibraryActions();

    await actions.resumeUpload(batch.id, interrupted.id, file);

    expect(mocks.retryKnowledgeUploadItem).toHaveBeenCalledWith(
      "base-1",
      batch.id,
      interrupted.id,
      1
    );
    expect(mocks.startKnowledgeUploadItem).toHaveBeenCalledWith(
      "base-1",
      batch.id,
      interrupted.id,
      2
    );
    expect(mocks.uploadKnowledgeProxyContent).toHaveBeenCalledWith(
      "/api/upload/item-interrupted?attempt=2",
      file,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("aborts an active transfer and persists file-scoped cancellation", async () => {
    installDetail(base({ sourceCount: 0, readiness: readiness("empty", 0) }), emptySourceList());
    const actions = createKnowledgeLibraryActions();
    const file = new File(["cancel"], "cancel.md", { type: "text/markdown" });
    const queued = uploadItem("item-cancel", file.name, "client-cancel", { byteSize: file.size });
    let batch = uploadBatch([queued], "batch-cancel");
    let persistedBatch = batch;
    mocks.fetchKnowledgeUploadBatches.mockImplementation(async () => ({
      data: { batches: [persistedBatch] },
      ok: true
    }));
    mocks.createKnowledgeUploadBatch.mockImplementation(async (_baseId, input) => {
      const clientFileId = (input as { files: Array<{ clientFileId: string }> }).files[0]!.clientFileId;
      batch = uploadBatch([{ ...queued, clientFileId }], "batch-cancel");
      return { data: batch, ok: true };
    });
    mocks.startKnowledgeUploadItem.mockImplementation(async () => ({
      data: uploadBatch([{ ...batch.items[0]!, state: "uploading" }], batch.id),
      ok: true
    }));
    mocks.uploadKnowledgeProxyContent.mockImplementation(async (_url, _file, input) =>
      new Promise((resolve) => {
        (input as { signal: AbortSignal }).signal.addEventListener("abort", () => resolve({
          code: "knowledge_upload_cancelled",
          message: "raw cancellation",
          ok: false
        }), { once: true });
      }));
    const cancelResponse = deferred<{ data: KnowledgeUploadBatch; ok: true }>();
    mocks.cancelKnowledgeUploadItem.mockReturnValue(cancelResponse.promise);

    const upload = actions.uploadFiles([file]);
    await vi.waitFor(() => expect(mocks.uploadKnowledgeProxyContent).toHaveBeenCalledOnce());
    const cancellation = actions.cancelUpload(batch.id, queued.id);
    persistedBatch = uploadBatch([{
        ...queued,
        state: "cancelled",
        transport: null,
        uploadedBytes: 0
      }], batch.id);
    cancelResponse.resolve({
      data: persistedBatch,
      ok: true
    });
    await Promise.all([upload, cancellation]);

    expect(mocks.cancelKnowledgeUploadItem).toHaveBeenCalledWith(
      "base-1",
      "batch-cancel",
      "item-cancel",
      1
    );
    await vi.waitFor(() => expect(
      useKnowledgeLibraryStore.getState().detail?.uploadBatches[0]?.items[0]?.state
    ).toBe("cancelled"));
    expect(useKnowledgeLibraryStore.getState().detail?.uploadErrors).toEqual({});
    expect(useKnowledgeLibraryStore.getState().notice?.text).toContain("1 file cancelled");
  });

  it("drives user actions through their existing server owners", async () => {
    const affected = source({
      readiness: {
        state: "needs_attention",
        supportReference: "K-0123456789AB",
        warningCodes: []
      }
    });
    installDetail(
      base({ readiness: readiness("needs_attention") }),
      sourceList(affected)
    );
    mocks.publishKnowledgeBase.mockResolvedValue({
      data: {
        groupId: "group-1",
        groupName: "Research",
        id: "publication-1",
        scope: "group",
        updatedAt: "2026-08-18T10:01:00.000Z"
      },
      ok: true
    });
    mocks.revokeKnowledgeBasePublication.mockResolvedValue({ data: undefined, ok: true });
    mocks.removeKnowledgeSourceMembership.mockResolvedValue({ data: affected, ok: true });
    mocks.updateKnowledgeBase.mockResolvedValue({
      data: base({ archived: true, readiness: readiness("archived"), version: 2 }),
      ok: true
    });
    const actions = createKnowledgeLibraryActions();

    await actions.publish({ groupId: "group-1", scope: "group" });
    await actions.revokePublication("publication-1");
    await actions.removeSourceFromDetail("source-1");
    await actions.setArchived("base-1", true);

    expect(mocks.publishKnowledgeBase).toHaveBeenCalledWith("base-1", {
      groupId: "group-1",
      scope: "group"
    });
    expect(mocks.removeKnowledgeSourceMembership).toHaveBeenCalledWith("source-1", "base-1");
  });

  it("keeps a shared Base read-only", async () => {
    const shared = base({
      owned: false,
      ownerDisplayName: "Publisher",
      publications: null,
      scope: { groupNames: ["Research"], kind: "group" }
    });
    installDetail(shared, sourceList(source({ owned: false, ownerDisplayName: "Publisher" })));
    const actions = createKnowledgeLibraryActions();
    const view = buildKnowledgeLibraryView(actions, useKnowledgeLibraryStore.getState())!;
    expect(view.detail?.maxUploadBytes).toBe(50_000_000);

    view.detail?.onArchiveToggle(true);
    view.detail?.onUpload([new File(["x"], "x.md")]);
    view.detail?.onPublish({ groupId: "group-1", scope: "group" });
    await Promise.resolve();

    expect(mocks.updateKnowledgeBase).not.toHaveBeenCalled();
    expect(mocks.createKnowledgeUploadBatch).not.toHaveBeenCalled();
    expect(mocks.publishKnowledgeBase).not.toHaveBeenCalled();
  });

  it("loads the Source catalog from server filters and ignores stale responses", async () => {
    const first = deferred<{ data: KnowledgeSourceListResponse; ok: true }>();
    const second = deferred<{ data: KnowledgeSourceListResponse; ok: true }>();
    mocks.fetchKnowledgeSources
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    useKnowledgeLibraryStore.setState({
      ...initialKnowledgeLibrarySnapshot,
      data: listData(),
      dataState: "ready",
      open: true
    });
    const actions = createKnowledgeLibraryActions();

    actions.setCatalog("sources");
    await vi.waitFor(() => expect(mocks.fetchKnowledgeSources).toHaveBeenCalledOnce());
    actions.setSourceQuery("policy");
    await vi.waitFor(() => expect(mocks.fetchKnowledgeSources).toHaveBeenCalledTimes(2));
    const latest = source({ id: "source-2", name: "Policy manual" });
    second.resolve({
      data: sourceList(latest, {
        pagination: { page: 1, pageSize: 25, query: "policy", totalItems: 1, totalPages: 1 }
      }),
      ok: true
    });
    await vi.waitFor(() => expect(useKnowledgeLibraryStore.getState().sourceData?.sources[0]?.id)
      .toBe("source-2"));
    first.resolve({ data: sourceList(source({ name: "Late result" })), ok: true });
    await Promise.resolve();

    expect(mocks.fetchKnowledgeSources).toHaveBeenNthCalledWith(1, {
      filter: "all",
      page: 1,
      query: ""
    });
    expect(mocks.fetchKnowledgeSources).toHaveBeenNthCalledWith(2, {
      filter: "all",
      page: 1,
      query: "policy"
    });
    expect(useKnowledgeLibraryStore.getState().sourceData?.sources[0]?.name).toBe("Policy manual");
  });

  it("edits a Source and keeps add, move, and remove as distinct membership calls", async () => {
    installSourceDetail();
    const saved = source({
      description: "Updated guidance",
      name: "Product handbook",
      tags: ["product", "policy"],
      version: 4
    });
    mocks.updateKnowledgeSource.mockResolvedValue({ data: saved, ok: true });
    const added = source({
      eligibleBases: [{ archived: false, id: "base-3", name: "Project docs" }],
      membershipCount: 2,
      memberships: [
        { archived: false, id: "base-1", name: "Product docs" },
        { archived: false, id: "base-2", name: "Assistant docs" }
      ],
      version: 5
    });
    const moved = source({
      eligibleBases: [{ archived: false, id: "base-1", name: "Product docs" }],
      membershipCount: 2,
      memberships: [
        { archived: false, id: "base-2", name: "Assistant docs" },
        { archived: false, id: "base-3", name: "Project docs" }
      ],
      version: 6
    });
    const removed = source({
      eligibleBases: [
        { archived: false, id: "base-1", name: "Product docs" },
        { archived: false, id: "base-2", name: "Assistant docs" }
      ],
      membershipCount: 1,
      memberships: [{ archived: false, id: "base-3", name: "Project docs" }],
      version: 7
    });
    mocks.addKnowledgeSourceMemberships.mockResolvedValue({ data: added, ok: true });
    mocks.moveKnowledgeSource.mockResolvedValue({ data: moved, ok: true });
    mocks.removeKnowledgeSourceMembership.mockResolvedValue({ data: removed, ok: true });
    const actions = createKnowledgeLibraryActions();
    const sourceView = buildKnowledgeLibraryView(actions, useKnowledgeLibraryStore.getState())!;
    sourceView.sourceDetail?.onChange({
      description: " Updated guidance ",
      name: " Product handbook ",
      tags: "product, policy"
    });

    await actions.saveSourceDetail();
    await actions.addSourceToBases(["base-2"]);
    await actions.moveSourceMembership("base-1", "base-3");
    await actions.removeSourceFromBase("base-2");

    expect(mocks.updateKnowledgeSource).toHaveBeenCalledWith("source-1", {
      description: "Updated guidance",
      expectedVersion: 3,
      name: "Product handbook",
      tags: ["product", "policy"]
    });
    expect(mocks.addKnowledgeSourceMemberships).toHaveBeenCalledWith("source-1", ["base-2"]);
    expect(mocks.moveKnowledgeSource).toHaveBeenCalledWith("source-1", {
      fromBaseId: "base-1",
      toBaseId: "base-3"
    });
    expect(mocks.removeKnowledgeSourceMembership).toHaveBeenCalledWith("source-1", "base-2");
    expect(useKnowledgeLibraryStore.getState().sourceDetail?.source).toMatchObject({
      membershipCount: 1,
      version: 7
    });
  });

  it("replaces and retries the canonical Source from its own detail view", async () => {
    installSourceDetail(source({
      replacement: { state: "needs_attention", supportReference: "K-RETRY" }
    }));
    const processing = source({
      replacement: { state: "processing", supportReference: null },
      version: 4
    });
    mocks.replaceKnowledgeSource.mockResolvedValue({ data: processing, ok: true });
    mocks.reprocessKnowledgeSource.mockResolvedValue({ data: processing, ok: true });
    const actions = createKnowledgeLibraryActions();
    const file = new File(["replacement"], "replacement.md", { type: "text/markdown" });

    await actions.replaceSource(file);
    await actions.reprocessSource();

    expect(mocks.replaceKnowledgeSource).toHaveBeenCalledWith("source-1", file);
    expect(mocks.reprocessKnowledgeSource).toHaveBeenCalledWith("source-1");
    expect(useKnowledgeLibraryStore.getState().sourceDetail?.source).toMatchObject({
      replacement: { state: "processing" },
      version: 4
    });
    expect(useKnowledgeLibraryStore.getState().notice?.text).toBe(
      "Source processing restarted."
    );
  });

  it("blocks Source membership changes while its metadata draft is dirty", async () => {
    installSourceDetail();
    const actions = createKnowledgeLibraryActions();
    useKnowledgeLibraryStore.getState().patchSourceDetail({
      draft: { description: "Unsaved", name: "Product guide", tags: "product, onboarding" }
    });

    await actions.addSourceToBases(["base-2"]);
    await actions.moveSourceMembership("base-1", "base-2");
    await actions.removeSourceFromBase("base-1");

    expect(mocks.addKnowledgeSourceMemberships).not.toHaveBeenCalled();
    expect(mocks.moveKnowledgeSource).not.toHaveBeenCalled();
    expect(mocks.removeKnowledgeSourceMembership).not.toHaveBeenCalled();
    expect(useKnowledgeLibraryStore.getState().notice?.text).toBe(
      "Save or discard Source changes first."
    );
  });
});
