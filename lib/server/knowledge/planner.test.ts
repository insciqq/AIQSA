import { describe, expect, it } from "vitest";
import {
  decodeKnowledgePlannerPlan,
  KNOWLEDGE_PLANNER_VERSION,
  planKnowledgeRequest,
  plannerAutomaticOperation,
  type KnowledgePlannerInput
} from "./planner";

const alphaId = "11111111-1111-4111-8111-111111111111";
const betaId = "22222222-2222-4222-8222-222222222222";
const gammaId = "33333333-3333-4333-8333-333333333333";
const deltaId = "44444444-4444-4444-8444-444444444444";

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
    directSources: [],
    modelCapabilities: { contextWindow: 128_000, toolCalling: true },
    originalQuery: "What is the retention policy?",
    scopeRequested: true,
    sources: [{
      fileName: "Alpha.pdf",
      sourceAlias: "S1",
      sourceId: alphaId,
      sourceName: "Alpha",
      versionNumber: 1
    }, {
      fileName: "Beta.pdf",
      sourceAlias: "S2",
      sourceId: betaId,
      sourceName: "Beta",
      versionNumber: 1
    }, {
      fileName: "Gamma.pdf",
      sourceAlias: "S3",
      sourceId: gammaId,
      sourceName: "Gamma",
      versionNumber: 1
    }, {
      fileName: "Delta.pdf",
      sourceAlias: "S4",
      sourceId: deltaId,
      sourceName: "Delta",
      versionNumber: 1
    }],
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
      expect(plan).toMatchObject({ intent, strategy, version: KNOWLEDGE_PLANNER_VERSION });
      expect(decodeKnowledgePlannerPlan(plan)).toEqual({ ok: true, plan });
      for (const subquery of plan.subqueries) {
        expect(plannerAutomaticOperation(plan, subquery)).toMatchObject({
          coverage: {
            expectedPassageCount: plan.coverage.expectedPassageCount,
            mode: plan.coverage.mode
          },
          operation: expect.any(String),
          phaseOrdinal: 0,
          plannerVersion: KNOWLEDGE_PLANNER_VERSION,
          strategy: plan.strategy,
          subqueryOrdinal: subquery.ordinal,
          targetSourceIds: subquery.targetSourceIds
        });
      }
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

  it("preserves uppercase Cyrillic codes without reducing them to the numeric suffix", async () => {
    const plan = await planKnowledgeRequest(input({
      originalQuery: "Найди код РЕЛИЗ-2048 от 18.08.2026"
    }));

    expect(plan.rewrite.exactTerms).toEqual(expect.arrayContaining([
      "РЕЛИЗ-2048",
      "18.08.2026"
    ]));
    expect(plan.rewrite.exactTerms).not.toContain("2048");
    expect(decodeKnowledgePlannerPlan(plan)).toEqual({ ok: true, plan });
  });

  it("emits a fully specified find_exact operation only when match semantics are structural", async () => {
    const plannerInput = input();
    const plan = await planKnowledgeRequest(input({
      originalQuery: "Find exact phrase \"retention period\" in \"Alpha Policy.pdf\"",
      sources: plannerInput.sources.map((source) => source.sourceId === alphaId
        ? { ...source, fileName: "Alpha Policy.pdf", sourceName: "Alpha Policy" }
        : source)
    }));

    expect(plan).toMatchObject({
      targetResolution: {
        outcome: "resolved",
        targetSourceIds: [alphaId]
      },
      targetSourceIds: [alphaId]
    });
    expect(plan.subqueries).toEqual([expect.objectContaining({
      exact: {
        caseMode: "insensitive",
        field: "body",
        match: "phrase",
        value: "retention period"
      },
      lanes: ["exact"],
      operation: "find_exact",
      targetNames: ["Alpha Policy.pdf"],
      targetSourceIds: [alphaId]
    })]);
    expect(plannerAutomaticOperation(plan, plan.subqueries[0]!)).toMatchObject({
      exact: {
        caseMode: "insensitive",
        cursor: null,
        field: "body",
        limit: 50,
        match: "phrase",
        value: "retention period"
      },
      operation: "find_exact",
      plannerVersion: KNOWLEDGE_PLANNER_VERSION,
      targetSourceIds: [alphaId]
    });
    expect(decodeKnowledgePlannerPlan(plan)).toEqual({ ok: true, plan });
  });

  it("does not mistake an admitted alias or dated filename for a body exact-match intent", async () => {
    const aliasSummary = await planKnowledgeRequest(input({ originalQuery: "Summarize S1" }));
    const datedSummary = await planKnowledgeRequest(input({
      originalQuery: "Summarize Release Notes 2026-08-18.pdf",
      sources: [{
        fileName: "Release Notes 2026-08-18.pdf",
        sourceAlias: "S1",
        sourceId: alphaId,
        sourceName: "Release Notes",
        versionNumber: 1
      }]
    }));

    for (const plan of [aliasSummary, datedSummary]) {
      expect(plan).toMatchObject({ intent: "single_source_summary" });
      expect(plan.subqueries[0]).toMatchObject({ operation: "automatic_search" });
      expect(decodeKnowledgePlannerPlan(plan)).toEqual({ ok: true, plan });
    }
    expect(aliasSummary.targetSourceIds).toEqual([alphaId]);
    expect(datedSummary.rewrite.exactTerms).toContain("2026-08-18");
    expect(datedSummary.targetSourceIds).toEqual([alphaId]);
  });

  it("keeps mixed exact terms on automatic search instead of inventing one match mode", async () => {
    const plan = await planKnowledgeRequest(input({
      originalQuery: "Find exact code API-2048 on 2026-08-18"
    }));

    expect(plan.subqueries[0]).toMatchObject({
      exact: null,
      operation: "automatic_search"
    });
    expect(plan.rewrite.exactTerms).toEqual(expect.arrayContaining(["API-2048", "2026-08-18"]));
  });

  it("persists explicit regex match semantics without rewriting the pattern", async () => {
    const plan = await planKnowledgeRequest(input({
      originalQuery: "Find exact regex /API-\\d{4}/ case-sensitive in Alpha.pdf"
    }));

    expect(plan.rewrite.exactTerms).toContain("/API-\\d{4}/");
    expect(plan.subqueries[0]).toMatchObject({
      exact: {
        caseMode: "sensitive",
        field: "body",
        match: "pattern",
        value: "API-\\d{4}"
      },
      operation: "find_exact"
    });
    expect(decodeKnowledgePlannerPlan(plan)).toEqual({ ok: true, plan });
  });

  it.each([
    "Find Revenue outliers in Alpha.pdf",
    "Show the Revenue trend over Closed at in Alpha.pdf",
    "Join Sales and People by Key in Alpha.pdf",
    "Проверь формулы на листе Sales в Alpha.pdf"
  ])("routes structured operation wording through the structured lane: %s", async (originalQuery) => {
    const plan = await planKnowledgeRequest(input({ originalQuery }));
    expect(plan).toMatchObject({
      intent: "structured_data_analysis",
      strategy: "structured_data"
    });
    expect(plan.subqueries[0]).toMatchObject({ lanes: [], operation: "structured_analysis" });
    expect(plannerAutomaticOperation(plan, plan.subqueries[0]!)).toMatchObject({
      structured: {
        query: plan.subqueries[0]!.query,
        selector: {
          columns: [],
          includeHidden: false,
          operation: null,
          range: null,
          sheet: null
        },
        targetSourceIds: plan.subqueries[0]!.targetSourceIds
      }
    });
  });

  it.each([
    "Покажи динамику по холестерину в Alpha.pdf и Beta.pdf",
    "Рассчитай динамику по холестерину в Alpha.pdf и Beta.pdf"
  ])("does not infer spreadsheet semantics from Russian dynamics across PDFs: %s", async (originalQuery) => {
    const plan = await planKnowledgeRequest(input({
      originalQuery
    }));

    expect(plan).toMatchObject({ intent: "fact_lookup", strategy: "focused" });
    expect(plan.subqueries[0]).toMatchObject({ operation: "automatic_search" });
  });

  it("uses the explicit visual operation without pretending it is a text lane", async () => {
    const plan = await planKnowledgeRequest(input({
      originalQuery: "What does the diagram in Alpha.pdf show?"
    }));

    expect(plan.subqueries[0]).toMatchObject({
      lanes: [],
      operation: "visual_analysis",
      targetSourceIds: [alphaId]
    });
    expect(plannerAutomaticOperation(plan, plan.subqueries[0]!)).toMatchObject({
      visual: {
        query: plan.subqueries[0]!.query,
        selector: null,
        targetSourceIds: [alphaId]
      }
    });
  });

  it("keeps source discovery metadata-only", async () => {
    const plan = await planKnowledgeRequest(input({
      originalQuery: "Which document describes retention?"
    }));

    expect(plan.subqueries).toEqual([expect.objectContaining({
      exact: null,
      exactTerms: [],
      lanes: ["metadata"],
      operation: "discover_sources",
      purpose: "source_discovery",
      targetSourceIds: []
    })]);
    expect(plannerAutomaticOperation(plan, plan.subqueries[0]!)).toMatchObject({
      discovery: {
        cursor: null,
        fields: ["filename", "heading", "source_name", "tag", "title"],
        limit: 50,
        query: plan.subqueries[0]!.query
      },
      operation: "discover_sources"
    });
  });

  it("clarifies an unnamed multi-Source structured scope before analysis", async () => {
    const plan = await planKnowledgeRequest(input({ originalQuery: "Find Revenue outliers" }));

    expect(plan).toMatchObject({
      intent: "structured_data_analysis",
      targetResolution: { outcome: "ambiguous", targetSourceIds: [] }
    });
    expect(plan.subqueries).toEqual([expect.objectContaining({
      lanes: ["metadata"],
      operation: "discover_sources",
      purpose: "source_discovery",
      targetNames: ["unspecified source"],
      targetSourceIds: []
    })]);
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

  it("preserves intent but performs no retrieval when a selected Base has no ready Source", async () => {
    const plan = await planKnowledgeRequest(input({
      bases: [{
        approxTokens: null,
        knowledgeBaseId: "base-processing",
        passageCount: null,
        readySourceCount: 0,
        sourceCount: 1
      }]
    }));

    expect(plan).toMatchObject({
      automaticRetrieval: false,
      intent: "fact_lookup",
      strategy: "none",
      subqueries: []
    });
    expect(decodeKnowledgePlannerPlan(plan)).toEqual({ ok: true, plan });
  });

  it("plans a direct-only Source as real scope without inventing a Base", async () => {
    const plan = await planKnowledgeRequest(input({
      bases: [],
      directSources: [{
        approxTokens: 1_200,
        passageCount: 6,
        sourceOrdinal: 0
      }],
      modelCapabilities: { contextWindow: 16_000, toolCalling: true },
      originalQuery: "Summarize this source"
    }));

    expect(plan).toMatchObject({
      automaticRetrieval: true,
      coverage: { expectedPassageCount: 6, mode: "verified_only" },
      intent: "single_source_summary",
      strategy: "full_context"
    });
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

  it("keeps comparison branches Source-local and reports a budget-limited target set as partial", async () => {
    const plan = await planKnowledgeRequest(input({
      budgetPolicy: { maxSubqueriesPerPhase: 2 },
      originalQuery: "Compare Alpha and Beta and Gamma and Delta"
    }));

    expect(plan.intent).toBe("multi_source_comparison");
    expect(plan.subqueries).toHaveLength(2);
    expect(plan.coverage.namedTargets).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
    expect(plan.subqueries.map((query) => query.targetNames)).toEqual([["Alpha"], ["Beta"]]);
    expect(plan.targetResolution).toMatchObject({
      outcome: "resolved_many",
      targetSourceIds: [alphaId, betaId, gammaId, deltaId]
    });
    expect(plan.subqueries.map((query) => query.targetSourceIds)).toEqual([[alphaId], [betaId]]);
  });

  it("resolves Base-admitted canonical Sources, not only direct-only scope summaries", async () => {
    const plan = await planKnowledgeRequest(input({
      directSources: [],
      originalQuery: "Compare Alpha.pdf and Beta.pdf"
    }));

    expect(plan.targetResolution).toMatchObject({
      outcome: "resolved_many",
      targetSourceIds: [alphaId, betaId]
    });
    expect(plan.subqueries.every((subquery) => subquery.operation === "automatic_search")).toBe(true);
  });

  it("turns ambiguous comparison identity into one metadata-only clarification branch", async () => {
    const plan = await planKnowledgeRequest(input({
      originalQuery: "Compare Report and Beta",
      sources: [{
        fileName: "Report-A.pdf",
        sourceAlias: "S1",
        sourceId: alphaId,
        sourceName: "Report",
        versionNumber: 1
      }, {
        fileName: "Report-B.pdf",
        sourceAlias: "S2",
        sourceId: gammaId,
        sourceName: "Report",
        versionNumber: 1
      }, {
        fileName: "Beta.pdf",
        sourceAlias: "S3",
        sourceId: betaId,
        sourceName: "Beta",
        versionNumber: 1
      }]
    }));

    expect(plan).toMatchObject({
      automaticRetrieval: true,
      targetResolution: { outcome: "ambiguous", targetSourceIds: [] },
      targetSourceIds: []
    });
    expect(plan.subqueries).toEqual([expect.objectContaining({
      exactTerms: [],
      lanes: ["metadata"],
      operation: "discover_sources",
      purpose: "source_discovery",
      targetSourceIds: []
    })]);
  });

  it.each([
    ["Compare Missing and Beta", "not_found"],
    ["Compare Alhpa and Beta", "ambiguous"]
  ] as const)("never broad-searches an unresolved comparison: %s", async (originalQuery, outcome) => {
    const plan = await planKnowledgeRequest(input({ originalQuery }));

    expect(plan.targetResolution?.outcome).toBe(outcome);
    expect(plan.targetSourceIds).toEqual([]);
    expect(plan.subqueries).toEqual([expect.objectContaining({
      lanes: ["metadata"],
      operation: "discover_sources",
      purpose: "source_discovery",
      targetSourceIds: []
    })]);
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

  it("resolves follow-up comparison references from bounded conversation metadata", async () => {
    const plan = await planKnowledgeRequest(input({
      conversation: [
        { role: "user", text: "Review Alpha.pdf" },
        { role: "assistant", text: "I reviewed the selected report." }
      ],
      originalQuery: "And compare it with Beta.pdf"
    }));

    expect(plan.rewrite.query).toContain("Review Alpha.pdf");
    expect(plan.targetResolution).toMatchObject({
      outcome: "resolved_many",
      targetSourceIds: [alphaId, betaId]
    });
    expect(plan.coverage.namedTargets).toEqual(["Alpha.pdf", "Beta.pdf"]);
  });

  it("does not mistake a quoted comparison dimension for another target", async () => {
    const plan = await planKnowledgeRequest(input({
      originalQuery: "Compare “Alpha” and “Beta” by “termination clause”"
    }));

    expect(plan.coverage.namedTargets).toEqual(["Alpha", "Beta"]);
  });

  it("does not split an admitted filename that contains a conjunction", async () => {
    const plan = await planKnowledgeRequest(input({
      originalQuery: "Compare Alpha.pdf and Research and Development.pdf by owner",
      sources: [{
        fileName: "Alpha.pdf",
        sourceAlias: "S1",
        sourceId: alphaId,
        sourceName: "Alpha",
        versionNumber: 1
      }, {
        fileName: "Research and Development.pdf",
        sourceAlias: "S2",
        sourceId: betaId,
        sourceName: "Research and Development",
        versionNumber: 1
      }]
    }));

    expect(plan.coverage.namedTargets).toEqual([
      "Alpha.pdf",
      "Research and Development.pdf"
    ]);
    expect(plan.targetResolution).toMatchObject({
      outcome: "resolved_many",
      targetSourceIds: [alphaId, betaId]
    });
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

  it("does not let an injected classifier erase exact strings or filenames", async () => {
    const plan = await planKnowledgeRequest(input({
      originalQuery: "Find \"retention period\" in Alpha.pdf"
    }), {
      classifier: {
        classify: async () => ({ intent: "exact_lookup", rewrittenQuery: "Search the policy" })
      }
    });

    expect(plan.rewrite.query).toContain("\"retention period\"");
    expect(plan.rewrite.query).toContain("Alpha.pdf");
    expect(plan.subqueries[0]).toMatchObject({
      operation: "find_exact",
      targetNames: ["Alpha.pdf"],
      targetSourceIds: [alphaId]
    });
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
    expect(decodeKnowledgePlannerPlan({ ...plan, debug: true })).toEqual({ ok: false });
    expect(decodeKnowledgePlannerPlan({
      ...plan,
      subqueries: plan.subqueries.map(({ operation: _operation, ...subquery }) => subquery)
    })).toEqual({ ok: false });

    const structured = await planKnowledgeRequest(input({
      originalQuery: "Calculate the median CSV column in Alpha.pdf"
    }));
    expect(decodeKnowledgePlannerPlan({
      ...structured,
      subqueries: structured.subqueries.map((subquery) => ({
        ...subquery,
        targetResolution: null,
        targetSourceIds: []
      })),
      targetResolution: null,
      targetSourceIds: []
    })).toEqual({ ok: false });
  });

  it("decodes a strict legacy v1 plan byte-for-byte for recovery compatibility", async () => {
    const current = await planKnowledgeRequest(input());
    const {
      targetResolution: _targetResolution,
      targetSourceIds: _targetSourceIds,
      ...planWithoutTargets
    } = current;
    const legacy = {
      ...planWithoutTargets,
      subqueries: current.subqueries.map(({
        exact: _exact,
        operation: _operation,
        targetResolution: _subqueryResolution,
        targetSourceIds: _subqueryTargetSourceIds,
        ...subquery
      }) => subquery),
      version: 1
    };

    expect(decodeKnowledgePlannerPlan(legacy)).toEqual({ ok: true, plan: legacy });
  });
});
