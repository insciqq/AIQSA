import { createReadStream } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import { loadLongMemEvalLatestCaseEvaluations } from "./caseEvaluation";
import {
  LONGMEMEVAL_EVALUATOR_SHA256,
  LONGMEMEVAL_MAX_EVALUATOR_CONCURRENCY,
  LONGMEMEVAL_ORACLE_SHA256,
  LONGMEMEVAL_REPOSITORY_COMMIT,
  LONGMEMEVAL_S_SHA256,
  decodeLongMemEvalProfileManifest,
  longMemEvalQualificationGate,
  mapConcurrentOrdered,
  mergeLongMemEvalEvaluationResults,
  partitionLongMemEvalEvaluation,
  type LongMemEvalEvaluationValue,
  type LongMemEvalProfileManifest
} from "./contract";

const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(benchmarkRoot, "../..");
const resultsRoot = resolve(benchmarkRoot, "results");
const upstreamRoot = resolve(benchmarkRoot, ".upstream");
const evaluatorPath = resolve(upstreamRoot, "src/evaluation/evaluate_qa.py");
const oraclePath = resolve(upstreamRoot, "data/longmemeval_oracle.json");
const pythonPath = resolve(upstreamRoot, ".venv/bin/python");

type Hypothesis = Readonly<{ hypothesis: string; questionId: string }>;
type ScoredCase = Readonly<{
  executionFailed: boolean;
  memoryOutcome: string | null;
  questionId: string;
  questionType: string;
}>;
type EvaluationContract = Readonly<{
  cases: readonly ScoredCase[];
  hypotheses: readonly Hypothesis[];
  profile: LongMemEvalProfileManifest;
}>;
type OfficialEvaluationRow = Readonly<{
  label: boolean;
  questionId: string;
  value: Record<string, unknown>;
}>;
type EvaluatorOptions = Readonly<{
  answersArgument: string | undefined;
  concurrency: number;
  reuseCaseEvaluations: boolean;
}>;

const DEFAULT_EVALUATOR_CONCURRENCY = 16;

function safeCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "longmemeval_evaluator_failed";
  return /^[A-Za-z0-9_:-]{1,160}$/u.test(message)
    ? message
    : "longmemeval_evaluator_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEvaluatorOptions(argv: readonly string[]): EvaluatorOptions {
  const answersArgument = argv[0];
  let concurrency = DEFAULT_EVALUATOR_CONCURRENCY;
  let concurrencyExplicit = false;
  let reuseCaseEvaluations = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--reuse-case-evaluations") {
      if (reuseCaseEvaluations) {
        throw new Error("longmemeval_evaluator_argument_duplicate");
      }
      reuseCaseEvaluations = true;
      continue;
    }
    if (argument !== "--concurrency") {
      throw new Error(`longmemeval_evaluator_argument_unknown:${argument ?? "missing"}`);
    }
    const raw = argv[index + 1];
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 1 ||
      parsed > LONGMEMEVAL_MAX_EVALUATOR_CONCURRENCY) {
      throw new Error("longmemeval_evaluator_concurrency_invalid");
    }
    concurrency = parsed;
    concurrencyExplicit = true;
    index += 1;
  }
  if (reuseCaseEvaluations && concurrencyExplicit) {
    throw new Error("longmemeval_evaluator_reuse_concurrency_forbidden");
  }
  return Object.freeze({ answersArgument, concurrency, reuseCaseEvaluations });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function resolveAnswersPath(argument: string | undefined): Promise<string> {
  if (!argument) throw new Error("longmemeval_answers_path_required");
  const candidate = resolve(repositoryRoot, argument);
  const [root, answers] = await Promise.all([
    realpath(resultsRoot),
    realpath(candidate)
  ]);
  if (!answers.startsWith(`${root}${sep}`) || !answers.endsWith(`${sep}answers.jsonl`)) {
    throw new Error("longmemeval_answers_path_not_isolated");
  }
  return answers;
}

function parseJsonLines(text: string, code: string): readonly unknown[] {
  return text.split("\n").filter((line) => line.length > 0).map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new Error(code);
    }
  });
}

