import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_PLANNER_VERSION,
  planKnowledgeRequest,
  type KnowledgePlannerInput,
  type KnowledgePlannerIntent,
  type KnowledgePlannerStrategy
} from "../../lib/server/knowledge/planner";

const ordinaryBases: KnowledgePlannerInput["bases"] = [{
  approxTokens: 20_000,
  knowledgeBaseId: "policies",
  passageCount: 30,
  readySourceCount: 2,
  sourceCount: 2
}];
const alphaId = "11111111-1111-4111-8111-111111111111";
const betaId = "22222222-2222-4222-8222-222222222222";
const ordinarySources: NonNullable<KnowledgePlannerInput["sources"]> = [{
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
}];

function plannerInput(
  originalQuery: string,
  overrides: Partial<KnowledgePlannerInput> = {}
): KnowledgePlannerInput {
  return {
    bases: ordinaryBases,
    conversation: [],
    directSources: [],
    modelCapabilities: { contextWindow: 64_000, toolCalling: true },
    originalQuery,
    scopeRequested: true,
    sources: ordinarySources,
    version: KNOWLEDGE_PLANNER_VERSION,
    ...overrides
  };
}

describe("Knowledge planner golden evaluation", () => {
  it.each([
    ["Спасибо!", "no_knowledge_needed", "none"],
    ["What is the retention policy?", "fact_lookup", "focused"],
    ["Перефразируй предыдущий ответ", "no_knowledge_needed", "none"],
    ["Find API-2048 dated 2026-08-18", "exact_lookup", "focused"],
    ["Сделай краткий обзор базы знаний", "corpus_summary", "corpus_summary"],
    ["Сравни Alpha и Beta", "multi_source_comparison", "comparison"],
    ["Найди все исключения без пропусков", "exhaustive_corpus_search", "exhaustive"],
    ["Кто согласовал релиз; затем когда он вышел?", "multi_hop_reasoning", "multi_pass"],
    ["Посчитай медиану столбца CSV", "structured_data_analysis", "structured_data"],
    ["Какой документ описывает удаление данных?", "source_discovery", "focused"],
    ["Compare every exact API-2048 and API-4096 occurrence", "mixed", "multi_pass"]
  ] as const)(
    "%s -> %s / %s",
    async (query, expectedIntent: KnowledgePlannerIntent, expectedStrategy: KnowledgePlannerStrategy) => {
      const planned = await planKnowledgeRequest(plannerInput(query, query === "Перефразируй предыдущий ответ"
        ? { conversation: [{ role: "assistant", text: "Предыдущий ответ" }] }
        : {}));
      expect(planned).toMatchObject({
        intent: expectedIntent,
        strategy: expectedStrategy,
        version: KNOWLEDGE_PLANNER_VERSION
      });
    }
  );

  it("covers small-source full context and conversation follow-up fixtures", async () => {
    const summary = await planKnowledgeRequest(plannerInput("Summarize this source", {
      bases: [{
        approxTokens: 900,
        knowledgeBaseId: "one-small-source",
        passageCount: 5,
        readySourceCount: 1,
        sourceCount: 1
      }]
    }));
    const followUp = await planKnowledgeRequest(plannerInput("А когда?", {
      conversation: [
        { role: "user", text: "Расскажи о запуске проекта" },
        { role: "assistant", text: "Его согласовали в июле." }
      ]
    }));

    expect(summary).toMatchObject({
      coverage: { expectedPassageCount: 5, mode: "verified_only" },
      intent: "single_source_summary",
      strategy: "full_context"
    });
    expect(followUp).toMatchObject({
      intent: "follow_up_reference",
      strategy: "focused"
    });
    expect(followUp.rewrite.query).toContain("Расскажи о запуске проекта");
  });

  it.each([
    ["Покажи динамику по холестерину в Alpha.pdf и Beta.pdf", "fact_lookup", "automatic_search"],
    ["Рассчитай динамику по холестерину в Alpha.pdf и Beta.pdf", "fact_lookup", "automatic_search"],
    ["Посчитай динамику в таблице Alpha.pdf", "structured_data_analysis", "structured_analysis"],
    ["What does the chart in Alpha.pdf show?", "fact_lookup", "visual_analysis"]
  ] as const)("routes semantic operation fixture: %s", async (query, intent, operation) => {
    const plan = await planKnowledgeRequest(plannerInput(query));

    expect(plan.intent).toBe(intent);
    expect(plan.subqueries[0]?.operation).toBe(operation);
  });

  it("binds EN/RU comparison targets to admitted Source IDs", async () => {
    const english = await planKnowledgeRequest(plannerInput("Compare Alpha.pdf and Beta.pdf"));
    const russian = await planKnowledgeRequest(plannerInput("Сравни Alpha.pdf и Beta.pdf"));

    for (const plan of [english, russian]) {
      expect(plan.targetResolution).toMatchObject({
        outcome: "resolved_many",
        targetSourceIds: [alphaId, betaId]
      });
      expect(plan.subqueries.flatMap((subquery) => subquery.targetSourceIds ?? []).sort())
        .toEqual([alphaId, betaId].sort());
    }
  });

  it("measures ambiguity as metadata clarification, never broad target search", async () => {
    const plan = await planKnowledgeRequest(plannerInput("Compare Report and Beta", {
      sources: [{
        fileName: "Report A.pdf",
        sourceAlias: "S1",
        sourceId: alphaId,
        sourceName: "Report",
        versionNumber: 1
      }, {
        fileName: "Report B.pdf",
        sourceAlias: "S2",
        sourceId: "33333333-3333-4333-8333-333333333333",
        sourceName: "Report",
        versionNumber: 1
      }, {
        ...ordinarySources[1]!,
        sourceAlias: "S3"
      }]
    }));

    expect(plan.targetResolution?.outcome).toBe("ambiguous");
    expect(plan.subqueries).toEqual([expect.objectContaining({
      lanes: ["metadata"],
      operation: "discover_sources",
      targetSourceIds: []
    })]);
  });

  it("meets the local planner latency envelope and deterministic outage fallback", async () => {
    const durations: number[] = [];
    for (let index = 0; index < 200; index += 1) {
      const started = performance.now();
      await planKnowledgeRequest(plannerInput("Compare Alpha and Beta"));
      durations.push(performance.now() - started);
    }
    durations.sort((left, right) => left - right);
    const p95 = durations[Math.floor(durations.length * 0.95)] ?? Number.POSITIVE_INFINITY;
    const degraded = await planKnowledgeRequest(plannerInput("What is retention?"), {
      classifier: { classify: async () => { throw new Error("planner offline"); } }
    });

    expect(p95).toBeLessThan(25);
    expect(degraded).toMatchObject({
      failureCode: "classifier_unavailable",
      intent: "fact_lookup",
      status: "degraded"
    });
  });
});
