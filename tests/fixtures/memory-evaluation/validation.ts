import { memoryEvaluationSha256 } from "../../../lib/evaluation/memory/canonical";
import {
  MEMORY_CORPUS_MINIMUMS,
  buildMemoryCorpusManifest,
  type MemoryCorpusManifest
} from "./manifestBuilders";
import {
  MEMORY_ADVERSARIAL_COHORTS,
  MEMORY_CORPUS_SCHEMA_VERSION,
  MEMORY_CORPUS_VERSION,
  MEMORY_CRITICAL_COHORTS,
  type MemoryCorpusFixture,
  type MemoryCorpusSplit
} from "./shared/corpusTypes";

export type MemoryCorpusValidationSummary = Readonly<{
  actionCount: number;
  fixtureCount: number;
  groupCounts: Readonly<Record<MemoryCorpusSplit, number>>;
  messageCount: number;
  queryCount: number;
}>;

function assertUnique(id: string, ids: Set<string>, errorCode: string): void {
  if (id.trim().length === 0) throw new Error("memory_corpus_blank_id");
  if (ids.has(id)) throw new Error(errorCode);
  ids.add(id);
}

function assertNotBlank(value: string): void {
  if (value.trim().length === 0) throw new Error("memory_corpus_blank_text");
}

function assertFixtureReferences(fixture: MemoryCorpusFixture, messageIds: Set<string>): void {
  const requireMessageIds = (ids: readonly string[]) => {
    for (const id of ids) {
      if (!messageIds.has(id)) throw new Error("memory_corpus_unknown_source_message");
    }
  };
  for (const fact of fixture.expectedFacts) requireMessageIds(fact.sourceMessageIds);
  for (const fact of fixture.forbiddenFacts) requireMessageIds(fact.sourceMessageIds);
  for (const action of fixture.actions) requireMessageIds(action.sourceMessageIds);
  for (const query of fixture.queries) {
    requireMessageIds(query.relevantMessageIds);
    requireMessageIds(query.forbiddenMessageIds);
  }
}

function assertHoldoutMinimums(manifest: MemoryCorpusManifest): void {
  const holdout = manifest.splits.HOLDOUT;
  for (const language of ["RU", "EN"] as const) {
    const statistics = holdout.languages[language];
    if (statistics.factScenarios < MEMORY_CORPUS_MINIMUMS.factScenarios[language]) {
      throw new Error("memory_corpus_fact_minimum_not_met");
    }
    if (statistics.judgedRetrievalQueries < MEMORY_CORPUS_MINIMUMS.retrievalQueries[language]) {
      throw new Error("memory_corpus_query_minimum_not_met");
    }
    if (statistics.adversarialCases < MEMORY_CORPUS_MINIMUMS.adversarial[language]) {
      throw new Error("memory_corpus_adversarial_minimum_not_met");
    }
    for (const cohort of MEMORY_CRITICAL_COHORTS) {
      if (
        holdout.criticalCohorts[language][cohort] <
        MEMORY_CORPUS_MINIMUMS.criticalCohortPerLanguage
      ) {
        throw new Error("memory_corpus_critical_cohort_minimum_not_met");
      }
    }
  }
}

