import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultAssistantDraftRows,
  type AssistantEditorDraft,
  type AssistantEditorView
} from "@/components/assistants/libraryViewContracts";
import { resetSkillLibraryStoreForTest } from "@/components/app-shell/skillLibraryStore";
import type { AssistantAvatarRecipe } from "@/lib/contracts/assistants";
import type { ModelParameterControls } from "@/lib/contracts/catalog";
import { AssistantEditorPageV2 } from "./AssistantEditorPageV2";

const avatar: AssistantAvatarRecipe = {
  accents: [0, 4],
  backgroundShape: "circle",
  foregroundShape: "diamond",
  kind: "generated",
  paletteId: "ocean",
  recipeVersion: 1,
  rotations: [0, 2]
};

const controls: ModelParameterControls = {
  background: { defaultValue: false, supported: true },
  maxOutputTokens: { defaultValue: 4096, maxValue: 16384 },
  reasoningEffort: { defaultValue: "medium", options: ["low", "medium", "high"], supported: true },
  stream: { defaultValue: true, supported: true },
  temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
};

function draft(overrides: Partial<AssistantEditorDraft> = {}): AssistantEditorDraft {
  return {
    answerRules: null,
    avatar,
    category: "coding",
    description: "Reviews route handlers.",
    name: "API Reviewer",
    responseReminder: "",
    rows: defaultAssistantDraftRows(),
    starterPrompts: ["Review this handler"],
    systemPrompt: "Review authentication and validation.",
    ...overrides
  };
}

function editor(overrides: Partial<AssistantEditorView> = {}): AssistantEditorView {
  return {
    archived: false,
    assistantId: "assistant-1",
    audience: { everyone: false, groupNames: [] },
    availability: { ok: true },
    conflict: null,
    dirty: false,
    draft: draft(),
    error: null,
    errors: null,
    initialExpandedRow: null,
    justCreated: false,
    mode: "edit",
    onCancel: vi.fn(),
    onChange: vi.fn(),
    onGenerateAvatar: vi.fn(),
    onKeepDraftOverLatest: vi.fn(),
    onOpenMcpSettings: vi.fn(),
    onOpenSharing: vi.fn(),
    onReloadLatest: vi.fn(),
    onReplaceDraftWithLatest: vi.fn(),
    onRowChange: vi.fn(),
    onSave: vi.fn(async () => "assistant-1"),
    onSaveAndTry: vi.fn(async () => true),
    onUseInChat: null,
    options: {
      knowledgeBases: [{ available: true, id: "base-1", name: "Product docs" }],
      knowledgeDataError: null,
      knowledgeDataState: "ready",
      knowledgeSources: [{ available: true, id: "source-1", name: "API contract" }],
      mcpServers: [
        { enabled: true, id: "mcp-ready", name: "Jira", readiness: "ready" },
        { enabled: true, id: "mcp-setup", name: "Kubernetes", readiness: "needs_setup" },
        { enabled: false, id: "mcp-off", name: "GitHub", readiness: "disabled" }
      ],
      models: [{
        capabilities: { documentInputMode: "native_pdf", imageInput: true, reasoning: true, toolCalling: true },
        controls,
        id: "model-1",
        label: "GPT-5.6 Luna",
        providerFamily: "openai",
        providerLabel: "OpenAI",
        supportsTools: true
      }],
      onRetryKnowledge: vi.fn(),
      searchOptions: [{ id: "web", label: "Web Search" }],
      selectedSkills: [
        { id: "review", name: "Review" },
        { id: "charts", name: "Charts" },
        { available: false, id: "gone", name: "Old workflow" }
      ]
    },
    rowAvailability: {},
    savedName: "API Reviewer",
    saving: false,
    scope: { kind: "owner" },
    ...overrides
  };
}

function renderPage(view: AssistantEditorView, props: { onOpenSharing?(): void; onRequestClose?(): void } = {}) {
  return render(
    <AssistantEditorPageV2
      busy={false}
      editor={view}
      notice={null}
      onDismissNotice={vi.fn()}
      onOpenSharing={props.onOpenSharing ?? vi.fn()}
      onRequestClose={props.onRequestClose ?? vi.fn()}
    />
  );
}

