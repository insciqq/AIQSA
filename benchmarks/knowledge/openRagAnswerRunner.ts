import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KNOWLEDGE_ANSWER_SCOPE_V6_REPAIR_RESERVED_MAX_OPERATION_COUNT_V2
} from "../../lib/server/knowledge/answerGroundingV21";
import type {
  OpenRagAnswerCheckpointHeader,
  OpenRagAnswerOutcome,
  OpenRagAnswerStageRecord,
  OpenRagJudgeStageRecord
} from "./openRagAnswerCheckpoint";
import {
  assertOpenRagAnswerResumeIdentity,
  decodeOpenRagAnswerCheckpointHeader,
  decodeOpenRagAnswerOutcome,
  OPEN_RAG_ANSWER_CHECKPOINT_SCHEMA_VERSION
} from "./openRagAnswerCheckpoint";
import type {
  OpenRagAnswerCase,
  OpenRagAnswerRunManifest
} from "./openRagAnswerContract";
import {
  decodeOpenRagAnswerRunManifest,
  openRagAnswerManifestFingerprint,
  sha256Canonical
} from "./openRagAnswerContract";
import type { OpenRagFailureFacts } from "./openRagAnswerEvaluate";
import {
  aggregateOpenRagJudgments,
  applyOpenRagCitationCeiling,
  applyOpenRagCoverageCeiling,
  classifyOpenRagFailure,
  decodeOpenRagJudgmentText,
  openRagJudgePrompt
} from "./openRagAnswerEvaluate";
import {
  decodeOpenRagAnswerReplaySnapshot,
  getOpenRagAnswerReplayFailureTrace,
  getOpenRagAnswerReplaySnapshotDiagnostic,
  isOpenRagAnswerOperationSequence,
  type OpenRagRawProviderOutput,
  type OpenRagAnswerReplaySnapshot
} from "./openRagAnswerReplay";

export type OpenRagAnswerCliOptions = Readonly<{
  batchSize: number | null;
  caseIds: readonly string[];
  confirmPaid: true;
  frozenEvidencePath: string | null;
  full: boolean;
  judgeRepeat: number;
  mode: "focused" | "full" | "replay";
  noJudge: boolean;
  outputPath: string | null;
  preflightOnly: boolean;
  repeat: number;
  resume: boolean;
}>;

export type OpenRagAnswerObservedFacts = Omit<
  OpenRagFailureFacts,
  "answerCompleted" | "answerCoverage" | "answerStageFailure" | "judgment"
>;

export type OpenRagProductAnswer = Readonly<{
  acceptedResults: readonly Readonly<{
    operation: string;
    output: Readonly<Record<string, unknown>>;
  }>[];
  answerRunId: string;
  answerText: string;
  citedEvidence: readonly Readonly<{
    handle: string;
    locator: string | null;
    providerEvidence: string;
    providerEvidenceTruncated: boolean;
    sourceLabel: string | null;
  }>[];
  coverage: "complete" | "none" | "partial";
  facts: OpenRagAnswerObservedFacts;
  operationCount: number;
  /** Present only when the benchmark itself owns the provider call. Product
   * execution deliberately exposes no raw provider payload. */
  rawProviderOutputs?: readonly OpenRagRawProviderOutput[];
  replaySnapshot: OpenRagAnswerReplaySnapshot;
  stageRecords: readonly OpenRagAnswerStageRecord[];
}>;

export type OpenRagProductJudge = Readonly<{
  durationMs: number;
  providerResponseId: string | null;
  rawResult: string;
  runId: string;
  usage: OpenRagAnswerStageRecord["usage"];
}>;

export type OpenRagAnswerRuntime = Readonly<{
  executeAnswer(input: Readonly<{
    case: OpenRagAnswerCase;
    goldDocumentId: string;
    repeatOrdinal: number;
  }>): Promise<OpenRagProductAnswer>;
  executeJudge(input: Readonly<{
    case: OpenRagAnswerCase;
    prompt: string;
    repeatOrdinal: number;
  }>): Promise<OpenRagProductJudge>;
  executeReplay(input: Readonly<{
    repeatOrdinal: number;
    snapshot: OpenRagAnswerReplaySnapshot;
  }>): Promise<OpenRagProductAnswer>;
}>;

