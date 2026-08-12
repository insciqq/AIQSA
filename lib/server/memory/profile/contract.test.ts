import { describe, expect, it } from "vitest";
import {
  MEMORY_PROFILE_PIPELINE_VERSION,
  memoryProfileAsOf,
  memoryProfileClaimIsValid,
  memoryProfileInputHash,
  memoryProfileJobFingerprint,
  memoryProfileJobInputHash,
  memoryProfileOutputHash,
  memoryWorkingSetSweepClaimIsValid,
  type MemoryProfileInput
} from "./contract";

const withoutHash: Omit<MemoryProfileInput, "inputHash"> = {
  asOf: "2026-08-11T12:00:00.000Z",
  candidates: [{
    factId: "fact-1",
    factVersionContentHash: "1".repeat(64),
    factVersionId: "version-1",
    safetyIdentitySnapshot: "2".repeat(64),
    sourceIdentitySnapshot: "3".repeat(64),
    suppressionIdentitySnapshot: "4".repeat(64),
    temperatureClass: "HOT",
    temperatureScore: 0.9,
    text: "Я предпочитаю краткие ответы."
  }],
  languageCode: "ru",
  memoryGeneration: 2,
  memoryRevision: 7,
  redactionState: "NOT_NEEDED",
  safetyIdentitySnapshot: "5".repeat(64),
  scopeId: "scope-1",
  sourceIdentitySnapshot: "6".repeat(64),
  suppressionIdentitySnapshot: "7".repeat(64)
};
const input: MemoryProfileInput = { ...withoutHash, inputHash: memoryProfileInputHash(withoutHash) };

function job(fingerprint = memoryProfileJobFingerprint(input.inputHash, "sweep-job-1")) {
  return {
    activeLeafMessageId: null,
    attemptCount: 0,
    branchGeneration: null,
    chatId: null,
    id: "job-1",
    idempotencyFingerprint: fingerprint,
    kind: "RECALCULATE_WORKING_SET" as const,
    memoryGenerationSnapshot: 2,
    memoryRevisionSnapshot: 7,
    pipelineVersion: MEMORY_PROFILE_PIPELINE_VERSION,
    sourceHash: null,
    sourceRevision: null,
    stage: null,
    userId: "user-1"
  };
}

describe("Memory profile contract", () => {
  it("freezes a stable hour boundary and exact input/output identities", () => {
    expect(memoryProfileAsOf(new Date("2026-08-11T12:59:59.999Z")).toISOString())
      .toBe("2026-08-11T12:00:00.000Z");
    expect(input.inputHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(memoryProfileJobInputHash(memoryProfileJobFingerprint(
      input.inputHash,
      "sweep-job-1"
    ))).toBe(input.inputHash);
    expect(memoryProfileOutputHash(input, [{
      factVersionId: "version-1",
      text: "Я предпочитаю краткие ответы."
    }])).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("separates provider profile jobs from local temperature sweeps", () => {
    expect(memoryProfileClaimIsValid(job())).toBe(true);
    expect(memoryWorkingSetSweepClaimIsValid(job())).toBe(false);
    expect(memoryProfileClaimIsValid(job("legacy-working-set-job"))).toBe(false);
    expect(memoryWorkingSetSweepClaimIsValid(job("legacy-working-set-job"))).toBe(true);
  });

  it("gives each sweep cause an idempotent profile incarnation", () => {
    const first = memoryProfileJobFingerprint(input.inputHash, "sweep-job-1");
    const repeated = memoryProfileJobFingerprint(input.inputHash, "sweep-job-1");
    const rebuilt = memoryProfileJobFingerprint(input.inputHash, "sweep-job-2");
    expect(repeated).toBe(first);
    expect(rebuilt).not.toBe(first);
    expect(memoryProfileJobInputHash(rebuilt)).toBe(input.inputHash);
  });
});
