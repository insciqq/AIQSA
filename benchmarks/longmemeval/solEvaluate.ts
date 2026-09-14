import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import { assertLiveBaseUrl, assertLiveDatabaseUrl, resolveLiveOutputDirectory } from "../aiqsa-memory-live-microbench/contract";
import { safeCode } from "../aiqsa-memory-live-microbench/acceptance/contract";
import { LONGMEMEVAL_EVALUATOR_SHA256 } from "./contract";
import { SOL_EVALUATION_ACK, parseSolVerdict, validateHypotheses } from "./solEvaluationContract";

const root = dirname(fileURLToPath(import.meta.url));
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--ack" || args[1] !== SOL_EVALUATION_ACK || args[2] !== "--run" || process.env.AIQSA_TEST_MODE !== "1") {
    throw new Error("longmemeval_sol_evaluation_authority_required");
  }
  const baseUrl = assertLiveBaseUrl(process.env.AIQSA_MEMORY_ACCEPTANCE_BASE_URL ?? "", Number(process.env.AIQSA_MEMORY_BENCHMARK_APP_PORT));
  const database = assertLiveDatabaseUrl(process.env.AIQSA_MEMORY_ACCEPTANCE_DATABASE_URL ?? "", Number(process.env.AIQSA_MEMORY_BENCHMARK_POSTGRES_PORT));
  database.searchParams.set("connection_limit", "4");
  process.env.DATABASE_URL = database.toString();
  loadEnvConfig(resolve(root, "../.."), true, { info() {}, error() {} });
  if (process.env.DATABASE_URL !== database.toString()) throw new Error("longmemeval_sol_database_authority_changed");
  const directory = resolveLiveOutputDirectory(root, args[3]!);
  const summary = JSON.parse(await readFile(resolve(directory, "run-summary.json"), "utf8")) as { selection: { questionIds: string[] } };
  const bytes = await readFile(resolve(directory, "answers.jsonl"));
  const hypotheses = validateHypotheses(bytes.toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)), summary.selection.questionIds);
  const prompts = JSON.parse(execFileSync("python3", [resolve(root, "solEvaluationPrompts.py")], {
    input: JSON.stringify(hypotheses), encoding: "utf8", maxBuffer: 8_000_000, stdio: ["pipe", "pipe", "pipe"]
  })) as { rows: Array<{ id: string; type: string; prompt: string }>; controls: Array<{ expected: boolean; prompt: string }> };
  const output = resolve(directory, "sol-evaluation.json");
  // Exclusive creation prevents silently replacing a prior judge attempt.
  await writeFile(output, "{}\n", { flag: "wx", mode: 0o600 });
  const { AcceptanceDriver, PROFILE, EXECUTION_LIMITS } = await import("../aiqsa-memory-live-microbench/acceptance/driver");
  const driver = new AcceptanceDriver(baseUrl, database.toString());
  const results: Array<{ id: string; type: string; correct: boolean; code: string | null }> = [];
  const calibration: Array<{ expected: boolean; actual: boolean }> = [];
  let metadata: Record<string, unknown> = { officialScore: false, judge: PROFILE.judge, executionLimits: EXECUTION_LIMITS,
    rubricSha256: LONGMEMEVAL_EVALUATOR_SHA256, answersSha256: createHash("sha256").update(bytes).digest("hex"),
    startedAt: new Date().toISOString(), total: summary.selection.questionIds.length };
  const save = async () => writeFile(output, JSON.stringify({ ...metadata, calibration, results,
    correct: results.filter((item) => item.correct && item.code === null).length,
    complete: results.length === summary.selection.questionIds.length,
    ownedUserIds: driver.ownedUserIds }, null, 2), { mode: 0o600 });
  try {
    await driver.prepare();
    metadata.profileFingerprint = driver.profileFingerprint;
    const identity = await driver.identity("longmemeval.sol.judge", false);
    const evaluate = async (prompt: string) => {
      const response = await driver.send(identity, driver.conversation("EXCLUDED"), prompt);
      if (!response.ownerIsolation || response.memoryItems !== 0 || ["FAILED_SAFE", "DEGRADED"].includes(response.memoryOutcome)) throw new Error("longmemeval_sol_judge_contaminated");
      return parseSolVerdict(response.answer);
    };
    for (const control of prompts.controls) {
      const actual = await evaluate(control.prompt);
      calibration.push({ expected: control.expected, actual });
      await save();
    }
    if (calibration.some((item) => item.actual !== item.expected)) throw new Error("longmemeval_sol_calibration_failed");
    for (const id of summary.selection.questionIds) {
      const row = prompts.rows.find((item) => item.id === id);
      const result = { id, type: row?.type ?? "unanswered", correct: false, code: row ? null : "longmemeval_answer_missing" as string | null };
      try { if (row) result.correct = await evaluate(row.prompt); }
      catch (error) { result.code = safeCode(error); }
      results.push(result);
      await save();
      emit({ event: "sol_judged", id, correct: result.correct, code: result.code, done: results.length });
    }
    metadata = { ...metadata, finishedAt: new Date().toISOString(), usage: await driver.usage() };
    await save();
    if (results.some((item) => item.code !== null)) process.exitCode = 2;
  } catch (error) { metadata.failureCode = safeCode(error); await save(); throw error; }
  finally {
    await driver.prisma.$disconnect();
    const { prisma } = await import("../../lib/server/prisma");
    await prisma.$disconnect();
  }
}
void main().catch((error: unknown) => { emit({ event: "failed", code: safeCode(error) }); process.exitCode = 1; });
