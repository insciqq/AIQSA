import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  KnowledgeCreateView,
  KnowledgeDetailView,
  KnowledgeLibraryView,
  KnowledgeListView
} from "./libraryViewContracts";
import type {
  KnowledgeBaseDetail,
  KnowledgeDocumentStatus,
  KnowledgeIngestionStatusResponse
} from "@/lib/contracts/knowledge";
import { KnowledgeLibrary } from "./KnowledgeLibrary";

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
      id: "generation-12345678",
      indexedContentRevision: 2,
      targetDimension: 1536,
      vectorSpaceFingerprint: "vector-space-1"
    },
    archived: false,
    contentRevision: 2,
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

function knowledgeDocument(overrides: Partial<KnowledgeDocumentStatus> = {}): KnowledgeDocumentStatus {
  return {
    archived: false,
    currentVersionId: "version-2",
    id: "document-1",
    versions: [
      {
        byteSize: 1_200,
        completedAt: null,
        createdAt: "2026-08-08T10:00:00.000Z",
        current: true,
        embeddedChunks: 3,
        errorCode: null,
        fileName: "guide.md",
        id: "version-2",
        mimeType: "text/markdown",
        pageCount: null,
        payloadAvailable: true,
        state: "embedding",
        totalChunks: 8,
        updatedAt: "2026-08-08T10:01:00.000Z",
        versionNumber: 2,
        visibleFromRevision: null,
        visibleUntilRevision: null
      },
      {
        byteSize: 900,
        completedAt: "2026-08-07T10:01:00.000Z",
        createdAt: "2026-08-07T10:00:00.000Z",
        current: false,
        embeddedChunks: 4,
        errorCode: null,
        fileName: "guide.md",
        id: "version-1",
        mimeType: "text/markdown",
        pageCount: null,
        payloadAvailable: true,
        state: "ready",
        totalChunks: 4,
        updatedAt: "2026-08-07T10:01:00.000Z",
        versionNumber: 1,
        visibleFromRevision: 1,
        visibleUntilRevision: 2
      }
    ],
    ...overrides
  };
}

