import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  KnowledgePlannerPlanV2,
  KnowledgePlannerStrategy,
  KnowledgePlannerSubqueryV2
} from "./planner";
import type { KnowledgeAcceptedSourceTupleV1 } from "./knowledgeStrategyExecution";
import { prepareKnowledgeStrategyExecutionV1 } from "./knowledgeStrategyPlan";
import { createKnowledgeToolExecutor } from "./toolExecutor";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function source(ordinal: number, passageCount = 1): KnowledgeAcceptedSourceTupleV1 {
  return {
    bindingId: `binding-${ordinal}`,
    hierarchicalArtifactId: `hierarchy-${ordinal}`,
    hierarchicalChecksum: digest(`hierarchy-${ordinal}`),
    ordinal,
    passageCount,
    sourceAlias: `S${ordinal + 1}`,
    sourceArtifactId: `artifact-${ordinal}`,
    sourceId: `00000000-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`,
    sourceVersionId: `version-${ordinal}`,
    sourceVersionNumber: 1,
    version: 1
  };
}

function subquery(
  ordinal: number,
  query = `question ${ordinal}`
): KnowledgePlannerSubqueryV2 {
  return {
    exact: null,
    exactTerms: [],
    lanes: ["lexical"],
    operation: "automatic_search",
    ordinal,
    purpose: ordinal === 0 ? "answer" : "follow_up",
    query,
    targetNames: [],
    targetResolution: null,
    targetSourceIds: []
  };
}

function plan(
  strategy: KnowledgePlannerStrategy,
  subqueries: readonly KnowledgePlannerSubqueryV2[] = [subquery(0)]
): KnowledgePlannerPlanV2 {
  return {
    automaticRetrieval: strategy !== "none",
    coverage: {
      expectedPassageCount: strategy === "full_context" ? 65 : null,
      mode: strategy === "full_context" || strategy === "exhaustive"
        ? "verified_only"
        : "partial",
      namedTargets: []
    },
    evidenceMode: "compact",
    intent: strategy === "corpus_summary" ? "corpus_summary" :
      strategy === "comparison" ? "multi_source_comparison" :
        strategy === "exhaustive" ? "exhaustive_corpus_search" :
          strategy === "multi_pass" ? "multi_hop_reasoning" : "fact_lookup",
    originalQuery: "original question",
    rewrite: { exactTerms: [], query: "rewritten question" },
    status: "ready",
    strategy,
    subqueries,
    targetResolution: null,
    targetSourceIds: [],
    version: 2
  };
}

function calls(count: number) {
  return Array.from({ length: count }, (_, ordinal) => ({
    id: `tool-call-${ordinal}`,
    ordinal
  }));
}

