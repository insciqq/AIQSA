import { describe, expect, it, vi } from "vitest";
import {
  zeroMemoryHardInvariantObservations,
  type MemoryEvaluationFixture,
  type MemoryEvaluationRunContext
} from "../../../lib/evaluation/memory/contracts";
import {
  assertExactHindsightReferencePin,
  createHindsightReferenceAdapter
} from "./hindsightReference";

const fixture: MemoryEvaluationFixture<{ prompt: string }> = {
  corpusVersion: "corpus-v1",
  dataClass: "SYNTHETIC",
  groupId: "group-1",
  id: "fixture-1",
  input: { prompt: "synthetic" },
  language: "RU",
  noMemoryBaseline: {
    binaryOutcomes: [],
    hardInvariants: zeroMemoryHardInvariantObservations(),
    operations: [],
    rankedOutcomes: []
  },
  split: "HOLDOUT",
  tags: ["synthetic"]
};

const context: MemoryEvaluationRunContext = {
  corpusHash: "a".repeat(64),
  fixtureSeed: 1,
  pipelineVersion: "pipeline-v1",
  policyVersion: "policy-v1",
  promptVersion: "prompt-v1",
  randomSeed: 1,
  schemaVersion: "schema-v1",
  scorerVersion: "scorer-v1",
  suiteVersion: "suite-v1"
};

describe("development-only Hindsight Memory reference", () => {
  it("requires the exact release, source commit, and OCI digest", () => {
    const expected = {
      commit: "a".repeat(40),
      imageDigest: `sha256:${"b".repeat(64)}`,
      tag: "0.7.0"
    };
    expect(() => assertExactHindsightReferencePin(expected, expected)).not.toThrow();
    expect(() => assertExactHindsightReferencePin({
      ...expected,
      imageDigest: `sha256:${"c".repeat(64)}`
    }, expected)).toThrow("memory_hindsight_reference_pin_mismatch");
  });

  it("is disabled by default and never calls the injected reference executor", async () => {
    const run = vi.fn();
    const adapter = createHindsightReferenceAdapter({
      fingerprints: [],
      run,
      upstreamVersion: "1.2.3"
    });
    expect(adapter).toMatchObject({
      adapterVersion: "hindsight-1.2.3",
      kind: "HINDSIGHT_REFERENCE",
      liveProvider: false
    });
    await expect(adapter.run(fixture, context)).rejects.toThrow(
      "memory_hindsight_reference_disabled"
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("requires an exact upstream release or commit pin", () => {
    expect(() => createHindsightReferenceAdapter({
      enabled: true,
      fingerprints: [],
      run: vi.fn(),
      upstreamVersion: "latest"
    })).toThrow("memory_hindsight_reference_unpinned");
    expect(() => createHindsightReferenceAdapter({
      enabled: true,
      fingerprints: [],
      run: vi.fn(),
      upstreamVersion: "main"
    })).toThrow("memory_hindsight_reference_unpinned");
  });

  it("allows explicitly enabled synthetic evaluation through the neutral interface", async () => {
    const observation = {
      binaryOutcomes: [],
      fixtureId: fixture.id,
      hardInvariants: zeroMemoryHardInvariantObservations(),
      language: fixture.language,
      operations: [],
      rankedOutcomes: []
    };
    const run = vi.fn(async () => observation);
    const adapter = createHindsightReferenceAdapter({
      enabled: true,
      fingerprints: [],
      run,
      upstreamVersion: "abcdef1234567890"
    });
    await expect(adapter.run(fixture, context)).resolves.toEqual(observation);
    expect(run).toHaveBeenCalledOnce();
  });
});
