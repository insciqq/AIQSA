import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import {
  resetAssistantLibraryStoreForTest,
  resetChatAssistantProjectionStoreForTest,
  resetComposerControlStoreForTest,
  resetComposerSessionStoreForTest,
  resetKnowledgeLibraryStoreForTest,
  resetThreadStoreForTest,
  resetWorkspaceStoreForTest
} from "@/tests/support/appShellStores";
import {
  assistantContent,
  assistantDetail,
  assistantList,
  assistantSummary
} from "@/tests/support/assistantLibraryFixtures";
import { matrixCatalog } from "@/tests/e2e/shell/catalog";
import { PowerAppShellV2 } from "./PowerAppShellV2";

/*
 * The whole shell with its real stores, answering its startup requests from
 * a table. A gated request answers only when the test opens its gate, so the
 * test decides what has finished when the user clicks.
 */
type Gate = { open(): Promise<void>; promise: Promise<void> };

function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return {
    async open() {
      await act(async () => {
        release();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    },
    promise
  };
}

let gates: Record<string, Gate> = {};
let defaultAssistantId: string | null = null;
let modelPolicy: "adjustable" | "fixed" = "adjustable";

function catalogResponse() {
  return {
    catalog: {
      ...matrixCatalog,
      defaults: {
        ...matrixCatalog.defaults,
        assistantId: defaultAssistantId,
        assistantUnavailable: false,
        // The organization default model is not in this user's catalog, so
        // the blank chat starts without a model.
        hasPersonalModelDefault: false,
        modelId: "missing-model",
        modelPreferenceSource: "organization",
        organizationModelDefault: { modelId: "missing-model", provider: "openai" },
        personalModelDefault: null,
        provider: "openai"
      }
    }
  };
}

const reviewer = () => assistantContent({
  providerModelId: "gpt-5.5",
  rows: { ...assistantContent().rows, model: { policy: modelPolicy, value: { mode: "model", modelId: "gpt-5.5" } } }
});

async function answer(input: RequestInfo | URL): Promise<Response> {
  const path = String(input instanceof Request ? input.url : input).replace(/^https?:\/\/[^/]+/u, "");
  const pathname = path.split("?")[0]!;
  await gates[pathname]?.promise;
  switch (pathname) {
    case "/api/me/catalog":
      return Response.json(catalogResponse());
    case "/api/chats":
      return Response.json({ chats: [], contentMatches: [], folders: [] });
    case "/api/me/assistants":
      return Response.json(assistantList({
        assistants: [assistantSummary({ id: "assistant-1", pinned: true })]
      }));
    case "/api/me/assistants/assistant-1":
      return Response.json({ assistant: assistantDetail(3, { content: reviewer() }) });
    default:
      return Response.json({ error: "not_found" }, { status: 404 });
  }
}

function renderShell() {
  render(<PowerAppShellV2 accountDisplayName="User" accountEmail="user@example.test" accountId="user-1" />);
}

const trigger = () => screen.getByTestId("header-model-trigger");
const picker = () => screen.queryByRole("dialog", { name: "Choose model" });

async function catalogLoaded() {
  await vi.waitFor(() => expect(useWorkspaceStore.getState().catalog).not.toBeNull());
}

beforeEach(() => {
  gates = {};
  defaultAssistantId = null;
  modelPolicy = "adjustable";
  resetAssistantLibraryStoreForTest();
  resetChatAssistantProjectionStoreForTest();
  resetComposerControlStoreForTest();
  resetComposerSessionStoreForTest();
  resetKnowledgeLibraryStoreForTest();
  resetThreadStoreForTest();
  resetWorkspaceStoreForTest();
  vi.stubGlobal("fetch", vi.fn(answer));
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches: false,
    media: query,
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn()
  })));
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the header model picker right after the shell loads", () => {
  it("is not actionable until the composer that opens it is shown, then opens on the first click", async () => {
    gates["/api/chats"] = gate();
    renderShell();
    await catalogLoaded();

    // The catalog is in, the workspace list is not: the conversation still
    // loads and renders no composer, so a click cannot be taken and dropped.
    expect(trigger()).toHaveTextContent("Choose model");
    expect(trigger()).toBeDisabled();
    fireEvent.click(trigger());
    expect(picker()).toBeNull();

    await gates["/api/chats"].open();
    await vi.waitFor(() => expect(trigger()).toBeEnabled());
    fireEvent.click(trigger());
    expect(picker()).not.toBeNull();
    expect(within(picker()!).getByText("GPT-5.5")).toBeVisible();
    expect(useComposerControlStore.getState().selectedModelId).toBe("");
  });

  it.each([
    ["the Assistants list, then the default Assistant", ["/api/me/assistants", "/api/me/assistants/assistant-1"]],
    ["the default Assistant, then the Assistants list", ["/api/me/assistants/assistant-1", "/api/me/assistants"]]
  ] as const)("stays open while %s finish in the background", async (_order, sequence) => {
    defaultAssistantId = "assistant-1";
    for (const path of sequence) gates[path] = gate();
    renderShell();
    await catalogLoaded();
    await vi.waitFor(() => expect(trigger()).toBeEnabled());

    fireEvent.click(trigger());
    expect(picker()).not.toBeNull();
    await gates[sequence[0]].open();
    expect(picker()).not.toBeNull();
    await gates[sequence[1]].open();

    // The default Assistant arrived while the picker was open: the picker
    // stays and shows the chat's new model.
    expect(useComposerControlStore.getState().assistant).toMatchObject({ id: "assistant-1", state: "bound" });
    expect(picker()).not.toBeNull();
    expect(trigger()).toHaveTextContent("GPT-5.5");

    // A click after both finished toggles it as usual.
    fireEvent.click(trigger());
    expect(picker()).toBeNull();
    fireEvent.click(trigger());
    expect(picker()).not.toBeNull();
  });
});

