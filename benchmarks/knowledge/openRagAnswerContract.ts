import { createHash } from "node:crypto";
import { canonicalJson } from "./contract";
import {
  OPEN_RAG_DATASET_ID,
  OPEN_RAG_UPSTREAM_REVISION
} from "./openRagSlice";

export const OPEN_RAG_ANSWER_RUN_SCHEMA_VERSION = 1 as const;
export const OPEN_RAG_ANSWER_JUDGE_CONTRACT_VERSION = 1 as const;
export const OPEN_RAG_ANSWER_RUNNER_CONTRACT_VERSION = 3 as const;
export const OPEN_RAG_ANSWER_QUESTION_PACKAGE = "open-rag-v1" as const;
export const OPEN_RAG_ANSWER_QUESTION_PACKAGE_VERSION = 2 as const;
export const OPEN_RAG_ANSWER_SELECTION_FINGERPRINT =
  "2a92892666775ba4cfdf098a1a4da855cd3becdac30f1da239e842b250487517" as const;

export type OpenRagAnswerCase = Readonly<{
  caseId: string;
  documentAlias: string;
  evaluationMode: "open_rag_reference_answer";
  goldSectionId: number;
  kind: "fact" | "table";
  question: string;
  referenceAnswer: string;
  source: "text" | "text-image" | "text-table" | "text-table-image";
  type: "abstractive" | "extractive";
}>;

export type OpenRagAnswerModelPin = Readonly<{
  adapterKind: string;
  connectionId: string;
  executionSnapshotHash: string;
  providerModelId: string;
  upstreamModelId: string;
}>;

export type OpenRagAnswerEnginePin = Readonly<{
  chunkingProfileVersion: number;
  coverageAuditorContractVersion: number | null;
  draftContractVersion: number;
  evidencePackingVersion: string;
  groundingEvidenceVersion: number;
  parserProfileVersion: number;
  pipelineVersion: string;
  profileRevisionId: string;
  profileRevisionNumber: number;
  rankingProfileVersion: number;
  reranker: OpenRagAnswerModelPin | null;
  selectorContractVersion: number;
  settlementVersion: number;
}>;

export type OpenRagAnswerSchedule = Readonly<{
  concurrency: number;
  caseStartIntervalMs: number;
}>;

export type OpenRagAnswerRunManifest = Readonly<{
  answerControlsFingerprint: string;
  answerModel: OpenRagAnswerModelPin;
  baseFingerprint: string;
  caseIds: readonly string[];
  datasetId: typeof OPEN_RAG_DATASET_ID;
  engine: OpenRagAnswerEnginePin;
  judgeContractVersion: typeof OPEN_RAG_ANSWER_JUDGE_CONTRACT_VERSION;
  judgeControlsFingerprint: string | null;
  judgeModel: OpenRagAnswerModelPin | null;
  judgeRepeat: number;
  mode: "focused" | "full" | "replay";
  noJudge: boolean;
  repeat: number;
  revision: typeof OPEN_RAG_UPSTREAM_REVISION;
  runnerContractVersion: typeof OPEN_RAG_ANSWER_RUNNER_CONTRACT_VERSION;
  schedule: OpenRagAnswerSchedule;
  schemaVersion: typeof OPEN_RAG_ANSWER_RUN_SCHEMA_VERSION;
  scoreable: boolean;
  selectionFingerprint: string;
  sourceBindingFingerprint: string;
}>;

type OpenRagAnswerQuestionBundle = Readonly<{
  cases: readonly OpenRagAnswerCase[];
  questionPackage: typeof OPEN_RAG_ANSWER_QUESTION_PACKAGE;
  version: typeof OPEN_RAG_ANSWER_QUESTION_PACKAGE_VERSION;
}>;