async function decodeAnswers(path: string): Promise<readonly Hypothesis[]> {
  const values = parseJsonLines(
    await readFile(path, "utf8"),
    "longmemeval_answers_invalid"
  );
  const hypotheses = values.map((parsed) => {
    if (!isRecord(parsed) || typeof parsed.question_id !== "string" ||
      !parsed.question_id || typeof parsed.hypothesis !== "string" ||
      !parsed.hypothesis.trim()) {
      throw new Error("longmemeval_answers_invalid");
    }
    return Object.freeze({
      hypothesis: parsed.hypothesis,
      questionId: parsed.question_id
    });
  });
  if (new Set(hypotheses.map(({ questionId }) => questionId)).size !==
    hypotheses.length) {
    throw new Error("longmemeval_answers_duplicate");
  }
  return Object.freeze(hypotheses);
}

function decodeCaseSummary(
  value: unknown,
  executionFailed: boolean
): ScoredCase {
  if (!isRecord(value) || typeof value.questionId !== "string" ||
    !value.questionId || typeof value.questionType !== "string" ||
    !value.questionType) {
    throw new Error("longmemeval_run_summary_invalid");
  }
  const memoryOutcome = executionFailed
    ? null
    : isRecord(value.answer) && typeof value.answer.memoryOutcome === "string" &&
        value.answer.memoryOutcome
      ? value.answer.memoryOutcome
      : null;
  if (!executionFailed && memoryOutcome === null) {
    throw new Error("longmemeval_run_summary_invalid");
  }
  return Object.freeze({
    executionFailed,
    memoryOutcome,
    questionId: value.questionId,
    questionType: value.questionType
  });
}

async function decodeEvaluationContract(
  answersPath: string
): Promise<EvaluationContract> {
  const summaryPath = resolve(dirname(answersPath), "run-summary.json");
  const [hypotheses, rawSummary] = await Promise.all([
    decodeAnswers(answersPath),
    readFile(summaryPath, "utf8").then((text) => JSON.parse(text) as unknown)
  ]);
  if (!isRecord(rawSummary) || rawSummary.upstreamCommit !==
      LONGMEMEVAL_REPOSITORY_COMMIT ||
    !isRecord(rawSummary.dataset) || rawSummary.dataset.sha256 !==
      LONGMEMEVAL_S_SHA256 ||
    !isRecord(rawSummary.evaluator) || rawSummary.evaluator.sha256 !==
      LONGMEMEVAL_EVALUATOR_SHA256 ||
    rawSummary.evaluator.referenceSha256 !== LONGMEMEVAL_ORACLE_SHA256 ||
    !isRecord(rawSummary.selection) ||
    !Array.isArray(rawSummary.selection.questionIds) ||
    !Array.isArray(rawSummary.results) || !Array.isArray(rawSummary.failures)) {
    throw new Error("longmemeval_run_summary_invalid");
  }
  const selectedIds = rawSummary.selection.questionIds;
  if (selectedIds.some((value) => typeof value !== "string" || !value) ||
    new Set(selectedIds).size !== selectedIds.length || selectedIds.length === 0) {
    throw new Error("longmemeval_run_summary_invalid");
  }
  const successful = rawSummary.results.map((value) =>
    decodeCaseSummary(value, false));
  const failed = rawSummary.failures.map((value) =>
    decodeCaseSummary(value, true));
  const cases = [...successful, ...failed];
  const caseIds = cases.map(({ questionId }) => questionId);
  const hypothesisIds = hypotheses.map(({ questionId }) => questionId);
  if (new Set(caseIds).size !== caseIds.length ||
    caseIds.length !== selectedIds.length ||
    caseIds.some((id) => !selectedIds.includes(id)) ||
    hypotheses.length !== successful.length ||
    hypothesisIds.some((id) => !successful.some((entry) =>
      entry.questionId === id))) {
    throw new Error("longmemeval_result_alignment_invalid");
  }
  return Object.freeze({
    cases: Object.freeze(cases),
    hypotheses,
    profile: decodeLongMemEvalProfileManifest(rawSummary.profile)
  });
}

