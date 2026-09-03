import { act, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CompactKnowledgePollingV2,
  compactKnowledgeRefreshPendingV2,
  dispatchAssistantUnavailableActionV2,
  knowledgeSummaryStatusV2,
  memoryManagerErrorCopy
} from "./WorkspaceWelcomeV2";

afterEach(() => {
  vi.useRealTimers();
});

describe("Assistant unavailable action routing", () => {
  it("opens the owned Assistant editor for a fixable saved setup", () => {
    const onCloseLibrary = vi.fn();
    const onOpenEditor = vi.fn();
    const onOpenMcpSettings = vi.fn();

    dispatchAssistantUnavailableActionV2({
      action: "open-editor",
      assistantId: "assistant-1",
      onCloseLibrary,
      onOpenEditor,
      onOpenMcpSettings
    });

    expect(onOpenEditor).toHaveBeenCalledWith("assistant-1");
    expect(onCloseLibrary).not.toHaveBeenCalled();
    expect(onOpenMcpSettings).not.toHaveBeenCalled();
  });

  it("closes Library before opening MCP Settings", () => {
    const onCloseLibrary = vi.fn();
    const onOpenEditor = vi.fn();
    const onOpenMcpSettings = vi.fn();

    dispatchAssistantUnavailableActionV2({
      action: "mcp-settings",
      assistantId: "assistant-1",
      onCloseLibrary,
      onOpenEditor,
      onOpenMcpSettings
    });

    expect(onCloseLibrary).toHaveBeenCalledOnce();
    expect(onOpenMcpSettings).toHaveBeenCalledOnce();
    expect(onCloseLibrary.mock.invocationCallOrder[0]).toBeLessThan(
      onOpenMcpSettings.mock.invocationCallOrder[0]!
    );
    expect(onOpenEditor).not.toHaveBeenCalled();
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
