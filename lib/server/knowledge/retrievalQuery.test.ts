import { describe, expect, it } from "vitest";
import { validateKnowledgeToolArguments } from "./retrievalQuery";

describe("Knowledge retrieval query validation", () => {
  it("normalizes one bounded generated query", () => {
    expect(validateKnowledgeToolArguments({ query: "  release\n notes\t2026  " })).toEqual({
      ok: true,
      query: "release notes 2026"
    });
  });

  it.each([
    [null, "knowledge_query_arguments_invalid"],
    [{ query: "ok", baseId: "private" }, "knowledge_query_arguments_invalid"],
    [{ query: "" }, "knowledge_query_required"],
    [{ query: "x".repeat(501) }, "knowledge_query_too_long"]
  ])("rejects %j before execution", (value, code) => {
    expect(validateKnowledgeToolArguments(value)).toEqual({ code, ok: false });
  });
});
