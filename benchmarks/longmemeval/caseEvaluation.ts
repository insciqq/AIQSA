import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { resolve } from "node:path";
import {
  LONGMEMEVAL_EVALUATOR_SHA256,
  LONGMEMEVAL_ORACLE_SHA256
} from "./contract";
import {
  LONGMEMEVAL_OFFICIAL_EVALUATOR_MODEL,
  decodeLongMemEvalOfficialRows,
  runLongMemEvalOfficialEvaluator,
  type LongMemEvalOfficialEvaluation,
  type LongMemEvalOfficialHypothesis
} from "./officialEvaluator";

const directoryName = "case-evaluations";
const safeQuestionId = /^[A-Za-z0-9_]{1,64}$/u;

export type LongMemEvalCaseEvaluation = Readonly<{
  answerSha256: string;
  attempt: number;
  evaluatedAt: string;
  evaluator: Readonly<{
    model: typeof LONGMEMEVAL_OFFICIAL_EVALUATOR_MODEL;
    oracleSha256: typeof LONGMEMEVAL_ORACLE_SHA256;
    scriptSha256: typeof LONGMEMEVAL_EVALUATOR_SHA256;
    unchanged: true;
  }>;
  label: boolean;
  questionId: string;
  row: Record<string, unknown>;
  version: 1;
}>;

type OfficialEvaluator = (
  hypotheses: readonly LongMemEvalOfficialHypothesis[],
  concurrency: number
) => Promise<LongMemEvalOfficialEvaluation>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function answerSha256(hypothesis: string): string {
  return createHash("sha256")
    .update("aiqsa.longmemeval.answer.v1\0", "utf8")
    .update(hypothesis, "utf8")
    .digest("hex");
}

function artifactPath(
  outputDirectory: string,
  questionId: string,
  attempt: number
): string {
  if (!safeQuestionId.test(questionId) ||
    !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("longmemeval_case_evaluation_identity_invalid");
  }
  return resolve(
    outputDirectory,
    directoryName,
    `${questionId}.${String(attempt).padStart(3, "0")}.json`
  );
}

function decodeCaseEvaluation(
  value: unknown,
  expected: Readonly<{
    attempt: number;
    hypothesis: string;
    questionId: string;
  }>
): LongMemEvalCaseEvaluation {
  if (!isRecord(value) || value.version !== 1 ||
    value.questionId !== expected.questionId || value.attempt !== expected.attempt ||
    value.answerSha256 !== answerSha256(expected.hypothesis) ||
    typeof value.evaluatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.evaluatedAt)) ||
    typeof value.label !== "boolean" || !isRecord(value.evaluator) ||
    value.evaluator.model !== LONGMEMEVAL_OFFICIAL_EVALUATOR_MODEL ||
    value.evaluator.oracleSha256 !== LONGMEMEVAL_ORACLE_SHA256 ||
    value.evaluator.scriptSha256 !== LONGMEMEVAL_EVALUATOR_SHA256 ||
    value.evaluator.unchanged !== true || !isRecord(value.row)) {
    throw new Error("longmemeval_case_evaluation_invalid");
  }
  const rows = decodeLongMemEvalOfficialRows(
    [value.row],
    new Map([[expected.questionId, expected.hypothesis]])
  );
  if (rows[0]?.value.label !== value.label) {
    throw new Error("longmemeval_case_evaluation_invalid");
  }
  return Object.freeze({
    answerSha256: value.answerSha256,
    attempt: value.attempt,
    evaluatedAt: value.evaluatedAt,
    evaluator: Object.freeze({
      model: LONGMEMEVAL_OFFICIAL_EVALUATOR_MODEL,
      oracleSha256: LONGMEMEVAL_ORACLE_SHA256,
      scriptSha256: LONGMEMEVAL_EVALUATOR_SHA256,
      unchanged: true as const
    }),
    label: value.label,
    questionId: value.questionId,
    row: value.row,
    version: 1 as const
  });
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function readLongMemEvalCaseEvaluation(input: Readonly<{
  attempt: number;
  hypothesis: string;
  outputDirectory: string;
  questionId: string;
}>): Promise<LongMemEvalCaseEvaluation | null> {
  const path = artifactPath(input.outputDirectory, input.questionId, input.attempt);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("longmemeval_case_evaluation_invalid");
  }
  return decodeCaseEvaluation(value, input);
}

