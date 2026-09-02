import {
  OPEN_RAG_ANSWER_JUDGE_CONTRACT_VERSION,
  type OpenRagAnswerCase
} from "./openRagAnswerContract";

export const OPEN_RAG_JUDGE_CONTRACT_VERSION =
  OPEN_RAG_ANSWER_JUDGE_CONTRACT_VERSION;

export type OpenRagJudgeVerdict = "fail" | "partial" | "pass";
export type OpenRagJudgeReason =
  | "citation_issue"
  | "correct"
  | "judge_uncertain"
  | "minor_omission"
  | "no_answer"
  | "retrieval_miss"
  | "unsupported"
  | "wrong_value";

export type OpenRagJudgment = Readonly<{
  correctness: number;
  explanation: string;
  grounded: boolean;
  reasonCode: OpenRagJudgeReason;
  verdict: OpenRagJudgeVerdict;
}>;

export type OpenRagFailureClassification =
  | "coverage_audit_error"
  | "dataset_question_invalid"
  | "dataset_reference_invalid"
  | "document_mismatch"
  | "draft_omission"
  | "evidence_budget_or_packing_loss"
  | "false_complete"
  | "false_insufficient"
  | "judge_disagreement"
  | "parser_missing_content"
  | "provider_or_infrastructure_failure"
  | "rerank_relevant_candidate_dropped"
  | "retrieval_relevant_source_absent"
  | "selector_support_error";

export type OpenRagFailureFacts = Readonly<{
  answerCompleted: boolean;
  answerCoverage: "complete" | "none" | "partial" | null;
  answerStageFailure: string | null;
  auditMissingCount: number | null;
  draftHadReferenceAxis: boolean | null;
  evidenceHadGoldSource: boolean | null;
  evidenceHadRelevantContent: boolean | null;
  goldCandidateBeforeRerank: boolean | null;
  goldCandidateAfterRerank: boolean | null;
  judgment: OpenRagJudgment | null;
  parserArtifactReady: boolean | null;
  selectorRejectedReferenceAxis: boolean | null;
}>;

