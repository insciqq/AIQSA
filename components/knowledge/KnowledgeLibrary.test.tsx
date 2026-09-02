import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    backLabel: "Back to Sources",
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
    maxUploadBytes: 50_000_000,
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
    maxUploadBytes: 50_000_000,
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
    expect(screen.getByText(/Up to 50 MB per file/)).toBeVisible();
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

  it("keeps Source troubleshooting safe and routes recovery through Source details", () => {
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
    expect(screen.getByText(/Up to 50 MB per file/)).toBeVisible();

    expect(screen.getByTestId("knowledge-readiness-summary")).toHaveTextContent(/needs attention/iu);
    expect(screen.getByText(/Support reference K-ABCDEF012345/)).toBeVisible();
    expect(screen.getByText(/Processing needs attention. Open the Source/)).toBeVisible();
    expect(screen.queryByText(/errorCode|embedding_failed|generation|revision|chunks?/iu))
      .not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open Source" }));
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

    expect(screen.getByText("The usable part is searchable")).toBeVisible();
    expect(screen.getByText("Some pages could not be read")).toBeVisible();
    expect(screen.queryByText(/partial_parse|unreadable_pages|coverage|confidence/iu))
      .not.toBeInTheDocument();
  });

  it("keeps retry and replacement actions on the canonical Source", () => {
    const affected = source({
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

    fireEvent.click(screen.getByRole("button", { name: "Retry processing" }));
    expect(detailView.onReprocess).toHaveBeenCalledOnce();

    const replacement = new File(["replacement"], "guide-new.md", { type: "text/markdown" });
    fireEvent.change(screen.getByLabelText("Replace file"), { target: { files: [replacement] } });
    expect(detailView.onReplace).toHaveBeenCalledWith(replacement);
  });

  it("uploads, opens, and removes a Source with product-level consequences", () => {
    const detailView = detail();
    render(<KnowledgeLibrary view={view({ detail: detailView, task: "detail" })} />);

    const first = new File(["first"], "first.md", { type: "text/markdown" });
    const second = new File(["second"], "second.txt", { type: "text/plain" });
    const transfer = { dropEffect: "none", files: [first, second], types: ["Files"] } as unknown as DataTransfer;
    fireEvent.drop(screen.getByTestId("knowledge-drop-zone"), { dataTransfer: transfer });
    expect(detailView.onUpload).toHaveBeenCalledWith([first, second]);

    fireEvent.click(screen.getByRole("button", { name: "Open Source" }));
    expect(detailView.onOpenSource).toHaveBeenCalledWith("source-1");

    fireEvent.click(screen.getByRole("button", { name: "Remove from base" }));
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
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Sources in this base" }), {
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
    expect(screen.queryByText("Add Sources")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Troubleshooting" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Publication" })).not.toBeInTheDocument();
  });

  it("confirms Base Trash and permanent deletion with the restoration boundary", () => {
    const active = detail();
    const { rerender } = render(
      <KnowledgeLibrary view={view({ detail: active, task: "detail" })} />
    );

    fireEvent.click(screen.getByRole("button", { name: "Move Product docs to Trash" }));
    const trashConfirmation = screen.getByRole("dialog", {
      name: "Move to Trash Product docs"
    });
    expect(trashConfirmation).toHaveTextContent("Future Chat, Project, and Assistant runs");
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
    expect(deleteConfirmation).toHaveTextContent("Canonical Sources remain available");
    expect(deleteConfirmation).toHaveTextContent("generic citation handles");
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

    expect(screen.getByRole("region", { name: "Source Trash actions" }))
      .toHaveTextContent(/Deleted .*purge scheduled/u);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(sourceView.onRestore).not.toHaveBeenCalled();
    const confirmation = screen.getByRole("dialog", { name: "Restore Product guide" });
    expect(confirmation).toHaveTextContent("2 Base memberships");
    fireEvent.click(within(confirmation).getByRole("button", {
      name: "Confirm restore source"
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

    expect(screen.getByText(/Sources are reusable files/)).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "Sources" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Source filters" }).querySelector("[aria-pressed=\"true\"]"))
      .toHaveTextContent("All");
    expect(knowledgeSubviewChrome(view({ list: listView }))).toEqual({
      backLabel: "Back to Knowledge",
      key: "sources",
      label: "Sources"
    });
    expect(screen.getByTestId("knowledge-source-source-1")).toHaveTextContent("Product guide");
    expect(screen.getByTestId("knowledge-source-source-1")).toHaveTextContent("1 base");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Sources" }), {
      target: { value: "policy" }
    });
    expect(listView.onSourceQueryChange).toHaveBeenCalledWith("policy");
    fireEvent.click(screen.getByText("Product guide"));
    expect(listView.onOpenSource).toHaveBeenCalledWith("source-1");
  });

  it("keeps Source add, move, and remove as distinct owner actions", () => {
    const detailView = sourceDetail();
    render(<KnowledgeLibrary view={view({ sourceDetail: detailView, task: "source-detail" })} />);

    expect(screen.getByText("One canonical file identity, reused wherever you add it.")).toBeVisible();
    expect(screen.getByText("Version history · 2")).toBeVisible();

    fireEvent.click(screen.getByLabelText("Assistant docs"));
    fireEvent.click(screen.getByRole("button", { name: "Add to selected" }));
    expect(detailView.onAddToBases).toHaveBeenCalledWith(["base-2"]);

    fireEvent.click(screen.getByRole("button", { name: "Move Source" }));
    expect(detailView.onMove).toHaveBeenCalledWith("base-1", "base-2");

    fireEvent.click(screen.getByRole("button", { name: "Remove from base" }));
    const confirmation = screen.getByRole("dialog", { name: "Remove Product guide from Product docs" });
    expect(confirmation).toHaveTextContent("stays in your library and in its other bases");
    fireEvent.click(within(confirmation).getByRole("button", { name: "Confirm remove from base" }));
    expect(detailView.onRemoveFromBase).toHaveBeenCalledWith("base-1");
  });

  it("opens a ready Source in the shared viewer from Source details", () => {
    const onPreviewSource = vi.fn();
    render(
      <KnowledgeLibrary
        onPreviewSource={onPreviewSource}
        view={view({ sourceDetail: sourceDetail(), task: "source-detail" })}
      />
    );

    const preview = screen.getByRole("button", { name: "Preview" });
    fireEvent.click(preview);
    expect(onPreviewSource).toHaveBeenCalledWith("source-1", preview);
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

    expect(screen.getAllByText("Ready with warnings").length).toBeGreaterThan(0);
    expect(screen.getByText("Some table structure was simplified")).toBeVisible();
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

    expect(screen.getByText("Read-only shared Source")).toBeVisible();
    expect(screen.getByText("Version history · 1")).toBeVisible();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add to selected" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move Source" })).not.toBeInTheDocument();
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
      backLabel: "Back to Sources",
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