async function runEvaluator(answersPath: string): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(
      pythonPath,
      [evaluatorPath, "gpt-4o", answersPath, oraclePath],
      {
        cwd: upstreamRoot,
        env: process.env,
        // The unchanged upstream script prints the private question, oracle
        // answer, and hypothesis. Its output is intentionally not inherited.
        stdio: "ignore"
      }
    );
    child.once("error", () => rejectRun(new Error("longmemeval_evaluator_spawn_failed")));
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(
        signal
          ? `longmemeval_evaluator_signal:${signal}`
          : `longmemeval_evaluator_exit:${code ?? "unknown"}`
      ));
    });
  });
}

async function decodeOfficialRows(
  resultPath: string,
  expectedHypotheses: ReadonlyMap<string, string>
): Promise<readonly LongMemEvalEvaluationValue<OfficialEvaluationRow>[]> {
  const values = parseJsonLines(
    await readFile(resultPath, "utf8"),
    "longmemeval_evaluator_result_invalid"
  );
  const rows: LongMemEvalEvaluationValue<OfficialEvaluationRow>[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!isRecord(value) || typeof value.question_id !== "string" ||
      typeof value.hypothesis !== "string" ||
      !isRecord(value.autoeval_label) ||
      value.autoeval_label.model !== "gpt-4o-2024-08-06" ||
      typeof value.autoeval_label.label !== "boolean" ||
      seen.has(value.question_id) ||
      expectedHypotheses.get(value.question_id) !== value.hypothesis) {
      throw new Error("longmemeval_evaluator_result_invalid");
    }
    seen.add(value.question_id);
    rows.push(Object.freeze({
      questionId: value.question_id,
      value: Object.freeze({
        label: value.autoeval_label.label,
        questionId: value.question_id,
        value
      })
    }));
  }
  if (rows.length !== expectedHypotheses.size) {
    throw new Error("longmemeval_evaluator_result_incomplete");
  }
  return Object.freeze(rows);
}

