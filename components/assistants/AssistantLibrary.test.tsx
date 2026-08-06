import type {
  AssistantAvatarRecipe,
  AssistantSummary
} from "@/lib/contracts/assistants";
import type { ModelParameterControls } from "@/lib/contracts/catalog";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantLibrary } from "./AssistantLibrary";
import type {
  AssistantEditorDraftState,
  AssistantEditorView,
  AssistantHistoryView,
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

function makeAssistant(overrides: Partial<AssistantSummary> = {}): AssistantSummary {
  return {
    archived: false,
    availability: { ok: true },
    avatar,
    category: "coding",
    description: "Reviews changes with care.",
    fingerprint: { mcpServerCount: 0, modelLabel: "GPT-5.2", reasoningEffort: null, searchOptionCount: 0 },
    id: "assistant-1",
    name: "Code reviewer",
    owned: false,
    ownerDisplayName: "Dana Ops",
    pinned: false,
    published: true,
    revisionNumber: 3,
    scope: { kind: "installation" },
    starterPrompts: [],
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides
  };
}

function makeControls(overrides: Partial<ModelParameterControls> = {}): ModelParameterControls {
  return {
    background: { defaultValue: false, supported: false },
    maxOutputTokens: { defaultValue: 4096, maxValue: 8192 },
    reasoningEffort: { defaultValue: "medium", options: ["low", "medium", "high"], supported: false },
    stream: { defaultValue: true, supported: true },
    temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true },
    ...overrides
  };
}

function makeDraft(overrides: Partial<AssistantEditorDraftState> = {}): AssistantEditorDraftState {
  return {
    avatar,
    backgroundMode: false,
    category: null,
    description: "",
    developerPrompt: "",
    maxOutputTokens: "4096",
    mcpServerIds: [],
    name: "Focused helper",
    providerModelId: "model-1",
    reasoningEffort: "medium",
    reasoningMode: "",
    searchOptionIds: [],
    searchPlanMode: "model_choice",
    starterPrompts: [],
    streamMode: true,
    systemPrompt: "Help carefully.",
    temperature: "1",
    ...overrides
  };
}

function makeEditor(overrides: Partial<AssistantEditorView> = {}): AssistantEditorView {
  return {
    canPublishInstallation: false,
    dirty: false,
    draft: makeDraft(),
    error: null,
    mode: "create",
    onCancel: vi.fn(),
    onChange: vi.fn(),
    onGenerateAvatar: vi.fn(),
    onPublish: vi.fn(),
    onRevokePublication: vi.fn(),
    onSave: vi.fn(),
    onUseInChat: null,
    options: {
      mcpServers: [],
      models: [
        { controls: makeControls(), id: "model-1", label: "GPT-5.2", providerLabel: "OpenAI", supportsTools: true }
      ],
      searchOptions: []
    },
    publications: null,
    publishableGroups: [],
    revisionNumber: null,
    saving: false,
    ...overrides
  };
}

function makeHistory(overrides: Partial<AssistantHistoryView> = {}): AssistantHistoryView {
  return {
    assistantName: "Code reviewer",
    entries: [],
    loading: false,
    onBack: vi.fn(),
    onRestore: vi.fn(),
    onView: vi.fn(),
    restoring: false,
    viewedRevision: null,
    ...overrides
  };
}

function makeList(overrides: Partial<AssistantLibraryListView> = {}): AssistantLibraryListView {
  return {
    assistants: [],
    category: null,
    filter: "all",
    mode: "discover",
    onArchiveToggle: vi.fn(),
    onCategoryChange: vi.fn(),
    onDuplicate: vi.fn(),
    onEdit: vi.fn(),
    onFilterChange: vi.fn(),
    onModeChange: vi.fn(),
    onNewAssistant: vi.fn(),
    onOpenHistory: vi.fn(),
    onPinToggle: vi.fn(),
    onQueryChange: vi.fn(),
    onUse: vi.fn(),
    query: "",
    ...overrides
  };
}

