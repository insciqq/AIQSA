import { act, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CompactKnowledgePollingV2,
  compactKnowledgeRefreshPendingV2,
  knowledgeSummaryStatusV2
} from "./WorkspaceWelcomeV2";

afterEach(() => {
  vi.useRealTimers();
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
