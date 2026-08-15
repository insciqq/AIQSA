import { afterEach, describe, expect, it } from "vitest";
import {
  emptyRunSurfaceSnapshot,
  resetRunSurfaceStoreForTest,
  selectRunSurface,
  useRunSurfaceStore
} from "./runSurfaceStore";

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

  it("keeps transient event appends isolated by chat", () => {
    useRunSurfaceStore.getState().appendEvent("chat-a", {
      data: { message: "started" },
      type: "start"
    });
    useRunSurfaceStore.getState().appendEvent("chat-b", {
      data: { status: "complete" },
      type: "done"
    });

    expect(surface("chat-a")).toEqual({
      events: [{ data: { message: "started" }, type: "start" }]
    });
    expect(surface("chat-b")).toEqual({
      events: [{ data: { status: "complete" }, type: "done" }]
    });
  });

  it("compacts adjacent raw token frames while they are live", () => {
    useRunSurfaceStore.getState().appendEvent("chat-a", {
      data: { delta: "ab" },
      type: "token"
    });
    useRunSurfaceStore.getState().appendEvent("chat-a", {
      data: { delta: "c" },
      type: "token"
    });

    expect(surface("chat-a").events).toEqual([{
      data: { characterCount: 3, chunkCount: 2 },
      type: "token"
    }]);
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
