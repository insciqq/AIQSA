import type {
  MemoryPhase7AblationCandidate,
  MemoryPhase7AblationCase
} from "../../../lib/evaluation/memory/phase7Ablation";
import {
  buildMemoryRecallReleaseCases,
  stripMemoryEvaluationVariantMarker
} from "./recallReleaseCases";
import type {
  MemoryCorpusExpectedFact,
  MemoryCorpusFixture
} from "./shared/corpusTypes";

export const MEMORY_PHASE7_ABLATION_CASE_BUILDER_VERSION =
  "memory-phase7-ablation-cases-v2";

export function memoryPhase7VariantForFixtureId(fixtureId: string): number {
  const value = /(\d{2})$/u.exec(fixtureId)?.[1];
  const variant = value === undefined ? Number.NaN : Number(value);
  if (!Number.isSafeInteger(variant) || variant < 0 || variant > 99) {
    throw new Error("memory_phase7_ablation_fixture_id_invalid");
  }
  return variant;
}

function modalityFor(
  value: MemoryCorpusExpectedFact["modality"]
): NonNullable<MemoryPhase7AblationCandidate["modality"]> {
  if (value === "IDENTITY" || value === "RELATIONSHIP") return "STATE";
  return value;
}

function dateRange(values: readonly string[]): Readonly<{
  from: string | null;
  to: string | null;
}> {
  const timestamps = values.map((value) => new Date(value).getTime());
  if (timestamps.length === 0 || timestamps.some((value) => !Number.isFinite(value))) {
    return { from: null, to: null };
  }
  return {
    from: new Date(Math.min(...timestamps)).toISOString(),
    to: new Date(Math.max(...timestamps) + 1).toISOString()
  };
}

function factFor(
  fixture: MemoryCorpusFixture,
  sourceMessageIds: readonly string[]
): MemoryCorpusExpectedFact | null {
  const source = new Set(sourceMessageIds);
  return fixture.expectedFacts.find((fact) =>
    fact.state === "ACTIVE" &&
    fact.sourceMessageIds.some((messageId) => source.has(messageId))
  ) ?? null;
}

function chatFor(
  fixture: MemoryCorpusFixture,
  sourceMessageIds: readonly string[]
) {
  const source = new Set(sourceMessageIds);
  return fixture.chats.find((chat) => chat.ownerUserId === fixture.queries[0]?.requestingUserId &&
    chat.messages.some(({ id }) => source.has(id))) ?? null;
}

function candidateFor(
  fixture: MemoryCorpusFixture,
  candidate: ReturnType<typeof buildMemoryRecallReleaseCases>[number]["candidates"][number]
): MemoryPhase7AblationCandidate {
  const fact = candidate.kind === "FACT"
    ? factFor(fixture, candidate.sourceMessageIds)
    : null;
  const chat = chatFor(fixture, candidate.sourceMessageIds);
  const messages = chat?.messages.filter(({ id }) => candidate.sourceMessageIds.includes(id)) ?? [];
  const occurred = dateRange(messages.map(({ createdAt }) => createdAt));
  const explicit = fixture.actions.some(({ sourceMessageIds, type }) =>
    ["EDIT", "SAVE"].includes(type) &&
    sourceMessageIds.some((messageId) => candidate.sourceMessageIds.includes(messageId))
  );
  return {
    category: fact?.category ?? null,
    current: candidate.kind !== "RUN_SNAPSHOT",
    explicit,
    key: candidate.key,
    kind: candidate.kind,
    language: fixture.language,
    modality: fact ? modalityFor(fact.modality) : null,
    occurredFrom: occurred.from,
    occurredTo: occurred.to,
    scopeTargetId: fact?.scope.targetId ?? null,
    scopeType: fact?.scope.type ?? null,
    sensitivity: fact?.sensitivity ?? null,
    sourceChatId: chat?.id ?? null,
    sourceFixtureId: fixture.id,
    sourceFolderId: chat?.folderId ?? null,
    sourceMessageIds: candidate.sourceMessageIds,
    sourceMode: fact ? (explicit ? "EXPLICIT" : "AUTOMATIC") : null,
    text: candidate.text,
    validFrom: fact?.validFrom ?? null,
    validTo: fact?.validTo ?? null
  };
}

function episodeFor(
  candidate: MemoryPhase7AblationCandidate
): MemoryPhase7AblationCandidate | null {
  if (candidate.kind !== "HISTORY_CHUNK") return null;
  return {
    ...candidate,
    key: `${candidate.key}:episode-proxy`,
    kind: "EPISODE"
  };
}

export function buildMemoryPhase7AblationCases(
  fixtures: readonly MemoryCorpusFixture[]
): readonly MemoryPhase7AblationCase[] {
  const sources = fixtures.map((fixture) => {
    const releaseCases = buildMemoryRecallReleaseCases([fixture]);
    if (releaseCases.length !== 1 || fixture.queries.length !== 1) {
      throw new Error("memory_phase7_ablation_fixture_shape_invalid");
    }
    const ownerChat = fixture.chats.find(({ ownerUserId }) =>
      ownerUserId === fixture.queries[0]!.requestingUserId
    );
    if (!ownerChat) throw new Error("memory_phase7_ablation_fixture_owner_missing");
    const release = releaseCases[0]!;
    const nativeCandidates = release.candidates.map((candidate) =>
      candidateFor(fixture, candidate)
    );
    return {
      candidates: [
        ...nativeCandidates,
        ...nativeCandidates.flatMap((candidate) => episodeFor(candidate) ?? [])
      ],
      fixture,
      ownerChat,
      release,
      variant: memoryPhase7VariantForFixtureId(fixture.id)
    };
  });
  const pools = new Map<string, MemoryPhase7AblationCandidate[]>();
  for (const source of sources) {
    const key = `${source.fixture.language}:${source.variant}`;
    const values = pools.get(key) ?? [];
    values.push(...source.candidates);
    pools.set(key, values);
  }
  return sources.map((source) => ({
    candidates: pools.get(`${source.fixture.language}:${source.variant}`) ?? [],
    cohort: source.release.cohort,
    contextChatId: source.ownerChat.id,
    contextFolderId: source.ownerChat.folderId,
    criticalCohort: source.release.criticalCohort,
    forbiddenMessageIds: source.release.forbiddenMessageIds,
    key: source.release.key,
    language: source.release.language,
    lexicalTerms: source.release.lexicalTerms,
    queryText: stripMemoryEvaluationVariantMarker(source.release.queryText),
    recallExpected: source.release.recallExpected,
    relevantMessageIds: source.release.relevantMessageIds,
    retrievalAllowed: source.release.retrievalAllowed,
    sourceFixtureId: source.fixture.id,
    variant: source.variant
  }));
}
