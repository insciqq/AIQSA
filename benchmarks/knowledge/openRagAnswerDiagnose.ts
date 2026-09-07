import { createHash } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveKnowledgeBenchmarkOutputDirectory } from "./contract";
import { assertOpenRagPrivatePathNoSymlinks } from "./openRagAnswerRunner";
import { decodeOpenRagJudgmentText } from "./openRagAnswerEvaluate";
import { diagnoseBrightAnswerTrace } from "./brightAnswerDiagnose";
import { applyBrightPackingReplaySupplement } from "./brightPackingReplay";
import { KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V1 } from "../../lib/server/knowledge/evidenceAnswerSnapshotV1";
import { KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2 } from "../../lib/server/knowledge/evidenceAnswerSnapshotV2";
import {
  brightAnswerCodeFingerprint, brightAnswerHash, createBrightAnswerStore, isRecord,
  readBrightPrivateJson, type BrightAnswerStore
} from "./brightAnswerHarness";

type RecordValue = Record<string, unknown>;
type Reader = Pick<BrightAnswerStore, "read">;
function fail(reason: string): never { throw Error(`open_rag_diagnose_${reason}`); }
const hash = (value: unknown) => brightAnswerHash(value);
const hashString = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
function rows(value: unknown, maximum = 512): RecordValue[] {
  if (!Array.isArray(value) || value.length > maximum || value.some(item => !isRecord(item))) fail("trace_invalid");
  return value as RecordValue[];
}

/** Both ordinary and separately qualified OCR controls use the current trace
 * envelope. Protocol and corpus differences remain comparison confounders. */
export function openRagDiagnosticManifest(value: unknown) {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.protocol !== "string" ||
    !/^[a-z][a-z0-9_]{1,99}$/u.test(value.protocol) || !Array.isArray(value.caseIds) ||
    value.caseIds.length < 1 || value.caseIds.length > 100 ||
    value.caseIds.some(id => typeof id !== "string" || !/^doc-[0-9]{3}-q[1-8]$/u.test(id)) ||
    new Set(value.caseIds).size !== value.caseIds.length || !hashString(value.casesFingerprint) ||
    !hashString(value.codeFingerprint) || typeof value.fullSlice !== "boolean" ||
    !["answerModel", "judgeModel", "answerControls", "judgeControls", "engine", "policies", "schema"].every(key => isRecord(value[key])) ||
    !Number.isSafeInteger(value.judgeContractVersion) ||
    !isRecord(value.corpus) && !Array.isArray(value.scopes)) fail("manifest_invalid");
  return value as RecordValue & { caseIds: string[]; codeFingerprint: string };
}

export function compareOpenRagDiagnosticManifests(current: RecordValue, baseline: RecordValue) {
  const changedFields = [...new Set([...Object.keys(current), ...Object.keys(baseline)])].sort()
    .filter(key => hash(current[key] ?? null) !== hash(baseline[key] ?? null));
  // Engine contracts are the experimental variable, just like its executable.
  // Everything else, including unknown future controls, is checked fail-closed.
  const controlChanges = changedFields.filter(key => !["codeFingerprint", "engine"].includes(key));
  return { controlsMatch: controlChanges.length === 0, controlChanges,
    codeChanged: current.codeFingerprint !== baseline.codeFingerprint,
    engineChanged: hash(current.engine ?? null) !== hash(baseline.engine ?? null) };
}

