import { createHash } from "node:crypto";
import { decodeKnowledgeCitationHandle } from "../../contracts/knowledge";
import {
  knowledgeEvidenceReceiptHash,
  type KnowledgeEvidencePackage
} from "./evidencePackage";

export const KNOWLEDGE_GROUNDING_VERSION = 5 as const;

export type KnowledgeGroundingResult = Readonly<{
  finalAnswerHash: string;
  finalText: string;
  originalAnswerHash: string;
  outcome: "answered" | "insufficient_evidence";
  receiptHash: string;
  sessionId: string;
  version: typeof KNOWLEDGE_GROUNDING_VERSION;
}>;

export class KnowledgeAnswerContractError extends Error {
  readonly code:
    | "knowledge_answer_contract_failed"
    | "knowledge_citation_contract_failed";

  constructor(
    code: KnowledgeAnswerContractError["code"],
    message: string
  ) {
    super(message);
    this.name = "KnowledgeAnswerContractError";
    this.code = code;
  }
}

const statusAnswered = "AIQSA_KB_STATUS=ANSWERED";
const statusInsufficient = "AIQSA_KB_STATUS=INSUFFICIENT_EVIDENCE";
const groupedCitation = /[\[(【]\s*((?:K[1-9]\d{0,3}(?:\.[1-9]\d?)?)(?:\s*(?:[,;&/+]|and|и)\s*(?:K[1-9]\d{0,3}(?:\.[1-9]\d?)?))*)\s*[\])】]/giu;
const citationToken = /K[1-9]\d{0,3}(?:\.[1-9]\d?)?/giu;
const bracketedKnowledgeToken = /\[\s*(K[^\]]{0,64})\s*\]/giu;
const adjacentDuplicate = /(\[K[1-9]\d{0,3}(?:\.[1-9]\d?)?\])(?:\s*\1)+/giu;
const commaGroupedCitation = /\[\s*(K[1-9]\d{0,3}(?:\.[1-9]\d?)?(?:\s*,\s*K[1-9]\d{0,3}(?:\.[1-9]\d?)?)+)\s*\]/giu;
const internalIdentity = /\b(?:sourceId|sourceArtifactId|sourceVersionId|documentId|documentVersionId|knowledgeBaseId|knowledgeBaseSnapshotId|indexGenerationId|chunkId|passageId|sectionId|evidenceItemId|evidencePackageId|manifestId|manifestHash|retrievalSessionId|knowledgeRunId|modelRunId|modelRunToolCallId|providerAttemptId|providerCallId|providerResponseId|profileRevisionId|embeddingProviderModelId|credentialId|receiptHash|contentHash|requestHash|checkpointHash|idempotencyKey|dispatchAttemptKey|fusedScore|vectorDistance|rawScore|(?:vector|lexical|semantic|hybrid|rrf|rerank|similarity|confidence)Score|confidenceBucket|preRerankRank|postRerankRank|knowledge_focused_v1)\b/iu;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeToolLoopCitationSyntax(
  value: string,
  availableHandles: ReadonlySet<string>
): string {
  return value.replace(commaGroupedCitation, (match, body: string) => {
    const handles = body.split(",").map((handle) => handle.trim().toUpperCase());
    return handles.every((handle) => availableHandles.has(handle))
      ? handles.map((handle) => `[${handle}]`).join("")
      : match;
  });
}

function containsEvidenceInternalIdentity(
  answer: string,
  evidence: KnowledgeEvidencePackage
): boolean {
  const sentinels = [
    evidence.runId,
    evidence.sessionId,
    ...evidence.items.flatMap((item) => [
      item.id,
      item.knowledgeBaseId,
      item.sourceId,
      item.sourceVersionId,
      item.sourceArtifactId,
      item.documentId,
      item.documentVersionId,
      item.sectionId,
      item.passageId,
      item.contentHash
    ])
  ].filter((entry): entry is string => Boolean(entry && entry.length >= 8));
  return sentinels.some((entry) => answer.includes(entry));
}

function normalizeCitationSyntax(value: string): string {
  const grouped = value.replace(groupedCitation, (match, body: string) => {
    const handles = body.match(citationToken)?.map((handle) => handle.toUpperCase()) ?? [];
    return handles.length > 0 && handles.every((handle) => decodeKnowledgeCitationHandle(handle))
      ? handles.map((handle) => `[${handle}]`).join("")
      : match;
  });
  return grouped.replace(adjacentDuplicate, "$1");
}

