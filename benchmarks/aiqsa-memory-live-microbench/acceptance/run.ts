import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import { currentLongMemEvalQualificationRevision } from "../../longmemeval/qualificationRevision";
import { assertLiveBaseUrl, assertLiveDatabaseUrl, resolveLiveOutputDirectory } from "../contract";
import { ACCEPTANCE_ACK, ACCEPTANCE_CORPUS_SHA256, JUDGE_SYSTEM, LATENCY_LIMITS, corpusFingerprint, corpusSchema, safeCode, summarizeLatency, summarizeResults, type ScenarioResult, type Timing } from "./contract";
import { ANSWER_JUDGE_SYSTEM } from "./answerGrading";
import { ACTOR_JUDGE_INSTRUCTION } from "./actorGrading";

const root = dirname(fileURLToPath(import.meta.url));
const benchmarkRoot = resolve(root, "..");
function emit(value: unknown) { process.stdout.write(`${JSON.stringify(value)}\n`); }

async function main() {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    if (!["--ack", "--output", "--partition", "--ids", "--model"].includes(args[index] ?? "") || !args[index + 1] || options.has(args[index]!)) {
      throw new Error("memory_acceptance_arguments_invalid");
    }
    options.set(args[index]!, args[index + 1]!);
  }
  if (options.get("--ack") !== ACCEPTANCE_ACK || process.env.AIQSA_TEST_MODE !== "1") throw new Error("memory_acceptance_authority_required");
  const baseUrl = assertLiveBaseUrl(process.env.AIQSA_MEMORY_ACCEPTANCE_BASE_URL ?? "", Number(process.env.AIQSA_MEMORY_BENCHMARK_APP_PORT));
  const databaseUrl = assertLiveDatabaseUrl(process.env.AIQSA_MEMORY_ACCEPTANCE_DATABASE_URL ?? "", Number(process.env.AIQSA_MEMORY_BENCHMARK_POSTGRES_PORT));
  databaseUrl.searchParams.set("connection_limit", "4");
  // Set the guarded disposable authority before importing server singletons or loading .env.
  process.env.DATABASE_URL = databaseUrl.toString();
  loadEnvConfig(resolve(root, "../../.."), true, { info() {}, error() {} });
  if (process.env.DATABASE_URL !== databaseUrl.toString()) throw new Error("memory_acceptance_database_authority_changed");
  const corpus = corpusSchema.parse(JSON.parse(await readFile(resolve(root, "corpus.json"), "utf8")));
  if (corpusFingerprint(corpus) !== ACCEPTANCE_CORPUS_SHA256) throw new Error("memory_acceptance_corpus_changed");
  const partition = options.get("--partition") ?? "all";
  if (!["all", "development", "acceptance"].includes(partition)) throw new Error("memory_acceptance_partition_invalid");
  const requested = options.get("--ids")?.split(",");
  if (requested && (new Set(requested).size !== requested.length || requested.some((id) => !corpus.scenarios.some((scenario) => scenario.id === id)))) {
    throw new Error("memory_acceptance_selection_invalid");
  }
  const selected = corpus.scenarios.filter((scenario) => (partition === "all" || scenario.partition === partition) && (!requested || requested.includes(scenario.id)));
  if (!selected.length) throw new Error("memory_acceptance_selection_empty");
  const output = resolveLiveOutputDirectory(benchmarkRoot, options.get("--output") ?? `results/acceptance-${Date.now()}`);
  await mkdir(resolve(benchmarkRoot, "results"), { recursive: true, mode: 0o700 });
  await mkdir(output, { recursive: false, mode: 0o700 });
  const [{ AcceptanceDriver, PROFILE, EXECUTION_LIMITS }, { calibrateJudge, evaluateScenario }] = await Promise.all([import("./driver"), import("./evaluate")]);
  const model = options.get("--model") ?? PROFILE.answer;
  if (model !== PROFILE.answer && model !== PROFILE.control) throw new Error("memory_acceptance_model_invalid");
  const driver = new AcceptanceDriver(baseUrl, databaseUrl.toString(), model);
  const judgeDriver = model === PROFILE.judge ? driver
    : new AcceptanceDriver(baseUrl, databaseUrl.toString(), PROFILE.judge, model);
  const results: ScenarioResult[] = [];
  const timings: Timing[] = [];
  const owned: unknown[] = [];
  let metadata: Record<string, unknown> = { corpusSha256: corpusFingerprint(corpus), startedAt: new Date().toISOString(),
    sourceRevision: await currentLongMemEvalQualificationRevision(resolve(root, "../../.."), ["app", "components", "lib", "prisma", "benchmarks", "package.json", "package-lock.json"]),
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    trackedDiffSha256: (await import("node:crypto")).createHash("sha256").update(execFileSync("git", ["diff", "HEAD", "--", "lib/server/memory", "lib/domain/memory", "lib/server/runs", "lib/server/providers", "lib/server/providerRuntime", "lib/contracts", "prisma"])).digest("hex"),
    judgePromptSha256: (await import("node:crypto")).createHash("sha256").update(JUDGE_SYSTEM).digest("hex"),
    answerJudgePromptSha256: (await import("node:crypto")).createHash("sha256").update(ANSWER_JUDGE_SYSTEM).digest("hex"),
    actorJudgeInstructionSha256: (await import("node:crypto")).createHash("sha256").update(ACTOR_JUDGE_INSTRUCTION).digest("hex"),
    latencyLimits: LATENCY_LIMITS, executionLimits: EXECUTION_LIMITS, caseConcurrency: 1,
    scenarioIds: selected.map(({ id }) => id), profile: { ...PROFILE, answer: model, system: model } };
  const save = async () => {
    await writeFile(resolve(output, "report.json"), JSON.stringify({ ...metadata, summary: summarizeResults(selected, results), latency: summarizeLatency(timings), searchExecutions: driver.searchExecutions, results }, null, 2), { mode: 0o600 });
    await writeFile(resolve(output, "owned-state.json"), JSON.stringify({
      userIds: [...driver.ownedUserIds, ...(judgeDriver === driver ? [] : judgeDriver.ownedUserIds)], scenarios: owned
    }, null, 2), { mode: 0o600 });
  };
  try {
    await driver.prepare();
    if (judgeDriver !== driver) await judgeDriver.prepare();
    const judgeIdentity = await judgeDriver.identity("judge", false);
    const calibration = await calibrateJudge(judgeDriver, judgeIdentity, emit);
    metadata = { ...metadata, profileFingerprint: driver.profileFingerprint, calibration,
      judgeProfileFingerprint: judgeDriver.profileFingerprint };
    await save();
    if (calibration.correct !== calibration.total) throw new Error("memory_acceptance_judge_calibration_failed");
    emit({ event: "calibrated", total: selected.length, corpusSha256: metadata.corpusSha256 });
    await save();
    for (const scenario of selected) {
      const evaluated = await evaluateScenario(driver, judgeIdentity, scenario, emit, judgeDriver);
      results.push(evaluated.result);
      timings.push(...evaluated.timings);
      owned.push({ id: scenario.id, actors: evaluated.actors });
      if (scenario.partition === "development") await writeFile(resolve(output, `${scenario.id}.json`), JSON.stringify(evaluated, null, 2), { mode: 0o600 });
      await save();
      emit({ event: "scenario_complete", scenario: scenario.partition === "development" ? scenario.id : "reserved", done: results.length, total: selected.length,
        ...(scenario.partition === "development" ? { healthy: evaluated.result.healthy, failureCode: evaluated.result.failureCode,
          passed: evaluated.result.checks.filter((check) => check.passed).length, checks: evaluated.result.checks.length } : {}) });
      // A lost database is a run-level infrastructure failure. Preserve the
      // completed prefix instead of manufacturing failures for every later case.
      if (evaluated.result.failureCode) await driver.assertDatabaseAvailable();
    }
    metadata = { ...metadata, finishedAt: new Date().toISOString(), usage: await driver.usage(),
      ...(judgeDriver === driver ? {} : { judgeUsage: await judgeDriver.usage() }) };
    await save();
    const summary = summarizeResults(selected, results);
    emit({ event: "complete", summary });
    if (!summary.qualityPassed || !Object.values(summarizeLatency(timings)).every((item) => item.passed)) process.exitCode = 2;
  } catch (error) {
    metadata = { ...metadata, failureCode: safeCode(error), finishedAt: new Date().toISOString() };
    await save();
    throw error;
  } finally {
    await driver.prisma.$disconnect();
    if (judgeDriver !== driver) await judgeDriver.prisma.$disconnect();
    const { prisma } = await import("../../../lib/server/prisma");
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => { emit({ event: "failed", code: safeCode(error) }); process.exitCode = 1; });
