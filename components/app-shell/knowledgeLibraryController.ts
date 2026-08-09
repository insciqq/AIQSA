import {
  archiveKnowledgeDocument,
  createKnowledgeBase,
  fetchKnowledgeBaseDetail,
  fetchKnowledgeBaseList,
  fetchKnowledgeDocuments,
  publishKnowledgeBase,
  replaceKnowledgeDocument,
  retryKnowledgeDocumentVersion,
  revokeKnowledgeBasePublication,
  startKnowledgeReindex,
  updateKnowledgeBase,
  uploadKnowledgeDocument
} from "@/components/knowledge/knowledgeApi";
import type {
  KnowledgeCreateDraft,
  KnowledgeLibraryView
} from "@/components/knowledge/libraryViewContracts";
import {
  useKnowledgeLibraryStore,
  type KnowledgeDetailState,
  type KnowledgeLibraryStore
} from "@/components/app-shell/knowledgeLibraryStore";
import {
  KNOWLEDGE_DOCUMENT_PAGE_SIZE,
  KNOWLEDGE_DOCUMENT_SEARCH_MAX_LENGTH,
  type KnowledgeBaseDetail,
  type KnowledgeBaseSummary,
  type KnowledgeDocumentStatus,
  type KnowledgeIngestionStatusResponse
} from "@/lib/contracts/knowledge";

function createBaseline(draft: KnowledgeCreateDraft): string {
  return JSON.stringify([draft.description, draft.embeddingDeploymentId, draft.name]);
}

function detailBaseline(draft: { description: string; name: string }): string {
  return JSON.stringify([draft.description, draft.name]);
}

function summaryFromDetail(detail: KnowledgeBaseDetail): KnowledgeBaseSummary {
  const { documentCount: _documentCount, publications: _publications, ...summary } = detail;
  return summary;
}

