import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { ModelRunUsage } from "../lib/domain/modelRunEvents";
import { estimateCostMicros } from "../lib/domain/usage";
import { memoryEvaluationSha256 } from "../lib/evaluation/memory/canonical";
import type {
  MemoryEvaluationLanguage,
  MemoryOperationObservation,
  MemoryEvaluationSystemFingerprint
} from "../lib/evaluation/memory/contracts";
import {
  MEMORY_PHASE7_BOOTSTRAP_SAMPLES,
  MEMORY_PHASE7_CORPUS_VERSION,
  MEMORY_PHASE7_EVALUATOR_VERSION,
  MEMORY_PHASE7_EVIDENCE_VERSION,
  MEMORY_PHASE7_HOLDOUT_CORPUS_HASH,
  MEMORY_PHASE7_RANDOM_SEED,
  MEMORY_PHASE7_SCORER_VERSION,
  MEMORY_PHASE7_SUITE_VERSION,
  decideMemoryPhase7Profile,
  memoryPhase7EvidenceIdentityIsCurrent,
  memoryPhase7RussianTextPreservesLanguage
} from "../lib/evaluation/memory/phase7";
import { scoreMemoryOperations } from "../lib/evaluation/memory/scorers";
import { prisma } from "../lib/server/prisma";
import { requireAdminAcceptedMemoryDestination } from
  "../lib/server/memory/execution/adminConsent";
import { resolveMemoryEgressConsentMode } from
  "../lib/server/memory/execution/consentMode";
import {
  requireAcceptedMemoryUtilityPolicy,
  resolveCurrentMemoryUtilityPolicy,
  type ResolvedMemoryExecutionTarget
} from "../lib/server/memory/execution/policy";
import { detectMemoryTextLanguage } from
  "../lib/server/memory/history/language";
import { memorySha256 } from "../lib/server/memory/persistence/lexical";
import {
  MEMORY_PROFILE_MAX_INPUT_FACTS,
  MEMORY_PROFILE_VERSIONS,
  memoryProfileInputHash,
  type MemoryProfileCandidate,
  type MemoryProfileInput
} from "../lib/server/memory/profile/contract";
import { decodeMemoryProfile } from "../lib/server/memory/profile/decoder";
import {
  createAcceptedMemoryProfileProvider,
  MemoryProfileProviderCallError,
  type MemoryProfileProviderEvidence
} from "../lib/server/memory/profile/runtime";
import { loadMemoryTuningCorpus } from
  "../tests/fixtures/memory-evaluation/tuning/corpus";
import type {
  MemoryCorpusExpectedFact,
  MemoryCorpusFixture
} from "../tests/fixtures/memory-evaluation/shared/corpusTypes";

const HOLDOUT_CASES_PER_LANGUAGE = 20;
const PROVIDER_TIMEOUT_MS = 300_000;
let failureStage = "startup";

type Split = "HOLDOUT" | "TUNING";
type CorpusManifest = Readonly<{
  corpusVersion: string;
  splits: Readonly<Record<Split, Readonly<{ contentHash: string }>>>;
}>;

type ProfileSourceFact = Readonly<{
  fact: MemoryCorpusExpectedFact;
  fixtureId: string;
  language: MemoryEvaluationLanguage;
}>;

function hasArgument(value: string): boolean {
  return process.argv.slice(2).includes(value);
}

function argumentValue(prefix: string): string | null {
  return process.argv.slice(2).find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length).trim() || null;
}

function selectedSplit(): Split {
  if (hasArgument("--split=tuning")) return "TUNING";
  if (hasArgument("--split=holdout")) return "HOLDOUT";
  throw new Error("memory_phase7_profile_split_required");
}

function privateEvidenceOutputPath(): string {
  const value = argumentValue("--evidence-output=");
  if (!value) throw new Error("memory_phase7_profile_evidence_output_required");
  const privateRoot = resolve(".aiqsa");
  const target = resolve(value);
  if (target === privateRoot || !target.startsWith(`${privateRoot}${sep}`)) {
    throw new Error("memory_phase7_profile_evidence_output_invalid");
  }
  return target;
}

