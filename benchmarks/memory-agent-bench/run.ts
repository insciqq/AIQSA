import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import { currentLongMemEvalQualificationRevision } from "../longmemeval/qualificationRevision";
import { assertLiveBaseUrl, assertLiveDatabaseUrl, resolveLiveOutputDirectory } from "../aiqsa-memory-live-microbench/contract";
import { JUDGE_SYSTEM, safeCode } from "../aiqsa-memory-live-microbench/acceptance/contract";
import { FACT_CONSOLIDATION_ACK, readerControlQuestions, summarize, validatePrepared, type Result } from "./contract";
import { substringExactMatch } from "./metric";
import { SEMANTIC_SCORER_VERSION } from "./semantic";
import type { Identity } from "../aiqsa-memory-live-microbench/acceptance/driver";

const root = dirname(fileURLToPath(import.meta.url));
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
async function main() {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    if (!["--ack", "--output", "--mode", "--regrade-from"].includes(args[index] ?? "") || !args[index + 1] || options.has(args[index]!)) throw new Error("factconsolidation_arguments_invalid");
    options.set(args[index]!, args[index + 1]!);
  }
  if (options.get("--ack") !== FACT_CONSOLIDATION_ACK || process.env.AIQSA_TEST_MODE !== "1") throw new Error("factconsolidation_authority_required");
  const baseUrl = assertLiveBaseUrl(process.env.AIQSA_MEMORY_ACCEPTANCE_BASE_URL ?? "", Number(process.env.AIQSA_MEMORY_BENCHMARK_APP_PORT));
  const databaseUrl = assertLiveDatabaseUrl(process.env.AIQSA_MEMORY_ACCEPTANCE_DATABASE_URL ?? "", Number(process.env.AIQSA_MEMORY_BENCHMARK_POSTGRES_PORT));
  databaseUrl.searchParams.set("connection_limit", "4");
  process.env.DATABASE_URL = databaseUrl.toString();
  loadEnvConfig(resolve(root, "../.."), true, { info() {}, error() {} });
  if (process.env.DATABASE_URL !== databaseUrl.toString()) throw new Error("factconsolidation_database_authority_changed");
  const mode = options.get("--mode") ?? "memory";
  if (mode !== "memory" && mode !== "reader-control") throw new Error("factconsolidation_mode_invalid");
  const control = mode === "reader-control";
  const regrade = options.get("--regrade-from") ? resolveLiveOutputDirectory(root, options.get("--regrade-from")!) : null;
  if (regrade && !control) throw new Error("factconsolidation_regrade_requires_reader_control");
  const frozen = JSON.parse(await readFile(resolve(root, "selection.json"), "utf8")) as { preparedSha256: string };
  const bytes = await readFile(resolve(root, ".data/prepared.json"));
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  if (fingerprint !== frozen.preparedSha256) throw new Error("factconsolidation_prepared_hash_mismatch");
  const prepared = validatePrepared(JSON.parse(bytes.toString("utf8")));
  await mkdir(resolve(root, "results"), { recursive: true, mode: 0o700 });
  const output = resolveLiveOutputDirectory(root, options.get("--output") ?? `results/${mode}-${Date.now()}`);
  await mkdir(output, { mode: 0o700 });
  const [{ AcceptanceDriver, PROFILE, EXECUTION_LIMITS }, { semanticJudge, calibrateSemanticJudge }] = await Promise.all([
    import("../aiqsa-memory-live-microbench/acceptance/driver"), import("./semantic")
  ]);
  const driver = new AcceptanceDriver(baseUrl, databaseUrl.toString());
  const results: Result[] = [];
  const sourceEvidence: unknown[] = [];
  const cleanupFailures: Array<{ contextHash: string; code: string }> = [];
  const summary = () => {
    const score = summarize(prepared.strata, results, control);
    return { ...score, healthy: score.healthy && cleanupFailures.length === 0,
      qualityPassed: score.qualityPassed && cleanupFailures.length === 0 };
  };
  let metadata: Record<string, unknown> = { mode, startedAt: new Date().toISOString(), preparedSha256: fingerprint,
    sourceRevision: await currentLongMemEvalQualificationRevision(resolve(root, "../.."), ["app", "components", "lib", "prisma", "benchmarks", "package.json", "package-lock.json"]),
    profile: PROFILE, executionLimits: EXECUTION_LIMITS, caseConcurrency: 1, semanticScorerVersion: SEMANTIC_SCORER_VERSION,
    judgePromptSha256: createHash("sha256").update(JUDGE_SYSTEM).digest("hex"),
    regradeFrom: regrade,
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    trackedDiffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD", "--", "lib/server/memory", "lib/domain/memory", "lib/server/runs", "lib/server/providers", "lib/server/providerRuntime", "lib/contracts", "prisma"])).digest("hex") };
  const save = async () => writeFile(resolve(output, "report.json"), JSON.stringify({ ...metadata,
    summary: summary(), results, sources: sourceEvidence, cleanupFailures, ownedUserIds: driver.ownedUserIds }, null, 2), { mode: 0o600 });
  try {
    await driver.prepare();
    if (regrade) {
      const priorBytes = await readFile(resolve(regrade, "report.json"));
      const prior = JSON.parse(priorBytes.toString("utf8")) as { mode: string; preparedSha256: string; profileFingerprint: string; summary: { complete: boolean; healthy: boolean } };
      if (prior.mode !== "reader-control" || prior.preparedSha256 !== fingerprint || prior.profileFingerprint !== driver.profileFingerprint ||
        !prior.summary.complete || !prior.summary.healthy) throw new Error("factconsolidation_regrade_source_invalid");
      metadata.readerEvidenceSha256 = createHash("sha256").update(priorBytes).digest("hex");
    }
    const judgeIdentity = await driver.identity("factconsolidation.judge", false);
    const calibration = await calibrateSemanticJudge(driver, judgeIdentity, emit);
    metadata = { ...metadata, profileFingerprint: driver.profileFingerprint, calibration };
    await save();
    if (calibration.correct !== calibration.total) throw new Error("factconsolidation_judge_calibration_failed");
    for (const [contextHash, context] of Object.entries(prepared.contexts)) {
      let identity: Identity | null = null;
      let sourceFailure: string | null = null;
      try {
        identity = regrade ? null : await driver.identity(`factconsolidation.${contextHash.slice(0, 12)}`, !control);
        if (!control) {
          for (const [ordinal, chunk] of context.chunks.entries()) {
            const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
            const content = prepared.memorizeTemplate.replace("{time_stamp}", () => timestamp).replace("{context}", () => chunk);
            const chat = driver.conversation();
            const sent = await driver.send(identity!, chat, content);
            const settlementMs = await driver.settle(identity!, { chat, messageId: sent.userMessageId });
            const healthy = sent.ownerIsolation && !["DEGRADED", "FAILED_SAFE"].includes(sent.memoryOutcome) && sent.degradationCode === null;
            sourceEvidence.push({ contextHash, ordinal, runId: sent.runId, elapsedMs: sent.elapsedMs, settlementMs: sent.elapsedMs + settlementMs, healthy });
            await save();
            emit({ event: "source_settled", context: contextHash.slice(0, 12), ordinal, chunks: context.chunks.length, healthy });
            if (!healthy) throw new Error("factconsolidation_source_degraded");
          }
        }
      } catch (error) { sourceFailure = safeCode(error); }
      for (const stratum of prepared.strata.filter((item) => item.contextSha256 === contextHash)) {
        const selected = control ? readerControlQuestions(stratum) : stratum.questions;
        for (const question of selected) {
          const result: Result = { id: question.id, source: stratum.source, complete: false, healthy: false, exact: false, semantic: false, elapsedMs: 0, code: sourceFailure };
          try {
            if (sourceFailure) throw new Error(sourceFailure);
            const prior = regrade ? JSON.parse(await readFile(resolve(regrade, `${question.id}.json`), "utf8")) as {
              result: Result; runId: string; answer: string;
            } : null;
            if (prior && (prior.result.id !== question.id || prior.result.source !== stratum.source || !prior.result.healthy ||
              !prior.result.complete || prior.result.code !== null || typeof prior.answer !== "string" || !prior.answer.trim())) {
              throw new Error("factconsolidation_regrade_answer_invalid");
            }
            const sent = prior ? null
              : control ? await driver.send(identity!, driver.conversation("EXCLUDED"), `${context.context}\n\n${question.query}`)
                : await driver.probe(identity!, question.query);
            const answer = prior?.answer ?? sent!.answer;
            const runId = prior?.runId ?? sent!.runId;
            result.elapsedMs = prior?.result.elapsedMs ?? sent!.elapsedMs;
            result.complete = true;
            result.code = sent?.cleanupFailureCode ?? null;
            result.healthy = prior ? prior.result.healthy : sent!.ownerIsolation && !["DEGRADED", "FAILED_SAFE"].includes(sent!.memoryOutcome) && sent!.degradationCode === null && !sent!.cleanupFailureCode && (!control || sent!.memoryItems === 0);
            result.exact = substringExactMatch(answer, question.answers);
            const judgement = await semanticJudge(driver, judgeIdentity, question.question, question.answers, answer);
            result.semantic = judgement.passed;
            await writeFile(resolve(output, `${question.id}.json`), JSON.stringify({ result, runId, answer, judgement, reusedReaderAnswer: prior !== null }, null, 2), { mode: 0o600 });
          } catch (error) { result.code = safeCode(error); result.healthy = false; }
          results.push(result);
          await save();
          emit({ event: "question_complete", id: result.id, done: results.length, exact: result.exact, semantic: result.semantic, healthy: result.healthy, code: result.code });
          if (!result.complete && result.code?.startsWith("memory_acceptance_transport:")) {
            // The request may have committed before the connection was lost.
            // Stop until its stored run and query exclusion can be reconciled.
            if (identity) {
              try { await driver.quiesce(identity); }
              catch (error) { cleanupFailures.push({ contextHash, code: safeCode(error) }); }
            }
            throw new Error(result.code);
          }
        }
      }
      if (identity) {
        try { await driver.quiesce(identity); }
        catch (error) {
          cleanupFailures.push({ contextHash, code: safeCode(error) });
          await save();
          await driver.assertDatabaseAvailable();
        }
      }
    }
    metadata = { ...metadata, finishedAt: new Date().toISOString(), usage: await driver.usage() };
    await save();
    const score = summary();
    emit({ event: "complete", summary: score });
    if (!score.healthy || !score.complete || (!control && !score.qualityPassed)) process.exitCode = 2;
  } catch (error) { metadata = { ...metadata, failureCode: safeCode(error), finishedAt: new Date().toISOString() }; await save(); throw error; }
  finally {
    await driver.prisma.$disconnect();
    const { prisma } = await import("../../lib/server/prisma");
    await prisma.$disconnect();
  }
}
void main().catch((error: unknown) => { emit({ event: "failed", code: safeCode(error) }); process.exitCode = 1; });
