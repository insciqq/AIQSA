import type {
  AssistantAvatarRecipe,
  AssistantDetail,
  AssistantRevisionContent
} from "@/lib/contracts/assistants";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantEditorDraftState } from "@/components/assistants/libraryViewContracts";
import {
  resetAssistantLibraryStoreForTest,
  resetComposerControlStoreForTest
} from "@/tests/support/appShellStores";
import {
  initialAssistantLibrarySnapshot,
  useAssistantLibraryStore
} from "./assistantLibraryStore";
import { useComposerControlStore } from "./composerControlStore";
import {
  buildAssistantLibraryView,
  createAssistantLibraryActions,
  type AssistantLibraryControllerInput
} from "./assistantLibraryController";

const mocks = vi.hoisted(() => ({
  createAssistant: vi.fn(),
  duplicateAssistant: vi.fn(),
  fetchAssistantDetail: vi.fn(),
  fetchAssistantList: vi.fn(),
  fetchAssistantRevision: vi.fn(),
  fetchAssistantRevisions: vi.fn(),
  loadUserMcpServers: vi.fn(),
  publishAssistant: vi.fn(),
  reviseAssistant: vi.fn(),
  revokeAssistantPublication: vi.fn(),
  setAssistantArchived: vi.fn(),
  setAssistantPinned: vi.fn()
}));

vi.mock("@/components/assistants/assistantsApi", () => ({
  createAssistant: mocks.createAssistant,
  duplicateAssistant: mocks.duplicateAssistant,
  fetchAssistantDetail: mocks.fetchAssistantDetail,
  fetchAssistantList: mocks.fetchAssistantList,
  fetchAssistantRevision: mocks.fetchAssistantRevision,
  fetchAssistantRevisions: mocks.fetchAssistantRevisions,
  publishAssistant: mocks.publishAssistant,
  reviseAssistant: mocks.reviseAssistant,
  revokeAssistantPublication: mocks.revokeAssistantPublication,
  setAssistantArchived: mocks.setAssistantArchived,
  setAssistantPinned: mocks.setAssistantPinned
}));

vi.mock("@/components/app-shell/mcpSettingsApi", () => ({
  loadUserMcpServers: mocks.loadUserMcpServers
}));

const avatar: AssistantAvatarRecipe = {
  accents: [0, 4],
  backgroundShape: "circle",
  foregroundShape: "diamond",
  kind: "generated",
  paletteId: "ocean",
  recipeVersion: 1,
  rotations: [0, 2]
};

function revision(revisionNumber = 3): AssistantRevisionContent {
  return {
    authorDisplayName: "Dana Ops",
    avatar,
    category: "coding",
    createdAt: "2026-08-07T09:00:00.000Z",
    description: "Reviews changes with care.",
    developerPrompt: null,
    knowledgeBaseIds: [],
    mcpServerIds: [],
    name: "Code reviewer",
    providerModelId: "model-1",
    revisionNumber,
    runControls: {},
    searchPlan: { mode: "model_choice", optionIds: [] },
    skillIds: [],
    starterPrompts: [],
    systemPrompt: "Review carefully."
  };
}

