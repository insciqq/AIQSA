import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_EVALUATION_SCORER_VERSION,
  createAiqsaNativeEvaluationAdapter,
  zeroMemoryHardInvariantObservations,
  type MemoryEvaluationAdapter,
  type MemoryEvaluationConfig,
  type MemoryEvaluationFixture
} from "./contracts";
import { hashMemoryEvaluationCorpus } from "./harness";
import {
  MEMORY_LIVE_AUTHORIZATION_VERSION,
  memoryEvaluationAdapterFingerprint,
  memoryEvaluationConfigFingerprint,
  runAuthorizedSyntheticMemoryEvaluation,
  type MemorySyntheticLiveAuthorization
} from "./liveRunner";

function fixture(
  overrides: Partial<MemoryEvaluationFixture<{ prompt: string }>> = {}
): MemoryEvaluationFixture<{ prompt: string }> {
  return {
    corpusVersion: "live-corpus-v1",
    dataClass: "SYNTHETIC",
    groupId: "live-group-1",
    id: "live-fixture-1",
    input: { prompt: "synthetic-private-provider-prompt" },
    language: "RU",
    noMemoryBaseline: {
      binaryOutcomes: [],
      hardInvariants: zeroMemoryHardInvariantObservations(),
      operations: [],
      rankedOutcomes: []
    },
    split: "HOLDOUT",
    tags: ["live", "synthetic"],
    ...overrides
  };
}

function config(fixtures: readonly MemoryEvaluationFixture<unknown>[]): MemoryEvaluationConfig {
  return {
    bootstrapSamples: 200,
    corpusHash: hashMemoryEvaluationCorpus(fixtures),
    corpusVersion: "live-corpus-v1",
    gateProfile: "RECALL_RELEASE",
    pgvectorVersion: "0.8.5",
    pipelineVersion: "pipeline-v1",
    policyVersion: "policy-v1",
    postgresqlVersion: "16.14",
    promptVersion: "prompt-v1",
    randomSeed: 17,
    retrievalConfigFingerprint: "retrieval-v1",
    schemaVersion: "schema-v1",
    scorerVersion: MEMORY_EVALUATION_SCORER_VERSION,
    suiteVersion: "live-suite-v1"
  };
}

function liveAdapter(run = vi.fn(async (current: MemoryEvaluationFixture<{ prompt: string }>) => ({
  binaryOutcomes: [],
  fixtureId: current.id,
  hardInvariants: zeroMemoryHardInvariantObservations(),
  language: current.language,
  operations: [],
  rankedOutcomes: []
}))): MemoryEvaluationAdapter<{ prompt: string }> {
  return createAiqsaNativeEvaluationAdapter({
    adapterVersion: "native-live-fake-v1",
    fingerprints: [{
      configFingerprint: "config-v1",
      deploymentFingerprint: "deployment-v1",
      modelFingerprint: "model-v1",
      providerFingerprint: "provider-v1",
      role: "MEMORY_FACT_EXTRACT",
      vectorSpaceFingerprint: null
    }],
    liveProvider: true,
    run
  });
}

function authorization<Input>(
  adapter: MemoryEvaluationAdapter<Input>,
  currentConfig: MemoryEvaluationConfig
): MemorySyntheticLiveAuthorization {
  return {
    adapterFingerprint: memoryEvaluationAdapterFingerprint(adapter),
    adapterKind: "AIQSA_NATIVE",
    adapterVersion: adapter.adapterVersion,
    approvalId: "operator-approval-1",
    approvedAt: "2026-08-09T10:00:00.000Z",
    approvedBy: "operator-1",
    authorizationVersion: MEMORY_LIVE_AUTHORIZATION_VERSION,
    corpusHash: currentConfig.corpusHash,
    evaluationConfigFingerprint: memoryEvaluationConfigFingerprint(currentConfig),
    expiresAt: "2026-08-10T10:00:00.000Z",
    operatorApproved: true,
    suiteVersion: currentConfig.suiteVersion,
    syntheticOnly: true
  };
}

