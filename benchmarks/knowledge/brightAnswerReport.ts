import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveKnowledgeBenchmarkOutputDirectory } from "./contract";
import {
  BRIGHT_ANSWER_CONTRACT_VERSION, createBrightAnswerStore, decodeBrightAnswerJudgment,
  isRecord, readBrightPrivateJson, safeBrightAnswerError, type BrightAnswerStore
} from "./brightAnswerHarness";
import { assertOpenRagPrivatePathNoSymlinks } from "./openRagAnswerRunner";

/** A terminal chat can contain failed tool calls and zero retrieval receipts.
 * Never mislabel that as a healthy retrieval miss or zero failures. */
export function brightAnswerDiagnostics(trace: unknown) {
  if (!isRecord(trace) || !Array.isArray(trace.toolCalls) || !Array.isArray(trace.knowledgeRuns) ||
    !Array.isArray(trace.knowledgeProviderAttempts) || typeof trace.status !== "string") {
    throw new Error("bright_answer_report_trace_invalid");
  }
  const tools = trace.toolCalls.filter(isRecord).filter(({ toolName }) => toolName === "search_knowledge");
  const failures = tools.filter(({ state }) => state === "error");
  const retrievalFailures = trace.knowledgeRuns.filter(isRecord).filter(({ failureCode }) => failureCode !== null);
  const operationFailures = trace.knowledgeProviderAttempts.filter(isRecord).filter(({ failureCode }) => failureCode !== null);
  const codes = new Set<string>();
  const addCode = (value: unknown) => {
    if (typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(value)) codes.add(value);
  };
  addCode(trace.error);
  for (const row of [...retrievalFailures, ...operationFailures]) addCode(row.failureCode);
  for (const tool of failures) {
    const content = isRecord(tool.result) && Array.isArray(tool.result.content) ? tool.result.content : [];
    for (const block of content) {
      if (!isRecord(block) || typeof block.text !== "string") continue;
      const match = /^(?:Knowledge retrieval failed: ([a-z][a-z0-9_]{0,127})\.|Knowledge failed: (knowledge_retrieval_failed))$/u.exec(block.text);
      if (match) addCode(match[1] ?? match[2]);
    }
  }
  return Object.freeze({
    searchToolCalls: tools.length, failedSearchToolCalls: failures.length,
    retrievalReceipts: trace.knowledgeRuns.length, failedRetrievalReceipts: retrievalFailures.length,
    failedProviderOperations: operationFailures.length, failureCodes: [...codes].sort(),
    technicalFailure: ["error", "cancelled"].includes(trace.status) || failures.length > 0 ||
      retrievalFailures.length > 0 || operationFailures.length > 0
  });
}

export async function buildBrightAnswerReport(store: Pick<BrightAnswerStore, "read" | "write">, queryCount: number) {
  if (!Number.isSafeInteger(queryCount) || queryCount < 1 || queryCount > 10) {
    throw new Error("bright_answer_report_count_invalid");
  }
  const cases = [];
  for (let index = 1; index <= queryCount; index += 1) {
    const prefix = String(index).padStart(3, "0");
    const trace = await store.read(`${prefix}/answer.json`) ?? await store.read(`${prefix}/answer-trace.json`);
    const rawJudgment = await store.read(`${prefix}/judgment.json`);
    const evaluation = await store.read(`${prefix}/evaluation-input.json`);
    const judgment = rawJudgment === null ? null : decodeBrightAnswerJudgment(JSON.stringify(rawJudgment));
    cases.push({
      ordinal: index, status: isRecord(trace) ? trace.status : "not_observed",
      question: isRecord(trace) && typeof trace.question === "string" ? trace.question : null,
      answer: isRecord(trace) && typeof trace.answer === "string" ? trace.answer : null,
      referenceAnswer: isRecord(evaluation) && typeof evaluation.referenceAnswer === "string" ? evaluation.referenceAnswer : null,
      judgment, diagnostics: trace === null ? null : brightAnswerDiagnostics(trace),
      traceFile: `${prefix}/answer.json`, judgeTraceFile: `${prefix}/judge.json`
    });
  }
  const summary = {
    requested: queryCount, evaluated: cases.filter(({ judgment }) => judgment !== null).length,
    pass: cases.filter(({ judgment }) => judgment?.verdict === "pass").length,
    partial: cases.filter(({ judgment }) => judgment?.verdict === "partial").length,
    fail: cases.filter(({ judgment }) => judgment?.verdict === "fail").length,
    groundedPass: cases.filter(({ judgment }) => judgment?.verdict === "pass" && judgment.grounding === "supported").length,
    technicalFailureCases: cases.filter(({ diagnostics }) => diagnostics?.technicalFailure).length,
    searchToolCalls: cases.reduce((sum, { diagnostics }) => sum + (diagnostics?.searchToolCalls ?? 0), 0),
    failedSearchToolCalls: cases.reduce((sum, { diagnostics }) => sum + (diagnostics?.failedSearchToolCalls ?? 0), 0),
    retrievalReceipts: cases.reduce((sum, { diagnostics }) => sum + (diagnostics?.retrievalReceipts ?? 0), 0)
  };
  await store.write("report.json", {
    reportVersion: 1, scoreable: false, summary, cases,
    interpretation: "Reference-answer judge plus private traces. Pipeline failures are not a measurement of healthy retrieval quality."
  });
  return summary;
}

/** Offline derivation from checksum-verified receipts. No database, session,
 * provider calls, current model configuration, or paid-run replay. */
export async function reportBrightAnswers(argv: readonly string[]) {
  if (argv.length !== 2 || argv[0] !== "--output" || !argv[1]) throw new Error("bright_answer_report_arguments_invalid");
  const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(benchmarkRoot, "../..");
  const output = resolveKnowledgeBenchmarkOutputDirectory(benchmarkRoot, argv[1]);
  await assertOpenRagPrivatePathNoSymlinks(repositoryRoot, output);
  const manifestPath = await assertOpenRagPrivatePathNoSymlinks(repositoryRoot, resolve(output, "manifest.json"));
  const receipt = await readBrightPrivateJson(manifestPath);
  if (!isRecord(receipt) || !isRecord(receipt.manifest) ||
    receipt.manifest.contractVersion !== BRIGHT_ANSWER_CONTRACT_VERSION) {
    throw new Error("bright_answer_report_manifest_invalid");
  }
  const store = await createBrightAnswerStore({ repositoryRoot, output, manifest: receipt.manifest, resume: true });
  try {
    const summary = await buildBrightAnswerReport(store, Number(receipt.manifest.queryCount));
    process.stdout.write(`${JSON.stringify({ event: "bright_answer_report", ...summary })}\n`);
  } finally { await store.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  reportBrightAnswers(process.argv.slice(2)).catch((error: unknown) => {
    process.stdout.write(`${JSON.stringify({ event: "bright_answer_report_failed", code: safeBrightAnswerError(error) })}\n`);
    process.exitCode = 1;
  });
}