function casesPerLanguage(split: Split): number {
  const raw = argumentValue("--cases-per-language=");
  if (split === "HOLDOUT") {
    if (raw !== null) throw new Error("memory_phase7_profile_holdout_subset_forbidden");
    return HOLDOUT_CASES_PER_LANGUAGE;
  }
  const value = Number(raw ?? "4");
  if (!Number.isSafeInteger(value) || value < 1 ||
      value > HOLDOUT_CASES_PER_LANGUAGE) {
    throw new Error("memory_phase7_profile_tuning_subset_invalid");
  }
  return value;
}

async function loadManifest(): Promise<CorpusManifest> {
  const value = JSON.parse(await readFile(
    "tests/fixtures/memory-evaluation/manifests/corpus-v2.json",
    "utf8"
  )) as CorpusManifest;
  if (
    value.corpusVersion !== MEMORY_PHASE7_CORPUS_VERSION ||
    value.splits.HOLDOUT.contentHash !== MEMORY_PHASE7_HOLDOUT_CORPUS_HASH ||
    !/^[a-f0-9]{64}$/u.test(value.splits.TUNING.contentHash)
  ) throw new Error("memory_phase7_profile_manifest_invalid");
  return value;
}

function requireLiveAuthorization(split: Split, manifest: CorpusManifest): void {
  if (!hasArgument("--authorized-live-provider")) {
    throw new Error("memory_phase7_profile_live_provider_authorization_required");
  }
  if (split === "HOLDOUT" && !hasArgument(
    `--holdout-corpus-hash=${manifest.splits.HOLDOUT.contentHash}`
  )) throw new Error("memory_phase7_profile_holdout_hash_authorization_required");
}

async function loadCorpus(split: Split): Promise<readonly MemoryCorpusFixture[]> {
  if (split === "TUNING") return loadMemoryTuningCorpus();
  const { loadMemoryHoldoutCorpus } = await import(
    "../tests/fixtures/memory-evaluation/holdout/corpus"
  );
  return loadMemoryHoldoutCorpus({
    expectedCorpusVersion: MEMORY_PHASE7_CORPUS_VERSION,
    purpose: "SCORING_ONLY"
  });
}

function eligibleFacts(
  fixtures: readonly MemoryCorpusFixture[],
  language: MemoryEvaluationLanguage
): readonly ProfileSourceFact[] {
  return fixtures.flatMap((fixture) => fixture.language === language
    ? fixture.expectedFacts.flatMap((fact) =>
        fact.state === "ACTIVE" &&
        fact.scope.type === "GLOBAL_USER" &&
        fact.sensitivity === "NORMAL" &&
        fact.displayText.length <= 500
          ? [{ fact, fixtureId: fixture.id, language }]
          : []
      )
    : []
  ).sort((left, right) => memorySha256({
    fixtureId: left.fixtureId,
    text: left.fact.displayText
  }).localeCompare(memorySha256({
    fixtureId: right.fixtureId,
    text: right.fact.displayText
  })));
}

function profileCandidate(
  source: ProfileSourceFact,
  caseIndex: number,
  candidateIndex: number
): MemoryProfileCandidate {
  const identity = memorySha256({
    candidateIndex,
    caseIndex,
    fixtureId: source.fixtureId,
    language: source.language,
    sourceMessageIds: source.fact.sourceMessageIds,
    text: source.fact.displayText
  });
  const temperatureClass = candidateIndex < 4
    ? "HOT"
    : candidateIndex < 8 ? "WARM" : "COLD";
  return {
    factId: `qualification-fact-${identity.slice(0, 32)}`,
    factVersionContentHash: memorySha256({ identity, kind: "content" }),
    factVersionId: `qualification-version-${identity.slice(0, 32)}`,
    safetyIdentitySnapshot: memorySha256({ identity, kind: "safety" }),
    sourceIdentitySnapshot: memorySha256({ identity, kind: "source" }),
    suppressionIdentitySnapshot: memorySha256({ identity, kind: "suppression" }),
    temperatureClass,
    temperatureScore: temperatureClass === "HOT" ? 0.95 :
      temperatureClass === "WARM" ? 0.65 : 0.25,
    text: source.fact.displayText
  };
}

