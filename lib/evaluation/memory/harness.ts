import {
  MEMORY_CAPABILITY_ROLES,
  MEMORY_EVALUATION_ADAPTER_KINDS,
  MEMORY_EVALUATION_EVIDENCE_VERSION,
  MEMORY_EVALUATION_GATE_PROFILES,
  MEMORY_EVALUATION_LANGUAGES,
  MEMORY_EVALUATION_SCORER_VERSION,
  MEMORY_EVALUATION_SPLITS,
  decodeMemoryEvaluationObservation,
  type MemoryBinaryOutcome,
  type MemoryEvaluationAdapter,
  type MemoryEvaluationAdapterKind,
  type MemoryEvaluationConfig,
  type MemoryEvaluationFixture,
  type MemoryEvaluationGateProfile,
  type MemoryEvaluationLanguage,
  type MemoryEvaluationSplit,
  type MemoryEvaluationSystemFingerprint,
  type MemoryHardInvariantObservation,
  type MemoryOperationObservation,
  type MemoryRankedOutcome
} from "./contracts";
import {
  compareMemoryEvaluationText,
  deriveMemoryEvaluationSeed,
  memoryEvaluationSha256
} from "./canonical";
import {
  MEMORY_BETA_REQUIRED_BINARY_METRICS,
  MEMORY_BETA_REQUIRED_RANKED_METRICS,
  MEMORY_RECALL_RELEASE_REQUIRED_BINARY_METRICS,
  MEMORY_RECALL_RELEASE_REQUIRED_RANKED_METRICS,
  scoreMemoryBinaryOutcomes,
  scoreMemoryHardInvariants,
  scoreMemoryOperations,
  scoreMemoryRankedOutcomes,
  type MemoryBinaryScore,
  type MemoryHardInvariantSuiteScore,
  type MemoryOperationScore,
  type MemoryRankedScore
} from "./scorers";

const safeToken = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,199}$/u;
const sha256 = /^[a-f0-9]{64}$/u;

export const MEMORY_EVALUATION_ERROR_CODES = [
  "memory_evaluation_adapter_invalid",
  "memory_evaluation_config_invalid",
  "memory_evaluation_corpus_invalid",
  "memory_evaluation_corpus_hash_mismatch",
  "memory_evaluation_observation_invalid",
  "memory_evaluation_observation_mismatch"
] as const;
export type MemoryEvaluationErrorCode = (typeof MEMORY_EVALUATION_ERROR_CODES)[number];

export class MemoryEvaluationError extends Error {
  constructor(readonly code: MemoryEvaluationErrorCode) {
    super(code);
    this.name = "MemoryEvaluationError";
  }
}

export type MemoryEvaluationEvidence = Readonly<{
  adapter: Readonly<{
    fingerprints: readonly MemoryEvaluationSystemFingerprint[];
    kind: MemoryEvaluationAdapterKind;
    version: string;
  }>;
  corpus: Readonly<{
    hash: string;
    languages: readonly MemoryEvaluationLanguage[];
    splits: readonly MemoryEvaluationSplit[];
    version: string;
  }>;
  evidenceVersion: typeof MEMORY_EVALUATION_EVIDENCE_VERSION;
  hardInvariants: MemoryHardInvariantSuiteScore;
  operations: readonly MemoryOperationScore[];
  passed: boolean;
  quality: Readonly<{
    automaticLearningBetaCoverageComplete: boolean;
    automaticLearningBetaGatePassed: boolean;
    binary: readonly MemoryBinaryScore[];
    gatedMetricCount: number;
    observedGatesPassed: boolean;
    ranked: readonly MemoryRankedScore[];
    recallReleaseCoverageComplete: boolean;
    recallReleaseGatePassed: boolean;
    selectedGateProfile: MemoryEvaluationGateProfile;
    selectedProfileCoverageComplete: boolean;
    selectedProfileGatePassed: boolean;
  }>;
  sanitizedAggregatesOnly: true;
  versions: Readonly<{
    pgvector: string;
    pipeline: string;
    policy: string;
    postgresql: string;
    prompt: string;
    randomSeed: number;
    retrievalConfigFingerprint: string;
    schema: string;
    scorer: string;
    suite: string;
  }>;
}>;