describe("Memory synthetic live evaluation gate", () => {
  it("does not invoke an adapter without exact current authorization", async () => {
    const fixtures = [fixture()];
    const run = vi.fn(async (current: MemoryEvaluationFixture<{ prompt: string }>) => ({
      binaryOutcomes: [],
      fixtureId: current.id,
      hardInvariants: zeroMemoryHardInvariantObservations(),
      language: current.language,
      operations: [],
      rankedOutcomes: []
    }));
    const adapter = liveAdapter(run);
    const currentConfig = config(fixtures);

    expect(await runAuthorizedSyntheticMemoryEvaluation({
      adapter,
      authorization: null,
      config: currentConfig,
      fixtures,
      now: "2026-08-09T12:00:00.000Z"
    })).toEqual({
      adapterInvoked: false,
      code: "memory_live_authorization_invalid",
      ok: false
    });
    expect(run).not.toHaveBeenCalled();

    expect(await runAuthorizedSyntheticMemoryEvaluation({
      adapter,
      authorization: { ...authorization(adapter, currentConfig), suiteVersion: "stale-suite" },
      config: currentConfig,
      fixtures,
      now: "2026-08-09T12:00:00.000Z"
    })).toMatchObject({
      adapterInvoked: false,
      code: "memory_live_authorization_stale",
      ok: false
    });
    expect(run).not.toHaveBeenCalled();

    expect(await runAuthorizedSyntheticMemoryEvaluation({
      adapter,
      authorization: authorization(adapter, currentConfig),
      config: { ...currentConfig, promptVersion: "prompt-v2" },
      fixtures,
      now: "2026-08-09T12:00:00.000Z"
    })).toMatchObject({
      adapterInvoked: false,
      code: "memory_live_authorization_stale",
      ok: false
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects public/tuning input before adapter invocation even with matching approval", async () => {
    const fixtures = [fixture({ dataClass: "APPROVED_PUBLIC_BENCHMARK" })];
    const run = vi.fn();
    const adapter = liveAdapter(run);
    const currentConfig = config(fixtures);
    expect(await runAuthorizedSyntheticMemoryEvaluation({
      adapter,
      authorization: authorization(adapter, currentConfig),
      config: currentConfig,
      fixtures,
      now: "2026-08-09T12:00:00.000Z"
    })).toMatchObject({
      adapterInvoked: false,
      code: "memory_live_non_synthetic_corpus",
      ok: false
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns sanitized aggregates only for an authorized synthetic HOLDOUT run", async () => {
    const fixtures = [fixture()];
    const adapter = liveAdapter();
    const currentConfig = config(fixtures);
    const result = await runAuthorizedSyntheticMemoryEvaluation({
      adapter,
      authorization: authorization(adapter, currentConfig),
      config: currentConfig,
      fixtures,
      now: "2026-08-09T12:00:00.000Z"
    });
    expect(result).toMatchObject({
      adapterInvoked: true,
      evidence: {
        adapter: { kind: "AIQSA_NATIVE" },
        hardInvariants: { passed: true },
        sanitizedAggregatesOnly: true
      },
      ok: true
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("synthetic-private-provider-prompt");
    expect(serialized).not.toContain("live-fixture-1");
  });

  it("collapses malformed provider output to a content-free failure", async () => {
    const fixtures = [fixture()];
    const adapter = liveAdapter(vi.fn(async (current) => ({
      binaryOutcomes: [],
      fixtureId: current.id,
      hardInvariants: zeroMemoryHardInvariantObservations(),
      language: current.language,
      operations: [],
      providerBody: "raw-provider-secret",
      rankedOutcomes: []
    })));
    const currentConfig = config(fixtures);
    const result = await runAuthorizedSyntheticMemoryEvaluation({
      adapter,
      authorization: authorization(adapter, currentConfig),
      config: currentConfig,
      fixtures,
      now: "2026-08-09T12:00:00.000Z"
    });
    expect(result).toEqual({
      adapterInvoked: true,
      code: "memory_live_evaluation_failed",
      ok: false
    });
    expect(JSON.stringify(result)).not.toContain("raw-provider-secret");
  });
});