const row = (key: string) => screen.getByTestId(`assistant-setup-row-${key}`);

afterEach(() => {
  resetSkillLibraryStoreForTest();
  vi.unstubAllGlobals();
});

describe("Assistant editor page", () => {
  it("shows identity, instructions, starters, Setup, Sharing and the save bar with the saved state", () => {
    renderPage(editor());

    expect(screen.getByRole("heading", { level: 2, name: "API Reviewer" })).toBeVisible();
    expect(screen.getByLabelText("Name Required")).toHaveValue("API Reviewer");
    expect(screen.getByLabelText("Description")).toHaveAccessibleDescription("Shown to people who pick this Assistant. Not sent to the model.");
    expect(screen.getByLabelText("Category")).toHaveValue("coding");
    expect(within(screen.getByLabelText("Category")).getAllByRole("option")[0]).toHaveTextContent("None");
    expect(screen.getByLabelText("Instructions")).toHaveValue("Review authentication and validation.");
    expect(screen.getByText("37 / 48 000")).toBeVisible();
    expect(screen.getByText("Answer rules (optional)")).toBeVisible();
    expect(screen.getByText("Response reminder (optional)")).toBeVisible();
    expect(screen.getByLabelText("Conversation starter 1")).toHaveValue("Review this handler");
    expect(screen.getByText(/Shown on an empty chat\. One click sends the starter\. 1 of 6\./)).toBeVisible();
    for (const name of ["Model", "Reasoning & parameters", "Web search", "Tools", "Knowledge", "Skills"]) {
      expect(screen.getByRole("button", { expanded: false, name })).toBeVisible();
    }
    expect(within(row("model")).getByRole("button", { expanded: false, name: "Model" }))
      .toHaveAccessibleDescription("Your default model (Inherit)");
    expect(within(row("knowledge")).getByRole("button", { expanded: false, name: "Knowledge" }))
      .toHaveAccessibleDescription("None");
    expect(screen.getByText("Only you")).toBeVisible();
    expect(screen.getByRole("button", { name: "Manage sharing…" })).toBeEnabled();
    expect(screen.getByText("Ctrl / ⌘ S to save")).toBeVisible();
    expect(screen.getByText("Saved")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save & try" })).toBeEnabled();
    expect(screen.getByTestId("assistant-editor-save")).toHaveTextContent("Save");
    expect(screen.getByTestId("assistant-editor-save")).toBeDisabled();
    expect(screen.queryByText(/Order \d/)).toBeNull();
  });

  it("names the owner's audience on the Sharing card in one segment, as the gallery card does", () => {
    const { unmount } = renderPage(editor({ audience: { everyone: true, groupNames: ["Design", "Sales", "Support"] } }));
    const sharing = () => screen.getByRole("region", { name: "Sharing" });
    expect(sharing()).toHaveTextContent(/^SharingEveryoneManage sharing…$/);
    unmount();

    renderPage(editor({ audience: { everyone: false, groupNames: ["Design", "Sales", "Support"] } }));
    expect(sharing()).toHaveTextContent(/^Sharing3 groupsManage sharing…$/);
  });

  it("creates with every row Adjustable, Sharing waiting for the first save", () => {
    renderPage(editor({ assistantId: null, audience: null, draft: draft({ name: "" }), mode: "create", onOpenSharing: null, savedName: null, scope: null }));

    expect(screen.getByRole("heading", { level: 2, name: "New assistant" })).toBeVisible();
    expect(screen.getByTestId("assistant-editor-save")).toHaveTextContent("Create");
    expect(screen.getByTestId("assistant-editor-save")).toBeEnabled();
    expect(screen.getByText("Not saved yet")).toBeVisible();
    const manage = screen.getByRole("button", { name: "Manage sharing…" });
    expect(manage).toBeDisabled();
    expect(manage).toHaveAccessibleDescription("Save first");
    const toggles = screen.getAllByRole("button", { name: "Adjustable" });
    expect(toggles).toHaveLength(6);
    for (const toggle of toggles) {
      // The name is explicit, so the visible tooltip (generated content) can never join it.
      expect(toggle).toHaveAttribute("aria-label", "Adjustable");
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      expect(toggle).toHaveAccessibleDescription(/^Fixed: used in every chat, cannot be changed there\./);
    }
  });

  it("asks for a concrete value when an inherited row becomes Fixed and keeps the error at that row", () => {
    const view = editor();
    const { rerender } = renderPage(view);

    fireEvent.click(within(row("model")).getByRole("button", { name: "Adjustable" }));
    expect(view.onRowChange).toHaveBeenCalledWith("model", { policy: "fixed" });
    expect(within(row("model")).getByRole("button", { name: "Model" })).toHaveAttribute("aria-expanded", "true");

    const rows = defaultAssistantDraftRows();
    rerender(
      <AssistantEditorPageV2
        busy={false}
        editor={{ ...view, draft: draft({ rows: { ...rows, controls: { ...rows.controls, policy: "fixed" }, model: { ...rows.model, policy: "fixed" } } }) }}
        notice={null}
        onDismissNotice={vi.fn()}
        onOpenSharing={vi.fn()}
        onRequestClose={vi.fn()}
      />
    );
    const fixed = within(row("model")).getByRole("button", { name: "Fixed" });
    expect(fixed).toHaveAttribute("aria-pressed", "true");
    expect(fixed).toHaveAttribute("aria-label", "Fixed");
    fixed.focus();
    expect(fixed).toHaveAccessibleName("Fixed");
    expect(row("model")).toHaveTextContent("Choose a value to fix, or make this row Adjustable.");
    expect(row("controls")).toHaveTextContent("Set at least one parameter to fix, or make this row Adjustable.");
    expect(within(row("model")).getByRole("button", { name: "Model" }))
      .toHaveAccessibleDescription(/Choose a value to fix/);
    expect(row("search")).not.toHaveTextContent("Choose a value to fix");
  });

  it("offers Inherit first for the model and parameters only for a concrete model", () => {
    const view = editor();
    renderPage(view);

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const model = screen.getByLabelText("Model");
    expect(within(model).getAllByRole("option").map((option) => option.textContent))
      .toEqual(["Your default model (Inherit)", "GPT-5.6 Luna · OpenAI"]);
    fireEvent.change(model, { target: { value: "model-1" } });
    expect(view.onRowChange).toHaveBeenCalledWith("model", { value: { mode: "model", modelId: "model-1" } });

    fireEvent.click(screen.getByRole("button", { name: "Reasoning & parameters" }));
    expect(row("controls")).toHaveTextContent("Choose a model to set its parameters");
    expect(screen.queryByLabelText("Temperature")).toBeNull();
  });

  it("edits parameters of a concrete model without persisting untouched values", () => {
    const rows = defaultAssistantDraftRows();
    const view = editor({ draft: draft({ rows: { ...rows, model: { policy: "fixed", value: { mode: "model", modelId: "model-1" } } } }) });
    renderPage(view);

    fireEvent.click(screen.getByRole("button", { name: "Reasoning & parameters" }));
    expect(screen.getByLabelText("Temperature")).toHaveValue("");
    expect(screen.getByLabelText("Temperature")).toHaveAttribute("placeholder", "1");
    expect(screen.getByLabelText("Reasoning effort")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Temperature"), { target: { value: "0.3" } });
    expect(view.onRowChange).toHaveBeenCalledWith("controls", { value: { ...rows.controls.value, temperature: "0.3" } });
    expect(screen.getByRole("group", { name: "Stream the answer" })).toBeVisible();
  });

  it("selects Tools servers, marks a server that is not ready and keeps disabled servers out", () => {
    const rows = defaultAssistantDraftRows();
    const view = editor({ draft: draft({ rows: { ...rows, tools: { policy: "adjustable", value: { mode: "exact", serverIds: ["mcp-ready"] } } } }) });
    renderPage(view);

    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    const tools = row("tools");
    expect(within(tools).getByRole("radio", { name: "Your default (Inherit)" })).not.toBeChecked();
    expect(within(tools).getByRole("radio", { name: /Selected servers/ })).toBeChecked();
    expect(within(tools).getByRole("checkbox", { name: /Kubernetes Needs setup/ })).toBeEnabled();
    expect(within(tools).getByRole("checkbox", { name: /GitHub Off in MCP servers/ })).toBeDisabled();
    fireEvent.click(within(tools).getByRole("checkbox", { name: /Kubernetes/ }));
    expect(view.onRowChange).toHaveBeenCalledWith("tools", { value: { mode: "exact", serverIds: ["mcp-ready", "mcp-setup"] } });
    fireEvent.click(within(tools).getByRole("radio", { name: "Off" }));
    expect(view.onRowChange).toHaveBeenCalledWith("tools", { value: { mode: "off" } });
    fireEvent.click(within(tools).getByRole("button", { name: "Open MCP servers" }));
    expect(view.onOpenMcpSettings).toHaveBeenCalledOnce();
  });

  it("chooses Web search and Knowledge as Inherit, Off or None, or a selection", () => {
    const view = editor();
    renderPage(view);

    fireEvent.click(screen.getByRole("button", { name: "Web search" }));
    fireEvent.click(within(row("search")).getByRole("radio", { name: /Selected sources/ }));
    expect(view.onRowChange).toHaveBeenCalledWith("search", { value: { mode: "model_choice", optionIds: [] } });
    fireEvent.click(screen.getByRole("button", { name: "Knowledge" }));
    expect(within(row("knowledge")).getByRole("radio", { name: "None" })).toBeChecked();
    fireEvent.click(within(row("knowledge")).getByRole("radio", { name: "Your default (Inherit)" }));
    expect(view.onRowChange).toHaveBeenCalledWith("knowledge", { value: { mode: "inherit" } });
  });

  it("keeps one Skills list with Always or On demand per link and honest counts", () => {
    const rows = defaultAssistantDraftRows();
    const links = [
      { delivery: "always" as const, skillId: "review" },
      { delivery: "on_demand" as const, skillId: "charts" },
      { delivery: "on_demand" as const, skillId: "gone" }
    ];
    const view = editor({ draft: draft({ rows: { ...rows, skills: { policy: "adjustable", value: { links, mode: "auto" } } } }) });
    renderPage(view);

    expect(within(row("skills")).getByRole("button", { name: "Skills" }))
      .toHaveAccessibleDescription("Auto · 1 always · 2 on demand");
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    const skills = row("skills");
    expect(within(skills).getByRole("switch", { name: "Load Skills on demand" })).toHaveAttribute("aria-checked", "true");
    expect(within(skills).getByText("Off keeps Always Skills and disables loading others")).toBeVisible();
    expect(within(skills).getByText("1 always · 2 on demand")).toHaveAccessibleDescription(
      "Up to 32 Always and 64 On demand Skills. Always Skills are delivered in this order."
    );
    expect(within(skills).getByText("Unavailable · remove it or ask for access")).toBeVisible();
    expect(within(skills).queryByText(/Order/)).toBeNull();

    fireEvent.click(within(within(skills).getByRole("radiogroup", { name: "Delivery for Charts" })).getByRole("radio", { name: "Always" }));
    expect(view.onRowChange).toHaveBeenCalledWith("skills", { value: { links: [links[0], { ...links[1], delivery: "always" }, links[2]], mode: "auto" } });
    fireEvent.click(within(skills).getByRole("button", { name: "Remove Old workflow" }));
    expect(view.onRowChange).toHaveBeenCalledWith("skills", { value: { links: links.slice(0, 2), mode: "auto" } });
    fireEvent.click(within(skills).getByRole("switch", { name: "Load Skills on demand" }));
    expect(view.onRowChange).toHaveBeenCalledWith("skills", { value: { links, mode: "off" } });
  });

  it("opens the Skills library in selection mode and returns focus to Add Skills", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      nextCursor: null, publishableWorkspaces: [], skills: [], viewer: { canPublishInstallation: false }
    })));
    renderPage(editor({ initialExpandedRow: "skills" }));

    const add = screen.getByRole("button", { name: "Add Skills…" });
    add.focus();
    fireEvent.click(add);
    const picker = await screen.findByRole("dialog");
    expect(picker).toHaveTextContent("Choose Assistant Skills");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(add).toHaveFocus());
  });

  it("saves with Ctrl or Cmd+S, tries with Save & try and cancels through the guard", () => {
    const view = editor({ dirty: true });
    const onRequestClose = vi.fn();
    renderPage(view, { onRequestClose });

    expect(screen.getByText("Unsaved changes")).toBeVisible();
    fireEvent.keyDown(screen.getByLabelText("Name Required"), { ctrlKey: true, key: "s" });
    fireEvent.keyDown(screen.getByLabelText("Description"), { key: "S", metaKey: true });
    expect(view.onSave).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Save & try" }));
    expect(view.onSaveAndTry).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onRequestClose).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Manage sharing…" }));
  });

  it("keeps the last saved name as the heading while the name field of a saved Assistant is empty", () => {
    renderPage(editor({ dirty: true, draft: draft({ name: "  " }) }));
    expect(screen.getByRole("heading", { level: 2, name: "API Reviewer" })).toBeVisible();
    expect(screen.getByTestId("assistant-editor-save")).toHaveTextContent("Save");
  });

  it("keeps errors at their fields and rows and focuses the first one", async () => {
    const rows = defaultAssistantDraftRows();
    renderPage(editor({
      dirty: true,
      draft: draft({ name: "", rows: { ...rows, tools: { policy: "fixed", value: { mode: "exact", serverIds: [] } } } }),
      error: { code: "assistant_editor_invalid", text: "Enter a name." },
      errors: {
        fields: { name: "Enter a name.", starterPrompts: "Keep up to 6 starters of up to 200 characters." },
        rows: { tools: "Choose at least one MCP server, or turn Tools off." }
      }
    }));

    const name = screen.getByLabelText("Name Required");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription("Enter a name.");
    await waitFor(() => expect(name).toHaveFocus());
    expect(screen.getByLabelText("Conversation starter 1")).toHaveAccessibleDescription(/Keep up to 6 starters/);
    expect(within(row("tools")).getByRole("button", { name: "Tools" })).toHaveAttribute("aria-expanded", "true");
    expect(row("tools")).toHaveTextContent("Choose at least one MCP server, or turn Tools off.");
    expect(screen.getByRole("alert")).toHaveTextContent("Review the highlighted fields.");
  });

  it("shows the latest saved version beside the kept draft after a version conflict", () => {
    const rows = defaultAssistantDraftRows();
    const latestRows = {
      ...rows,
      model: { policy: "fixed" as const, value: { mode: "model" as const, modelId: "model-1" } },
      tools: { policy: "adjustable" as const, value: { mode: "exact" as const, serverIds: ["mcp-ready", "mcp-elsewhere"] } }
    };
    const view = editor({
      conflict: {
        latest: {
          draft: draft({ category: "writing", name: "API Reviewer v2", rows: latestRows, systemPrompt: "Newer text." }),
          version: 7
        },
        loading: false
      },
      dirty: true,
      draft: draft({ systemPrompt: "My unsaved text." }),
      error: { code: "assistant_version_conflict", text: "This assistant changed in another session." }
    });
    renderPage(view);

    const conflict = screen.getByTestId("assistant-editor-conflict");
    expect(conflict).toHaveTextContent("This Assistant changed in another session. Your draft is kept.");
    fireEvent.click(within(conflict).getByText("Latest saved version: API Reviewer v2"));
    expect(within(conflict).getAllByRole("listitem").map((line) => line.textContent)).toEqual([
      "Category: Writing — differs from your draft",
      "Model: GPT-5.6 Luna · Fixed — differs from your draft",
      "Reasoning & parameters: Your saved values · Adjustable",
      "Web search: Your default (Inherit) · Adjustable",
      // A server outside the owner's list is not named.
      "Tools: Jira, Unavailable MCP server · Adjustable — differs from your draft",
      "Knowledge: None · Adjustable",
      "Skills: Auto · no Skills linked · Adjustable"
    ]);
    expect(conflict).toHaveTextContent("Newer text.");
    expect(screen.getByLabelText("Instructions")).toHaveValue("My unsaved text.");
    // With the latest version loaded the two choices stand alone.
    expect(within(conflict).queryByRole("button", { name: "Reload latest version" })).toBeNull();
    fireEvent.click(within(conflict).getByRole("button", { name: "Keep my draft" }));
    fireEvent.click(within(conflict).getByRole("button", { name: "Replace draft with latest version" }));
    expect(view.onKeepDraftOverLatest).toHaveBeenCalledOnce();
    expect(view.onReplaceDraftWithLatest).toHaveBeenCalledOnce();
    expect(conflict).toHaveTextContent("Keep my draft replaces the other session's changes when you save.");
    expect(conflict).not.toHaveTextContent("version 7");
  });

  it("says in one line that the Setup is the same and names a changed avatar", () => {
    renderPage(editor({
      conflict: {
        latest: { draft: draft({ avatar: { ...avatar, paletteId: "plum" }, name: "API Reviewer v2" }), version: 7 },
        loading: false
      },
      dirty: true,
      error: { code: "assistant_version_conflict", text: "This assistant changed in another session." }
    }));

    const conflict = screen.getByTestId("assistant-editor-conflict");
    expect(within(conflict).getAllByRole("listitem").map((line) => line.textContent)).toEqual([
      "Category: Coding",
      "Avatar differs from your draft",
      "Setup: same as your draft"
    ]);
  });

  it("offers Reload only while the latest saved version is not loaded", () => {
    const view = editor({
      conflict: { latest: null, loading: false },
      dirty: true,
      error: { code: "assistant_version_conflict", text: "This assistant changed in another session." }
    });
    renderPage(view);

    const conflict = screen.getByTestId("assistant-editor-conflict");
    expect(conflict).toHaveTextContent("The latest saved version could not be loaded.");
    expect(within(conflict).getAllByRole("button").map((button) => button.textContent)).toEqual(["Reload latest version"]);
    fireEvent.click(within(conflict).getByRole("button", { name: "Reload latest version" }));
    expect(view.onReloadLatest).toHaveBeenCalledOnce();
  });

  it("opens the optional disclosures that have content and edits starters within limits", () => {
    const view = editor({
      draft: draft({ answerRules: "Answer in tables.", responseReminder: "Stay brief.", starterPrompts: ["1", "2", "3", "4", "5", "6"] })
    });
    renderPage(view);

    expect(screen.getByText("Answer rules (optional)").closest("details")).toHaveAttribute("open");
    expect(screen.getByLabelText("Response reminder")).toHaveValue("Stay brief.");
    expect(screen.getByText("Response reminder (optional)").closest("details")).toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "Add starter" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove conversation starter 2" }));
    expect(view.onChange).toHaveBeenCalledWith({ starterPrompts: ["1", "3", "4", "5", "6"] });
    expect(screen.getByText("Replaces the built-in answer rules · 17 / 4 000")).toBeVisible();
  });

  it("changes the avatar recipe in a popover with Randomize", () => {
    const view = editor();
    renderPage(view);

    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const picker = screen.getByRole("dialog", { name: "Avatar" });
    fireEvent.click(within(picker).getByRole("radio", { name: "Plum" }));
    expect(view.onChange).toHaveBeenCalledWith({ avatar: { ...avatar, paletteId: "plum" } });
    fireEvent.click(within(picker).getByRole("radio", { name: "Hexagon" }));
    expect(view.onChange).toHaveBeenCalledWith({ avatar: { ...avatar, foregroundShape: "hexagon" } });
    fireEvent.click(within(picker).getByRole("button", { name: "Rotate" }));
    expect(view.onChange).toHaveBeenCalledWith({ avatar: { ...avatar, rotations: [0, 3] } });
    fireEvent.click(within(picker).getByRole("button", { name: "Randomize" }));
    expect(view.onGenerateAvatar).toHaveBeenCalledOnce();
    act(() => { fireEvent.keyDown(document, { key: "Escape" }); });
    expect(screen.queryByRole("dialog", { name: "Avatar" })).toBeNull();
    expect(screen.getByRole("button", { name: "Change" })).toHaveFocus();
  });

  it("names an unavailable adjustable value without blocking the row", () => {
    const rows = defaultAssistantDraftRows();
    renderPage(editor({
      draft: draft({ rows: { ...rows, search: { policy: "adjustable", value: { mode: "model_choice", optionIds: ["web"] } } } }),
      rowAvailability: { search: { dependencies: [{ kind: "search", name: "Web Search" }], reason: "search_access" } }
    }));

    expect(row("search")).toHaveTextContent("Web Search isn't available to you; your default is used.");
  });
});
