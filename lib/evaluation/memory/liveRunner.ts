import {
  type MemoryEvaluationAdapter,
  type MemoryEvaluationConfig,
  type MemoryEvaluationFixture
} from "./contracts";
import { compareMemoryEvaluationText, memoryEvaluationSha256 } from "./canonical";
import {
  hashMemoryEvaluationCorpus,
  runMemoryEvaluation,
  type MemoryEvaluationEvidence
} from "./harness";

export const MEMORY_LIVE_AUTHORIZATION_VERSION = "memory-live-evaluation-authorization-v1";

export type MemorySyntheticLiveAuthorization = Readonly<{
  adapterFingerprint: string;
  adapterKind: "AIQSA_NATIVE";
  adapterVersion: string;
  approvalId: string;
  approvedAt: string;
  approvedBy: string;
  authorizationVersion: typeof MEMORY_LIVE_AUTHORIZATION_VERSION;
  corpusHash: string;
  evaluationConfigFingerprint: string;
  expiresAt: string;
  operatorApproved: true;
  suiteVersion: string;
  syntheticOnly: true;
}>;

export const MEMORY_LIVE_RUN_FAILURE_CODES = [
  "memory_live_authorization_invalid",
  "memory_live_authorization_stale",
  "memory_live_authorization_expired",
  "memory_live_adapter_not_eligible",
  "memory_live_non_synthetic_corpus",
  "memory_live_evaluation_failed"
] as const;
export type MemoryLiveRunFailureCode = (typeof MEMORY_LIVE_RUN_FAILURE_CODES)[number];

export type MemorySyntheticLiveRunResult =
  | Readonly<{
      adapterInvoked: false;
      code: Exclude<MemoryLiveRunFailureCode, "memory_live_evaluation_failed">;
      ok: false;
    }>
  | Readonly<{
      adapterInvoked: boolean;
      code: "memory_live_evaluation_failed";
      ok: false;
    }>
  | Readonly<{
      adapterInvoked: true;
      evidence: MemoryEvaluationEvidence;
      ok: true;
    }>;

const exactIsoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const safeToken = /^[A-Za-z0-9][A-Za-z0-9._:+@/=-]{0,299}$/u;
const authorizationKeys = [
  "adapterFingerprint",
  "adapterKind",
  "adapterVersion",
  "approvalId",
  "approvedAt",
  "approvedBy",
  "authorizationVersion",
  "corpusHash",
  "evaluationConfigFingerprint",
  "expiresAt",
  "operatorApproved",
  "suiteVersion",
  "syntheticOnly"
].sort();

function validInstant(value: unknown): value is string {
  return typeof value === "string" && exactIsoInstant.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function authorizationIsValid(value: unknown): value is MemorySyntheticLiveAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(authorizationKeys)) return false;
  return candidate.authorizationVersion === MEMORY_LIVE_AUTHORIZATION_VERSION &&
    candidate.adapterKind === "AIQSA_NATIVE" &&
    candidate.operatorApproved === true &&
    candidate.syntheticOnly === true &&
    typeof candidate.adapterFingerprint === "string" && sha256.test(candidate.adapterFingerprint) &&
    typeof candidate.corpusHash === "string" && sha256.test(candidate.corpusHash) &&
    typeof candidate.evaluationConfigFingerprint === "string" &&
      sha256.test(candidate.evaluationConfigFingerprint) &&
    [candidate.adapterVersion, candidate.approvalId, candidate.approvedBy, candidate.suiteVersion]
      .every((item) => typeof item === "string" && safeToken.test(item)) &&
    validInstant(candidate.approvedAt) && validInstant(candidate.expiresAt);
}

export function memoryEvaluationAdapterFingerprint<Input>(
  adapter: MemoryEvaluationAdapter<Input>
): string {
  return memoryEvaluationSha256({
    fingerprints: [...adapter.fingerprints].sort((left, right) =>
      compareMemoryEvaluationText(left.role, right.role)
    ),
    kind: adapter.kind,
    version: adapter.adapterVersion
  });
}

export function memoryEvaluationConfigFingerprint(config: MemoryEvaluationConfig): string {
  return memoryEvaluationSha256(config);
}

function rejected(
  code: Exclude<MemoryLiveRunFailureCode, "memory_live_evaluation_failed">
): MemorySyntheticLiveRunResult {
  return { adapterInvoked: false, code, ok: false };
}

export async function runAuthorizedSyntheticMemoryEvaluation<Input>(input: {
  adapter: MemoryEvaluationAdapter<Input>;
  authorization: unknown;
  config: MemoryEvaluationConfig;
  fixtures: readonly MemoryEvaluationFixture<Input>[];
  now: string;
}): Promise<MemorySyntheticLiveRunResult> {
  if (!authorizationIsValid(input.authorization) || !validInstant(input.now)) {
    return rejected("memory_live_authorization_invalid");
  }
  if (
    input.adapter.kind !== "AIQSA_NATIVE" ||
    !input.adapter.liveProvider ||
    input.adapter.fingerprints.length === 0
  ) {
    return rejected("memory_live_adapter_not_eligible");
  }
  let corpusHash: string;
  let adapterFingerprint: string;
  try {
    corpusHash = hashMemoryEvaluationCorpus(
      input.fixtures as readonly MemoryEvaluationFixture<unknown>[]
    );
    adapterFingerprint = memoryEvaluationAdapterFingerprint(
      input.adapter as MemoryEvaluationAdapter<unknown>
    );
  } catch {
    return rejected("memory_live_authorization_invalid");
  }
  if (
    input.authorization.adapterFingerprint !== adapterFingerprint ||
    input.authorization.adapterVersion !== input.adapter.adapterVersion ||
    input.authorization.corpusHash !== corpusHash ||
    input.authorization.corpusHash !== input.config.corpusHash ||
    input.authorization.evaluationConfigFingerprint !==
      memoryEvaluationConfigFingerprint(input.config) ||
    input.authorization.suiteVersion !== input.config.suiteVersion
  ) {
    return rejected("memory_live_authorization_stale");
  }
  const now = Date.parse(input.now);
  if (Date.parse(input.authorization.approvedAt) > now) {
    return rejected("memory_live_authorization_invalid");
  }
  if (Date.parse(input.authorization.expiresAt) <= now) {
    return rejected("memory_live_authorization_expired");
  }
  if (
    input.fixtures.length === 0 ||
    input.fixtures.some(({ dataClass, split }) =>
      dataClass !== "SYNTHETIC" || split !== "HOLDOUT"
    )
  ) {
    return rejected("memory_live_non_synthetic_corpus");
  }

  let adapterInvoked = false;
  const guardedAdapter: MemoryEvaluationAdapter<Input> = {
    ...input.adapter,
    run: async (...args) => {
      adapterInvoked = true;
      return input.adapter.run(...args);
    }
  };
  try {
    const evidence = await runMemoryEvaluation({
      adapter: guardedAdapter,
      config: input.config,
      fixtures: input.fixtures
    });
    return { adapterInvoked: true, evidence, ok: true };
  } catch {
    return {
      adapterInvoked,
      code: "memory_live_evaluation_failed",
      ok: false
    };
  }
}
