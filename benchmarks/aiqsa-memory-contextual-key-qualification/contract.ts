import { analyzeMemoryLexicalQuery } from
  "../../lib/domain/memory/retrieval/lexical";
import {
  buildMemoryContextualKeyRequest,
  decodeMemoryContextualKeyOutputs
} from "../../lib/server/memory/history/contextualKeys";
import {
  applyMemoryRecallRoundContextualKeysWithDiagnostics,
  MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
  type MemoryContextualFallbackReason,
  type MemoryContextualRoundOutput
} from "../../lib/server/memory/history/rounds";
import { memorySha256 } from "../../lib/server/memory/persistence/lexical";

export const CONTEXTUAL_KEY_QUALIFICATION_VERSION = 1 as const;

type DependencyClass = "CURRENT_ONLY" | "PRIOR_DEPENDENT";
type LengthClass = "LONG" | "SHORT";
type QualificationLanguageBucket = "en" | "mixed" | "other" | "ru" | "und";
type RedactionClass = "NOT_NEEDED" | "REDACTED";

type Seed = Readonly<{
  languageCode: string;
  selection: string;
  topic: string;
  value: string;
}>;

type QualificationCase = Readonly<{
  currentText: string;
  dependencyClass: DependencyClass;
  id: string;
  languageCode: string;
  lengthClass: LengthClass;
  priorText: string | null;
  query: string;
  redactionClass: RedactionClass;
  statement: string;
}>;

type QualificationRound = Readonly<{
  contextualKeyPolicyVersion: string;
  contextualKeyState: "GENERATED" | "RAW_FALLBACK";
  contextualNarrativeText: string;
  contextualSearchHash: string;
  contextualSearchText: string;
  id: string;
  languageCode: string;
  publicationState: "ACTIVE";
  rawSafeText: string;
  redactionState: RedactionClass;
  safetyClass: "NORMAL";
  supportingRoundIds: readonly string[];
}>;

const seeds: readonly Seed[] = Object.freeze([
  { languageCode: "en", selection: "selected", topic: "Project Cedar deployment region", value: "euwestalpha" },
  { languageCode: "en", selection: "chosen", topic: "Project Alder retention tier", value: "glacierbeta" },
  { languageCode: "en", selection: "selected", topic: "Atlas release channel", value: "stablegamma" },
  { languageCode: "en", selection: "chosen", topic: "Harbor database engine", value: "postgresdelta" },
  { languageCode: "ru", selection: "выбран", topic: "Проект Кедр регион развертывания", value: "западальфа" },
  { languageCode: "ru", selection: "выбран", topic: "Проект Ольха уровень хранения", value: "архивбета" },
  { languageCode: "ru", selection: "выбран", topic: "Сервис Атлас канал выпуска", value: "стабильныйгамма" },
  { languageCode: "ru", selection: "выбран", topic: "Сервис Гавань движок базы", value: "постгресдельта" },
  { languageCode: "mixed", selection: "selected", topic: "Project Сапфир deployment регион", value: "northmixed" },
  { languageCode: "mixed", selection: "выбрана", topic: "Сервис Atlas backup политика", value: "dailymixed" },
  { languageCode: "und", selection: "chosen", topic: "zeta omicron locus", value: "northcell" },
  { languageCode: "und", selection: "chosen", topic: "tau lambda archive", value: "deepcell" },
  { languageCode: "es", selection: "seleccionada", topic: "Proyecto Olivo región despliegue", value: "oestealfa" },
  { languageCode: "es", selection: "seleccionado", topic: "Servicio Brisa motor datos", value: "postgresbeta" },
  { languageCode: "sr-Cyrl", selection: "изабран", topic: "Пројекат Јасен регион примене", value: "западалфа" },
  { languageCode: "sr-Cyrl", selection: "изабран", topic: "Сервис Морава база података", value: "постгресбета" }
]);

function paddedCurrent(seed: Seed, ordinal: number, base: string): Readonly<{
  lengthClass: LengthClass;
  text: string;
}> {
  if (ordinal % 4 !== 0) return { lengthClass: "SHORT", text: base };
  return {
    lengthClass: "LONG",
    text: `${base} ${Array.from({ length: 160 }, () => seed.value).join(" ")}`
  };
}

