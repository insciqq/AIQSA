import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveKnowledgeBenchmarkOutputDirectory } from "./contract";
import { assertOpenRagPrivatePathNoSymlinks } from "./openRagAnswerRunner";
import { brightAnswerDiagnostics } from "./brightAnswerReport";
import { applyBrightPackingReplaySupplement, replayBrightEvidencePacking } from "./brightPackingReplay";
import { BRIGHT_STACKOVERFLOW_QUERY_COUNT } from "./brightStackOverflowContract";
import { KNOWLEDGE_EVIDENCE_ANSWER_LIMITS_V1 } from "../../lib/server/knowledge/evidenceAnswerV1";
import {
  BRIGHT_ANSWER_CONTRACT_VERSION, brightAnswerCodeFingerprint, brightAnswerHash, createBrightAnswerStore,
  decodeBrightAnswerJudgment, isRecord, readBrightPrivateJson, safeBrightAnswerError, type BrightAnswerStore
} from "./brightAnswerHarness";

function fail(): never { throw Error("bright_answer_diagnose_trace_invalid"); }
function rows(value: unknown, maximum = 64): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > maximum || value.some(item => !isRecord(item))) fail();
  return value as Record<string, unknown>[];
}
function time(value: unknown): number | null {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
function duration(start: unknown, end: unknown): number | null {
  const from = time(start), to = time(end);
  return from !== null && to !== null && to >= from ? to - from : null;
}
const numeric = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
function durations(values: readonly (number | null)[]) {
  return { measured: values.filter(value => value !== null).length, unavailable: values.filter(value => value === null).length,
    totalMs: values.some(value => value !== null) ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null };
}

/** Content-free observations only. Document relevance and missing semantic
 * premises cannot be inferred from candidate counts or a matching citation. */
export function diagnoseBrightAnswerTrace(trace: unknown) {
  if (!isRecord(trace)) fail();
  const tools = rows(trace.toolCalls, 32).filter(call => call.toolName === "search_knowledge");
  const retrievals = rows(trace.knowledgeRuns, 32);
  const attempts = rows(trace.knowledgeProviderAttempts);
  const manifests = rows(trace.knowledgeDispatchManifests).filter(manifest => isRecord(manifest.providerAttempt) &&
    time(manifest.providerAttempt.dispatchedAt) !== null &&
    ["knowledge_evidence_compose_v1", "knowledge_evidence_compose_v2"].includes(String(manifest.providerAttempt.purpose)));
  const seenQueries = new Set<string>();
  let repeatedQueries = 0;
  for (const tool of tools) {
    if (!isRecord(tool.arguments) || typeof tool.arguments.query !== "string" || !Array.isArray(tool.arguments.sourceAliases)) fail();
    const key = brightAnswerHash({ query: tool.arguments.query.normalize("NFKC").trim().replace(/\s+/gu, " "),
      aliases: [...tool.arguments.sourceAliases].sort() });
    if (seenQueries.has(key)) repeatedQueries++;
    seenQueries.add(key);
  }
  const compositions = manifests.map(manifest => {
    const items = rows(manifest.items, 512);
    let expansionsIncluded = 0, expansionsOmitted = 0;
    for (const item of items) {
      if (typeof item.renderedBlock !== "string") fail();
      let block: unknown;
      try { block = JSON.parse(item.renderedBlock); } catch { fail(); }
      if (!isRecord(block)) fail();
      expansionsIncluded += Number(block.expandedContextState === "included");
      expansionsOmitted += Number(block.expandedContextState === "omitted");
    }
    return { items: items.length, bytes: numeric(manifest.totalBytes), tokens: numeric(manifest.totalTokens),
      budgetExclusions: rows(manifest.exclusions, 1024).filter(item => item.reason === "budget").length,
      expansionsIncluded, expansionsOmitted };
  });
  const reviews = attempts.filter(attempt => ["knowledge_evidence_review_v1", "knowledge_evidence_review_v2"].includes(String(attempt.purpose)) &&
    isRecord(attempt.acceptedResult) && Array.isArray(attempt.acceptedResult.blocks)).map(attempt => {
    const review = attempt.acceptedResult as Record<string, unknown>;
    const requirements = review.version === 2 ? rows(review.requirements, KNOWLEDGE_EVIDENCE_ANSWER_LIMITS_V1.gaps) : null;
    return { version: review.version === 2 ? 2 : 1,
      coverage: ["complete", "partial", "none"].includes(String(review.coverage)) ? review.coverage as string : "unknown",
      supportedBlocks: rows(review.blocks, 64).filter(block => block.verdict === "supported").length,
      rejectedBlocks: rows(review.blocks, 64).filter(block => block.verdict !== "supported").length,
      requirements: requirements && { total: requirements.length,
        answered: requirements.filter(item => item.status === "answered").length,
        needsCorrection: requirements.filter(item => item.status === "needs_correction").length,
        missingEvidence: requirements.filter(item => item.status === "missing_evidence").length },
      followUps: rows(review.followUps, KNOWLEDGE_EVIDENCE_ANSWER_LIMITS_V1.followUps).length };
  });
  const started = tools.map(tool => time(tool.startedAt)).filter((value): value is number => value !== null);
  const created = time(trace.createdAt);
  const finalHandles = new Set(manifests.length ? rows(manifests.at(-1)!.items, 512).map(item => item.handle) : []);
  const returnedHandles = new Set(retrievals.flatMap(retrieval => rows(retrieval.results, 16).map(result => result.handle)));
  const degradedFlags = isRecord(trace.knowledgeRetrievalSession) && Array.isArray(trace.knowledgeRetrievalSession.degradedFlags)
    ? trace.knowledgeRetrievalSession.degradedFlags.length : null;
  return {
    technical: brightAnswerDiagnostics(trace),
    degradedFlagCount: degradedFlags,
    retrieval: { candidateCounts: retrievals.map(item => numeric(item.candidateCount)),
      resultCounts: retrievals.map(item => rows(item.results, 16).length),
      emptySearches: retrievals.filter(item => item.outcome === "no_relevant_evidence").length,
      broadSearches: tools.filter(tool => isRecord(tool.arguments) && Array.isArray(tool.arguments.sourceAliases) && !tool.arguments.sourceAliases.length).length,
      scopedSearches: tools.filter(tool => isRecord(tool.arguments) && Array.isArray(tool.arguments.sourceAliases) && tool.arguments.sourceAliases.length > 0).length,
      repeatedQueries },
    packing: { compositions, distinctReturnedPrimaries: returnedHandles.size,
      returnedPrimariesAbsentFromFinalContext: [...returnedHandles].filter(handle => !finalHandles.has(handle)).length },
    reviews,
    timing: { observedRunMs: duration(trace.createdAt, trace.updatedAt),
      beforeFirstSearchMs: created !== null && started.length && Math.min(...started) >= created ? Math.min(...started) - created : null,
      searchWall: durations(tools.map(tool => duration(tool.startedAt, tool.completedAt))),
      retrievalService: durations(retrievals.map(item => numeric(item.durationMs))),
      lexicalService: durations(retrievals.map(item => isRecord(item.lexicalBackendEvidence) ? numeric(item.lexicalBackendEvidence.durationMs) : null)),
      rerankService: durations(retrievals.map(item => isRecord(item.readReceipt) && isRecord(item.readReceipt.rerankerBinding)
        ? numeric(item.readReceipt.rerankerBinding.durationMs) : null)),
      embeddingService: durations(retrievals.flatMap(item => Array.isArray(item.embeddingUsage)
        ? rows(item.embeddingUsage).map(usage => numeric(usage.durationMs)) : [null])),
      answerOperations: durations(attempts.map(item => duration(item.dispatchedAt, item.settledAt))) },
    packingReplay: replayBrightEvidencePacking(trace),
    unavailableAttribution: ["pre_rerank_candidate_replay", "relevant_source_recall", "semantic_premise_coverage", "preparation_only_duration"]
  };
}

/** A changed model, corpus, query set or budget is not a code-only A/B. */
export function compareBrightDiagnosticManifests(current: Record<string, unknown>, baseline: Record<string, unknown>) {
  const changedFields = [...new Set([...Object.keys(current), ...Object.keys(baseline)])].sort()
    .filter(key => brightAnswerHash(current[key] ?? null) !== brightAnswerHash(baseline[key] ?? null));
  return { comparableControls: changedFields.every(key => key === "codeFingerprint"),
    codeChanged: current.codeFingerprint !== baseline.codeFingerprint, changedFields };
}

export async function buildBrightStageReport(store: Pick<BrightAnswerStore, "read">, queryCount: number, queryOffset = 0) {
  if (!Number.isSafeInteger(queryCount) || queryCount < 1 || queryCount > 10 ||
    !Number.isSafeInteger(queryOffset) || queryOffset < 0 || queryOffset + queryCount > BRIGHT_STACKOVERFLOW_QUERY_COUNT) throw Error("bright_answer_diagnose_count_invalid");
  const cases = [];
  for (let ordinal = queryOffset + 1; ordinal <= queryOffset + queryCount; ordinal++) {
    const prefix = String(ordinal).padStart(3, "0");
    const trace = await store.read(`${prefix}/answer.json`) ?? await store.read(`${prefix}/answer-trace.json`);
    const supplement = isRecord(trace) && trace.packingReplayContext == null ? await store.read(`${prefix}/packing-replay-context.json`) : null;
    const replayTrace = trace === null ? null : applyBrightPackingReplaySupplement(trace, supplement);
    const rawJudgment = await store.read(`${prefix}/judgment.json`);
    const judgment = rawJudgment === null ? null : decodeBrightAnswerJudgment(JSON.stringify(rawJudgment));
    cases.push({ ordinal, observed: trace !== null,
      replayContextSource: supplement !== null ? "accepted_run_supplement" : isRecord(trace) && trace.packingReplayContext != null ? "trace" : "unavailable",
      judgment: judgment && { verdict: judgment.verdict, grounding: judgment.grounding,
        missingPoints: judgment.missingPoints.length, incorrectClaims: judgment.incorrectClaims.length },
      stages: replayTrace === null ? null : diagnoseBrightAnswerTrace(replayTrace) });
  }
  return { reportVersion: 1, scoreable: false, providerCalls: 0, databaseCalls: 0, cases,
    summary: { requested: queryCount, observed: cases.filter(item => item.observed).length,
      evaluated: cases.filter(item => item.judgment).length,
      pass: cases.filter(item => item.judgment?.verdict === "pass").length,
      partial: cases.filter(item => item.judgment?.verdict === "partial").length,
      fail: cases.filter(item => item.judgment?.verdict === "fail").length,
      technicalFailureCases: cases.filter(item => item.stages?.technical.technicalFailure).length,
      degradedCases: cases.filter(item => (item.stages?.degradedFlagCount ?? 0) > 0).length,
      searchCalls: cases.reduce((sum, item) => sum + (item.stages?.technical.searchToolCalls ?? 0), 0),
      replayMatchedCases: cases.filter(item => item.stages?.packingReplay.status === "matched").length,
      replayMismatchCases: cases.filter(item => item.stages?.packingReplay.status === "mismatch").length,
      replayUnavailableCases: cases.filter(item => item.stages?.packingReplay.status === "unavailable").length },
    interpretation: "Timing components overlap; do not sum them. Missing contexts are not proof of missing relevant facts. A replay mismatch does not establish quality improvement." };
}

export async function diagnoseBrightAnswers(argv: readonly string[]) {
  if ((argv.length !== 2 && argv.length !== 4) || argv[0] !== "--output" || !argv[1] ||
    argv.length === 4 && (argv[2] !== "--baseline" || !argv[3])) throw Error("bright_answer_diagnose_arguments_invalid");
  const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(benchmarkRoot, "../..");
  const open = async (directory: string) => {
    const output = resolveKnowledgeBenchmarkOutputDirectory(benchmarkRoot, directory);
    const receipt = await readBrightPrivateJson(await assertOpenRagPrivatePathNoSymlinks(repositoryRoot, resolve(output, "manifest.json")));
    if (!isRecord(receipt) || !isRecord(receipt.manifest) ||
      ![1, 2, BRIGHT_ANSWER_CONTRACT_VERSION].includes(receipt.manifest.contractVersion as number) ||
      !Number.isSafeInteger(receipt.manifest.queryCount) ||
      receipt.manifest.queryOffset !== undefined && !Number.isSafeInteger(receipt.manifest.queryOffset)) throw Error("bright_answer_diagnose_manifest_invalid");
    const store = await createBrightAnswerStore({ repositoryRoot, output, manifest: receipt.manifest, resume: true });
    return { store, manifest: receipt.manifest, fingerprint: receipt.fingerprint };
  };
  const current = await open(argv[1]);
  try {
    const report = await buildBrightStageReport(current.store, Number(current.manifest.queryCount), Number(current.manifest.queryOffset ?? 0));
    let baseline = null;
    if (argv[3]) {
      const prior = await open(argv[3]);
      try {
        const priorReport = await buildBrightStageReport(prior.store, Number(prior.manifest.queryCount), Number(prior.manifest.queryOffset ?? 0));
        baseline = { fingerprint: prior.fingerprint, controls: compareBrightDiagnosticManifests(current.manifest, prior.manifest), summary: priorReport.summary };
      } finally { await prior.store.close(); }
    }
    await current.store.write("diagnosis.json", { ...report, baseline, sourceManifestFingerprint: current.fingerprint,
      sourceCodeFingerprint: current.manifest.codeFingerprint, replayCodeFingerprint: await brightAnswerCodeFingerprint(repositoryRoot) });
    process.stdout.write(`${JSON.stringify({ event: "bright_answer_diagnosis", ...report.summary, baseline })}\n`);
  } finally { await current.store.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  diagnoseBrightAnswers(process.argv.slice(2)).catch((error: unknown) => {
    process.stdout.write(`${JSON.stringify({ event: "bright_answer_diagnosis_failed", code: safeBrightAnswerError(error) })}\n`);
    process.exitCode = 1;
  });
}
