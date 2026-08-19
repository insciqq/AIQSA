import {
  addKnowledgeSourceMemberships,
  cancelKnowledgeUploadItem,
  checkpointKnowledgeUploadPart,
  createKnowledgeBase,
  createKnowledgeUploadBatch,
  fetchKnowledgeBaseDetail,
  fetchKnowledgeBaseList,
  fetchKnowledgeSourceDetail,
  fetchKnowledgeSources,
  fetchKnowledgeUploadBatches,
  moveKnowledgeSource,
  permanentlyDeleteKnowledgeBase,
  permanentlyDeleteKnowledgeSource,
  publishKnowledgeBase,
  reprocessKnowledgeSource,
  replaceKnowledgeSource,
  retryKnowledgeUploadItem,
  restoreKnowledgeBase,
  restoreKnowledgeSource,
  removeKnowledgeSourceMembership,
  revokeKnowledgeBasePublication,
  settleKnowledgeUploadItem,
  startKnowledgeUploadItem,
  trashKnowledgeBase,
  trashKnowledgeSource,
  updateKnowledgeBase,
  updateKnowledgeSource,
  uploadKnowledgeMultipartPart,
  uploadKnowledgeProxyContent
} from "@/components/knowledge/knowledgeApi";
import type {
  KnowledgeCreateDraft,
  KnowledgeLibraryView
} from "@/components/knowledge/libraryViewContracts";
import {
  useKnowledgeLibraryStore,
  type KnowledgeDetailState,
  type KnowledgeLibraryStore,
  type KnowledgeSourceDetailState
} from "@/components/app-shell/knowledgeLibraryStore";
import {
  KNOWLEDGE_SOURCE_PAGE_SIZE,
  KNOWLEDGE_SOURCE_SEARCH_MAX_LENGTH,
  type KnowledgeBaseDetail,
  type KnowledgeBaseSummary,
  type KnowledgeSourceDetail,
  type KnowledgeSourceSummary
} from "@/lib/contracts/knowledge";
import type {
  KnowledgeUploadBatch,
  KnowledgeUploadItem
} from "@/lib/contracts/knowledgeUploads";

function createBaseline(draft: KnowledgeCreateDraft): string {
  return JSON.stringify([
    draft.description,
    draft.files.map(({ lastModified, name, size, type }) => [name, size, type, lastModified]),
    draft.name
  ]);
}

function detailBaseline(draft: { description: string; name: string }): string {
  return JSON.stringify([draft.description, draft.name]);
}

function sourceDraft(source: KnowledgeSourceDetail | null) {
  return {
    description: source?.description ?? "",
    name: source?.name ?? "",
    tags: source?.tags.join(", ") ?? ""
  };
}

function sourceBaseline(draft: ReturnType<typeof sourceDraft>): string {
  return JSON.stringify([draft.description, draft.name, draft.tags]);
}

function summaryFromDetail(detail: KnowledgeBaseDetail): KnowledgeBaseSummary {
  const { publications: _publications, ...summary } = detail;
  return summary;
}

function sourceSummaryFromDetail(detail: KnowledgeSourceDetail): KnowledgeSourceSummary {
  const {
    eligibleBases: _eligibleBases,
    memberships: _memberships,
    versions: _versions,
    ...summary
  } = detail;
  return summary;
}

function errorText(code: string): string {
  const messages: Record<string, string> = {
    file_required: "Choose a document to upload.",
    knowledge_base_archived: "Restore this base before sharing it.",
    knowledge_base_input_invalid: "Check the highlighted Knowledge fields and try again.",
    knowledge_base_not_available: "This Knowledge base is no longer available to you.",
    knowledge_base_lifecycle_conflict: "This base cannot be changed from its current lifecycle state.",
    knowledge_base_must_be_trashed: "Move this base to Trash before deleting it permanently.",
    knowledge_base_version_conflict:
      "This base changed in another session. Reload it and reapply your edits.",
    knowledge_document_ingest_in_progress:
      "Wait for the current document version to finish before replacing it.",
    knowledge_document_retry_not_available: "Only a failed current document version can be retried.",
    knowledge_document_reprocess_unavailable:
      "This file cannot be reprocessed. Replace it with the original file and try again.",
    knowledge_file_limit_exceeded: "The document is larger than the Knowledge upload limit.",
    knowledge_publication_forbidden: "You are not allowed to publish to that audience.",
    knowledge_reprocess_in_progress: "This base is already being reprocessed.",
    knowledge_reprocess_unavailable:
      "This base cannot be reprocessed yet. Replace any affected files and try again.",
    knowledge_response_invalid: "The Knowledge response could not be read. Refresh and try again.",
    knowledge_source_input_invalid: "Check the Source fields and try again.",
    knowledge_source_ingest_in_progress:
      "Wait for the current Source replacement to finish before starting another one.",
    knowledge_source_not_available: "This Source is no longer available to you.",
    knowledge_source_lifecycle_conflict: "This Source cannot be changed from its current lifecycle state.",
    knowledge_source_must_be_trashed: "Move this Source to Trash before deleting it permanently.",
    knowledge_source_query_invalid: "Check the Source search and filters and try again.",
    knowledge_source_profile_unavailable:
      "This Source cannot be processed until one of its bases has an active Knowledge profile.",
    knowledge_source_reprocess_not_available:
      "There is no failed Source version to reprocess. Replace the file instead.",
    knowledge_source_version_conflict:
      "This Source changed in another session. Reload it and reapply your edits.",
    knowledge_storage_unavailable: "Private document storage is temporarily unavailable.",
    knowledge_temporarily_unavailable:
      "Knowledge is temporarily unavailable. Contact your administrator.",
    knowledge_checksum_mismatch: "The selected file no longer matches the original upload.",
    knowledge_processing_failed: "This file needs attention before it can be used.",
    knowledge_upload_conflict: "This upload changed in another session. Refresh and try again.",
    knowledge_upload_etag_unavailable:
      "Object storage did not expose a resumable checkpoint. Check its CORS configuration.",
    knowledge_upload_input_invalid: "Check the selected files and try again.",
    knowledge_upload_not_available: "This upload is no longer available.",
    knowledge_upload_session_expired: "The upload session expired. Select the file to retry.",
    network_unavailable: "The Knowledge request could not reach the server.",
    unauthorized: "Your session is no longer available.",
    unsupported_type: "That file type is not supported for Knowledge processing.",
    upload_busy: "Document uploads are busy. Try again in a moment."
  };
  return messages[code] ?? "The Knowledge request could not be completed.";
}

function blankDetail(baseId: string, base: KnowledgeBaseDetail | null = null): KnowledgeDetailState {
  const draft = {
    description: base?.description ?? "",
    name: base?.name ?? ""
  };
  return {
    actionId: null,
    base,
    baseId,
    baseline: detailBaseline(draft),
    dataError: null,
    dataState: base ? "ready" : "loading",
    draft,
    error: null,
    requestId: 0,
    sourcePage: 1,
    sourceQuery: "",
    sources: null,
    uploadBatches: [],
    uploadErrors: {},
    uploadProgress: {}
  };
}

function blankSourceDetail(
  sourceId: string,
  returnBaseId: string | null = null,
  source: KnowledgeSourceDetail | null = null
): KnowledgeSourceDetailState {
  const draft = sourceDraft(source);
  return {
    actionId: null,
    baseline: sourceBaseline(draft),
    dataError: null,
    dataState: source ? "ready" : "loading",
    draft,
    error: null,
    requestId: 0,
    returnBaseId,
    source,
    sourceId
  };
}

