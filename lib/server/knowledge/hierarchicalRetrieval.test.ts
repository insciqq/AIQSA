import { describe, expect, it } from "vitest";
import {
  decodeKnowledgeExactCursor,
  decodeKnowledgeHierarchicalLimit,
  decodeKnowledgeHierarchicalQuery,
  decodeKnowledgeHierarchicalScope,
  decodeKnowledgeSafeRegex,
  encodeKnowledgeExactCursor,
  KNOWLEDGE_EXACT_CURSOR_MAX_OFFSET,
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

  it("keeps admitted-run authority distinct from owner-only maintenance scope", () => {
    expect(decodeKnowledgeHierarchicalScope({
      runId: "run-1",
      scopeKind: "admitted_run",
      sourceArtifactIds: ["artifact-2", "artifact-1", "artifact-2"],
      userId: "user-1"
    })).toEqual({
      runId: "run-1",
      scopeKind: "admitted_run",
      sourceArtifactIds: ["artifact-2", "artifact-1"],
      userId: "user-1"
    });
    expect(() => decodeKnowledgeHierarchicalScope({
      runId: "",
      scopeKind: "admitted_run",
      sourceArtifactIds: ["artifact-1"],
      userId: "user-1"
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
    expect(decodeKnowledgeExactCursor(
      encodeKnowledgeExactCursor(KNOWLEDGE_EXACT_CURSOR_MAX_OFFSET)
    )).toBe(KNOWLEDGE_EXACT_CURSOR_MAX_OFFSET);
    expect(decodeKnowledgeExactCursor(undefined)).toBe(0);
    expect(() => encodeKnowledgeExactCursor(KNOWLEDGE_EXACT_CURSOR_MAX_OFFSET + 1))
      .toThrowError(expect.objectContaining({ code: "knowledge_exact_cursor_invalid" }));
    expect(() => decodeKnowledgeExactCursor("not+base64"))
      .toThrowError(expect.objectContaining({ code: "knowledge_exact_cursor_invalid" }));
    expect(decodeKnowledgeHierarchicalQuery("  хранить материалы  ")).toBe("хранить материалы");
    expect(decodeKnowledgeHierarchicalLimit(10)).toBe(10);
    expect(() => decodeKnowledgeHierarchicalLimit(0))
      .toThrowError(expect.objectContaining({ code: "knowledge_index_query_invalid" }));
  });
});
