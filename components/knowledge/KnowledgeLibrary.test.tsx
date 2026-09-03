import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const viewerMocks = vi.hoisted(() => ({
  loadKnowledgeSourceViewer: vi.fn().mockRejectedValue(new Error("preview unavailable"))
}));

vi.mock("@/features/citations-v2/knowledgeCitationApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/features/citations-v2/knowledgeCitationApi")>(),
  loadKnowledgeSourceViewer: viewerMocks.loadKnowledgeSourceViewer
}));

import type {
  KnowledgeBaseDetail,
  KnowledgeReadiness,
  KnowledgeSourceDetail,
  KnowledgeSourceListResponse
} from "@/lib/contracts/knowledge";
import type {
  KnowledgeCreateView,
  KnowledgeDetailView,
  KnowledgeLibraryView,
  KnowledgeListView,
  KnowledgeSourceDetailView
} from "./libraryViewContracts";
import {
  isKnowledgeSubview,
  KnowledgeLibrary,
  knowledgeSubviewChrome,
  useKnowledgeLibraryExit
} from "./KnowledgeLibrary";

function readiness(
  state: KnowledgeReadiness["state"] = "ready",
  totalSources = 1
): KnowledgeReadiness {
  const attentionSources = state === "needs_attention" ? 1 : 0;
  const processingSources = state === "processing" ? 1 : 0;
  return {
    attentionSources,
    processingSources,
    readySources: Math.max(0, totalSources - attentionSources - processingSources),
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

function list(overrides: Partial<KnowledgeListView> = {}): KnowledgeListView {
  const owner = base();
  const { publications: _publications, ...summary } = owner;
  return {
    catalog: "bases",
    canCreate: true,
    filter: "all",
    knowledgeBases: [summary],
    onArchiveToggle: vi.fn(),
    onCatalogChange: vi.fn(),
    onFilterChange: vi.fn(),
    onNewBase: vi.fn(),
    onOpenBase: vi.fn(),
    onOpenSource: vi.fn(),
    onQueryChange: vi.fn(),
    onRefresh: vi.fn(),
    onSourceFilterChange: vi.fn(),
    onSourcePageChange: vi.fn(),
    onSourceQueryChange: vi.fn(),
    query: "",
    sourceData: {
      pagination: { page: 1, pageSize: 25, query: "", totalItems: 0, totalPages: 0 },
      sources: []
    },
    sourceDataError: null,
    sourceDataState: "ready",
    sourceFilter: "all",
    sourceQuery: "",
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
    canReprocess: false,
    currentVersion,
    deletionPending: false,
    description: "Canonical product guidance",
    eligibleBases: [
      { archived: false, id: "base-2", name: "Assistant docs" },
      { archived: false, id: "base-3", name: "Project docs" }
    ],
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
    versions: [
      currentVersion,
      {
        ...currentVersion,
        createdAt: "2026-08-17T10:00:00.000Z",
        fileName: "product-guide-v1.pdf",
        isCurrent: false,
        versionNumber: 1
      }
    ],
    ...overrides
  };
}

function sourceDetail(overrides: Partial<KnowledgeSourceDetailView> = {}): KnowledgeSourceDetailView {
  const value = source();
  return {
    actionId: null,
    backLabel: "Back to documents",
    dataError: null,
    dataState: "ready",
    dirty: false,
    draft: { description: value.description, name: value.name, tags: value.tags.join(", ") },
    error: null,
    onAddToBases: vi.fn(),
    onBack: vi.fn(),
    onChange: vi.fn(),
    onDeletePermanently: vi.fn(),
    onMove: vi.fn(),
    onRefresh: vi.fn(),
    onRemoveFromBase: vi.fn(),
    onReplace: vi.fn(),
    onReprocess: vi.fn(),
    onRestore: vi.fn(),
    onSave: vi.fn(),
    onTrash: vi.fn(),
    source: value,
    ...overrides
  };
}

function baseSources(
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

function creation(overrides: Partial<KnowledgeCreateView> = {}): KnowledgeCreateView {
  return {
    dirty: false,
    draft: { description: "", files: [], name: "" },
    error: null,
    maxUploadBytes: 25_000_000,
    onCancel: vi.fn(),
    onChange: vi.fn(),
    onSave: vi.fn(),
    progress: null,
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
    dirty: false,
    draft: { description: owner.description, name: owner.name },
    error: null,
    maxUploadBytes: 25_000_000,
    onArchiveToggle: vi.fn(),
    onBack: vi.fn(),
    onCancelUpload: vi.fn(),
    onChange: vi.fn(),
    onDeletePermanently: vi.fn(),
    onOpenSource: vi.fn(),
    onPublish: vi.fn(),
    onRefresh: vi.fn(),
    onRemoveSource: vi.fn(),
    onResumeUpload: vi.fn(),
    onRevokePublication: vi.fn(),
    onRestore: vi.fn(),
    onSave: vi.fn(),
    onTrash: vi.fn(),
    onUpload: vi.fn(),
    publishableGroups: [{ id: "group-1", name: "Research" }],
    sourcePage: 1,
    sourceQuery: "",
    sources: baseSources(),
    onSourcePageChange: vi.fn(),
    onSourceQueryChange: vi.fn(),
    uploadBatches: [],
    uploadErrors: {},
    uploadProgress: {},
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
    sourceDetail: null,
    task: "list",
    ...overrides
  };
}

afterEach(() => {
  cleanup();
  viewerMocks.loadKnowledgeSourceViewer.mockReset().mockRejectedValue(new Error("preview unavailable"));
  vi.useRealTimers();
});

describe("KnowledgeLibrary", () => {
  it("creates from identity and optional files without technical settings", async () => {
    const createView = creation();
    render(<KnowledgeLibrary view={view({ create: createView, task: "create" })} />);

    // The crumb and Back control belong to the Library (A14): the content
    // starts with the sub-view heading.
    expect(screen.getByRole("heading", { level: 2, name: "New Knowledge base" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Back to Knowledge" })).not.toBeInTheDocument();
    expect(screen.queryByText(/embedding|provider|dimension|fingerprint|revision|generation/iu))
      .not.toBeInTheDocument();
    expect(screen.getByText(/Up to 25 MB per file/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Runbooks" } });
    expect(createView.onChange).toHaveBeenCalledWith({ name: "Runbooks" });

    const first = new File(["first"], "first.md", { type: "text/markdown" });
    const second = new File(["second"], "second.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [first, second] } });
    expect(createView.onChange).toHaveBeenCalledWith({ files: [first, second] });

    fireEvent.submit(screen.getByRole("button", { name: "Create knowledge base" }).closest("form")!);
    expect(createView.onSave).toHaveBeenCalledOnce();
  });

  it("supports drag-and-drop file selection during creation", () => {
    const createView = creation();
    render(<KnowledgeLibrary view={view({ create: createView, task: "create" })} />);
    const file = new File(["guide"], "guide.md", { type: "text/markdown" });
    const transfer = { dropEffect: "none", files: [file], types: ["Files"] } as unknown as DataTransfer;

    fireEvent.dragEnter(screen.getByTestId("knowledge-create-drop-zone"), { dataTransfer: transfer });
    expect(screen.getByTestId("knowledge-create-drop-zone")).toHaveAttribute("data-drop-active", "true");
    fireEvent.drop(screen.getByTestId("knowledge-create-drop-zone"), { dataTransfer: transfer });
    expect(createView.onChange).toHaveBeenCalledWith({ files: [file] });
  });

  it("keeps unavailable-document troubleshooting safe and does not promise recovery", () => {
    const affected = source({
      currentVersion: null,
      readiness: {
        state: "needs_attention",
        supportReference: "K-ABCDEF012345",
        warningCodes: []
      },
      versions: []
    });
    const detailView = detail({
      base: base({
        readiness: {
          ...readiness("needs_attention"),
          supportReference: "K-ABCDEF012345"
        }
      }),
      sources: baseSources(affected)
    });
    render(<KnowledgeLibrary view={view({ detail: detailView, task: "detail" })} />);
    expect(screen.getByText(/up to 25 MB each/iu)).toBeVisible();

    expect(screen.getByRole("heading", { level: 2, name: "Product docs" }).parentElement)
      .toHaveTextContent("Needs attention · 1 document");
    expect(screen.getByText("This document is unavailable.")).toBeVisible();
    expect(screen.getByTestId("knowledge-source-source-1")).toHaveTextContent("Unavailable");
    expect(screen.queryByText(/errorCode|embedding_failed|generation|revision|chunks?/iu))
      .not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "More actions for Product guide" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open document" }));
    expect(detailView.onOpenSource).toHaveBeenCalledWith("source-1");
    expect(screen.queryByRole("button", { name: /reprocess/iu })).not.toBeInTheDocument();
  });

  it("shows user-safe partial-success warnings without parser internals", () => {
    const currentVersion = source().currentVersion!;
    const warnedSource = source({
      currentVersion: {
        ...currentVersion,
        readiness: {
          state: "ready",
          supportReference: null,
          warningCodes: ["partial_parse", "unreadable_pages"]
        }
      },
      readiness: {
        state: "ready",
        supportReference: null,
        warningCodes: ["partial_parse", "unreadable_pages"]
      }
    });
    const detailView = detail({
      sources: baseSources(warnedSource)
    });
    render(<KnowledgeLibrary view={view({ detail: detailView, task: "detail" })} />);

    expect(screen.getByText("Part of the file could not be read. The rest is searchable."))
      .toBeVisible();
    expect(screen.queryByText(/Some pages could not be read/)).not.toBeInTheDocument();
    expect(screen.queryByText(/partial_parse|unreadable_pages|coverage|confidence/iu))
      .not.toBeInTheDocument();
  });

  it("shows Reprocess only when the server projects an actionable recovery", () => {
    const affected = source({
      canReprocess: true,
      currentVersion: null,
      readiness: {
        state: "needs_attention",
        supportReference: "K-ABCDEF012345",
        warningCodes: []
      },
      versions: []
    });
    const detailView = sourceDetail({
      draft: { description: affected.description, name: affected.name, tags: affected.tags.join(", ") },
      source: affected
    });
    render(<KnowledgeLibrary view={view({ sourceDetail: detailView, task: "source-detail" })} />);

    expect(screen.getByText("Needs attention", { exact: true })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Reprocess this document" }));
    expect(detailView.onReprocess).toHaveBeenCalledOnce();

    const replacement = new File(["replacement"], "guide-new.md", { type: "text/markdown" });
    fireEvent.change(screen.getByLabelText("Replace file"), { target: { files: [replacement] } });
    expect(detailView.onReplace).toHaveBeenCalledWith(replacement);
  });

  it("keeps a usable current version Ready when its replacement cannot be reprocessed", () => {
    const unavailableReplacement = source({
      canReprocess: false,
      replacement: { state: "needs_attention", supportReference: "K-ABCDEF012345" }
    });
    render(<KnowledgeLibrary view={view({
      sourceDetail: sourceDetail({
        draft: {
          description: unavailableReplacement.description,
          name: unavailableReplacement.name,
          tags: unavailableReplacement.tags.join(", ")
        },
        source: unavailableReplacement
      }),
      task: "source-detail"
    })} />);

    expect(screen.getByText("Ready · replacement unavailable")).toBeVisible();
    expect(screen.getByText("Replacement unavailable")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Reprocess" })).not.toBeInTheDocument();
  });

  it("labels failed versions unavailable when no retry action can succeed", () => {
    const currentVersion = {
      ...source().currentVersion!,
      readiness: {
        state: "needs_attention" as const,
        supportReference: "K-ABCDEF012345",
        warningCodes: []
      }
    };
    const unavailable = source({
      canReprocess: false,
      currentVersion,
      readiness: currentVersion.readiness,
      versions: [
        currentVersion,
        {
          ...currentVersion,
          createdAt: "2026-08-17T10:00:00.000Z",
          fileName: "product-guide-v1.pdf",
          isCurrent: false,
          versionNumber: 1
        }
      ]
    });
    render(<KnowledgeLibrary view={view({
      sourceDetail: sourceDetail({
        draft: {
          description: unavailable.description,
          name: unavailable.name,
          tags: unavailable.tags.join(", ")
        },
        source: unavailable
      }),
      task: "source-detail"
    })} />);

    fireEvent.click(screen.getByText("History · 1 earlier version"));
    const versions = screen.getByRole("list", { name: "Document versions" });
    const versionRows = within(versions).getAllByRole("listitem");
    expect(versionRows[0]).toHaveTextContent("Current · product-guide.pdf");
    expect(versionRows[0]).toHaveTextContent("Unavailable");
    expect(versionRows[1]).toHaveTextContent("Unavailable");
    expect(within(versions).queryByText(/Needs attention/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open original" })).not.toBeInTheDocument();
  });

  it("uploads, opens, and removes a Source with product-level consequences", () => {
    const detailView = detail();
    render(<KnowledgeLibrary view={view({ detail: detailView, task: "detail" })} />);

    const first = new File(["first"], "first.md", { type: "text/markdown" });
    const second = new File(["second"], "second.txt", { type: "text/plain" });
    const transfer = { dropEffect: "none", files: [first, second], types: ["Files"] } as unknown as DataTransfer;
    fireEvent.drop(screen.getByTestId("knowledge-drop-zone"), { dataTransfer: transfer });
    expect(detailView.onUpload).toHaveBeenCalledWith([first, second]);

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(detailView.onOpenSource).toHaveBeenCalledWith("source-1");

    fireEvent.click(screen.getByRole("button", { name: "More actions for Product guide" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from base" }));
    const confirmation = screen.getByRole("dialog", { name: "Remove Product guide from Product docs" });
    expect(confirmation).toHaveTextContent(/future chats/iu);
    expect(confirmation).not.toHaveTextContent(/version|binding|revision/iu);
    fireEvent.click(within(confirmation).getByRole("button", { name: "Confirm remove from base" }));
    expect(detailView.onRemoveSource).toHaveBeenCalledWith("source-1");
  });

  it("renders durable per-file progress with independent resume, retry, and cancel", () => {
    const uploadItem = (input: {
      failureCode?: string | null;
      fileName: string;
      id: string;
      sourceId?: string | null;
      state: "needs_attention" | "queued" | "ready" | "uploading";
      uploadedBytes?: number;
    }) => ({
      attemptNumber: 1,
      byteSize: 10,
      clientFileId: `client-${input.id}`,
      failureCode: input.failureCode ?? null,
      fileName: input.fileName,
      id: input.id,
      sourceId: input.sourceId ?? null,
      state: input.state,
      transport: input.state === "queued" || input.state === "uploading"
        ? { kind: "proxy" as const, uploadUrl: `/api/upload/${input.id}` }
        : null,
      updatedAt: "2026-08-18T10:00:00.000Z",
      uploadedBytes: input.uploadedBytes ?? 0
    });
    const detailView = detail({
      uploadBatches: [{
        createdAt: "2026-08-18T10:00:00.000Z",
        id: "batch-1",
        items: [
          uploadItem({ fileName: "ready.md", id: "ready", sourceId: "source-1", state: "ready", uploadedBytes: 10 }),
          uploadItem({ fileName: "active.md", id: "active", state: "uploading", uploadedBytes: 2 }),
          uploadItem({
            failureCode: "knowledge_upload_session_expired",
            fileName: "expired.md",
            id: "expired",
            state: "needs_attention"
          }),
          uploadItem({ fileName: "resume.md", id: "resume", state: "queued" })
        ],
        updatedAt: "2026-08-18T10:00:00.000Z"
      }],
      uploadProgress: { active: 5 }
    });
    render(<KnowledgeLibrary view={view({ detail: detailView, task: "detail" })} />);

    expect(screen.getByText("1 ready · 2 transferring · 1 needs attention", { exact: true }))
      .toBeVisible();
    expect(screen.getByRole("progressbar", { name: "active.md upload progress" }))
      .toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByTestId("knowledge-upload-item-expired"))
      .toHaveTextContent("The upload session expired");
    expect(screen.queryByText("knowledge_upload_session_expired")).not.toBeInTheDocument();

    const retry = new File(["0123456789"], "expired.md", { type: "text/markdown" });
    fireEvent.change(screen.getByLabelText("Retry"), { target: { files: [retry] } });
    expect(detailView.onResumeUpload).toHaveBeenCalledWith("batch-1", "expired", retry);
    const resume = new File(["0123456789"], "resume.md", { type: "text/markdown" });
    fireEvent.change(screen.getByLabelText("Resume"), { target: { files: [resume] } });
    expect(detailView.onResumeUpload).toHaveBeenCalledWith("batch-1", "resume", resume);
    fireEvent.click(within(screen.getByTestId("knowledge-upload-item-active")).getByRole(
      "button",
      { name: "Cancel" }
    ));
    expect(detailView.onCancelUpload).toHaveBeenCalledWith("batch-1", "active");
  });

  it("searches Sources and navigates bounded server pages", () => {
    const detailView = detail({
      sourcePage: 2,
      sourceQuery: "guide",
      sources: baseSources(source(), {
        pagination: {
          page: 2,
          pageSize: 25,
          query: "guide",
          totalItems: 26,
          totalPages: 2
        }
      })
    });
    render(<KnowledgeLibrary view={view({ detail: detailView, task: "detail" })} />);

    expect(screen.getByText(/Showing 26–26 of 26 matching/)).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search documents in this base" }), {
      target: { value: "incident" }
    });
    expect(detailView.onSourceQueryChange).toHaveBeenCalledWith("incident");
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(detailView.onSourcePageChange).toHaveBeenCalledWith(1);
  });

  it("keeps a shared Base read-only", () => {
    const shared = base({
      owned: false,
      ownerDisplayName: "Publisher",
      publications: null,
      scope: { groupNames: ["Research"], kind: "group" }
    });
    render(<KnowledgeLibrary view={view({
      detail: detail({ base: shared }),
      task: "detail"
    })} />);

    expect(screen.getByText("Read-only shared base")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.queryByText("Add documents")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Troubleshooting" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Publication" })).not.toBeInTheDocument();
  });

  it("confirms Base Trash and permanent deletion with the restoration boundary", () => {
    const active = detail();
    const { rerender } = render(
      <KnowledgeLibrary view={view({ detail: active, task: "detail" })} />
    );

    fireEvent.click(screen.getByRole("button", { name: "More actions for Product docs" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to Trash" }));
    const trashConfirmation = screen.getByRole("dialog", {
      name: "Move to Trash Product docs"
    });
    expect(trashConfirmation).toHaveTextContent("Future chats stop using this base immediately");
    expect(trashConfirmation).toHaveTextContent(
      "restore its document memberships and sharing settings"
    );
    fireEvent.click(within(trashConfirmation).getByRole("button", {
      name: "Confirm move to trash"
    }));
    expect(active.onTrash).toHaveBeenCalledOnce();

    const trashed = detail({
      base: base({
        purgeScheduledAt: "2026-09-17T10:00:00.000Z",
        readiness: readiness("trashed"),
        trashed: true,
        trashedAt: "2026-08-18T10:00:00.000Z",
        version: 2
      })
    });
    rerender(<KnowledgeLibrary view={view({ detail: trashed, task: "detail" })} />);

    expect(screen.getByText("Knowledge base is in Trash")).toBeVisible();
    expect(screen.getByRole("region", { name: "Knowledge base Trash actions" }))
      .toHaveTextContent(/Deleted .*purge scheduled/u);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(trashed.onRestore).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    const deleteConfirmation = screen.getByRole("dialog", {
      name: "Permanently delete Product docs"
    });
    expect(deleteConfirmation).toHaveTextContent("reusable documents stay in your Library");
    expect(deleteConfirmation).toHaveTextContent("Past answers remain unchanged");
    expect(deleteConfirmation).not.toHaveTextContent(/generic citation handles/iu);
    fireEvent.click(within(deleteConfirmation).getByRole("button", {
      name: "Confirm delete permanently"
    }));
    expect(trashed.onDeletePermanently).toHaveBeenCalledOnce();
  });

  it("confirms restoring a Source into multiple Bases and shows its purge window", () => {
    const sourceView = sourceDetail({
      source: source({
        membershipCount: 2,
        memberships: [
          { archived: false, id: "base-1", name: "Product docs" },
          { archived: false, id: "base-2", name: "Assistant docs" }
        ],
        purgeScheduledAt: "2026-09-17T10:00:00.000Z",
        trashed: true,
        trashedAt: "2026-08-18T10:00:00.000Z"
      })
    });
    render(<KnowledgeLibrary view={view({ sourceDetail: sourceView, task: "source-detail" })} />);

    expect(screen.getByRole("region", { name: "Document Trash actions" }))
      .toHaveTextContent(/Deleted .*purge scheduled/u);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(sourceView.onRestore).not.toHaveBeenCalled();
    const confirmation = screen.getByRole("dialog", { name: "Restore Product guide" });
    expect(confirmation).toHaveTextContent("belongs to 2 bases");
    fireEvent.click(within(confirmation).getByRole("button", {
      name: "Confirm restore document"
    }));
    expect(sourceView.onRestore).toHaveBeenCalledOnce();
  });

  it("switches to the reusable Source catalog and opens a Source", () => {
    const sourceValue = source();
    const { eligibleBases: _eligibleBases, memberships: _memberships, versions: _versions, ...summary } = sourceValue;
    const listView = list({
      catalog: "sources",
      sourceData: {
        pagination: { page: 1, pageSize: 25, query: "", totalItems: 1, totalPages: 1 },
        sources: [summary]
      }
    });
    render(<KnowledgeLibrary view={view({ list: listView })} />);

    expect(screen.getByText(/Documents are reusable files/)).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "Documents" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Document filters" }).querySelector("[aria-pressed=\"true\"]"))
      .toHaveTextContent("All");
    expect(knowledgeSubviewChrome(view({ list: listView }))).toEqual({
      backLabel: "Back to Knowledge",
      key: "sources",
      label: "Documents"
    });
    expect(screen.getByTestId("knowledge-source-source-1")).toHaveTextContent("Product guide");
    expect(screen.getByTestId("knowledge-source-source-1")).toHaveTextContent("1 base");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search documents" }), {
      target: { value: "policy" }
    });
    expect(listView.onSourceQueryChange).toHaveBeenCalledWith("policy");
    fireEvent.click(screen.getByText("Product guide"));
    expect(listView.onOpenSource).toHaveBeenCalledWith("source-1");
  });

  it("keeps Source add, move, and remove as distinct owner actions", () => {
    const detailView = sourceDetail();
    render(<KnowledgeLibrary view={view({ sourceDetail: detailView, task: "source-detail" })} />);

    expect(screen.getByText("History · 1 earlier version")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "More actions for Product guide" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Manage bases…" }));

    fireEvent.click(screen.getByLabelText("Assistant docs"));
    fireEvent.click(screen.getByRole("button", { name: "Add to selected" }));
    expect(detailView.onAddToBases).toHaveBeenCalledWith(["base-2"]);

    fireEvent.click(screen.getByRole("button", { name: "Move document" }));
    expect(detailView.onMove).toHaveBeenCalledWith("base-1", "base-2");

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const confirmation = screen.getByRole("dialog", { name: "Remove Product guide from Product docs" });
    expect(confirmation).toHaveTextContent("stays in your library and in its other bases");
    fireEvent.click(within(confirmation).getByRole("button", { name: "Confirm remove from base" }));
    expect(detailView.onRemoveFromBase).toHaveBeenCalledWith("base-1");
  });

  it("renders an authenticated page preview inside ready document details", () => {
    const { rerender } = render(
      <KnowledgeLibrary view={view({ sourceDetail: sourceDetail(), task: "source-detail" })} />
    );

    expect(screen.getByRole("img", { name: "product-guide.pdf, page 1" })).toHaveAttribute(
      "src",
      "/api/me/knowledge-sources/source-1/viewer?asset=page&page=1"
    );
    expect(screen.getByRole("link", { name: "Open original" })).toHaveAttribute(
      "href",
      "/api/me/knowledge-sources/source-1/viewer?asset=original#page=1"
    );
    expect(document.querySelector("iframe")).toBeNull();

    fireEvent.change(screen.getByRole("combobox", { name: "Preview page" }), {
      target: { value: "8" }
    });
    expect(screen.getByRole("img", { name: "product-guide.pdf, page 8" })).toBeVisible();

    const replacementBaseline = source();
    const replacementVersion = {
      ...replacementBaseline.currentVersion!,
      pageCount: 1,
      versionNumber: 3
    };
    const replacement = source({
      currentVersion: replacementVersion,
      versions: [replacementVersion, ...replacementBaseline.versions]
    });
    rerender(<KnowledgeLibrary view={view({
      sourceDetail: sourceDetail({ source: replacement }),
      task: "source-detail"
    })} />);

    expect(screen.getByRole("img", { name: "product-guide.pdf, page 1" })).toHaveAttribute(
      "src",
      "/api/me/knowledge-sources/source-1/viewer?asset=page&page=1"
    );
  });

  it("renders normalized text instead of an unavailable placeholder for ready non-visual documents", async () => {
    viewerMocks.loadKnowledgeSourceViewer.mockResolvedValueOnce({
      blocks: [{
        boundingBoxes: [],
        headingPath: ["Release policy"],
        pageEnd: 1,
        pageStart: 1,
        relation: "target",
        table: null,
        text: "Rollback remains available for fourteen calendar days.",
        type: "paragraph"
      }],
      excerpt: "Rollback remains available for fourteen calendar days.",
      excerptTruncated: false,
      headingPath: ["Release policy"],
      libraryAvailable: true,
      locator: { boundingBoxes: [], pageEnd: 1, pageStart: 1 },
      originalKind: null,
      source: {
        baseName: "Product docs",
        fileName: "release-policy.md",
        mimeType: "text/markdown",
        name: "Release policy",
        statuses: [],
        versionNumber: 2
      },
      state: "available",
      visual: null,
      workbook: null
    });
    const markdownVersion = {
      ...source().currentVersion!,
      fileName: "release-policy.md",
      pageCount: 1
    };
    const markdownSource = source({
      currentVersion: markdownVersion,
      versions: [markdownVersion]
    });

    render(<KnowledgeLibrary view={view({
      sourceDetail: sourceDetail({ source: markdownSource }),
      task: "source-detail"
    })} />);

    expect(await screen.findByTestId("knowledge-normalized-preview")).toHaveTextContent(
      "Rollback remains available for fourteen calendar days."
    );
    expect(screen.queryByText("This file does not have an in-app page preview.")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open original" })).toHaveAttribute(
      "href",
      "/api/me/knowledge-sources/source-1/viewer?asset=original"
    );
    expect(viewerMocks.loadKnowledgeSourceViewer).toHaveBeenCalledWith(
      "source-1",
      expect.any(AbortSignal)
    );
  });

  it("keeps a ready Source usable while surfacing bounded extraction warnings", () => {
    const current = source().currentVersion!;
    const warnedCurrent = {
      ...current,
      readiness: {
        state: "ready" as const,
        supportReference: null,
        warningCodes: ["table_extraction_degraded" as const]
      }
    };
    const warnedSource = source({
      currentVersion: warnedCurrent,
      readiness: warnedCurrent.readiness,
      versions: [warnedCurrent]
    });
    render(<KnowledgeLibrary view={view({
      sourceDetail: sourceDetail({
        draft: {
          description: warnedSource.description,
          name: warnedSource.name,
          tags: warnedSource.tags.join(", ")
        },
        source: warnedSource
      }),
      task: "source-detail"
    })} />);

    expect(within(screen.getByRole("region", { name: "Processing notes" }))
      .getByText("Ready")).toBeVisible();
    expect(screen.queryByText("Ready with warnings")).not.toBeInTheDocument();
    expect(screen.getByText("Processing note")).toBeVisible();
    expect(screen.getByText("Some table structure was simplified. Its text is searchable."))
      .toBeVisible();
    expect(screen.queryByRole("button", { name: "Reprocess" })).not.toBeInTheDocument();
    expect(screen.queryByText(/table_extraction_degraded|parser|score/iu)).not.toBeInTheDocument();
  });

  it("keeps a shared Source read-only and limits it to current safe metadata", () => {
    const current = source().currentVersion!;
    const shared = source({
      eligibleBases: [],
      memberships: [{ archived: false, id: "base-shared", name: "Shared policies" }],
      membershipCount: 1,
      owned: false,
      ownerDisplayName: "Publisher",
      versions: [current]
    });
    render(<KnowledgeLibrary view={view({
      sourceDetail: sourceDetail({
        draft: { description: shared.description, name: shared.name, tags: shared.tags.join(", ") },
        source: shared
      }),
      task: "source-detail"
    })} />);

    expect(screen.getByText("Read-only shared document")).toBeVisible();
    expect(screen.getByText("History · 0 earlier versions")).toBeVisible();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add to selected" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move document" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove from base" })).not.toBeInTheDocument();
  });

  it("names the Library crumb for every sub-view and keeps the Bases list out of it", () => {
    const detailView = detail();
    expect(isKnowledgeSubview(view({ list: list() }))).toBe(false);
    expect(isKnowledgeSubview(view({ list: list({ catalog: "sources" }) }))).toBe(true);
    expect(knowledgeSubviewChrome(view({ detail: detailView, task: "detail" }))).toEqual({
      backLabel: "Back to Knowledge",
      key: "detail:base-1",
      label: "Product docs"
    });
    expect(knowledgeSubviewChrome(view({ sourceDetail: sourceDetail(), task: "source-detail" }))).toEqual({
      backLabel: "Back to documents",
      key: "source:source-1",
      label: "Product guide"
    });
  });

  it("asks for an explicit discard before a dirty sub-view leaves through the Library", () => {
    const detailView = detail({ dirty: true });
    const after = vi.fn();
    function Harness() {
      const exit = useKnowledgeLibraryExit(view({ detail: detailView, task: "detail" }));
      return (
        <>
          <button onClick={() => exit.requestExit(after)} type="button">Back to Knowledge</button>
          {exit.confirmation}
        </>
      );
    }
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Back to Knowledge" }));
    const confirmation = screen.getByRole("dialog", { name: "Discard Knowledge base settings changes" });
    expect(detailView.onBack).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(after).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back to Knowledge" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm discard changes" }));
    expect(detailView.onBack).toHaveBeenCalledOnce();
    expect(after).toHaveBeenCalledOnce();
  });

  it("polls only while observed processing work is transient", async () => {
    vi.useFakeTimers();
    const processingSource = source({
      currentVersion: null,
      readiness: { state: "processing", supportReference: null, warningCodes: [] },
      versions: []
    });
    const detailView = detail({ sources: baseSources(processingSource) });
    render(<KnowledgeLibrary view={view({ detail: detailView, task: "detail" })} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(detailView.onRefresh).toHaveBeenCalledOnce();
  });
});