async function runEvaluatorShards(
  resultPath: string,
  hypotheses: readonly Hypothesis[],
  concurrency: number
): Promise<Readonly<{
  labels: ReadonlyMap<string, boolean>;
  shards: number;
}>> {
  const shards = partitionLongMemEvalEvaluation(hypotheses, concurrency);
  if (shards.length === 0) {
    await writeFile(resultPath, "", { flag: "wx", mode: 0o600 });
    return Object.freeze({ labels: new Map(), shards: 0 });
  }
  const temporaryDirectory = await mkdtemp(resolve(
    tmpdir(),
    "aiqsa-longmemeval-evaluator-"
  ));
  try {
    const evaluatedShards = await mapConcurrentOrdered(
      shards,
      Math.min(concurrency, shards.length),
      async (shard, index) => {
        const shardAnswersPath = resolve(
          temporaryDirectory,
          `answers-${String(index).padStart(3, "0")}.jsonl`
        );
        await writeFile(
          shardAnswersPath,
          `${shard.map(({ hypothesis, questionId }) => JSON.stringify({
            hypothesis,
            question_id: questionId
          })).join("\n")}\n`,
          { flag: "wx", mode: 0o600 }
        );
        await runEvaluator(shardAnswersPath);
        return decodeOfficialRows(
          `${shardAnswersPath}.eval-results-gpt-4o`,
          new Map(shard.map(({ hypothesis, questionId }) => [
            questionId,
            hypothesis
          ]))
        );
      }
    );
    const orderedRows = mergeLongMemEvalEvaluationResults(
      hypotheses.map(({ questionId }) => questionId),
      evaluatedShards
    );
    await writeFile(
      resultPath,
      `${orderedRows.map(({ value }) => JSON.stringify(value)).join("\n")}\n`,
      { flag: "wx", mode: 0o600 }
    );
    return Object.freeze({
      labels: new Map(orderedRows.map(({ label, questionId }) => [
        questionId,
        label
      ])),
      shards: shards.length
    });
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

async function writeAggregateScore(
  scorePath: string,
  contract: EvaluationContract,
  labels: ReadonlyMap<string, boolean>,
  evaluatorConcurrency: number,
  evaluatorShards: number,
  reusedCaseEvaluations = false
): Promise<boolean> {
  const categories = new Map<string, { correct: number; total: number }>();
  let correct = 0;
  for (const entry of contract.cases) {
    const label = labels.get(entry.questionId) ?? false;
    if (label) correct += 1;
    const category = categories.get(entry.questionType) ?? { correct: 0, total: 0 };
    category.total += 1;
    if (label) category.correct += 1;
    categories.set(entry.questionType, category);
  }
  const total = contract.cases.length;
  const qualification = longMemEvalQualificationGate({
    executionFailures: contract.cases.filter(({ executionFailed }) =>
      executionFailed).length,
    memoryOutcomes: contract.cases.flatMap(({ memoryOutcome }) =>
      memoryOutcome === null ? [] : [memoryOutcome])
  });
  const score = {
    accuracy: correct / total,
    answeredCases: contract.hypotheses.length,
    categories: Object.fromEntries([...categories.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, {
        accuracy: value.correct / value.total,
        correct: value.correct,
        total: value.total
      }])),
    correctCases: correct,
    executionFailedCases: qualification.executionFailures,
    memoryDegradedCases: qualification.degradedMemoryOutcomes,
    officialEvaluator: {
      evaluatedCases: labels.size,
      model: "gpt-4o-2024-08-06",
      requestedConcurrency: evaluatorConcurrency,
      reusedCaseEvaluations,
      scriptSha256: LONGMEMEVAL_EVALUATOR_SHA256,
      shards: evaluatorShards,
      unchanged: true
    },
    profile: contract.profile,
    qualificationPassed: qualification.passed,
    totalCases: total,
    version: 4
  };
  await writeFile(scorePath, `${JSON.stringify(score, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  process.stdout.write(`${JSON.stringify({
    accuracy: score.accuracy,
    answeredCases: score.answeredCases,
    correctCases: score.correctCases,
    event: "benchmark_score",
    executionFailedCases: score.executionFailedCases,
    memoryDegradedCases: score.memoryDegradedCases,
    officialComparable: contract.profile.officialComparable,
    profile: contract.profile.id,
    qualificationPassed: score.qualificationPassed,
    totalCases: score.totalCases
  })}\n`);
  return qualification.passed;
}

async function main(): Promise<void> {
  loadEnvConfig(repositoryRoot, true, { error() {}, info() {} }, true);
  const options = parseEvaluatorOptions(process.argv.slice(2));
  if (!options.reuseCaseEvaluations && !process.env.OPENAI_API_KEY) {
    throw new Error("longmemeval_openai_key_missing");
  }
  const answersPath = await resolveAnswersPath(options.answersArgument);
  const resultPath = `${answersPath}.eval-results-gpt-4o`;
  const scorePath = resolve(dirname(answersPath), "benchmark-score.json");
  const [contract] = await Promise.all([
    decodeEvaluationContract(answersPath),
    access(pythonPath),
    sha256File(evaluatorPath).then((hash) => {
      if (hash !== LONGMEMEVAL_EVALUATOR_SHA256) {
        throw new Error("longmemeval_evaluator_integrity_failed");
      }
    }),
    sha256File(oraclePath).then((hash) => {
      if (hash !== LONGMEMEVAL_ORACLE_SHA256) {
        throw new Error("longmemeval_reference_integrity_failed");
      }
    }),
    ...[resultPath, scorePath].map((path) => access(path).then(
      () => Promise.reject(new Error("longmemeval_evaluator_output_exists")),
      () => Promise.resolve()
    ))
  ]);
  const evaluation = options.reuseCaseEvaluations
    ? await loadLongMemEvalLatestCaseEvaluations({
        hypotheses: contract.hypotheses,
        outputDirectory: dirname(answersPath)
      }).then(async (evaluations) => {
        await writeFile(
          resultPath,
          `${evaluations.map(({ row }) => JSON.stringify(row)).join("\n")}\n`,
          { flag: "wx", mode: 0o600 }
        );
        return Object.freeze({
          labels: new Map(evaluations.map(({ label, questionId }) => [
            questionId,
            label
          ])),
          shards: evaluations.length
        });
      })
    : await runEvaluatorShards(
        resultPath,
        contract.hypotheses,
        options.concurrency
      );
  const qualificationPassed = await writeAggregateScore(
    scorePath,
    contract,
    evaluation.labels,
    options.reuseCaseEvaluations ? 1 : options.concurrency,
    evaluation.shards,
    options.reuseCaseEvaluations
  );
  if (!qualificationPassed) process.exitCode = 2;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${safeCode(error)}\n`);
  process.exitCode = 1;
});