describe("H4 measured strategy planning", () => {
  it("prepares and reuses the frozen ledger before the first strategy read", async () => {
    const strategyPlan = plan("full_context");
    const createExecution = vi.fn(async (input: Readonly<{ execution: unknown }>) => ({
      execution: { execution: input.execution },
      kind: "created" as const
    }));
    const prepareStrategySession = vi.fn(async () => ({ id: "retrieval-session-1" }));
    const loadStrategySources = vi.fn(async () => [source(0, 1)]);
    const executor = createKnowledgeToolExecutor({
      embeddingRuntime: { resolve: vi.fn() },
      store: {
        hybridSearch: vi.fn(),
        loadBindings: vi.fn(),
        loadStrategySources,
        prepareStrategySession
      } as never,
      strategies: { createExecution } as never
    });

    const prepared = await executor.prepareStrategy!({
      calls: calls(1),
      plan: strategyPlan,
      runId: "run-1",
      userId: "owner-1"
    });

    expect(prepared).toEqual({
      executionId: expect.stringMatching(/^strategy-[0-9a-f]{64}$/u),
      strategy: "full_context"
    });
    expect(prepareStrategySession).toHaveBeenCalledWith({
      runId: "run-1",
      userId: "owner-1"
    });
    expect(createExecution).toHaveBeenCalledWith(expect.objectContaining({
      retrievalSessionId: "retrieval-session-1",
      toolCallBindings: [{
        modelRunToolCallId: "tool-call-0",
        stepId: expect.stringMatching(/^strategy-step-/u)
      }]
    }));
  });

  it("rejects full-context scopes beyond the reachable one-Source bound", () => {
    expect(() => prepareKnowledgeStrategyExecutionV1({
      calls: calls(1),
      executionId: "execution-full-context-large",
      modelRunId: "run-1",
      pageSize: 64,
      plan: plan("full_context"),
      sources: [source(0, 9)]
    })).toThrow("knowledge_strategy_full_context_scope_invalid");

    expect(() => prepareKnowledgeStrategyExecutionV1({
      calls: calls(1),
      executionId: "execution-full-context-multiple",
      modelRunId: "run-1",
      pageSize: 64,
      plan: plan("full_context"),
      sources: [source(0, 4), source(1, 4)]
    })).toThrow("knowledge_strategy_full_context_scope_invalid");
  });

  it("binds each comparison target to its own Source-local ToolCall", () => {
    const sources = [source(0), source(1)];
    const targetResolution = {
      outcome: "resolved_many" as const,
      targetSourceIds: sources.map(({ sourceId }) => sourceId),
      targets: sources.map((entry, ordinal) => ({
        candidateSourceIds: [entry.sourceId],
        matchKind: "alias" as const,
        outcome: "resolved" as const,
        targetName: entry.sourceAlias
      }))
    };
    const subqueries = sources.map((entry, ordinal): KnowledgePlannerSubqueryV2 => ({
      ...subquery(ordinal, `compare ${entry.sourceAlias}`),
      purpose: "compare_target",
      targetNames: [entry.sourceAlias],
      targetResolution: {
        outcome: "resolved",
        targetSourceIds: [entry.sourceId],
        targets: [targetResolution.targets[ordinal]!]
      },
      targetSourceIds: [entry.sourceId]
    }));
    const comparisonPlan = {
      ...plan("comparison", subqueries),
      targetResolution,
      targetSourceIds: targetResolution.targetSourceIds
    };
    const prepared = prepareKnowledgeStrategyExecutionV1({
      calls: calls(2),
      executionId: "execution-comparison",
      modelRunId: "run-1",
      plan: comparisonPlan,
      sources
    });

    expect(prepared?.steps.map(({ modelRunToolCallId, template }) => ({
      dimension: template.comparisonDimensionHash,
      modelRunToolCallId,
      sourceBindingId: template.sourceBindingId,
      targetOrdinal: template.targetOrdinal
    }))).toEqual([
      {
        dimension: prepared!.execution.config.kind === "comparison"
          ? prepared!.execution.config.dimensionHash
          : null,
        modelRunToolCallId: "tool-call-0",
        sourceBindingId: "binding-0",
        targetOrdinal: 0
      },
      {
        dimension: prepared!.execution.config.kind === "comparison"
          ? prepared!.execution.config.dimensionHash
          : null,
        modelRunToolCallId: "tool-call-1",
        sourceBindingId: "binding-1",
        targetOrdinal: 1
      }
    ]);
  });

  it("creates one map receipt per Source before a single corpus reduce", () => {
    const sources = Array.from({ length: 50 }, (_, ordinal) => source(ordinal));
    const prepared = prepareKnowledgeStrategyExecutionV1({
      calls: calls(1),
      executionId: "execution-summary",
      modelRunId: "run-1",
      plan: plan("corpus_summary"),
      sources
    });

    const maps = prepared!.steps.filter(({ template }) =>
      template.kind === "corpus_summary_map");
    const reduce = prepared!.steps.find(({ template }) =>
      template.kind === "corpus_summary_reduce");
    expect(maps).toHaveLength(50);
    expect(reduce?.modelRunToolCallId).toBe("tool-call-0");
    expect(reduce?.template.materializationMode).toBe("evidence_from_prerequisites");
    expect(prepared?.dependencies.filter(({ dependentStepId }) =>
      dependentStepId === reduce?.template.stepId)).toHaveLength(50);
  });

  it("freezes exhaustive pagination without pretending the first page is complete", () => {
    const prepared = prepareKnowledgeStrategyExecutionV1({
      calls: calls(1),
      executionId: "execution-exhaustive",
      modelRunId: "run-1",
      pageSize: 64,
      plan: plan("exhaustive"),
      sources: [source(0, 129)]
    });

    expect(prepared?.steps.map(({ modelRunToolCallId, template }) => [
      template.pageOrdinal,
      template.materializationMode,
      modelRunToolCallId
    ])).toEqual([
      [0, "complete", null],
      [1, "cursor_from_predecessor", null],
      [2, "cursor_from_predecessor", "tool-call-0"]
    ]);
    expect(prepared?.dependencies).toHaveLength(2);
  });

  it("freezes one bound root followed by a bound linear evidence chain", () => {
    const prepared = prepareKnowledgeStrategyExecutionV1({
      calls: calls(3),
      executionId: "execution-multi-hop",
      modelRunId: "run-1",
      plan: plan("multi_pass", [
        subquery(0, "first fact"),
        subquery(1, "second fact"),
        subquery(2, "third fact")
      ]),
      sources: [source(0)]
    });

    expect(prepared?.steps.map(({ modelRunToolCallId, template }) => ({
      kind: template.kind,
      materializationMode: template.materializationMode,
      modelRunToolCallId
    }))).toEqual([
      {
        kind: "multi_hop_root",
        materializationMode: "complete",
        modelRunToolCallId: "tool-call-0"
      },
      {
        kind: "multi_hop_follow_up",
        materializationMode: "evidence_from_prerequisites",
        modelRunToolCallId: "tool-call-1"
      },
      {
        kind: "multi_hop_follow_up",
        materializationMode: "evidence_from_prerequisites",
        modelRunToolCallId: "tool-call-2"
      }
    ]);
    expect(prepared?.dependencies).toHaveLength(2);
    expect(prepared?.dependencies).toEqual([
      expect.objectContaining({
        dependentStepId: prepared?.steps[1]?.template.stepId,
        prerequisiteStepId: prepared?.steps[0]?.template.stepId
      }),
      expect.objectContaining({
        dependentStepId: prepared?.steps[2]?.template.stepId,
        prerequisiteStepId: prepared?.steps[1]?.template.stepId
      })
    ]);
  });

  it("leaves focused retrieval outside the measured-strategy ledger", () => {
    expect(prepareKnowledgeStrategyExecutionV1({
      calls: calls(1),
      executionId: "execution-focused",
      modelRunId: "run-1",
      plan: plan("focused"),
      sources: [source(0)]
    })).toBeNull();
  });

  it("rejects missing or duplicated ToolCall identities before persistence", () => {
    expect(() => prepareKnowledgeStrategyExecutionV1({
      calls: [{ id: "same-call", ordinal: 0 }, { id: "same-call", ordinal: 1 }],
      executionId: "execution-invalid",
      modelRunId: "run-1",
      plan: plan("multi_pass", [subquery(0), subquery(1)]),
      sources: [source(0)]
    })).toThrow("knowledge_strategy_tool_call_identity_invalid");
  });
});
