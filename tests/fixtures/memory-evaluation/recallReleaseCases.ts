import { planMemoryRetrieval } from "../../../lib/domain/memory/retrieval";
import type { MemoryRecallReleaseCase } from "../../../lib/evaluation/memory/recallRelease";
import {
  MEMORY_CRITICAL_COHORTS,
  type MemoryCorpusChat,
  type MemoryCorpusFixture
} from "./shared/corpusTypes";

export const MEMORY_RECALL_RELEASE_CASE_BUILDER_VERSION =
  "memory-recall-release-cases-v2";

const scoringNow = new Date("2026-08-11T12:00:00.000Z");
const syntheticVariantSuffix = /\s*\[(?:синтетический пример|synthetic case) \d+\]$/u;
const criticalCohorts = new Set<string>(MEMORY_CRITICAL_COHORTS);

export function stripMemoryEvaluationVariantMarker(value: string): string {
  return value.replace(syntheticVariantSuffix, "").trim();
}

function activeLineage(chat: MemoryCorpusChat): ReadonlySet<string> {
  const parents = new Map(chat.branches.map(({ id, parentBranchId }) => [id, parentBranchId]));
  const result = new Set<string>();
  let current: string | null | undefined = chat.activeBranchId;
  while (current && !result.has(current)) {
    result.add(current);
    current = parents.get(current);
  }
  return result;
}

function historyRecallEligible(fixture: MemoryCorpusFixture): boolean {
  if (!fixture.expectedLifecycle.sourceEligible) return false;
  if (fixture.cohort === "public-share-stripping" || fixture.cohort === "sensitive-inference") {
    return false;
  }
  if (fixture.expectedLifecycle.terminalFactState === "FORGOTTEN") return false;
  return true;
}

function historicalRunSnapshot(fixture: MemoryCorpusFixture): MemoryRecallReleaseCase["candidates"] {
  if (fixture.cohort !== "historical-run-snapshot") return [];
  const relevant = new Set(fixture.queries[0]!.relevantMessageIds);
  const messages = fixture.chats.flatMap(({ messages }) => messages)
    .filter(({ id, ownerUserId, role }) =>
      role === "user" && ownerUserId === fixture.queries[0]!.requestingUserId && relevant.has(id)
    );
  if (messages.length === 0) return [];
  return [{
    key: `${fixture.id}:run-snapshot`,
    kind: "RUN_SNAPSHOT",
    sourceMessageIds: messages.map(({ id }) => id),
    text: messages.map(({ text }) => stripMemoryEvaluationVariantMarker(text)).join("\n")
  }];
}

export function buildMemoryRecallReleaseCases(
  fixtures: readonly MemoryCorpusFixture[]
): readonly MemoryRecallReleaseCase[] {
  return fixtures.flatMap((fixture) => fixture.queries.map((query) => {
    const candidates: MemoryRecallReleaseCase["candidates"][number][] = [];
    if (historyRecallEligible(fixture)) {
      for (const chat of fixture.chats) {
        if (chat.ownerUserId !== query.requestingUserId) continue;
        const lineage = activeLineage(chat);
        const messages = chat.messages.filter(({ branchId, ownerUserId, role }) =>
          lineage.has(branchId) && ownerUserId === query.requestingUserId && role === "user"
        );
        if (messages.length === 0) continue;
        candidates.push({
          key: `${fixture.id}:${chat.id}:history`,
          kind: "HISTORY_CHUNK",
          sourceMessageIds: messages.map(({ id }) => id),
          text: messages.map(({ text }) => stripMemoryEvaluationVariantMarker(text)).join("\n")
        });
      }
      for (const fact of fixture.expectedFacts) {
        if (fact.state !== "ACTIVE") continue;
        candidates.push({
          key: `${fixture.id}:${fact.category}:fact`,
          kind: "FACT",
          sourceMessageIds: fact.sourceMessageIds,
          text: stripMemoryEvaluationVariantMarker(fact.displayText)
        });
      }
    }
    candidates.push(...historicalRunSnapshot(fixture));
    const queryText = stripMemoryEvaluationVariantMarker(query.text);
    const plan = planMemoryRetrieval({ currentUserText: queryText, now: scoringNow });
    return {
      candidates,
      cohort: fixture.cohort,
      criticalCohort: criticalCohorts.has(fixture.cohort),
      forbiddenMessageIds: query.forbiddenMessageIds,
      key: query.id,
      language: fixture.language,
      lexicalTerms: plan.lexicalQuery?.split(" ") ?? [],
      queryText,
      recallExpected: query.expectedOutcome === "RECALL",
      relevantMessageIds: query.relevantMessageIds,
      retrievalAllowed: plan.queryPresent
    };
  }));
}
