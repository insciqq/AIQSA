import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initialComposerControlSnapshot,
  useComposerControlStore,
  type ComposerControlSnapshot
} from "@/components/app-shell/composerControlStore";
import { resetComposerControlStoreForTest } from "@/tests/support/appShellStores";
import {
  boundComposerAssistantFixture,
  composerAssistantRowsFixture
} from "@/tests/support/composerAssistantFixtures";
import { ASSISTANT_SEND_GATE_HINT } from "./AssistantBindingNoticeV2";
import {
  assistantContent,
  assistantSummary,
  catalog as catalogFixture,
  catalogModel
} from "@/tests/support/assistantLibraryFixtures";
import type { BlankDefaultAssistant } from "@/components/app-shell/workspaceActions";
import {
  enterProjectComposerContext,
  enterProjectComposerControlBoundary,
  effectiveComposerDisabledHint,
  effectiveProjectCatalog,
  leaveProjectComposerContext,
  projectChatAssistantSource,
  projectStartingAssistant,
  restorePersonalComposerControls,
  shellComposerAssistant,
  runCatalogLoadDeduped,
  workspaceCommandRunning,
  workspaceDefaultControlsFingerprint
} from "./PowerAppShellV2";
import type { Catalog } from "@/lib/contracts/catalog";
import type { ProjectDetailWire } from "@/lib/contracts/projects";

afterEach(() => resetComposerControlStoreForTest());

describe("PowerAppShellV2 catalog loading", () => {
  it("reports a running Workspace command only from the live tool phase", () => {
    const workspaceCall = {
      data: {
        artifactType: "tool_call",
        payload: { serverName: "Workspace", status: "requested", toolName: "sandbox_shell" }
      },
      type: "artifact"
    };

    expect(workspaceCommandRunning([workspaceCall])).toBe(true);
    expect(workspaceCommandRunning([{
      ...workspaceCall,
      data: { ...workspaceCall.data, payload: {
        ...workspaceCall.data.payload, origin: "mcp"
      } }
    }])).toBe(false);
    expect(workspaceCommandRunning([{
      ...workspaceCall,
      data: { ...workspaceCall.data, payload: {
        ...workspaceCall.data.payload, origin: "workspace", serverName: "Execution tools"
      } }
    }])).toBe(true);
    expect(workspaceCommandRunning([workspaceCall, {
      data: { artifactType: "summary", payload: { stage: "model", status: "waiting" } },
      type: "artifact"
    }])).toBe(false);
    expect(workspaceCommandRunning([{
      data: {
        artifactType: "tool_call",
        payload: { serverName: "Knowledge", status: "requested", toolName: "search_knowledge" }
      },
      type: "artifact"
    }])).toBe(false);
    expect(workspaceCommandRunning([workspaceCall, {
      data: { runId: "run_1", status: "cancelled" },
      type: "done"
    }])).toBe(false);
    expect(workspaceCommandRunning([workspaceCall, {
      data: { code: "provider_stream_failed", message: "failed" },
      type: "error"
    }])).toBe(false);
  });

  it.each([
    ["search", { selectedSearchOptionIds: ["perplexity-tool-search"] }],
    [
      "assistant",
      { assistant: boundComposerAssistantFixture({ id: "assistant-1" }) }
    ],
    ["temperature", { temperature: "0.3" }],
    ["reasoning", { reasoningEffort: "high" }],
    ["stream", { streamMode: true }],
    ["background", { backgroundMode: false }]
  ])("detects a user $name change before catalog recovery reapplies chat defaults", (_name, update) => {
    const before = workspaceDefaultControlsFingerprint(initialComposerControlSnapshot);
    const after = workspaceDefaultControlsFingerprint({
      ...initialComposerControlSnapshot,
      ...update
    });

    expect(after).not.toBe(before);
  });

  it("deduplicates concurrent loads and does not refetch a hydrated catalog", async () => {
    let loadedCatalog: string | null = null;
    let loadCount = 0;
    let resolveLoad: ((value: string) => void) | undefined;
    const requestRef = { current: null as Promise<string | null> | null };
    const getLoadedCatalog = () => loadedCatalog;
    const load = async () => {
      loadCount += 1;
      const value = await new Promise<string>((resolve) => {
        resolveLoad = resolve;
      });
      loadedCatalog = value;
      return value;
    };

    const first = runCatalogLoadDeduped({ getLoadedCatalog, load, requestRef });
    const second = runCatalogLoadDeduped({ getLoadedCatalog, load, requestRef });

    expect(second).toBe(first);
    expect(loadCount).toBe(1);
    resolveLoad?.("catalog");
    await expect(first).resolves.toBe("catalog");
    await expect(runCatalogLoadDeduped({ getLoadedCatalog, load, requestRef })).resolves.toBe("catalog");
    expect(loadCount).toBe(1);
  });

  it("allows a failed catalog request to be retried", async () => {
    let loadedCatalog: string | null = null;
    let loadCount = 0;
    const requestRef = { current: null as Promise<string | null> | null };
    const getLoadedCatalog = () => loadedCatalog;
    const load = async () => {
      loadCount += 1;
      if (loadCount === 1) {
        return null;
      }
      loadedCatalog = "recovered";
      return loadedCatalog;
    };

    await expect(runCatalogLoadDeduped({ getLoadedCatalog, load, requestRef })).resolves.toBeNull();
    await expect(runCatalogLoadDeduped({ getLoadedCatalog, load, requestRef })).resolves.toBe("recovered");
    expect(loadCount).toBe(2);
  });
});

