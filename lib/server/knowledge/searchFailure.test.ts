import { describe, expect, it } from "vitest";
import { decodeKnowledgeCoverageLimitationsV1, KnowledgeSearchFailure, knowledgeSearchFailureToolResult } from "./searchFailure";
import { OpenSearchTransportError } from "../search/opensearch/coreTransport";

describe("safe Knowledge search failure projection", () => {
  it.each(["knowledge_search_projection_incomplete", "opensearch_timeout", "opensearch_connection_failed",
    "opensearch_rate_limited", "opensearch_authentication_failed", "opensearch_configuration_invalid", "opensearch_index_incompatible"] as const)(
    "retains %s and only a hash of the accepted scope", (code) => {
      const result = knowledgeSearchFailureToolResult({ id: "call-1", name: "search_knowledge",
        arguments: { query: "PRIVATE_QUERY", source: "PRIVATE_SOURCE" } }, new KnowledgeSearchFailure(code, "a".repeat(64)));
      expect(result).toMatchObject({ callId: "call-1", status: "error", rawPreview: { knowledgeFailure: {
        code, mappingVersion: 1, scopeFingerprint: "a".repeat(64), version: 1
      } } });
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_QUERY|PRIVATE_SOURCE|arguments|credentials|password/u);
      expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("Knowledge search") }]);
    }
  );
  it("does not persist arbitrary provider bodies or code-shaped private strings", () => {
    const call = { id: "call-1", name: "search_knowledge", arguments: {} };
    for (const error of [new Error("private_secret_value"), new Error("Bearer PRIVATE_TOKEN"), { code: "opensearch_timeout" }]) {
      expect(knowledgeSearchFailureToolResult(call, error)).toMatchObject({ rawPreview: { knowledgeFailure: { code: "knowledge_retrieval_failed" } } });
    }
    expect(knowledgeSearchFailureToolResult(call, new OpenSearchTransportError("opensearch_authentication_failed")))
      .toMatchObject({ rawPreview: { knowledgeFailure: { code: "opensearch_authentication_failed" } } });
  });
  it("retains the bounded SQL timeout classification without its underlying query or cause", () => {
    const result = knowledgeSearchFailureToolResult({ id: "call-1", name: "search_knowledge", arguments: {} },
      new Error("knowledge_retrieval_query_timed_out", { cause: new Error("PRIVATE_DATABASE_QUERY") }));
    expect(result).toMatchObject({ status: "error", rawPreview: { knowledgeFailure: {
      code: "knowledge_retrieval_query_timed_out", stage: "search", version: 1
    } } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_DATABASE_QUERY");
  });
  it("rejects malformed or private coverage limitations", () => {
    const valid = { excludedResources: 1, retrievalFailures: ["opensearch_timeout"], version: 1 };
    expect(decodeKnowledgeCoverageLimitationsV1(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
    for (const value of [{ ...valid, excludedResources: -1 }, { ...valid, excludedResources: 1.5 },
      { ...valid, sourceIds: ["PRIVATE"] }, { ...valid, retrievalFailures: ["PRIVATE"] },
      { ...valid, retrievalFailures: ["opensearch_timeout", "opensearch_timeout"] }]) {
      expect(decodeKnowledgeCoverageLimitationsV1(value)).toBeNull();
    }
  });
});