function profileInputs(
  fixtures: readonly MemoryCorpusFixture[],
  count: number
): readonly Readonly<{ input: MemoryProfileInput; language: MemoryEvaluationLanguage }>[] {
  return (["RU", "EN"] as const).flatMap((language) => {
    const sources = eligibleFacts(fixtures, language);
    const required = count * MEMORY_PROFILE_MAX_INPUT_FACTS;
    if (sources.length < required) {
      throw new Error("memory_phase7_profile_corpus_coverage_incomplete");
    }
    return Array.from({ length: count }, (_, caseIndex) => {
      const candidates = sources
        .slice(
          caseIndex * MEMORY_PROFILE_MAX_INPUT_FACTS,
          (caseIndex + 1) * MEMORY_PROFILE_MAX_INPUT_FACTS
        )
        .map((source, candidateIndex) =>
          profileCandidate(source, caseIndex, candidateIndex)
        );
      const identity = memorySha256({ candidates, caseIndex, language });
      const withoutHash: Omit<MemoryProfileInput, "inputHash"> = {
        asOf: "2026-08-11T12:00:00.000Z",
        candidates,
        languageCode: language.toLowerCase() as "en" | "ru",
        memoryGeneration: 1,
        memoryRevision: caseIndex + 1,
        redactionState: "NOT_NEEDED",
        safetyIdentitySnapshot: memorySha256({ identity, kind: "safety" }),
        scopeId: `qualification-global-${language.toLowerCase()}-${caseIndex}`,
        sourceIdentitySnapshot: memorySha256({ identity, kind: "source" }),
        suppressionIdentitySnapshot: memorySha256({ identity, kind: "suppression" })
      };
      return {
        input: { ...withoutHash, inputHash: memoryProfileInputHash(withoutHash) },
        language
      };
    });
  });
}

function roleFingerprint(
  target: ResolvedMemoryExecutionTarget
): MemoryEvaluationSystemFingerprint {
  return {
    ...target.qualificationFingerprints,
    role: "MEMORY_PROFILE",
    vectorSpaceFingerprint: null
  };
}

function providerEvidence(
  target: ResolvedMemoryExecutionTarget
): MemoryProfileProviderEvidence {
  const snapshot = target.snapshot;
  if (!snapshot.credentialId || !snapshot.credentialVersionId) {
    throw new Error("memory_phase7_profile_target_invalid");
  }
  return {
    connectionId: target.authority.connectionId,
    credentialId: target.authority.credentialId,
    credentialVersionId: target.authority.credentialVersionId,
    executionSnapshot: snapshot,
    logicalRole: "MEMORY_PROFILE",
    providerModelId: target.authority.providerModelId
  };
}

