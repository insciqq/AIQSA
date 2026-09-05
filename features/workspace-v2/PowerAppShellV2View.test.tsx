import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composerGalleryConfig } from "@/app/ui-v2-fixture/_fixtures/ComposerV2Gallery";
import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import { resetSkillLibraryStoreForTest } from "@/components/app-shell/skillLibraryStore";
import { resetComposerControlStoreForTest } from "@/tests/support/appShellStores";
import {
  RunSetupV2,
  TemporaryChatIndicatorV2,
  WorkspaceHeaderV2,
  answerIdentityV2,
  knowledgeReferenceForMessageV2,
  retryAutoMcpDiscoveryV2,
  applyLoadAllAfterMcpDiscoveryFailureV2,
  blankConversationOrientationV2,
  chatLocationCrumbV2,
  ComposerOperationErrorV2,
  SkillLibraryOverlayV2,
  type RunSetupComposerV2
} from "./PowerAppShellV2View";
import { formatTemporaryRetentionDeadlineV2 } from "./WorkspaceHeaderV2";

const galleryModels = composerGalleryConfig.catalog.models;

afterEach(() => {
  resetComposerControlStoreForTest();
  resetSkillLibraryStoreForTest();
  vi.unstubAllGlobals();
});

describe("Skill Library overlay v2", () => {
  it("performs no list request until the shell opens the Library", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json({
      nextCursor: null,
      publishableWorkspaces: [],
      skills: [],
      viewer: { canPublishInstallation: false }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const props = {
      onClose: vi.fn(),
      onSelectionChange: vi.fn(),
      selectedIds: []
    };
    const { rerender } = render(<SkillLibraryOverlayV2 {...props} open={false} />);

    expect(fetchMock).not.toHaveBeenCalled();
    rerender(<SkillLibraryOverlayV2 {...props} open />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/me/skills");
  });
});

describe("MCP discovery failure actions v2", () => {
  it("preserves Auto on Retry and switches only on explicit Load all", () => {
    const regenerate = vi.fn();
    useComposerControlStore.getState().setMcpSelection({ mode: "load_all" });

    retryAutoMcpDiscoveryV2(regenerate);
    expect(useComposerControlStore.getState().mcpSelection).toEqual({ mode: "auto" });

    applyLoadAllAfterMcpDiscoveryFailureV2(regenerate);
    expect(useComposerControlStore.getState().mcpSelection).toEqual({ mode: "load_all" });
    expect(regenerate).toHaveBeenCalledTimes(2);
  });
});

describe("Composer operation error v2", () => {
  it("offers one explicit Retry action only for a retryable send rejection", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <ComposerOperationErrorV2
        error="Provider unavailable. Try again."
        live
        onRetry={onRetry}
        retryable
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Provider unavailable. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();

    rerender(
      <ComposerOperationErrorV2
        error="Upload failed."
        live={false}
        onRetry={onRetry}
        retryable={false}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Upload failed.");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

function runSetupComposer(overrides: Partial<RunSetupComposerV2> = {}): RunSetupComposerV2 {
  return {
    backgroundMode: false,
    changeBackgroundMode: vi.fn(),
    changeMaxOutputTokens: vi.fn(),
    changeReasoningEffort: vi.fn(),
    changeReasoningMode: vi.fn(),
    changeStreamMode: vi.fn(),
    changeTemperature: vi.fn(),
    currentModel: galleryModels[0],
    currentParameterControls: galleryModels[0]!.parameterControls,
    maxOutputTokens: "8192",
    reasoningEffort: "medium",
    reasoningMode: "",
    searchPlanMode: "all_selected",
    selectSearchPlan: vi.fn(),
    selectedSearchOptionIds: [],
    streamMode: true,
    temperature: "0.7",
    useOrganizationModelDefault: vi.fn(),
    useOrganizationSearchDefault: vi.fn(),
    ...overrides
  };
}

describe("Run setup v2", () => {
  it("names the current model and confirms organization-default resets visibly", () => {
    const composer = runSetupComposer();
    const { rerender } = render(<RunSetupV2 composer={composer} onClose={vi.fn()} />);

    expect(screen.getByTestId("run-setup-current-model")).toHaveTextContent(
      "Current model: GPT-5.2"
    );

    fireEvent.click(screen.getByRole("button", { name: "Use organization model default" }));
    expect(composer.useOrganizationModelDefault).toHaveBeenCalledOnce();
    expect(screen.getByTestId("run-setup-defaults-feedback")).toHaveTextContent(
      "Organization model default applied."
    );

    rerender(
      <RunSetupV2
        composer={runSetupComposer({ currentModel: galleryModels[2] })}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByTestId("run-setup-current-model")).toHaveTextContent(
      "Current model: Gemini 3 Pro"
    );

    fireEvent.click(screen.getByRole("button", { name: "Use organization Search default" }));
    expect(screen.getByTestId("run-setup-defaults-feedback")).toHaveTextContent(
      "Organization Search default applied."
    );
  });

  it("closes the params sheet from scrim tap, the close control, and Escape", () => {
    const onClose = vi.fn();
    render(<RunSetupV2 composer={runSetupComposer()} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Model parameters" });
    const scrim = dialog.parentElement!;

    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close parameters" }));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("keeps only model parameters as switches; display settings live in Settings", () => {
    const composer = runSetupComposer();
    render(<RunSetupV2 composer={composer} onClose={vi.fn()} />);

    // Citations, Reasoning blocks and the answer sound moved to Settings ›
    // General (UX audit 2026-09-02 B2): no duplicate toggles here.
    expect(screen.queryByRole("switch", { name: /Citations/ })).toBeNull();
    expect(screen.queryByRole("switch", { name: /Reasoning blocks/ })).toBeNull();
    expect(screen.queryByRole("switch", { name: /sound/i })).toBeNull();

    const streaming = screen.getByRole("switch", { name: /Streaming/ });
    expect(streaming).toHaveAttribute("aria-checked", "true");
    fireEvent.click(streaming);
    expect(composer.changeStreamMode).toHaveBeenCalledWith(false);
  });
});

describe("Answer identity v2", () => {
  it("keeps ordinary answers neutral", () => {
    expect(answerIdentityV2({})).toBeNull();
  });

  it("projects only the accepted Assistant identity", () => {
    expect(answerIdentityV2({
      assistantIdentity: {
        avatar: {
          accents: [1],
          backgroundShape: "circle",
          foregroundShape: "ring",
          kind: "generated",
          paletteId: "ocean",
          recipeVersion: 1,
          rotations: [0, 1]
        },
        name: "Quarterly analyst"
      }
    })).toEqual({
      label: "Quarterly analyst",
      testId: "answer-assistant-identity"
    });
  });
});

describe("Knowledge citation provenance v2", () => {
  it("uses the original answer authority for a copied branch message", () => {
    expect(knowledgeReferenceForMessageV2({
      citationMessageId: "assistant-source",
      id: "assistant-branch",
      runId: "run-source"
    }, {
      citations: [],
      knowledgeCitations: [{ handle: "K1" }],
      reasoningText: [],
      sources: []
    }, true)).toEqual({
      messageId: "assistant-source",
      runId: "run-source"
    });
  });

  it("does not expose a citation authority for unsettled or uncited answers", () => {
    const message = { id: "assistant", runId: "run" };
    expect(knowledgeReferenceForMessageV2(message, null, true)).toBeUndefined();
    expect(knowledgeReferenceForMessageV2(message, {
      citations: [],
      knowledgeCitations: [{ handle: "K1" }],
      reasoningText: [],
      sources: []
    }, false)).toBeUndefined();
  });
});

describe("Temporary chat indicator v2", () => {
  const memory = {
    explanation: "Temporary Chat reads and writes no personal Memory.",
    externalRetention: "External providers may retain data under their disclosed policies.",
    label: "Temporary chat",
    retention: "The complete chat aggregate is deleted after 24 hours.",
    retentionDeadline: "2026-08-14T12:00:00.000Z"
  };

  it("stays quiet until clicked, then disclosing the retention explainer", () => {
    render(<TemporaryChatIndicatorV2 memory={memory} />);

    const trigger = screen.getByTestId("header-temporary-indicator");
    expect(trigger).toHaveTextContent("Temporary chat");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Temporary chat" });
    expect(dialog).toHaveTextContent("deleted after 24 hours");
    expect(dialog).toHaveTextContent("External providers");
    const deadline = screen.getByTestId("temporary-retention-deadline");
    expect(deadline).toHaveTextContent("Scheduled deletion:");
    expect(deadline).not.toHaveTextContent("2026-08-14T12:00:00.000Z");
    expect(deadline.querySelector("time")).toHaveAttribute(
      "datetime",
      "2026-08-14T12:00:00.000Z"
    );

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("localizes the server retention instant instead of exposing raw ISO", () => {
    const formatted = formatTemporaryRetentionDeadlineV2(
      "2026-08-22T10:15:00.000Z",
      "en-US",
      "UTC"
    );

    expect(formatted).toBe("Aug 22, 2026, 10:15 AM");
    expect(formatted).not.toContain("T10:15:00.000Z");
  });
});

describe("Workspace header v2", () => {
  const temporaryMemory = {
    explanation: "Temporary Chat reads and writes no personal Memory.",
    externalRetention: "External providers may retain data under their disclosed policies.",
    label: "Temporary chat",
    retention: "The complete chat aggregate is deleted after 24 hours.",
    retentionDeadline: null
  };
  const folders = [
    { id: "root-a", name: "Research", parentId: null },
    { id: "child-a", name: "Recall", parentId: "root-a" },
    { id: "root-b", name: "Ops", parentId: null }
  ];

  function headerProps(overrides: Partial<Parameters<typeof WorkspaceHeaderV2>[0]> = {}) {
    return {
      active: true,
      editingTitle: null,
      folders,
      onArchive: vi.fn(),
      onBranches: vi.fn(),
      onCopyThread: vi.fn(),
      onDelete: vi.fn(),
      onExport: vi.fn(),
      onMove: vi.fn(),
      onRenameCancel: vi.fn(),
      onRenameChange: vi.fn(),
      onRenameSave: vi.fn(),
      onRenameStart: vi.fn(),
      onShare: vi.fn(),
      shareDisabled: false,
      temporaryMemory: null,
      title: "Release checklist",
      ...overrides
    } satisfies Parameters<typeof WorkspaceHeaderV2>[0];
  }

  it("keeps one kicker-free header: Share plus a single complete ⋯ menu", () => {
    const props = headerProps({
      favorite: true,
      memoryUsed: true,
      onFavorite: vi.fn(),
      onMemoryMode: vi.fn()
    });
    render(<WorkspaceHeaderV2 {...props} />);

    // No kicker and no standalone Copy/Branches buttons remain.
    expect(screen.queryByText("Conversation")).toBeNull();
    expect(screen.queryByText("Reading Room")).toBeNull();
    expect(screen.queryByRole("button", { name: "Копировать" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Branches" })).toBeNull();
    expect(screen.getByRole("button", { name: "Share" })).toBeVisible();

    const trigger = screen.getByTestId("header-more-trigger");
    fireEvent.click(trigger);
    const menu = screen.getByTestId("header-more-menu");
    // Three groups (UX audit F17): chat · content · destructive last.
    expect(
      within(menu).getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual([
      "Rename",
      "Move to…",
      "Favorite",
      "Exclude from Memory",
      "Share",
      "Branches",
      "Export",
      "Archive",
      "Delete…"
    ]);
    expect(within(menu).getAllByRole("separator")).toHaveLength(2);
    expect(within(menu).getByRole("menuitem", { name: "Delete…" }))
      .toHaveAttribute("data-tone", "destructive");
    expect(within(menu).getByRole("menuitem", { name: "Archive" }))
      .not.toHaveAttribute("data-tone");
    // Share is a mobile-only route; ≤767px CSS owns the breakpoint and
    // toggles this exact marker.
    expect(within(menu).getByRole("menuitem", { name: "Share" }))
      .toHaveAttribute("data-mobile-only");

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Export" }));
    expect(within(screen.getByLabelText("Export")).getAllByRole("menuitem")
      .map((item) => item.textContent)).toEqual([
      "Markdown",
      "JSON",
      "Copy entire thread"
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Markdown" }));
    expect(props.onExport).toHaveBeenLastCalledWith("markdown");
    expect(screen.queryByTestId("header-more-menu")).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "JSON" }));
    expect(props.onExport).toHaveBeenLastCalledWith("json");

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy entire thread" }));
    expect(props.onCopyThread).toHaveBeenCalledTimes(1);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Branches" }));
    expect(props.onBranches).toHaveBeenCalledTimes(1);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(props.onArchive).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus();
  });

  it("chooses the model from the header selector and locks it under an Assistant", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <WorkspaceHeaderV2
        {...headerProps({ active: false })}
        modelSelector={{
          expanded: false,
          family: "anthropic",
          label: "Anthropic",
          name: "Claude Opus 5",
          onToggle
        }}
      />
    );

    // The blank chat keeps the header for the selector alone: no title, no actions.
    const trigger = screen.getByTestId("header-model-trigger");
    expect(trigger).toHaveAccessibleName("Claude Opus 5");
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger.querySelector("use")).toHaveAttribute("href", "#v2-icon-provider-anthropic");
    expect(screen.queryByTestId("header-title")).toBeNull();
    expect(screen.queryByTestId("header-more-trigger")).toBeNull();
    fireEvent.click(trigger);
    expect(onToggle).toHaveBeenCalledWith(trigger);

    rerender(
      <WorkspaceHeaderV2
        {...headerProps()}
        modelSelector={{
          expanded: true,
          family: "openai_compatible",
          label: "Custom OpenAI",
          locked: true,
          name: "Decision Writer · gpt-5.6-terra",
          onToggle
        }}
      />
    );
    const locked = screen.getByTestId("header-model-trigger");
    expect(locked).toBeDisabled();
    expect(locked).toHaveAttribute("title", "Managed by the Assistant");
    expect(locked).toHaveAttribute("aria-expanded", "true");
    expect([...locked.querySelectorAll("use")].map((use) => use.getAttribute("href")))
      .toEqual(["#v2-icon-plug", "#v2-icon-lock"]);
    expect(screen.getByTestId("header-title")).toBeVisible();
  });

  it("gates Delete… on the capability and lists nested move destinations", () => {
    const props = headerProps({ onDelete: null });
    const { rerender } = render(<WorkspaceHeaderV2 {...props} />);

    fireEvent.click(screen.getByTestId("header-more-trigger"));
    expect(screen.queryByRole("menuitem", { name: "Delete…" })).toBeNull();

    const onDelete = vi.fn();
    const onMove = vi.fn();
    rerender(<WorkspaceHeaderV2 {...headerProps({ onDelete, onMove })} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    expect(onDelete).toHaveBeenCalledTimes(1);

    // Move discloses the complete nested folder list with indentation.
    fireEvent.click(screen.getByTestId("header-more-trigger"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
    const submenu = screen.getByLabelText("Move to…");
    const labels = within(submenu).getAllByRole("menuitem").map((item) => item.textContent);
    expect(labels).toEqual(["No folder", "Research", "Recall", "Ops"]);
    const nested = within(submenu).getByRole("menuitem", { name: "Recall" });
    expect(nested.style.paddingLeft).toBe("1.25rem");
    fireEvent.click(nested);
    expect(onMove).toHaveBeenCalledWith("child-a");
    expect(screen.queryByTestId("header-more-menu")).toBeNull();
  });

  it("uses Project root for manager movement and hides movement without authority", () => {
    const onMove = vi.fn();
    const projectFolders = folders.map((folder) => ({ ...folder, parentId: null }));
    const { rerender } = render(
      <WorkspaceHeaderV2
        {...headerProps({ folders: projectFolders, moveRootLabel: "Project root", onMove })}
      />
    );

    fireEvent.click(screen.getByTestId("header-more-trigger"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
    const submenu = screen.getByLabelText("Move to…");
    expect(within(submenu).getAllByRole("menuitem").map((item) => item.textContent))
      .toEqual(["Project root", "Research", "Recall", "Ops"]);
    fireEvent.click(within(submenu).getByRole("menuitem", { name: "Research" }));
    expect(onMove).toHaveBeenCalledWith("root-a");

    rerender(<WorkspaceHeaderV2 {...headerProps({ folders: projectFolders, onMove: null })} />);
    fireEvent.click(screen.getByTestId("header-more-trigger"));
    expect(screen.queryByRole("menuitem", { name: "Move to…" })).toBeNull();
  });

  it("starts inline rename from the title with the shared ✓/✕ pattern", () => {
    const props = headerProps();
    const { rerender } = render(<WorkspaceHeaderV2 {...props} />);

    fireEvent.click(screen.getByTestId("header-title"));
    expect(props.onRenameStart).toHaveBeenCalledTimes(1);

    rerender(<WorkspaceHeaderV2 {...props} editingTitle="Черновик названия" />);
    const input = screen.getByRole("textbox", { name: "New title: Release checklist" });
    expect(input).toHaveValue("Черновик названия");
    fireEvent.change(input, { target: { value: "Новое имя" } });
    expect(props.onRenameChange).toHaveBeenCalledWith("Новое имя");

    fireEvent.click(screen.getByRole("button", { name: "Save title" }));
    expect(props.onRenameSave).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel rename" }));
    expect(props.onRenameCancel).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: "Escape" });
    expect(props.onRenameCancel).toHaveBeenCalledTimes(2);
  });

  it("shows the canonical New chat placeholder until a real title exists", () => {
    render(<WorkspaceHeaderV2 {...headerProps({ title: "New Chat" })} />);

    expect(screen.getByTestId("header-title")).toHaveTextContent("New chat");
    expect(screen.queryByText("New Chat")).toBeNull();
  });

  it("keeps the welcome header empty and carries no account menu", () => {
    const props = headerProps({ active: false });
    render(<WorkspaceHeaderV2 {...props} />);

    // Welcome: no title, no kicker, no chat actions — a quiet bar.
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByTestId("header-more-trigger")).toBeNull();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Commands" })).toBeNull();
    // The account menu is the sidebar footer's single entry, never a header one.
    expect(screen.queryByRole("button", { name: "Account menu" })).toBeNull();
  });

  it("keeps Share governance, the Temporary indicator, and shared dismissal", () => {
    const props = headerProps({ shareDisabled: true, temporaryMemory });
    render(<WorkspaceHeaderV2 {...props} />);

    expect(screen.getByTestId("header-temporary-indicator")).toHaveTextContent("Temporary chat");

    const trigger = screen.getByTestId("header-more-trigger");
    fireEvent.click(trigger);
    const share = screen.getByRole("menuitem", { name: "Share" });
    expect(share).toBeDisabled();
    fireEvent.click(share);
    expect(props.onShare).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Branches" }), { key: "Escape" });
    expect(screen.queryByTestId("header-more-menu")).toBeNull();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("header-more-menu")).toBeNull();
  });

});

describe("Chat location crumb v2", () => {
  it("uses the Project-owned hierarchy and prefixes the Project name", () => {
    expect(chatLocationCrumbV2({
      chat: { folderId: "project-child", projectId: "project-1" },
      personalFolders: [{ id: "project-child", name: "Personal leak", parentId: null }],
      project: { id: "project-1", name: "Ingest pipeline" },
      projectFolders: [
        { id: "project-root", name: "Specs", parentId: null },
        { id: "project-child", name: "Retries", parentId: "project-root" }
      ]
    })).toBe("Ingest pipeline / Specs / Retries");

    expect(chatLocationCrumbV2({
      chat: { folderId: null, projectId: "project-1" },
      personalFolders: [],
      project: { id: "project-1", name: "Ingest pipeline" },
      projectFolders: []
    })).toBe("Ingest pipeline");
  });

  it("keeps personal paths separate and fails closed for a mismatched Project", () => {
    const personalFolders = [
      { id: "personal-root", name: "Research", parentId: null },
      { id: "personal-child", name: "Recall", parentId: "personal-root" }
    ];
    expect(chatLocationCrumbV2({
      chat: { folderId: "personal-child", projectId: null },
      personalFolders,
      project: null,
      projectFolders: []
    })).toBe("Research / Recall");
    expect(chatLocationCrumbV2({
      chat: { folderId: "personal-child", projectId: "project-missing" },
      personalFolders,
      project: { id: "other-project", name: "Other" },
      projectFolders: []
    })).toBeNull();
  });
});

describe("Blank welcome v2", () => {
  it("shows the Project Assistant intro instead of hiding it behind Project orientation", () => {
    render(<>{blankConversationOrientationV2({
      assistantOrientation: <section data-testid="project-assistant-intro">Assistant starters</section>,
      projectOrientation: <section data-testid="project-generic-intro">Shared project</section>,
      projectSelected: true
    })}</>);

    expect(screen.getByTestId("project-assistant-intro")).toBeVisible();
    expect(screen.queryByTestId("project-generic-intro")).toBeNull();
  });

  it("leaves the personal blank chat to the quiet greeting with no generic starter prompts", () => {
    expect(blankConversationOrientationV2({
      projectOrientation: <section>Shared project</section>,
      projectSelected: false
    })).toBeUndefined();

    render(<>{blankConversationOrientationV2({
      assistantOrientation: <section data-testid="assistant-intro">Assistant</section>,
      projectSelected: false
    })}</>);
    expect(screen.getByTestId("assistant-intro")).toBeVisible();
  });
});
