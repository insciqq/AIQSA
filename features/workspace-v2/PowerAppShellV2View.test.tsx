import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { composerGalleryConfig } from "@/features/composer-v2/ComposerV2Gallery";
import {
  RunSetupV2,
  TemporaryChatIndicatorV2,
  WelcomeOrientationV2,
  WorkspaceHeaderV2,
  answerIdentityV2,
  blankWelcomeStartersVisibleV2,
  type RunSetupComposerV2
} from "./PowerAppShellV2View";

const galleryModels = composerGalleryConfig.catalog.models;

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
      label: "Quarterly analyst · revision 3",
      testId: "answer-assistant-identity"
    });
  });
});

describe("Temporary chat indicator v2", () => {
  const memory = {
    explanation: "Temporary Chat reads and writes no personal Memory.",
    externalRetention: "External providers may retain data under their disclosed policies.",
    label: "Temporary chat",
    retention: "The complete chat aggregate is deleted after 24 hours.",
    retentionDeadline: "Aug 14, 12:00"
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
    expect(screen.getByTestId("temporary-retention-deadline")).toHaveTextContent(
      "Aug 14, 12:00"
    );

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
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
      accountEmail: "operator@example.com",
      adminEntryVisible: false,
      editingTitle: null,
      folders,
      onArchive: vi.fn(),
      onBranches: vi.fn(),
      onCommands: vi.fn(),
      onCopyThread: vi.fn(),
      onDelete: vi.fn(),
      onExport: vi.fn(),
      onLibrary: vi.fn(),
      onMove: vi.fn(),
      onRenameCancel: vi.fn(),
      onRenameChange: vi.fn(),
      onRenameSave: vi.fn(),
      onRenameStart: vi.fn(),
      onSettings: vi.fn(),
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

  it("keeps the welcome header empty and the account menu to one archive entry", () => {
    const props = headerProps({ active: false });
    render(<WorkspaceHeaderV2 {...props} />);

    // Welcome: no title, no kicker, no chat actions — quiet actions only.
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByTestId("header-more-trigger")).toBeNull();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.getByRole("button", { name: "Commands" })).toBeVisible();

    // The sidebar «Archived chats» row is the single archive entry.
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    const account = screen.getByRole("menu", { name: "Account" });
    expect(within(account).queryByRole("menuitem", { name: "Archived chats" })).toBeNull();
    expect(within(account).getByRole("menuitem", { name: "Library" })).toBeVisible();
    expect(within(account).getByRole("menuitem", { name: "Settings" })).toBeVisible();
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
  it("shows starter prompts exactly on the untouched blank welcome", () => {
    expect(blankWelcomeStartersVisibleV2({
      assistantSelected: false,
      attachmentCount: 0,
      draft: "",
      uploading: false
    })).toBe(true);
    expect(blankWelcomeStartersVisibleV2({
      assistantSelected: true,
      attachmentCount: 0,
      draft: "",
      uploading: false
    })).toBe(false);
    expect(blankWelcomeStartersVisibleV2({
      assistantSelected: false,
      attachmentCount: 0,
      draft: "  черновик",
      uploading: false
    })).toBe(false);
    expect(blankWelcomeStartersVisibleV2({
      assistantSelected: false,
      attachmentCount: 1,
      draft: "",
      uploading: false
    })).toBe(false);
    expect(blankWelcomeStartersVisibleV2({
      assistantSelected: false,
      attachmentCount: 0,
      draft: "",
      uploading: true
    })).toBe(false);
  });

  it("greets quietly with prompts and no wordmark or marketing subtitle", () => {
    const onPickPrompt = vi.fn();
    const onOpenAssistantPicker = vi.fn();
    render(
      <WelcomeOrientationV2
        showAssistantEntry
        onOpenAssistantPicker={onOpenAssistantPicker}
        onPickPrompt={onPickPrompt}
      />
    );

    expect(screen.getByRole("heading", { name: "What are we working on?" })).toBeVisible();
    expect(screen.queryByText("AIQSA")).toBeNull();
    expect(screen.queryByText(/Спросите, исследуйте/u)).toBeNull();

    const starters = screen.getByLabelText("Starter prompts");
    const buttons = within(starters).getAllByRole("button");
    expect(buttons.length).toBeLessThanOrEqual(4);
    fireEvent.click(buttons[0]!);
    expect(onPickPrompt).toHaveBeenCalledWith(buttons[0]!.textContent);
    fireEvent.click(within(starters).getByRole("button", { name: "Start with an Assistant…" }));
    expect(onOpenAssistantPicker).toHaveBeenCalledTimes(1);
  });
});
