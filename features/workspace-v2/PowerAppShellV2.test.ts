import { afterEach, describe, expect, it } from "vitest";
import {
  initialComposerControlSnapshot,
  useComposerControlStore,
  type ComposerAssistantSelection,
  type ComposerControlSnapshot
} from "@/components/app-shell/composerControlStore";
import { resetComposerControlStoreForTest } from "@/tests/support/appShellStores";
import {
  enterProjectComposerControlBoundary,
  effectiveComposerDisabledHint,
  effectiveProjectCatalog,
  restorePersonalComposerControls,
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
      {
        selectedAssistant: {
          avatar: {
            accents: [0],
            backgroundShape: "circle" as const,
            foregroundShape: "diamond" as const,
            kind: "generated" as const,
            paletteId: "ocean" as const,
            recipeVersion: 1 as const,
            rotations: [0, 1] as [0, 1]
          },
          description: "Focused research helper",
          id: "assistant-1",
          name: "Researcher",
          promptCharacterCount: 120,
          starterPrompts: []
        }
      }
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
      personalHint: "No model access. Ask an admin to grant model access.",
      projectContext: true,
      projectHint: null
    })).toBeNull();
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
    const personalAssistant: ComposerAssistantSelection = {
      avatar: {
        accents: [0],
        backgroundShape: "circle" as const,
        foregroundShape: "diamond" as const,
        kind: "generated" as const,
        paletteId: "ocean" as const,
        recipeVersion: 1 as const,
        rotations: [0, 1]
      },
      description: "Personal helper",
      id: "personal-assistant",
      name: "Personal helper",
      promptCharacterCount: 25,
      starterPrompts: ["Personal starter"]
    };
    useComposerControlStore.setState({
      knowledgePlanSource: "explicit",
      knowledgeSelection: {
        baseIds: ["personal-base"],
        mode: "explicit",
        sourceIds: ["personal-source"],
        version: 1
      },
      mcpSelection: { mode: "load_all" },
      selectedAssistant: personalAssistant,
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
      mcpSelection: { mode: "off" },
      selectedAssistant: null,
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
      mcpSelection: { mode: "auto" },
      selectedAssistant: {
        avatar: {
          accents: [0],
          backgroundShape: "circle",
          foregroundShape: "diamond",
          kind: "generated",
          paletteId: "ocean",
          recipeVersion: 1,
          rotations: [0, 1]
        },
        description: "Project-only helper",
        id: "project-assistant",
        name: "Project helper",
        promptCharacterCount: 30,
        starterPrompts: ["Start together"]
      },
      selectedKnowledgeBaseIds: ["project-base"],
      selectedSearchOptionIds: ["project-search"],
      selectedSkills: []
    });
    enterProjectComposerControlBoundary(ref);

    expect(useComposerControlStore.getState()).toMatchObject({
      knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [] },
      mcpSelection: { mode: "off" },
      selectedAssistant: null,
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
      selectedAssistant: expect.objectContaining({ id: "personal-assistant" }),
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
