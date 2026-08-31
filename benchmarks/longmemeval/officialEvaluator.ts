import { createReadStream } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LONGMEMEVAL_EVALUATOR_SHA256,
  LONGMEMEVAL_MAX_EVALUATOR_CONCURRENCY,
  LONGMEMEVAL_ORACLE_SHA256,
  mapConcurrentOrdered,
  mergeLongMemEvalEvaluationResults,
  partitionLongMemEvalEvaluation,
  type LongMemEvalEvaluationValue
} from "./contract";

const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const upstreamRoot = resolve(benchmarkRoot, ".upstream");
const evaluatorPath = resolve(upstreamRoot, "src/evaluation/evaluate_qa.py");
const oraclePath = resolve(upstreamRoot, "data/longmemeval_oracle.json");
const pythonPath = resolve(upstreamRoot, ".venv/bin/python");

export const LONGMEMEVAL_OFFICIAL_EVALUATOR_MODEL =
  "gpt-4o-2024-08-06" as const;

export type LongMemEvalOfficialHypothesis = Readonly<{
  hypothesis: string;
  questionId: string;
}>;

export type LongMemEvalOfficialEvaluationRow = Readonly<{
  label: boolean;
  questionId: string;
  value: Record<string, unknown>;
}>;

export type LongMemEvalOfficialEvaluation = Readonly<{
  labels: ReadonlyMap<string, boolean>;
  rows: readonly LongMemEvalOfficialEvaluationRow[];
  shards: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

let runtimeProof: Promise<void> | null = null;

export async function assertLongMemEvalOfficialEvaluatorRuntime(): Promise<void> {
  runtimeProof ??= Promise.all([
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
    })
  ]).then(() => undefined).catch((error: unknown) => {
    runtimeProof = null;
    throw error;
  });
  return runtimeProof;
}

async function runEvaluator(answersPath: string): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(
      pythonPath,
      [evaluatorPath, "gpt-4o", answersPath, oraclePath],
      {
        cwd: upstreamRoot,
        env: process.env,
        // The unchanged upstream evaluator prints private benchmark material.
        stdio: "ignore"
      }
    );
    child.once("error", () => rejectRun(new Error(
      "longmemeval_evaluator_spawn_failed"
    )));
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

export function decodeLongMemEvalOfficialRows(
  values: readonly unknown[],
  expectedHypotheses: ReadonlyMap<string, string>
): readonly LongMemEvalEvaluationValue<LongMemEvalOfficialEvaluationRow>[] {
  const rows: LongMemEvalEvaluationValue<LongMemEvalOfficialEvaluationRow>[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!isRecord(value) || typeof value.question_id !== "string" ||
      typeof value.hypothesis !== "string" ||
      !isRecord(value.autoeval_label) ||
      value.autoeval_label.model !== LONGMEMEVAL_OFFICIAL_EVALUATOR_MODEL ||
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

async function decodeOfficialRows(
  resultPath: string,
  expectedHypotheses: ReadonlyMap<string, string>
): Promise<readonly LongMemEvalEvaluationValue<LongMemEvalOfficialEvaluationRow>[]> {
  return decodeLongMemEvalOfficialRows(
    parseJsonLines(
      await readFile(resultPath, "utf8"),
      "longmemeval_evaluator_result_invalid"
    ),
    expectedHypotheses
  );
}

export async function runLongMemEvalOfficialEvaluator(
  hypotheses: readonly LongMemEvalOfficialHypothesis[],
  concurrency: number
): Promise<LongMemEvalOfficialEvaluation> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("longmemeval_openai_key_missing");
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 ||
    concurrency > LONGMEMEVAL_MAX_EVALUATOR_CONCURRENCY ||
    new Set(hypotheses.map(({ questionId }) => questionId)).size !==
      hypotheses.length ||
    hypotheses.some(({ hypothesis, questionId }) =>
      !questionId || !hypothesis.trim())) {
    throw new Error("longmemeval_evaluator_input_invalid");
  }
  await assertLongMemEvalOfficialEvaluatorRuntime();
  const shards = partitionLongMemEvalEvaluation(hypotheses, concurrency);
  if (shards.length === 0) {
    return Object.freeze({
      labels: new Map(),
      rows: Object.freeze([]),
      shards: 0
    });
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
    const rows: readonly LongMemEvalOfficialEvaluationRow[] =
      mergeLongMemEvalEvaluationResults<LongMemEvalOfficialEvaluationRow>(
        hypotheses.map(({ questionId }) => questionId),
        evaluatedShards
      );
    return Object.freeze({
      labels: new Map<string, boolean>(rows.map(({ label, questionId }) => [
        questionId,
        label
      ])),
      rows: Object.freeze(rows),
      shards: shards.length
    });
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}
