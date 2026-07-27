import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptEditorDraft } from "./promptSettingsStore";
import { PromptWorkbench } from "./PromptWorkbench";

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

function renderWorkbench(
  editor: PromptEditorDraft = defaultEditor,
  overrides: Partial<Parameters<typeof PromptWorkbench>[0]> = {}
) {
  const props = {
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
    onUpdatePrompt: vi.fn(),
    prompts,
    saving: false
  };
  const renderProps = { ...props, ...overrides };
  const view = render(<PromptWorkbench {...renderProps} />);

  return {
    ...renderProps,
    ...view,
    rerenderEditor(nextEditor: PromptEditorDraft) {
      view.rerender(<PromptWorkbench {...renderProps} editor={nextEditor} />);
    }
  };
}

function useCompactViewport() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) =>
      ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: query === "(max-width: 1023px)",
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn()
      }) as MediaQueryList
    )
  );
}

function confirmDiscard() {
  fireEvent.click(screen.getByRole("button", { name: "Confirm discard changes" }));
}

describe("PromptWorkbench", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders a full-screen dialog without a backdrop and keeps both desktop work regions mounted", async () => {
    renderWorkbench();

    const workbench = screen.getByRole("dialog", { name: "Prompt library" });
    expect(workbench).toBe(screen.getByTestId("prompt-workbench"));
    expect(workbench).toHaveAttribute("aria-modal", "true");
    expect(workbench).toHaveAttribute("data-presentation", "workbench");
    expect(workbench).toHaveClass("fixed", "inset-0", "h-[100dvh]", "w-full", "overflow-hidden");
    expect(workbench).not.toHaveClass("rounded-panel", "shadow-overlay");
    expect(screen.queryByTestId("settings-backdrop")).not.toBeInTheDocument();
    expect(screen.queryByTestId("prompt-workbench-backdrop")).not.toBeInTheDocument();

    const body = screen.getByTestId("prompt-workbench-body");
    const library = screen.getByTestId("prompt-library-pane");
    const editor = screen.getByTestId("prompt-editor-pane");
    expect(body).toContainElement(library);
    expect(body).toContainElement(editor);
    expect(body).toHaveClass("row-start-3");
    expect(body.className).toContain("grid-cols-[20rem_minmax(0,1fr)]");
    expect(library.className).toContain("!grid");
    expect(editor.className).toContain("!grid");
    expect(screen.getByRole("heading", { name: "Prompt library" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Prompts" })).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "Search prompts" })).toBeVisible();
    expect(screen.getByTestId("prompt-instruction-stack")).toBeInTheDocument();
    expect(screen.getByTestId("prompt-default-control")).toHaveTextContent("Default for new chats");
    expect(screen.getByRole("button", { name: "Back to chat" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Duplicate selected prompt" })).not.toHaveClass("hidden");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Prompts" })).toHaveFocus());
  });

  it("filters names and instructions, shows a no-results state, and clears the search", () => {
    renderWorkbench();

    const search = screen.getByRole("searchbox", { name: "Search prompts" });
    fireEvent.change(search, { target: { value: "ASSUMPTIONS" } });

    expect(screen.getByRole("button", { name: "Edit prompt Research Prompt" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit prompt Helpful Assistant" })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "missing phrase" } });
    const noResults = screen.getByText("No matching prompts").closest<HTMLElement>("[role='status']");
    expect(noResults).not.toBeNull();
    expect(noResults).toHaveTextContent("No matching prompts");
    expect(noResults).toHaveTextContent("Try another name or instruction phrase.");
    expect(screen.queryByRole("list", { name: "Prompts" })).not.toBeInTheDocument();
    expect(screen.queryByText("No prompts yet")).not.toBeInTheDocument();

    fireEvent.click(within(noResults!).getByRole("button", { name: "Clear search" }));
    expect(search).toHaveValue("");
    expect(screen.getByRole("button", { name: "Edit prompt Helpful Assistant" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit prompt Research Prompt" })).toBeInTheDocument();
  });

  it("switches from the compact library to the editor and returns with selection and search intact", async () => {
    useCompactViewport();
    const props = renderWorkbench();

    const library = screen.getByTestId("prompt-library-pane");
    const editor = screen.getByTestId("prompt-editor-pane");
    const header = screen.getByTestId("prompt-workbench-header");
    const search = screen.getByRole("searchbox", { name: "Search prompts" });
    expect(library).toHaveClass("grid");
    expect(editor).toHaveClass("hidden");
    expect(header).toHaveClass("grid");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Prompts" })).toHaveFocus());

    fireEvent.change(search, { target: { value: "Research" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit prompt Research Prompt" }));
    expect(props.onEditPrompt).toHaveBeenCalledWith(prompts[1]);
    props.rerenderEditor(customEditor);

    await waitFor(() => expect(screen.getByLabelText("Prompt name")).toHaveFocus());
    expect(library).toHaveClass("hidden");
    expect(editor).toHaveClass("grid");
    expect(header).toHaveClass("hidden");
    expect(screen.getByLabelText("Prompt name")).toHaveValue("Research Prompt");

    fireEvent.click(screen.getByRole("button", { name: "Back to prompts" }));
    expect(library).toHaveClass("grid");
    expect(editor).toHaveClass("hidden");
    expect(header).toHaveClass("grid");
    expect(search).toHaveValue("Research");
    expect(screen.getByRole("button", { name: "Edit prompt Research Prompt" })).toHaveAttribute(
      "aria-current",
      "true"
    );
  });

  it("routes a dirty global close through discard confirmation", () => {
    const props = renderWorkbench({ ...customEditor, name: "Research Prompt draft" });

    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    const confirmation = screen.getByRole("dialog", { name: "Discard prompt changes" });
    expect(confirmation).toBeVisible();
    expect(screen.getByTestId("prompt-workbench")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("prompt-workbench")).toHaveAttribute("inert");
    expect(props.onClose).not.toHaveBeenCalled();

    fireEvent.click(within(confirmation).getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("dialog", { name: "Discard prompt changes" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    confirmDiscard();
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("confirms a dirty compact Back action before returning to the library", () => {
    useCompactViewport();
    const props = renderWorkbench({ ...customEditor, name: "Research Prompt draft" });

    fireEvent.click(screen.getByRole("button", { name: "Edit prompt Research Prompt" }));
    expect(screen.getByTestId("prompt-editor-pane")).toHaveClass("grid");
    fireEvent.click(screen.getByRole("button", { name: "Back to prompts" }));
    expect(screen.getByRole("dialog", { name: "Discard prompt changes" })).toBeVisible();
    expect(props.onEditPrompt).not.toHaveBeenCalled();

    confirmDiscard();
    expect(props.onEditPrompt).toHaveBeenCalledWith(prompts[1]);
    expect(screen.getByTestId("prompt-library-pane")).toHaveClass("grid");
    expect(screen.getByTestId("prompt-editor-pane")).toHaveClass("hidden");
  });

  it("confirms a dirty New prompt transition before opening the compact editor", () => {
    useCompactViewport();
    const props = renderWorkbench({ ...customEditor, name: "Research Prompt draft" });

    fireEvent.click(screen.getByRole("button", { name: "New prompt" }));
    expect(screen.getByRole("dialog", { name: "Discard prompt changes" })).toBeVisible();
    expect(props.onNewPrompt).not.toHaveBeenCalled();

    confirmDiscard();
    expect(props.onNewPrompt).toHaveBeenCalledOnce();
    expect(screen.getByTestId("prompt-library-pane")).toHaveClass("hidden");
    expect(screen.getByTestId("prompt-editor-pane")).toHaveClass("grid");
  });

  it("keeps pristine create validation neutral, then enables only a valid dirty draft", () => {
    const props = renderWorkbench({
      developerPrompt: "",
      id: null,
      name: "",
      systemPrompt: ""
    });

    const name = screen.getByLabelText("Prompt name");
    const system = screen.getByRole("textbox", { name: "System instructions" });
    expect(name).toHaveAttribute("aria-invalid", "false");
    expect(system).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByTestId("prompt-name-required-indicator")).toHaveClass("text-ink-muted");
    expect(screen.getByTestId("system-prompt-required-indicator")).toHaveClass("text-ink-muted");
    expect(screen.queryByText("Enter a prompt name.")).not.toBeInTheDocument();
    expect(screen.queryByText("Enter system instructions.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create prompt" })).toBeDisabled();

    props.rerenderEditor({
      developerPrompt: "Check every constraint.",
      id: null,
      name: "",
      systemPrompt: ""
    });
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(system).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Enter a prompt name.")).toBeVisible();
    expect(screen.getByText("Enter system instructions.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Create prompt" })).toBeDisabled();

    props.rerenderEditor({
      developerPrompt: "Check every constraint.",
      id: null,
      name: "Constraint reviewer",
      systemPrompt: "Review every constraint."
    });
    const create = screen.getByRole("button", { name: "Create prompt" });
    expect(create).toBeEnabled();
    fireEvent.click(create);
    expect(props.onCreatePrompt).toHaveBeenCalledOnce();
  });

  it("enables update only for a valid dirty existing prompt", () => {
    const props = renderWorkbench({ ...customEditor, name: "Research Prompt revised" });

    const update = screen.getByRole("button", { name: "Save changes" });
    expect(update).toBeEnabled();
    fireEvent.click(update);
    expect(props.onUpdatePrompt).toHaveBeenCalledOnce();

    props.rerenderEditor({ ...customEditor, systemPrompt: "" });
    expect(screen.getByRole("textbox", { name: "System instructions" })).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("opens More, protects the default prompt, and deletes a non-default prompt", () => {
    const defaultProps = renderWorkbench();

    fireEvent.click(screen.getByRole("button", { name: "Prompt actions" }));
    let menu = screen.getByRole("menu", { name: "Prompt actions menu" });
    expect(within(menu).queryByRole("menuitem", { name: "Duplicate selected prompt" })).not.toBeInTheDocument();
    const protectedDelete = within(menu).getByRole("menuitem", { name: "Delete selected prompt" });
    expect(protectedDelete).toBeDisabled();
    expect(protectedDelete).toHaveAttribute("aria-describedby", "default-delete-protection");
    expect(within(menu).getByText(/Make another prompt the default/)).toBeVisible();
    expect(defaultProps.onDeletePrompt).not.toHaveBeenCalled();
    defaultProps.unmount();

    const customProps = renderWorkbench(customEditor);
    fireEvent.click(screen.getByRole("button", { name: "Prompt actions" }));
    menu = screen.getByRole("menu", { name: "Prompt actions menu" });
    const deletePrompt = within(menu).getByRole("menuitem", { name: "Delete selected prompt" });
    expect(deletePrompt).toBeEnabled();
    fireEvent.click(deletePrompt);
    expect(customProps.onDeletePrompt).toHaveBeenCalledWith(prompts[1]);
    expect(screen.queryByRole("menu", { name: "Prompt actions menu" })).not.toBeInTheDocument();
  });

  it("lets Escape close only the open prompt-actions menu and restores its trigger", async () => {
    const props = renderWorkbench(customEditor);
    const trigger = screen.getByRole("button", { name: "Prompt actions" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Prompt actions menu" })).toBeVisible();

    fireEvent.keyDown(screen.getByRole("menu", { name: "Prompt actions menu" }), { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Prompt actions menu" })).not.toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("saves a valid dirty update with both Ctrl+S and Cmd+S but ignores a pristine draft", () => {
    const props = renderWorkbench({ ...customEditor, name: "Research Prompt revised" });
    const name = screen.getByLabelText("Prompt name");

    fireEvent.keyDown(name, { ctrlKey: true, key: "s" });
    fireEvent.keyDown(name, { key: "S", metaKey: true });
    expect(props.onUpdatePrompt).toHaveBeenCalledTimes(2);

    props.rerenderEditor(customEditor);
    fireEvent.keyDown(screen.getByLabelText("Prompt name"), { ctrlKey: true, key: "s" });
    expect(props.onUpdatePrompt).toHaveBeenCalledTimes(2);
  });

  it("routes Ctrl+S to create for a valid new prompt and ignores invalid drafts", () => {
    const props = renderWorkbench({
      developerPrompt: "",
      id: null,
      name: "New prompt",
      systemPrompt: "Act carefully."
    });

    fireEvent.keyDown(screen.getByLabelText("Prompt name"), { ctrlKey: true, key: "s" });
    expect(props.onCreatePrompt).toHaveBeenCalledOnce();

    props.rerenderEditor({
      developerPrompt: "Some guidance",
      id: null,
      name: "",
      systemPrompt: ""
    });
    fireEvent.keyDown(screen.getByLabelText("Prompt name"), { ctrlKey: true, key: "s" });
    expect(props.onCreatePrompt).toHaveBeenCalledOnce();
  });
});