type Evidence = Readonly<{ identity: string; text: string }>;
function publishedComposition(trace: RecordValue, compositions: readonly RecordValue[]) {
  if (trace.status !== "complete") return null;
  const session = trace.knowledgeRetrievalSession as RecordValue;
  const result = session.groundingResult as RecordValue;
  const evidence = result.evidence as RecordValue;
  const operation = rows(evidence.operations, 8).filter(item =>
    ["knowledge_evidence_compose_v1", "knowledge_evidence_compose_v2"].includes(String(item.purpose))).at(-1);
  const attempts = rows(trace.knowledgeProviderAttempts, 64).filter(item => operation &&
    item.purpose === operation.purpose && item.requestHash === operation.acceptedRequestHash &&
    item.resultHash === operation.acceptedResultHash);
  if (attempts.length !== 1 || !isRecord(attempts[0]!.acceptedRequest)) fail("publication_composition_invalid");
  let prompt: unknown;
  try { prompt = JSON.parse(String(attempts[0]!.acceptedRequest.userPrompt)); } catch { fail("publication_composition_invalid"); }
  if (!isRecord(prompt) || typeof prompt.evidenceManifest !== "string") fail("publication_composition_invalid");
  const matches = compositions.filter(item => isRecord(item.providerAttempt) &&
    item.providerAttempt.ordinal === attempts[0]!.ordinal && item.providerAttempt.purpose === attempts[0]!.purpose);
  // Equal rendered bytes may belong to different evidence identities. Bind the
  // exact accepted attempt as well as its message, even after later attempts.
  if (matches.length !== 1 || matches[0]!.messageText !== prompt.evidenceManifest) fail("publication_composition_invalid");
  return matches[0]!;
}

function evidenceProjection(trace: RecordValue) {
  const primaries = new Map<string, Evidence>();
  for (const run of rows(trace.knowledgeRuns, 32)) for (const result of rows(run.results, 16)) {
    if (![result.handle, result.sourceArtifactId, result.documentVersionId, result.chunkId, result.includedText]
      .every(value => typeof value === "string" && value.length > 0)) fail("evidence_identity_invalid");
    const projected = { identity: hash([result.sourceArtifactId, result.documentVersionId, result.chunkId]),
      text: hash(result.includedText) };
    const prior = primaries.get(String(result.handle));
    if (prior && prior.identity !== projected.identity) fail("evidence_identity_invalid");
    primaries.set(String(result.handle), projected);
  }
  const compositions = rows(trace.knowledgeDispatchManifests).filter(manifest => isRecord(manifest.providerAttempt) &&
    typeof manifest.providerAttempt.dispatchedAt === "string" &&
    ["knowledge_evidence_compose_v1", "knowledge_evidence_compose_v2"].includes(String(manifest.providerAttempt.purpose)));
  const delivered = (manifest: RecordValue) => rows(manifest.items).map(item => {
    const primary = primaries.get(String(item.handle));
    // A full-context run has no retrieval primaries; do not invent a mapping.
    if (!primary) return null;
    let block: unknown;
    try { block = JSON.parse(String(item.renderedBlock)); } catch { fail("evidence_invalid"); }
    if (!isRecord(block)) fail("evidence_invalid");
    return { identity: primary.identity, text: hash({ excerpt: item.exactExcerpt ?? null,
      expandedContext: block.expandedContext ?? null, representation: item.representation ?? null }) };
  });
  const composition = publishedComposition(trace, compositions);
  const final = composition ? delivered(composition) : null;
  return { returned: [...primaries.values()],
    final: final && final.every(item => item !== null) ? final as Evidence[] : null };
}

function compareEvidence(current: readonly Evidence[] | null, baseline: readonly Evidence[] | null) {
  if (!current || !baseline) return null;
  const now = new Map(current.map(item => [item.identity, item.text]));
  const before = new Map(baseline.map(item => [item.identity, item.text]));
  const shared = [...now.keys()].filter(key => before.has(key));
  return { current: now.size, baseline: before.size, shared: shared.length,
    added: now.size - shared.length, removed: before.size - shared.length,
    changedText: shared.filter(key => now.get(key) !== before.get(key)).length,
    orderChanged: hash(current.map(item => item.identity)) !== hash(baseline.map(item => item.identity)) };
}

/** Select the review actually used for publication. A later discarded attempt
 * is not evidence that the published answer passed that review. */