export type OpenRagAnswerCheckpointStore = Readonly<{
  initialize(input: Readonly<{
    header: OpenRagAnswerCheckpointHeader;
    resume: boolean;
  }>): Promise<OpenRagAnswerCheckpointHeader>;
  loadOutcome(expected: Readonly<{
    caseId: string;
    repeatOrdinal: number;
  }>): Promise<OpenRagAnswerOutcome | null>;
  writeFailure(input: Readonly<{
    caseId: string;
    code: string;
    diagnostic?: string;
    privateRecord?: Readonly<Record<string, unknown>>;
    repeatOrdinal: number;
    stage: string;
  }>): Promise<void>;
  writeOutcome(input: Readonly<{
    outcome: OpenRagAnswerOutcome;
    privateRecord: Readonly<Record<string, unknown>>;
  }>): Promise<void>;
  writeSummary(summary: Readonly<Record<string, unknown>>): Promise<void>;
}>;

export type OpenRagAnswerRunSummary = Readonly<{
  fail: number;
  grounded: number;
  partial: number;
  pass: number;
  runId: string;
  scoreable: boolean;
  total: number;
}>;

export type OpenRagAnswerBatchProgress = Readonly<{
  kind: "paused";
  newlySettled: number;
  runId: string;
  settled: number;
  totalExpected: number;
}>;

const caseIdPattern = /^doc-[0-9]{3}-q[1-8]$/u;
const singletonArguments = new Set([
  "--batch-size",
  "--confirm-paid",
  "--frozen-evidence",
  "--full",
  "--judge-repeat",
  "--no-judge",
  "--output",
  "--preflight-only",
  "--repeat",
  "--resume"
]);
const privateRoots = Object.freeze([
  [".aiqsa"],
  ["benchmarks", "knowledge", ".data"],
  ["benchmarks", "knowledge", "results"]
] as const);

function integerArgument(value: string | undefined, minimum: number, maximum: number): number {
  if (!value || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("open_rag_answer_integer_argument_invalid");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("open_rag_answer_integer_argument_invalid");
  }
  return parsed;
}

