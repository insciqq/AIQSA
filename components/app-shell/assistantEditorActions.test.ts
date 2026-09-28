import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantDetail, AssistantRows } from "@/lib/contracts/assistants";
import {
  resetAssistantLibraryStoreForTest,
  resetComposerControlStoreForTest,
  resetMcpSettingsStoreForTest
} from "@/tests/support/appShellStores";
import {
  assistantContent,
  assistantControllerInput,
  assistantDetail,
  assistantList,
  assistantSummary,
  catalog,
  catalogModel,
  installAssistantEditor
} from "@/tests/support/assistantLibraryFixtures";
import { useAssistantLibraryStore } from "./assistantLibraryStore";
import { useComposerControlStore } from "./composerControlStore";
import { useMcpSettingsStore } from "./mcpSettingsStore";
import {
  buildAssistantLibraryView,
  createAssistantLibraryActions
} from "./assistantLibraryController";

const mocks = vi.hoisted(() => ({
  createAssistant: vi.fn(),
  fetchAssistantDetail: vi.fn(),
  fetchAssistantList: vi.fn(),
  loadUserMcpServers: vi.fn(),
  updateAssistant: vi.fn()
}));

vi.mock("@/components/assistants/assistantsApi", () => ({
  createAssistant: mocks.createAssistant,
  fetchAssistantDetail: mocks.fetchAssistantDetail,
  fetchAssistantList: mocks.fetchAssistantList,
  updateAssistant: mocks.updateAssistant
}));

vi.mock("@/components/app-shell/mcpSettingsApi", () => ({
  loadUserMcpServers: mocks.loadUserMcpServers
}));

const store = () => useAssistantLibraryStore.getState();

beforeEach(() => {
  vi.resetAllMocks();
  resetAssistantLibraryStoreForTest();
  resetComposerControlStoreForTest();
  resetMcpSettingsStoreForTest();
  mocks.fetchAssistantList.mockResolvedValue({ data: assistantList(), ok: true });
  mocks.loadUserMcpServers.mockResolvedValue([]);
});

function view(input = assistantControllerInput(), actions = createAssistantLibraryActions(input)) {
  return buildAssistantLibraryView(input, actions, store())!;
}