function validToken(value: unknown): value is string {
  return typeof value === "string" && safeToken.test(value);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateConfig(config: MemoryEvaluationConfig): void {
  if (
    !Number.isSafeInteger(config.bootstrapSamples) ||
    config.bootstrapSamples < 100 ||
    config.bootstrapSamples > 100_000 ||
    !sha256.test(config.corpusHash) ||
    !Number.isSafeInteger(config.randomSeed) ||
    config.randomSeed < 0 ||
    config.randomSeed > 0xffff_ffff ||
    !MEMORY_EVALUATION_GATE_PROFILES.includes(config.gateProfile) ||
    config.scorerVersion !== MEMORY_EVALUATION_SCORER_VERSION ||
    ![
      config.corpusVersion,
      config.pgvectorVersion,
      config.pipelineVersion,
      config.policyVersion,
      config.postgresqlVersion,
      config.promptVersion,
      config.retrievalConfigFingerprint,
      config.schemaVersion,
      config.suiteVersion
    ].every(validToken)
  ) {
    throw new MemoryEvaluationError("memory_evaluation_config_invalid");
  }
}

function fingerprintIsValid(value: unknown): value is MemoryEvaluationSystemFingerprint {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasExactKeys(value, [
    "configFingerprint",
    "deploymentFingerprint",
    "modelFingerprint",
    "providerFingerprint",
    "role",
    "vectorSpaceFingerprint"
  ])) return false;
  const candidate = value as MemoryEvaluationSystemFingerprint;
  return [
    candidate.configFingerprint,
    candidate.deploymentFingerprint,
    candidate.modelFingerprint,
    candidate.providerFingerprint,
    candidate.role
  ].every(validToken) && MEMORY_CAPABILITY_ROLES.includes(candidate.role) && (
    candidate.vectorSpaceFingerprint === null || validToken(candidate.vectorSpaceFingerprint)
  );
}

function validateAdapter(adapter: MemoryEvaluationAdapter<unknown>): void {
  if (
    !MEMORY_EVALUATION_ADAPTER_KINDS.includes(adapter.kind) ||
    !validToken(adapter.adapterVersion) ||
    typeof adapter.liveProvider !== "boolean" ||
    typeof adapter.run !== "function" ||
    !Array.isArray(adapter.fingerprints) ||
    !adapter.fingerprints.every(fingerprintIsValid) ||
    new Set(adapter.fingerprints.map(({ role }) => role)).size !== adapter.fingerprints.length ||
    (adapter.liveProvider &&
      (adapter.kind !== "AIQSA_NATIVE" || adapter.fingerprints.length === 0)) ||
    (adapter.kind === "NO_MEMORY_BASELINE" &&
      (adapter.liveProvider || adapter.fingerprints.length !== 0))
  ) {
    throw new MemoryEvaluationError("memory_evaluation_adapter_invalid");
  }
}

function normalizedFixtureForHash(fixture: MemoryEvaluationFixture<unknown>): unknown {
  return {
    corpusVersion: fixture.corpusVersion,
    dataClass: fixture.dataClass,
    groupId: fixture.groupId,
    id: fixture.id,
    input: fixture.input,
    language: fixture.language,
    noMemoryBaseline: fixture.noMemoryBaseline,
    split: fixture.split,
    tags: [...fixture.tags].sort()
  };
}

export function hashMemoryEvaluationCorpus(
  fixtures: readonly MemoryEvaluationFixture<unknown>[]
): string {
  return memoryEvaluationSha256(
    [...fixtures]
      .sort((left, right) => compareMemoryEvaluationText(left.id, right.id))
      .map(normalizedFixtureForHash)
  );
}