describe("Project effective catalog", () => {
  it("does not let missing personal model grants disable a ready Project composer", () => {
    expect(effectiveComposerDisabledHint({
      assistantBlocked: false,
      personalHint: "No model access. Ask an admin to grant model access.",
      projectAccessHint: null,
      projectContext: true,
      projectModelHint: null
    })).toBeNull();
  });
});

describe("Composer send hint with a blocking Assistant", () => {
  const hint = (overrides: Partial<Parameters<typeof effectiveComposerDisabledHint>[0]>) =>
    effectiveComposerDisabledHint({
      assistantBlocked: false,
      personalHint: null,
      projectAccessHint: null,
      projectContext: false,
      projectModelHint: null,
      ...overrides
    });

  it("states the Assistant's gate instead of the model hint in personal and Project chats", () => {
    // A Fixed model without a credential leaves no current model (A-19).
    expect(hint({ assistantBlocked: true, personalHint: "Select an available model before sending." }))
      .toBe(ASSISTANT_SEND_GATE_HINT);
    expect(hint({
      assistantBlocked: true,
      projectContext: true,
      projectModelHint: "Choose a model linked to this project."
    })).toBe(ASSISTANT_SEND_GATE_HINT);
  });

  it("reads the gate from the composer's Assistant whose Fixed model is not available", () => {
    useComposerControlStore.setState({
      assistant: boundComposerAssistantFixture({
        availability: { ok: false, reason: "model_access" },
        owned: false,
        rows: composerAssistantRowsFixture({ model: "fixed" })
      })
    });
    const current = shellComposerAssistant(useComposerControlStore.getState(), {
      model: undefined,
      scope: "chat",
      summary: undefined
    });

    expect(hint({
      assistantBlocked: Boolean(current?.blockReason),
      personalHint: "Select an available model before sending."
    })).toBe(ASSISTANT_SEND_GATE_HINT);
    useComposerControlStore.setState({ assistant: null });
    expect(hint({
      assistantBlocked: Boolean(shellComposerAssistant(useComposerControlStore.getState(), {
        model: undefined,
        scope: "chat",
        summary: undefined
      })?.blockReason),
      personalHint: "Select an available model before sending."
    })).toBe("Select an available model before sending.");
  });

  it("keeps Project access first and the ordinary hints once the user chose", () => {
    expect(hint({
      assistantBlocked: true,
      projectAccessHint: "Viewer access is read-only. Ask a project manager for Contributor access.",
      projectContext: true
    })).toBe("Viewer access is read-only. Ask a project manager for Contributor access.");
    expect(hint({ personalHint: "Select an available model before sending." }))
      .toBe("Select an available model before sending.");
    expect(hint({ projectContext: true, projectModelHint: "Choose a model linked to this project." }))
      .toBe("Choose a model linked to this project.");
    expect(hint({})).toBeNull();
  });

  it("uses the server-authored Project catalog without intersecting personal grants", () => {
    const personalCatalog = {
      defaults: {},
      models: [{ modelId: "personal-model", provider: "personal-provider", searchStrategyIds: [] }],
      providers: [{ id: "personal-provider", models: ["personal-model"], name: "Personal" }],
      searchStrategies: []
    } as unknown as Catalog;
    const projectCatalog = {
      defaults: {},
      models: [{ modelId: "project-model", provider: "project-provider", searchStrategyIds: [] }],
      providers: [{ id: "project-provider", models: ["project-model"], name: "Project" }],
      searchStrategies: []
    } as unknown as Catalog;
    const project = {
      composer: {
        assistants: [],
        catalog: projectCatalog,
        knowledgeBases: [],
        mcpServers: []
      }
    } as unknown as ProjectDetailWire;

    expect(effectiveProjectCatalog(personalCatalog, project)).toBe(projectCatalog);
  });

  it("does not fall back to a personal catalog while Project authority is unavailable", () => {
    const personalCatalog = { defaults: {}, models: [], providers: [], searchStrategies: [] } as unknown as Catalog;
    const project = {} as ProjectDetailWire;

    expect(effectiveProjectCatalog(personalCatalog, project)).toBeNull();
  });

  it("masks personal and Project-A controls during async Project entry/switch, then restores personal state", () => {
    // A personal Assistant with a row changed for the chat not yet synced.
    const personalAssistant = boundComposerAssistantFixture({
      id: "personal-assistant",
      name: "Personal helper",
      unsyncedRows: ["search"]
    });
    personalAssistant.rows.search = { ...personalAssistant.rows.search, origin: "chat" };
    useComposerControlStore.setState({
      knowledgePlanSource: "explicit",
      knowledgeSelection: {
        baseIds: ["personal-base"],
        mode: "explicit",
        sourceIds: ["personal-source"],
        version: 1
      },
      assistant: personalAssistant,
      mcpSelection: { mode: "load_all" },
      selectedKnowledgeBaseIds: ["personal-base"],
      selectedModelId: "personal-model",
      selectedProvider: "personal-provider",
      selectedSearchOptionIds: ["personal-search"],
      selectedSkills: [{
        description: "Personal workflow",
        id: "personal-skill",
        name: "Personal skill",
        promptCharacterCount: 20
      }]
    });
    const ref = { current: null as ComposerControlSnapshot | null };
    enterProjectComposerControlBoundary(ref);

    expect(useComposerControlStore.getState()).toMatchObject({
      knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [] },
      assistant: null,
      mcpSelection: { mode: "off" },
      selectedKnowledgeBaseIds: [],
      selectedModelId: "",
      selectedProvider: "",
      selectedSearchOptionIds: [],
      selectedSkills: []
    });

    // Personal blank activation runs between the controller's entry callback
    // and Project-session activation. A second fence must remove the personal
    // catalog defaults it may resolve when no Assistant is selected.
    useComposerControlStore.setState({
      knowledgePlanSource: "off",
      knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      selectedModelId: "personal-catalog-default",
      selectedProvider: "personal-catalog-provider"
    });
    enterProjectComposerControlBoundary(ref);
    expect(useComposerControlStore.getState()).toMatchObject({
      selectedModelId: "",
      selectedProvider: ""
    });

    useComposerControlStore.setState({
      knowledgePlanSource: "project",
      knowledgeSelection: {
        baseIds: ["project-base"],
        mode: "explicit",
        sourceIds: [],
        version: 1
      },
      mcpSelection: { mode: "exact", serverIds: ["project-server"] },
      assistant: boundComposerAssistantFixture({ id: "project-assistant", name: "Project helper" }),
      selectedKnowledgeBaseIds: ["project-base"],
      selectedSearchOptionIds: ["project-search"],
      selectedSkills: []
    });
    enterProjectComposerControlBoundary(ref);

    expect(useComposerControlStore.getState()).toMatchObject({
      knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [] },
      assistant: null,
      mcpSelection: { mode: "off" },
      selectedKnowledgeBaseIds: [],
      selectedModelId: "",
      selectedProvider: "",
      selectedSearchOptionIds: [],
      selectedSkills: []
    });

    useComposerControlStore.getState().setShowCitations(false);
    useComposerControlStore.getState().setShowReasoningBlocks(true);
    restorePersonalComposerControls(ref);

    expect(useComposerControlStore.getState()).toMatchObject({
      knowledgePlanSource: "explicit",
      knowledgeSelection: {
        baseIds: ["personal-base"],
        sourceIds: ["personal-source"]
      },
      mcpSelection: { mode: "load_all" },
      assistant: expect.objectContaining({
        id: "personal-assistant",
        rows: expect.objectContaining({ search: expect.objectContaining({ origin: "chat" }) }),
        unsyncedRows: ["search"]
      }),
      selectedModelId: "personal-model",
      selectedProvider: "personal-provider",
      selectedSearchOptionIds: ["personal-search"],
      selectedSkills: [expect.objectContaining({ id: "personal-skill" })],
      showCitations: false,
      showReasoningBlocks: true
    });
    expect(ref.current).toBeNull();
  });
});