export function validateFrozenMemoryCorpus(input: {
  fixtures: readonly MemoryCorpusFixture[];
  frozenManifest: MemoryCorpusManifest;
}): MemoryCorpusValidationSummary {
  const fixtureIds = new Set<string>();
  const actionIds = new Set<string>();
  const messageIds = new Set<string>();
  const queryIds = new Set<string>();
  const groupsBySplit: Record<MemoryCorpusSplit, Set<string>> = {
    HOLDOUT: new Set<string>(),
    TUNING: new Set<string>()
  };

  for (const fixture of input.fixtures) {
    if (
      fixture.corpusVersion !== MEMORY_CORPUS_VERSION ||
      fixture.schemaVersion !== MEMORY_CORPUS_SCHEMA_VERSION ||
      fixture.dataClass !== "SYNTHETIC"
    ) {
      throw new Error("memory_corpus_fixture_contract_mismatch");
    }
    if (
      fixture.users.length === 0 ||
      fixture.chats.length === 0 ||
      fixture.queries.length === 0 ||
      fixture.forbiddenFacts.length === 0 ||
      fixture.expectedEgress.allowedDestinations.length === 0
    ) {
      throw new Error("memory_corpus_fixture_incomplete");
    }
    assertNotBlank(fixture.adjudicationId);
    assertNotBlank(fixture.groupId);
    assertUnique(fixture.id, fixtureIds, "memory_corpus_duplicate_fixture_id");
    groupsBySplit[fixture.split].add(fixture.groupId);

    const fixtureMessageIds = new Set<string>();
    const messageOwners = new Map<string, string>();
    const messageRoles = new Map<string, "user" | "assistant">();
    for (const chat of fixture.chats) {
      if (!fixture.users.includes(chat.ownerUserId)) {
        throw new Error("memory_corpus_unknown_chat_owner");
      }
      const branchIds = new Set(chat.branches.map(({ id }) => id));
      if (!branchIds.has(chat.activeBranchId)) {
        throw new Error("memory_corpus_unknown_active_branch");
      }
      for (const branch of chat.branches) {
        if (branch.parentBranchId !== null && !branchIds.has(branch.parentBranchId)) {
          throw new Error("memory_corpus_unknown_parent_branch");
        }
      }
      for (const value of chat.messages) {
        if (value.ownerUserId !== chat.ownerUserId || !branchIds.has(value.branchId)) {
          throw new Error("memory_corpus_message_ownership_mismatch");
        }
        assertUnique(value.id, messageIds, "memory_corpus_duplicate_message_id");
        assertUnique(value.id, fixtureMessageIds, "memory_corpus_duplicate_fixture_message_id");
        assertNotBlank(value.text);
        messageOwners.set(value.id, value.ownerUserId);
        messageRoles.set(value.id, value.role);
      }
    }
    assertFixtureReferences(fixture, fixtureMessageIds);
    for (const action of fixture.actions) {
      assertUnique(action.id, actionIds, "memory_corpus_duplicate_action_id");
    }

    for (const fact of fixture.expectedFacts) {
      assertNotBlank(fact.displayText);
      for (const sourceMessageId of fact.sourceMessageIds) {
        if (messageRoles.get(sourceMessageId) !== "user") {
          throw new Error("memory_corpus_non_user_fact_source");
        }
        if (messageOwners.get(sourceMessageId) !== fixture.queries[0].requestingUserId) {
          throw new Error("memory_corpus_cross_user_fact_source");
        }
      }
    }
    for (const fact of fixture.forbiddenFacts) assertNotBlank(fact.text);
    for (const query of fixture.queries) {
      assertUnique(query.id, queryIds, "memory_corpus_duplicate_query_id");
      assertNotBlank(query.text);
      if (!fixture.users.includes(query.requestingUserId)) {
        throw new Error("memory_corpus_unknown_query_owner");
      }
      for (const relevantMessageId of query.relevantMessageIds) {
        if (messageOwners.get(relevantMessageId) !== query.requestingUserId) {
          throw new Error("memory_corpus_cross_user_relevant_source");
        }
      }
      if (fixture.cohort === "cross-user-isolation") {
        for (const forbiddenMessageId of query.forbiddenMessageIds) {
          if (messageOwners.get(forbiddenMessageId) === query.requestingUserId) {
            throw new Error("memory_corpus_cross_user_forbidden_source_mismatch");
          }
        }
      }
    }

    const adversarial = MEMORY_ADVERSARIAL_COHORTS.some(
      (cohort) => cohort === fixture.cohort
    );
    if (fixture.tags.includes("adversarial") !== adversarial) {
      throw new Error("memory_corpus_adversarial_tag_mismatch");
    }
  }

  for (const groupId of groupsBySplit.TUNING) {
    if (groupsBySplit.HOLDOUT.has(groupId)) {
      throw new Error("memory_corpus_split_group_overlap");
    }
  }

  const generatedManifest = buildMemoryCorpusManifest(input.fixtures);
  assertHoldoutMinimums(generatedManifest);
  if (memoryEvaluationSha256(generatedManifest) !== memoryEvaluationSha256(input.frozenManifest)) {
    throw new Error("memory_corpus_frozen_manifest_mismatch");
  }
  return {
    actionCount: actionIds.size,
    fixtureCount: fixtureIds.size,
    groupCounts: {
      HOLDOUT: groupsBySplit.HOLDOUT.size,
      TUNING: groupsBySplit.TUNING.size
    },
    messageCount: messageIds.size,
    queryCount: queryIds.size
  };
}
