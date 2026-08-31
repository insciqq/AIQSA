import type {
  OpenRagAnswerRunManifest
} from "./openRagAnswerContract";
import {
  decodeOpenRagAnswerRunManifest,
  openRagAnswerManifestFingerprint
} from "./openRagAnswerContract";
import type {
  OpenRagFailureClassification,
  OpenRagJudgment
} from "./openRagAnswerEvaluate";
import { decodeOpenRagJudgment } from "./openRagAnswerEvaluate";

export const OPEN_RAG_ANSWER_CHECKPOINT_SCHEMA_VERSION = 1 as const;

export type OpenRagAnswerStageRecord = Readonly<{
  durationMs: number;
  providerResponseId: string | null;
  requestHash: string;
  resultHash: string;
  stage: string;
  usage: Readonly<{
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  }>;
}>;

export type OpenRagJudgeStageRecord = Readonly<{
  durationMs: number;
  judgment: OpenRagJudgment;
  providerResponseId: string | null;
  requestHash: string;
  resultHash: string;
  runId: string;
  usage: OpenRagAnswerStageRecord["usage"];
}>;

export type OpenRagAnswerOutcome = Readonly<{
  answerHash: string;
  answerRunId: string;
  caseId: string;
  classification: OpenRagFailureClassification | null;
  coverage: "complete" | "none" | "partial";
  diagnosticJudgeRuns: readonly OpenRagJudgeStageRecord[];
  judgment: OpenRagJudgeStageRecord | null;
  operationCount: number;
  repeatOrdinal: number;
  replaySnapshotHash: string;
  stageRecords: readonly OpenRagAnswerStageRecord[];
}>;

export type OpenRagAnswerCheckpointHeader = Readonly<{
  createdAt: string;
  manifest: OpenRagAnswerRunManifest;
  manifestFingerprint: string;
  runId: string;
  schemaVersion: typeof OPEN_RAG_ANSWER_CHECKPOINT_SCHEMA_VERSION;
}>;

