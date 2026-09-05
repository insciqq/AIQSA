import type { AssistantAvatarRecipe } from "@/lib/contracts/assistants";
import type { ModelParameterControls } from "@/lib/contracts/catalog";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AssistantLibrary } from "./AssistantLibrary";
import type {
  AssistantEditorDraftState,
  AssistantEditorView,
  AssistantLibraryListView,
  AssistantLibraryView
} from "./libraryViewContracts";

const avatar: AssistantAvatarRecipe = {
  accents: [0, 4],
  backgroundShape: "circle",
  foregroundShape: "diamond",
  kind: "generated",
  paletteId: "ocean",
  recipeVersion: 1,
  rotations: [0, 2]
};

function controls(overrides: Partial<ModelParameterControls> = {}): ModelParameterControls {
  return {
    background: { defaultValue: false, supported: true },
    maxOutputTokens: { defaultValue: 4096, maxValue: 16384 },
    reasoningEffort: {
      defaultValue: "medium",
      options: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      supported: true
    },
    reasoningMode: { defaultValue: "standard", options: ["standard", "pro"], supported: true },
    stream: { defaultValue: true, supported: true },
    temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true },
    ...overrides
  };
}

function draft(overrides: Partial<AssistantEditorDraftState> = {}): AssistantEditorDraftState {
  return {
    avatar,
    backgroundMode: null,
    category: "coding",
    description: "Reviews route handlers against our API rules.",
    developerPrompt: "",
    knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    maxOutputTokens: "",
    mcpServerIds: [],
    name: "API Reviewer",
    providerModelId: "model-1",
    reasoningEffort: "",
    reasoningMode: "",
    searchOptionIds: [],
    searchPlanMode: "all_selected",
    skillIds: [],
    starterPrompts: [],
    streamMode: null,
    systemPrompt: "Review authentication, validation and response shapes.",
    temperature: "",
    ...overrides
  };
}

function editor(overrides: Partial<AssistantEditorView> = {}): AssistantEditorView {
  return {
    availability: { ok: true },
    canPublishInstallation: false,
    dirty: false,
    draft: draft(),
    error: null,
    fieldErrors: null,
    justCreated: false,
    mode: "edit",
    onCancel: vi.fn(),
    onChange: vi.fn(),
    onGenerateAvatar: vi.fn(),
    onOpenMcpSettings: vi.fn(),
    onPublish: vi.fn(),
    onRevokePublication: vi.fn(),
    onSave: vi.fn(),
    onUseInChat: vi.fn(),
    options: {
      knowledgeBases: [{ available: true, id: "base-1", name: "Product docs" }],
      knowledgeSources: [{ available: true, id: "source-1", name: "API contract" }],
      knowledgeDataError: null,
      knowledgeDataState: "ready",
      mcpServers: [{ enabled: true, id: "mcp-1", name: "GitHub", readiness: "ready" }],
      models: [{
        capabilities: {
          documentInputMode: "native_pdf",
          imageInput: true,
          reasoning: true,
          toolCalling: true
        },
        controls: controls(),
        id: "model-1",
        label: "GPT-5.6 Luna",
        providerFamily: "openai",
        providerLabel: "OpenAI",
        supportsTools: true
      }],
      onRetryKnowledge: vi.fn(),
      onRetrySkills: vi.fn(),
      searchOptions: [{ id: "search-1", label: "Web Search" }],
      skillDataError: null,
      skillDataState: "ready",
      skills: []
    },
    publications: [],
    publishableGroups: [],
    saving: false,
    ...overrides
  };
}

function list(): AssistantLibraryListView {
  return {
    assistants: [],
    onArchiveToggle: vi.fn(),
    onDuplicate: vi.fn(),
    onEdit: vi.fn(),
    onNewAssistant: vi.fn(),
    onPinToggle: vi.fn(),
    onUse: vi.fn()
  };
}

function view(overrides: Partial<AssistantLibraryView> = {}): AssistantLibraryView {
  return {
    busy: false,
    catalogError: null,
    catalogState: "ready",
    editor: null,
    list: list(),
    notice: null,
    onBackToChat: vi.fn(),
    onDismissNotice: vi.fn(),
    onRetryCatalog: vi.fn(),
    task: "list",
    ...overrides
  };
}

