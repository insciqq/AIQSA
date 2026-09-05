import { createHash } from "node:crypto";
import { KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2 } from "../../lib/server/knowledge/evidenceAnswerSnapshotV2";
import { brightAnswerHash, isRecord, type BrightAnswerStore } from "./brightAnswerHarness";
import type { BrightAnswerTrace } from "./brightAnswerTrace";
import type { OpenRagAnswerCase } from "./openRagAnswerContract";
import {
  applyOpenRagCitationCeiling, applyOpenRagCoverageCeiling, boundedOpenRagCitedEvidence,
  decodeOpenRagJudgmentText, openRagJudgePrompt
} from "./openRagAnswerEvaluate";
import { brightAnswerDiagnostics } from "./brightAnswerReport";

export function assertOpenRagCurrentSchema(expected: Readonly<Record<string, string>>, applied: readonly Readonly<{
  name: string; checksum: string; finished: boolean;
}>[]) {
  const names = Object.keys(expected).sort();
  const latest = names.at(-1);
  if (!latest || applied.length !== names.length ||
    new Set(applied.map(item => item.name)).size !== applied.length ||
    applied.some(item => !item.finished || !Object.hasOwn(expected, item.name) || !/^[0-9a-f]{64}$/u.test(item.checksum)) ||
    applied.find(item => item.name === latest)?.checksum !== expected[latest]) {
    throw Error("open_rag_current_schema_mismatch");
  }
  // This is migration-ledger readiness, not a schema-drift audit. Historical
  // checksums remain immutable even when later forward migrations supersede
  // their DDL. Pin both histories so a resumed campaign cannot hide changes.
  const ordered = [...applied].sort((a, b) => a.name.localeCompare(b.name));
  return { sourceFingerprint: brightAnswerHash(expected), appliedFingerprint: brightAnswerHash(ordered),
    historicalChecksumDifferences: ordered.filter(item => expected[item.name] !== item.checksum).length };
}

export function parseOpenRagCurrentCli(argv: readonly string[]) {
  let baseline: string | null = null, output: string | null = null;
  let full = false, resume = false, preflightOnly = false, paid = false, batchSize = 1;
  const caseIds: string[] = [];
  const seen = new Set<string>();
  const invalid = () => { throw Error("open_rag_current_arguments_invalid"); };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]!;
    if (key !== "--case-id" && seen.has(key)) invalid();
    seen.add(key);
    if (key === "--full") { full = true; continue; }
    if (key === "--resume") { resume = true; continue; }
    if (key === "--preflight-only") { preflightOnly = true; continue; }
    const value = argv[++index];
    if (!value || value.startsWith("--")) invalid();
    if (key === "--baseline") baseline = value!;
    else if (key === "--output") output = value!;
    else if (key === "--case-id") {
      if (!/^doc-[0-9]{3}-q[1-8]$/u.test(value!) || caseIds.includes(value!)) invalid();
      caseIds.push(value!);
    } else if (key === "--batch-size") {
      if (!/^[1-5]$/u.test(value!)) invalid();
      batchSize = Number(value);
    } else if (key === "--confirm-paid") {
      if (value !== "OPENRAG") invalid();
      paid = true;
    } else invalid();
  }
  if (!paid) throw Error("open_rag_answer_paid_confirmation_required");
  if (!baseline || !output || full === (caseIds.length > 0) || caseIds.length > 100) invalid();
  return { baseline: baseline!, output: output!, full, resume, preflightOnly, batchSize,
    caseIds: Object.freeze(caseIds.sort()) };
}

/** Read publication coverage from the actual terminal receipt, never the last
 * attempted review (which may have been discarded) or the answer's wording. */
export function currentOpenRagEvaluationInput(trace: BrightAnswerTrace, benchmarkCase: OpenRagAnswerCase) {
  const result = trace.knowledgeRetrievalSession?.groundingResult;
  const evidence = isRecord(result?.evidence) ? result.evidence : null;
  const answerHash = createHash("sha256").update(trace.answer, "utf8").digest("hex");
  const coverage = evidence?.requestCoverage;
  if (trace.status !== "complete" || !result || !evidence || evidence.version !== 58 ||
    brightAnswerHash(evidence.contracts) !== brightAnswerHash(KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2) ||
    evidence.groundingStatus !== "verified" || result.finalAnswerHash !== answerHash ||
    evidence.finalAnswerHash !== answerHash || result.outcome !== evidence.outcome ||
    !["complete", "partial", "none"].includes(String(coverage)) ||
    result.outcome !== (coverage === "none" ? "insufficient_evidence" : "answered")) {
    throw Error("open_rag_current_publication_receipt_invalid");
  }
  const delivered = new Map<string, { handle: string; text: string; locator: string | null; sourceLabel: string | null }>();
  for (const manifest of trace.knowledgeDispatchManifests) {
    if (!manifest.providerAttempt.dispatchedAt) continue;
    for (const item of manifest.items) {
      const block: unknown = JSON.parse(item.renderedBlock);
      if (!isRecord(block) || block.handle !== item.handle) throw Error("open_rag_current_evidence_invalid");
      delivered.set(item.handle, { handle: item.handle, text: item.renderedBlock,
        locator: typeof block.locator === "string" ? block.locator : null,
        sourceLabel: typeof block.sourceLabel === "string" ? block.sourceLabel : null });
    }
  }
  const citedEvidence = boundedOpenRagCitedEvidence(trace.answer, [...delivered.values()]);
  return { answer: trace.answer, case: benchmarkCase, citationCount: citedEvidence.length, citedEvidence,
    productCoverage: coverage as "complete" | "partial" | "none" };
}