function upsertSummary(
  snapshot: KnowledgeLibraryStore,
  detail: KnowledgeBaseDetail
): void {
  if (!snapshot.data) return;
  const summary = summaryFromDetail(detail);
  const exists = snapshot.data.knowledgeBases.some((base) => base.id === detail.id);
  snapshot.patch({
    data: {
      ...snapshot.data,
      knowledgeBases: exists
        ? snapshot.data.knowledgeBases.map((base) => (base.id === detail.id ? summary : base))
        : [summary, ...snapshot.data.knowledgeBases]
    }
  });
}

function upsertSourceSummary(
  snapshot: KnowledgeLibraryStore,
  detail: KnowledgeSourceDetail
): void {
  if (!snapshot.sourceData) return;
  const summary = sourceSummaryFromDetail(detail);
  const exists = snapshot.sourceData.sources.some((source) => source.id === detail.id);
  snapshot.patch({
    sourceData: {
      ...snapshot.sourceData,
      sources: exists
        ? snapshot.sourceData.sources.map((source) => source.id === detail.id ? summary : source)
        : [summary, ...snapshot.sourceData.sources]
    }
  });
}

const KNOWLEDGE_UPLOAD_CONCURRENCY = 4;

function newKnowledgeUploadClientId(prefix: "batch" | "file"): string {
  const randomId = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${randomId}`;
}

async function mapUploadsBounded<T>(
  values: readonly T[],
  operation: (value: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from(
    { length: Math.min(KNOWLEDGE_UPLOAD_CONCURRENCY, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        await operation(values[index]!);
      }
    }
  ));
}

function uploadItemInBatch(
  batch: KnowledgeUploadBatch,
  itemId: string
): KnowledgeUploadItem | null {
  return batch.items.find((item) => item.id === itemId) ?? null;
}

function uploadItemSettled(item: KnowledgeUploadItem): boolean {
  return item.state === "processing" || item.state === "ready" ||
    item.state === "ready_with_warnings" || item.state === "reused";
}

const uploadStateOrder: Record<KnowledgeUploadItem["state"], number> = {
  cancelled: 5,
  needs_attention: 5,
  processing: 4,
  queued: 0,
  ready: 5,
  ready_with_warnings: 5,
  reused: 5,
  upload_complete: 3,
  uploading: 2
};

function fresherUploadItem(
  current: KnowledgeUploadItem,
  incoming: KnowledgeUploadItem
): KnowledgeUploadItem {
  if (incoming.attemptNumber !== current.attemptNumber) {
    return incoming.attemptNumber > current.attemptNumber ? incoming : current;
  }
  const timeDifference = Date.parse(incoming.updatedAt) - Date.parse(current.updatedAt);
  if (timeDifference !== 0) return timeDifference > 0 ? incoming : current;
  return uploadStateOrder[incoming.state] >= uploadStateOrder[current.state]
    ? incoming
    : current;
}

export function mergeKnowledgeUploadBatch(
  current: KnowledgeUploadBatch,
  incoming: KnowledgeUploadBatch
): KnowledgeUploadBatch {
  if (current.id !== incoming.id) return incoming;
  const incomingBatchTime = Date.parse(incoming.updatedAt);
  const currentBatchTime = Date.parse(current.updatedAt);
  const incomingBatchIsOlder = incomingBatchTime < currentBatchTime;
  const currentItems = new Map(current.items.map((item) => [item.id, item]));
  const incomingIds = new Set(incoming.items.map((item) => item.id));
  const items = incoming.items.flatMap((item) => {
    const existing = currentItems.get(item.id);
    if (existing) return [fresherUploadItem(existing, item)];
    return incomingBatchIsOlder ? [] : [item];
  });
  if (incomingBatchIsOlder) {
    for (const item of current.items) {
      if (!incomingIds.has(item.id)) items.push(item);
    }
  }
  return {
    createdAt: current.createdAt,
    id: current.id,
    items,
    updatedAt: incomingBatchTime >= currentBatchTime
      ? incoming.updatedAt
      : current.updatedAt
  };
}

export function createKnowledgeLibraryActions() {
  const store = () => useKnowledgeLibraryStore.getState();
  const activeTransfers = new Set<string>();
  const cancellingTransfers = new Set<string>();
  const transferControllers = new Map<string, AbortController>();

  function transferKey(baseId: string, batchId: string, itemId: string): string {
    return `${baseId}:${batchId}:${itemId}`;
  }

  function patchUploadBatch(baseId: string, batch: KnowledgeUploadBatch): void {
    const detail = store().detail;
    if (detail?.baseId !== baseId) return;
    const exists = detail.uploadBatches.some((candidate) => candidate.id === batch.id);
    store().patchDetail({
      uploadBatches: exists
        ? detail.uploadBatches.map((candidate) => candidate.id === batch.id
            ? mergeKnowledgeUploadBatch(candidate, batch)
            : candidate)
        : [batch, ...detail.uploadBatches]
    });
  }

  function patchUploadProgress(baseId: string, itemId: string, uploadedBytes: number | null): void {
    const detail = store().detail;
    if (detail?.baseId !== baseId) return;
    const uploadProgress = { ...detail.uploadProgress };
    if (uploadedBytes === null) delete uploadProgress[itemId];
    else uploadProgress[itemId] = uploadedBytes;
    store().patchDetail({ uploadProgress });
  }

  function patchUploadError(baseId: string, itemId: string, message: string | null): void {
    const detail = store().detail;
    if (detail?.baseId !== baseId) return;
    const uploadErrors = { ...detail.uploadErrors };
    if (message === null) delete uploadErrors[itemId];
    else uploadErrors[itemId] = message;
    store().patchDetail({ uploadErrors });
  }

  function beginOperation(actionId: string): number | null {
    const snapshot = store();
    if (snapshot.busy) return null;
    const requestId = snapshot.operationRequestId + 1;
    snapshot.patch({ busy: true, operationRequestId: requestId });
    if (snapshot.detail) snapshot.patchDetail({ actionId, error: null });
    if (snapshot.sourceDetail) snapshot.patchSourceDetail({ actionId, error: null });
    if (snapshot.create) snapshot.patchCreate({ error: null, saving: true });
    return requestId;
  }

  function ownsOperation(requestId: number): boolean {
    const snapshot = store();
    return snapshot.busy && snapshot.operationRequestId === requestId;
  }

  function finishOperation(requestId: number): boolean {
    if (!ownsOperation(requestId)) return false;
    const snapshot = store();
    snapshot.patch({ busy: false });
    snapshot.patchCreate({ progress: null, saving: false });
    snapshot.patchDetail({ actionId: null });
    snapshot.patchSourceDetail({ actionId: null });
    return true;
  }

  async function refreshList() {
    const snapshot = store();
    const requestId = snapshot.listRequestId + 1;
    snapshot.patch({
      dataError: null,
      dataState: snapshot.data ? "ready" : "loading",
      listRequestId: requestId
    });
    const result = await fetchKnowledgeBaseList();
    if (store().listRequestId !== requestId) return;
    if (!result.ok) {
      const current = store();
      if (current.data) {
        current.patch({ notice: { kind: "error", text: errorText(result.code) } });
      } else {
        current.patch({ dataError: errorText(result.code), dataState: "error" });
      }
      return;
    }
    store().patch({ data: result.data, dataError: null, dataState: "ready" });
  }

  async function refreshSources() {
    const snapshot = store();
    const requestId = snapshot.sourceListRequestId + 1;
    snapshot.patch({
      sourceDataError: null,
      sourceDataState: snapshot.sourceData ? "ready" : "loading",
      sourceListRequestId: requestId
    });
    const result = await fetchKnowledgeSources({
      filter: snapshot.sourceFilter,
      page: snapshot.sourcePage,
      query: snapshot.sourceQuery
    });
    if (store().sourceListRequestId !== requestId) return;
    if (!result.ok) {
      const current = store();
      if (current.sourceData) {
        current.patch({ notice: { kind: "error", text: errorText(result.code) } });
      } else {
        current.patch({
          sourceDataError: errorText(result.code),
          sourceDataState: "error"
        });
      }
      return;
    }
    store().patch({
      sourceData: result.data,
      sourceDataError: null,
      sourceDataState: "ready",
      sourcePage: result.data.pagination.page
    });
  }

  function openLibrary() {
    if (store().busy) return;
    store().patch({
      create: null,
      detail: null,
      notice: null,
      open: true,
      sourceDetail: null,
      task: "list"
    });
    void refreshList();
  }

  function closeLibrary() {
    if (store().busy) return;
    store().patch({
      create: null,
      detail: null,
      notice: null,
      open: false,
      sourceDetail: null,
      task: "list"
    });
  }

  function setCatalog(catalog: "bases" | "sources") {
    const snapshot = store();
    if (snapshot.busy || snapshot.catalog === catalog) return;
    snapshot.patch({ catalog, notice: null });
    if (catalog === "sources" && !snapshot.sourceData) void refreshSources();
  }

  function openCreate() {
    const snapshot = store();
    if (snapshot.busy) return;
    if (!snapshot.data?.viewer.canCreate) {
      snapshot.patch({
        notice: {
          kind: "error",
          text: "Knowledge is temporarily unavailable. Contact your administrator."
        }
      });
      return;
    }
    const draft: KnowledgeCreateDraft = {
      description: "",
      files: [],
      name: ""
    };
    snapshot.patch({
      catalog: "bases",
      create: {
        baseline: createBaseline(draft),
        draft,
        error: null,
        progress: null,
        saving: false
      },
      detail: null,
      notice: null,
      sourceDetail: null,
      task: "create"
    });
  }

  function closeCreate() {
    if (store().busy) return;
    store().patch({ create: null, notice: null, task: "list" });
  }

  async function saveCreate() {
    const current = store().create;
    if (!current) return;
    const name = current.draft.name.trim();
    const description = current.draft.description.trim();
    const files = [...current.draft.files];
    if (!name) {
      store().patchCreate({
        error: {
          code: "knowledge_base_input_invalid",
          text: "Give this base a name."
        }
      });
      return;
    }
    const requestId = beginOperation("create");
    if (requestId === null) return;
    const result = await createKnowledgeBase({
      description,
      name
    });
    if (!ownsOperation(requestId)) return;
    if (!result.ok) {
      finishOperation(requestId);
      store().patchCreate({ error: { code: result.code, text: errorText(result.code) } });
      return;
    }
    upsertSummary(store(), result.data);
    store().patch({
      create: null,
      detail: blankDetail(result.data.id, result.data),
      notice: {
        kind: "success",
        text: files.length > 0
          ? `Knowledge base created. Preparing ${files.length} file${files.length === 1 ? "" : "s"} in the intake queue.`
          : "Knowledge base created. Add files whenever you are ready."
      },
      task: "detail"
    });
    finishOperation(requestId);
    void refreshDetail(result.data.id, true);
    void refreshList();
    if (files.length > 0) void beginUploadBatch(result.data.id, files);
  }

  function ownsDetailRequest(baseId: string, requestId: number): boolean {
    const detail = store().detail;
    return Boolean(
      store().open &&
      store().task === "detail" &&
      detail?.baseId === baseId &&
      detail.requestId === requestId
    );
  }

  async function refreshDetail(baseId = store().detail?.baseId ?? "", quiet = false) {
    const current = store().detail;
    if (!baseId || !current || current.baseId !== baseId) return;
    const requestId = current.requestId + 1;
    store().patchDetail({
      dataError: null,
      dataState: current.base && current.sources ? "ready" : "loading",
      requestId
    });
    const [detailResult, sourcesResult, uploadResult] = await Promise.all([
      fetchKnowledgeBaseDetail(baseId),
      fetchKnowledgeSources({
        baseId,
        filter: "all",
        page: current.sourcePage,
        pageSize: KNOWLEDGE_SOURCE_PAGE_SIZE,
        query: current.sourceQuery
      }),
      fetchKnowledgeUploadBatches(baseId)
    ]);
    if (!ownsDetailRequest(baseId, requestId)) return;
    if (!detailResult.ok || !sourcesResult.ok || !uploadResult.ok) {
      const code = !detailResult.ok
        ? detailResult.code
        : !sourcesResult.ok
          ? sourcesResult.code
          : !uploadResult.ok
            ? uploadResult.code
          : "knowledge_response_invalid";
      const latest = store().detail;
      if (latest?.base && latest.sources) {
        if (!quiet) store().patch({ notice: { kind: "error", text: errorText(code) } });
        store().patchDetail({ dataState: "ready" });
      } else {
        store().patchDetail({ dataError: errorText(code), dataState: "error" });
      }
      return;
    }
    const latest = store().detail;
    if (!latest) return;
    const dirty = detailBaseline(latest.draft) !== latest.baseline;
    const nextDraft = {
      description: detailResult.data.description,
      name: detailResult.data.name
    };
    store().patchDetail({
      base: dirty && latest.base ? latest.base : detailResult.data,
      baseline: dirty ? latest.baseline : detailBaseline(nextDraft),
      dataError: null,
      dataState: "ready",
      draft: dirty ? latest.draft : nextDraft,
      sourcePage: sourcesResult.data.pagination.page,
      sourceQuery: sourcesResult.data.pagination.query,
      sources: sourcesResult.data,
      uploadBatches: uploadResult.data.batches.map((batch) => {
        const currentBatch = latest.uploadBatches.find(({ id }) => id === batch.id);
        return currentBatch ? mergeKnowledgeUploadBatch(currentBatch, batch) : batch;
      })
    });
    for (const batch of uploadResult.data.batches) {
      for (const item of batch.items) {
        if (item.state === "upload_complete") {
          void transferUploadItem(baseId, batch, item, null);
        }
      }
    }
    if (!dirty) upsertSummary(store(), detailResult.data);
  }

  function openDetail(baseId: string) {
    if (store().busy) return;
    store().patch({
      create: null,
      detail: blankDetail(baseId),
      notice: null,
      sourceDetail: null,
      task: "detail"
    });
    void refreshDetail(baseId);
  }

  function openEvidence(baseId: string) {
    if (store().busy) return;
    store().patch({ open: true });
    openDetail(baseId);
    void refreshList();
  }

  function closeDetail() {
    if (store().busy) return;
    store().patch({ detail: null, notice: null, task: "list" });
  }

  function ownsSourceDetailRequest(sourceId: string, requestId: number): boolean {
    const detail = store().sourceDetail;
    return Boolean(
      store().open &&
      store().task === "source-detail" &&
      detail?.sourceId === sourceId &&
      detail.requestId === requestId
    );
  }

  async function refreshSourceDetail(sourceId = store().sourceDetail?.sourceId ?? "", quiet = false) {
    const current = store().sourceDetail;
    if (!sourceId || !current || current.sourceId !== sourceId) return;
    const requestId = current.requestId + 1;
    store().patchSourceDetail({
      dataError: null,
      dataState: current.source ? "ready" : "loading",
      requestId
    });
    const result = await fetchKnowledgeSourceDetail(sourceId);
    if (!ownsSourceDetailRequest(sourceId, requestId)) return;
    if (!result.ok) {
      const latest = store().sourceDetail;
      if (latest?.source) {
        if (!quiet) store().patch({ notice: { kind: "error", text: errorText(result.code) } });
        store().patchSourceDetail({ dataState: "ready" });
      } else {
        store().patchSourceDetail({ dataError: errorText(result.code), dataState: "error" });
      }
      return;
    }
    const latest = store().sourceDetail;
    if (!latest) return;
    const dirty = sourceBaseline(latest.draft) !== latest.baseline;
    const draft = sourceDraft(result.data);
    store().patchSourceDetail({
      baseline: dirty ? latest.baseline : sourceBaseline(draft),
      dataError: null,
      dataState: "ready",
      draft: dirty ? latest.draft : draft,
      source: dirty && latest.source ? latest.source : result.data
    });
    if (!dirty) upsertSourceSummary(store(), result.data);
  }

  function openSourceDetail(sourceId: string, returnBaseId: string | null = null) {
    if (store().busy) return;
    const retainedDetail = returnBaseId && store().detail?.baseId === returnBaseId
      ? store().detail
      : null;
    store().patch({
      catalog: returnBaseId ? "bases" : "sources",
      create: null,
      detail: retainedDetail,
      notice: null,
      sourceDetail: blankSourceDetail(sourceId, returnBaseId),
      task: "source-detail"
    });
    void refreshSourceDetail(sourceId);
  }

  function closeSourceDetail() {
    if (store().busy) return;
    const returnBaseId = store().sourceDetail?.returnBaseId;
    if (returnBaseId && store().detail?.baseId === returnBaseId) {
      store().patch({
        catalog: "bases",
        notice: null,
        sourceDetail: null,
        task: "detail"
      });
      void refreshDetail(returnBaseId, true);
      return;
    }
    store().patch({
      catalog: "sources",
      notice: null,
      sourceDetail: null,
      task: "list"
    });
  }

  async function saveSourceDetail() {
    const detail = store().sourceDetail;
    if (!detail?.source?.owned) return;
    const name = detail.draft.name.trim();
    const description = detail.draft.description.trim();
    const tags = detail.draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
    if (!name) {
      store().patchSourceDetail({
        error: { code: "knowledge_source_input_invalid", text: "Give this Source a name." }
      });
      return;
    }
    const requestId = beginOperation("source:settings");
    if (requestId === null) return;
    const result = await updateKnowledgeSource(detail.source.id, {
      description,
      expectedVersion: detail.source.version,
      name,
      tags
    });
    if (!ownsOperation(requestId)) return;
    if (!result.ok) {
      finishOperation(requestId);
      store().patchSourceDetail({ error: { code: result.code, text: errorText(result.code) } });
      return;
    }
    const draft = sourceDraft(result.data);
    store().patchSourceDetail({
      baseline: sourceBaseline(draft),
      draft,
      error: null,
      source: result.data
    });
    upsertSourceSummary(store(), result.data);
    finishOperation(requestId);
    store().patch({ notice: { kind: "success", text: "Source details saved." } });
  }

  function sourceMembershipActionAllowed(): KnowledgeSourceDetailState | null {
    const detail = store().sourceDetail;
    if (!detail?.source?.owned) return null;
    if (sourceBaseline(detail.draft) !== detail.baseline) {
      store().patch({ notice: { kind: "error", text: "Save or discard Source changes first." } });
      return null;
    }
    return detail;
  }

  async function replaceSource(file: File) {
    const detail = sourceMembershipActionAllowed();
    if (!detail?.source || detail.source.trashed || detail.source.deletionPending) return;
    const requestId = beginOperation("source:replace");
    if (requestId === null) return;
    const result = await replaceKnowledgeSource(detail.source.id, file);
    if (!ownsOperation(requestId)) return;
    if (!result.ok) {
      finishOperation(requestId);
      store().patch({ notice: { kind: "error", text: errorText(result.code) } });
      return;
    }
    const draft = sourceDraft(result.data);
    store().patchSourceDetail({
      baseline: sourceBaseline(draft),
      draft,
      source: result.data
    });
    upsertSourceSummary(store(), result.data);
    finishOperation(requestId);
    store().patch({
      notice: {
        kind: "success",
        text: "Replacement uploaded. The current ready version stays available while it processes."
      }
    });
    void refreshList();
  }

  async function reprocessSource() {
    const detail = sourceMembershipActionAllowed();
    if (!detail?.source || detail.source.trashed || detail.source.deletionPending) return;
    const requestId = beginOperation("source:reprocess");
    if (requestId === null) return;
    const result = await reprocessKnowledgeSource(detail.source.id);
    if (!ownsOperation(requestId)) return;
    if (!result.ok) {
      finishOperation(requestId);
      store().patch({ notice: { kind: "error", text: errorText(result.code) } });
      return;
    }
    const draft = sourceDraft(result.data);
    store().patchSourceDetail({
      baseline: sourceBaseline(draft),
      draft,
      source: result.data
    });
    upsertSourceSummary(store(), result.data);
    finishOperation(requestId);
    store().patch({
      notice: { kind: "success", text: "Source processing restarted." }
    });
  }

  async function addSourceToBases(baseIds: readonly string[]) {
    const detail = sourceMembershipActionAllowed();
    if (!detail || baseIds.length === 0) return;
    const requestId = beginOperation("source:add");
    if (requestId === null) return;
    const result = await addKnowledgeSourceMemberships(detail.source!.id, baseIds);
    if (!ownsOperation(requestId)) return;
    if (!result.ok) {
      finishOperation(requestId);
      store().patch({ notice: { kind: "error", text: errorText(result.code) } });
      return;
    }
    const draft = sourceDraft(result.data);
    store().patchSourceDetail({
      baseline: sourceBaseline(draft),
      draft,
      source: result.data
    });
    upsertSourceSummary(store(), result.data);
    finishOperation(requestId);
    store().patch({
      notice: {
        kind: "success",
        text: `Source added to ${baseIds.length} base${baseIds.length === 1 ? "" : "s"}.`
      }
    });
    void refreshList();
  }

  async function removeSourceFromBase(baseId: string) {
    const detail = sourceMembershipActionAllowed();
    if (!detail) return;
    const requestId = beginOperation(`source:remove:${baseId}`);
    if (requestId === null) return;
    const result = await removeKnowledgeSourceMembership(detail.source!.id, baseId);
    if (!ownsOperation(requestId)) return;
    if (!result.ok) {
      finishOperation(requestId);
      store().patch({ notice: { kind: "error", text: errorText(result.code) } });
      return;
    }
    const draft = sourceDraft(result.data);
    store().patchSourceDetail({
      baseline: sourceBaseline(draft),
      draft,
      source: result.data
    });
    upsertSourceSummary(store(), result.data);
    finishOperation(requestId);
    store().patch({
      notice: {
        kind: "success",
        text: "Source removed from the base. The Source and accepted chat history are unchanged."
      }
    });
    void refreshList();
  }

  async function moveSourceMembership(fromBaseId: string, toBaseId: string) {
    const detail = sourceMembershipActionAllowed();
    if (!detail || fromBaseId === toBaseId) return;
    const requestId = beginOperation(`source:move:${fromBaseId}`);
    if (requestId === null) return;
    const result = await moveKnowledgeSource(detail.source!.id, { fromBaseId, toBaseId });
    if (!ownsOperation(requestId)) return;
    if (!result.ok) {
      finishOperation(requestId);
      store().patch({ notice: { kind: "error", text: errorText(result.code) } });
      return;
    }
    const draft = sourceDraft(result.data);
    store().patchSourceDetail({
      baseline: sourceBaseline(draft),
      draft,
      source: result.data
    });
    upsertSourceSummary(store(), result.data);
    finishOperation(requestId);
    store().patch({
      notice: {
        kind: "success",
        text: "Source moved. Future chats use the new Base membership; accepted chats are unchanged."
      }
    });
    void refreshList();
  }

  function setSourceQuery(query: string) {
    const snapshot = store();
    if (snapshot.busy) return;
    snapshot.patch({
      sourcePage: 1,
      sourceQuery: query.slice(0, KNOWLEDGE_SOURCE_SEARCH_MAX_LENGTH)
    });
    void refreshSources();
  }

  function setSourceFilter(filter: "all" | "shared" | "trash" | "yours") {
    const snapshot = store();
    if (snapshot.busy || snapshot.sourceFilter === filter) return;
    snapshot.patch({ sourceFilter: filter, sourcePage: 1 });
    void refreshSources();
  }

  function setSourcePage(page: number) {
    const snapshot = store();
    if (snapshot.busy || !Number.isSafeInteger(page) || page < 1) return;
    const maximum = Math.max(1, snapshot.sourceData?.pagination.totalPages ?? 1);
    const next = Math.min(page, maximum);
    if (next === snapshot.sourcePage) return;
    snapshot.patch({ sourcePage: next });
    void refreshSources();
  }

  async function saveDetail() {
    const detail = store().detail;
    if (!detail?.base?.owned) return;
    const name = detail.draft.name.trim();
    const description = detail.draft.description.trim();
    if (!name) {
      store().patchDetail({
        error: { code: "knowledge_base_input_invalid", text: "Give this base a name." }
      });
      return;
    }
    const requestId = beginOperation("settings");
    if (requestId === null) return;
    const result = await updateKnowledgeBase(detail.base.id, {
      description,
      expectedVersion: detail.base.version,
      name
    });
    if (!ownsOperation(requestId)) return;
    if (!result.ok) {
      finishOperation(requestId);
      store().patchDetail({ error: { code: result.code, text: errorText(result.code) } });
      return;
    }
    const draft = { description: result.data.description, name: result.data.name };
    store().patchDetail({
      base: result.data,
      baseline: detailBaseline(draft),
      draft,
      error: null
    });
    upsertSummary(store(), result.data);
    store().patch({ notice: { kind: "success", text: "Base settings saved." } });
    finishOperation(requestId);
  }

  function lifecycleBase() {
    const snapshot = store();
    const detail = snapshot.detail;
    if (!detail?.base?.owned || detail.base.deletionPending) return null;
    if (detailBaseline(detail.draft) !== detail.baseline) {
      snapshot.patch({ notice: { kind: "error", text: "Save or discard base setting changes first." } });
      return null;
    }
    return detail;
  }

  async function setBaseTrashed(trashed: boolean) {
    const detail = lifecycleBase();
    if (!detail || detail.base!.trashed === trashed) return;
    const requestId = beginOperation(trashed ? "base:trash" : "base:restore");
    if (requestId === null) return;
    const result = trashed
      ? await trashKnowledgeBase(detail.base!.id, detail.base!.version)
      : await restoreKnowledgeBase(detail.base!.id, detail.base!.version);
    if (!ownsOperation(requestId)) return;
    if (!result.ok) {
      finishOperation(requestId);
      store().patch({ notice: { kind: "error", text: errorText(result.code) } });
      return;
    }
    finishOperation(requestId);
    store().patch({
      notice: {
        kind: "success",
        text: trashed
          ? "Knowledge base moved to Trash. Future runs can no longer use it."
          : "Knowledge base restored with its Sources and sharing settings."
      }
    });
    void refreshDetail(detail.base!.id, true);
    void refreshList();
  }

  async function permanentlyDeleteBase() {
    const detail = lifecycleBase();
    if (!detail?.base?.trashed) return;
    const requestId = beginOperation("base:delete");
    if (requestId === null) return;
    const result = await permanentlyDeleteKnowledgeBase(detail.base.id, detail.base.version);
    if (!ownsOperation(requestId)) return;
    if (!result.ok) {
      finishOperation(requestId);
      store().patch({ notice: { kind: "error", text: errorText(result.code) } });
      return;
    }
    finishOperation(requestId);
    store().patch({
      detail: null,
      notice: {
        kind: "success",
        text: "Permanent base deletion started. Its canonical Sources remain in your library."
      },
      task: "list"
    });
    void refreshList();
    if (store().sourceData) void refreshSources();
  }

  function lifecycleSource() {
    const snapshot = store();
    const detail = snapshot.sourceDetail;
    if (!detail?.source?.owned || detail.source.deletionPending) return null;
    if (sourceBaseline(detail.draft) !== detail.baseline) {
      snapshot.patch({ notice: { kind: "error", text: "Save or discard Source changes first." } });
      return null;
    }
    return detail;
  }

  async function setSourceTrashed(trashed: boolean) {
    const detail = lifecycleSource();
    if (!detail || detail.source!.trashed === trashed) return;
    const requestId = beginOperation(trashed ? "source:trash" : "source:restore");
    if (requestId === null) return;
    const result = trashed
      ? await trashKnowledgeSource(detail.source!.id, detail.source!.version)
      : await restoreKnowledgeSource(detail.source!.id, detail.source!.version);
    if (!ownsOperation(requestId)) return;
    if (!result.ok) {
      finishOperation(requestId);
      store().patch({ notice: { kind: "error", text: errorText(result.code) } });
      return;
    }
    finishOperation(requestId);
    store().patch({
      notice: {
        kind: "success",
        text: trashed
          ? "Source moved to Trash. Future runs exclude it from every base."
          : "Source restored to its previous Base memberships."
      }
    });
    void refreshSourceDetail(detail.source!.id, true);
    void refreshSources();
    void refreshList();
  }

  async function permanentlyDeleteSource() {
    const detail = lifecycleSource();
    if (!detail?.source?.trashed) return;
    const requestId = beginOperation("source:delete");
    if (requestId === null) return;
    const result = await permanentlyDeleteKnowledgeSource(detail.source.id, detail.source.version);
    if (!ownsOperation(requestId)) return;
    if (!result.ok) {
      finishOperation(requestId);
      store().patch({ notice: { kind: "error", text: errorText(result.code) } });
      return;
    }
    finishOperation(requestId);
    store().patch({
      notice: {
        kind: "success",
        text: "Permanent Source deletion started. Past answers keep only generic citation handles."
      },
      sourceDetail: null,
      task: "list"
    });
    void refreshSources();
    void refreshList();
  }

  async function setArchived(baseId: string, archived: boolean) {
    const snapshot = store();
    const detail = snapshot.detail?.baseId === baseId ? snapshot.detail : null;
    const base = detail?.base ?? snapshot.data?.knowledgeBases.find((candidate) => candidate.id === baseId);
    if (!base?.owned) return;
    if (detail && detailBaseline(detail.draft) !== detail.baseline) {
      snapshot.patch({ notice: { kind: "error", text: "Save or discard base setting changes first." } });
      return;
    }
    const requestId = beginOperation(`base:${baseId}:archive`);
    if (requestId === null) return;
    const result = await updateKnowledgeBase(baseId, {
      archived,
      expectedVersion: base.version
    });
    if (!ownsOperation(requestId)) return;
    if (!result.ok) {
      finishOperation(requestId);
      store().patch({ notice: { kind: "error", text: errorText(result.code) } });
      return;
    }
    upsertSummary(store(), result.data);
    if (store().detail?.baseId === baseId) {
      const draft = { description: result.data.description, name: result.data.name };
      store().patchDetail({
        base: result.data,
        baseline: detailBaseline(draft),
        draft
      });
    }
    store().patch({
      notice: {
        kind: "success",
        text: archived
          ? "Knowledge base archived. Its history is unchanged."
          : "Knowledge base restored."
      }
    });
    finishOperation(requestId);
  }

  async function transferUploadItem(
    baseId: string,
    initialBatch: KnowledgeUploadBatch,
    initialItem: KnowledgeUploadItem,
    file: File | null
  ): Promise<string | null> {
    const key = transferKey(baseId, initialBatch.id, initialItem.id);
    if (activeTransfers.has(key)) return null;
    if (initialItem.state !== "upload_complete" &&
      (!file || file.name !== initialItem.fileName || file.size !== initialItem.byteSize)) {
      patchUploadError(
        baseId,
        initialItem.id,
        `Select the original “${initialItem.fileName}” file (${initialItem.byteSize} bytes).`
      );
      return "knowledge_upload_file_mismatch";
    }
    activeTransfers.add(key);
    const controller = new AbortController();
    transferControllers.set(key, controller);
    patchUploadError(baseId, initialItem.id, null);
    patchUploadProgress(baseId, initialItem.id, initialItem.uploadedBytes);

    const fail = (code: string): string | null => {
      if (code !== "knowledge_upload_cancelled" && !cancellingTransfers.has(key)) {
        patchUploadError(baseId, initialItem.id, errorText(code));
        return code;
      }
      return "knowledge_upload_cancelled";
    };

    try {
      let batch = initialBatch;
      let item = initialItem;
      if (item.state === "cancelled" || uploadItemSettled(item)) return null;
      const restartInterruptedProxy = item.state === "uploading" &&
        item.transport?.kind === "proxy";
      if (item.state === "needs_attention" || restartInterruptedProxy) {
        if (item.state === "needs_attention" && item.sourceId) {
          return fail("knowledge_processing_failed");
        }
        const retried = await retryKnowledgeUploadItem(
          baseId,
          batch.id,
          item.id,
          item.attemptNumber
        );
        if (!retried.ok) return fail(retried.code);
        batch = retried.data;
        patchUploadBatch(baseId, batch);
        item = uploadItemInBatch(batch, item.id)!;
      }

      if (item.state !== "upload_complete") {
        let started = await startKnowledgeUploadItem(
          baseId,
          batch.id,
          item.id,
          item.attemptNumber
        );
        if (!started.ok && started.code === "knowledge_upload_session_expired") {
          const retried = await retryKnowledgeUploadItem(
            baseId,
            batch.id,
            item.id,
            item.attemptNumber
          );
          if (!retried.ok) return fail(retried.code);
          batch = retried.data;
          patchUploadBatch(baseId, batch);
          item = uploadItemInBatch(batch, item.id)!;
          started = await startKnowledgeUploadItem(
            baseId,
            batch.id,
            item.id,
            item.attemptNumber
          );
        }
        if (!started.ok) return fail(started.code);
        batch = started.data;
        patchUploadBatch(baseId, batch);
        item = uploadItemInBatch(batch, item.id)!;
        if (!item.transport) return fail("knowledge_upload_conflict");
        if (!file) return fail("knowledge_upload_not_available");

        if (item.transport.kind === "proxy") {
          const uploaded = await uploadKnowledgeProxyContent(item.transport.uploadUrl, file, {
            onProgress(uploadedBytes) {
              patchUploadProgress(baseId, item.id, uploadedBytes);
            },
            signal: controller.signal
          });
          if (!uploaded.ok) return fail(uploaded.code);
          batch = uploaded.data;
          patchUploadBatch(baseId, batch);
          item = uploadItemInBatch(batch, item.id)!;
        } else {
          const parts = item.transport.parts;
          let completedBytes = parts.reduce(
            (total, part) => total + (part.complete ? part.byteSize : 0),
            0
          );
          patchUploadProgress(baseId, item.id, completedBytes);
          for (const part of parts) {
            if (part.complete) continue;
            if (!part.uploadUrl) return fail("knowledge_upload_conflict");
            const body = file.slice(
              part.byteOffset,
              part.byteOffset + part.byteSize,
              file.type || "application/octet-stream"
            );
            const uploaded = await uploadKnowledgeMultipartPart(part.uploadUrl, body, {
              onProgress(uploadedBytes) {
                patchUploadProgress(baseId, item.id, completedBytes + uploadedBytes);
              },
              signal: controller.signal
            });
            if (!uploaded.ok) return fail(uploaded.code);
            const checkpointed = await checkpointKnowledgeUploadPart(
              baseId,
              batch.id,
              item.id,
              part.partNumber,
              {
                attemptNumber: item.attemptNumber,
                byteSize: part.byteSize,
                etag: uploaded.data
              }
            );
            if (!checkpointed.ok) return fail(checkpointed.code);
            completedBytes += part.byteSize;
            batch = checkpointed.data;
            patchUploadBatch(baseId, batch);
            patchUploadProgress(baseId, item.id, completedBytes);
          }
        }
      }

      const settled = await settleKnowledgeUploadItem(
        baseId,
        batch.id,
        item.id,
        item.attemptNumber
      );
      if (!settled.ok) return fail(settled.code);
      patchUploadBatch(baseId, settled.data);
      patchUploadError(baseId, item.id, null);
      return null;
    } catch {
      return fail("network_unavailable");
    } finally {
      activeTransfers.delete(key);
      transferControllers.delete(key);
      patchUploadProgress(baseId, initialItem.id, null);
    }
  }

  async function beginUploadBatch(baseId: string, files: readonly File[]): Promise<void> {
    if (files.length === 0) return;
    const filesByClientId = new Map<string, File>();
    const admissionFiles = files.map((file) => {
      const clientFileId = newKnowledgeUploadClientId("file");
      filesByClientId.set(clientFileId, file);
      return {
        byteSize: file.size,
        clientFileId,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream"
      };
    });
    const created = await createKnowledgeUploadBatch(baseId, {
      clientBatchId: newKnowledgeUploadClientId("batch"),
      files: admissionFiles
    });
    if (!created.ok) {
      if (store().detail?.baseId === baseId) {
        store().patch({ notice: { kind: "error", text: errorText(created.code) } });
      }
      return;
    }
    patchUploadBatch(baseId, created.data);
    if (store().detail?.baseId === baseId) {
      store().patch({
        notice: {
          kind: "success",
          text: `${files.length} file${files.length === 1 ? "" : "s"} added. Uploads continue independently.`
        }
      });
    }

    const failures: string[] = [];
    await mapUploadsBounded(created.data.items, async (item) => {
      const file = filesByClientId.get(item.clientFileId);
      if (!file) {
        failures.push("knowledge_upload_not_available");
        return;
      }
      const failure = await transferUploadItem(baseId, created.data, item, file);
      if (failure) failures.push(failure);
    });
    const cancelled = failures.filter((code) => code === "knowledge_upload_cancelled").length;
    const actionableFailures = failures.filter((code) => code !== "knowledge_upload_cancelled");
    if (store().detail?.baseId === baseId) {
      store().patch({
        notice: actionableFailures.length > 0
          ? {
              kind: "error",
              text: `${actionableFailures.length} file${actionableFailures.length === 1 ? " needs" : "s need"} attention. Other files continue independently.`
            }
          : cancelled > 0
            ? {
                kind: "success",
                text: `${cancelled} file${cancelled === 1 ? "" : "s"} cancelled. Other files continue independently.`
              }
          : {
              kind: "success",
              text: `${files.length} file${files.length === 1 ? "" : "s"} uploaded. Processing continues independently.`
            }
      });
      void refreshDetail(baseId, true);
    }
    void refreshList();
    void refreshSources();
  }

  async function uploadFiles(files: readonly File[]) {
    const detail = store().detail;
    if (!detail?.base?.owned || detail.base.archived || files.length === 0) return;
    await beginUploadBatch(detail.base.id, files);
  }

  async function resumeUpload(batchId: string, itemId: string, file: File): Promise<void> {
    const detail = store().detail;
    const batch = detail?.uploadBatches.find((candidate) => candidate.id === batchId);
    const item = batch ? uploadItemInBatch(batch, itemId) : null;
    if (!detail?.base?.owned || !batch || !item) return;
    await transferUploadItem(detail.baseId, batch, item, file);
    if (store().detail?.baseId === detail.baseId) void refreshDetail(detail.baseId, true);
  }

  async function cancelUpload(batchId: string, itemId: string): Promise<void> {
    const detail = store().detail;
    if (!detail?.base?.owned) return;
    const item = detail.uploadBatches
      .find((candidate) => candidate.id === batchId)
      ?.items.find((candidate) => candidate.id === itemId);
    if (!item) return;
    const key = transferKey(detail.baseId, batchId, itemId);
    if (cancellingTransfers.has(key)) return;
    cancellingTransfers.add(key);
    transferControllers.get(key)?.abort();
    try {
      const cancelled = await cancelKnowledgeUploadItem(
        detail.baseId,
        batchId,
        itemId,
        item.attemptNumber
      );
      if (!cancelled.ok) {
        patchUploadError(detail.baseId, itemId, errorText(cancelled.code));
        void refreshDetail(detail.baseId, true);
        return;
      }
      patchUploadBatch(detail.baseId, cancelled.data);
      patchUploadError(detail.baseId, itemId, null);
      patchUploadProgress(detail.baseId, itemId, null);
    } finally {
      cancellingTransfers.delete(key);
    }
  }

  async function removeSourceFromDetail(sourceId: string) {
    const detail = store().detail;
    if (!detail?.base?.owned) return;
    const requestId = beginOperation(`base-source:${sourceId}:remove`);
    if (requestId === null) return;
    const result = await removeKnowledgeSourceMembership(sourceId, detail.base.id);
    if (!ownsOperation(requestId)) return;
    if (!result.ok) {
      finishOperation(requestId);
      store().patch({ notice: { kind: "error", text: errorText(result.code) } });
      return;
    }
    finishOperation(requestId);
    store().patch({
      notice: {
        kind: "success",
        text: "Source removed from this Knowledge base. It remains in your Source library."
      }
    });
    void refreshDetail(detail.base.id, true);
    void refreshList();
  }

  function setDetailSourceQuery(query: string) {
    const detail = store().detail;
    if (!detail || store().busy) return;
    const normalized = query.slice(0, KNOWLEDGE_SOURCE_SEARCH_MAX_LENGTH);
    store().patchDetail({ sourcePage: 1, sourceQuery: normalized });
    void refreshDetail(detail.baseId, true);
  }

  function setDetailSourcePage(page: number) {
    const detail = store().detail;
    if (!detail || store().busy || !Number.isSafeInteger(page) || page < 1) return;
    const maximum = Math.max(1, detail.sources?.pagination.totalPages ?? 1);
    const next = Math.min(page, maximum);
    if (next === detail.sourcePage) return;
    store().patchDetail({ sourcePage: next });
    void refreshDetail(detail.baseId, true);
  }

  async function publish(input: Parameters<typeof publishKnowledgeBase>[1]) {
    const detail = store().detail;
    if (!detail?.base?.owned) return;
    const requestId = beginOperation("publication");
    if (requestId === null) return;
    const result = await publishKnowledgeBase(detail.base.id, input);
    if (!ownsOperation(requestId)) return;
    if (!result.ok) {
      finishOperation(requestId);
      store().patch({ notice: { kind: "error", text: errorText(result.code) } });
      return;
    }
    const publications = detail.base.publications ?? [];
    const next = publications.some((publication) => publication.id === result.data.id)
      ? publications.map((publication) => publication.id === result.data.id ? result.data : publication)
      : [...publications, result.data];
    const base = { ...detail.base, publications: next };
    store().patchDetail({ base });
    upsertSummary(store(), base);
    finishOperation(requestId);
    store().patch({ notice: { kind: "success", text: "Knowledge base published." } });
  }

  async function revokePublication(publicationId: string) {
    const detail = store().detail;
    if (!detail?.base?.owned) return;
    const requestId = beginOperation(`publication:${publicationId}`);
    if (requestId === null) return;
    const result = await revokeKnowledgeBasePublication(detail.base.id, publicationId);
    if (!ownsOperation(requestId)) return;
    if (!result.ok) {
      finishOperation(requestId);
      store().patch({ notice: { kind: "error", text: errorText(result.code) } });
      return;
    }
    const publications = (detail.base.publications ?? []).filter(
      (publication) => publication.id !== publicationId
    );
    const base = { ...detail.base, publications };
    store().patchDetail({ base });
    upsertSummary(store(), base);
    finishOperation(requestId);
    store().patch({
      notice: {
        kind: "success",
        text: "Publication revoked. Future runs lose access; already accepted runs are unchanged."
      }
    });
  }

  return {
    addSourceToBases,
    cancelUpload,
    closeCreate,
    closeDetail,
    closeLibrary,
    closeSourceDetail,
    openCreate,
    openDetail,
    openEvidence,
    openLibrary,
    openSourceDetail,
    permanentlyDeleteBase,
    permanentlyDeleteSource,
    publish,
    refreshDetail,
    refreshList,
    refreshSourceDetail,
    refreshSources,
    reprocessSource,
    removeSourceFromDetail,
    removeSourceFromBase,
    replaceSource,
    resumeUpload,
    revokePublication,
    saveCreate,
    saveDetail,
    saveSourceDetail,
    setCatalog,
    setBaseTrashed,
    setDetailSourcePage,
    setDetailSourceQuery,
    setSourceFilter,
    setSourcePage,
    setSourceQuery,
    setSourceTrashed,
    setArchived,
    moveSourceMembership,
    uploadFiles
  };
}

export type KnowledgeLibraryActions = ReturnType<typeof createKnowledgeLibraryActions>;

export function buildKnowledgeLibraryView(
  actions: KnowledgeLibraryActions,
  snapshot: ReturnType<typeof useKnowledgeLibraryStore.getState>
): KnowledgeLibraryView | null {
  if (!snapshot.open) return null;
  const creation = snapshot.create;
  const detail = snapshot.detail;
  const sourceDetail = snapshot.sourceDetail;
  return {
    busy: snapshot.busy,
    create: creation
      ? {
          dirty: createBaseline(creation.draft) !== creation.baseline,
          draft: creation.draft,
          error: creation.error,
          maxUploadBytes: snapshot.data?.viewer.maxUploadBytes ?? 0,
          onCancel: actions.closeCreate,
          onChange(update) {
            const current = useKnowledgeLibraryStore.getState();
            if (current.busy || !current.create) return;
            current.patchCreate({ draft: { ...current.create.draft, ...update }, error: null });
          },
          onSave() {
            void actions.saveCreate();
          },
          progress: creation.progress,
          saving: creation.saving
        }
      : null,
    dataError: snapshot.dataError,
    dataState: snapshot.dataState,
    detail: detail
      ? {
          actionId: detail.actionId,
          base: detail.base,
          canPublishInstallation: snapshot.data?.viewer.canPublishInstallation ?? false,
          dataError: detail.dataError,
          dataState: detail.dataState,
          dirty: detailBaseline(detail.draft) !== detail.baseline,
          draft: detail.draft,
          error: detail.error,
          maxUploadBytes: snapshot.data?.viewer.maxUploadBytes ?? 0,
          onArchiveToggle(archived) {
            void actions.setArchived(detail.baseId, archived);
          },
          onBack: actions.closeDetail,
          onCancelUpload(batchId, itemId) {
            void actions.cancelUpload(batchId, itemId);
          },
          onChange(update) {
            const current = useKnowledgeLibraryStore.getState();
            if (current.busy || !current.detail) return;
            current.patchDetail({ draft: { ...current.detail.draft, ...update }, error: null });
          },
          onDeletePermanently() {
            void actions.permanentlyDeleteBase();
          },
          onPublish(input) {
            void actions.publish(input);
          },
          onRefresh() {
            void actions.refreshDetail(detail.baseId, true);
          },
          onOpenSource(sourceId) {
            actions.openSourceDetail(sourceId, detail.baseId);
          },
          onRemoveSource(sourceId) {
            void actions.removeSourceFromDetail(sourceId);
          },
          onResumeUpload(batchId, itemId, file) {
            void actions.resumeUpload(batchId, itemId, file);
          },
          onRevokePublication(publicationId) {
            void actions.revokePublication(publicationId);
          },
          onSave() {
            void actions.saveDetail();
          },
          onRestore() {
            void actions.setBaseTrashed(false);
          },
          onTrash() {
            void actions.setBaseTrashed(true);
          },
          onUpload(files) {
            void actions.uploadFiles(files);
          },
          publishableGroups: snapshot.data?.publishableGroups ?? [],
          sourcePage: detail.sourcePage,
          sourceQuery: detail.sourceQuery,
          sources: detail.sources,
          onSourcePageChange(page) {
            actions.setDetailSourcePage(page);
          },
          onSourceQueryChange(query) {
            actions.setDetailSourceQuery(query);
          },
          uploadBatches: detail.uploadBatches,
          uploadErrors: detail.uploadErrors,
          uploadProgress: detail.uploadProgress
        }
      : null,
    list: {
      catalog: snapshot.catalog,
      canCreate: snapshot.data?.viewer.canCreate ?? false,
      filter: snapshot.filter,
      knowledgeBases: snapshot.data?.knowledgeBases ?? [],
      onArchiveToggle(baseId, archived) {
        void actions.setArchived(baseId, archived);
      },
      onFilterChange(filter) {
        const current = useKnowledgeLibraryStore.getState();
        if (!current.busy) current.patch({ filter });
      },
      onCatalogChange(catalog) {
        actions.setCatalog(catalog);
      },
      onNewBase: actions.openCreate,
      onOpenBase: actions.openDetail,
      onOpenSource: actions.openSourceDetail,
      onQueryChange(query) {
        const current = useKnowledgeLibraryStore.getState();
        if (!current.busy) current.patch({ query });
      },
      query: snapshot.query,
      sourceData: snapshot.sourceData,
      sourceDataError: snapshot.sourceDataError,
      sourceDataState: snapshot.sourceDataState,
      sourceFilter: snapshot.sourceFilter,
      sourceQuery: snapshot.sourceQuery,
      onSourceFilterChange(filter) {
        actions.setSourceFilter(filter);
      },
      onSourcePageChange(page) {
        actions.setSourcePage(page);
      },
      onSourceQueryChange(query) {
        actions.setSourceQuery(query);
      }
    },
    notice: snapshot.notice,
    onBackToChat: actions.closeLibrary,
    onDismissNotice() {
      useKnowledgeLibraryStore.getState().patch({ notice: null });
    },
    onRetry() {
      if (snapshot.task === "source-detail" && sourceDetail) {
        void actions.refreshSourceDetail(sourceDetail.sourceId);
      } else if (snapshot.task === "detail" && detail) {
        void actions.refreshDetail(detail.baseId);
      } else if (snapshot.catalog === "sources") {
        void actions.refreshSources();
      } else {
        void actions.refreshList();
      }
    },
    sourceDetail: sourceDetail
      ? {
          actionId: sourceDetail.actionId,
          backLabel: sourceDetail.returnBaseId ? "Back to base" : "Back to Sources",
          dataError: sourceDetail.dataError,
          dataState: sourceDetail.dataState,
          dirty: sourceBaseline(sourceDetail.draft) !== sourceDetail.baseline,
          draft: sourceDetail.draft,
          error: sourceDetail.error,
          onAddToBases(baseIds) {
            void actions.addSourceToBases(baseIds);
          },
          onBack: actions.closeSourceDetail,
          onChange(update) {
            const current = useKnowledgeLibraryStore.getState();
            if (current.busy || !current.sourceDetail) return;
            current.patchSourceDetail({
              draft: { ...current.sourceDetail.draft, ...update },
              error: null
            });
          },
          onDeletePermanently() {
            void actions.permanentlyDeleteSource();
          },
          onMove(fromBaseId, toBaseId) {
            void actions.moveSourceMembership(fromBaseId, toBaseId);
          },
          onRefresh() {
            void actions.refreshSourceDetail(sourceDetail.sourceId, true);
          },
          onRemoveFromBase(baseId) {
            void actions.removeSourceFromBase(baseId);
          },
          onReplace(file) {
            void actions.replaceSource(file);
          },
          onReprocess() {
            void actions.reprocessSource();
          },
          onSave() {
            void actions.saveSourceDetail();
          },
          onRestore() {
            void actions.setSourceTrashed(false);
          },
          onTrash() {
            void actions.setSourceTrashed(true);
          },
          source: sourceDetail.source
        }
      : null,
    task: snapshot.task
  };
}
