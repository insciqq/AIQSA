import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptEditorDraft } from "./promptSettingsStore";
import { resetMcpSettingsStoreForTest, useMcpSettingsStore } from "./mcpSettingsStore";
import { SettingsDialog } from "./SettingsDialog";

const prompts = [
  {
    developerPrompt: null,
    id: "prompt-default",
    isDefault: true,
    name: "Helpful Assistant",
    systemPrompt: "Be helpful."
  },
  {
    developerPrompt: "Check assumptions.",
    id: "prompt-custom",
    isDefault: false,
    name: "Research Prompt",
    systemPrompt: "Research carefully."
  }
];

const defaultEditor: PromptEditorDraft = {
  developerPrompt: "",
  id: "prompt-default",
  name: "Helpful Assistant",
  systemPrompt: "Be helpful."
};

const customEditor: PromptEditorDraft = {
  developerPrompt: "Check assumptions.",
  id: "prompt-custom",
  name: "Research Prompt",
  systemPrompt: "Research carefully."
};

function renderDialog(
  editor: PromptEditorDraft = defaultEditor,
  overrides: Partial<Parameters<typeof SettingsDialog>[0]> = {}
) {
  const props = {
    currentPromptId: "prompt-default",
    defaultPromptId: "prompt-default",
    editor,
    onClose: vi.fn(),
    onCreatePrompt: vi.fn(),
    onDeletePrompt: vi.fn(),
    onDuplicatePrompt: vi.fn(),
    onEditPrompt: vi.fn(),
    onEditorChange: vi.fn(),
    onNewPrompt: vi.fn(),
    onSetDefaultPrompt: vi.fn(),
    onThemeChange: vi.fn(),
    onUpdatePrompt: vi.fn(),
    onUsePrompt: vi.fn(),
    prompts,
    saving: false,
    themeId: "aiqsa" as const
  };

  const renderProps = { ...props, ...overrides };
  const view = render(<SettingsDialog {...renderProps} />);

  return {
    ...renderProps,
    ...view,
    rerenderEditor(nextEditor: PromptEditorDraft) {
      view.rerender(<SettingsDialog {...renderProps} editor={nextEditor} />);
    }
  };
}

function confirmDiscard() {
  fireEvent.click(screen.getByRole("button", { name: "Confirm discard changes" }));
}