const judgmentKeys = Object.freeze([
  "correctness",
  "explanation",
  "grounded",
  "reasonCode",
  "verdict"
] as const);
const reasons = new Set<OpenRagJudgeReason>([
  "citation_issue",
  "correct",
  "judge_uncertain",
  "minor_omission",
  "no_answer",
  "retrieval_miss",
  "unsupported",
  "wrong_value"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

export function openRagJudgePrompt(input: Readonly<{
  answer: string;
  case: OpenRagAnswerCase;
  citationCount: number;
  citedEvidence: readonly Readonly<{
    handle: string;
    locator: string | null;
    providerEvidence: string;
    providerEvidenceTruncated: boolean;
    sourceLabel: string | null;
  }>[];
  productCoverage: "complete" | "none" | "partial" | null;
}>): string {
  return [
    `OPENRAG_JUDGE_CONTRACT_VERSION: ${OPEN_RAG_JUDGE_CONTRACT_VERSION}`,
    "Evaluate an AIQSA answer against an authoritative public benchmark reference answer.",
    "Do not answer the question yourself and do not challenge or replace the supplied reference answer.",
    "Return only one JSON object, without Markdown or commentary, with exactly these keys:",
    '{"verdict":"pass|partial|fail","correctness":0,"grounded":true,"reasonCode":"correct|minor_omission|wrong_value|unsupported|no_answer|retrieval_miss|citation_issue|judge_uncertain","explanation":"..."}',
    "correctness is an integer from 0 to 4.",
    "Accept semantically equivalent wording but preserve values, units, entities, relations, and qualifiers.",
    "pass means the request and essential reference meaning are fully covered without contradiction or unsupported additions.",
    "partial means the core is correct but a material requested part or qualifier is missing.",
    "fail means wrong, contradicted, evasive, unsupported, or missing the requested answer.",
    "Use CITED_EVIDENCE only to check support; do not generate a replacement answer from it.",
    "Use reasonCode=correct only with verdict=pass, never with partial or fail.",
    "A product partial settlement cannot receive pass; a none settlement cannot receive pass or partial.",
    "grounded requires cited immutable evidence and a non-insufficient product settlement.",
    `INPUT_JSON: ${JSON.stringify({
      actualAnswer: input.answer,
      citedEvidence: input.citedEvidence,
      knowledgeCitationCount: input.citationCount,
      productSelectorCoverage: input.productCoverage ?? "unknown",
      question: input.case.question,
      questionType: input.case.type,
      referenceAnswer: input.case.referenceAnswer,
      sourceModality: input.case.source
    })}`
  ].join("\n");
}

export function decodeOpenRagJudgment(value: unknown): OpenRagJudgment {
  const code = "open_rag_judge_contract_invalid";
  if (!isRecord(value) || !hasExactKeys(value, judgmentKeys) ||
    value.verdict !== "pass" && value.verdict !== "partial" && value.verdict !== "fail" ||
    !Number.isSafeInteger(value.correctness) || Number(value.correctness) < 0 ||
      Number(value.correctness) > 4 || typeof value.grounded !== "boolean" ||
    typeof value.reasonCode !== "string" ||
      !reasons.has(value.reasonCode as OpenRagJudgeReason) ||
    typeof value.explanation !== "string" || value.explanation.includes("\u0000") ||
      value.explanation.trim().length === 0 ||
      Buffer.byteLength(value.explanation, "utf8") > 4_000) throw new Error(code);
  const judgment: OpenRagJudgment = Object.freeze({
    correctness: Number(value.correctness),
    explanation: value.explanation.trim(),
    grounded: value.grounded,
    reasonCode: value.reasonCode as OpenRagJudgeReason,
    verdict: value.verdict
  });
  if (judgment.verdict === "pass" && (judgment.correctness < 3 || !judgment.grounded) ||
    (judgment.verdict === "partial" || judgment.verdict === "fail") &&
      judgment.reasonCode === "correct" ||
    judgment.verdict === "pass" && judgment.reasonCode !== "correct") throw new Error(code);
  return judgment;
}

export function decodeOpenRagJudgmentText(value: string): OpenRagJudgment {
  const text = value.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("open_rag_judge_contract_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("open_rag_judge_contract_invalid");
  }
  return decodeOpenRagJudgment(parsed);
}

export function applyOpenRagCoverageCeiling(
  judgment: OpenRagJudgment,
  coverage: OpenRagFailureFacts["answerCoverage"]
): OpenRagJudgment {
  if (coverage === "none") {
    return Object.freeze({
      correctness: 0,
      explanation: "The product settled with no supported requested coverage.",
      grounded: false,
      reasonCode: "no_answer",
      verdict: "fail"
    });
  }
  if (coverage === "partial" && judgment.verdict === "pass") {
    return Object.freeze({
      ...judgment,
      correctness: Math.min(judgment.correctness, 3),
      explanation: "The supported content is correct, but product settlement is partial.",
      reasonCode: "minor_omission",
      verdict: "partial"
    });
  }
  return judgment;
}

export function applyOpenRagCitationCeiling(
  judgment: OpenRagJudgment,
  citationCount: number
): OpenRagJudgment {
  if (!Number.isSafeInteger(citationCount) || citationCount < 0) {
    throw new Error("open_rag_judge_citation_count_invalid");
  }
  if (citationCount > 0) return judgment;
  if (judgment.verdict === "fail") {
    return judgment.grounded
      ? Object.freeze({ ...judgment, grounded: false })
      : judgment;
  }
  return Object.freeze({
    correctness: Math.min(judgment.correctness, 2),
    explanation: "The answer has no immutable Knowledge citation.",
    grounded: false,
    reasonCode: "citation_issue",
    verdict: "fail"
  });
}

export function classifyOpenRagFailure(
  facts: OpenRagFailureFacts
): OpenRagFailureClassification | null {
  if (facts.judgment?.verdict === "pass") return null;
  if (!facts.answerCompleted || facts.answerStageFailure) {
    return "provider_or_infrastructure_failure";
  }
  if (facts.parserArtifactReady === false) return "parser_missing_content";
  if (facts.evidenceHadGoldSource === false) {
    if (facts.goldCandidateBeforeRerank === true && facts.goldCandidateAfterRerank === false) {
      return "rerank_relevant_candidate_dropped";
    }
    return "retrieval_relevant_source_absent";
  }
  if (facts.evidenceHadRelevantContent === false) return "evidence_budget_or_packing_loss";
  if (facts.selectorRejectedReferenceAxis === true) return "selector_support_error";
  if (facts.answerCoverage === "complete" && facts.judgment?.reasonCode === "minor_omission") {
    return "false_complete";
  }
  if (facts.answerCoverage === "none" && facts.evidenceHadRelevantContent === true) {
    return "false_insufficient";
  }
  if (facts.auditMissingCount !== null && facts.auditMissingCount > 0 &&
    facts.draftHadReferenceAxis === true) return "coverage_audit_error";
  if (facts.draftHadReferenceAxis === false) return "draft_omission";
  if (facts.judgment?.reasonCode === "judge_uncertain") return "judge_disagreement";
  return facts.judgment?.reasonCode === "citation_issue"
    ? "selector_support_error"
    : "draft_omission";
}

export function aggregateOpenRagJudgments(
  judgments: readonly OpenRagJudgment[]
): Readonly<{
  fail: number;
  grounded: number;
  partial: number;
  pass: number;
  total: number;
}> {
  return Object.freeze({
    fail: judgments.filter(({ verdict }) => verdict === "fail").length,
    grounded: judgments.filter(({ grounded }) => grounded).length,
    partial: judgments.filter(({ verdict }) => verdict === "partial").length,
    pass: judgments.filter(({ verdict }) => verdict === "pass").length,
    total: judgments.length
  });
}