function ingestion(overrides: Partial<KnowledgeIngestionStatusResponse> = {}): KnowledgeIngestionStatusResponse {
  const documents = overrides.documents ?? [knowledgeDocument()];
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

function list(overrides: Partial<KnowledgeListView> = {}): KnowledgeListView {
  const owner = base();
  const { documentCount: _count, publications: _publications, ...summary } = owner;
  return {
    filter: "all",
    knowledgeBases: [summary],
    onArchiveToggle: vi.fn(),
    onFilterChange: vi.fn(),
    onNewBase: vi.fn(),
    onOpenBase: vi.fn(),
    onQueryChange: vi.fn(),
    query: "",
    ...overrides
  };
}

function creation(overrides: Partial<KnowledgeCreateView> = {}): KnowledgeCreateView {
  return {
    dirty: false,
    draft: { description: "", embeddingDeploymentId: "embedding-1", name: "" },
    embeddingDeployments: [base().activeGeneration.embeddingDeployment!],
    error: null,
    onCancel: vi.fn(),
    onChange: vi.fn(),
    onSave: vi.fn(),
    saving: false,
    ...overrides
  };
}

function detail(overrides: Partial<KnowledgeDetailView> = {}): KnowledgeDetailView {
  const owner = base();
  return {
    actionId: null,
    base: owner,
    canPublishInstallation: true,
    dataError: null,
    dataState: "ready",
    documentPage: 1,
    documentQuery: "",
    dirty: false,
    draft: { description: owner.description, name: owner.name },
    embeddingDeployments: [owner.activeGeneration.embeddingDeployment!],
    error: null,
    ingestion: ingestion(),
    onArchiveToggle: vi.fn(),
    onBack: vi.fn(),
    onChange: vi.fn(),
    onDocumentPageChange: vi.fn(),
    onDocumentQueryChange: vi.fn(),
    onPublish: vi.fn(),
    onRefresh: vi.fn(),
    onReindex: vi.fn(),
    onRemoveDocument: vi.fn(),
    onReplaceDocument: vi.fn(),
    onRetryDocument: vi.fn(),
    onRevokePublication: vi.fn(),
    onSave: vi.fn(),
    onUpload: vi.fn(),
    publishableGroups: [{ id: "group-1", name: "Research" }],
    upload: null,
    ...overrides
  };
}

function view(overrides: Partial<KnowledgeLibraryView> = {}): KnowledgeLibraryView {
  return {
    busy: false,
    create: null,
    dataError: null,
    dataState: "ready",
    detail: null,
    list: list(),
    notice: null,
    onBackToChat: vi.fn(),
    onDismissNotice: vi.fn(),
    onRetry: vi.fn(),
    task: "list",
    ...overrides
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("KnowledgeLibrary", () => {
  it("renders a full-screen library index from only the server-authorized bases", () => {
    const owner = base();
    const { documentCount: _ownerCount, publications: _ownerPublications, ...ownerSummary } = owner;
    const shared = base({
      id: "base-shared",
      name: "Shared research",
      owned: false,
      ownerDisplayName: "Publisher",
      publications: null,
      scope: { groupNames: ["Research"], kind: "group" }
    });
    const { documentCount: _sharedCount, publications: _sharedPublications, ...sharedSummary } = shared;
    const archived = base({ archived: true, id: "base-archived", name: "Old docs" });
    const { documentCount: _archivedCount, publications: _archivedPublications, ...archivedSummary } = archived;
    const libraryList = list({ knowledgeBases: [ownerSummary, sharedSummary, archivedSummary] });
    render(<KnowledgeLibrary view={view({ list: libraryList })} />);

    const dialog = screen.getByRole("dialog", { name: "Knowledge" });
    expect(dialog).toHaveClass("fixed", "h-[100dvh]", "overflow-hidden");
    expect(screen.getByRole("heading", { level: 1, name: "Knowledge" })).toBeVisible();
    expect(screen.getByTestId("knowledge-base-base-1")).toBeVisible();
    expect(screen.getByTestId("knowledge-base-base-shared")).toHaveTextContent("Shared with Research");
    expect(screen.queryByTestId("knowledge-base-base-archived")).not.toBeInTheDocument();
    expect(screen.getByTestId("knowledge-base-base-1")).toHaveTextContent("Content revision 2");
    expect(screen.getByTestId("knowledge-base-base-1")).toHaveTextContent("Indexed revision 2");

    fireEvent.click(screen.getByRole("button", { name: "Shared" }));
    expect(libraryList.onFilterChange).toHaveBeenCalledWith("shared");
    fireEvent.click(within(screen.getByTestId("knowledge-base-base-1")).getAllByRole("button")[0]);
    expect(libraryList.onOpenBase).toHaveBeenCalledWith("base-1");
  });

  it("renders the exact embedding egress disclosure and submits the creation task", () => {
    const create = creation({
      draft: {
        description: "Operational references",
        embeddingDeploymentId: "embedding-1",
        name: "Runbooks"
      }
    });
    render(<KnowledgeLibrary view={view({ create, task: "create" })} />);

    expect(screen.getByTestId("knowledge-egress-disclosure")).toHaveTextContent(
      "Indexing sends this base’s document text to Embedding connection / Embed model for embedding"
    );
    expect(screen.getByTestId("knowledge-egress-disclosure")).toHaveTextContent(
      "outside chat runs and repeats when the base is reindexed"
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Updated runbooks" } });
    expect(create.onChange).toHaveBeenCalledWith({ name: "Updated runbooks" });
    fireEvent.click(screen.getByRole("button", { name: "Create base" }));
    expect(create.onSave).toHaveBeenCalledOnce();
  });

  it("blocks every dirty create and detail exit behind discard confirmation", () => {
    const create = creation({ dirty: true });
    const { rerender } = render(<KnowledgeLibrary view={view({ create, task: "create" })} />);

    fireEvent.click(screen.getByRole("button", { name: "Back to Knowledge" }));
    expect(create.onCancel).not.toHaveBeenCalled();
    expect(screen.getByTestId("knowledge-library")).toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("button", { name: "Confirm discard changes" }));
    expect(create.onCancel).toHaveBeenCalledOnce();

    const detailView = detail({ dirty: true });
    rerender(<KnowledgeLibrary view={view({ detail: detailView, task: "detail" })} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(detailView.onBack).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm discard changes" }));
    expect(detailView.onBack).toHaveBeenCalledOnce();
  });

  it("protects dirty Knowledge create/detail drafts from document unload", () => {
    const create = creation({ dirty: true });
    const { rerender } = render(<KnowledgeLibrary view={view({ create, task: "create" })} />);
    const createUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(createUnload);
    expect(createUnload.defaultPrevented).toBe(true);

    rerender(<KnowledgeLibrary view={view({ detail: detail({ dirty: true }), task: "detail" })} />);
    const detailUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(detailUnload);
    expect(detailUnload.defaultPrevented).toBe(true);

    rerender(<KnowledgeLibrary view={view()} />);
    const cleanUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
  });

  it("shows exact document stages, versions, drag/drop upload, retry, replacement, and logical removal", () => {
    const failed = knowledgeDocument({
      currentVersionId: "failed-version",
      id: "failed-document",
      versions: [{
        ...knowledgeDocument().versions[0],
        embeddedChunks: 0,
        errorCode: "embedding_failed",
        id: "failed-version",
        state: "failed",
        totalChunks: 8
      }]
    });
    const detailView = detail({ ingestion: ingestion({ documents: [knowledgeDocument(), failed] }) });
    render(<KnowledgeLibrary view={view({ detail: detailView, task: "detail" })} />);

    expect(screen.getByTestId("knowledge-revision-spine")).toHaveTextContent("Active index");
    expect(screen.getAllByText("Embedding 3 of 8 chunks")[0]).toBeVisible();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(screen.getByText("Code: embedding_failed")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(detailView.onRetryDocument).toHaveBeenCalledWith("failed-document", "failed-version");

    fireEvent.click(screen.getAllByText("Version history (2)")[0]);
    expect(screen.getByText(/visible from revision 1 before revision 2/)).toBeVisible();

    const first = new File(["first"], "first.md", { type: "text/markdown" });
    const second = new File(["second"], "second.txt", { type: "text/plain" });
    const transfer = { dropEffect: "none", files: [first, second], types: ["Files"] } as unknown as DataTransfer;
    fireEvent.dragEnter(screen.getByTestId("knowledge-drop-zone"), { dataTransfer: transfer });
    expect(screen.getByTestId("knowledge-drop-zone")).toHaveAttribute("data-drop-active", "true");
    fireEvent.drop(screen.getByTestId("knowledge-drop-zone"), { dataTransfer: transfer });
    expect(detailView.onUpload).toHaveBeenCalledWith([first, second]);

    const replaceInputs = screen.getAllByLabelText("New version");
    const replacement = new File(["replacement"], "guide-v3.md", { type: "text/markdown" });
    fireEvent.change(replaceInputs[0], { target: { files: [replacement] } });
    expect(detailView.onReplaceDocument).toHaveBeenCalledWith("document-1", replacement);

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    const confirmation = screen.getByRole("dialog", { name: "Remove guide.md from this Knowledge base" });
    expect(confirmation).toHaveTextContent("Historical version identity");
    expect(detailView.onRemoveDocument).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Confirm remove document" }));
    expect(detailView.onRemoveDocument).toHaveBeenCalledWith("document-1");
  });

  it("searches filenames and navigates bounded server pages", () => {
    const pagedIngestion = ingestion({
      pagination: {
        page: 2,
        pageSize: 25,
        query: "guide",
        totalItems: 26,
        totalPages: 2
      }
    });
    const detailView = detail({
      documentPage: 2,
      documentQuery: "guide",
      ingestion: pagedIngestion
    });
    render(<KnowledgeLibrary view={view({ detail: detailView, task: "detail" })} />);

    expect(screen.getByText(/Showing 26–26 of 26 matching/)).toBeVisible();
    expect(screen.getByText("Page 2 of 2")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search documents by filename" }), {
      target: { value: "incident" }
    });
    expect(detailView.onDocumentQueryChange).toHaveBeenCalledWith("incident");
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(detailView.onDocumentPageChange).toHaveBeenCalledWith(1);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("distinguishes an empty base from a filename search with no matches", () => {
    const detailView = detail({
      documentQuery: "missing",
      ingestion: ingestion({
        documents: [],
        pagination: {
          page: 1,
          pageSize: 25,
          query: "missing",
          totalItems: 0,
          totalPages: 0
        }
      })
    });
    render(<KnowledgeLibrary view={view({ detail: detailView, task: "detail" })} />);

    expect(screen.getByText("No documents match this filename")).toBeVisible();
    expect(screen.getByText(/does not inspect document contents/)).toBeVisible();
    expect(screen.queryByText(/honest empty retrieval result/)).not.toBeInTheDocument();
  });

  it("renders truthful reindex and live-publication controls with their disclosures", () => {
    const owner = base({
      publications: [{
        groupId: null,
        groupName: null,
        id: "publication-installation",
        scope: "installation",
        updatedAt: "2026-08-08T10:00:00.000Z"
      }]
    });
    const detailView = detail({
      base: owner,
      ingestion: ingestion({
        reindex: {
          completedDocuments: 2,
          createdAt: "2026-08-08T10:00:00.000Z",
          errorCode: null,
          failedDocuments: 1,
          generationId: "generation-2",
          status: "failed",
          targetContentRevision: 2,
          totalDocuments: 3
        }
      })
    });
    render(<KnowledgeLibrary view={view({ detail: detailView, task: "detail" })} />);

    expect(screen.getByText("Reindex failed")).toBeVisible();
    expect(screen.getByText("2 completed · 1 failed · 3 total · target revision 2")).toBeVisible();
    expect(screen.getAllByTestId("knowledge-egress-disclosure").at(-1)).toHaveTextContent(
      "Embedding connection / Embed model"
    );
    fireEvent.click(screen.getByRole("button", { name: "Start reindex" }));
    expect(detailView.onReindex).toHaveBeenCalledWith("embedding-1");

    expect(screen.getByTestId("knowledge-publication-disclosure")).toHaveTextContent(
      "Revoking stops future run admission; runs accepted earlier keep their admitted revision"
    );
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(detailView.onRevokePublication).toHaveBeenCalledWith("publication-installation");
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(detailView.onPublish).toHaveBeenCalledWith({ groupId: "group-1", scope: "group" });
  });

  it("keeps a shared base read-only and does not reveal a hidden embedding destination", () => {
    const shared = base({
      activeGeneration: {
        ...base().activeGeneration,
        embeddingDeployment: null,
        embeddingDeploymentId: null
      },
      owned: false,
      ownerDisplayName: "Publisher",
      publications: null,
      scope: { groupNames: ["Research"], kind: "group" }
    });
    const detailView = detail({ base: shared, ingestion: ingestion({ owned: false }) });
    render(<KnowledgeLibrary view={view({ detail: detailView, task: "detail" })} />);

    expect(screen.getByText("Read-only shared base")).toBeVisible();
    expect(screen.getByTestId("knowledge-revision-spine")).toHaveTextContent("Destination hidden by access policy");
    expect(screen.queryByText("Embedding connection")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.queryByText("Add documents")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Reindex" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Publication" })).not.toBeInTheDocument();
  });

  it("polls only while observed lifecycle work is transient", async () => {
    vi.useFakeTimers();
    const detailView = detail();
    render(<KnowledgeLibrary view={view({ detail: detailView, task: "detail" })} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(detailView.onRefresh).toHaveBeenCalledOnce();
  });
});