function assertNoMalformedOrUnknownHandles(
  answer: string,
  availableHandles: ReadonlySet<string>
): string[] {
  const seen: string[] = [];
  for (const match of answer.matchAll(bracketedKnowledgeToken)) {
    const raw = match[1]?.trim().toUpperCase() ?? "";
    const decoded = decodeKnowledgeCitationHandle(raw);
    if (!decoded || !availableHandles.has(raw)) {
      throw new KnowledgeAnswerContractError(
        "knowledge_citation_contract_failed",
        "The Knowledge answer cited a handle outside the final evidence manifest"
      );
    }
    seen.push(raw);
  }
  const outsideBrackets = answer.replace(
    /\[\s*K[1-9]\d{0,3}(?:\.[1-9]\d?)?\s*\]/giu,
    ""
  );
  if (/\bK[1-9]\d{0,3}(?:\.[1-9]\d?)?\b/iu.test(outsideBrackets)) {
    throw new KnowledgeAnswerContractError(
      "knowledge_citation_contract_failed",
      "The Knowledge answer used a malformed citation handle"
    );
  }
  return seen;
}

/**
 * Structural-only answer settlement. It validates the exact status line and
 * final-manifest handles; it never scores prose, guesses support, calls a
 * model, retries, or rewrites answer content.
 */
export function groundKnowledgeAnswer(input: Readonly<{
  answer: string;
  evidence: KnowledgeEvidencePackage;
}>): KnowledgeGroundingResult {
  const original = input.answer.replace(/\r\n?/gu, "\n");
  const newline = original.indexOf("\n");
  const status = newline < 0 ? original : original.slice(0, newline);
  if (status !== statusAnswered && status !== statusInsufficient) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      status.startsWith("AIQSA_KB_STATUS=")
        ? "The Knowledge answer returned an unknown status"
        : "The Knowledge answer omitted the required status line"
    );
  }
  const body = newline < 0 ? "" : original.slice(newline + 1);
  if (!body.trim() || internalIdentity.test(body) ||
    containsEvidenceInternalIdentity(body, input.evidence)) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      !body.trim()
        ? "The Knowledge answer body is empty"
        : "The Knowledge answer leaked an internal identity"
    );
  }
  const normalizedBody = normalizeCitationSyntax(body);
  const availableHandles = new Set(
    input.evidence.items
      .filter((item) => item.state === "available" && item.excerpt !== null)
      .map((item) => item.handle)
  );
  const handles = assertNoMalformedOrUnknownHandles(normalizedBody, availableHandles);
  if (status === statusAnswered && handles.length < 1) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "An answered Knowledge response requires a final-manifest citation"
    );
  }
  const answered = status === statusAnswered;
  return Object.freeze({
    finalAnswerHash: hash(normalizedBody),
    finalText: normalizedBody,
    originalAnswerHash: hash(input.answer),
    outcome: answered ? "answered" : "insufficient_evidence",
    receiptHash: knowledgeEvidenceReceiptHash(input.evidence),
    sessionId: input.evidence.sessionId,
    version: KNOWLEDGE_GROUNDING_VERSION
  });
}

/**
 * Structural settlement for the ordinary answer-model tool loop. It keeps the
 * answer as ordinary Markdown and only normalizes an unambiguous comma-group
 * whose every handle belongs to provider-visible, still-available evidence.
 */
export function groundKnowledgeToolLoopAnswer(input: Readonly<{
  answer: string;
  evidence: KnowledgeEvidencePackage;
}>): KnowledgeGroundingResult {
  const original = input.answer.replace(/\r\n?/gu, "\n");
  if (!original.trim() || internalIdentity.test(original) ||
    containsEvidenceInternalIdentity(original, input.evidence)) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      !original.trim()
        ? "The answer body is empty"
        : "The answer leaked an internal Knowledge identity"
    );
  }
  const availableHandles = new Set(
    input.evidence.items
      .filter((item) => item.state === "available" && item.excerpt !== null)
      .map((item) => item.handle)
  );
  const finalText = normalizeToolLoopCitationSyntax(original, availableHandles);
  assertNoMalformedOrUnknownHandles(finalText, availableHandles);
  return Object.freeze({
    finalAnswerHash: hash(finalText),
    finalText,
    originalAnswerHash: hash(input.answer),
    outcome: "answered",
    receiptHash: knowledgeEvidenceReceiptHash(input.evidence),
    sessionId: input.evidence.sessionId,
    version: KNOWLEDGE_GROUNDING_VERSION
  });
}
