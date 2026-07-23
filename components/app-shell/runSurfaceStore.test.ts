import { afterEach, describe, expect, it } from "vitest";
import type { PersistedRun, RunEventView } from "./types";
import {
  emptyRunSurfaceSnapshot,
  resetRunSurfaceStoreForTest,
  selectRunSurface,
  useRunSurfaceStore
} from "./runSurfaceStore";

function run(id: string): PersistedRun {
  return {
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    errorPayload: null,
    estimatedCostMicros: null,
    events: [],
    id,
    inputTokens: 1,
    modelId: "model-1",
    outputTokens: 2,
    provider: "fake",
    reasoningTokens: 0,
    searchRuns: [],
    status: "complete",
    toolCalls: [],
    totalTokens: 3
  };
}

function surface(chatId: string | null) {
  return selectRunSurface(useRunSurfaceStore.getState(), chatId);
}

describe("run surface store", () => {
  afterEach(() => {
    resetRunSurfaceStoreForTest();
  });

  it("returns one stable empty surface for missing and blank chat ids", () => {
    const missing = surface("missing");
    const blank = surface(null);

    useRunSurfaceStore.getState().appendEvent("chat-a", { data: {}, type: "start" });

    expect(surface("missing")).toBe(missing);
    expect(surface(null)).toBe(blank);
    expect(missing).toBe(blank);
    expect(blank).toBe(emptyRunSurfaceSnapshot);
  });

  it("keeps appends and replacements isolated by chat", () => {
    const chatBRun = run("run-b");
    useRunSurfaceStore.getState().appendEvent("chat-a", {
      data: { message: "started" },
      type: "start"
    });
    useRunSurfaceStore.getState().replaceSurface("chat-b", {
      events: [{ data: { status: "complete" }, type: "done" }],
      lastRun: chatBRun
    });

    expect(surface("chat-a")).toEqual({
      events: [{ data: { message: "started" }, type: "start" }],
      lastRun: null
    });
    expect(surface("chat-b")).toEqual({
      events: [{ data: { status: "complete" }, type: "done" }],
      lastRun: chatBRun
    });
  });

  it("compacts adjacent raw token frames on append and replace", () => {
    const tokens: RunEventView[] = [
      { data: { delta: "ab" }, type: "token" },
      { data: { delta: "c" }, type: "token" }
    ];

    for (const event of tokens) {
      useRunSurfaceStore.getState().appendEvent("chat-a", event);
    }
    useRunSurfaceStore.getState().replaceSurface("chat-b", {
      events: tokens,
      lastRun: null
    });

    const compacted = [
      {
        data: { characterCount: 3, chunkCount: 2 },
        type: "token"
      }
    ];
    expect(surface("chat-a").events).toEqual(compacted);
    expect(surface("chat-b").events).toEqual(compacted);
  });

  it("resets only chat A and removes only chat B", () => {
    useRunSurfaceStore.getState().appendEvent("chat-a", { data: {}, type: "start" });
    useRunSurfaceStore.getState().appendEvent("chat-b", { data: {}, type: "start" });

    useRunSurfaceStore.getState().resetSurface("chat-a");

    expect(surface("chat-a")).toBe(emptyRunSurfaceSnapshot);
    expect(surface("chat-b").events).toHaveLength(1);

    useRunSurfaceStore.getState().removeSurface("chat-b");

    expect(useRunSurfaceStore.getState().surfacesByChatId).toHaveProperty(
      "chat-a",
      emptyRunSurfaceSnapshot
    );
    expect(useRunSurfaceStore.getState().surfacesByChatId).not.toHaveProperty("chat-b");
  });
});
