import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { composerGalleryConfig } from "@/features/composer-v2/ComposerV2Gallery";
import type { ThreadArtifactSummary } from "@/lib/contracts/chats";
import {
  LiveEvidenceV2,
  RunSetupV2,
  TemporaryChatIndicatorV2,
  WelcomeOrientationV2,
  WorkspaceHeaderV2,
  answerIdentityV2,
  blankWelcomeStartersVisibleV2,
  type RunSetupComposerV2
} from "./PowerAppShellV2View";

const galleryModels = composerGalleryConfig.catalog.models;
const galleryCatalog = composerGalleryConfig.catalog;

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
    showToolActivity: true,
    streamMode: true,
    temperature: "0.7",
    toggleCitationsVisibility: vi.fn(),
    toggleNotificationSound: vi.fn(),
    toggleReasoningBlockVisibility: vi.fn(),
    toggleToolActivityVisibility: vi.fn(),
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
  it("resolves only catalog display names and never adapter, model, or UUID ids", () => {
    expect(answerIdentityV2(galleryCatalog, {
      modelId: "gpt-5.2",
      provider: "openai-work"
    })).toEqual({ label: "GPT-5.2", testId: "evidence-row-model" });

    // Unknown historical binding: omit instead of leaking a raw identifier.
    expect(answerIdentityV2(galleryCatalog, {
      modelId: "gpt-5.6-terra",
      provider: "openai_compatible"
    })).toBeNull();
    expect(answerIdentityV2(galleryCatalog, {
      modelId: "6681cb85-2f4d-4bd1-9a53-8d21c7e64b02",
      provider: "396b627a-1c9f-4e58-9d1f-2b9a5c1e7a10"
    })).toBeNull();
    expect(answerIdentityV2(null, { modelId: "gpt-5.2" })).toBeNull();
  });

  it("prefers the accepted Assistant identity", () => {
    expect(answerIdentityV2(galleryCatalog, {
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
      },
      modelId: "gpt-5.2",
      provider: "openai-work"
    })).toEqual({
      label: "Quarterly analyst · revision 3",
      testId: "answer-assistant-identity"
    });
  });
});

describe("Live evidence v2", () => {
  const artifact: ThreadArtifactSummary = {
    citationCount: 0,
    citations: [],
    reasoningCount: 1,
    reasoningText: ["**Identifying need**\n\nCompare the sources."],
    searchActivity: [{
      displayName: "OpenAI Search",
      providerOperations: null,
      providerOperationsTruncated: false,
      query: "quarterly comparison",
      sourceCount: 3,
      sources: [
        { rank: 1, title: "Quarterly guide", url: "https://example.com/guide" }
      ],
      status: "complete"
    }],
    searchCount: 1,
    searchDisplayName: "OpenAI Search",
    searchStrategy: "openai-native-web-search",
    toolCallCount: 0,
    toolCalls: []
  };

  it("assembles one muted row with non-zero counters, optional identity, and no token text", () => {
    render(
      <LiveEvidenceV2
        artifact={artifact}
        identity={{ label: "GPT-5.2", testId: "evidence-row-model" }}
        locale="RU"
        showReasoning
        showTools
        summary={{ fileCount: 2, hasUsage: true, sourceCount: 3, toolCallCount: 0 }}
        onOpenRunDetails={vi.fn()}
      />
    );

    const row = screen.getByTestId("evidence-row");
    expect(row).toHaveTextContent("GPT-5.2");
    expect(row).toHaveTextContent("Sources 3");
    expect(row).toHaveTextContent("Files 2");
    expect(row).toHaveTextContent("Run details");
    expect(row).not.toHaveTextContent("Tools");

    // Token counts live only in the Run details drawer; adapter ids never
    // render anywhere in the feed.
    expect(document.body.textContent).not.toMatch(/token/iu);
    expect(document.body.textContent).not.toContain("openai_compatible");
    expect(document.body.textContent).not.toContain("openai-work");

    // Reasoning renders sanitized with a counter-free header.
    const reasoning = screen.getByTestId("reasoning-evidence");
    expect(reasoning.querySelector("summary")).toHaveTextContent(/^Reasoning$/u);
    expect(reasoning.textContent).not.toContain("**");
  });

  it("keeps the row to Run details alone when no counters and no identity exist", () => {
    render(
      <LiveEvidenceV2
        artifact={null}
        identity={null}
        locale="RU"
        showReasoning={false}
        showTools={false}
        summary={null}
        onOpenRunDetails={vi.fn()}
      />
    );

    expect(screen.getByTestId("evidence-row")).toHaveTextContent(/^Run details$/u);
    expect(screen.queryByTestId("evidence-row-model")).toBeNull();
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
      onRunDetails: vi.fn(),
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
      "Branches",
      "Run details"
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
    fireEvent.click(screen.getByRole("menuitem", { name: "Run details" }));
    expect(props.onRunDetails).toHaveBeenCalledTimes(1);

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

  it("disables Run details without a settled answer run", () => {
    render(<WorkspaceHeaderV2 {...headerProps({ onRunDetails: null })} />);

    fireEvent.click(screen.getByTestId("header-more-trigger"));
    expect(screen.getByRole("menuitem", { name: "Run details" })).toBeDisabled();
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