function detail(revisionNumber = 3): AssistantDetail {
  return {
    archived: false,
    availability: { ok: true },
    id: "assistant-1",
    owned: true,
    ownerDisplayName: "Dana Ops",
    pinned: false,
    publications: [],
    revision: revision(revisionNumber),
    revisionCount: revisionNumber,
    version: revisionNumber
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function draft(): AssistantEditorDraftState {
  return {
    avatar,
    backgroundMode: false,
    category: "coding",
    description: "Reviews changes with care.",
    developerPrompt: "",
    knowledgeBaseIds: [],
    maxOutputTokens: "",
    mcpServerIds: [],
    name: "Code reviewer",
    providerModelId: "model-1",
    reasoningEffort: "",
    reasoningMode: "",
    searchOptionIds: [],
    searchPlanMode: "model_choice",
    skillIds: [],
    starterPrompts: [],
    streamMode: false,
    systemPrompt: "Review carefully.",
    temperature: ""
  };
}

function controllerInput(): AssistantLibraryControllerInput {
  return {
    activateBlankWorkspace: vi.fn(),
    applyAssistantToComposer: vi.fn(() => true),
    catalog: null,
    catalogError: null,
    knowledgeBases: [],
    knowledgeDataError: null,
    knowledgeDataState: "ready",
    retryCatalog: vi.fn(),
    retryKnowledge: vi.fn(),
    retrySkills: vi.fn(),
    setShellNotice: vi.fn(),
    skillDataError: null,
    skillDataState: "ready",
    skills: []
  };
}

function installEditor(options: { busy?: boolean } = {}) {
  const editorDraft = draft();
  useAssistantLibraryStore.setState({
    ...initialAssistantLibrarySnapshot,
    busy: options.busy ?? false,
    editor: {
      assistantId: "assistant-1",
      baseline: JSON.stringify(editorDraft),
      createdAssistantId: null,
      draft: editorDraft,
      error: null,
      expectedVersion: 3,
      publications: [],
      revisionNumber: 3,
      saving: false
    },
    open: true,
    task: "editor"
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  resetAssistantLibraryStoreForTest();
  resetComposerControlStoreForTest();
  mocks.fetchAssistantList.mockResolvedValue({
    data: {
      assistants: [],
      publishableGroups: [],
      viewer: { canPublishInstallation: false }
    },
    ok: true
  });
  mocks.fetchAssistantRevisions.mockResolvedValue({ data: [], ok: true });
  mocks.loadUserMcpServers.mockResolvedValue([]);
});

describe("assistantLibraryController", () => {
  it("loads Skill options lazily and prefills manual Skills from the current setup", () => {
    useComposerControlStore.setState({
      selectedSkills: [{
        description: "Review carefully",
        id: "skill-review",
        name: "Reviewer",
        promptCharacterCount: 80
      }, {
        description: "Finish with actions",
        id: "skill-actions",
        name: "Action closer",
        promptCharacterCount: 60
      }]
    });
    const input = controllerInput();
    const actions = createAssistantLibraryActions(input);

    actions.openNewAssistantFromCurrentSetup();

    expect(input.retrySkills).toHaveBeenCalledOnce();
    expect(useAssistantLibraryStore.getState()).toMatchObject({
      editor: {
        draft: { skillIds: ["skill-review", "skill-actions"] }
      },
      task: "editor"
    });
  });

  it("names the Assistants surface in a revision conflict recovery action", async () => {
    installEditor();
    mocks.reviseAssistant.mockResolvedValue({
      code: "assistant_version_conflict",
      message: "Conflict.",
      ok: false
    });
    const actions = createAssistantLibraryActions(controllerInput());

    await actions.saveEditor();

    expect(useAssistantLibraryStore.getState().editor?.error?.text).toContain("Reload Assistants");
    expect(useAssistantLibraryStore.getState().editor?.error?.text).not.toContain("Library");
  });

  it("keeps the successful restore notice while history refreshes", async () => {
    useAssistantLibraryStore.setState({
      ...initialAssistantLibrarySnapshot,
      history: {
        assistantId: "assistant-1",
        assistantName: "Code reviewer",
        entries: [],
        loading: false,
        restoring: false,
        viewedRevision: null
      },
      open: true,
      task: "history"
    });
    mocks.fetchAssistantRevision.mockResolvedValue({ data: revision(1), ok: true });
    mocks.fetchAssistantDetail.mockResolvedValue({ data: detail(3), ok: true });
    mocks.reviseAssistant.mockResolvedValue({ data: detail(4), ok: true });
    const actions = createAssistantLibraryActions(controllerInput());

    await actions.restoreHistoryRevision(1);

    expect(useAssistantLibraryStore.getState().notice).toEqual({
      kind: "success",
      text: "Restored as revision 4."
    });
  });

  it("refuses save and close mutations while another library operation is busy", async () => {
    installEditor({ busy: true });
    const actions = createAssistantLibraryActions(controllerInput());

    await actions.saveEditor();
    actions.closeEditor();
    actions.closeLibrary();

    expect(mocks.reviseAssistant).not.toHaveBeenCalled();
    expect(useAssistantLibraryStore.getState().editor).not.toBeNull();
    expect(useAssistantLibraryStore.getState().task).toBe("editor");
    expect(useAssistantLibraryStore.getState().open).toBe(true);
  });

  it("keeps Use in chat available after a newly created Assistant receives a second save", async () => {
    const editorDraft = draft();
    useAssistantLibraryStore.setState({
      ...initialAssistantLibrarySnapshot,
      editor: {
        assistantId: null,
        baseline: JSON.stringify(editorDraft),
        createdAssistantId: null,
        draft: editorDraft,
        error: null,
        expectedVersion: null,
        publications: null,
        revisionNumber: null,
        saving: false
      },
      open: true,
      task: "editor"
    });
    mocks.createAssistant.mockResolvedValue({ data: detail(1), ok: true });
    mocks.reviseAssistant.mockResolvedValue({ data: detail(2), ok: true });
    mocks.fetchAssistantDetail.mockResolvedValue({ data: detail(2), ok: true });
    const input = controllerInput();
    const actions = createAssistantLibraryActions(input);

    await actions.saveEditor();
    useAssistantLibraryStore.getState().patchEditor({
      draft: { ...useAssistantLibraryStore.getState().editor!.draft, name: "Code reviewer v2" }
    });
    await actions.saveEditor();

    const view = buildAssistantLibraryView(input, actions, useAssistantLibraryStore.getState());
    expect(view?.editor?.onUseInChat).not.toBeNull();
    view?.editor?.onUseInChat?.();
    await vi.waitFor(() => expect(input.applyAssistantToComposer).toHaveBeenCalledOnce());
    expect(input.applyAssistantToComposer).toHaveBeenCalledWith(
      expect.objectContaining({ revision: expect.objectContaining({ revisionNumber: 2 }) })
    );
  });

  it("resolves ordered Assistant Skill names only when the Assistant is used", async () => {
    mocks.fetchAssistantDetail.mockResolvedValue({
      data: {
        ...detail(),
        revision: { ...revision(), skillIds: ["skill-incident", "skill-review"] },
        skills: [
          { id: "skill-incident", name: "Incident brief" },
          { id: "skill-review", name: "Careful reviewer" }
        ]
      },
      ok: true
    });
    const input = controllerInput();
    const actions = createAssistantLibraryActions(input);

    await actions.useAssistant("assistant-1", { navigate: false });

    expect(input.applyAssistantToComposer).toHaveBeenCalledWith(expect.objectContaining({
      assistant: expect.objectContaining({
        includedSkills: [
          { id: "skill-incident", name: "Incident brief" },
          { id: "skill-review", name: "Careful reviewer" }
        ]
      })
    }));
  });

  it.each(["publish", "revoke"] as const)(
    "keeps %s reconciliation busy and refuses to patch a replacement editor",
    async (operation) => {
      installEditor();
      const reconciliation = deferred<{ data: AssistantDetail; ok: true }>();
      mocks.fetchAssistantDetail.mockReturnValue(reconciliation.promise);
      mocks.publishAssistant.mockResolvedValue({ data: undefined, ok: true });
      mocks.revokeAssistantPublication.mockResolvedValue({ data: undefined, ok: true });
      const actions = createAssistantLibraryActions(controllerInput());

      const pending = operation === "publish"
        ? actions.publish("assistant-1", { scope: "installation" })
        : actions.revokePublicationById("assistant-1", "publication-a");
      await vi.waitFor(() => expect(mocks.fetchAssistantDetail).toHaveBeenCalledOnce());
      expect(useAssistantLibraryStore.getState().busy).toBe(true);

      const replacementDraft = { ...draft(), name: "Assistant B" };
      useAssistantLibraryStore.getState().patch({
        editor: {
          assistantId: "assistant-b",
          baseline: JSON.stringify(replacementDraft),
          createdAssistantId: null,
          draft: replacementDraft,
          error: null,
          expectedVersion: 9,
          publications: [],
          revisionNumber: 9,
          saving: false
        },
        task: "editor"
      });
      reconciliation.resolve({ data: detail(4), ok: true });
      await pending;

      expect(useAssistantLibraryStore.getState().busy).toBe(false);
      expect(useAssistantLibraryStore.getState().editor).toMatchObject({
        assistantId: "assistant-b",
        expectedVersion: 9,
        publications: []
      });
    }
  );

  it("ignores a late history response after another Assistant history becomes current", async () => {
    const first = deferred<{ data: never[]; ok: true }>();
    const secondEntry = {
      authorDisplayName: "Bea",
      changedSections: ["identity"],
      createdAt: "2026-08-07T10:00:00.000Z",
      revisionNumber: 2
    };
    mocks.fetchAssistantRevisions
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ data: [secondEntry], ok: true });
    const actions = createAssistantLibraryActions(controllerInput());

    const firstOpen = actions.openHistory("assistant-a");
    await vi.waitFor(() => expect(mocks.fetchAssistantRevisions).toHaveBeenCalledOnce());
    useAssistantLibraryStore.getState().patch({ history: null, task: "list" });
    await actions.openHistory("assistant-b");
    first.resolve({ data: [], ok: true });
    await firstOpen;

    expect(useAssistantLibraryStore.getState().history).toMatchObject({
      assistantId: "assistant-b",
      entries: [secondEntry]
    });
  });

  it("ignores a viewed revision response after another Assistant history becomes current", async () => {
    useAssistantLibraryStore.setState({
      ...initialAssistantLibrarySnapshot,
      history: {
        assistantId: "assistant-a",
        assistantName: "Assistant A",
        entries: [],
        loading: false,
        restoring: false,
        viewedRevision: null
      },
      open: true,
      task: "history"
    });
    const viewed = deferred<{ data: AssistantRevisionContent; ok: true }>();
    mocks.fetchAssistantRevision.mockReturnValue(viewed.promise);
    const actions = createAssistantLibraryActions(controllerInput());

    const pending = actions.viewHistoryRevision(1);
    await vi.waitFor(() => expect(mocks.fetchAssistantRevision).toHaveBeenCalledOnce());
    useAssistantLibraryStore.getState().patch({
      history: {
        assistantId: "assistant-b",
        assistantName: "Assistant B",
        entries: [],
        loading: false,
        restoring: false,
        viewedRevision: null
      }
    });
    viewed.resolve({ data: revision(1), ok: true });
    await pending;

    expect(useAssistantLibraryStore.getState().history).toMatchObject({
      assistantId: "assistant-b",
      viewedRevision: null
    });
  });

  it("keeps the newest viewed revision when same-Assistant views settle out of order", async () => {
    useAssistantLibraryStore.setState({
      ...initialAssistantLibrarySnapshot,
      history: {
        assistantId: "assistant-a",
        assistantName: "Assistant A",
        entries: [],
        loading: false,
        restoring: false,
        viewedRevision: null
      },
      open: true,
      task: "history"
    });
    const older = deferred<{ data: AssistantRevisionContent; ok: true }>();
    const newer = deferred<{ data: AssistantRevisionContent; ok: true }>();
    mocks.fetchAssistantRevision
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const actions = createAssistantLibraryActions(controllerInput());

    const olderView = actions.viewHistoryRevision(1);
    const newerView = actions.viewHistoryRevision(2);
    newer.resolve({ data: revision(2), ok: true });
    await newerView;
    older.resolve({ data: revision(1), ok: true });
    await olderView;

    expect(useAssistantLibraryStore.getState().history?.viewedRevision?.revisionNumber).toBe(2);
  });

  it("does not let a late restore replace a different dirty editor", async () => {
    useAssistantLibraryStore.setState({
      ...initialAssistantLibrarySnapshot,
      history: {
        assistantId: "assistant-1",
        assistantName: "Code reviewer",
        entries: [],
        loading: false,
        restoring: false,
        viewedRevision: null
      },
      open: true,
      task: "history"
    });
    const restore = deferred<{ data: AssistantDetail; ok: true }>();
    mocks.fetchAssistantRevision.mockResolvedValue({ data: revision(1), ok: true });
    mocks.fetchAssistantDetail.mockResolvedValue({ data: detail(3), ok: true });
    mocks.reviseAssistant.mockReturnValue(restore.promise);
    const actions = createAssistantLibraryActions(controllerInput());

    const pending = actions.restoreHistoryRevision(1);
    await vi.waitFor(() => expect(mocks.reviseAssistant).toHaveBeenCalledOnce());
    const replacementDraft = { ...draft(), name: "Unsaved Assistant B" };
    useAssistantLibraryStore.getState().patch({
      editor: {
        assistantId: "assistant-b",
        baseline: JSON.stringify(draft()),
        createdAssistantId: null,
        draft: replacementDraft,
        error: null,
        expectedVersion: 2,
        publications: [],
        revisionNumber: 2,
        saving: false
      },
      history: null,
      task: "editor"
    });
    restore.resolve({ data: detail(4), ok: true });
    await pending;

    expect(useAssistantLibraryStore.getState()).toMatchObject({
      task: "editor",
      editor: { assistantId: "assistant-b", draft: { name: "Unsaved Assistant B" } }
    });
  });

  it("uses the restored revision name while refreshing history", async () => {
    useAssistantLibraryStore.setState({
      ...initialAssistantLibrarySnapshot,
      history: {
        assistantId: "assistant-1",
        assistantName: "Old name",
        entries: [],
        loading: false,
        restoring: false,
        viewedRevision: null
      },
      open: true,
      task: "history"
    });
    const restoredRevision = { ...revision(4), name: "Restored name" };
    mocks.fetchAssistantRevision.mockResolvedValue({ data: revision(1), ok: true });
    mocks.fetchAssistantDetail.mockResolvedValue({ data: detail(3), ok: true });
    mocks.reviseAssistant.mockResolvedValue({
      data: { ...detail(4), revision: restoredRevision },
      ok: true
    });
    mocks.fetchAssistantRevisions.mockResolvedValue({ data: [], ok: true });
    const actions = createAssistantLibraryActions(controllerInput());

    await actions.restoreHistoryRevision(1);
    await vi.waitFor(() => expect(useAssistantLibraryStore.getState().history?.loading).toBe(false));

    expect(useAssistantLibraryStore.getState().history?.assistantName).toBe("Restored name");
  });

  it("marks archive busy before its detail preflight settles", async () => {
    const preflight = deferred<{ data: AssistantDetail; ok: true }>();
    mocks.fetchAssistantDetail.mockReturnValue(preflight.promise);
    mocks.setAssistantArchived.mockResolvedValue({ data: detail(4), ok: true });
    const actions = createAssistantLibraryActions(controllerInput());

    const pending = actions.toggleArchived("assistant-1", true);
    expect(useAssistantLibraryStore.getState().busy).toBe(true);
    preflight.resolve({ data: detail(3), ok: true });
    await pending;

    expect(useAssistantLibraryStore.getState().busy).toBe(false);
  });

  it("guards stale list controls after a library mutation starts", () => {
    useAssistantLibraryStore.setState({
      ...initialAssistantLibrarySnapshot,
      category: null,
      filter: "all",
      mode: "discover",
      open: true,
      query: ""
    });
    const input = controllerInput();
    const actions = createAssistantLibraryActions(input);
    const view = buildAssistantLibraryView(input, actions, useAssistantLibraryStore.getState());
    useAssistantLibraryStore.getState().patch({ busy: true });

    view!.list.onCategoryChange("coding");
    view!.list.onFilterChange("pinned");
    view!.list.onModeChange("yours");
    view!.list.onQueryChange("changed");
    view!.onRetryCatalog();

    expect(useAssistantLibraryStore.getState()).toMatchObject({
      category: null,
      filter: "all",
      mode: "discover",
      query: ""
    });
    expect(input.retryCatalog).not.toHaveBeenCalled();
  });

  it("guards a stale history Back callback during restore and after task replacement", () => {
    useAssistantLibraryStore.setState({
      ...initialAssistantLibrarySnapshot,
      history: {
        assistantId: "assistant-a",
        assistantName: "Assistant A",
        entries: [],
        loading: false,
        restoring: false,
        viewedRevision: null
      },
      open: true,
      task: "history"
    });
    const input = controllerInput();
    const actions = createAssistantLibraryActions(input);
    const view = buildAssistantLibraryView(input, actions, useAssistantLibraryStore.getState());
    useAssistantLibraryStore.getState().patchHistory({ restoring: true });

    view!.history!.onBack();
    expect(useAssistantLibraryStore.getState().task).toBe("history");

    useAssistantLibraryStore.getState().patch({ history: null, task: "editor" });
    view!.history!.onBack();
    expect(useAssistantLibraryStore.getState().task).toBe("editor");
  });

  it("keeps the newest Assistant list when overlapping refreshes settle out of order", async () => {
    const older = deferred<{ data: { assistants: { id: string }[]; publishableGroups: never[]; viewer: { canPublishInstallation: false } }; ok: true }>();
    const newer = deferred<{ data: { assistants: { id: string }[]; publishableGroups: never[]; viewer: { canPublishInstallation: false } }; ok: true }>();
    mocks.fetchAssistantList.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const actions = createAssistantLibraryActions(controllerInput());

    const olderRefresh = actions.refreshList();
    const newerRefresh = actions.refreshList();
    newer.resolve({
      data: { assistants: [{ id: "newer" }], publishableGroups: [], viewer: { canPublishInstallation: false } },
      ok: true
    });
    await newerRefresh;
    older.resolve({
      data: { assistants: [{ id: "older" }], publishableGroups: [], viewer: { canPublishInstallation: false } },
      ok: true
    });
    await olderRefresh;

    expect(useAssistantLibraryStore.getState().data?.assistants.map((assistant) => assistant.id)).toEqual(["newer"]);
  });
});