describe("New assistant", () => {
  it("opens the sheet, and Blank starts the editor with the PRD defaults", () => {
    const input = assistantControllerInput();
    const actions = createAssistantLibraryActions(input);
    store().patch({ open: true });

    view(input, actions).newAssistant.onOpen();
    expect(view(input, actions).newAssistant.open).toBe(true);
    view(input, actions).newAssistant.onBlank();

    const editor = view(input, actions).editor!;
    expect(store().newAssistantOpen).toBe(false);
    expect(editor).toMatchObject({ dirty: false, mode: "create", onOpenSharing: null });
    expect(editor.draft.rows).toMatchObject({
      knowledge: { policy: "adjustable", value: { mode: "none" } },
      model: { policy: "adjustable", value: { mode: "inherit" } },
      search: { policy: "adjustable", value: { mode: "inherit" } },
      skills: { policy: "adjustable", value: { links: [], mode: "auto" } },
      tools: { policy: "adjustable", value: { mode: "inherit" } }
    });
  });

  it("prefills a template's identity only and saves nothing", () => {
    const input = assistantControllerInput();
    const actions = createAssistantLibraryActions(input);
    store().patch({ open: true });

    view(input, actions).newAssistant.onTemplate(
      { description: "Answers from your documents.", name: "Support with Knowledge", starterPrompts: ["Where is the refund policy?"] },
      { expandedRow: "knowledge" }
    );

    expect(view(input, actions).editor).toMatchObject({
      draft: { description: "Answers from your documents.", name: "Support with Knowledge", starterPrompts: ["Where is the refund policy?"] },
      initialExpandedRow: "knowledge",
      mode: "create"
    });
    expect(mocks.createAssistant).not.toHaveBeenCalled();
  });

  it("carries the current chat's setup as adjustable rows with Skill delivery", () => {
    useComposerControlStore.setState({
      assistant: null,
      knowledgeSelection: { baseIds: ["base-1"], mode: "explicit", sourceIds: ["doc-1"], version: 1 },
      mcpSelection: { mode: "exact", serverIds: ["mcp-1"] },
      searchPlanMode: "model_choice",
      selectedModelId: "model-1",
      selectedSearchOptionIds: ["web"],
      selectedSkills: [
        { description: "Review carefully", id: "skill-review", name: "Reviewer", promptCharacterCount: 80 },
        { description: "Finish with actions", id: "skill-actions", name: "Action closer", promptCharacterCount: 60 }
      ],
      skillsMode: "off",
      temperature: "0.5"
    });
    const input = assistantControllerInput();
    const actions = createAssistantLibraryActions(input);

    actions.openNewAssistantFromCurrentSetup();

    const editor = view(input, actions).editor!;
    expect(Object.values(editor.draft.rows).every((row) => row.policy === "adjustable")).toBe(true);
    expect(editor.draft.rows).toMatchObject({
      controls: { value: { temperature: "0.5" } },
      knowledge: { value: { baseIds: ["base-1"], mode: "explicit", sourceIds: ["doc-1"] } },
      model: { value: { mode: "model", modelId: "model-1" } },
      search: { value: { mode: "model_choice", optionIds: ["web"] } },
      skills: {
        value: {
          links: [{ delivery: "always", skillId: "skill-review" }, { delivery: "always", skillId: "skill-actions" }],
          mode: "off"
        }
      },
      tools: { value: { mode: "exact", serverIds: ["mcp-1"] } }
    });
    expect(editor.options.selectedSkills).toEqual([
      { id: "skill-review", name: "Reviewer" },
      { id: "skill-actions", name: "Action closer" }
    ]);
  });

  it("keeps the chat Assistant's on-demand links and lists Load all servers exactly", () => {
    const rows = assistantContent().rows;
    useComposerControlStore.setState({
      assistant: {
        availability: { ok: true },
        avatar: assistantContent().avatar,
        description: null,
        id: "assistant-9",
        includedSkills: [{ id: "skill-lookup", mode: "available", name: "Lookup" }],
        name: "Helper",
        owned: false,
        ownerDisplayName: "Robin",
        promptCharacterCount: null,
        resets: {},
        rows: Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, {
          assistantValue: row.value, deviation: null, origin: "assistant", policy: row.policy
        }])) as never,
        starterPrompts: null,
        state: "bound",
        unsyncedRows: []
      },
      mcpSelection: { mode: "load_all" },
      selectedSkills: []
    });
    useMcpSettingsStore.setState({
      loadState: "ready",
      servers: [
        { enabled: true, id: "mcp-on", name: "On" },
        { enabled: false, id: "mcp-off", name: "Off" }
      ] as never
    });
    const input = assistantControllerInput();
    const actions = createAssistantLibraryActions(input);

    actions.openNewAssistantFromCurrentSetup();

    expect(store().editor?.draft.rows).toMatchObject({
      skills: { value: { links: [{ delivery: "on_demand", skillId: "skill-lookup" }] } },
      tools: { value: { mode: "exact", serverIds: ["mcp-on"] } }
    });
    expect(store().editor?.selectedSkills).toEqual([{ id: "skill-lookup", name: "Lookup" }]);
  });
});

