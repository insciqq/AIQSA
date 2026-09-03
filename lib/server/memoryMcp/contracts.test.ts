import { describe, expect, it } from "vitest";
import type { MemoryConsumerItem } from "../../contracts/memoryConsumer";
import {
  addMemoryInputSchema,
  getMemoryInputSchema,
  listMemoriesInputSchema,
  memoryMcpErrorResultSchema,
  projectMemoryMcpItem,
  projectMemoryMcpList,
  projectMemoryMcpSearch,
  searchMemoriesInputSchema,
  updateMemoryInputSchema
} from "./contracts";

const consumerItem: MemoryConsumerItem = {
  allowedActions: ["EDIT", "FORGET"],
  category: "PREFERENCES",
  createdAt: "2026-09-03T01:00:00.000Z",
  memoryRef: "mcm1.opaque-ref",
  provenance: "SAVED",
  sourceAvailable: true,
  statement: "I prefer aisle seats.",
  updatedAt: "2026-09-03T01:00:00.000Z"
};

describe("Personal Memory MCP contracts", () => {
  it("projects only the public fact fields", () => {
    expect(projectMemoryMcpItem(consumerItem)).toEqual({
      memoryRef: "mcm1.opaque-ref",
      text: "I prefer aisle seats.",
      category: "PREFERENCES",
      provenance: "SAVED",
      createdAt: "2026-09-03T01:00:00.000Z",
      updatedAt: "2026-09-03T01:00:00.000Z"
    });
    expect(projectMemoryMcpItem(consumerItem)).not.toHaveProperty("allowedActions");
    expect(projectMemoryMcpItem(consumerItem)).not.toHaveProperty("sourceAvailable");
    expect(projectMemoryMcpList({
      items: [consumerItem],
      nextCursor: "mcm1.cursor"
    })).toMatchObject({
      items: [{ text: consumerItem.statement }],
      nextCursor: "mcm1.cursor"
    });
    expect(projectMemoryMcpSearch([consumerItem])).toEqual({
      items: [{
        memoryRef: "mcm1.opaque-ref",
        text: "I prefer aisle seats.",
        category: "PREFERENCES",
        provenance: "SAVED",
        createdAt: "2026-09-03T01:00:00.000Z",
        updatedAt: "2026-09-03T01:00:00.000Z"
      }]
    });
    expect(projectMemoryMcpSearch([consumerItem])).not.toHaveProperty("nextCursor");
  });

  it("accepts only strict bounded fact inputs", () => {
    expect(addMemoryInputSchema.safeParse({ text: "  useful fact  " }).success).toBe(true);
    expect(addMemoryInputSchema.safeParse({ text: " ".repeat(3) }).success).toBe(false);
    expect(addMemoryInputSchema.safeParse({ text: "x\u0000y" }).success).toBe(false);
    expect(addMemoryInputSchema.safeParse({ text: "x".repeat(2_001) }).success).toBe(false);
    expect(addMemoryInputSchema.safeParse({ text: "fact", userId: "other" }).success)
      .toBe(false);
    expect(updateMemoryInputSchema.safeParse({
      memoryRef: "mcm1.ref",
      text: "replacement",
      category: "WORK"
    }).success).toBe(false);
  });

  it("keeps semantic search simple and pagination filters inventory-only", () => {
    expect(searchMemoriesInputSchema.safeParse({
      query: "seat preference",
      limit: 20
    }).success).toBe(true);
    expect(searchMemoriesInputSchema.safeParse({
      query: "seat preference",
      category: "PREFERENCES"
    }).success).toBe(false);
    expect(searchMemoriesInputSchema.safeParse({
      query: "seat preference",
      cursor: "mcm1.cursor"
    }).success).toBe(false);
    expect(searchMemoriesInputSchema.safeParse({ query: "x".repeat(501) }).success)
      .toBe(false);
    expect(listMemoriesInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(listMemoriesInputSchema.safeParse({ limit: 21 }).success).toBe(false);
    expect(listMemoriesInputSchema.safeParse({ metadata: {} }).success).toBe(false);
    expect(getMemoryInputSchema.safeParse({ memoryRef: "has whitespace" }).success)
      .toBe(false);
  });

  it("exposes only the approved stable application errors", () => {
    expect(memoryMcpErrorResultSchema.safeParse({ error: "memory_changed" }).success)
      .toBe(true);
    expect(memoryMcpErrorResultSchema.safeParse({ error: "memory_reset_in_progress" }).success)
      .toBe(false);
    expect(memoryMcpErrorResultSchema.safeParse({
      error: "memory_action_failed",
      message: "private details"
    }).success).toBe(false);
  });
});