function qualificationCases(): readonly QualificationCase[] {
  return Object.freeze((["CURRENT_ONLY", "PRIOR_DEPENDENT"] as const)
    .flatMap((dependencyClass) => seeds.map((seed, ordinal) => {
      const prefix = dependencyClass === "CURRENT_ONLY" ? "current" : "prior";
      const base = dependencyClass === "CURRENT_ONLY"
        ? `User: ${seed.topic} ${seed.selection} ${seed.value}`
        : `User: ${seed.selection} ${seed.value}`;
      const current = paddedCurrent(seed, ordinal, base);
      return Object.freeze({
        currentText: current.text,
        dependencyClass,
        id: `${prefix}-${String(ordinal).padStart(2, "0")}`,
        languageCode: seed.languageCode,
        lengthClass: current.lengthClass,
        priorText: dependencyClass === "PRIOR_DEPENDENT"
          ? `User: ${seed.topic}`
          : null,
        query: seed.topic,
        redactionClass: ordinal % 5 === 0 ? "REDACTED" : "NOT_NEEDED",
        statement: `${seed.topic} ${seed.selection} ${seed.value}`
      });
    })));
}

function round(
  id: string,
  rawSafeText: string,
  languageCode: string,
  redactionState: RedactionClass
): QualificationRound {
  const contextualSearchText = rawSafeText.normalize("NFKC")
    .toLocaleLowerCase("und");
  return Object.freeze({
    contextualKeyPolicyVersion: MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
    contextualKeyState: "RAW_FALLBACK",
    contextualNarrativeText: rawSafeText,
    contextualSearchHash: memorySha256(contextualSearchText),
    contextualSearchText,
    id,
    languageCode,
    publicationState: "ACTIVE",
    rawSafeText,
    redactionState,
    safetyClass: "NORMAL",
    supportingRoundIds: Object.freeze([])
  });
}

function batches<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

function decodeFixtureOutputs(
  cases: readonly QualificationCase[]
): readonly MemoryContextualRoundOutput[] {
  return Object.freeze(batches(cases, 8).flatMap((batchCases) => {
    const batch = batchCases.map((candidate) => ({
      input: {
        current: {
          id: `${candidate.id}-current`,
          rawSafeText: candidate.currentText
        },
        prior: candidate.priorText === null ? [] : [{
          id: `${candidate.id}-prior`,
          rawSafeText: candidate.priorText
        }]
      },
      roundId: `${candidate.id}-current`
    }));
    const built = buildMemoryContextualKeyRequest(batch);
    return decodeMemoryContextualKeyOutputs({
      rounds: batchCases.map((candidate, ordinal) => ({
        handle: built.handles[ordinal],
        language_code: candidate.languageCode,
        statements: [{
          source_refs: [
            `${built.handles[ordinal]}c`,
            ...(candidate.priorText === null
              ? []
              : [`${built.handles[ordinal]}p0`])
          ],
          text: candidate.statement
        }]
      }))
    }, batch, built.handles);
  }));
}

type EvaluatedCase = Readonly<{
  contextualText: string;
  dependencyClass: DependencyClass;
  fallbackReasons: readonly MemoryContextualFallbackReason[];
  generated: boolean;
  id: string;
  languageBucket: QualificationLanguageBucket;
  lengthClass: LengthClass;
  missingDependency: boolean;
  query: string;
  rawText: string;
  redactionClass: RedactionClass;
}>;

function qualificationLanguageBucket(languageCode: string): QualificationLanguageBucket {
  if (languageCode === "en" || languageCode === "ru" ||
    languageCode === "mixed" || languageCode === "und") return languageCode;
  return "other";
}

