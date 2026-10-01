import { act, render, renderHook } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeMcpSettings } from "@/components/app-shell/mcpSettingsStore";
import type { UserMcpServer } from "@/lib/contracts/mcp";
import { resetMcpSettingsStoreForTest } from "@/tests/support/appShellStores";
import {
  CompactKnowledgePollingV2,
  compactKnowledgeRefreshPendingV2,
  knowledgeSummaryStatusV2,
  memoryManagerErrorCopy,
  useStudioMcpAttentionV2
} from "./WorkspaceWelcomeV2";

afterEach(() => {
  vi.useRealTimers();
});

describe("Studio MCP attention", () => {
  afterEach(() => {
    resetMcpSettingsStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("flags the tab from the shared observation and releases only the Studio observer", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const ready: UserMcpServer = {
      accountLabel: null,
      description: "Team tasks",
      enabled: true,
      fields: [],
      id: "server-1",
      knownToolCount: 1,
      name: "Todoist",
      oauthAvailable: true,
      oauthState: "ready",
      readiness: "ready",
      tools: []
    };
    let current: UserMcpServer = { ...ready, oauthState: "reauthorization_required",
      readiness: "reauthorization_required" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ servers: [current] })));
    vi.stubGlobal("fetch", fetchMock);
    const releaseChatShell = observeMcpSettings();
    const studio = renderHook(() => useStudioMcpAttentionV2("account-1"));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(studio.result.current).toBe(true);

    current = ready;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(studio.result.current).toBe(false);

    studio.unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    releaseChatShell();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Studio alone keeps the catalog fresh while open and stops when left.
    const alone = renderHook(() => useStudioMcpAttentionV2("account-1"));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    alone.unmount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

describe("knowledgeSummaryStatusV2", () => {
  it("preserves exact server readiness and never guesses ready", () => {
    expect(knowledgeSummaryStatusV2({
      archived: false,
      readiness: { state: "processing" }
    })).toBe("processing");
    expect(knowledgeSummaryStatusV2({
      archived: false,
      readiness: { state: "needs_attention" }
    })).toBe("needs_attention");
    expect(knowledgeSummaryStatusV2({ archived: false })).toBe("unavailable");
    expect(knowledgeSummaryStatusV2({
      archived: true,
      readiness: { state: "trashed" }
    })).toBe("trashed");
    expect(knowledgeSummaryStatusV2({ archived: true })).toBe("archived");
  });
});

describe("memoryManagerErrorCopy", () => {
  it("keeps internal Memory failure codes out of the Library", () => {
    expect(memoryManagerErrorCopy("memory_unavailable")).toMatch(/temporarily unavailable/i);
    expect(memoryManagerErrorCopy("memory_secret_rejected")).toMatch(/looks like a secret/i);
    expect(memoryManagerErrorCopy("classifier_internal_code")).not.toContain("classifier_internal_code");
  });
});

describe("compactKnowledgeRefreshPendingV2", () => {
  it("polls only the visible compact Knowledge list while processing remains", () => {
    expect(compactKnowledgeRefreshPendingV2({
      activeTab: "knowledge",
      busy: false,
      catalog: "bases",
      processing: true,
      task: "list"
    })).toBe(true);
    expect(compactKnowledgeRefreshPendingV2({
      activeTab: "files",
      busy: false,
      catalog: "bases",
      processing: true,
      task: "list"
    })).toBe(false);
    expect(compactKnowledgeRefreshPendingV2({
      activeTab: "knowledge",
      busy: false,
      catalog: "bases",
      processing: false,
      task: "list"
    })).toBe(false);
    expect(compactKnowledgeRefreshPendingV2({
      activeTab: "knowledge",
      busy: false,
      catalog: "sources",
      processing: true,
      task: "list"
    })).toBe(false);
  });

  it("waits for a slow refresh before scheduling the next poll and stops on cleanup", async () => {
    vi.useFakeTimers();
    let settleFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      settleFirst = resolve;
    });
    const refresh = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue(undefined);
    const view = render(createElement(CompactKnowledgePollingV2, {
      active: true,
      onRefresh: refresh
    }));

    await act(async () => vi.advanceTimersByTime(2_000));
    expect(refresh).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(refresh).toHaveBeenCalledOnce();

    await act(async () => {
      settleFirst?.();
      await first;
    });
    await act(async () => vi.advanceTimersByTime(1_999));
    expect(refresh).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTime(1));
    expect(refresh).toHaveBeenCalledTimes(2);

    view.unmount();
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