describe("Assistant Library subviews", () => {
  it("renders the editor as non-modal Library content with honest saved state", () => {
    const current = editor();
    render(<AssistantLibrary view={view({ editor: current, task: "editor" })} />);

    expect(screen.getByTestId("assistant-editor")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Assistants" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "API Reviewer" })).toBeVisible();
    expect(screen.getByText("All changes saved")).toBeVisible();
    expect(screen.getByTestId("assistant-editor-save")).toHaveTextContent("Save changes");
    expect(screen.getByTestId("assistant-editor-save")).toBeDisabled();
    expect(screen.queryByLabelText("Category")).not.toBeInTheDocument();
  });

  it("shows model defaults without persisting an untouched value", () => {
    render(<AssistantLibrary view={view({ editor: editor(), task: "editor" })} />);
    fireEvent.click(screen.getByText("Advanced model settings").closest("summary")!);

    expect(screen.getByLabelText("Temperature")).toHaveValue("");
    expect(screen.getByLabelText("Temperature")).toHaveAttribute("placeholder", "1");
    expect(screen.getAllByText("model default").length).toBeGreaterThan(1);
    expect(screen.getByLabelText("Reasoning effort")).toHaveValue("");
    expect(screen.getByText(/model's own defaults/)).toBeVisible();
    expect(screen.getByRole("group", { name: "Stream the answer" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Run in the background" })).toBeVisible();
  });

  it("expands setup choices and keeps disabled MCP repair reachable", () => {
    const current = editor({
      draft: draft({ mcpServerIds: ["mcp-off"] }),
      fieldErrors: { mcpServerIds: "Remove MCP servers that need attention." },
      options: {
        ...editor().options,
        mcpServers: [{ enabled: false, id: "mcp-off", name: "GitHub", readiness: "needs_authorization" }]
      }
    });
    render(<AssistantLibrary view={view({ editor: current, task: "editor" })} />);

    fireEvent.click(screen.getByRole("button", { name: "Change", expanded: false }));
    expect(screen.getByText("Off in Settings")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Enable in Settings/ }));
    expect(current.onOpenMcpSettings).toHaveBeenCalledOnce();
    expect(screen.getByText("Remove MCP servers that need attention.")).toHaveAttribute("role", "alert");
  });

  it("guards a dirty Cancel and keeps the draft until discard is confirmed", () => {
    const current = editor({ dirty: true });
    render(<AssistantLibrary view={view({ editor: current, task: "editor" })} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Discard assistant draft changes" })).toBeVisible();
    expect(current.onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm discard changes" }));
    expect(current.onCancel).toHaveBeenCalledOnce();
  });

  it("keeps created and unavailable outcomes actionable in the mounted editor", () => {
    const use = vi.fn();
    const created = editor({ justCreated: true, onUseInChat: use });
    const { rerender } = render(<AssistantLibrary view={view({
      editor: created,
      notice: { kind: "success", text: "Assistant created. It stays private until you share it." },
      task: "editor"
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "use it in a chat" }));
    expect(use).toHaveBeenCalledOnce();

    const unavailable = editor({
      availability: {
        dependencies: [{ kind: "mcp", name: "GitHub" }],
        ok: false,
        reason: "tools_access"
      },
      onUseInChat: null
    });
    rerender(<AssistantLibrary view={view({ editor: unavailable, task: "editor" })} />);
    expect(screen.getByText("Needs the GitHub tools")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Use in chat" })).not.toBeInTheDocument();
  });
  it("shares the live definition without history or publication updates", () => {
    const current = editor({ publications: [{ id: "publication", scope: "group", groupId: "team",
      groupName: "Review team", updatedAt: "2026-09-05T00:00:00Z" }] });
    render(<AssistantLibrary view={view({ editor: current, task: "editor" })} />);
    fireEvent.click(screen.getByText("Sharing").closest("summary")!);
    expect(screen.getByText("Review team")).toBeVisible();
    expect(screen.queryByText(/Revision|Draft|history|Publish update/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unshare" }));
    expect(current.onRevokePublication).toHaveBeenCalledWith("publication");
  });

});