export function parseOpenRagAnswerCli(argv: readonly string[]): OpenRagAnswerCliOptions {
  let batchSize: number | null = null;
  let confirmPaid = false;
  let frozenEvidencePath: string | null = null;
  let full = false;
  let judgeRepeat = 1;
  let noJudge = false;
  let outputPath: string | null = null;
  let preflightOnly = false;
  let repeat = 1;
  let resume = false;
  const caseIds: string[] = [];
  const seenSingletons = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument && singletonArguments.has(argument)) {
      if (seenSingletons.has(argument)) {
        throw new Error("open_rag_answer_argument_duplicate");
      }
      seenSingletons.add(argument);
    }
    switch (argument) {
      case "--batch-size":
        batchSize = integerArgument(next, 1, 100);
        index += 1;
        break;
      case "--case-id":
        if (!next || !caseIdPattern.test(next)) {
          throw new Error("open_rag_answer_case_id_invalid");
        }
        caseIds.push(next);
        index += 1;
        break;
      case "--confirm-paid":
        if (next !== "OPENRAG") {
          throw new Error("open_rag_answer_paid_confirmation_invalid");
        }
        confirmPaid = true;
        index += 1;
        break;
      case "--frozen-evidence":
        if (!next?.trim() || frozenEvidencePath !== null) {
          throw new Error("open_rag_answer_frozen_evidence_invalid");
        }
        frozenEvidencePath = next;
        index += 1;
        break;
      case "--full":
        full = true;
        break;
      case "--judge-repeat":
        judgeRepeat = integerArgument(next, 1, 10);
        index += 1;
        break;
      case "--no-judge":
        noJudge = true;
        break;
      case "--output":
        if (!next?.trim() || outputPath !== null) {
          throw new Error("open_rag_answer_output_invalid");
        }
        outputPath = next;
        index += 1;
        break;
      case "--preflight-only":
        preflightOnly = true;
        break;
      case "--repeat":
        repeat = integerArgument(next, 1, 20);
        index += 1;
        break;
      case "--resume":
        resume = true;
        break;
      default:
        throw new Error(`open_rag_answer_argument_unknown:${argument ?? "missing"}`);
    }
  }
  if (!confirmPaid) throw new Error("open_rag_answer_paid_confirmation_required");
  if (new Set(caseIds).size !== caseIds.length) {
    throw new Error("open_rag_answer_case_id_duplicate");
  }
  const selections = Number(full) + Number(caseIds.length > 0) +
    Number(frozenEvidencePath !== null);
  if (selections !== 1) throw new Error("open_rag_answer_selection_invalid");
  if (noJudge && judgeRepeat !== 1) {
    throw new Error("open_rag_answer_judge_mode_invalid");
  }
  const scoreable = full && repeat === 1 && judgeRepeat === 1 && !noJudge;
  if (batchSize !== null && !full) {
    throw new Error("open_rag_answer_batch_mode_invalid");
  }
  if (batchSize !== null && !scoreable) {
    throw new Error("open_rag_answer_batch_mode_invalid");
  }
  if (batchSize !== null && outputPath === null && !preflightOnly) {
    throw new Error("open_rag_answer_batch_output_required");
  }
  if (resume && (!scoreable || outputPath === null || preflightOnly)) {
    throw new Error("open_rag_answer_resume_mode_invalid");
  }
  return Object.freeze({
    batchSize,
    caseIds: Object.freeze([...caseIds].sort()),
    confirmPaid: true,
    frozenEvidencePath,
    full,
    judgeRepeat,
    mode: frozenEvidencePath ? "replay" : full ? "full" : "focused",
    noJudge,
    outputPath,
    preflightOnly,
    repeat,
    resume
  });
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`) &&
    !path.startsWith(sep);
}

export function assertOpenRagPrivatePath(
  repositoryRoot: string,
  candidatePath: string
): string {
  const root = resolve(repositoryRoot);
  const candidate = resolve(root, candidatePath);
  if (!privateRoots.some((parts) => isInside(resolve(root, ...parts), candidate))) {
    throw new Error("open_rag_answer_private_path_required");
  }
  return candidate;
}

export async function assertOpenRagPrivatePathNoSymlinks(
  repositoryRoot: string,
  candidatePath: string
) {
  const root = resolve(repositoryRoot);
  const candidate = assertOpenRagPrivatePath(root, candidatePath);
  const path = relative(root, candidate).split(sep);
  let cursor = root;
  for (const part of path) {
    cursor = resolve(cursor, part);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) {
        throw new Error("open_rag_answer_private_path_symlink_forbidden");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return candidate;
}

function outcomeName(caseId: string, repeatOrdinal: number): string {
  return `${caseId}-r${String(repeatOrdinal).padStart(2, "0")}.json`;
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("open_rag_answer_checkpoint_corrupt");
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

export async function createOpenRagAnswerFileCheckpointStore(input: Readonly<{
  manifestFingerprint: string;
  outputPath: string;
  repositoryRoot: string;
}>): Promise<OpenRagAnswerCheckpointStore> {
  const output = await assertOpenRagPrivatePathNoSymlinks(
    input.repositoryRoot,
    input.outputPath
  );
  const headerPath = resolve(output, "checkpoint.json");
  const outcomesPath = resolve(output, "outcomes");
  const privatePath = resolve(output, "private");
  const replayPath = resolve(output, "replay-snapshots");
  const failurePath = resolve(output, "failures");
  const summaryPath = resolve(output, "summary.json");
  const wrap = (outcome: OpenRagAnswerOutcome) => Object.freeze({
    manifestFingerprint: input.manifestFingerprint,
    outcome,
    schemaVersion: OPEN_RAG_ANSWER_CHECKPOINT_SCHEMA_VERSION
  });
  return Object.freeze({
    async initialize({ header, resume }) {
      await mkdir(output, { recursive: true, mode: 0o700 });
      const existing = await readJson(headerPath);
      if (resume) {
        if (existing === null || await readJson(summaryPath) !== null) {
          throw new Error("open_rag_answer_resume_checkpoint_invalid");
        }
        const decoded = decodeOpenRagAnswerCheckpointHeader(existing);
        assertOpenRagAnswerResumeIdentity(decoded, header.manifest);
        return decoded;
      }
      if (existing !== null || (await readdir(output)).length > 0) {
        throw new Error("open_rag_answer_output_not_empty");
      }
      await atomicJson(headerPath, header);
      return header;
    },
    async loadOutcome(expected) {
      const raw = await readJson(resolve(outcomesPath, outcomeName(
        expected.caseId,
        expected.repeatOrdinal
      )));
      if (raw === null) return null;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw) ||
        Object.keys(raw).sort().join(",") !==
          "manifestFingerprint,outcome,schemaVersion" ||
        (raw as Record<string, unknown>).manifestFingerprint !==
          input.manifestFingerprint ||
        (raw as Record<string, unknown>).schemaVersion !==
          OPEN_RAG_ANSWER_CHECKPOINT_SCHEMA_VERSION) {
        throw new Error("open_rag_answer_checkpoint_corrupt");
      }
      return decodeOpenRagAnswerOutcome(
        (raw as Record<string, unknown>).outcome,
        expected
      );
    },
    async writeFailure(failure) {
      const { privateRecord, ...contentSafeFailure } = failure;
      if (privateRecord) {
        const replaySnapshot = decodeOpenRagAnswerReplaySnapshot(
          privateRecord.replaySnapshot
        );
        await atomicJson(resolve(privatePath, outcomeName(
          failure.caseId,
          failure.repeatOrdinal
        )), Object.freeze({
          ...privateRecord,
          failedStage: failure.stage,
          manifestFingerprint: input.manifestFingerprint
        }));
        await atomicJson(resolve(replayPath, outcomeName(
          failure.caseId,
          failure.repeatOrdinal
        )), replaySnapshot);
      }
      await atomicJson(resolve(failurePath, outcomeName(
        failure.caseId,
        failure.repeatOrdinal
      )), Object.freeze({
        ...contentSafeFailure,
        classification: "provider_or_infrastructure_failure",
        manifestFingerprint: input.manifestFingerprint,
        recordedAt: new Date().toISOString()
      }));
    },
    async writeOutcome({ outcome, privateRecord }) {
      const decoded = decodeOpenRagAnswerOutcome(outcome, outcome);
      const replaySnapshot = decodeOpenRagAnswerReplaySnapshot(
        privateRecord.replaySnapshot
      );
      if (replaySnapshot.snapshotHash !== decoded.replaySnapshotHash) {
        throw new Error("open_rag_answer_replay_snapshot_mismatch");
      }
      await atomicJson(resolve(privatePath, outcomeName(
        decoded.caseId,
        decoded.repeatOrdinal
      )), Object.freeze({
        ...privateRecord,
        manifestFingerprint: input.manifestFingerprint
      }));
      await atomicJson(resolve(replayPath, outcomeName(
        decoded.caseId,
        decoded.repeatOrdinal
      )), replaySnapshot);
      await atomicJson(resolve(outcomesPath, outcomeName(
        decoded.caseId,
        decoded.repeatOrdinal
      )), wrap(decoded));
    },
    async writeSummary(summary) {
      if (await readJson(summaryPath) !== null) {
        throw new Error("open_rag_answer_summary_exists");
      }
      await atomicJson(summaryPath, summary);
    }
  });
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  const candidate = message.split(":", 1)[0]!
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 128);
  return /^[a-z][a-z0-9_]{0,127}$/u.test(candidate)
    ? candidate
    : "provider_or_infrastructure_failure";
}

function replaySnapshotDiagnostic(error: unknown): string | undefined {
  const diagnostic = getOpenRagAnswerReplaySnapshotDiagnostic(error);
  return diagnostic !== null && /^[a-z][a-z0-9_]{0,95}$/u.test(diagnostic)
    ? diagnostic
    : undefined;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function judgeStage(
  product: OpenRagProductJudge,
  prompt: string,
  coverage: OpenRagProductAnswer["coverage"],
  citationCount: number
): OpenRagJudgeStageRecord {
  const judgment = applyOpenRagCitationCeiling(
    applyOpenRagCoverageCeiling(
      decodeOpenRagJudgmentText(product.rawResult),
      coverage
    ),
    citationCount
  );
  return Object.freeze({
    durationMs: product.durationMs,
    judgment,
    providerResponseId: product.providerResponseId,
    requestHash: sha256Text(prompt),
    resultHash: sha256Text(product.rawResult),
    runId: product.runId,
    usage: product.usage
  });
}

function privateAnswerRecord(
  answer: OpenRagProductAnswer,
  judgeProducts: readonly OpenRagProductJudge[]
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    answer: answer.answerText,
    acceptedResults: answer.acceptedResults,
    citedEvidence: answer.citedEvidence,
    judgeRawResults: judgeProducts.map(({ rawResult }) => rawResult),
    rawProviderOutputs: answer.rawProviderOutputs ?? null,
    replaySnapshot: answer.replaySnapshot,
    schemaVersion: 2
  });
}

function privateReplayFailureRecord(
  error: unknown
): Readonly<Record<string, unknown>> | undefined {
  const trace = getOpenRagAnswerReplayFailureTrace(error);
  if (!trace) return undefined;
  return Object.freeze({
    acceptedResults: trace.acceptedResults,
    rawProviderOutputs: trace.rawProviderOutputs,
    recordKind: "replay_failure_trace",
    replaySnapshot: trace.replaySnapshot,
    schemaVersion: 1,
    stageRecords: trace.stageRecords
  });
}

function assertProductAnswerIntegrity(
  answer: OpenRagProductAnswer,
  benchmarkCase: OpenRagAnswerCase,
  manifest: OpenRagAnswerRunManifest
): void {
  const operations = answer.acceptedResults.map(({ operation }) => operation);
  const stages = answer.stageRecords.map(({ stage }) => stage);
  const rawProviderOutputs = answer.rawProviderOutputs;
  if (!answer.answerText.trim() || answer.answerText.includes("\u0000") ||
    Buffer.byteLength(answer.answerText, "utf8") > 2 * 1_024 * 1_024 ||
    answer.operationCount < 3 || answer.operationCount >
      KNOWLEDGE_ANSWER_SCOPE_V6_REPAIR_RESERVED_MAX_OPERATION_COUNT_V2 ||
    operations.length !== answer.operationCount || stages.length !== answer.operationCount ||
    operations.some((operation, index) => operation !== stages[index]) ||
    (rawProviderOutputs !== undefined &&
      (rawProviderOutputs.length !== answer.operationCount ||
        rawProviderOutputs.some((raw, index) =>
          raw.ordinal !== index + 1 || raw.operation !== operations[index]))) ||
    !isOpenRagAnswerOperationSequence(answer.replaySnapshot.contracts, operations) ||
    answer.replaySnapshot.contracts.coverageAuditorContractVersion !==
      manifest.engine.coverageAuditorContractVersion ||
    answer.replaySnapshot.contracts.draftContractVersion !==
      manifest.engine.draftContractVersion ||
    answer.replaySnapshot.contracts.selectorContractVersion !==
      manifest.engine.selectorContractVersion ||
    answer.replaySnapshot.contracts.settlementVersion !==
      manifest.engine.settlementVersion ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(answer.answerRunId) ||
    !/^[0-9a-f]{64}$/u.test(answer.replaySnapshot.snapshotHash) ||
    sha256Canonical(answer.replaySnapshot.case) !== sha256Canonical(benchmarkCase) ||
    new Set(answer.citedEvidence.map(({ handle }) => handle)).size !==
      answer.citedEvidence.length) {
    throw new Error("open_rag_answer_product_artifact_invalid");
  }
}

export class OpenRagAnswerNonPassError extends Error {
  readonly caseId: string;
  readonly verdict: "fail" | "partial";

  constructor(caseId: string, verdict: "fail" | "partial") {
    super("open_rag_answer_non_pass_stop");
    this.name = "OpenRagAnswerNonPassError";
    this.caseId = caseId;
    this.verdict = verdict;
  }
}

type OpenRagAnswerBenchmarkInput = Readonly<{
  cases: readonly OpenRagAnswerCase[];
  checkpoint: OpenRagAnswerCheckpointStore;
  emit?: (event: Readonly<Record<string, unknown>>) => void;
  goldDocumentIds: Readonly<Record<string, string>>;
  header: OpenRagAnswerCheckpointHeader;
  now?: () => number;
  replaySnapshot?: OpenRagAnswerReplaySnapshot;
  resume: boolean;
  runtime: OpenRagAnswerRuntime;
  sleep?: (milliseconds: number) => Promise<void>;
}>;

export function runOpenRagAnswerBenchmark(
  input: OpenRagAnswerBenchmarkInput & Readonly<{ maxNewOutcomes: number }>
): Promise<OpenRagAnswerBatchProgress | OpenRagAnswerRunSummary>;
export function runOpenRagAnswerBenchmark(
  input: OpenRagAnswerBenchmarkInput
): Promise<OpenRagAnswerRunSummary>;
export async function runOpenRagAnswerBenchmark(
  input: OpenRagAnswerBenchmarkInput & Readonly<{ maxNewOutcomes?: number }>
): Promise<OpenRagAnswerBatchProgress | OpenRagAnswerRunSummary> {
  const manifest = decodeOpenRagAnswerRunManifest(input.header.manifest);
  const expectedFingerprint = openRagAnswerManifestFingerprint(manifest);
  if (input.header.manifestFingerprint !== expectedFingerprint ||
    input.cases.map(({ caseId }) => caseId).join("\u0000") !==
      manifest.caseIds.join("\u0000") ||
    manifest.mode === "replay" !== Boolean(input.replaySnapshot)) {
    throw new Error("open_rag_answer_schedule_identity_invalid");
  }
  const expectedOutcomeCount = input.cases.length * manifest.repeat;
  if (input.maxNewOutcomes !== undefined &&
    (manifest.mode !== "full" || !manifest.scoreable ||
      !Number.isSafeInteger(input.maxNewOutcomes) ||
      input.maxNewOutcomes < 1 || input.maxNewOutcomes > expectedOutcomeCount)) {
    throw new Error("open_rag_answer_batch_limit_invalid");
  }
  const header = await input.checkpoint.initialize({
    header: input.header,
    resume: input.resume
  });
  const emit = input.emit ?? (() => undefined);
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  const outcomes: OpenRagAnswerOutcome[] = [];
  let newlySettled = 0;
  let previousStart = 0;
  for (const benchmarkCase of input.cases) {
    const goldDocumentId = input.goldDocumentIds[benchmarkCase.documentAlias];
    if (!goldDocumentId) throw new Error("open_rag_answer_alias_map_invalid");
    for (let repeatOrdinal = 1; repeatOrdinal <= manifest.repeat; repeatOrdinal += 1) {
      const expected = { caseId: benchmarkCase.caseId, repeatOrdinal };
      const existing = await input.checkpoint.loadOutcome(expected);
      if (existing) {
        if (Boolean(existing.judgment) !== !manifest.noJudge ||
          existing.diagnosticJudgeRuns.length !==
            (manifest.noJudge ? 0 : manifest.judgeRepeat - 1) ||
          !isOpenRagAnswerOperationSequence(Object.freeze({
            coverageAuditorContractVersion:
              manifest.engine.coverageAuditorContractVersion,
            draftContractVersion: manifest.engine.draftContractVersion,
            selectorContractVersion: manifest.engine.selectorContractVersion,
            settlementVersion: manifest.engine.settlementVersion
          }), existing.stageRecords.map(({ stage }) => stage))) {
          throw new Error("open_rag_answer_resume_checkpoint_invalid");
        }
        outcomes.push(existing);
        if (manifest.mode !== "full" && existing.judgment &&
          existing.judgment.judgment.verdict !== "pass") {
          throw new Error("open_rag_answer_resume_contains_non_pass");
        }
        emit(Object.freeze({
          caseId: benchmarkCase.caseId,
          event: "case_skipped",
          repeatOrdinal
        }));
        continue;
      }
      const waitMs = Math.max(0,
        previousStart + manifest.schedule.caseStartIntervalMs - now());
      if (waitMs > 0) await sleep(waitMs);
      previousStart = now();
      let answer: OpenRagProductAnswer;
      try {
        answer = manifest.mode === "replay"
          ? await input.runtime.executeReplay({
              repeatOrdinal,
              snapshot: input.replaySnapshot!
            })
          : await input.runtime.executeAnswer({
              case: benchmarkCase,
              goldDocumentId,
              repeatOrdinal
            });
        assertProductAnswerIntegrity(answer, benchmarkCase, manifest);
      } catch (error) {
        const code = errorCode(error);
        const diagnostic = replaySnapshotDiagnostic(error);
        const privateRecord = privateReplayFailureRecord(error);
        await input.checkpoint.writeFailure({
          caseId: benchmarkCase.caseId,
          code,
          ...(diagnostic ? { diagnostic } : {}),
          ...(privateRecord ? { privateRecord } : {}),
          repeatOrdinal,
          stage: manifest.mode === "replay" ? "replay" : "answer"
        });
        emit(Object.freeze({
          caseId: benchmarkCase.caseId,
          code,
          event: "case_stopped",
          repeatOrdinal,
          stage: manifest.mode === "replay" ? "replay" : "answer"
        }));
        throw error;
      }
      const officialPrompt = openRagJudgePrompt({
        answer: answer.answerText,
        case: benchmarkCase,
        citationCount: answer.citedEvidence.length,
        citedEvidence: answer.citedEvidence,
        productCoverage: answer.coverage
      });
      const judgeProducts: OpenRagProductJudge[] = [];
      const judgeRecords: OpenRagJudgeStageRecord[] = [];
      if (!manifest.noJudge) {
        try {
          for (let judgeOrdinal = 1; judgeOrdinal <= manifest.judgeRepeat;
            judgeOrdinal += 1) {
            const product = await input.runtime.executeJudge({
              case: benchmarkCase,
              prompt: officialPrompt,
              repeatOrdinal: judgeOrdinal
            });
            judgeProducts.push(product);
            judgeRecords.push(judgeStage(
              product,
              officialPrompt,
              answer.coverage,
              answer.citedEvidence.length
            ));
          }
        } catch (error) {
          const code = errorCode(error);
          await input.checkpoint.writeFailure({
            caseId: benchmarkCase.caseId,
            code,
            privateRecord: privateAnswerRecord(answer, judgeProducts),
            repeatOrdinal,
            stage: "judge"
          });
          emit(Object.freeze({
            caseId: benchmarkCase.caseId,
            code,
            event: "case_stopped",
            repeatOrdinal,
            stage: "judge"
          }));
          throw error;
        }
      }
      const officialJudge = judgeRecords[0] ?? null;
      const classification = officialJudge
        ? classifyOpenRagFailure({
            ...answer.facts,
            answerCompleted: true,
            answerCoverage: answer.coverage,
            answerStageFailure: null,
            judgment: officialJudge.judgment
          })
        : null;
      const outcome = decodeOpenRagAnswerOutcome({
        answerHash: sha256Text(answer.answerText),
        answerRunId: answer.answerRunId,
        caseId: benchmarkCase.caseId,
        classification,
        coverage: answer.coverage,
        diagnosticJudgeRuns: judgeRecords.slice(1),
        judgment: officialJudge,
        operationCount: answer.operationCount,
        repeatOrdinal,
        replaySnapshotHash: answer.replaySnapshot.snapshotHash,
        stageRecords: answer.stageRecords
      }, expected);
      await input.checkpoint.writeOutcome({
        outcome,
        privateRecord: privateAnswerRecord(answer, judgeProducts)
      });
      outcomes.push(outcome);
      newlySettled += 1;
      const verdict = officialJudge?.judgment.verdict ?? "unjudged";
      emit(Object.freeze({
        caseId: benchmarkCase.caseId,
        coverage: answer.coverage,
        event: "case_settled",
        operationCount: answer.operationCount,
        repeatOrdinal,
        verdict
      }));
      if (officialJudge && officialJudge.judgment.verdict !== "pass") {
        emit(Object.freeze({
          caseId: benchmarkCase.caseId,
          classification,
          event: manifest.mode === "full"
            ? "benchmark_non_pass_collected"
            : "benchmark_fail_fast_stop",
          verdict: officialJudge.judgment.verdict
        }));
        if (manifest.mode !== "full") {
          throw new OpenRagAnswerNonPassError(
            benchmarkCase.caseId,
            officialJudge.judgment.verdict
          );
        }
      }
      if (input.maxNewOutcomes !== undefined &&
        newlySettled >= input.maxNewOutcomes &&
        outcomes.length < expectedOutcomeCount) {
        const progress = Object.freeze({
          kind: "paused" as const,
          newlySettled,
          runId: header.runId,
          settled: outcomes.length,
          totalExpected: expectedOutcomeCount
        });
        emit(Object.freeze({
          event: "run_batch_paused",
          newlySettled: progress.newlySettled,
          settled: progress.settled,
          totalExpected: progress.totalExpected
        }));
        return progress;
      }
    }
  }
  const judgments = outcomes.flatMap(({ judgment }) =>
    judgment ? [judgment.judgment] : []);
  const aggregate = aggregateOpenRagJudgments(judgments);
  const summary = Object.freeze({
    ...aggregate,
    runId: header.runId,
    scoreable: manifest.scoreable,
    total: outcomes.length
  });
  if (outcomes.length !== expectedOutcomeCount ||
    !manifest.noJudge && judgments.length !== expectedOutcomeCount) {
    throw new Error("open_rag_answer_summary_incomplete");
  }
  await input.checkpoint.writeSummary(Object.freeze({
    ...summary,
    manifestFingerprint: expectedFingerprint,
    schemaVersion: 1
  }));
  emit(Object.freeze({ event: "run_complete", ...summary }));
  return summary;
}

export function createOpenRagAnswerCheckpointHeader(input: Readonly<{
  createdAt?: string;
  manifest: OpenRagAnswerRunManifest;
  runId?: string;
}>): OpenRagAnswerCheckpointHeader {
  const manifest = decodeOpenRagAnswerRunManifest(input.manifest);
  return decodeOpenRagAnswerCheckpointHeader({
    createdAt: input.createdAt ?? new Date().toISOString(),
    manifest,
    manifestFingerprint: openRagAnswerManifestFingerprint(manifest),
    runId: input.runId ?? `openrag-${randomUUID()}`,
    schemaVersion: OPEN_RAG_ANSWER_CHECKPOINT_SCHEMA_VERSION
  });
}

async function runDirect(): Promise<void> {
  try {
    const { runOpenRagAnswerLive } = await import("./openRagAnswerLive");
    await runOpenRagAnswerLive(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      code: errorCode(error),
      event: "run_failed"
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runDirect();
}