describe("Project chat Assistants", () => {
  const projectModel = catalogModel({ displayName: "Project model", modelId: "project-model", provider: "shared" });

  function projectEntry(id: string, overrides: Readonly<{
    content?: Parameters<typeof assistantContent>[0];
    summary?: Parameters<typeof assistantSummary>[0];
  }> = {}) {
    return {
      content: assistantContent({ name: "Launch helper", providerModelId: "project-model", ...overrides.content }),
      promptCharacterCount: 120,
      summary: assistantSummary({
        id,
        name: "Launch helper",
        owned: false,
        ownerDisplayName: "Project",
        scope: { kind: "project", projectName: "Launch" },
        ...overrides.summary
      })
    };
  }

  function project(entries: ReturnType<typeof projectEntry>[], assistantId: string | null = "assistant-project") {
    return {
      composer: {
        assistants: entries,
        catalog: catalogFixture([projectModel]),
        knowledgeBases: [],
        knowledgeDocumentTotal: 0,
        knowledgeSources: [],
        mcpServers: []
      },
      defaults: {
        assistantId,
        controlValues: {},
        knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
        mcpMode: "off",
        providerModelId: "project-model",
        searchPlan: { mode: "all_selected", optionIds: [] }
      },
      id: "project-1",
      policy: { externalToolsEnabled: false },
      resources: [{
        available: true,
        id: "binding-model",
        label: "Project model",
        modelId: "project-model",
        provider: "shared",
        reason: null,
        resourceId: "project-model",
        type: "model"
      }]
    } as unknown as ProjectDetailWire;
  }

  const projectRows = (modelId: string | null) => ({
    ...assistantContent().rows,
    model: { policy: "adjustable" as const, value: { mode: "model" as const, modelId } }
  });

  it("starts a new Project chat with a listed, usable Assistant as the Project's", () => {
    const applied = projectStartingAssistant(project([projectEntry("assistant-project", {
      content: { rows: projectRows("project-model") }
    })]), "assistant-project");

    expect(applied?.assistant).toMatchObject({
      id: "assistant-project",
      owned: false,
      ownerDisplayName: "Project",
      promptCharacterCount: 120,
      state: "bound"
    });
    expect(applied?.controls).toMatchObject({ selectedModelId: "project-model", selectedProvider: "shared" });
  });

  it("starts without an Assistant when the default is not listed or not usable in the Project", () => {
    expect(projectStartingAssistant(project([]), "assistant-project")).toBeNull();
    expect(projectStartingAssistant(project([projectEntry("assistant-project", {
      summary: { availability: { ok: false, reason: "tools_access" } }
    })]), "assistant-project")).toBeNull();
  });

  it("runs a row the Project cannot provide with the Project default and marks it as falling back", () => {
    // A personal model of the owner reads as none in the Project's entry.
    const applied = projectStartingAssistant(project([projectEntry("assistant-project", {
      content: { providerModelId: null, rows: projectRows(null) },
      summary: { rowAvailability: { model: { reason: "model_access" } } }
    })]), "assistant-project");

    expect(applied?.assistant.rows.model).toMatchObject({
      assistantValue: { mode: "model", modelId: null },
      deviation: { reason: "model_access" },
      origin: "fallback"
    });
    expect(applied?.controls).toMatchObject({ selectedModelId: "project-model", selectedProvider: "shared" });
  });

  it("applies the Project default only to a new Project chat, never to an existing one", () => {
    const draft = { pendingProjectDraft: { folderId: null, projectId: "project-1" } };
    expect(projectChatAssistantSource(draft, false)).toBe("project_default");
    expect(projectChatAssistantSource({}, true)).toBe("projection");
    expect(projectChatAssistantSource({}, false)).toBe("none");
  });

  it("marks the chat's Assistant as the Project's only in a Project chat", () => {
    useComposerControlStore.setState({ assistant: boundComposerAssistantFixture() });
    const state = useComposerControlStore.getState();

    expect(shellComposerAssistant(state, { model: undefined, project: true, scope: "chat", summary: undefined }))
      .toMatchObject({ project: true, state: "bound" });
    expect(shellComposerAssistant(state, { model: undefined, scope: "chat", summary: undefined }))
      .not.toHaveProperty("project");
  });

  it("hands a consumer's archived binding to the header and notice with its reason", () => {
    useComposerControlStore.setState({ assistant: { reason: "archived", state: "unavailable" } });
    expect(shellComposerAssistant(useComposerControlStore.getState(), { model: undefined, scope: "chat", summary: undefined }))
      .toEqual({
        blockReason: "This Assistant was archived by its owner. Choose another or continue without the Assistant.",
        reason: "archived",
        scope: "chat",
        state: "unavailable"
      });
  });

  function contextRefs(mark: BlankDefaultAssistant | null) {
    return {
      blankDefaultAssistant: { current: mark },
      controls: { current: null as ComposerControlSnapshot | null },
      personalBlankDefaultAssistant: { current: null as BlankDefaultAssistant | null }
    };
  }

  it("returns the personal composer exactly as it was, without a default loaded on the way out", () => {
    // The personal blank chat's default was removed for that chat before entering.
    const removedDefault: BlankDefaultAssistant = { assistantId: "personal-default", state: "applied" };
    useComposerControlStore.setState({ assistant: null, selectedModelId: "personal-model" });
    const refs = contextRefs(removedDefault);
    enterProjectComposerContext(refs);
    useComposerControlStore.setState({ assistant: boundComposerAssistantFixture({ id: "project-assistant" }) });
    // Leaving a Project chat opens the personal blank chat, which starts loading the default.
    refs.blankDefaultAssistant.current = { assistantId: "personal-default", state: "loading" };
    const applyPersonalBlankDefaults = vi.fn();
    const skipBlankDefaultAssistant = vi.fn();

    leaveProjectComposerContext({ ...refs, accessLost: false, applyPersonalBlankDefaults, skipBlankDefaultAssistant });

    expect(useComposerControlStore.getState()).toMatchObject({ assistant: null, selectedModelId: "personal-model" });
    expect(refs.blankDefaultAssistant.current).toBe(removedDefault);
    expect(skipBlankDefaultAssistant).not.toHaveBeenCalled();
    expect(applyPersonalBlankDefaults).not.toHaveBeenCalled();
  });

  it("keeps the default load started on the way out when one was still loading on the way in", () => {
    const refs = contextRefs({ assistantId: "personal-default", state: "loading" });
    enterProjectComposerContext(refs);
    const outbound: BlankDefaultAssistant = { assistantId: "personal-default", state: "loading" };
    refs.blankDefaultAssistant.current = outbound;

    leaveProjectComposerContext({
      ...refs, accessLost: false, applyPersonalBlankDefaults: vi.fn(), skipBlankDefaultAssistant: vi.fn()
    });

    expect(refs.blankDefaultAssistant.current).toBe(outbound);
  });

  it("leaves no Assistant after access loss, neither a personal one nor the personal default", () => {
    useComposerControlStore.setState({
      assistant: boundComposerAssistantFixture({ id: "personal-assistant" }),
      selectedModelId: "personal-model"
    });
    const refs = contextRefs(null);
    enterProjectComposerContext(refs);
    useComposerControlStore.setState({ assistant: boundComposerAssistantFixture({ id: "project-assistant" }) });
    const applyPersonalBlankDefaults = vi.fn(() => useComposerControlStore.getState().clearAssistant());
    const skipBlankDefaultAssistant = vi.fn();

    leaveProjectComposerContext({ ...refs, accessLost: true, applyPersonalBlankDefaults, skipBlankDefaultAssistant });

    expect(useComposerControlStore.getState().assistant).toBeNull();
    expect(applyPersonalBlankDefaults).toHaveBeenCalledOnce();
    expect(skipBlankDefaultAssistant).toHaveBeenCalledOnce();

    // Without an Assistant to remove, the personal controls stay as they were.
    useComposerControlStore.setState({ assistant: null });
    enterProjectComposerContext(refs);
    applyPersonalBlankDefaults.mockClear();
    leaveProjectComposerContext({ ...refs, accessLost: true, applyPersonalBlankDefaults, skipBlankDefaultAssistant });
    expect(applyPersonalBlankDefaults).not.toHaveBeenCalled();
    expect(useComposerControlStore.getState().selectedModelId).toBe("personal-model");
  });
});
