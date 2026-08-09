import {
  MEMORY_ADVERSARIAL_COHORTS,
  MEMORY_CORPUS_COHORTS,
  MEMORY_CORPUS_SCHEMA_VERSION,
  MEMORY_CORPUS_VERSION,
  MEMORY_CRITICAL_COHORTS,
  type MemoryCorpusAction,
  type MemoryCorpusChat,
  type MemoryCorpusCohort,
  type MemoryCorpusExpectedFact,
  type MemoryCorpusFixture,
  type MemoryCorpusLanguage,
  type MemoryCorpusMessage,
  type MemoryCorpusSplit,
  type MemoryCohortTemplates
} from "./corpusTypes";

export const MEMORY_FIXTURES_PER_COHORT_SPLIT = 20;

const MEMORY_ADVERSARIAL_COHORT_SET = new Set<MemoryCorpusCohort>(
  MEMORY_ADVERSARIAL_COHORTS
);
const MEMORY_CRITICAL_COHORT_SET = new Set<MemoryCorpusCohort>(MEMORY_CRITICAL_COHORTS);

const HARD_INVARIANTS_BY_COHORT: Readonly<
  Partial<Record<MemoryCorpusCohort, readonly string[]>>
> = {
  "ambiguous-pronoun": ["UNAUTHORIZED_SOURCE_FACT_PROMOTION"],
  "branch-edit-stale-job": ["STALE_BRANCH_INCLUSION"],
  "cross-user-isolation": [
    "CROSS_USER_LEAKAGE",
    "DATABASE_ACCEPTED_CROSS_OWNER_RELATION",
    "FILTERED_ANN_TENANT_LEAKAGE"
  ],
  "forget-rebuild": ["FORGOTTEN_ITEM_REBUILD_RESURRECTION"],
  "prompt-injection-secret": [
    "SECRET_DERIVATIVE_MEMORY_RETENTION",
    "SECRET_PROVIDER_EGRESS",
    "MEMORY_ONLY_TOOL_DISCLOSURE",
    "TRANSITIVE_MEMORY_TOOL_DISCLOSURE"
  ],
  "sensitive-inference": ["GENERIC_SENSITIVE_EPISODIC_RECALL"],
  "index-generation-isolation": ["MIXED_INDEX_GENERATION"],
  "public-share-stripping": ["PUBLIC_SHARE_MEMORY_EVIDENCE_LEAKAGE"],
  "temporary-zero-memory": ["TEMPORARY_CHAT_MEMORY_READ_OR_WRITE"]
};

function lower(value: string): string {
  return value.toLowerCase();
}

function caseSuffix(language: MemoryCorpusLanguage, index: number): string {
  return language === "RU"
    ? ` [синтетический пример ${index}]`
    : ` [synthetic case ${index}]`;
}

function instantiate(text: string, language: MemoryCorpusLanguage, index: number): string {
  return text.replace("0000", String(index).padStart(4, "0")) + caseSuffix(language, index);
}

function message(input: {
  branchId: string;
  id: string;
  minute: number;
  ownerUserId: string;
  role: "user" | "assistant";
  text: string;
}): MemoryCorpusMessage {
  return {
    branchId: input.branchId,
    createdAt: `2026-07-${String(1 + (input.minute % 27)).padStart(2, "0")}T10:${String(
      input.minute % 60
    ).padStart(2, "0")}:00.000Z`,
    id: input.id,
    ownerUserId: input.ownerUserId,
    role: input.role,
    text: input.text
  };
}

function factState(
  state: MemoryCorpusFixture["expectedLifecycle"]["terminalFactState"]
): MemoryCorpusExpectedFact["state"] {
  if (state === "ABSENT") throw new Error("memory_corpus_absent_fact_has_no_state");
  return state;
}