function errorText(code: string): string {
  const messages: Record<string, string> = {
    file_required: "Choose a document to upload.",
    knowledge_base_archived: "Restore this base before sharing it.",
    knowledge_base_input_invalid: "Check the highlighted Knowledge fields and try again.",
    knowledge_base_not_available: "This Knowledge base is no longer available to you.",
    knowledge_base_version_conflict:
      "This base changed in another session. Reload it and reapply your edits.",
    knowledge_document_ingest_in_progress:
      "Wait for the current document version to finish before replacing it.",
    knowledge_document_retry_not_available: "Only a failed current document version can be retried.",
    knowledge_embedding_dimension_not_supported:
      "That embedding deployment does not use a supported Knowledge vector size.",
    knowledge_embedding_not_available:
      "That embedding deployment is not currently available to your account.",
    knowledge_file_limit_exceeded: "The document is larger than the Knowledge upload limit.",
    knowledge_normalized_text_unavailable:
      "Reindex cannot start because one current document no longer has normalized text.",
    knowledge_publication_forbidden: "You are not allowed to publish to that audience.",
    knowledge_reindex_in_progress: "A reindex is already in progress for this base.",
    knowledge_response_invalid: "The Knowledge response could not be read. Refresh and try again.",
    knowledge_storage_unavailable: "Private document storage is temporarily unavailable.",
    network_unavailable: "The Knowledge request could not reach the server.",
    unauthorized: "Your session is no longer available.",
    unsupported_type: "That document type is not supported for Knowledge indexing.",
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
    documentPage: 1,
    documentQuery: "",
    draft,
    error: null,
    ingestion: null,
    requestId: 0,
    upload: null
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

function replaceDocumentInStatus(
  status: KnowledgeIngestionStatusResponse | null,
  document: KnowledgeDocumentStatus
): KnowledgeIngestionStatusResponse | null {
  if (!status) return null;
  const exists = status.documents.some((candidate) => candidate.id === document.id);
  if (!exists) return status;
  return {
    ...status,
    documents: status.documents.map((candidate) =>
      candidate.id === document.id ? document : candidate)
  };
}

export function createKnowledgeLibraryActions() {
  const store = () => useKnowledgeLibraryStore.getState();

  function beginOperation(actionId: string): number | null {
    const snapshot = store();
    if (snapshot.busy) return null;
    const requestId = snapshot.operationRequestId + 1;
    snapshot.patch({ busy: true, operationRequestId: requestId });
    if (snapshot.detail) snapshot.patchDetail({ actionId, error: null });
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
    snapshot.patchCreate({ saving: false });
    snapshot.patchDetail({ actionId: null, upload: null });
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

  function openLibrary() {
    if (store().busy) return;
    store().patch({
      create: null,
      detail: null,
      notice: null,
      open: true,
      task: "list"
    });
    void refreshList();
  }

  function closeLibrary() {
    if (store().busy) return;
    store().patch({ create: null, detail: null, notice: null, open: false, task: "list" });
  }

  function openCreate() {
    const snapshot = store();
    if (snapshot.busy) return;
    const draft: KnowledgeCreateDraft = {
      description: "",
      embeddingDeploymentId:
        snapshot.data?.embeddingDeployments.find((deployment) => deployment.indexSupported)?.id ?? "",
      name: ""
    };
    snapshot.patch({
      create: {
        baseline: createBaseline(draft),
        draft,
        error: null,
        saving: false
      },
      detail: null,
      notice: null,
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
    if (!name || !current.draft.embeddingDeploymentId) {
      store().patchCreate({
        error: {
          code: "knowledge_base_input_invalid",
          text: !name ? "Give this base a name." : "Choose an embedding deployment."
        }
      });
      return;
    }
    const requestId = beginOperation("create");
    if (requestId === null) return;
    const result = await createKnowledgeBase({
      description,
      embeddingDeploymentId: current.draft.embeddingDeploymentId,
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
        text: "Knowledge base created. Add documents when you are ready to index them."
      },
      task: "detail"
    });
    finishOperation(requestId);
    void refreshDetail(result.data.id, true);
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
      dataState: current.base && current.ingestion ? "ready" : "loading",
      requestId
    });
    const [detailResult, ingestionResult] = await Promise.all([
      fetchKnowledgeBaseDetail(baseId),
      fetchKnowledgeDocuments(baseId, {
        page: current.documentPage,
        pageSize: KNOWLEDGE_DOCUMENT_PAGE_SIZE,
        query: current.documentQuery
      })
    ]);
    if (!ownsDetailRequest(baseId, requestId)) return;
    if (!detailResult.ok || !ingestionResult.ok || detailResult.data.owned !== ingestionResult.data.owned) {
      const code = !detailResult.ok
        ? detailResult.code
        : !ingestionResult.ok
          ? ingestionResult.code
          : "knowledge_response_invalid";
      const latest = store().detail;
      if (latest?.base && latest.ingestion) {
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
      documentPage: ingestionResult.data.pagination.page,
      documentQuery: ingestionResult.data.pagination.query,
      draft: dirty ? latest.draft : nextDraft,
      ingestion: ingestionResult.data
    });
    if (!dirty) upsertSummary(store(), detailResult.data);
  }

  function openDetail(baseId: string) {
    if (store().busy) return;
    store().patch({
      create: null,
      detail: blankDetail(baseId),
      notice: null,
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

  async function uploadFiles(files: readonly File[]) {
    const detail = store().detail;
    if (!detail?.base?.owned || files.length === 0) return;
    const requestId = beginOperation("upload");
    if (requestId === null) return;
    let completed = 0;
    const failures: string[] = [];
    for (let index = 0; index < files.length; index += 1) {
      if (!ownsOperation(requestId)) return;
      const file = files[index];
      store().patchDetail({ upload: { current: index + 1, fileName: file.name, total: files.length } });
      const result = await uploadKnowledgeDocument(detail.base.id, file);
      if (!ownsOperation(requestId)) return;
      if (result.ok) {
        completed += 1;
      } else {
        failures.push(result.code);
      }
    }
    finishOperation(requestId);
    store().patch({
      notice: failures.length > 0
        ? {
            kind: "error",
            text: completed > 0
              ? `${completed} document${completed === 1 ? "" : "s"} queued; ${failures.length} could not be uploaded. ${errorText(failures[0])}`
              : errorText(failures[0])
          }
        : {
            kind: "success",
            text: `${completed} document${completed === 1 ? "" : "s"} queued for indexing.`
          }
    });
    void refreshDetail(detail.base.id, true);
    void refreshList();
  }

  async function replaceDocument(documentId: string, file: File) {
    const detail = store().detail;
    if (!detail?.base?.owned) return;
    const requestId = beginOperation(`document:${documentId}:replace`);
    if (requestId === null) return;
    const result = await replaceKnowledgeDocument(detail.base.id, documentId, file);
    if (!ownsOperation(requestId)) return;
    if (!result.ok) {
      finishOperation(requestId);
      store().patch({ notice: { kind: "error", text: errorText(result.code) } });
      return;
    }
    store().patchDetail({
      ingestion: replaceDocumentInStatus(store().detail?.ingestion ?? null, result.data)
    });
    finishOperation(requestId);
    store().patch({ notice: { kind: "success", text: "New document version queued for indexing." } });
    void refreshDetail(detail.base.id, true);
  }

  async function removeDocument(documentId: string) {
    const detail = store().detail;
    if (!detail?.base?.owned) return;
    const requestId = beginOperation(`document:${documentId}:remove`);
    if (requestId === null) return;
    const result = await archiveKnowledgeDocument(detail.base.id, documentId);
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
        text: "Document removed from the current base. Historical version identity is retained."
      }
    });
    void refreshDetail(detail.base.id, true);
    void refreshList();
  }

  async function retryDocument(documentId: string, versionId: string) {
    const detail = store().detail;
    if (!detail?.base?.owned) return;
    const requestId = beginOperation(`document:${documentId}:retry`);
    if (requestId === null) return;
    const result = await retryKnowledgeDocumentVersion(detail.base.id, documentId, versionId);
    if (!ownsOperation(requestId)) return;
    if (!result.ok) {
      finishOperation(requestId);
      store().patch({ notice: { kind: "error", text: errorText(result.code) } });
      return;
    }
    store().patchDetail({
      ingestion: replaceDocumentInStatus(store().detail?.ingestion ?? null, result.data)
    });
    finishOperation(requestId);
    store().patch({ notice: { kind: "success", text: "Document retry queued." } });
    void refreshDetail(detail.base.id, true);
  }

  function setDocumentQuery(query: string) {
    const detail = store().detail;
    if (!detail || store().busy) return;
    const normalized = query.slice(0, KNOWLEDGE_DOCUMENT_SEARCH_MAX_LENGTH);
    store().patchDetail({ documentPage: 1, documentQuery: normalized });
    void refreshDetail(detail.baseId, true);
  }

  function setDocumentPage(page: number) {
    const detail = store().detail;
    if (!detail || store().busy || !Number.isSafeInteger(page) || page < 1) return;
    const maximum = Math.max(1, detail.ingestion?.pagination.totalPages ?? 1);
    const next = Math.min(page, maximum);
    if (next === detail.documentPage) return;
    store().patchDetail({ documentPage: next });
    void refreshDetail(detail.baseId, true);
  }

  async function reindex(embeddingDeploymentId: string) {
    const detail = store().detail;
    if (!detail?.base?.owned || !embeddingDeploymentId) return;
    const requestId = beginOperation("reindex");
    if (requestId === null) return;
    const result = await startKnowledgeReindex(detail.base.id, embeddingDeploymentId);
    if (!ownsOperation(requestId)) return;
    if (!result.ok) {
      finishOperation(requestId);
      store().patch({ notice: { kind: "error", text: errorText(result.code) } });
      return;
    }
    if (store().detail?.ingestion) {
      store().patchDetail({
        ingestion: { ...store().detail!.ingestion!, reindex: result.data }
      });
    }
    finishOperation(requestId);
    store().patch({ notice: { kind: "success", text: "Reindex started." } });
    void refreshDetail(detail.base.id, true);
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
    const base = { ...detail.base, publications: next, published: true };
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
    const base = { ...detail.base, publications, published: publications.length > 0 };
    store().patchDetail({ base });
    upsertSummary(store(), base);
    finishOperation(requestId);
    store().patch({
      notice: {
        kind: "success",
        text: "Publication revoked. Future runs lose access; accepted runs keep their evidence."
      }
    });
  }

  return {
    closeCreate,
    closeDetail,
    closeLibrary,
    openCreate,
    openDetail,
    openEvidence,
    openLibrary,
    publish,
    refreshDetail,
    refreshList,
    reindex,
    removeDocument,
    replaceDocument,
    retryDocument,
    revokePublication,
    saveCreate,
    saveDetail,
    setDocumentPage,
    setDocumentQuery,
    setArchived,
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
  return {
    busy: snapshot.busy,
    create: creation
      ? {
          dirty: createBaseline(creation.draft) !== creation.baseline,
          draft: creation.draft,
          embeddingDeployments:
            snapshot.data?.embeddingDeployments.filter((deployment) => deployment.indexSupported) ?? [],
          error: creation.error,
          onCancel: actions.closeCreate,
          onChange(update) {
            const current = useKnowledgeLibraryStore.getState();
            if (current.busy || !current.create) return;
            current.patchCreate({ draft: { ...current.create.draft, ...update }, error: null });
          },
          onSave() {
            void actions.saveCreate();
          },
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
          embeddingDeployments:
            snapshot.data?.embeddingDeployments.filter((deployment) => deployment.indexSupported) ?? [],
          error: detail.error,
          ingestion: detail.ingestion,
          onArchiveToggle(archived) {
            void actions.setArchived(detail.baseId, archived);
          },
          onBack: actions.closeDetail,
          onChange(update) {
            const current = useKnowledgeLibraryStore.getState();
            if (current.busy || !current.detail) return;
            current.patchDetail({ draft: { ...current.detail.draft, ...update }, error: null });
          },
          onDocumentPageChange(page) {
            actions.setDocumentPage(page);
          },
          onDocumentQueryChange(query) {
            actions.setDocumentQuery(query);
          },
          onPublish(input) {
            void actions.publish(input);
          },
          onRefresh() {
            void actions.refreshDetail(detail.baseId, true);
          },
          onReindex(embeddingDeploymentId) {
            void actions.reindex(embeddingDeploymentId);
          },
          onRemoveDocument(documentId) {
            void actions.removeDocument(documentId);
          },
          onReplaceDocument(documentId, file) {
            void actions.replaceDocument(documentId, file);
          },
          onRetryDocument(documentId, versionId) {
            void actions.retryDocument(documentId, versionId);
          },
          onRevokePublication(publicationId) {
            void actions.revokePublication(publicationId);
          },
          onSave() {
            void actions.saveDetail();
          },
          onUpload(files) {
            void actions.uploadFiles(files);
          },
          publishableGroups: snapshot.data?.publishableGroups ?? [],
          documentPage: detail.documentPage,
          documentQuery: detail.documentQuery,
          upload: detail.upload
        }
      : null,
    list: {
      filter: snapshot.filter,
      knowledgeBases: snapshot.data?.knowledgeBases ?? [],
      onArchiveToggle(baseId, archived) {
        void actions.setArchived(baseId, archived);
      },
      onFilterChange(filter) {
        const current = useKnowledgeLibraryStore.getState();
        if (!current.busy) current.patch({ filter });
      },
      onNewBase: actions.openCreate,
      onOpenBase: actions.openDetail,
      onQueryChange(query) {
        const current = useKnowledgeLibraryStore.getState();
        if (!current.busy) current.patch({ query });
      },
      query: snapshot.query
    },
    notice: snapshot.notice,
    onBackToChat: actions.closeLibrary,
    onDismissNotice() {
      useKnowledgeLibraryStore.getState().patch({ notice: null });
    },
    onRetry() {
      if (snapshot.task === "detail" && detail) {
        void actions.refreshDetail(detail.baseId);
      } else {
        void actions.refreshList();
      }
    },
    task: snapshot.task
  };
}
