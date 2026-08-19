import { describe, expect, it } from "vitest";
import {
  decodeKnowledgePlannerPlan,
  KNOWLEDGE_PLANNER_VERSION,
  planKnowledgeRequest,
  type KnowledgePlannerInput
} from "./planner";

function input(overrides: Partial<KnowledgePlannerInput> = {}): KnowledgePlannerInput {
  return {
    bases: [{
      approxTokens: 30_000,
      knowledgeBaseId: "base-1",
      passageCount: 42,
      readySourceCount: 2,
      sourceCount: 2
    }],
    conversation: [],
    modelCapabilities: { contextWindow: 128_000, toolCalling: true },
    originalQuery: "What is the retention policy?",
    scopeRequested: true,
    version: KNOWLEDGE_PLANNER_VERSION,
    ...overrides
  };
}

describe("Knowledge planner", () => {
  it("covers every required intent with a versioned decodable plan", async () => {
    const cases: Array<[string, KnowledgePlannerInput, string]> = [
      ["no_knowledge_needed", input({ originalQuery: "Спасибо!" }), "none"],
      ["fact_lookup", input(), "focused"],
      ["exact_lookup", input({ originalQuery: "Find exact code API-2048 on 2026-08-18" }), "focused"],
      ["single_source_summary", input({
        bases: [{
          approxTokens: 30_000,
          knowledgeBaseId: "base-1",
          passageCount: 30,
          readySourceCount: 1,
          sourceCount: 1
        }],
        originalQuery: "Summarize this source"
      }), "corpus_summary"],
      ["multi_source_comparison", input({ originalQuery: "Compare Alpha and Beta" }), "comparison"],
      ["exhaustive_corpus_search", input({ originalQuery: "List every incident in the entire corpus" }), "exhaustive"],
      ["corpus_summary", input({ originalQuery: "Give me an overview of the knowledge base" }), "corpus_summary"],
      ["multi_hop_reasoning", input({ originalQuery: "Who approved it; then when did it ship?" }), "multi_pass"],
      ["structured_data_analysis", input({ originalQuery: "Calculate the median of the CSV column" }), "structured_data"],
      ["source_discovery", input({ originalQuery: "Which document describes retention?" }), "focused"],
      ["follow_up_reference", input({
        conversation: [{ role: "user", text: "Tell me about the launch" }],
        originalQuery: "And when?"
      }), "focused"]
    ];

    for (const [intent, plannerInput, strategy] of cases) {
      const plan = await planKnowledgeRequest(plannerInput);
      expect(plan).toMatchObject({ intent, strategy, version: 1 });
      expect(decodeKnowledgePlannerPlan(plan)).toEqual({ ok: true, plan });
    }

    const mixed = await planKnowledgeRequest(input({
      originalQuery: "Compare all exact occurrences of API-2048 and API-4096"
    }));
    expect(mixed.intent).toBe("mixed");
    expect(mixed.strategy).toBe("multi_pass");
  });

  it("preserves quoted terms, names, codes, and dates through follow-up rewrite", async () => {
    const originalQuery = "And what did “North Star” say about API-2048 on 2026-08-18?";
    const plan = await planKnowledgeRequest(input({
      conversation: [
        { role: "user", text: "Review the launch decision" },
        { role: "assistant", text: "It was approved conditionally." }
      ],
      originalQuery
    }));

    expect(plan.intent).toBe("follow_up_reference");
    expect(plan.rewrite.exactTerms).toEqual(expect.arrayContaining([
      "“North Star”",
      "API-2048",
      "2026-08-18"
    ]));
    for (const term of plan.rewrite.exactTerms) {
      expect(plan.rewrite.query).toContain(term);
    }
    expect(plan.rewrite.query).toContain("Review the launch decision");
    expect(plan.originalQuery).toBe(originalQuery);
  });

  it.each([
    "Find Revenue outliers",
    "Show the Revenue trend over Closed at",
    "Join Sales and People by Key",
    "Проверь формулы на листе Sales"
  ])("routes structured operation wording through the structured lane: %s", async (originalQuery) => {
    await expect(planKnowledgeRequest(input({ originalQuery }))).resolves.toMatchObject({
      intent: "structured_data_analysis",
      strategy: "structured_data"
    });
  });

  it("does not retrieve again for an explicit transformation of the previous answer", async () => {
    const plan = await planKnowledgeRequest(input({
      conversation: [{ role: "assistant", text: "A grounded answer." }],
      originalQuery: "Перефразируй предыдущий ответ"
    }));

    expect(plan).toMatchObject({
      automaticRetrieval: false,
      intent: "no_knowledge_needed",
      strategy: "none",
      subqueries: []
    });
  });

  it("preserves a Knowledge-dependent intent when the selected scope has no ready bindings", async () => {
    const plan = await planKnowledgeRequest(input({ bases: [] }));

    expect(plan).toMatchObject({
      automaticRetrieval: false,
      intent: "fact_lookup",
      strategy: "none",
      subqueries: []
    });
    expect(decodeKnowledgePlannerPlan(plan)).toEqual({ ok: true, plan });
  });

  it("selects bounded full context only for one fully ready small source", async () => {
    const plan = await planKnowledgeRequest(input({
      bases: [{
        approxTokens: 1_200,
        knowledgeBaseId: "base-small",
        passageCount: 6,
        readySourceCount: 1,
        sourceCount: 1
      }],
      modelCapabilities: { contextWindow: 16_000, toolCalling: false },
      originalQuery: "Summarize this source"
    }));

    expect(plan).toMatchObject({
      automaticRetrieval: true,
      coverage: { expectedPassageCount: 6, mode: "verified_only" },
      evidenceMode: "fuller",
      intent: "single_source_summary",
      strategy: "full_context"
    });
  });

  it("partitions comparison targets within the admitted subquery budget without dropping a target", async () => {
    const plan = await planKnowledgeRequest(input({
      budgetPolicy: { maxSubqueriesPerPhase: 2 },
      originalQuery: "Compare Alpha and Beta and Gamma and Delta"
    }));

    expect(plan.intent).toBe("multi_source_comparison");
    expect(plan.subqueries).toHaveLength(2);
    expect(plan.coverage.namedTargets).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
    expect(plan.subqueries.flatMap((query) => query.targetNames).sort()).toEqual(
      ["Alpha", "Beta", "Delta", "Gamma"]
    );
  });

  it("uses the snapshotted profile budget instead of a hidden eight-branch ceiling", async () => {
    const plan = await planKnowledgeRequest(input({
      budgetPolicy: { maxSubqueriesPerPhase: 10 },
      originalQuery: [
        "Find alpha",
        "find beta",
        "find gamma",
        "find delta",
        "find epsilon",
        "find zeta",
        "find eta",
        "find theta",
        "find iota",
        "find kappa"
      ].join("; ")
    }));

    expect(plan.intent).toBe("multi_hop_reasoning");
    expect(plan.subqueries).toHaveLength(10);
    expect(decodeKnowledgePlannerPlan(plan)).toEqual({ ok: true, plan });
  });

  it("keeps comma-separated mixed comparison targets and exhaustive qualification", async () => {
    const plan = await planKnowledgeRequest(input({
      originalQuery: "Compare Alpha, Beta, Gamma and Delta by every exact exception"
    }));

    expect(plan).toMatchObject({
      coverage: {
        mode: "verified_only",
        namedTargets: ["Alpha", "Beta", "Gamma", "Delta"]
      },
      intent: "mixed",
      strategy: "multi_pass"
    });
    expect(plan.subqueries.flatMap((query) => query.targetNames).sort()).toEqual(
      ["Alpha", "Beta", "Delta", "Gamma"]
    );
  });

  it("does not mistake a quoted comparison dimension for another target", async () => {
    const plan = await planKnowledgeRequest(input({
      originalQuery: "Compare “Alpha” and “Beta” by “termination clause”"
    }));

    expect(plan.coverage.namedTargets).toEqual(["Alpha", "Beta"]);
  });

  it("marks exhaustive coverage as verified-only instead of asserting completeness", async () => {
    const plan = await planKnowledgeRequest(input({
      originalQuery: "Find every exception without omissions"
    }));

    expect(plan).toMatchObject({
      coverage: { expectedPassageCount: null, mode: "verified_only" },
      intent: "exhaustive_corpus_search",
      strategy: "exhaustive"
    });
  });

  it("falls back deterministically and truthfully when an optional classifier fails", async () => {
    const plannerInput = input({ originalQuery: "What is the retention policy?" });
    const first = await planKnowledgeRequest(plannerInput, {
      classifier: { classify: async () => { throw new Error("offline"); } }
    });
    const second = await planKnowledgeRequest(plannerInput, {
      classifier: { classify: async () => { throw new Error("offline again"); } }
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      failureCode: "classifier_unavailable",
      intent: "fact_lookup",
      status: "degraded",
      strategy: "focused"
    });
    expect(decodeKnowledgePlannerPlan(first)).toEqual({ ok: true, plan: first });
  });

  it("rejects malformed persisted plans", async () => {
    const plan = await planKnowledgeRequest(input({
      originalQuery: "Find exact code API-2048"
    }));
    expect(decodeKnowledgePlannerPlan({
      ...plan,
      coverage: { ...plan.coverage, mode: "complete" }
    })).toEqual({ ok: false });
    expect(decodeKnowledgePlannerPlan({
      ...plan,
      rewrite: { ...plan.rewrite, query: "dropped exact terms" }
    })).toEqual({ ok: false });
  });
});