const sha256Pattern = /^[0-9a-f]{64}$/u;
const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;
const failureClassifications = new Set<OpenRagFailureClassification>([
  "coverage_audit_error",
  "dataset_question_invalid",
  "dataset_reference_invalid",
  "document_mismatch",
  "draft_omission",
  "evidence_budget_or_packing_loss",
  "false_complete",
  "false_insufficient",
  "judge_disagreement",
  "parser_missing_content",
  "provider_or_infrastructure_failure",
  "rerank_relevant_candidate_dropped",
  "retrieval_relevant_source_absent",
  "selector_support_error"
]);
const headerKeys = Object.freeze([
  "createdAt",
  "manifest",
  "manifestFingerprint",
  "runId",
  "schemaVersion"
] as const);
const outcomeKeys = Object.freeze([
  "answerHash",
  "answerRunId",
  "caseId",
  "classification",
  "coverage",
  "diagnosticJudgeRuns",
  "judgment",
  "operationCount",
  "repeatOrdinal",
  "replaySnapshotHash",
  "stageRecords"
] as const);
const stageKeys = Object.freeze([
  "durationMs",
  "providerResponseId",
  "requestHash",
  "resultHash",
  "stage",
  "usage"
] as const);
const usageKeys = Object.freeze([
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens"
] as const);
const judgeStageKeys = Object.freeze([
  "durationMs",
  "judgment",
  "providerResponseId",
  "requestHash",
  "resultHash",
  "runId",
  "usage"
] as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function boundedInteger(value: unknown, maximum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum
    ? Number(value)
    : null;
}

function decodeStage(value: unknown): OpenRagAnswerStageRecord | null {
  if (!isRecord(value) || !hasExactKeys(value, stageKeys) ||
    typeof value.stage !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(value.stage) ||
    typeof value.requestHash !== "string" || !sha256Pattern.test(value.requestHash) ||
    typeof value.resultHash !== "string" || !sha256Pattern.test(value.resultHash) ||
    value.providerResponseId !== null && (typeof value.providerResponseId !== "string" ||
      !safeIdPattern.test(value.providerResponseId)) || !isRecord(value.usage) ||
    !hasExactKeys(value.usage, usageKeys)) return null;
  const durationMs = boundedInteger(value.durationMs, 24 * 60 * 60 * 1_000);
  const inputTokens = boundedInteger(value.usage.inputTokens, Number.MAX_SAFE_INTEGER);
  const outputTokens = boundedInteger(value.usage.outputTokens, Number.MAX_SAFE_INTEGER);
  const reasoningTokens = boundedInteger(value.usage.reasoningTokens, Number.MAX_SAFE_INTEGER);
  const totalTokens = boundedInteger(value.usage.totalTokens, Number.MAX_SAFE_INTEGER);
  if (durationMs === null || inputTokens === null || outputTokens === null ||
    reasoningTokens === null || totalTokens === null ||
    totalTokens < inputTokens + outputTokens) return null;
  return Object.freeze({
    durationMs,
    providerResponseId: value.providerResponseId as string | null,
    requestHash: value.requestHash,
    resultHash: value.resultHash,
    stage: value.stage,
    usage: Object.freeze({ inputTokens, outputTokens, reasoningTokens, totalTokens })
  });
}

function decodeJudgeStage(value: unknown): OpenRagJudgeStageRecord | null {
  if (!isRecord(value) || !hasExactKeys(value, judgeStageKeys) ||
    typeof value.runId !== "string" || !safeIdPattern.test(value.runId)) return null;
  const decoded = decodeStage({
    durationMs: value.durationMs,
    providerResponseId: value.providerResponseId,
    requestHash: value.requestHash,
    resultHash: value.resultHash,
    stage: "judge",
    usage: value.usage
  });
  if (!decoded) return null;
  let judgment: OpenRagJudgment;
  try {
    judgment = decodeOpenRagJudgment(value.judgment);
  } catch {
    return null;
  }
  return Object.freeze({
    durationMs: decoded.durationMs,
    judgment,
    providerResponseId: decoded.providerResponseId,
    requestHash: decoded.requestHash,
    resultHash: decoded.resultHash,
    runId: value.runId,
    usage: decoded.usage
  });
}

export function decodeOpenRagAnswerCheckpointHeader(
  value: unknown
): OpenRagAnswerCheckpointHeader {
  const code = "open_rag_answer_checkpoint_header_invalid";
  if (!isRecord(value) || !hasExactKeys(value, headerKeys) ||
    value.schemaVersion !== OPEN_RAG_ANSWER_CHECKPOINT_SCHEMA_VERSION ||
    typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.runId !== "string" || !safeIdPattern.test(value.runId) ||
    typeof value.manifestFingerprint !== "string" ||
      !sha256Pattern.test(value.manifestFingerprint)) throw new Error(code);
  const manifest = decodeOpenRagAnswerRunManifest(value.manifest);
  if (openRagAnswerManifestFingerprint(manifest) !== value.manifestFingerprint) {
    throw new Error(code);
  }
  return Object.freeze({
    createdAt: value.createdAt,
    manifest,
    manifestFingerprint: value.manifestFingerprint,
    runId: value.runId,
    schemaVersion: OPEN_RAG_ANSWER_CHECKPOINT_SCHEMA_VERSION
  });
}

export function decodeOpenRagAnswerOutcome(
  value: unknown,
  expected: Readonly<{ caseId: string; repeatOrdinal: number }>
): OpenRagAnswerOutcome {
  const code = "open_rag_answer_checkpoint_outcome_invalid";
  if (!isRecord(value) || !hasExactKeys(value, outcomeKeys) ||
    value.caseId !== expected.caseId || value.repeatOrdinal !== expected.repeatOrdinal ||
    typeof value.answerHash !== "string" || !sha256Pattern.test(value.answerHash) ||
    typeof value.replaySnapshotHash !== "string" ||
      !sha256Pattern.test(value.replaySnapshotHash) ||
    typeof value.answerRunId !== "string" || !safeIdPattern.test(value.answerRunId) ||
    value.coverage !== "complete" && value.coverage !== "partial" &&
      value.coverage !== "none" ||
    value.classification !== null && (typeof value.classification !== "string" ||
      !failureClassifications.has(value.classification as OpenRagFailureClassification)) ||
    !Array.isArray(value.stageRecords) || value.stageRecords.length < 3 ||
      value.stageRecords.length > 6 ||
    !Array.isArray(value.diagnosticJudgeRuns) || value.diagnosticJudgeRuns.length > 10) {
    throw new Error(code);
  }
  const operationCount = boundedInteger(value.operationCount, 6);
  const stageRecords = value.stageRecords.map(decodeStage);
  const judgment = value.judgment === null ? null : decodeJudgeStage(value.judgment);
  const diagnosticJudgeRuns = value.diagnosticJudgeRuns.map(decodeJudgeStage);
  if (operationCount === null || operationCount < 3 || stageRecords.some((stage) => !stage) ||
    operationCount !== stageRecords.length ||
    value.judgment !== null && judgment === null ||
    diagnosticJudgeRuns.some((stage) => !stage) ||
    judgment === null && value.classification !== null ||
    judgment?.judgment.verdict === "pass" && value.classification !== null ||
    value.coverage === "none" && judgment !== null &&
      judgment.judgment.verdict !== "fail" ||
    value.coverage === "partial" && judgment?.judgment.verdict === "pass" ||
    judgment?.judgment.verdict !== "pass" && judgment !== null &&
      value.classification === null) {
    throw new Error(code);
  }
  return Object.freeze({
    answerHash: value.answerHash,
    answerRunId: value.answerRunId,
    caseId: expected.caseId,
    classification: value.classification as OpenRagFailureClassification | null,
    coverage: value.coverage as OpenRagAnswerOutcome["coverage"],
    diagnosticJudgeRuns: Object.freeze(
      diagnosticJudgeRuns as OpenRagJudgeStageRecord[]
    ),
    judgment,
    operationCount,
    repeatOrdinal: expected.repeatOrdinal,
    replaySnapshotHash: value.replaySnapshotHash,
    stageRecords: Object.freeze(stageRecords as OpenRagAnswerStageRecord[])
  });
}

export function assertOpenRagAnswerResumeIdentity(
  existing: OpenRagAnswerCheckpointHeader,
  expectedManifest: OpenRagAnswerRunManifest
): void {
  if (existing.manifestFingerprint !== openRagAnswerManifestFingerprint(expectedManifest)) {
    throw new Error("open_rag_answer_resume_manifest_mismatch");
  }
}