function publication(trace: RecordValue) {
  if (trace.status !== "complete") return null;
  const session = isRecord(trace.knowledgeRetrievalSession) ? trace.knowledgeRetrievalSession : null;
  const result = isRecord(session?.groundingResult) ? session.groundingResult : null;
  const evidence = isRecord(result?.evidence) ? result.evidence : null;
  const answerHash = createHash("sha256").update(String(trace.answer), "utf8").digest("hex");
  const contractsHash = isRecord(evidence?.contracts) ? hash(evidence.contracts) : null;
  const reviewV1 = evidence && (evidence.version === 57 || evidence.version === 59) &&
    contractsHash === hash(KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V1);
  const reviewV2 = evidence && (evidence.version === 58 || evidence.version === 60) &&
    contractsHash === hash(KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2);
  if (!evidence || !reviewV1 && !reviewV2 || evidence.groundingStatus !== "verified" ||
    evidence.finalAnswerHash !== answerHash || result?.finalAnswerHash !== answerHash ||
    !["complete", "partial", "none"].includes(String(evidence.requestCoverage))) fail("publication_invalid");
  const reviewPurpose = reviewV1 ? "knowledge_evidence_review_v1" : "knowledge_evidence_review_v2";
  const operation = rows(evidence.operations, 8).filter(item => item.purpose === reviewPurpose).at(-1);
  const accepted = rows(trace.knowledgeProviderAttempts, 64).filter(item => operation &&
    item.purpose === operation.purpose && item.resultHash === operation.acceptedResultHash &&
    item.requestHash === operation.acceptedRequestHash && isRecord(item.acceptedResult));
  if (accepted.length !== 1) fail("publication_review_invalid");
  const review = accepted[0]!.acceptedResult as RecordValue;
  if (hash(review) !== operation!.acceptedResultHash || review.coverage !== evidence.requestCoverage) fail("publication_review_invalid");
  const requirements = review.version === 2 ? rows(review.requirements, 64) : null;
  return { coverage: String(evidence.requestCoverage),
    requirements: requirements && { answered: requirements.filter(item => item.status === "answered").length,
      needsCorrection: requirements.filter(item => item.status === "needs_correction").length,
      missingEvidence: requirements.filter(item => item.status === "missing_evidence").length },
    supportedBlocks: rows(review.blocks, 64).filter(item => item.verdict === "supported").length,
    rejectedBlocks: rows(review.blocks, 64).filter(item => item.verdict !== "supported").length };
}

