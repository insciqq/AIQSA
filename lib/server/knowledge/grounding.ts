import { createHash } from "node:crypto";
import { decodeKnowledgeCitationHandle } from "../../contracts/knowledge";
import {
  knowledgeEvidenceReceiptHash,
  type KnowledgeEvidencePackage
} from "./evidencePackage";
import {
  KNOWLEDGE_ANSWER_DRAFT_CONTRACT_VERSION,
  KNOWLEDGE_GROUNDED_SELECTOR_CONTRACT_VERSION,
  type KnowledgeAnswerFallbackReason,
  type KnowledgeAnswerSettlementV5
} from "./answerGroundingV5";
import type { KnowledgeProviderAttemptUsage } from "./evidenceDispatchRepository";

export const KNOWLEDGE_GROUNDING_VERSION = 5 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION = 7 as const;

export type LegacyKnowledgeGroundingResult = Readonly<{
  finalAnswerHash: string;
  finalText: string;
  originalAnswerHash: string;
  outcome: "answered" | "insufficient_evidence";
  receiptHash: string;
  sessionId: string;
  version: typeof KNOWLEDGE_GROUNDING_VERSION;
}>;

export type KnowledgeGroundingEvidenceV7 = Readonly<{
  contradictedClaimCount: number;
  draftClaimCount: number;
  draftContractVersion: typeof KNOWLEDGE_ANSWER_DRAFT_CONTRACT_VERSION;
  draftHash: string;
  draftOperationId: string;
  durations: Readonly<{
    draftMs: number;
    selectorMs: number;
  }>;
  evidenceReceiptHash: string;
  fallbackReason: KnowledgeAnswerFallbackReason | null;
  finalAnswerHash: string;
  finalText: string;
  finalizationMode: KnowledgeAnswerSettlementV5["finalizationMode"];
  groundingStatus: KnowledgeAnswerSettlementV5["groundingStatus"];
  originalAnswerHash: string;
  outcome: KnowledgeAnswerSettlementV5["outcome"];
  providerRequestIds: Readonly<{
    draft: string | null;
    selector: string | null;
  }>;
  receiptHash: string;
  requestCoverage: KnowledgeAnswerSettlementV5["requestCoverage"];
  selectorContractVersion: typeof KNOWLEDGE_GROUNDED_SELECTOR_CONTRACT_VERSION;
  selectorHash: string;
  selectorOperationId: string;
  sessionId: string;
  supportedClaimCount: number;
  unsupportedClaimCount: number;
  usage: Readonly<{
    draft: KnowledgeProviderAttemptUsage;
    selector: KnowledgeProviderAttemptUsage;
  }>;
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION;
}>;

export type KnowledgeGroundingResult =
  | LegacyKnowledgeGroundingResult
  | KnowledgeGroundingEvidenceV7;

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
const bracketedKnowledgeCandidate = /[\[【]\s*([Kk][0-9][^\]】]{0,63})\s*[\]】]/gu;
const knowledgeCitationPrefix = /^[Kk][0-9]+(?:\.[0-9]+)?(?=$|[^\p{L}\p{M}\p{N}_])/u;
const adjacentDuplicate = /(\[K[1-9]\d{0,3}(?:\.[1-9]\d?)?\])(?:\s*\1)+/giu;
const commaGroupedCitation = /\[\s*(K[1-9]\d{0,3}(?:\.[1-9]\d?)?(?:\s*,\s*K[1-9]\d{0,3}(?:\.[1-9]\d?)?)+)\s*\]/giu;
const fullWidthCitation = /【\s*(K[1-9]\d{0,3}(?:\.[1-9]\d?)?)\s*】/giu;
const providerWrappedCitation = /cite([\s\S]{0,1024}?)/giu;
const providerWrappedHandle = /^(K[1-9]\d{0,3}(?:\.[1-9]\d?)?)/iu;
const providerWrappedBracketedHandle = /^\[\s*(K[1-9]\d{0,3}(?:\.[1-9]\d?)?)\s*\]/iu;
const providerWrappedFullWidthHandle = /^【\s*(K[1-9]\d{0,3}(?:\.[1-9]\d?)?)\s*】/iu;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validOperationId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$/u.test(value);
}

function validDuration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 24 * 60 * 60 * 1_000;
}

