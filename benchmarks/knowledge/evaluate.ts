import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareKnowledgeRuns,
  macroKnowledgeAggregate,
  type KnowledgeComparison,
  type KnowledgeConfigLabel,
  type KnowledgeRunSummary,
  type KnowledgeSuiteMetrics,
  type KnowledgeUsageTotals,
  decodeKnowledgeRunSummary
} from "./contract";

/** Prints the §12.1 public retrieval metric table for one or more sanitized
 * run summaries and, when a baseline and a candidate configuration label are
 * given, the §14.1 comparison with absolute percentage-point deltas.
 *
 * Cross-manifest comparison is refused by the contract guard: only
 * baseline-vs-candidate pairs that share the per-suite frozen dataset
 * identity (dataset id + revision + split + corpus content) and differ solely
 * in the declared configuration label are admissible. */

const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(benchmarkRoot, "../..");
const resultsRoot = resolve(benchmarkRoot, "results");

type EvaluateOptions = Readonly<{
  baseline: KnowledgeConfigLabel | undefined;
  candidate: KnowledgeConfigLabel | undefined;
  summaryPaths: readonly string[];
}>;

function parseCli(argv: readonly string[]): EvaluateOptions {
  const summaryPaths: string[] = [];
  let baseline: KnowledgeConfigLabel | undefined;
  let candidate: KnowledgeConfigLabel | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === "--baseline" || argument === "--candidate") {
      if (next !== "A" && next !== "B" && next !== "C") {
        throw new Error("knowledge_benchmark_config_label_invalid");
      }
      if (argument === "--baseline") baseline = next;
      else candidate = next;
      index += 1;
    } else if (argument?.startsWith("--")) {
      throw new Error(`knowledge_benchmark_argument_unknown:${argument}`);
    } else if (argument?.trim()) {
      summaryPaths.push(argument);
    }
  }
  if (summaryPaths.length === 0) {
    throw new Error("knowledge_benchmark_summary_paths_required");
  }
  if ((baseline === undefined) !== (candidate === undefined)) {
    throw new Error("knowledge_benchmark_comparison_labels_incomplete");
  }
  if (baseline !== undefined && baseline === candidate) {
    throw new Error("knowledge_benchmark_comparison_labels_equal");
  }
  return Object.freeze({ baseline, candidate, summaryPaths });
}

async function loadSummary(argument: string): Promise<KnowledgeRunSummary> {
  const candidatePath = resolve(repositoryRoot, argument);
  const [root, summaryPath] = await Promise.all([
    realpath(resultsRoot),
    realpath(candidatePath)
  ]);
  if (!summaryPath.startsWith(`${root}${sep}`) ||
    !summaryPath.endsWith(`${sep}summary.json`)) {
    throw new Error("knowledge_benchmark_summary_path_not_isolated");
  }
  return decodeKnowledgeRunSummary(
    JSON.parse(await readFile(summaryPath, "utf8")) as unknown
  );
}

function ratio(value: number): string {
  return value.toFixed(4);
}

function pp(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}pp`;
}

function milliseconds(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value)}ms`;
}

function usage(totals: KnowledgeUsageTotals): string {
  const cost = totals.costMicros === null
    ? "cost n/a"
    : `cost ${(totals.costMicros / 1_000_000).toFixed(4)}$`;
  return `${totals.tokens} tokens / ${totals.requests} requests / ${cost}`;
}

