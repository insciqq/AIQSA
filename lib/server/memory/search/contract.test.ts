import { describe, expect, it } from "vitest";
import { decodeMemorySearchArguments, decodeMemorySearchSnapshot, memorySearchTool } from "./contract";

describe("native Memory search contract", () => {
  const snapshot = { version: "memory-search-v1", maxCalls: 3, resultTokens: 6000, comparisonResultTokens: 12000,
    memoryGeneration: 1, referenceChatHistory: true, timeoutSeconds: 30, destinations: [] } as const;
  it("accepts the new bounded read contract without accepting legacy markers", () => {
    expect(decodeMemorySearchSnapshot(snapshot)).toEqual(snapshot);
    expect(decodeMemorySearchSnapshot({ maxCalls: 2, pageSize: 20 })).toBeNull();
    expect(decodeMemorySearchSnapshot({ ...snapshot, maxCalls: 4 })).toBeNull();
    for (const timeoutSeconds of [0, 121, 1.5]) expect(decodeMemorySearchSnapshot({ ...snapshot, timeoutSeconds })).toBeNull();
    expect(decodeMemorySearchSnapshot({ ...snapshot, timeoutSeconds: 120 })).not.toBeNull();
  });
  it("accepts language-neutral queries and an explicit comparison budget, never authority arguments", () => {
    expect(decodeMemorySearchArguments({ query: " Что мы решили? ", comparison: true })).toEqual({ query: "Что мы решили?", comparison: true });
    expect(decodeMemorySearchArguments({ query: "past plan", comparison: false, userId: "other" })).toBeNull();
    expect(decodeMemorySearchArguments({ query: "x".repeat(2001), comparison: false })).toBeNull();
    expect(decodeMemorySearchArguments({ query: " ", comparison: false })).toBeNull();
  });
  it("advertises only allowed history and explains partial standing context", () => {
    expect(memorySearchTool(snapshot).description).toContain("past conversations");
    expect(memorySearchTool({ ...snapshot, referenceChatHistory: false }).description).not.toContain("and past conversations");
    expect(memorySearchTool(snapshot).description).toContain("before saying you do not know");
  });
});