/** Content-free V7 evidence for the server-settled Draft V5 / Selector V3 path. */
export function groundSettledKnowledgeAnswerV5(input: Readonly<{
  draft: Readonly<{
    claimCount: number;
    durationMs: number;
    hash: string;
    operationId: string;
    providerRequestId: string | null;
    usage: KnowledgeProviderAttemptUsage;
  }>;
  evidence: KnowledgeEvidencePackage;
  evidenceReceiptHash: string;
  selector: Readonly<{
    durationMs: number;
    hash: string;
    operationId: string;
    providerRequestId: string | null;
    usage: KnowledgeProviderAttemptUsage;
  }>;
  settlement: KnowledgeAnswerSettlementV5;
}>): KnowledgeGroundingEvidenceV7 {
  const receiptHash = knowledgeEvidenceReceiptHash(input.evidence);
  if (!validOperationId(input.draft.operationId) ||
    !validOperationId(input.selector.operationId) ||
    !/^[0-9a-f]{64}$/u.test(input.draft.hash) ||
    !/^[0-9a-f]{64}$/u.test(input.selector.hash) ||
    !validDuration(input.draft.durationMs) || !validDuration(input.selector.durationMs) ||
    !Number.isSafeInteger(input.draft.claimCount) || input.draft.claimCount < 0 ||
    input.draft.claimCount > 24 || !/^[0-9a-f]{64}$/u.test(input.evidenceReceiptHash)) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted Knowledge grounding operation evidence is invalid"
    );
  }
  return Object.freeze({
    contradictedClaimCount: input.settlement.contradictedClaimCount,
    draftClaimCount: input.draft.claimCount,
    draftContractVersion: KNOWLEDGE_ANSWER_DRAFT_CONTRACT_VERSION,
    draftHash: input.draft.hash,
    draftOperationId: input.draft.operationId,
    durations: Object.freeze({
      draftMs: input.draft.durationMs,
      selectorMs: input.selector.durationMs
    }),
    evidenceReceiptHash: input.evidenceReceiptHash,
    fallbackReason: input.settlement.fallbackReason,
    finalAnswerHash: hash(input.settlement.finalText),
    finalText: input.settlement.finalText,
    finalizationMode: input.settlement.finalizationMode,
    groundingStatus: input.settlement.groundingStatus,
    originalAnswerHash: input.draft.hash,
    outcome: input.settlement.outcome,
    providerRequestIds: Object.freeze({
      draft: input.draft.providerRequestId,
      selector: input.selector.providerRequestId
    }),
    receiptHash,
    requestCoverage: input.settlement.requestCoverage,
    selectorContractVersion: KNOWLEDGE_GROUNDED_SELECTOR_CONTRACT_VERSION,
    selectorHash: input.selector.hash,
    selectorOperationId: input.selector.operationId,
    sessionId: input.evidence.sessionId,
    supportedClaimCount: input.settlement.supportedClaimCount,
    unsupportedClaimCount: input.settlement.unsupportedClaimCount,
    usage: Object.freeze({
      draft: input.draft.usage,
      selector: input.selector.usage
    }),
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION
  });
}

function normalizeToolLoopCitationSyntax(
  value: string,
  availableHandles: ReadonlySet<string>
): string {
  return normalizeProviderWrappedCitations(value, availableHandles)
    .replace(commaGroupedCitation, (match, body: string) => {
      const handles = body.split(",").map((handle) => handle.trim().toUpperCase());
      return handles.every((handle) => availableHandles.has(handle))
        ? handles.map((handle) => `[${handle}]`).join("")
        : match;
    })
    .replace(fullWidthCitation, (match, handle: string) => {
      const normalized = handle.toUpperCase();
      return availableHandles.has(normalized) ? `[${normalized}]` : match;
    })
    .replace(adjacentDuplicate, "$1");
}

function normalizeProviderWrappedCitations(
  value: string,
  availableHandles: ReadonlySet<string>
): string {
  const normalized = value.replace(providerWrappedCitation, (_match, rawBody: string) => {
    let body = rawBody.trim();
    const handles: string[] = [];
    while (body.trim().length > 0) {
      const prefix = handles.length === 0
        ? /^\s*/u.exec(body)
        : /^(?:\s*\s*|\s*(?:[,;&/+]|and\b|и\b)\s*(?:\s*)?|\s+)/iu.exec(body);
      if (!prefix) {
        throw new KnowledgeAnswerContractError(
          "knowledge_citation_contract_failed",
          "The provider returned a malformed citation wrapper"
        );
      }
      body = body.slice(prefix[0].length);
      const handleMatch = providerWrappedBracketedHandle.exec(body) ??
        providerWrappedFullWidthHandle.exec(body) ?? providerWrappedHandle.exec(body);
      const handle = handleMatch?.[1]?.toUpperCase();
      if (!handleMatch || !handle) {
        throw new KnowledgeAnswerContractError(
          "knowledge_citation_contract_failed",
          "The provider returned a malformed citation wrapper"
        );
      }
      handles.push(handle);
      body = body.slice(handleMatch[0].length);
    }
    if (handles.length < 1 || handles.some((handle) => !availableHandles.has(handle))) {
      throw new KnowledgeAnswerContractError(
        "knowledge_citation_contract_failed",
        "The provider citation wrapper referenced evidence outside the final manifest"
      );
    }
    return handles.map((handle) => `[${handle}]`).join("");
  });
  if (normalized.includes("cite") || normalized.includes("") ||
    normalized.includes("")) {
    throw new KnowledgeAnswerContractError(
      "knowledge_citation_contract_failed",
      "The provider returned a malformed citation wrapper"
    );
  }
  return normalized;
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

function normalizeCitationSyntax(
  value: string,
  availableHandles: ReadonlySet<string>
): string {
  const wrapped = normalizeProviderWrappedCitations(value, availableHandles);
  const grouped = wrapped.replace(groupedCitation, (match, body: string) => {
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
  for (const match of answer.matchAll(bracketedKnowledgeCandidate)) {
    const candidate = match[1]?.trim() ?? "";
    if (!knowledgeCitationPrefix.test(candidate)) continue;
    const raw = candidate.toUpperCase();
    const decoded = decodeKnowledgeCitationHandle(raw);
    if (!decoded || !availableHandles.has(raw)) {
      throw new KnowledgeAnswerContractError(
        "knowledge_citation_contract_failed",
        "The Knowledge answer cited a handle outside the final evidence manifest"
      );
    }
    seen.push(raw);
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
  if (!body.trim() || containsEvidenceInternalIdentity(body, input.evidence)) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      !body.trim()
        ? "The Knowledge answer body is empty"
        : "The Knowledge answer leaked an internal identity"
    );
  }
  const availableHandles = new Set(
    input.evidence.items
      .filter((item) => item.state === "available" && item.excerpt !== null)
      .map((item) => item.handle)
  );
  const normalizedBody = normalizeCitationSyntax(body, availableHandles);
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
  if (!original.trim() || containsEvidenceInternalIdentity(original, input.evidence)) {
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