describe("the model parameters layer opened from the picker's Parameters row", () => {
  // A browser does not focus a control of an inert page; jsdom does, which
  // would let the picker's own focus return reach the header under the layer.
  beforeEach(() => {
    const focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options) {
      for (let node: HTMLElement | null = this; node; node = node.parentElement) if (node.inert) return;
      focus.call(this, options);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const parameters = () => screen.queryByRole("dialog", { name: "Model parameters" });
  const closeWays = [
    ["its Close button", (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole("button", { name: "Close parameters" }))],
    ["Escape", (dialog: HTMLElement) => fireEvent.keyDown(dialog, { key: "Escape" })],
    ["the scrim", (dialog: HTMLElement) => fireEvent.mouseDown(dialog.parentElement!)]
  ] as const;

  async function openParameters(ready: () => void = () => expect(trigger()).toBeEnabled()) {
    renderShell();
    await catalogLoaded();
    await vi.waitFor(ready);
    fireEvent.click(trigger());
    // The row closes the picker as it opens the layer, so it is gone when the layer closes.
    fireEvent.click(within(picker()!).getByTestId("composer-v2-model-parameters"));
    expect(picker()).toBeNull();
    await act(async () => undefined);
    expect(within(parameters()!).getByRole("button", { name: "Close parameters" })).toHaveFocus();
    return parameters()!;
  }

  it.each(closeWays)("returns focus to the header model selector when closed by %s", async (_way, close) => {
    const dialog = await openParameters();
    close(dialog);
    expect(parameters()).toBeNull();
    await vi.waitFor(() => expect(trigger()).toHaveFocus());
  });

  it.each(closeWays)("returns focus to the locked model selector of a fixed model when closed by %s", async (_way, close) => {
    defaultAssistantId = "assistant-1";
    modelPolicy = "fixed";
    const dialog = await openParameters(() => {
      expect(trigger()).toBeEnabled();
      expect(trigger()).toHaveAttribute("data-locked");
    });
    close(dialog);
    expect(parameters()).toBeNull();
    await vi.waitFor(() => expect(trigger()).toHaveFocus());
  });
});