function operation(
  usage: ModelRunUsage,
  latencyMs: number,
  pricing: Readonly<{
    inputTokenPriceMicros: number;
    outputTokenPriceMicros: number;
    reasoningTokenPriceMicros: number;
  }>,
  retries: number
): MemoryOperationObservation {
  const pricingConfigured = pricing.inputTokenPriceMicros > 0 ||
    pricing.outputTokenPriceMicros > 0;
  const costMicros = usage.estimatedCostMicros ?? (pricingConfigured
    ? estimateCostMicros(usage, pricing)
    : null);
  return {
    estimatedCostUsd: costMicros === null ? null : costMicros / 1_000_000,
    inputTokens: usage.inputTokens,
    latencyMs,
    outputTokens: usage.outputTokens,
    retries,
    role: "MEMORY_PROFILE"
  };
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

async function main(): Promise<void> {
  failureStage = "arguments";
  const split = selectedSplit();
  const caseCount = casesPerLanguage(split);
  const outputPath = privateEvidenceOutputPath();
  const manifest = await loadManifest();
  requireLiveAuthorization(split, manifest);

  failureStage = "corpus";
  const fixtures = await loadCorpus(split);
  const cases = profileInputs(fixtures, caseCount);

  failureStage = "authority";
  const users = await prisma.user.findMany({
    select: { id: true },
    where: { role: "admin", status: "active" }
  });
  if (users.length !== 1) throw new Error("memory_phase7_profile_admin_ambiguous");
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({
    select: {
      acceptedUtilityEgressAt: true,
      acceptedUtilityEgressFingerprint: true,
      acceptedUtilityPolicyVersion: true,
      embeddingProviderModelId: true
    },
    where: { userId: users[0]!.id }
  });
  const policy = await resolveCurrentMemoryUtilityPolicy(prisma, users[0]!.id, settings);
  const target = policy.targets.get("MEMORY_PROFILE");
  if (!target) throw new Error("memory_phase7_profile_target_unavailable");
  if (resolveMemoryEgressConsentMode() === "ADMIN") {
    await requireAdminAcceptedMemoryDestination(prisma, {
      role: "MEMORY_PROFILE",
      target
    });
  } else {
    requireAcceptedMemoryUtilityPolicy(settings, policy, "PER_USER");
  }
  const pricingRow = await prisma.providerModel.findUniqueOrThrow({
    select: { inputTokenPriceMicros: true, outputTokenPriceMicros: true },
    where: { id: target.authority.providerModelId }
  });
  const pricing = {
    inputTokenPriceMicros: pricingRow.inputTokenPriceMicros,
    outputTokenPriceMicros: pricingRow.outputTokenPriceMicros,
    reasoningTokenPriceMicros: pricingRow.outputTokenPriceMicros
  };
  if (hasArgument("--preflight-only")) {
    process.stdout.write(`${JSON.stringify({
      cases: cases.length,
      fingerprint: roleFingerprint(target),
      pricingConfigured: pricing.inputTokenPriceMicros > 0 ||
        pricing.outputTokenPriceMicros > 0,
      providerCalls: 0,
      ready: true,
      split,
      versions: MEMORY_PROFILE_VERSIONS
    }, null, 2)}\n`);
    await prisma.$disconnect();
    return;
  }

  failureStage = "provider";
  const provider = createAcceptedMemoryProfileProvider(prisma);
  const evidence = providerEvidence(target);
  const operations: MemoryOperationObservation[] = [];
  const compressionRatios: number[] = [];
  const projectionCostsUsd: (number | null)[] = [];
  const projectionLatenciesMs: number[] = [];
  let decodeFailures = 0;
  let providerFailures = 0;
  let producedCases = 0;
  let russianLanguagePreserved = 0;
  let russianSegments = 0;
  let supportedSegments = 0;
  let totalSegments = 0;
  for (const [index, current] of cases.entries()) {
    const projectionStartedAt = performance.now();
    let projectionCostUsd: number | null = 0;
    let completed = false;
    for (let attempt = 0; attempt < 2 && !completed; attempt += 1) {
      const startedAt = performance.now();
      try {
        const result = await provider.run(
          evidence,
          current.input,
          AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
        );
        const observation = operation(
          result.usage,
          performance.now() - startedAt,
          pricing,
          attempt
        );
        operations.push(observation);
        projectionCostUsd = projectionCostUsd === null ||
          observation.estimatedCostUsd === null
          ? null
          : projectionCostUsd + observation.estimatedCostUsd;
        try {
          const plan = decodeMemoryProfile(result.toolCalls, current.input);
          producedCases += 1;
          supportedSegments += plan.segments.length;
          totalSegments += plan.segments.length;
          const candidateCharacters = current.input.candidates.reduce(
            (sum, candidate) => sum + candidate.text.length,
            0
          );
          const outputCharacters = plan.segments.reduce(
            (sum, segment) => sum + segment.text.length,
            0
          );
          compressionRatios.push(outputCharacters / candidateCharacters);
          if (current.language === "RU") {
            russianSegments += plan.segments.length;
            russianLanguagePreserved += plan.segments.filter((segment) =>
              memoryPhase7RussianTextPreservesLanguage(
                detectMemoryTextLanguage(segment.text)
              )
            ).length;
          }
        } catch {
          decodeFailures += 1;
          if (current.language === "RU") russianSegments += 1;
          totalSegments += 1;
          compressionRatios.push(1);
        }
        completed = true;
      } catch (error) {
        const usage = error instanceof MemoryProfileProviderCallError
          ? error.usage
          : null;
        if (usage) {
          const observation = operation(
            usage,
            performance.now() - startedAt,
            pricing,
            attempt
          );
          operations.push(observation);
          projectionCostUsd = projectionCostUsd === null ||
            observation.estimatedCostUsd === null
            ? null
            : projectionCostUsd + observation.estimatedCostUsd;
        }
        if (attempt === 0 && error instanceof MemoryProfileProviderCallError) continue;
        providerFailures += 1;
        if (!usage) projectionCostUsd = null;
        if (current.language === "RU") russianSegments += 1;
        totalSegments += 1;
        compressionRatios.push(1);
        completed = true;
      }
    }
    projectionCostsUsd.push(projectionCostUsd);
    projectionLatenciesMs.push(performance.now() - projectionStartedAt);
    if ((index + 1) % 5 === 0 || index + 1 === cases.length) {
      process.stderr.write(`[memory-phase7-profile] ${index + 1}/${cases.length}\n`);
    }
  }

  failureStage = "scoring";
  const latencyP95Ms = percentile95(projectionLatenciesMs);
  const totalCost = projectionCostsUsd.every((current) => current !== null)
    ? projectionCostsUsd.reduce<number>((sum, current) => sum + current!, 0)
    : null;
  const estimatedCostUsdPerProjection = totalCost === null
    ? null
    : totalCost / projectionCostsUsd.length;
  const profileDecision = decideMemoryPhase7Profile({
    compressionRatios,
    eligibleCases: cases.length,
    estimatedCostUsdPerProjection,
    latencyP95Ms,
    producedCases,
    russianLanguagePreserved,
    russianSegments,
    supportedSegments,
    totalSegments
  });
  const identity = {
    bootstrapSamples: MEMORY_PHASE7_BOOTSTRAP_SAMPLES,
    corpusHash: manifest.splits[split].contentHash,
    corpusVersion: MEMORY_PHASE7_CORPUS_VERSION,
    evaluatorVersion: MEMORY_PHASE7_EVALUATOR_VERSION,
    evidenceVersion: MEMORY_PHASE7_EVIDENCE_VERSION,
    randomSeed: MEMORY_PHASE7_RANDOM_SEED,
    scorerVersion: MEMORY_PHASE7_SCORER_VERSION,
    suiteVersion: MEMORY_PHASE7_SUITE_VERSION
  };
  const fullHoldout = split === "HOLDOUT" &&
    cases.length === HOLDOUT_CASES_PER_LANGUAGE * 2;
  const evidenceOutput = {
    adapter: {
      fingerprints: [roleFingerprint(target)],
      kind: "AIQSA_NATIVE",
      liveProvider: true,
      version: MEMORY_PHASE7_EVALUATOR_VERSION
    },
    corpus: {
      evaluatedCases: cases.length,
      hash: manifest.splits[split].contentHash,
      sourceFixtures: fixtures.length,
      split,
      version: MEMORY_PHASE7_CORPUS_VERSION
    },
    evaluatedAt: new Date().toISOString(),
    evidenceVersion: MEMORY_PHASE7_EVIDENCE_VERSION,
    operations: scoreMemoryOperations(operations),
    passed: profileDecision.enabled && providerFailures === 0 &&
      (split === "TUNING" || fullHoldout && memoryPhase7EvidenceIdentityIsCurrent(identity)),
    profile: {
      ...profileDecision,
      decodeFailures,
      eligibleCases: cases.length,
      estimatedCostUsdPerProjection,
      latencyP95Ms,
      providerFailures,
      producedCases,
      russianLanguagePreserved,
      russianSegments,
      supportedSegments,
      totalSegments
    },
    sanitizedAggregatesOnly: true,
    versions: {
      ...identity,
      profile: MEMORY_PROFILE_VERSIONS
    }
  };

  failureStage = "output";
  const persistedEvidence = JSON.parse(JSON.stringify(evidenceOutput)) as unknown;
  const evidenceDigest = memoryEvaluationSha256(persistedEvidence);
  await mkdir(dirname(outputPath), { mode: 0o700, recursive: true });
  await writeFile(outputPath, `${JSON.stringify({
    evidence: persistedEvidence,
    evidenceDigest
  }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    evidenceDigest,
    outputPath: relative(process.cwd(), outputPath),
    passed: evidenceOutput.passed,
    profile: evidenceOutput.profile,
    split
  }, null, 2)}\n`);
  await prisma.$disconnect();
}

void main().catch(async (error: unknown) => {
  const code = error instanceof Error && /^memory_[a-z0-9_]+$/u.test(error.message)
    ? error.message
    : "memory_phase7_profile_evaluation_failed";
  process.stderr.write(`${code}:${failureStage}\n`);
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => undefined);
});