function makeView(overrides: Partial<AssistantLibraryView> = {}): AssistantLibraryView {
  return {
    busy: false,
    catalogError: null,
    catalogState: "ready",
    editor: null,
    history: null,
    list: makeList(),
    notice: null,
    onBackToChat: vi.fn(),
    onDismissNotice: vi.fn(),
    onRetryCatalog: vi.fn(),
    task: "list",
    ...overrides
  };
}

function renderedCardIds(): (string | null)[] {
  return Array.from(
    screen.getByTestId("assistant-library-grid").querySelectorAll("[data-testid^='assistant-card-']")
  ).map((card) => card.getAttribute("data-testid"));
}

describe("AssistantLibrary", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("splits Discover and Yours, orders pinned first, and hides archived from Yours All", () => {
    const assistants = [
      makeAssistant({ id: "shared-beta", name: "Beta guide" }),
      makeAssistant({ id: "shared-zulu", name: "Zulu guide", pinned: true }),
      makeAssistant({ id: "own-active", name: "My analyst", owned: true }),
      makeAssistant({ archived: true, id: "own-archived", name: "My archived", owned: true })
    ];
    const { rerender } = render(<AssistantLibrary view={makeView({ list: makeList({ assistants }) })} />);

    const dialog = screen.getByRole("dialog", { name: "Assistant library" });
    expect(dialog).toBe(screen.getByTestId("assistant-library"));
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Back to chat" })).toBeVisible();

    expect(renderedCardIds()).toEqual(["assistant-card-shared-zulu", "assistant-card-shared-beta"]);
    expect(screen.queryByTestId("assistant-card-own-active")).not.toBeInTheDocument();

    rerender(<AssistantLibrary view={makeView({ list: makeList({ assistants, mode: "yours" }) })} />);
    expect(renderedCardIds()).toEqual(["assistant-card-own-active"]);
    expect(screen.queryByTestId("assistant-card-own-archived")).not.toBeInTheDocument();
    expect(screen.queryByTestId("assistant-card-shared-beta")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("assistant-card-own-active")).getByText(/Yours/)).toBeInTheDocument();
  });

  it("filters by category and by case-insensitive query, and reports chip selection", () => {
    const assistants = [
      makeAssistant({ category: "coding", id: "a-code", name: "Code helper" }),
      makeAssistant({
        category: "writing",
        description: "Drafts release notes.",
        id: "a-write",
        name: "Writing helper"
      })
    ];
    const categoryList = makeList({ assistants, category: "writing" });
    render(<AssistantLibrary view={makeView({ list: categoryList })} />);

    expect(renderedCardIds()).toEqual(["assistant-card-a-write"]);
    fireEvent.click(screen.getByRole("button", { name: "Coding" }));
    expect(categoryList.onCategoryChange).toHaveBeenCalledWith("coding");
    cleanup();

    render(<AssistantLibrary view={makeView({ list: makeList({ assistants, query: "RELEASE Notes" }) })} />);
    expect(renderedCardIds()).toEqual(["assistant-card-a-write"]);
    expect(screen.queryByTestId("assistant-card-a-code")).not.toBeInTheDocument();
  });

  it("disables Use on an unavailable assistant and shows only the neutral reason", () => {
    const assistants = [
      makeAssistant({
        availability: { ok: false, reason: "model_access" },
        id: "a-restricted",
        name: "Restricted helper"
      })
    ];
    render(<AssistantLibrary view={makeView({ list: makeList({ assistants, filter: "unavailable" }) })} />);

    const card = screen.getByTestId("assistant-card-a-restricted");
    expect(within(card).getByRole("button", { name: "Use Restricted helper" })).toBeDisabled();
    expect(within(card).getByText("Required access unavailable")).toBeVisible();
    expect(within(card).queryByText(/model_access/)).not.toBeInTheDocument();
    expect(card).not.toHaveTextContent("GPT-5.2");
  });

  it("flips the pinned value through onPinToggle", () => {
    const assistants = [
      makeAssistant({ id: "a-plain", name: "Plain helper" }),
      makeAssistant({ id: "a-pinned", name: "Pinned helper", pinned: true })
    ];
    const list = makeList({ assistants });
    render(<AssistantLibrary view={makeView({ list })} />);

    fireEvent.click(
      within(screen.getByTestId("assistant-card-a-plain")).getByRole("button", { name: "Pin Plain helper" })
    );
    expect(list.onPinToggle).toHaveBeenCalledWith("a-plain", true);

    fireEvent.click(
      within(screen.getByTestId("assistant-card-a-pinned")).getByRole("button", { name: "Unpin Pinned helper" })
    );
    expect(list.onPinToggle).toHaveBeenCalledWith("a-pinned", false);
  });

  it("enables the sole primary editor action only with a name and model", () => {
    const missingName = makeEditor({ draft: makeDraft({ name: "   " }) });
    const { rerender } = render(<AssistantLibrary view={makeView({ editor: missingName, task: "editor" })} />);
    expect(screen.getByTestId("assistant-editor-save")).toBeDisabled();

    const missingModel = makeEditor({ draft: makeDraft({ providerModelId: null }) });
    rerender(<AssistantLibrary view={makeView({ editor: missingModel, task: "editor" })} />);
    expect(screen.getByTestId("assistant-editor-save")).toBeDisabled();

    const ready = makeEditor();
    rerender(<AssistantLibrary view={makeView({ editor: ready, task: "editor" })} />);
    const save = screen.getByTestId("assistant-editor-save");
    expect(save).toBeEnabled();
    expect(save).toHaveTextContent("Create assistant");
    fireEvent.click(save);
    expect(ready.onSave).toHaveBeenCalledOnce();
  });

  it("routes Generate another to the controller once per click without any fetch", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const editor = makeEditor();
    render(<AssistantLibrary view={makeView({ editor, task: "editor" })} />);

    const generate = screen.getByRole("button", { name: "Generate another" });
    fireEvent.click(generate);
    expect(editor.onGenerateAvatar).toHaveBeenCalledTimes(1);
    fireEvent.click(generate);
    expect(editor.onGenerateAvatar).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lists publications in edit mode and revokes through the contract", () => {
    const editor = makeEditor({
      mode: "edit",
      publications: [
        {
          groupId: null,
          groupName: null,
          id: "pub-install",
          revisionNumber: 4,
          scope: "installation",
          updatedAt: "2026-08-02T09:00:00.000Z"
        },
        {
          groupId: "group-1",
          groupName: "Research",
          id: "pub-group",
          revisionNumber: 2,
          scope: "group",
          updatedAt: "2026-08-03T09:00:00.000Z"
        }
      ],
      publishableGroups: [{ id: "group-1", name: "Research" }],
      revisionNumber: 5
    });
    render(<AssistantLibrary view={makeView({ editor, task: "editor" })} />);

    fireEvent.click(screen.getByRole("button", { name: "Sharing" }));
    const publications = screen.getByRole("list", { name: "Publications" });
    expect(within(publications).getByText("Installation")).toBeVisible();
    expect(within(publications).getByText("Revision 4")).toBeVisible();
    expect(within(publications).getByText("Research")).toBeVisible();
    expect(within(publications).getByText("Revision 2")).toBeVisible();
    expect(
      screen.getByText(/Saving a revision never changes what a publication shares/)
    ).toBeVisible();

    fireEvent.click(within(publications).getByRole("button", { name: "Revoke Installation publication" }));
    expect(editor.onRevokePublication).toHaveBeenCalledWith("pub-install");
  });

  it("renders history entries with readable sections and hides Restore on the newest", () => {
    const history = makeHistory({
      entries: [
        {
          authorDisplayName: "Dana Ops",
          changedSections: ["instructions", "run-setup"],
          createdAt: "2026-08-04T12:00:00.000Z",
          revisionNumber: 3
        },
        {
          authorDisplayName: null,
          changedSections: ["identity"],
          createdAt: "2026-08-03T12:00:00.000Z",
          revisionNumber: 2
        }
      ]
    });
    render(<AssistantLibrary view={makeView({ history, task: "history" })} />);

    expect(screen.getByTestId("assistant-history")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Version history · Code reviewer" })
    ).toBeVisible();
    expect(screen.getByText("Changed: Instructions, Run setup")).toBeInTheDocument();
    expect(screen.getByText(/Unknown author/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View revision 3" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Restore revision 3" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Restore revision 2" }));
    expect(history.onRestore).toHaveBeenCalledWith(2);
  });
});
