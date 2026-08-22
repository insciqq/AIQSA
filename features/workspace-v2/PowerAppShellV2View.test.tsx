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
    notificationSoundEnabled: false,
    reasoningEffort: "medium",
    reasoningMode: "",
    searchPlanMode: "all_selected",
    selectSearchPlan: vi.fn(),
    selectedSearchOptionIds: [],
    showCitations: true,
    showReasoningBlocks: false,
    streamMode: true,
    temperature: "0.7",
    toggleCitationsVisibility: vi.fn(),
    toggleNotificationSound: vi.fn(),
    toggleReasoningBlockVisibility: vi.fn(),
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

  it("renders display toggles as real switches with visible on/off state", () => {
    const composer = runSetupComposer();
    render(<RunSetupV2 composer={composer} onClose={vi.fn()} />);

    const citations = screen.getByRole("switch", { name: /Citations/ });
    expect(citations).toHaveAttribute("aria-checked", "true");
    expect(citations).toHaveTextContent("Shown");
    fireEvent.click(citations);
    expect(composer.toggleCitationsVisibility).toHaveBeenCalledOnce();

    const reasoning = screen.getByRole("switch", { name: /Reasoning blocks/ });
    expect(reasoning).toHaveAttribute("aria-checked", "false");
    expect(reasoning).toHaveTextContent("Hidden");

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
        name: "Quarterly analyst",
        revisionNumber: 3
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
    const props = headerProps();
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
    expect(
      within(menu).getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual([
      "Share",
      "Rename",
      "Move to…",
      "Archive",
      "Delete…",
      "Export",
      "Export as JSON",
      "Copy entire thread",
      "Branches"
    ]);
    // Share is a mobile-only route; ≤899px CSS owns the breakpoint and
    // toggles this exact marker.
    expect(within(menu).getByRole("menuitem", { name: "Share" }))
      .toHaveAttribute("data-mobile-only");

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Export" }));
    expect(props.onExport).toHaveBeenLastCalledWith("markdown");
    expect(screen.queryByTestId("header-more-menu")).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Export as JSON" }));
    expect(props.onExport).toHaveBeenLastCalledWith("json");

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy entire thread" }));
    expect(props.onCopyThread).toHaveBeenCalledTimes(1);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Branches" }));
    expect(props.onBranches).toHaveBeenCalledTimes(1);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(props.onArchive).toHaveBeenCalledTimes(1);
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