export async function buildOpenRagDiagnostic(store: Reader, manifestInput: unknown) {
  const manifest = openRagDiagnosticManifest(manifestInput);
  const cases = [];
  const projections = new Map<string, { question: string; queries: string; evidence: ReturnType<typeof evidenceProjection> }>();
  for (const [index, caseId] of manifest.caseIds.entries()) {
    const prefix = String(index + 1).padStart(3, "0");
    const trace = await store.read(`${prefix}/answer.json`) ?? await store.read(`${prefix}/answer-trace.json`);
    const outcome = await store.read(`${prefix}/outcome.json`);
    const raw = await store.read(`${prefix}/judgment.json`);
    if (outcome !== null && (!isRecord(outcome) || outcome.caseId !== caseId || outcome.ordinal !== index + 1)) fail("case_binding_invalid");
    if (raw !== null && (!isRecord(raw) || !isRecord(raw.judgment))) fail("judgment_invalid");
    const decoded = isRecord(raw) ? decodeOpenRagJudgmentText(JSON.stringify(raw.judgment)) : null;
    const judgment = decoded && { verdict: decoded.verdict, reasonCode: decoded.reasonCode, grounded: decoded.grounded };
    if (trace === null) {
      if (outcome !== null || judgment !== null) fail("trace_missing");
      cases.push({ ordinal: index + 1, caseId, observed: false, settled: false, judgment: null,
        publication: null, reviewerJudgeDisagreement: false, stages: null });
      continue;
    }
    if (!isRecord(trace) || typeof trace.question !== "string" || typeof trace.answer !== "string") fail("trace_invalid");
    const request = await store.read(`${prefix}/answer-request.json`);
    const blocks = isRecord(request) && isRecord(request.content) ? request.content.blocks : null;
    if (!Array.isArray(blocks) || blocks.length !== 1 || !isRecord(blocks[0]) || blocks[0].text !== trace.question) fail("question_binding_invalid");
    const published = publication(trace);
    if (isRecord(outcome) && (outcome.answerStatus !== trace.status || outcome.verdict !== (judgment?.verdict ?? null) ||
      outcome.coverage !== (published?.coverage ?? null))) fail("outcome_invalid");
    const supplement = trace.packingReplayContext == null ? await store.read(`${prefix}/packing-replay-context.json`) : null;
    const replayTrace = applyBrightPackingReplaySupplement(trace, supplement);
    const stages = diagnoseBrightAnswerTrace(replayTrace);
    projections.set(caseId, { question: hash(trace.question),
      queries: hash(rows(trace.toolCalls, 32).filter(call => call.toolName === "search_knowledge")
        .map(call => isRecord(call.arguments) ? call.arguments.query : null)), evidence: evidenceProjection(trace) });
    cases.push({ ordinal: index + 1, caseId, observed: true, settled: outcome !== null, judgment, publication: published,
      reviewerJudgeDisagreement: published?.coverage === "complete" && judgment !== null && judgment.verdict !== "pass", stages });
  }
  const summary = { requested: cases.length, observed: cases.filter(item => item.observed).length,
    settled: cases.filter(item => item.settled).length, evaluated: cases.filter(item => item.judgment).length,
    pass: cases.filter(item => item.judgment?.verdict === "pass").length,
    partial: cases.filter(item => item.judgment?.verdict === "partial").length,
    fail: cases.filter(item => item.judgment?.verdict === "fail").length,
    technicalFailureCases: cases.filter(item => item.stages?.technical.technicalFailure).length,
    degradedCases: cases.filter(item => (item.stages?.degradedFlagCount ?? 0) > 0).length,
    reviewerJudgeDisagreements: cases.filter(item => item.reviewerJudgeDisagreement).length,
    replayMatched: cases.filter(item => item.stages?.packingReplay.status === "matched").length,
    replayMismatch: cases.filter(item => item.stages?.packingReplay.status === "mismatch").length,
    replayUnavailable: cases.filter(item => item.stages?.packingReplay.status === "unavailable").length };
  return { report: { version: 1, scoreable: false, providerCalls: 0, databaseCalls: 0, summary, cases,
    interpretation: "Review/judge disagreement is a diagnostic signal, not proof of which is wrong. Passage overlap is not semantic recall. Packing mismatches stop replay; later recorded reviews cannot judge changed context. Timings overlap. Paired outcomes do not isolate a stochastic code effect." }, projections };
}

export function compareOpenRagDiagnostics(current: Awaited<ReturnType<typeof buildOpenRagDiagnostic>>,
  baseline: Awaited<ReturnType<typeof buildOpenRagDiagnostic>>) {
  const priorCases = new Map(baseline.report.cases.map(item => [item.caseId, item]));
  const score = { fail: 0, partial: 1, pass: 2 };
  const pairs = current.report.cases.map(item => {
    const prior = priorCases.get(item.caseId);
    const now = current.projections.get(item.caseId), before = baseline.projections.get(item.caseId);
    const sameQuestion = now && before ? now.question === before.question : null;
    const transition = !item.settled || !prior?.settled || !item.judgment || !prior.judgment || sameQuestion !== true ? "unavailable" :
      score[item.judgment.verdict] === score[prior.judgment.verdict] ? "unchanged" :
        score[item.judgment.verdict] > score[prior.judgment.verdict] ? "improved" : "regressed";
    return { ordinal: item.ordinal, baselineOrdinal: prior?.ordinal ?? null, transition, sameQuestion,
      verdict: item.judgment?.verdict ?? null, baselineVerdict: prior?.judgment?.verdict ?? null,
      queryTextsUnchanged: now && before ? now.queries === before.queries : null,
      returned: now && before ? compareEvidence(now.evidence.returned, before.evidence.returned) : null,
      finalContext: now && before ? compareEvidence(now.evidence.final, before.evidence.final) : null };
  });
  return { summary: { paired: pairs.filter(item => item.baselineOrdinal !== null).length,
    improved: pairs.filter(item => item.transition === "improved").length,
    regressed: pairs.filter(item => item.transition === "regressed").length,
    unchanged: pairs.filter(item => item.transition === "unchanged").length,
    unavailable: pairs.filter(item => item.transition === "unavailable").length,
    questionChanges: pairs.filter(item => item.sameQuestion === false).length }, pairs };
}

