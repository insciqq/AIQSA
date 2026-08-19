import { describe, expect, it } from "vitest";
import {
  decodeKnowledgeExactCursor,
  decodeKnowledgeHierarchicalLimit,
  decodeKnowledgeHierarchicalQuery,
  decodeKnowledgeHierarchicalScope,
  decodeKnowledgeSafeRegex,
  encodeKnowledgeExactCursor,
  KNOWLEDGE_HIERARCHICAL_SCOPE_MAX_ARTIFACTS
} from "./hierarchicalRetrieval";

describe("Knowledge hierarchical retrieval bounds", () => {
  it("requires an explicit bounded owner scope before query work", () => {
    expect(decodeKnowledgeHierarchicalScope({
      ownerUserId: "owner-1",
      sourceArtifactIds: ["artifact-1", "artifact-1", "artifact-2"]
    })).toEqual({
      ownerUserId: "owner-1",
      sourceArtifactIds: ["artifact-1", "artifact-2"]
    });
    expect(() => decodeKnowledgeHierarchicalScope({
      ownerUserId: "owner-1",
      sourceArtifactIds: []
    })).toThrowError(expect.objectContaining({ code: "knowledge_index_scope_invalid" }));
    expect(() => decodeKnowledgeHierarchicalScope({
      ownerUserId: "owner-1",
      sourceArtifactIds: Array.from(
        { length: KNOWLEDGE_HIERARCHICAL_SCOPE_MAX_ARTIFACTS + 1 },
        (_, index) => `artifact-${index}`
      )
    })).toThrowError(expect.objectContaining({ code: "knowledge_index_scope_invalid" }));
  });

  it("accepts useful bounded regex while rejecting catastrophic or scope-wide patterns", () => {
    expect(decodeKnowledgeSafeRegex("AX[0-9]{8}")).toBe("AX[0-9]{8}");
    expect(decodeKnowledgeSafeRegex("[А-Я]{2}-[0-9]{4}")).toBe("[А-Я]{2}-[0-9]{4}");
    for (const unsafe of [
      "(a+)+",
      ".*",
      "(?=secret)secret",
      "(secret)\\1",
      "secret.{1,999}",
      "(unbalanced"
    ]) {
      expect(() => decodeKnowledgeSafeRegex(unsafe), unsafe).toThrowError(
        expect.objectContaining({ code: "knowledge_exact_pattern_unsafe" })
      );
    }
  });

  it("uses canonical bounded cursors and rejects malformed query limits", () => {
    const cursor = encodeKnowledgeExactCursor(42);
    expect(decodeKnowledgeExactCursor(cursor)).toBe(42);
    expect(decodeKnowledgeExactCursor(undefined)).toBe(0);
    expect(() => decodeKnowledgeExactCursor("not+base64"))
      .toThrowError(expect.objectContaining({ code: "knowledge_exact_cursor_invalid" }));
    expect(decodeKnowledgeHierarchicalQuery("  хранить материалы  ")).toBe("хранить материалы");
    expect(decodeKnowledgeHierarchicalLimit(10)).toBe(10);
    expect(() => decodeKnowledgeHierarchicalLimit(0))
      .toThrowError(expect.objectContaining({ code: "knowledge_index_query_invalid" }));
  });
});
