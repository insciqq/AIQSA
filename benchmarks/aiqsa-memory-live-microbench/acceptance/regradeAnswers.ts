import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import { textFromContentBlocks } from "../../../lib/domain/modelRunEvents";
import { currentLongMemEvalQualificationRevision } from "../../longmemeval/qualificationRevision";
import { assertLiveBaseUrl, assertLiveDatabaseUrl, resolveLiveOutputDirectory } from "../contract";
import { ACCEPTANCE_ACK, ACCEPTANCE_CORPUS_SHA256, corpusFingerprint, corpusSchema, safeCode, summarizeResults, type ScenarioResult } from "./contract";
import { ANSWER_JUDGE_SYSTEM, judgeAnswer } from "./answerGrading";
import { ACTOR_JUDGE_INSTRUCTION } from "./actorGrading";

type StoredProbe = { id: string; status: string; userMessage: { content: unknown };
  assistantMessage: { status: string; content: unknown } | null };
const plainText = (value: unknown) => textFromContentBlocks(value as { blocks?: unknown[] }).trim();

export function uniqueStoredProbeAnswer(question: string, runs: readonly StoredProbe[]) {
  const matching = runs.filter((run) => plainText(run.userMessage.content) === question.trim());
  const run = matching[0];
  if (matching.length !== 1 || !run || run.status !== "complete" ||
    run.assistantMessage?.status !== "complete") throw new Error("memory_acceptance_regrade_probe_ambiguous");
  const answer = plainText(run.assistantMessage.content);
  if (!answer) throw new Error("memory_acceptance_regrade_answer_missing");
  return { runId: run.id, answer };
}