describe("Assistant editor", () => {
  it("saves the rows draft with inherit values and policies intact", async () => {
    mocks.createAssistant.mockResolvedValue({ data: assistantDetail(1), ok: true });
    const input = assistantControllerInput();
    const actions = createAssistantLibraryActions(input);
    actions.openNewAssistantEditor({ name: "Persona" });

    await expect(view(input, actions).editor!.onSave()).resolves.toBe("assistant-1");

    const sent = mocks.createAssistant.mock.calls[0]![0] as { rows: AssistantRows };
    expect(sent.rows).toEqual({
      controls: { policy: "adjustable", value: {} },
      knowledge: { policy: "adjustable", value: { mode: "none" } },
      model: { policy: "adjustable", value: { mode: "inherit" } },
      search: { policy: "adjustable", value: { mode: "inherit" } },
      skills: { policy: "adjustable", value: { links: [], mode: "auto" } },
      tools: { policy: "adjustable", value: { mode: "inherit" } }
    });
    expect(store().notice?.text).toBe("Assistant created. It stays private until you share it.");
  });

  it("keeps the draft on a version conflict and shows the latest saved version", async () => {
    installAssistantEditor();
    const latest: AssistantDetail = assistantDetail(5, {
      content: assistantContent({ name: "Renamed elsewhere" })
    });
    mocks.updateAssistant.mockResolvedValue({ code: "assistant_version_conflict", message: "Conflict.", ok: false, status: 409 });
    mocks.fetchAssistantDetail.mockResolvedValue({ data: latest, ok: true });
    const input = assistantControllerInput();
    const actions = createAssistantLibraryActions(input);
    view(input, actions).editor!.onChange({ description: "My unsaved edit" });

    await expect(view(input, actions).editor!.onSave()).resolves.toBeNull();

    expect(view(input, actions).editor!.error?.text).toContain("Reload Assistants");
    expect(view(input, actions).editor!.error?.text).not.toContain("Library");
    await vi.waitFor(() => expect(view(input, actions).editor!.conflict).toMatchObject({
      latest: { draft: { name: "Renamed elsewhere" }, version: 5 },
      loading: false
    }));
    expect(view(input, actions).editor!.draft.description).toBe("My unsaved edit");

    expect(view(input, actions).editor!.savedName).toBe("Code reviewer");
    view(input, actions).editor!.onKeepDraftOverLatest();
    expect(store().editor).toMatchObject({ conflict: null, expectedVersion: 5 });
    expect(view(input, actions).editor).toMatchObject({ dirty: true, savedName: "Renamed elsewhere" });
  });

  it("replaces the draft with the latest saved version on request", async () => {
    installAssistantEditor();
    mocks.updateAssistant.mockResolvedValue({ code: "assistant_version_conflict", message: "Conflict.", ok: false });
    mocks.fetchAssistantDetail.mockResolvedValue({
      data: assistantDetail(6, { content: assistantContent({ name: "Latest" }) }),
      ok: true
    });
    const input = assistantControllerInput();
    const actions = createAssistantLibraryActions(input);
    view(input, actions).editor!.onChange({ description: "Mine" });
    await view(input, actions).editor!.onSave();
    await vi.waitFor(() => expect(store().editor?.conflict?.latest).not.toBeNull());

    view(input, actions).editor!.onReplaceDraftWithLatest();

    expect(view(input, actions).editor).toMatchObject({ conflict: null, dirty: false, draft: { name: "Latest" }, savedName: "Latest" });
    expect(store().editor?.expectedVersion).toBe(6);
  });

  it("blocks an invalid run control locally and names its field and row", async () => {
    installAssistantEditor();
    const input = assistantControllerInput();
    const actions = createAssistantLibraryActions(input);
    view(input, actions).editor!.onRowChange("controls", {
      value: { ...store().editor!.draft.rows.controls.value, maxOutputTokens: "0" }
    });

    await actions.saveEditor();

    expect(mocks.updateAssistant).not.toHaveBeenCalled();
    expect(store().editor).toMatchObject({
      errors: {
        fields: { maxOutputTokens: "Enter a whole number from 1 to 8192." },
        rows: { controls: "Enter a whole number from 1 to 8192." }
      },
      saving: false
    });
  });

  it("refuses a fixed row without a value and keys the error by row", async () => {
    installAssistantEditor();
    const input = assistantControllerInput();
    const actions = createAssistantLibraryActions(input);
    view(input, actions).editor!.onRowChange("search", { value: { mode: "inherit" } });

    await actions.saveEditor();

    expect(mocks.updateAssistant).not.toHaveBeenCalled();
    expect(store().editor?.errors?.rows).toEqual({
      search: "Choose a value to fix, or make this row Adjustable."
    });
  });

  it("attaches server run-control metadata to the exact field and row", async () => {
    installAssistantEditor();
    mocks.updateAssistant.mockResolvedValue({
      code: "assistant_run_controls_invalid",
      field: "maxOutputTokens",
      limit: 8192,
      message: "Invalid controls.",
      ok: false
    });
    const actions = createAssistantLibraryActions(assistantControllerInput());
    store().patchEditor({ baseline: "changed" });

    await actions.saveEditor();

    expect(store().editor).toMatchObject({
      errors: {
        fields: { maxOutputTokens: "Enter a whole number no greater than 8192." },
        rows: { controls: "Enter a whole number no greater than 8192." }
      },
      saving: false
    });
  });

  it("resets model-incompatible parameters visibly without clamping", () => {
    installAssistantEditor();
    const secondModel = catalogModel({
      displayName: "Model two",
      modelId: "model-2",
      parameterControls: {
        background: { defaultValue: false, supported: false },
        maxOutputTokens: { defaultValue: 1024, maxValue: 2048 },
        reasoningEffort: { defaultValue: "low", options: ["low"], supported: true },
        stream: { defaultValue: true, supported: true },
        temperature: { defaultValue: 0.5, maxValue: 1, minValue: 0, supported: true }
      }
    });
    const input = assistantControllerInput();
    input.catalog = catalog([catalogModel(), secondModel]);
    const actions = createAssistantLibraryActions(input);
    view(input, actions).editor!.onRowChange("controls", {
      value: { ...store().editor!.draft.rows.controls.value, backgroundMode: true, maxOutputTokens: "8000", reasoningEffort: "max" }
    });

    view(input, actions).editor!.onRowChange("model", { value: { mode: "model", modelId: "model-2" } });

    expect(store().editor?.draft.rows.controls.value).toMatchObject({
      backgroundMode: null,
      maxOutputTokens: "",
      reasoningEffort: ""
    });
    expect(store().notice?.text).toBe(
      "Background, Max answer length and Reasoning effort reset to the model defaults."
    );
  });

  it("opens stale saved controls as a visible unsaved reset", async () => {
    mocks.fetchAssistantDetail.mockResolvedValue({
      data: assistantDetail(3, {
        content: assistantContent({
          rows: { ...assistantContent().rows, controls: { policy: "adjustable", value: { maxOutputTokens: 9000 } } }
        })
      }),
      ok: true
    });
    const input = assistantControllerInput();
    const actions = createAssistantLibraryActions(input);
    store().patch({ open: true });

    await actions.openAssistantEditor("assistant-1");

    expect(store().editor?.draft.rows.controls.value.maxOutputTokens).toBe("");
    expect(store().notice?.text).toBe("Max answer length reset to the model default.");
    expect(view(input, actions).editor?.dirty).toBe(true);
  });

  it("blocks a disabled MCP server at the Tools row", async () => {
    mocks.loadUserMcpServers.mockResolvedValue([{ enabled: false, id: "mcp-disabled", name: "Disabled tools", readiness: "disabled" }]);
    const input = assistantControllerInput();
    const actions = createAssistantLibraryActions(input);
    actions.openLibrary();
    await vi.waitFor(() => expect(store().mcpOptions).toHaveLength(1));
    actions.openNewAssistantEditor({ name: "Tools helper" });
    await vi.waitFor(() => expect(store().mcpOptions).toHaveLength(1));
    view(input, actions).editor!.onRowChange("tools", { value: { mode: "exact", serverIds: ["mcp-disabled"] } });

    await actions.saveEditor();

    expect(mocks.createAssistant).not.toHaveBeenCalled();
    expect(store().editor?.errors?.rows).toEqual({
      tools: "Remove MCP servers that are disabled or unavailable before saving."
    });
  });

  it("offers Use in chat only for a clean, available, non-archived saved Assistant", () => {
    installAssistantEditor();
    const input = assistantControllerInput();
    const actions = createAssistantLibraryActions(input);

    expect(view(input, actions).editor?.onUseInChat).not.toBeNull();
    store().patchEditor({ availability: { ok: false, reason: "tools_access" } });
    expect(view(input, actions).editor?.onUseInChat).toBeNull();
  });

  it("gives the Sharing card the owner's audience and scope from the list", () => {
    installAssistantEditor();
    const audience = { everyone: true, groupNames: ["Design"] };
    store().patch({ data: assistantList({ assistants: [assistantSummary({ audience, published: true })] }) });
    expect(view().editor).toMatchObject({ audience, scope: { kind: "owner" } });
    store().patch({ data: assistantList() });
    expect(view().editor).toMatchObject({ audience: null, scope: null });
  });

  it("keeps Use in chat available after a newly created Assistant receives a second save", async () => {
    mocks.createAssistant.mockResolvedValue({ data: assistantDetail(1), ok: true });
    mocks.updateAssistant.mockResolvedValue({ data: assistantDetail(2), ok: true });
    mocks.fetchAssistantDetail.mockResolvedValue({ data: assistantDetail(2), ok: true });
    const input = assistantControllerInput();
    const actions = createAssistantLibraryActions(input);
    actions.openNewAssistantEditor({ name: "Code reviewer" });

    await actions.saveEditor();
    view(input, actions).editor!.onChange({ name: "Code reviewer v2" });
    await actions.saveEditor();

    expect(view(input, actions).editor?.onUseInChat).not.toBeNull();
    view(input, actions).editor?.onUseInChat?.();
    await vi.waitFor(() => expect(input.chooseAssistant).toHaveBeenCalledOnce());
    expect(input.chooseAssistant).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.objectContaining({ name: "Code reviewer" }) })
    );
  });

  it("saves and opens a Temporary chat with the Assistant", async () => {
    installAssistantEditor();
    mocks.updateAssistant.mockResolvedValue({ data: assistantDetail(4), ok: true });
    mocks.fetchAssistantDetail.mockResolvedValue({ data: assistantDetail(4), ok: true });
    const input = assistantControllerInput();
    const actions = createAssistantLibraryActions(input);
    view(input, actions).editor!.onChange({ description: "Now stricter." });

    await expect(view(input, actions).editor!.onSaveAndTry()).resolves.toBe(true);

    expect(mocks.updateAssistant).toHaveBeenCalledOnce();
    expect(input.activateBlankWorkspace).toHaveBeenCalledExactlyOnceWith({ temporary: true });
    expect(input.chooseAssistant).toHaveBeenCalledOnce();
    expect(store()).toMatchObject({ editor: null, open: false });
  });

  it("tries a saved Assistant without saving it again, and a failed save opens nothing", async () => {
    installAssistantEditor();
    mocks.fetchAssistantDetail.mockResolvedValue({ data: assistantDetail(3), ok: true });
    const input = assistantControllerInput();
    const actions = createAssistantLibraryActions(input);

    await expect(view(input, actions).editor!.onSaveAndTry()).resolves.toBe(true);
    expect(mocks.updateAssistant).not.toHaveBeenCalled();
    expect(input.activateBlankWorkspace).toHaveBeenCalledExactlyOnceWith({ temporary: true });

    installAssistantEditor();
    mocks.updateAssistant.mockResolvedValue({ code: "assistant_name_invalid", message: "Invalid", ok: false, status: 400 });
    view(input, actions).editor!.onChange({ name: "Renamed" });
    await expect(view(input, actions).editor!.onSaveAndTry()).resolves.toBe(false);
    expect(input.activateBlankWorkspace).toHaveBeenCalledOnce();
    expect(view(input, actions).editor!.errors?.fields.name).toBe("Use up to 80 characters.");
  });

  it("keeps authorized off-page names and removable unavailable Skill links across pages", async () => {
    store().patch({ open: true });
    const rows = assistantContent().rows;
    mocks.fetchAssistantDetail.mockResolvedValue({ ok: true, data: assistantDetail(3, {
      content: assistantContent({
        rows: {
          ...rows,
          skills: {
            policy: "fixed",
            value: { links: [{ delivery: "always", skillId: "off-page" }, { delivery: "on_demand", skillId: "revoked" }], mode: "auto" }
          }
        },
        skillIds: ["off-page", "revoked"]
      }),
      skills: [{ id: "off-page", name: "Older workflow", available: false }, { id: "revoked", name: "Unavailable Skill", available: false }]
    }) });
    const input = assistantControllerInput();
    const actions = createAssistantLibraryActions(input);
    await actions.openAssistantEditor("assistant-1");
    const editor = () => view(input, actions).editor!;
    expect(editor().options.selectedSkills).toEqual([
      { id: "off-page", name: "Older workflow", available: false }, { id: "revoked", name: "Unavailable Skill", available: false }
    ]);
    editor().onChange({ description: "Keep this draft" });
    input.skills = [{ id: "next-page", name: "Page two", description: "", archived: false,
      owned: true, ownerDisplayName: "Owner", instructionCharacterCount: 50,
      scope: { kind: "owner" }, updatedAt: "2026-09-11T00:00:00Z", version: 1 }];
    const links = editor().draft.rows.skills.value.links;
    editor().onRowChange("skills", { value: { links: [...links, { delivery: "always", skillId: "next-page" }], mode: "auto" } });
    input.skills = [];
    editor().onRowChange("skills", {
      value: { links: [links[0]!, { delivery: "always", skillId: "next-page" }], mode: "auto" }
    });
    expect(editor().options.selectedSkills).toEqual([
      { id: "off-page", name: "Older workflow", available: false }, { id: "next-page", name: "Page two", available: true }
    ]);
    expect(editor().draft.description).toBe("Keep this draft");
    expect(mocks.fetchAssistantDetail).toHaveBeenCalledOnce();
  });
});
