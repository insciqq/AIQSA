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

function plannerInput(
  originalQuery: string,
  overrides: Partial<KnowledgePlannerInput> = {}
): KnowledgePlannerInput {
  return {
    bases: ordinaryBases,
    conversation: [],
    modelCapabilities: { contextWindow: 64_000, toolCalling: true },
    originalQuery,
    scopeRequested: true,
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