function validateCorpus(
  fixtures: readonly MemoryEvaluationFixture<unknown>[],
  config: MemoryEvaluationConfig
): void {
  if (fixtures.length === 0 || new Set(fixtures.map(({ id }) => id)).size !== fixtures.length) {
    throw new MemoryEvaluationError("memory_evaluation_corpus_invalid");
  }
  const groupSplits = new Map<string, MemoryEvaluationSplit>();
  for (const fixture of fixtures) {
    if (
      !validToken(fixture.id) ||
      !validToken(fixture.groupId) ||
      fixture.corpusVersion !== config.corpusVersion ||
      !MEMORY_EVALUATION_LANGUAGES.includes(fixture.language) ||
      !MEMORY_EVALUATION_SPLITS.includes(fixture.split) ||
      !["SYNTHETIC", "APPROVED_PUBLIC_BENCHMARK"].includes(fixture.dataClass) ||
      !Array.isArray(fixture.tags) ||
      fixture.tags.some((tag) => !validToken(tag))
    ) {
      throw new MemoryEvaluationError("memory_evaluation_corpus_invalid");
    }
    const existingSplit = groupSplits.get(fixture.groupId);
    if (existingSplit && existingSplit !== fixture.split) {
      throw new MemoryEvaluationError("memory_evaluation_corpus_invalid");
    }
    groupSplits.set(fixture.groupId, fixture.split);
  }
  let computedHash: string;
  try {
    computedHash = hashMemoryEvaluationCorpus(fixtures);
  } catch {
    throw new MemoryEvaluationError("memory_evaluation_corpus_invalid");
  }
  if (computedHash !== config.corpusHash) {
    throw new MemoryEvaluationError("memory_evaluation_corpus_hash_mismatch");
  }
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareMemoryEvaluationText);
}

type GateProfileStatus = Readonly<{
  coverageComplete: boolean;
  gatePassed: boolean;
}>;

function gateProfileStatus(
  binary: readonly MemoryBinaryScore[],
  ranked: readonly MemoryRankedScore[],
  requiredBinary: readonly MemoryBinaryScore["metric"][],
  requiredRanked: readonly MemoryRankedScore["metric"][]
): GateProfileStatus {
  const coverageComplete = MEMORY_EVALUATION_LANGUAGES.every((language) =>
    requiredBinary.every((metric) =>
      binary.some((score) =>
        score.cohort === "overall" && score.language === language && score.metric === metric
      )
    ) && requiredRanked.every((metric) =>
      ranked.some((score) =>
        score.cohort === "overall" && score.language === language && score.metric === metric
      )
    )
  );
  const relevantScores = [
    ...binary.filter(({ metric }) => requiredBinary.includes(metric)),
    ...ranked.filter(({ metric }) => requiredRanked.includes(metric))
  ];
  return {
    coverageComplete,
    gatePassed: coverageComplete && relevantScores.every(({ gatePassed }) => gatePassed === true)
  };
}

