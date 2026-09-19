import { describe, expect, it } from "vitest";
import type { DecisionResult } from "../providers/decisions";
import { buildMcpDecisionPlan, mcpDecisionSelection } from "./decisionPolicy";

function fixture() {
  return { activeToolNames: new Set<string>(), limit: 2, goals: ["Read the supplied record"],
    context: { currentText: "The record key is supplied", messages: [] },
    catalog: { version: 1 as const, servers: [{ serverId: "private-server-identity", revisionId: "private-revision-identity",
      namespace: "records", serverName: "Records", description: "Read-only records", tools: [
        { namespacedName: "records__read", originalName: "read", description: "Read by key" },
        { namespacedName: "records__find", originalName: "find", description: "Find a key" }
      ] }] } };
}
function result(choice: string, confidence: number | null): DecisionResult {
  return { model: "fixture", provider: "fixture", requestId: null,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    answers: { route: { type: "choice", choice, confidence, probabilities: null } } };
}

describe("optional single-capability MCP selection", () => {
  it("uses only the reviewed router disclosure and retains every requested goal", () => {
    const input = { ...fixture(), goals: ["Read the record", "Explain its state"] };
    const plan = buildMcpDecisionPlan(input)!;
    expect(plan.request.state).toMatchObject({ goals: input.goals, current_user_text: input.context.currentText });
    expect(JSON.stringify(plan.request)).not.toContain("private-server-identity");
    expect(JSON.stringify(plan.request)).not.toContain("private-revision-identity");
    expect([...plan.namesByChoice.values()]).toEqual(["records__read", "records__find"]);
  });

  it("excludes active tools before disclosure and skips empty/exhausted catalogs", () => {
    const input = fixture(); input.activeToolNames.add("records__read");
    const plan = buildMcpDecisionPlan(input)!;
    expect([...plan.namesByChoice.values()]).toEqual(["records__find"]);
    expect(mcpDecisionSelection(plan, result("t0", 0.99))).toEqual(["records__find"]);
    input.activeToolNames.add("records__find");
    expect(buildMcpDecisionPlan(input)).toBeNull();
    expect(buildMcpDecisionPlan({ ...fixture(), limit: 0 })).toBeNull();
  });

  it.each([null, 0.94, NaN, Infinity, 1.1])("keeps baseline for uncertain/invalid confidence %s", confidence => {
    const plan = buildMcpDecisionPlan(fixture())!;
    expect(mcpDecisionSelection(plan, result("t0", confidence))).toBeNull();
  });

  it("never manufactures names or accepts baseline/extra decisions as a fast route", () => {
    const plan = buildMcpDecisionPlan(fixture())!;
    for (const choice of ["baseline", "unknown", "records__read"]) {
      expect(mcpDecisionSelection(plan, result(choice, 1))).toBeNull();
    }
    const output = result("t0", 0.99);
    expect(mcpDecisionSelection(plan, { ...output, answers: { ...output.answers, extra: { type: "noul", noul: 1 } } })).toBeNull();
    expect(mcpDecisionSelection(plan, result("t0", 0.95))).toEqual(["records__read"]);
  });
});
