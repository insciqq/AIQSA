import { describe, expect, it } from "vitest";
import { initialComposerControlSnapshot } from "@/components/app-shell/composerControlStore";
import {
  effectiveComposerDisabledHint,
  effectiveProjectCatalog,
  runCatalogLoadDeduped,
  workspaceDefaultControlsFingerprint
} from "./PowerAppShellV2";
import type { Catalog } from "@/lib/contracts/catalog";
import type { ProjectDetailWire } from "@/lib/contracts/projects";

describe("PowerAppShellV2 catalog loading", () => {
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
});