export async function runOpenRagCurrentCases(input: Readonly<{
  cases: readonly OpenRagAnswerCase[];
  full: boolean;
  batchSize: number;
  store: Pick<BrightAnswerStore, "read" | "write">;
  executeStage(index: number, stage: "answer" | "judge", prompt: string): Promise<BrightAnswerTrace>;
  emit(value: Readonly<Record<string, unknown>>): void;
}>) {
  if (!Number.isSafeInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 5 ||
    input.cases.length < 1 || input.cases.length > 100 || input.full && input.cases.length !== 100 ||
    new Set(input.cases.map(item => item.caseId)).size !== input.cases.length) {
    throw Error("open_rag_current_cases_invalid");
  }
  const outcomes: Record<string, unknown>[] = [];
  let executed = 0;
  for (const [index, benchmarkCase] of input.cases.entries()) {
    const prefix = String(index + 1).padStart(3, "0");
    const settled = await input.store.read(`${prefix}/outcome.json`);
    if (settled !== null) {
      if (!isRecord(settled) || settled.caseId !== benchmarkCase.caseId ||
        !["pass", "partial", "fail", null].includes(settled.verdict as string | null)) {
        throw Error("open_rag_current_outcome_invalid");
      }
      outcomes.push(settled);
      continue;
    }
    if (executed >= input.batchSize) continue;
    input.emit({ event: "open_rag_current_case_started", ordinal: index + 1 });
    // The answer stage receives no reference, document alias or gold section.
    const answer = await input.executeStage(index, "answer", benchmarkCase.question);
    let evaluation: ReturnType<typeof currentOpenRagEvaluationInput> | null = null;
    let judgment: ReturnType<typeof decodeOpenRagJudgmentText> | null = null;
    let judged: BrightAnswerTrace | null = null;
    if (answer.status !== "error") {
      evaluation = currentOpenRagEvaluationInput(answer, benchmarkCase);
      await input.store.write(`${prefix}/evaluation-input.json`, evaluation);
      judged = await input.executeStage(index, "judge", openRagJudgePrompt(evaluation));
      const rawJudgment = decodeOpenRagJudgmentText(judged.answer);
      judgment = applyOpenRagCitationCeiling(
        applyOpenRagCoverageCeiling(rawJudgment, evaluation.productCoverage), evaluation.citationCount);
      await input.store.write(`${prefix}/judgment.json`, { rawJudgment, judgment });
    }
    const outcome = { caseId: benchmarkCase.caseId, ordinal: index + 1, answerStatus: answer.status,
      verdict: judgment?.verdict ?? null, grounded: judgment?.grounded ?? false,
      reasonCode: judgment?.reasonCode ?? null, coverage: evaluation?.productCoverage ?? null,
      citationCount: evaluation?.citationCount ?? 0, ...brightAnswerDiagnostics(answer),
      degradedFlags: answer.knowledgeRetrievalSession?.degradedFlags ?? [],
      groundingOperations: answer.knowledgeProviderAttempts.length,
      inputTokens: answer.inputTokens, outputTokens: answer.outputTokens,
      judgeInputTokens: judged?.inputTokens ?? 0, judgeOutputTokens: judged?.outputTokens ?? 0 };
    await input.store.write(`${prefix}/outcome.json`, outcome);
    outcomes.push(outcome);
    executed++;
    input.emit({ event: "open_rag_current_case_complete", ordinal: index + 1,
      verdict: outcome.verdict, grounded: outcome.grounded, coverage: outcome.coverage,
      technicalFailure: outcome.technicalFailure, searchCalls: outcome.searchToolCalls });
  }
  const summary = { scoreable: input.full && outcomes.length === 100,
    complete: outcomes.length === input.cases.length, requested: input.cases.length, total: outcomes.length,
    pass: outcomes.filter(item => item.verdict === "pass").length,
    partial: outcomes.filter(item => item.verdict === "partial").length,
    fail: outcomes.filter(item => item.verdict === "fail").length,
    grounded: outcomes.filter(item => item.grounded).length,
    terminalAnswerFailures: outcomes.filter(item => item.answerStatus === "error").length,
    technicalFailureCases: outcomes.filter(item => item.technicalFailure).length,
    degradedCases: outcomes.filter(item => Array.isArray(item.degradedFlags) && item.degradedFlags.length).length };
  await input.store.write("summary.json", { ...summary, outcomes });
  input.emit({ event: "open_rag_current_summary", ...summary });
  return summary;
}
