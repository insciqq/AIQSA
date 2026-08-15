import { describe, expect, it } from "vitest";
import { initialComposerControlSnapshot } from "@/components/app-shell/composerControlStore";
import {
  runCatalogLoadDeduped,
  workspaceDefaultControlsFingerprint
} from "./PowerAppShellV2";
import { isShellShortcutTextEntryTarget } from "@/components/app-shell/useShellOverlayController";

describe("PowerAppShellV2 shortcut targets", () => {
  it("treats typing surfaces as local shortcut targets", () => {
    const input = document.createElement("input");
    input.type = "text";
    const textarea = document.createElement("textarea");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");

    expect(isShellShortcutTextEntryTarget(input)).toBe(true);
    expect(isShellShortcutTextEntryTarget(textarea)).toBe(true);
    expect(isShellShortcutTextEntryTarget(editable)).toBe(true);
  });

  it("allows global shortcuts from non-typing controls", () => {
    const button = document.createElement("button");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";

    expect(isShellShortcutTextEntryTarget(button)).toBe(false);
    expect(isShellShortcutTextEntryTarget(checkbox)).toBe(false);
  });
});

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