function printSuiteMetrics(metrics: KnowledgeSuiteMetrics): void {
  const lines = [
    `  queries                ${metrics.queryCount}`,
    `  nDCG@10                ${ratio(metrics.ndcg10)}`,
    `  Recall@10              ${ratio(metrics.recall10)}`,
    `  Recall@50              ${ratio(metrics.recall50)}`,
    `  MRR@10                 ${ratio(metrics.mrr10)}`,
    `  exact relevant hits    ${ratio(metrics.exactRelevantHitRate)}`,
    `  candidates before/after rerank ` +
      `${metrics.meanCandidatesBeforeRerank.toFixed(1)} / ` +
      `${metrics.meanCandidatesAfterRerank.toFixed(1)}`,
    `  rerank fallback rate   ${ratio(metrics.rerankFallbackRate)}`,
    `  retrieval p50/p95      ${milliseconds(metrics.retrievalMsP50)} / ` +
      milliseconds(metrics.retrievalMsP95),
    `  reranker p50/p95       ${milliseconds(metrics.rerankMsP50)} / ` +
      milliseconds(metrics.rerankMsP95),
    `  embedding usage        ${usage(metrics.usage.embedding)}`,
    `  reranker usage         ${usage(metrics.usage.reranker)}`
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function printSummaries(summaries: readonly KnowledgeRunSummary[]): void {
  for (const summary of summaries) {
    process.stdout.write(
      `\n== ${summary.resultLabel} — config ${summary.configLabel} ` +
        `(run ${summary.runId})\n` +
        `  manifest ${summary.manifestFingerprint.slice(0, 16)} ` +
        `dataset ${summary.datasetFingerprint.slice(0, 16)} ` +
        `reranker ${summary.manifest.rerankerModelId ?? "none"}\n`
    );
    printSuiteMetrics(summary.metrics);
  }
  const byConfig = new Map<KnowledgeConfigLabel, KnowledgeRunSummary[]>();
  for (const summary of summaries) {
    byConfig.set(summary.configLabel, [
      ...(byConfig.get(summary.configLabel) ?? []),
      summary
    ]);
  }
  for (const [label, group] of [...byConfig.entries()].sort()) {
    const suiteIds = new Set(group.map(({ manifest }) => manifest.suiteId));
    if (group.length === 2 && suiteIds.size === 2) {
      const macro = macroKnowledgeAggregate(group.map(({ metrics }) => metrics));
      process.stdout.write(
        `\n== Macro aggregate — config ${label} (${group.length} suites)\n` +
          `  nDCG@10 ${ratio(macro.ndcg10)} | Recall@10 ${ratio(macro.recall10)}` +
          ` | Recall@50 ${ratio(macro.recall50)} | MRR@10 ${ratio(macro.mrr10)}` +
          ` | exact hits ${ratio(macro.exactRelevantHitRate)}\n` +
          `  embedding usage ${usage(macro.usage.embedding)}\n` +
          `  reranker usage  ${usage(macro.usage.reranker)}\n`
      );
    }
  }
}

function printComparison(comparison: KnowledgeComparison): void {
  process.stdout.write(
    `\n== Comparison: baseline ${comparison.baselineConfig} vs candidate ` +
      `${comparison.candidateConfig}\n`
  );
  for (const suite of comparison.suites) {
    process.stdout.write(
      `\n  ${suite.resultLabel}\n` +
        `    nDCG@10    ${ratio(suite.baseline.ndcg10)} -> ` +
        `${ratio(suite.candidate.ndcg10)} (${pp(suite.deltaPp.ndcg10)})\n` +
        `    Recall@10  ${ratio(suite.baseline.recall10)} -> ` +
        `${ratio(suite.candidate.recall10)} (${pp(suite.deltaPp.recall10)})\n` +
        `    Recall@50  ${ratio(suite.baseline.recall50)} -> ` +
        `${ratio(suite.candidate.recall50)} (${pp(suite.deltaPp.recall50)})\n` +
        `    MRR@10     ${ratio(suite.baseline.mrr10)} -> ` +
        `${ratio(suite.candidate.mrr10)} (${pp(suite.deltaPp.mrr10)})\n` +
        `    exact hits ${ratio(suite.baseline.exactRelevantHitRate)} -> ` +
        `${ratio(suite.candidate.exactRelevantHitRate)} ` +
        `(${pp(suite.deltaPp.exactRelevantHitRate)})\n` +
        `    regression bounds: nDCG@10 ` +
        `${suite.ndcg10RegressionWithinBound ? "within" : "BREACHED"} 1pp, ` +
        `Recall@50 ` +
        `${suite.recall50RegressionWithinBound ? "within" : "BREACHED"} 1pp\n`
    );
  }
  if (comparison.macro) {
    const relative = comparison.macro.relativeDelta === null
      ? "n/a"
      : `${(comparison.macro.relativeDelta * 100).toFixed(2)}%`;
    process.stdout.write(
      `\n  Macro nDCG@10 ${ratio(comparison.macro.baselineNdcg10)} -> ` +
        `${ratio(comparison.macro.candidateNdcg10)} ` +
        `(${pp(comparison.macro.deltaPp)}, relative ${relative})\n`
    );
  } else {
    process.stdout.write(
      "\n  Macro aggregate unavailable: both suites are required on both " +
        "sides of the comparison.\n"
    );
  }
  const gate = comparison.gate;
  const macroGate = gate.macroNdcg10ImprovedAtLeast5PercentRelative;
  process.stdout.write(
    "\n  §14.1 gate:\n" +
      `    macro nDCG@10 +5% relative      ${
        macroGate === null ? "n/a" : macroGate ? "PASS" : "FAIL"}\n` +
      `    no suite nDCG@10 drop > 1pp     ${
        gate.noSuiteNdcg10RegressionOver1Pp ? "PASS" : "FAIL"}\n` +
      `    no suite Recall@50 drop > 1pp   ${
        gate.noSuiteRecall50RegressionOver1Pp ? "PASS" : "FAIL"}\n`
  );
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const summaries = await Promise.all(options.summaryPaths.map(loadSummary));
  if (new Set(summaries.map(({ runId }) => runId)).size !== summaries.length) {
    throw new Error("knowledge_benchmark_summary_duplicate_run");
  }
  printSummaries(summaries);
  if (options.baseline !== undefined && options.candidate !== undefined) {
    const baselines = summaries.filter(
      ({ configLabel }) => configLabel === options.baseline
    );
    const candidates = summaries.filter(
      ({ configLabel }) => configLabel === options.candidate
    );
    printComparison(compareKnowledgeRuns(baselines, candidates));
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown";
  const code = /^[A-Za-z0-9_:,.-]{1,200}$/u.test(message)
    ? message
    : "knowledge_benchmark_evaluate_failed";
  process.stdout.write(`${JSON.stringify({ code, event: "evaluate_failed" })}\n`);
  process.exitCode = 1;
});