export async function runMemoryEvaluation<Input>(input: {
  adapter: MemoryEvaluationAdapter<Input>;
  config: MemoryEvaluationConfig;
  fixtures: readonly MemoryEvaluationFixture<Input>[];
}): Promise<MemoryEvaluationEvidence> {
  validateConfig(input.config);
  validateAdapter(input.adapter as MemoryEvaluationAdapter<unknown>);
  validateCorpus(
    input.fixtures as readonly MemoryEvaluationFixture<unknown>[],
    input.config
  );

  const binaryOutcomes: Array<{ language: MemoryEvaluationLanguage; outcome: MemoryBinaryOutcome }> = [];
  const rankedOutcomes: Array<{ language: MemoryEvaluationLanguage; outcome: MemoryRankedOutcome }> = [];
  const hardInvariants: MemoryHardInvariantObservation[] = [];
  const operations: MemoryOperationObservation[] = [];

  const fixtures = [...input.fixtures].sort((left, right) =>
    compareMemoryEvaluationText(left.id, right.id)
  );
  for (const fixture of fixtures) {
    const fixtureSeed = deriveMemoryEvaluationSeed(input.config.randomSeed, fixture.id);
    let rawObservation: unknown;
    try {
      rawObservation = await input.adapter.run(fixture, {
        corpusHash: input.config.corpusHash,
        fixtureSeed,
        pipelineVersion: input.config.pipelineVersion,
        policyVersion: input.config.policyVersion,
        promptVersion: input.config.promptVersion,
        randomSeed: input.config.randomSeed,
        schemaVersion: input.config.schemaVersion,
        scorerVersion: input.config.scorerVersion,
        suiteVersion: input.config.suiteVersion
      });
    } catch (error) {
      if (error instanceof MemoryEvaluationError) throw error;
      throw new MemoryEvaluationError("memory_evaluation_observation_invalid");
    }
    const observation = decodeMemoryEvaluationObservation(rawObservation);
    if (!observation) {
      throw new MemoryEvaluationError("memory_evaluation_observation_invalid");
    }
    if (observation.fixtureId !== fixture.id || observation.language !== fixture.language) {
      throw new MemoryEvaluationError("memory_evaluation_observation_mismatch");
    }
    binaryOutcomes.push(...observation.binaryOutcomes.map((outcome) => ({
      language: fixture.language,
      outcome
    })));
    rankedOutcomes.push(...observation.rankedOutcomes.map((outcome) => ({
      language: fixture.language,
      outcome
    })));
    hardInvariants.push(...observation.hardInvariants);
    operations.push(...observation.operations);
  }

  const binary = scoreMemoryBinaryOutcomes(binaryOutcomes);
  const ranked = scoreMemoryRankedOutcomes(rankedOutcomes, {
    samples: input.config.bootstrapSamples,
    seed: input.config.randomSeed
  });
  const invariantScores = scoreMemoryHardInvariants(hardInvariants);
  const gatedScores = [...binary, ...ranked].filter(({ gate }) => gate !== null);
  const observedGatesPassed = gatedScores.every(({ gatePassed }) => gatePassed === true);
  const recallRelease = gateProfileStatus(
    binary,
    ranked,
    MEMORY_RECALL_RELEASE_REQUIRED_BINARY_METRICS,
    MEMORY_RECALL_RELEASE_REQUIRED_RANKED_METRICS
  );
  const automaticLearningBeta = gateProfileStatus(
    binary,
    ranked,
    MEMORY_BETA_REQUIRED_BINARY_METRICS,
    MEMORY_BETA_REQUIRED_RANKED_METRICS
  );
  const selectedProfile = input.config.gateProfile === "RECALL_RELEASE"
    ? recallRelease
    : automaticLearningBeta;

  return {
    adapter: {
      fingerprints: [...input.adapter.fingerprints].sort((left, right) =>
        compareMemoryEvaluationText(left.role, right.role)
      ),
      kind: input.adapter.kind,
      version: input.adapter.adapterVersion
    },
    corpus: {
      hash: input.config.corpusHash,
      languages: uniqueSorted(fixtures.map(({ language }) => language)),
      splits: uniqueSorted(fixtures.map(({ split }) => split)),
      version: input.config.corpusVersion
    },
    evidenceVersion: MEMORY_EVALUATION_EVIDENCE_VERSION,
    hardInvariants: invariantScores,
    operations: scoreMemoryOperations(operations),
    passed: invariantScores.passed && selectedProfile.gatePassed,
    quality: {
      automaticLearningBetaCoverageComplete: automaticLearningBeta.coverageComplete,
      automaticLearningBetaGatePassed: automaticLearningBeta.gatePassed,
      binary,
      gatedMetricCount: gatedScores.length,
      observedGatesPassed,
      ranked,
      recallReleaseCoverageComplete: recallRelease.coverageComplete,
      recallReleaseGatePassed: recallRelease.gatePassed,
      selectedGateProfile: input.config.gateProfile,
      selectedProfileCoverageComplete: selectedProfile.coverageComplete,
      selectedProfileGatePassed: selectedProfile.gatePassed
    },
    sanitizedAggregatesOnly: true,
    versions: {
      pgvector: input.config.pgvectorVersion,
      pipeline: input.config.pipelineVersion,
      policy: input.config.policyVersion,
      postgresql: input.config.postgresqlVersion,
      prompt: input.config.promptVersion,
      randomSeed: input.config.randomSeed,
      retrievalConfigFingerprint: input.config.retrievalConfigFingerprint,
      schema: input.config.schemaVersion,
      scorer: input.config.scorerVersion,
      suite: input.config.suiteVersion
    }
  };
}