const root = dirname(fileURLToPath(import.meta.url));
const benchmarkRoot = resolve(root, "..");
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
function failureEvidence(error: unknown) {
  const types = ["Error", "TypeError", "RangeError", "AbortError", "TimeoutError", "ZodError", "PrismaClientKnownRequestError"];
  const networkCodes = ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"];
  const cause = error instanceof Error ? error.cause : null;
  const causeCode = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
  return { code: safeCode(error), errorType: error instanceof Error && types.includes(error.name) ? error.name : "Other",
    ...(typeof causeCode === "string" && networkCodes.includes(causeCode) ? { causeCode } : {}) };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== "--ack" || args[1] !== ACCEPTANCE_ACK ||
    args[2] !== "--from" || args[4] !== "--output" || process.env.AIQSA_TEST_MODE !== "1") {
    throw new Error("memory_acceptance_regrade_authority_required");
  }
  const baseUrl = assertLiveBaseUrl(process.env.AIQSA_MEMORY_ACCEPTANCE_BASE_URL ?? "", Number(process.env.AIQSA_MEMORY_BENCHMARK_APP_PORT));
  const database = assertLiveDatabaseUrl(process.env.AIQSA_MEMORY_ACCEPTANCE_DATABASE_URL ?? "", Number(process.env.AIQSA_MEMORY_BENCHMARK_POSTGRES_PORT));
  database.searchParams.set("connection_limit", "4");
  process.env.DATABASE_URL = database.toString();
  loadEnvConfig(resolve(root, "../../.."), true, { info() {}, error() {} });
  if (process.env.DATABASE_URL !== database.toString()) throw new Error("memory_acceptance_database_authority_changed");
  const source = resolveLiveOutputDirectory(benchmarkRoot, args[3]!);
  const output = resolveLiveOutputDirectory(benchmarkRoot, args[5]!);
  const corpus = corpusSchema.parse(JSON.parse(await readFile(resolve(root, "corpus.json"), "utf8")));
  if (corpusFingerprint(corpus) !== ACCEPTANCE_CORPUS_SHA256) throw new Error("memory_acceptance_corpus_changed");
  const priorBytes = await readFile(resolve(source, "report.json"));
  const prior = JSON.parse(priorBytes.toString("utf8")) as Record<string, unknown> & {
    corpusSha256: string; finishedAt?: string; failureCode?: string; scenarioIds: string[];
    profileFingerprint: string; calibration: { correct: number; total: number }; results: ScenarioResult[];
  };
  if (prior.corpusSha256 !== ACCEPTANCE_CORPUS_SHA256 || !prior.finishedAt || prior.failureCode ||
    prior.calibration.correct !== prior.calibration.total || prior.results.length !== prior.scenarioIds.length) {
    throw new Error("memory_acceptance_regrade_source_incomplete");
  }
  const selected = corpus.scenarios.filter(({ id }) => prior.scenarioIds.includes(id));
  if (selected.length !== prior.scenarioIds.length) throw new Error("memory_acceptance_regrade_selection_invalid");
  summarizeResults(selected, prior.results);
  const owned = JSON.parse(await readFile(resolve(source, "owned-state.json"), "utf8")) as {
    scenarios: Array<{ id: string; actors: Array<{ actor: string; userId: string }> }>;
  };
  const { AcceptanceDriver } = await import("./driver");
  const { calibrateJudge } = await import("./evaluate");
  const driver = new AcceptanceDriver(baseUrl, database.toString());
  const results = structuredClone(prior.results);
  let outputCreated = false;
  const work: Array<{ scenario: (typeof selected)[number]; ordinal: number; answer: string; runId: string }> = [];
  const regraded: Array<{ id: string; ordinal: number; runId: string; answerSha256: string }> = [];
  let metadata: Record<string, unknown> = { sourceReportSha256: digest(priorBytes),
    answerJudgePromptSha256: digest(ANSWER_JUDGE_SYSTEM), startedAt: new Date().toISOString(), complete: false,
    actorJudgeInstructionSha256: digest(ACTOR_JUDGE_INSTRUCTION),
    sourceRevision: await currentLongMemEvalQualificationRevision(resolve(root, "../../.."),
      ["app", "components", "lib", "prisma", "benchmarks", "package.json", "package-lock.json"]),
    reusedOriginalAnswers: true, reusedOriginalFactVerdicts: true };
  const save = async () => writeFile(resolve(output, "report.json"), JSON.stringify({ ...prior,
    answerRegrade: { ...metadata, regraded }, results, summary: summarizeResults(selected, results),
    judgeUserIds: driver.ownedUserIds }, null, 2), { mode: 0o600 });
  try {
    await driver.prepare();
    if (prior.profileFingerprint !== driver.profileFingerprint) throw new Error("memory_acceptance_regrade_profile_mismatch");
    // Resolve all frozen answers before any new judge call. No source, fact,
    // answer-model run or old result is mutated or regenerated.
    for (const scenario of selected) {
      const sourceResult = results.find(({ id }) => id === scenario.id)!;
      for (const check of sourceResult.checks.filter(({ surface }) => surface === "answer")) {
        const step = scenario.steps[check.ordinal];
        if (step?.action !== "check") throw new Error("memory_acceptance_regrade_step_invalid");
        const actors = owned.scenarios.filter(({ id }) => id === scenario.id)
          .flatMap(({ actors }) => actors).filter(({ actor }) => actor === (step.actor ?? "owner"));
        if (actors.length !== 1) throw new Error("memory_acceptance_regrade_owner_ambiguous");
        const owner = actors[0]!;
        const user = await driver.prisma.user.findUnique({ where: { id: owner.userId }, select: { email: true } });
        if (user?.email !== `${scenario.id}.${owner.actor}.${owner.userId}@memory-acceptance.benchmark.invalid`) {
          throw new Error("memory_acceptance_regrade_owner_invalid");
        }
        const runs = await driver.prisma.modelRun.findMany({
          where: { userId: owner.userId, chat: { memoryMode: step.temporary ? "TEMPORARY" : "EXCLUDED" } },
          select: { id: true, status: true, userMessage: { select: { content: true } },
            assistantMessage: { select: { content: true, status: true } } }
        });
        work.push({ scenario, ordinal: check.ordinal, ...uniqueStoredProbeAnswer(step.question, runs) });
      }
    }
    await mkdir(output, { mode: 0o700 });
    outputCreated = true;
    const identity = await driver.identity("answer-regrade.judge", false);
    const calibration = await calibrateJudge(driver, identity, emit);
    metadata = { ...metadata, calibration };
    await save();
    if (calibration.correct !== calibration.total) throw new Error("memory_acceptance_judge_calibration_failed");
    for (const item of work) {
      const step = item.scenario.steps[item.ordinal];
      if (step?.action !== "check") throw new Error("memory_acceptance_regrade_step_invalid");
      const verdict = await judgeAnswer(driver, identity, step, [item.answer]);
      const result = results.find(({ id }) => id === item.scenario.id)!;
      const index = result.checks.findIndex((check) => check.ordinal === item.ordinal && check.surface === "answer");
      const checks = [...result.checks];
      checks[index] = { ...checks[index]!, passed: verdict.passed, reason: verdict.reason };
      results[results.indexOf(result)] = { ...result, checks };
      regraded.push({ id: item.scenario.id, ordinal: item.ordinal, runId: item.runId, answerSha256: digest(item.answer) });
      await save();
      emit({ event: "answer_regraded", done: regraded.length, total: work.length });
    }
    metadata = { ...metadata, complete: true, finishedAt: new Date().toISOString(), usage: await driver.usage() };
    await save();
    emit({ event: "regrade_complete", summary: summarizeResults(selected, results) });
  } catch (error) {
    metadata = { ...metadata, failure: failureEvidence(error), failedAt: new Date().toISOString() };
    if (outputCreated) await save();
    throw error;
  } finally {
    await driver.prisma.$disconnect();
    const { prisma } = await import("../../../lib/server/prisma");
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => { emit({ event: "failed", ...failureEvidence(error) }); process.exitCode = 1; });
}