export async function diagnoseOpenRagAnswers(argv: readonly string[]) {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]!, value = argv[index + 1];
    if (!["--input", "--baseline", "--output"].includes(key) || options.has(key) || !value || value.startsWith("--")) fail("arguments_invalid");
    options.set(key, value);
  }
  if (!options.has("--input") || !options.has("--output")) fail("arguments_invalid");
  const benchmarkRoot = dirname(fileURLToPath(import.meta.url)), repositoryRoot = resolve(benchmarkRoot, "../..");
  const paths = [...options].map(([key, value]) => [key, resolveKnowledgeBenchmarkOutputDirectory(benchmarkRoot, value)] as const);
  const contains = (a: string, b: string) => { const path = relative(a, b); return !path || path !== ".." && !path.startsWith("../"); };
  if (paths.some(([, a], i) => paths.some(([, b], j) => i < j && (contains(a, b) || contains(b, a))))) fail("overlapping_paths");
  const open = async (key: string) => {
    const output = paths.find(([name]) => name === key)![1];
    const receipt = await readBrightPrivateJson(await assertOpenRagPrivatePathNoSymlinks(repositoryRoot, resolve(output, "manifest.json")));
    if (!isRecord(receipt)) fail("manifest_invalid");
    const manifest = openRagDiagnosticManifest(receipt.manifest);
    const store = await createBrightAnswerStore({ repositoryRoot, output, manifest, resume: true });
    return { store, manifest, fingerprint: hash(manifest) };
  };
  const current = await open("--input");
  try {
    const diagnosis = await buildOpenRagDiagnostic(current.store, current.manifest);
    let baseline = null;
    if (options.has("--baseline")) {
      const prior = await open("--baseline");
      try {
        const report = await buildOpenRagDiagnostic(prior.store, prior.manifest);
        baseline = { fingerprint: prior.fingerprint, controls: compareOpenRagDiagnosticManifests(current.manifest, prior.manifest),
          summary: report.report.summary, comparison: compareOpenRagDiagnostics(diagnosis, report) };
      } finally { await prior.store.close(); }
    }
    const output = await createBrightAnswerStore({ repositoryRoot, output: paths.find(([key]) => key === "--output")![1], resume: false,
      manifest: { version: 1, protocol: "openrag_offline_diagnosis", sourceManifestFingerprint: current.fingerprint,
        baselineManifestFingerprint: baseline?.fingerprint ?? null, sourceCodeFingerprint: current.manifest.codeFingerprint,
        replayCodeFingerprint: await brightAnswerCodeFingerprint(repositoryRoot) } });
    try { await output.write("diagnosis.json", { ...diagnosis.report, baseline }); } finally { await output.close(); }
    process.stdout.write(`${JSON.stringify({ event: "open_rag_diagnosis", ...diagnosis.report.summary,
      comparison: baseline && { ...baseline.comparison.summary, controlsMatch: baseline.controls.controlsMatch } })}\n`);
  } finally { await current.store.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  diagnoseOpenRagAnswers(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    const code = /^(?:open_rag_diagnose_|bright_answer_)[a-z_]+$/u.test(message) ? message : "open_rag_diagnose_failed";
    process.stdout.write(`${JSON.stringify({ event: "open_rag_diagnosis_failed", code })}\n`);
    process.exitCode = 1;
  });
}
