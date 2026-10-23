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
  effectiveComposerDisabledHint,
  shellComposerAssistant,
  runCatalogLoadDeduped,
  workspaceDefaultControlsFingerprint
} from "./PowerAppShellV2";
import type { Catalog } from "@/lib/contracts/catalog";

afterEach(() => resetComposerControlStoreForTest());

describe("PowerAppShellV2 catalog loading", () => {
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

describe("Composer send hint with a blocking Assistant", () => {
  const hint = (overrides: Partial<Parameters<typeof effectiveComposerDisabledHint>[0]>) =>
    effectiveComposerDisabledHint({
      assistantBlocked: false,
      personalHint: null,
      ...overrides
    });

  it("states the Assistant's gate instead of the model hint", () => {
    // A Fixed model without a credential leaves no current model (A-19).
    expect(hint({ assistantBlocked: true, personalHint: "Select an available model before sending." }))
      .toBe(ASSISTANT_SEND_GATE_HINT);
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

  it("keeps the ordinary hints once the user chose", () => {
    expect(hint({ personalHint: "Select an available model before sending." }))
      .toBe("Select an available model before sending.");
    expect(hint({})).toBeNull();
  });
});
