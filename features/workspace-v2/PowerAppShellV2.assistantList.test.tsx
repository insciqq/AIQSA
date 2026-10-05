import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAssistantLibraryStore } from "@/components/app-shell/assistantLibraryStore";
import {
  resetAssistantLibraryStoreForTest,
  resetChatAssistantProjectionStoreForTest,
  resetComposerControlStoreForTest,
  resetComposerSessionStoreForTest,
  resetKnowledgeLibraryStoreForTest,
  resetThreadStoreForTest,
  resetWorkspaceStoreForTest
} from "@/tests/support/appShellStores";
import { assistantList, assistantSummary } from "@/tests/support/assistantLibraryFixtures";
import { matrixCatalog } from "@/tests/e2e/shell/catalog";
import { PowerAppShellV2 } from "./PowerAppShellV2";

/*
 * The whole shell with its real stores, in StrictMode as the development
 * server runs it, answering its startup requests from a table and counting
 * the Assistant list loads. The list answer is held until the test releases
 * it, so the first paint's loads are all in flight together.
 */
let releaseList: () => void = () => undefined;
let listLoads = 0;

async function answer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = String(input instanceof Request ? input.url : input).replace(/^https?:\/\/[^/]+/u, "");
  const pathname = path.split("?")[0]!;
  switch (pathname) {
    case "/api/me/catalog":
      return Response.json({ catalog: { ...matrixCatalog, defaults: { ...matrixCatalog.defaults, assistantId: null } } });
    case "/api/chats":
      return Response.json({ chats: [], folders: [] });
    case "/api/me/assistants":
      if ((init?.method ?? "GET") !== "GET") break;
      listLoads += 1;
      await new Promise<void>((resolve) => { releaseList = resolve; });
      return Response.json(assistantList({ assistants: [assistantSummary({ id: "assistant-1", pinned: true })] }));
    default:
      break;
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}

beforeEach(() => {
  listLoads = 0;
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

describe("the Assistant list of a blank personal chat", () => {
  it("loads once for the first paint, and the picker shares that load", async () => {
    render(
      <StrictMode>
        <PowerAppShellV2 accountDisplayName="User" accountEmail="user@example.test" accountId="user-1" />
      </StrictMode>
    );
    await vi.waitFor(() => expect(listLoads).toBe(1));
    const selector = await screen.findByTestId("header-assistant-selector");

    // Opening the picker while the first load is still in flight waits for it.
    fireEvent.click(selector);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(listLoads).toBe(1);

    await act(async () => {
      releaseList();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(useAssistantLibraryStore.getState().data?.assistants.map((assistant) => assistant.id)).toEqual(["assistant-1"]);
    expect(await screen.findByTestId("assistant-strip")).toBeVisible();
    expect(listLoads).toBe(1);
  });

  it("reloads when the picker opens over a loaded list, as before", async () => {
    render(<PowerAppShellV2 accountDisplayName="User" accountEmail="user@example.test" accountId="user-1" />);
    await vi.waitFor(() => expect(listLoads).toBe(1));
    await act(async () => {
      releaseList();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    fireEvent.click(await screen.findByTestId("header-assistant-selector"));
    await vi.waitFor(() => expect(listLoads).toBe(2));
    await act(async () => {
      releaseList();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  });
});