const sha256Pattern = /^[0-9a-f]{64}$/u;
const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/u;
const pipelineIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,1023}$/u;
const caseIdPattern = /^doc-[0-9]{3}-q[1-8]$/u;
const aliasPattern = /^doc-[0-9]{3}$/u;
const adapterPattern = /^[a-z][a-z0-9_]{0,63}$/u;
const questionDocumentKeys = Object.freeze(["cases", "txtSha256"] as const);
const questionKeys = Object.freeze([
  "caseId",
  "evaluationMode",
  "goldSectionId",
  "kind",
  "question",
  "referenceAnswer",
  "source",
  "support",
  "type"
] as const);
const questionBundleKeys = Object.freeze([
  "documents",
  "questionPackage",
  "version"
] as const);
const modelPinKeys = Object.freeze([
  "adapterKind",
  "connectionId",
  "executionSnapshotHash",
  "providerModelId",
  "upstreamModelId"
] as const);
const enginePinKeys = Object.freeze([
  "chunkingProfileVersion",
  "coverageAuditorContractVersion",
  "draftContractVersion",
  "evidencePackingVersion",
  "groundingEvidenceVersion",
  "parserProfileVersion",
  "pipelineVersion",
  "profileRevisionId",
  "profileRevisionNumber",
  "rankingProfileVersion",
  "reranker",
  "selectorContractVersion",
  "settlementVersion"
] as const);
const scheduleKeys = Object.freeze(["caseStartIntervalMs", "concurrency"] as const);
const manifestKeys = Object.freeze([
  "answerControlsFingerprint",
  "answerModel",
  "baseFingerprint",
  "caseIds",
  "datasetId",
  "engine",
  "judgeContractVersion",
  "judgeControlsFingerprint",
  "judgeModel",
  "judgeRepeat",
  "mode",
  "noJudge",
  "repeat",
  "revision",
  "runnerContractVersion",
  "schedule",
  "schemaVersion",
  "scoreable",
  "selectionFingerprint",
  "sourceBindingFingerprint"
] as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function boundedText(value: unknown, maximumBytes: number): string | null {
  return typeof value === "string" && value.trim().length > 0 &&
    !value.includes("\u0000") && Buffer.byteLength(value, "utf8") <= maximumBytes
    ? value
    : null;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : null;
}

function decodeModelPin(value: unknown): OpenRagAnswerModelPin | null {
  if (!isRecord(value) || !hasExactKeys(value, modelPinKeys) ||
    typeof value.adapterKind !== "string" || !adapterPattern.test(value.adapterKind) ||
    typeof value.connectionId !== "string" || !safeIdPattern.test(value.connectionId) ||
    typeof value.providerModelId !== "string" || !safeIdPattern.test(value.providerModelId) ||
    typeof value.upstreamModelId !== "string" || !safeIdPattern.test(value.upstreamModelId) ||
    typeof value.executionSnapshotHash !== "string" ||
    !sha256Pattern.test(value.executionSnapshotHash)) return null;
  return Object.freeze({
    adapterKind: value.adapterKind,
    connectionId: value.connectionId,
    executionSnapshotHash: value.executionSnapshotHash,
    providerModelId: value.providerModelId,
    upstreamModelId: value.upstreamModelId
  });
}

function decodeEnginePin(value: unknown): OpenRagAnswerEnginePin | null {
  if (!isRecord(value) || !hasExactKeys(value, enginePinKeys)) return null;
  const integerFields = [
    "chunkingProfileVersion",
    "draftContractVersion",
    "groundingEvidenceVersion",
    "parserProfileVersion",
    "profileRevisionNumber",
    "rankingProfileVersion",
    "selectorContractVersion",
    "settlementVersion"
  ] as const;
  if (integerFields.some((field) => boundedInteger(value[field], 1, 10_000) === null) ||
    value.coverageAuditorContractVersion !== null &&
      boundedInteger(value.coverageAuditorContractVersion, 1, 10_000) === null ||
    typeof value.evidencePackingVersion !== "string" ||
      !safeIdPattern.test(value.evidencePackingVersion) ||
    typeof value.pipelineVersion !== "string" ||
      !pipelineIdPattern.test(value.pipelineVersion) ||
    typeof value.profileRevisionId !== "string" ||
      !safeIdPattern.test(value.profileRevisionId)) return null;
  const reranker = value.reranker === null ? null : decodeModelPin(value.reranker);
  if (value.reranker !== null && !reranker) return null;
  return Object.freeze({
    chunkingProfileVersion: Number(value.chunkingProfileVersion),
    coverageAuditorContractVersion: value.coverageAuditorContractVersion === null
      ? null
      : Number(value.coverageAuditorContractVersion),
    draftContractVersion: Number(value.draftContractVersion),
    evidencePackingVersion: value.evidencePackingVersion,
    groundingEvidenceVersion: Number(value.groundingEvidenceVersion),
    parserProfileVersion: Number(value.parserProfileVersion),
    pipelineVersion: value.pipelineVersion,
    profileRevisionId: value.profileRevisionId,
    profileRevisionNumber: Number(value.profileRevisionNumber),
    rankingProfileVersion: Number(value.rankingProfileVersion),
    reranker,
    selectorContractVersion: Number(value.selectorContractVersion),
    settlementVersion: Number(value.settlementVersion)
  });
}

export function decodeOpenRagAnswerEnginePin(value: unknown): OpenRagAnswerEnginePin {
  const decoded = decodeEnginePin(value);
  if (!decoded) throw new Error("open_rag_answer_engine_pin_invalid");
  return decoded;
}

function decodeSchedule(value: unknown): OpenRagAnswerSchedule | null {
  if (!isRecord(value) || !hasExactKeys(value, scheduleKeys)) return null;
  const concurrency = boundedInteger(value.concurrency, 1, 8);
  const caseStartIntervalMs = boundedInteger(value.caseStartIntervalMs, 0, 600_000);
  return concurrency !== 1 || caseStartIntervalMs === null
    ? null
    : Object.freeze({ caseStartIntervalMs, concurrency });
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function decodeOpenRagAnswerQuestionBundle(
  value: unknown
): OpenRagAnswerQuestionBundle {
  const code = "open_rag_answer_question_bundle_invalid";
  if (!isRecord(value) || !hasExactKeys(value, questionBundleKeys) ||
    value.questionPackage !== OPEN_RAG_ANSWER_QUESTION_PACKAGE ||
    value.version !== OPEN_RAG_ANSWER_QUESTION_PACKAGE_VERSION ||
    !isRecord(value.documents)) throw new Error(code);
  const cases: OpenRagAnswerCase[] = [];
  for (const [documentAlias, rawDocument] of Object.entries(value.documents)
    .sort(([left], [right]) => left.localeCompare(right))) {
    if (!aliasPattern.test(documentAlias) || !isRecord(rawDocument) ||
      !hasExactKeys(rawDocument, questionDocumentKeys) ||
      typeof rawDocument.txtSha256 !== "string" ||
      !sha256Pattern.test(rawDocument.txtSha256) || !Array.isArray(rawDocument.cases) ||
      rawDocument.cases.length < 1 || rawDocument.cases.length > 8) throw new Error(code);
    for (const rawCase of rawDocument.cases) {
      const question = isRecord(rawCase)
        ? boundedText(rawCase.question, 64 * 1_024)
        : null;
      const referenceAnswer = isRecord(rawCase)
        ? boundedText(rawCase.referenceAnswer, 64 * 1_024)
        : null;
      const support = isRecord(rawCase)
        ? boundedText(rawCase.support, 64 * 1_024)
        : null;
      if (!isRecord(rawCase) || !hasExactKeys(rawCase, questionKeys) ||
        typeof rawCase.caseId !== "string" || !caseIdPattern.test(rawCase.caseId) ||
        !rawCase.caseId.startsWith(`${documentAlias}-q`) ||
        rawCase.evaluationMode !== "open_rag_reference_answer" ||
        boundedInteger(rawCase.goldSectionId, 0, 1_000_000) === null ||
        rawCase.kind !== "fact" && rawCase.kind !== "table" ||
        !question || !referenceAnswer || !support ||
        !["text", "text-image", "text-table", "text-table-image"].includes(
          String(rawCase.source)
        ) || !["abstractive", "extractive"].includes(String(rawCase.type))) {
        throw new Error(code);
      }
      cases.push(Object.freeze({
        caseId: rawCase.caseId,
        documentAlias,
        evaluationMode: "open_rag_reference_answer",
        goldSectionId: Number(rawCase.goldSectionId),
        kind: rawCase.kind,
        question,
        referenceAnswer,
        source: rawCase.source as OpenRagAnswerCase["source"],
        type: rawCase.type as OpenRagAnswerCase["type"]
      }));
    }
  }
  if (cases.length < 1 || cases.length > 100 ||
    new Set(cases.map(({ caseId }) => caseId)).size !== cases.length) throw new Error(code);
  return Object.freeze({
    cases: Object.freeze(cases.sort((left, right) => left.caseId.localeCompare(right.caseId))),
    questionPackage: OPEN_RAG_ANSWER_QUESTION_PACKAGE,
    version: OPEN_RAG_ANSWER_QUESTION_PACKAGE_VERSION
  });
}

export function decodeOpenRagAnswerRunManifest(value: unknown): OpenRagAnswerRunManifest {
  const code = "open_rag_answer_manifest_invalid";
  if (!isRecord(value) || !hasExactKeys(value, manifestKeys) ||
    value.schemaVersion !== OPEN_RAG_ANSWER_RUN_SCHEMA_VERSION ||
    value.datasetId !== OPEN_RAG_DATASET_ID || value.revision !== OPEN_RAG_UPSTREAM_REVISION ||
    value.judgeContractVersion !== OPEN_RAG_ANSWER_JUDGE_CONTRACT_VERSION ||
    value.runnerContractVersion !== OPEN_RAG_ANSWER_RUNNER_CONTRACT_VERSION ||
    value.selectionFingerprint !== OPEN_RAG_ANSWER_SELECTION_FINGERPRINT ||
    typeof value.answerControlsFingerprint !== "string" ||
      !sha256Pattern.test(value.answerControlsFingerprint) ||
    value.judgeControlsFingerprint !== null &&
      (typeof value.judgeControlsFingerprint !== "string" ||
        !sha256Pattern.test(value.judgeControlsFingerprint)) ||
    typeof value.baseFingerprint !== "string" || !sha256Pattern.test(value.baseFingerprint) ||
    typeof value.sourceBindingFingerprint !== "string" ||
      !sha256Pattern.test(value.sourceBindingFingerprint) ||
    !Array.isArray(value.caseIds) || value.caseIds.length < 1 || value.caseIds.length > 100 ||
    value.caseIds.some((caseId) => typeof caseId !== "string" || !caseIdPattern.test(caseId)) ||
    new Set(value.caseIds).size !== value.caseIds.length ||
    value.mode !== "focused" && value.mode !== "full" && value.mode !== "replay" ||
    value.mode === "full" && value.caseIds.length !== 100 ||
    value.mode === "replay" && value.caseIds.length !== 1 ||
    typeof value.noJudge !== "boolean" || typeof value.scoreable !== "boolean") {
    throw new Error(code);
  }
  const answerModel = decodeModelPin(value.answerModel);
  const judgeModel = value.judgeModel === null ? null : decodeModelPin(value.judgeModel);
  const engine = decodeEnginePin(value.engine);
  const schedule = decodeSchedule(value.schedule);
  const repeat = boundedInteger(value.repeat, 1, 100);
  const judgeRepeat = boundedInteger(value.judgeRepeat, 1, 10);
  const expectedScoreable = value.mode === "full" && value.caseIds.length === 100 &&
    repeat === 1 && judgeRepeat === 1 && value.noJudge === false;
  if (!answerModel || !engine || !schedule || repeat === null || judgeRepeat === null ||
    (value.noJudge ? judgeModel !== null : judgeModel === null) ||
    (value.noJudge ? value.judgeControlsFingerprint !== null :
      value.judgeControlsFingerprint === null) ||
    value.scoreable !== expectedScoreable) throw new Error(code);
  return Object.freeze({
    answerControlsFingerprint: value.answerControlsFingerprint,
    answerModel,
    baseFingerprint: value.baseFingerprint,
    caseIds: Object.freeze([...value.caseIds as string[]]),
    datasetId: OPEN_RAG_DATASET_ID,
    engine,
    judgeContractVersion: OPEN_RAG_ANSWER_JUDGE_CONTRACT_VERSION,
    judgeControlsFingerprint: value.judgeControlsFingerprint as string | null,
    judgeModel,
    judgeRepeat,
    mode: value.mode,
    noJudge: value.noJudge,
    repeat,
    revision: OPEN_RAG_UPSTREAM_REVISION,
    runnerContractVersion: OPEN_RAG_ANSWER_RUNNER_CONTRACT_VERSION,
    schedule,
    schemaVersion: OPEN_RAG_ANSWER_RUN_SCHEMA_VERSION,
    scoreable: value.scoreable,
    selectionFingerprint: OPEN_RAG_ANSWER_SELECTION_FINGERPRINT,
    sourceBindingFingerprint: value.sourceBindingFingerprint
  });
}

export function openRagAnswerManifestFingerprint(
  manifest: OpenRagAnswerRunManifest
): string {
  return sha256Canonical(decodeOpenRagAnswerRunManifest(manifest));
}