function evaluateCases(cases: readonly QualificationCase[]): readonly EvaluatedCase[] {
  const outputs = decodeFixtureOutputs(cases);
  const outputByRoundId = new Map(outputs.map((output) =>
    [output.roundId, output] as const));
  return Object.freeze(cases.map((candidate) => {
    const currentId = `${candidate.id}-current`;
    const priorId = `${candidate.id}-prior`;
    const inputRounds = candidate.priorText === null
      ? [round(currentId, candidate.currentText, candidate.languageCode,
        candidate.redactionClass)]
      : [
          round(priorId, candidate.priorText, candidate.languageCode,
            candidate.redactionClass),
          round(currentId, candidate.currentText, candidate.languageCode,
            candidate.redactionClass)
        ];
    const output = outputByRoundId.get(currentId);
    if (!output) throw new Error("contextual_qualification_output_missing");
    const applied = applyMemoryRecallRoundContextualKeysWithDiagnostics(
      inputRounds,
      [output],
      MEMORY_CONTEXTUAL_KEY_POLICY_VERSION
    );
    const current = applied.rounds.find(({ id }) => id === currentId);
    if (!current) throw new Error("contextual_qualification_round_missing");
    const generated = current.contextualKeyState === "GENERATED";
    return Object.freeze({
      contextualText: current.contextualSearchText,
      dependencyClass: candidate.dependencyClass,
      fallbackReasons: Object.freeze(applied.fallbackDiagnostics
        .filter(({ roundId }) => roundId === currentId)
        .map(({ reason }) => reason)),
      generated,
      id: candidate.id,
      languageBucket: qualificationLanguageBucket(candidate.languageCode),
      lengthClass: candidate.lengthClass,
      missingDependency: candidate.dependencyClass === "PRIOR_DEPENDENT" && generated &&
        !current.supportingRoundIds.includes(priorId),
      query: candidate.query,
      rawText: candidate.currentText,
      redactionClass: candidate.redactionClass
    });
  }));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rankedIds(
  query: string,
  cases: readonly EvaluatedCase[],
  projection: "contextualText" | "rawText"
): readonly string[] {
  const queryTerms = new Set(analyzeMemoryLexicalQuery(query).logicalTerms);
  return cases.map((candidate) => {
    const documentTerms = new Set(
      analyzeMemoryLexicalQuery(candidate[projection]).logicalTerms
    );
    const score = [...queryTerms].filter((term) => documentTerms.has(term)).length;
    return { id: candidate.id, score };
  }).sort((left, right) => right.score - left.score ||
    compareText(left.id, right.id)).map(({ id }) => id);
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function recallAt(ranks: readonly number[], limit: number): number {
  return rate(ranks.filter((rank) => rank <= limit).length, ranks.length);
}

type OutcomeClass = Readonly<{
  fallback: number;
  fallbackRate: number;
  generated: number;
  generatedRate: number;
  total: number;
}>;

function outcomeClass(cases: readonly EvaluatedCase[]): OutcomeClass {
  const generated = cases.filter(({ generated: value }) => value).length;
  const fallback = cases.length - generated;
  return Object.freeze({
    fallback,
    fallbackRate: rate(fallback, cases.length),
    generated,
    generatedRate: rate(generated, cases.length),
    total: cases.length
  });
}

function groupedOutcome<K extends string>(
  cases: readonly EvaluatedCase[],
  keys: readonly K[],
  selector: (candidate: EvaluatedCase) => K
): Readonly<Record<K, OutcomeClass>> {
  return Object.freeze(Object.fromEntries(keys.map((key) => [
    key,
    outcomeClass(cases.filter((candidate) => selector(candidate) === key))
  ]))) as Readonly<Record<K, OutcomeClass>>;
}

function adversarialDiagnostics(): Readonly<{
  acceptedUnsupportedDateCount: number;
  acceptedUnsupportedEntityCount: number;
  acceptedUnsupportedNumberCount: number;
  rejectedCount: number;
  rejectionReasonCounts: Readonly<Partial<Record<MemoryContextualFallbackReason, number>>>;
}> {
  const fixtures = [
    {
      expected: ["UNSUPPORTED_NUMBER"] as const,
      id: "unsupported-number",
      source: "User: Project Cedar budget twelve",
      statements: ["Project Cedar budget 13"]
    },
    {
      expected: ["UNSUPPORTED_DATE", "UNSUPPORTED_NUMBER"] as const,
      id: "unsupported-date",
      source: "User: Project Cedar date 2026-08-12",
      statements: ["Project Cedar date 2026-08-13"]
    },
    {
      expected: ["UNSUPPORTED_ENTITY"] as const,
      id: "unsupported-entity",
      source: "User: Project Cedar region",
      statements: ["Project Nimbus region"]
    },
    {
      expected: ["DUPLICATE_STATEMENT"] as const,
      id: "duplicate-statement",
      source: "User: Project Cedar region west",
      statements: ["Project Cedar region west", "Project Cedar region west"]
    }
  ];
  const reasonCounts: Partial<Record<MemoryContextualFallbackReason, number>> = {};
  let acceptedUnsupportedDateCount = 0;
  let acceptedUnsupportedEntityCount = 0;
  let acceptedUnsupportedNumberCount = 0;
  let rejectedCount = 0;
  for (const fixture of fixtures) {
    const sourceRound = round(fixture.id, fixture.source, "en", "NOT_NEEDED");
    const applied = applyMemoryRecallRoundContextualKeysWithDiagnostics(
      [sourceRound],
      [{
        languageCode: "en",
        roundId: fixture.id,
        statements: fixture.statements.map((text) => ({
          sourceRoundIds: [fixture.id],
          text
        }))
      }],
      MEMORY_CONTEXTUAL_KEY_POLICY_VERSION
    );
    const generated = applied.rounds[0]?.contextualKeyState === "GENERATED";
    if (!generated) rejectedCount += 1;
    const reasons = new Set(applied.fallbackDiagnostics.map(({ reason }) => reason));
    for (const expected of fixture.expected) {
      if (!reasons.has(expected)) {
        throw new Error("contextual_qualification_expected_reason_missing");
      }
    }
    for (const reason of reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    if (generated && fixture.expected.includes("UNSUPPORTED_DATE" as never)) {
      acceptedUnsupportedDateCount += 1;
    }
    if (generated && fixture.expected.includes("UNSUPPORTED_ENTITY" as never)) {
      acceptedUnsupportedEntityCount += 1;
    }
    if (generated && fixture.expected.includes("UNSUPPORTED_NUMBER" as never)) {
      acceptedUnsupportedNumberCount += 1;
    }
  }
  return Object.freeze({
    acceptedUnsupportedDateCount,
    acceptedUnsupportedEntityCount,
    acceptedUnsupportedNumberCount,
    rejectedCount,
    rejectionReasonCounts: Object.freeze(reasonCounts)
  });
}

export function runContextualKeyQualification() {
  const corpus = qualificationCases();
  const evaluated = evaluateCases(corpus);
  const rankEvidence = evaluated.map((candidate) => {
    const rawRank = rankedIds(candidate.query, evaluated, "rawText")
      .indexOf(candidate.id) + 1;
    const contextualRank = rankedIds(candidate.query, evaluated, "contextualText")
      .indexOf(candidate.id) + 1;
    if (rawRank < 1 || contextualRank < 1) {
      throw new Error("contextual_qualification_rank_missing");
    }
    return Object.freeze({
      contextualRank,
      dependencyClass: candidate.dependencyClass,
      id: candidate.id,
      languageBucket: candidate.languageBucket,
      rawRank
    });
  });
  const rawRanks = rankEvidence.map(({ rawRank }) => rawRank);
  const contextualRanks = rankEvidence.map(({ contextualRank }) => contextualRank);
  const priorRanks = rankEvidence.filter(({ dependencyClass }) =>
    dependencyClass === "PRIOR_DEPENDENT");
  const overall = outcomeClass(evaluated);
  const adversarial = adversarialDiagnostics();
  const rawRecallAt20 = recallAt(rawRanks, 20);
  const contextualRecallAt20 = recallAt(contextualRanks, 20);
  const rawPriorRecallAt20 = recallAt(priorRanks.map(({ rawRank }) => rawRank), 20);
  const contextualPriorRecallAt20 = recallAt(
    priorRanks.map(({ contextualRank }) => contextualRank),
    20
  );
  const missingSupportingDependencyCount = evaluated.filter(({ missingDependency }) =>
    missingDependency).length;
  const byLanguage = groupedOutcome(evaluated,
    ["en", "ru", "mixed", "und", "other"] as const,
    ({ languageBucket }) => languageBucket);
  const targetEvidence = Object.freeze({
    acceptedUnsupportedDateAndEntityIsZero:
      adversarial.acceptedUnsupportedDateCount === 0 &&
      adversarial.acceptedUnsupportedEntityCount === 0,
    contextualRecallAt20WithinOnePoint:
      contextualRecallAt20 >= rawRecallAt20 - 0.01,
    coreferenceImprovementAtLeastFivePoints:
      contextualPriorRecallAt20 - rawPriorRecallAt20 >= 0.05,
    deterministicDecoderSuccessAtLeast99Percent: true,
    englishFallbackAtMost20Percent: byLanguage.en.fallbackRate <= 0.2,
    missingSupportingDependencyIsZero: missingSupportingDependencyCount === 0,
    providerSuccessAtLeast99Percent: null,
    russianFallbackAtMost30Percent: byLanguage.ru.fallbackRate <= 0.3
  });
  return Object.freeze({
    adversarial,
    binding: Object.freeze({
      mode: "DETERMINISTIC_NO_PROVIDER" as const,
      providerSuccessRate: null
    }),
    corpus: Object.freeze({
      caseCount: evaluated.length,
      fixedSeed: "contextual-key-qualification-corpus-v1",
      priorDependentCount: priorRanks.length
    }),
    decision: Object.freeze({
      controlledEquivalenceEnabled: false,
      reason: "REAL_PROVIDER_EVIDENCE_UNAVAILABLE_STRICT_VALIDATOR_RETAINED" as const,
      validatorMode: "STRICT_SOURCE_BOUND" as const
    }),
    dimensions: Object.freeze({
      byDependency: groupedOutcome(evaluated,
        ["CURRENT_ONLY", "PRIOR_DEPENDENT"] as const,
        ({ dependencyClass }) => dependencyClass),
      byLanguage,
      byLength: groupedOutcome(evaluated, ["SHORT", "LONG"] as const,
        ({ lengthClass }) => lengthClass),
      byRedaction: groupedOutcome(evaluated,
        ["NOT_NEEDED", "REDACTED"] as const,
        ({ redactionClass }) => redactionClass),
      policyVersion: MEMORY_CONTEXTUAL_KEY_POLICY_VERSION
    }),
    fallbackReasonCounts: Object.freeze(evaluated.flatMap(({ fallbackReasons }) =>
      fallbackReasons).reduce<Partial<Record<MemoryContextualFallbackReason, number>>>(
        (counts, reason) => ({ ...counts, [reason]: (counts[reason] ?? 0) + 1 }),
        {}
      )),
    metrics: Object.freeze({
      contextualFallbackRate: overall.fallbackRate,
      contextualGeneratedRate: overall.generatedRate,
      contextualKeyPrecisionSampleAt5: rate(
        contextualRanks.filter((rank) => rank <= 5).length,
        contextualRanks.length * 5
      ),
      contextualKeyRecall: Object.freeze({
        at5: recallAt(contextualRanks, 5),
        at10: recallAt(contextualRanks, 10),
        at20: contextualRecallAt20
      }),
      contextualOnlyGoldHitCountAt20: rankEvidence.filter(({ contextualRank, rawRank }) =>
        contextualRank <= 20 && rawRank > 20).length,
      contextualPriorDependencyRate: rate(priorRanks.length, evaluated.length),
      deterministicDecoderSuccessRate: 1,
      missingSupportingDependencyCount,
      rawKeyRecall: Object.freeze({
        at5: recallAt(rawRanks, 5),
        at10: recallAt(rawRanks, 10),
        at20: rawRecallAt20
      }),
      rawOnlyGoldHitCountAt20: rankEvidence.filter(({ contextualRank, rawRank }) =>
        rawRank <= 20 && contextualRank > 20).length
    }),
    rankEvidence: Object.freeze(rankEvidence),
    targetEvidence,
    version: CONTEXTUAL_KEY_QUALIFICATION_VERSION
  });
}
