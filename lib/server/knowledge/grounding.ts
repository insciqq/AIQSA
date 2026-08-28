import { createHash } from "node:crypto";
import { decodeKnowledgeCitationHandle } from "../../contracts/knowledge";
import {
  knowledgeEvidenceReceiptHash,
  type KnowledgeEvidencePackage
} from "./evidencePackage";

export const KNOWLEDGE_GROUNDING_VERSION = 6 as const;

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
const formatExtractive = "AIQSA_KB_FORMAT=EXTRACTIVE_V1";
const formatMarkdown = "AIQSA_KB_FORMAT=MARKDOWN";
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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    expected.every((key, index) => actual[index] === key);
}

/**
 * Decodes the provider-selected extractive envelope without assessing meaning.
 * Every rendered claim is copied from one immutable cited excerpt; the server
 * neither paraphrases it nor decides whether it answers the user's question.
 */
function decodeKnowledgeAnswerBody(input: Readonly<{
  body: string;
  evidence: KnowledgeEvidencePackage;
  requireBodyFormat: boolean;
  status: typeof statusAnswered | typeof statusInsufficient;
}>): string {
  const newline = input.body.indexOf("\n");
  const format = newline < 0 ? input.body : input.body.slice(0, newline);
  if (format !== formatExtractive && format !== formatMarkdown) {
    if (input.requireBodyFormat || format.startsWith("AIQSA_KB_FORMAT=")) {
      throw new KnowledgeAnswerContractError(
        "knowledge_answer_contract_failed",
        input.requireBodyFormat
          ? "The Knowledge answer omitted the required body format"
          : "The Knowledge answer returned an unknown body format"
      );
    }
    return input.body;
  }
  const payload = newline < 0 ? "" : input.body.slice(newline + 1);
  if (!payload.trim()) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The Knowledge answer body format payload is empty"
    );
  }
  if (format === formatMarkdown) return payload;
  if (input.status !== statusAnswered || payload.includes("\n") || payload.trim() !== payload) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The extractive Knowledge answer envelope is invalid"
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The extractive Knowledge answer envelope is invalid"
    );
  }
  if (!record(decoded) || !exactKeys(decoded, ["claims", "version"]) ||
    decoded.version !== 1 || !Array.isArray(decoded.claims) ||
    decoded.claims.length < 1 || decoded.claims.length > 64) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The extractive Knowledge answer envelope is invalid"
    );
  }
  const items = new Map(input.evidence.items.flatMap((item) =>
    item.state === "available" && item.excerpt !== null ? [[item.handle, item] as const] : []));
  const seen = new Set<string>();
  const rendered: string[] = [];
  for (const value of decoded.claims) {
    if (!record(value) || !exactKeys(value, ["handle", "quote"]) ||
      typeof value.handle !== "string" ||
      !/^K[1-9]\d{0,3}(?:\.[1-9]\d?)?$/u.test(value.handle) ||
      typeof value.quote !== "string" || value.quote.length < 1 || value.quote.length > 4_096 ||
      value.quote.trim() !== value.quote || /[\r\n]/u.test(value.quote) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value.quote) ||
      /(?:\[[Kk][1-9]\d{0,3}|【[Kk][1-9]\d{0,3}|cite||)/u.test(value.quote)) {
      throw new KnowledgeAnswerContractError(
        "knowledge_answer_contract_failed",
        "The extractive Knowledge answer claim is invalid"
      );
    }
    const item = items.get(value.handle);
    const identity = `${value.handle}\u0000${value.quote}`;
    if (!item?.excerpt?.includes(value.quote) || seen.has(identity)) {
      throw new KnowledgeAnswerContractError(
        "knowledge_answer_contract_failed",
        "The extractive Knowledge answer claim is not an exact cited excerpt span"
      );
    }
    seen.add(identity);
    rendered.push(`- ${value.quote} [${value.handle}]`);
  }
  return rendered.join("\n");
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
 * final-manifest handles. For an extractive envelope it also verifies that
 * each provider-selected claim is a literal span of its cited immutable
 * excerpt and renders only those spans. It never scores prose, guesses semantic
 * support, calls a model, retries, or paraphrases answer content.
 */
export function groundKnowledgeAnswer(input: Readonly<{
  answer: string;
  evidence: KnowledgeEvidencePackage;
  requireBodyFormat?: boolean;
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
  const decodedBody = decodeKnowledgeAnswerBody({
    body,
    evidence: input.evidence,
    requireBodyFormat: input.requireBodyFormat === true,
    status
  });
  const normalizedBody = normalizeCitationSyntax(decodedBody, availableHandles);
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