describe("SettingsDialog", () => {
  beforeEach(() => {
    resetMcpSettingsStoreForTest();
    useMcpSettingsStore.setState({ loadState: "ready" });
  });

  afterEach(() => {
    cleanup();
    resetMcpSettingsStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens directly on the MCP section when requested", () => {
    renderDialog(defaultEditor, { initialSection: "mcp" });

    expect(screen.getByRole("heading", { name: "MCP & tools" })).toBeVisible();
    expect(screen.getByRole("button", { name: "MCP & tools" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps editing, next-run selection, and the user default as separate actions", () => {
    const props = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Edit prompt Research Prompt" }));
    expect(props.onEditPrompt).toHaveBeenCalledWith(prompts[1]);
    expect(props.onUsePrompt).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Use prompt Research Prompt for next run" }));
    expect(props.onUsePrompt).toHaveBeenCalledWith("prompt-custom");

    fireEvent.click(screen.getByRole("button", { name: "Set prompt Research Prompt as default" }));
    expect(props.onSetDefaultPrompt).toHaveBeenCalledWith("prompt-custom");
    expect(screen.getByText(/Next run:/).parentElement).toHaveTextContent("Helpful Assistant");
    expect(screen.getByText(/User default:/).parentElement).toHaveTextContent("Helpful Assistant");
    expect(screen.getByText(/Selection alone does not change the next run/)).toBeVisible();
  });

  it("emits editor updates and explicit save, duplicate, and delete actions", () => {
    const props = renderDialog({
      ...customEditor,
      name: "Research Prompt draft"
    });

    fireEvent.change(screen.getByLabelText("Settings system prompt"), {
      target: { value: "Updated system." }
    });
    expect(props.onEditorChange).toHaveBeenCalledWith({
      developerPrompt: "Check assumptions.",
      id: "prompt-custom",
      name: "Research Prompt draft",
      systemPrompt: "Updated system."
    });

    fireEvent.click(screen.getByRole("button", { name: "Update prompt" }));
    expect(props.onUpdatePrompt).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Duplicate prompt Research Prompt" }));
    expect(screen.getByRole("dialog", { name: "Discard prompt changes" })).toBeInTheDocument();
    confirmDiscard();
    expect(props.onEditPrompt).toHaveBeenCalledWith(prompts[1]);
    expect(props.onDuplicatePrompt).toHaveBeenCalledWith(prompts[1]);
  });

  it("closes dirty discard ownership before requesting the external delete confirmation", async () => {
    const props = renderDialog({ ...customEditor, name: "Research Prompt draft" });

    fireEvent.click(screen.getByRole("button", { name: "Delete selected prompt" }));
    expect(screen.getByRole("dialog", { name: "Discard prompt changes" })).toBeVisible();
    confirmDiscard();

    expect(screen.queryByRole("dialog", { name: "Discard prompt changes" })).not.toBeInTheDocument();
    expect(props.onDeletePrompt).not.toHaveBeenCalled();
    await waitFor(() => expect(props.onDeletePrompt).toHaveBeenCalledWith(prompts[1]));
  });

  it("derives readable delete protection from the selected default prompt id", () => {
    const props = renderDialog(undefined, {
      currentPromptId: "prompt-custom",
      defaultPromptId: "prompt-custom",
      editor: defaultEditor,
      prompts: [
        {
          ...prompts[0],
          isDefault: false
        },
        {
          ...prompts[1],
          isDefault: true
        }
      ]
    });

    expect(screen.getByRole("button", { name: "Delete prompt Helpful Assistant" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete prompt Research Prompt" })).toBeDisabled();
    expect(screen.getByText("Protected while this is the user default.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Delete selected prompt" }));
    expect(props.onDeletePrompt).toHaveBeenCalledWith(expect.objectContaining({ id: "prompt-default" }));
  });

  it("puts focus in the editor, closes cleanly on Escape, and restores the opener", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open settings";
    document.body.appendChild(trigger);
    trigger.focus();

    const props = renderDialog();

    await waitFor(() => expect(screen.getByLabelText("Prompt name")).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledOnce();

    props.unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("puts the prompt library and New before the editor on narrow layouts, then opens a selected editor", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) =>
        ({
          matches: query === "(max-width: 1023px)",
          media: query
        }) as MediaQueryList
      )
    );
    const props = renderDialog();

    const libraryHeading = screen.getByRole("heading", { name: "Prompt library" });
    const editorHeading = screen.getByRole("heading", { name: "Helpful Assistant" });
    expect(libraryHeading.closest("section")).toHaveClass("order-1", "lg:order-1");
    expect(editorHeading.closest("section")).toHaveClass("order-2", "lg:order-2");
    expect(screen.getByRole("button", { name: "New prompt" })).toBeVisible();
    await waitFor(() => expect(libraryHeading).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Edit prompt Research Prompt" }));
    expect(props.onEditPrompt).toHaveBeenCalledWith(prompts[1]);
    props.rerenderEditor(customEditor);

    await waitFor(() => expect(screen.getByLabelText("Prompt name")).toHaveFocus());
    expect(screen.getByLabelText("Prompt name")).toHaveValue("Research Prompt");
  });

  it("routes close, Escape, and backdrop dismissal through dirty confirmation", () => {
    const props = renderDialog({
      ...defaultEditor,
      name: "Changed name"
    });

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    const firstConfirmation = screen.getByRole("dialog", { name: "Discard prompt changes" });
    expect(firstConfirmation).toBeInTheDocument();
    expect(screen.getByTestId("settings-dialog")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("settings-dialog")).toHaveAttribute("inert");

    fireEvent.keyDown(firstConfirmation, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Discard prompt changes" })).not.toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(props.onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByTestId("settings-backdrop"));
    expect(screen.getByRole("dialog", { name: "Discard prompt changes" })).toBeInTheDocument();
    confirmDiscard();
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("closes directly from a clean backdrop click", () => {
    const props = renderDialog();

    fireEvent.mouseDown(screen.getByTestId("settings-backdrop"));
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("yields modal semantics and keyboard ownership to an external child confirmation", () => {
    const props = renderDialog(undefined, { nestedDialogOpen: true });
    const settings = screen.getByTestId("settings-dialog");

    expect(settings).toHaveAttribute("aria-hidden", "true");
    expect(settings).toHaveAttribute("inert");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("requires confirmation before dirty section, edit, and new-prompt transitions", () => {
    const dirtyEditor = {
      ...defaultEditor,
      name: "Changed name"
    };

    const sectionProps = renderDialog(dirtyEditor);
    const appearanceSection = screen.getByRole("button", { name: "Appearance" });
    appearanceSection.focus();
    fireEvent.click(appearanceSection);
    expect(screen.getByRole("dialog", { name: "Discard prompt changes" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Appearance" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Prompt name")).toHaveValue("Changed name");
    expect(appearanceSection).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    confirmDiscard();
    expect(sectionProps.onEditPrompt).toHaveBeenCalledWith(prompts[0]);
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeVisible();
    sectionProps.unmount();

    const editProps = renderDialog(dirtyEditor);
    fireEvent.click(screen.getByRole("button", { name: "Edit prompt Research Prompt" }));
    confirmDiscard();
    expect(editProps.onEditPrompt).toHaveBeenCalledWith(prompts[1]);
    editProps.unmount();

    const newProps = renderDialog(dirtyEditor);
    fireEvent.click(screen.getByRole("button", { name: "New prompt" }));
    confirmDiscard();
    expect(newProps.onNewPrompt).toHaveBeenCalledOnce();
  });

  it("shows dirty validation and saving feedback while locking editor-replacing actions", () => {
    const empty = renderDialog({
      developerPrompt: "",
      id: null,
      name: "",
      systemPrompt: ""
    });

    expect(screen.getByLabelText("Prompt name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Settings system prompt")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("prompt-name-required-indicator")).toHaveClass("text-accent-rose");
    expect(screen.getByTestId("system-prompt-required-indicator")).toHaveClass("text-accent-rose");
    expect(screen.getByText("Enter a prompt name.")).toBeVisible();
    expect(screen.getByText("Enter system instructions.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Create prompt" })).toBeDisabled();
    empty.unmount();

    const savingProps = renderDialog(
      {
        ...customEditor,
        name: "Research Prompt draft"
      },
      { saving: true }
    );
    expect(screen.getByText("Saving prompt…")).toBeVisible();
    expect(screen.getByTestId("settings-dialog")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByLabelText("Prompt name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Update prompt" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close settings" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Appearance" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New prompt" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit prompt Helpful Assistant" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use prompt Research Prompt for next run" })).toBeDisabled();

    fireEvent.mouseDown(screen.getByTestId("settings-backdrop"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(savingProps.onClose).not.toHaveBeenCalled();
  });

  it("keeps valid required metadata neutral and owns API notices inside the dialog flow", () => {
    const onDismissNotice = vi.fn();
    renderDialog(undefined, {
      notice: {
        kind: "error",
        scope: "settings",
        text: "Prompt creation failed with HTTP 500"
      },
      onDismissNotice
    });

    expect(screen.getByTestId("prompt-name-required-indicator")).toHaveClass("text-content-muted");
    expect(screen.getByTestId("prompt-name-required-indicator")).not.toHaveClass("text-accent-rose");
    expect(screen.getByTestId("system-prompt-required-indicator")).toHaveClass("text-content-muted");
    expect(screen.getByTestId("settings-notice-region")).toContainElement(screen.getByRole("alert"));

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(onDismissNotice).toHaveBeenCalledOnce();
  });

  it("blocks prompt mutations behind catalog recovery while keeping Appearance available", async () => {
    const onRetryCatalog = vi.fn();
    renderDialog(undefined, {
      onRetryCatalog,
      promptCatalogError: "catalog_unavailable",
      promptCatalogState: "error"
    });

    const recovery = screen.getByTestId("settings-prompts-catalog-state");
    expect(recovery).toHaveTextContent("Prompt library didn’t load");
    expect(recovery).toHaveTextContent("catalog_unavailable");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Prompt library didn’t load" })).toHaveFocus());
    expect(screen.queryByLabelText("Prompt name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New prompt" })).not.toBeInTheDocument();
    expect(screen.queryByText("No prompt presets yet")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry loading prompt library" }));
    expect(onRetryCatalog).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeVisible();
  });

  it("keeps long prompt names and instruction previews readable in the library", () => {
    const longName = `Research ${"workflow ".repeat(14)}`.trim();
    const longSystem = `Verify assumptions and cite primary sources. ${"Preserve nuance. ".repeat(12)}`.trim();
    renderDialog(undefined, {
      currentPromptId: "long-prompt",
      defaultPromptId: "long-prompt",
      editor: {
        developerPrompt: "",
        id: "long-prompt",
        name: longName,
        systemPrompt: longSystem
      },
      prompts: [
        {
          developerPrompt: null,
          id: "long-prompt",
          isDefault: true,
          name: longName,
          systemPrompt: longSystem
        }
      ]
    });

    const library = screen.getByRole("list", { name: "Prompt presets" });
    expect(within(library).getByText(longName)).toBeVisible();
    expect(within(library).getByText(longSystem)).toBeVisible();
    expect(within(library).getByRole("button", { name: `Edit prompt ${longName}` })).toHaveAttribute(
      "aria-current",
      "true"
    );
  });

  it("keeps every prompt action touch-safe for hoverless and coarse pointers without inflating desktop controls", () => {
    renderDialog();

    const settings = screen.getByRole("dialog", { name: "Settings" });
    const close = within(settings).getByRole("button", { name: "Close settings" });
    expect(close).toHaveClass(
      "sm:size-9",
      "[@media(hover:none)]:!size-11",
      "[@media(pointer:coarse)]:!size-11"
    );

    for (const action of within(settings).getAllByRole("button")) {
      if (action === close) {
        continue;
      }
      expect(action).toHaveClass(
        "[@media(hover:none)]:!min-h-touch",
        "[@media(pointer:coarse)]:!min-h-touch"
      );
    }

    expect(screen.getByRole("button", { name: "Prompts" })).toHaveClass("sm:min-h-control");
    expect(screen.getByRole("button", { name: "Update prompt" })).toHaveClass("sm:min-h-control");
    expect(screen.getByRole("button", { name: "Use selected prompt for next run" })).toHaveClass(
      "sm:min-h-control-sm"
    );
    expect(screen.getByRole("button", { name: "New prompt" })).toHaveClass("sm:min-h-control-sm");

    const name = screen.getByLabelText("Prompt name");
    expect(name).toHaveClass(
      "sm:h-control",
      "[@media(hover:none)]:!h-touch",
      "[@media(pointer:coarse)]:!h-touch"
    );
    expect(screen.getByLabelText("Settings system prompt")).toHaveClass("min-h-48");
    expect(screen.getByLabelText("Developer prompt")).toHaveClass("min-h-36");

    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    for (const theme of screen.getAllByRole("radio")) {
      expect(theme).toHaveClass("min-h-touch");
    }
  });

  it("contains the Settings workspace inside short landscape safe areas with local scrolling", () => {
    renderDialog();

    const backdrop = screen.getByTestId("settings-backdrop");
    expect(backdrop.className).toContain("sm:pl-[max(1.25rem,env(safe-area-inset-left))]");
    expect(backdrop.className).toContain("sm:pr-[max(1.25rem,env(safe-area-inset-right))]");
    expect(backdrop.className).toContain("[@media(max-height:32rem)]:!pt-[max(.5rem,env(safe-area-inset-top))]");
    expect(backdrop.className).toContain(
      "[@media(max-height:32rem)]:!pb-[max(.5rem,env(safe-area-inset-bottom))]"
    );

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveClass(
      "h-[100dvh]",
      "overflow-hidden",
      "[@media(max-height:32rem)]:!h-full",
      "[@media(max-height:32rem)]:!max-h-full"
    );
    expect(dialog.className).toContain("pl-[env(safe-area-inset-left)]");
    expect(dialog.className).toContain("pr-[env(safe-area-inset-right)]");

    const promptsScroll = screen.getByTestId("settings-prompts-scroll");
    expect(promptsScroll).toHaveClass("min-h-0", "flex-1", "overflow-y-auto", "overscroll-contain");
    expect(screen.getByRole("button", { name: "Prompts" })).toHaveAttribute("aria-current", "page");

    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.getByTestId("settings-appearance-scroll")).toHaveClass(
      "min-h-0",
      "flex-1",
      "overflow-y-auto",
      "overscroll-contain"
    );
    expect(screen.getByRole("button", { name: "Appearance" })).toHaveAttribute("aria-current", "page");
  });

  it("describes local-only palettes and supports radio Arrow/Home/End selection", () => {
    const props = renderDialog(undefined, {
      themeId: "graphite"
    });

    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.getByText("This theme is saved only in this browser and does not follow your account.")).toBeVisible();
    expect(screen.queryByText(/same-site cookie|first paint/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Choose an AIQSA palette/)).toBeVisible();

    const graphite = screen.getByRole("radio", { name: /Use Graphite theme/ });
    const verdant = screen.getByRole("radio", { name: /Use Verdant theme/ });
    const classicDark = screen.getByRole("radio", { name: /Use Classic Dark theme/ });
    const neutral = screen.getByRole("radio", { name: /Use Classic Light theme/ });
    const aiqsa = screen.getByRole("radio", { name: /Use AIQSA theme/ });
    expect(screen.getAllByRole("radio")).toHaveLength(5);
    expect(graphite).toHaveAttribute("aria-checked", "true");
    expect(graphite).toHaveAttribute("tabindex", "0");
    expect(verdant).toHaveAttribute("tabindex", "-1");
    expect(classicDark).toHaveAttribute("tabindex", "-1");
    expect(neutral).toHaveAttribute("tabindex", "-1");

    graphite.focus();
    fireEvent.keyDown(graphite, { key: "End" });
    expect(props.onThemeChange).toHaveBeenLastCalledWith("neutral");
    expect(neutral).toHaveFocus();

    fireEvent.keyDown(neutral, { key: "Home" });
    expect(props.onThemeChange).toHaveBeenLastCalledWith("aiqsa");
    expect(aiqsa).toHaveFocus();

    fireEvent.keyDown(aiqsa, { key: "ArrowRight" });
    expect(props.onThemeChange).toHaveBeenLastCalledWith("graphite");
    expect(graphite).toHaveFocus();

    fireEvent.click(verdant);
    expect(props.onThemeChange).toHaveBeenLastCalledWith("verdant");

    fireEvent.click(classicDark);
    expect(props.onThemeChange).toHaveBeenLastCalledWith("classic-dark");
  });
});