function generateFixture(input: {
  cohort: MemoryCorpusCohort;
  family: string;
  index: number;
  language: MemoryCorpusLanguage;
  split: MemoryCorpusSplit;
  templates: MemoryCohortTemplates;
}): MemoryCorpusFixture {
  const { cohort, family, index, language, split, templates } = input;
  const template = templates[cohort][language];
  const stem = `${lower(split)}-${lower(language)}-${cohort}-${String(index).padStart(2, "0")}`;
  const ownerUserId = `user-${stem}`;
  const otherUserId = `other-${stem}`;
  const chatId = `chat-${stem}`;
  const rootBranchId = `branch-${stem}-root`;
  const branching = cohort === "branch-edit-stale-job" || cohort === "branch-common-ancestor";
  const activeBranchId = branching
    ? `branch-${stem}-active`
    : rootBranchId;
  const staleBranchId = `branch-${stem}-stale`;
  const sourceMessageId = `message-${stem}-source`;
  const assistantMessageId = `message-${stem}-assistant`;
  const correctionMessageId = `message-${stem}-correction`;
  const otherMessageId = `message-${stem}-other-user`;
  const sourceBranchId = cohort === "branch-edit-stale-job"
    ? staleBranchId
    : cohort === "branch-common-ancestor"
      ? rootBranchId
      : activeBranchId;
  const currentSourceMessageId = template.correction ? correctionMessageId : sourceMessageId;
  const expectedFactSourceMessageId = cohort === "branch-common-ancestor" ||
      cohort === "historical-run-snapshot"
    ? sourceMessageId
    : currentSourceMessageId;

  const ownerMessages: MemoryCorpusMessage[] = [
    message({
      branchId: sourceBranchId,
      id: sourceMessageId,
      minute: index,
      ownerUserId,
      role: "user",
      text: instantiate(template.source, language, index)
    }),
    message({
      branchId: sourceBranchId,
      id: assistantMessageId,
      minute: index + 1,
      ownerUserId,
      role: "assistant",
      text: language === "RU"
        ? `Принято как синтетический тест ${index}; это не отдельный источник истины.`
        : `Acknowledged as synthetic test ${index}; this is not an independent truth source.`
    })
  ];
  if (template.correction) {
    ownerMessages.push(message({
      branchId: activeBranchId,
      id: correctionMessageId,
      minute: index + 2,
      ownerUserId,
      role: "user",
      text: instantiate(template.correction, language, index)
    }));
  }

  const ownerChat: MemoryCorpusChat = {
    activeBranchId,
    branches: branching
      ? [
          { id: rootBranchId, parentBranchId: null },
          { id: staleBranchId, parentBranchId: rootBranchId },
          { id: activeBranchId, parentBranchId: rootBranchId }
        ]
      : [{ id: rootBranchId, parentBranchId: null }],
    folderId: template.scopeType === "FOLDER" ? `folder-${stem}-atlas` : null,
    id: chatId,
    messages: ownerMessages,
    ownerUserId
  };

  const chats: MemoryCorpusChat[] = [ownerChat];
  if (cohort === "cross-user-isolation") {
    chats.push({
      activeBranchId: `branch-${stem}-other-root`,
      branches: [{ id: `branch-${stem}-other-root`, parentBranchId: null }],
      folderId: null,
      id: `chat-${stem}-other`,
      messages: [message({
        branchId: `branch-${stem}-other-root`,
        id: otherMessageId,
        minute: index + 3,
        ownerUserId: otherUserId,
        role: "user",
        text: instantiate(template.source, language, index)
      })],
      ownerUserId: otherUserId
    });
  }

  const expectedFacts: MemoryCorpusExpectedFact[] = template.expectedFact === null ||
      template.terminalFactState === "ABSENT"
    ? []
    : [{
        category: template.category,
        displayText: instantiate(template.expectedFact, language, index),
        modality: template.modality,
        scope: {
          targetId: template.scopeType === "GLOBAL_USER"
            ? null
            : template.scopeType === "FOLDER"
              ? ownerChat.folderId
              : template.scopeType === "CHAT"
                ? chatId
                : `assistant-${stem}`,
          type: template.scopeType
        },
        sensitivity: template.sensitivity,
        sourceMessageIds: [expectedFactSourceMessageId],
        state: factState(template.terminalFactState),
        validFrom: cohort === "relative-date-timezone" ? "2026-08-10T07:00:00.000Z" : null,
        validTo: cohort === "expired-plan" ? "2026-08-02T20:59:59.000Z" : null
      }];

  const forbiddenSourceMessageIds = cohort === "cross-user-isolation"
    ? [otherMessageId]
    : cohort === "branch-edit-stale-job"
      ? [sourceMessageId]
      : [currentSourceMessageId];
  const queryForbiddenMessageIds = [
    "cross-user-isolation",
    "branch-edit-stale-job",
    "prompt-injection-secret",
    "sensitive-inference",
    "exclude-removes-memory",
    "hard-delete-retracts",
    "temporary-zero-memory",
    "account-deletion-purge",
    "public-share-stripping",
    "historical-run-snapshot",
    "scope-target-delete-no-global"
  ].includes(cohort)
    ? forbiddenSourceMessageIds
    : [];
  const queryRelevantMessageIds = [
    "irrelevant-memory",
    "prompt-injection-secret",
    "sensitive-inference",
    "exclude-removes-memory",
    "hard-delete-retracts",
    "temporary-zero-memory",
    "account-deletion-purge",
    "public-share-stripping",
    "scope-target-delete-no-global"
  ].includes(cohort)
    ? []
    : cohort === "branch-common-ancestor"
      ? [sourceMessageId, correctionMessageId]
      : cohort === "historical-run-snapshot"
        ? [sourceMessageId]
        : [currentSourceMessageId];

  const actions: MemoryCorpusAction[] = template.actions.map((type, actionIndex) => ({
    expectedOutcome: type === "REBUILD"
      ? "NOOP"
      : type === "SIMULATE_PROVIDER_FAILURE"
        ? "DEGRADED"
        : type === "DELETE_ACCOUNT"
          ? "PURGED"
          : "APPLIED",
    id: `action-${stem}-${actionIndex}`,
    sourceMessageIds: type === "LIST"
      ? []
      : [type === "SAVE" ? sourceMessageId : currentSourceMessageId],
    type
  }));

  const localOnly = [
    "prompt-injection-secret",
    "sensitive-inference",
    "temporary-zero-memory",
    "account-deletion-purge",
    "public-share-stripping"
  ].includes(cohort);
  return {
    actions,
    adjudicationId: `adjudication-${lower(split)}-${lower(language)}-${cohort}`,
    chats,
    corpusVersion: MEMORY_CORPUS_VERSION,
    cohort,
    dataClass: "SYNTHETIC",
    expectedEgress: {
      allowedDestinations: localOnly
        ? ["LOCAL_ONLY"]
        : ["LOCAL_ONLY", "SYSTEM_MODEL", "EMBEDDING"],
      remoteCallsAllowed: !localOnly,
      requiresAcceptedFingerprint: !localOnly
    },
    expectedFacts,
    expectedLifecycle: {
      events: template.lifecycleEvents,
      sourceEligible: template.sourceEligible,
      terminalFactState: template.terminalFactState
    },
    expectedSafety: {
      automaticPromotionAllowed: template.automaticPromotionAllowed,
      hardInvariantCodes: HARD_INVARIANTS_BY_COHORT[cohort] ?? [],
      toolEgress: template.toolEgress
    },
    forbiddenFacts: [{
      reason: template.forbiddenReason,
      sourceMessageIds: forbiddenSourceMessageIds,
      text: instantiate(template.forbiddenFact, language, index)
    }],
    groupId: `group-${family}-${lower(language)}-${cohort}`,
    id: `fixture-${stem}`,
    language,
    queries: [{
      expectedOutcome: template.queryOutcome,
      forbiddenMessageIds: queryForbiddenMessageIds,
      id: `query-${stem}`,
      language: cohort === "cross-language-query"
        ? language === "RU" ? "EN" : "RU"
        : language,
      relevantMessageIds: queryRelevantMessageIds,
      requestingUserId: ownerUserId,
      text: instantiate(template.query, language, index)
    }],
    schemaVersion: MEMORY_CORPUS_SCHEMA_VERSION,
    split,
    tags: [
      cohort,
      lower(language),
      lower(split),
      ...(MEMORY_ADVERSARIAL_COHORT_SET.has(cohort) ? ["adversarial"] : [])
    ],
    users: cohort === "cross-user-isolation" ? [ownerUserId, otherUserId] : [ownerUserId]
  };
}

export function generateMemoryCorpusSplit(input: {
  family: string;
  split: MemoryCorpusSplit;
  templates: MemoryCohortTemplates;
}): MemoryCorpusFixture[] {
  const fixtures: MemoryCorpusFixture[] = [];
  const firstCaseNumber = input.split === "TUNING" ? 1 : 1001;
  for (const language of ["RU", "EN"] as const) {
    for (const cohort of MEMORY_CORPUS_COHORTS) {
      const fixtureCount = MEMORY_CRITICAL_COHORT_SET.has(cohort)
        ? MEMORY_FIXTURES_PER_COHORT_SPLIT
        : 1;
      for (let offset = 0; offset < fixtureCount; offset += 1) {
        fixtures.push(generateFixture({
          cohort,
          family: input.family,
          index: firstCaseNumber + offset,
          language,
          split: input.split,
          templates: input.templates
        }));
      }
    }
  }
  return fixtures;
}