export async function settleLongMemEvalCaseEvaluation(
  input: Readonly<{
    attempt: number;
    hypothesis: string;
    outputDirectory: string;
    questionId: string;
  }>,
  evaluate: OfficialEvaluator = runLongMemEvalOfficialEvaluator
): Promise<LongMemEvalCaseEvaluation> {
  const existing = await readLongMemEvalCaseEvaluation(input);
  if (existing) return existing;
  const evaluation = await evaluate([{
    hypothesis: input.hypothesis,
    questionId: input.questionId
  }], 1);
  const row = evaluation.rows[0];
  if (!row || row.questionId !== input.questionId || evaluation.rows.length !== 1) {
    throw new Error("longmemeval_case_evaluation_incomplete");
  }
  const artifact: LongMemEvalCaseEvaluation = Object.freeze({
    answerSha256: answerSha256(input.hypothesis),
    attempt: input.attempt,
    evaluatedAt: new Date().toISOString(),
    evaluator: Object.freeze({
      model: LONGMEMEVAL_OFFICIAL_EVALUATOR_MODEL,
      oracleSha256: LONGMEMEVAL_ORACLE_SHA256,
      scriptSha256: LONGMEMEVAL_EVALUATOR_SHA256,
      unchanged: true as const
    }),
    label: row.label,
    questionId: input.questionId,
    row: row.value,
    version: 1 as const
  });
  await mkdir(resolve(input.outputDirectory, directoryName), {
    mode: 0o700,
    recursive: true
  });
  await writeJsonAtomic(
    artifactPath(input.outputDirectory, input.questionId, input.attempt),
    artifact
  );
  return artifact;
}

export function longMemEvalCaseEvaluationsDirectory(outputDirectory: string): string {
  return resolve(outputDirectory, directoryName);
}

export async function loadLongMemEvalLatestCaseEvaluations(input: Readonly<{
  hypotheses: readonly Readonly<{ hypothesis: string; questionId: string }>[];
  outputDirectory: string;
}>): Promise<readonly LongMemEvalCaseEvaluation[]> {
  const directory = longMemEvalCaseEvaluationsDirectory(input.outputDirectory);
  const expected = new Set(input.hypotheses.map(({ questionId }) => questionId));
  if (expected.size !== input.hypotheses.length) {
    throw new Error("longmemeval_case_evaluation_selection_invalid");
  }
  const attempts = new Map<string, number>();
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => {
    throw new Error("longmemeval_case_evaluation_directory_unavailable");
  });
  for (const entry of entries) {
    const match = /^([A-Za-z0-9_]{1,64})\.(\d{3,})\.json$/u.exec(entry.name);
    if (!entry.isFile() || !match || !expected.has(match[1]!)) {
      throw new Error("longmemeval_case_evaluation_directory_invalid");
    }
    const attempt = Number(match[2]);
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
      throw new Error("longmemeval_case_evaluation_directory_invalid");
    }
    attempts.set(match[1]!, Math.max(attempts.get(match[1]!) ?? 0, attempt));
  }
  return Object.freeze(await Promise.all(input.hypotheses.map(async (hypothesis) => {
    const attempt = attempts.get(hypothesis.questionId);
    if (!attempt) throw new Error("longmemeval_case_evaluation_incomplete");
    const evaluation = await readLongMemEvalCaseEvaluation({
      ...hypothesis,
      attempt,
      outputDirectory: input.outputDirectory
    });
    if (!evaluation) throw new Error("longmemeval_case_evaluation_incomplete");
    return evaluation;
  })));
}
