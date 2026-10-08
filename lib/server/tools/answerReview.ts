import {
  ANSWER_REVIEW_MAX_FINDINGS,
  ANSWER_REVIEW_MAX_REVIEWERS,
  ANSWER_REVIEW_SEVERITIES,
  ANSWER_REVIEW_TEXT_LIMITS,
  answerReviewText,
  isAnswerReviewFindingKey,
  type AnswerReviewCard,
  type AnswerReviewDecision,
  type AnswerReviewDecisionsCard,
  type AnswerReviewFinding,
  type AnswerReviewSeverity
} from "../../contracts/answerReviews";
import type { ModelToolCall, RunTool, ToolExecutionResult } from "./types";

/**
 * The two built-in tools of an answer review step, offered only by the
 * server-owned admission marker of a step's run (`NormalizedRunRequest
 * .answerReviewStep`, frozen from the step a session admitted, never from a
 * request field). A reviewer reports its review through `submit_answer_review`;
 * the author records its decisions on the round's findings through
 * `record_review_decisions`. Neither performs external I/O or changes anything
 * another call reads (the `session` class): the call's settled result and its
 * card are the record. The step's first call of its tool is reserved outside
 * the business tool budgets, like a monitoring verdict.
 */
export const SUBMIT_ANSWER_REVIEW_TOOL_NAME = "submit_answer_review";
export const RECORD_REVIEW_DECISIONS_TOOL_NAME = "record_review_decisions";

/** Finding keys a step's marker names: every finding of two reviews, or earlier rejected ones. */
const MARKER_KEYS_LIMIT = 64;

/** A step of an answer review session as its run was admitted. */
export type AnswerReviewStepMarker = Readonly<{
  /** Revision: the keys of the round's findings its decisions cover. */
  findingKeys?: readonly string[];
  kind: "review" | "revision";
  /** The admitted model's display name, for its card and the transcript. */
  modelName: string;
  /** Review: keys of findings the author rejected earlier, which `repeatsFindingId` may name. */
  rejectedKeys?: readonly string[];
  /** Review: the reviewer's position in the round. */
  reviewer?: number;
  round: number;
  sessionId: string;
  step: number;
  version: 1;
}>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keyList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.length <= MARKER_KEYS_LIMIT && value.every(isAnswerReviewFindingKey) &&
  new Set(value).size === value.length;

export function isAnswerReviewStepMarker(value: unknown): value is AnswerReviewStepMarker {
  if (!record(value) || !Object.keys(value).every((key) =>
    ["findingKeys", "kind", "modelName", "rejectedKeys", "reviewer", "round", "sessionId", "step", "version"].includes(key))) {
    return false;
  }
  const review = value.kind === "review";
  return value.version === 1 && (review || value.kind === "revision") &&
    typeof value.sessionId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.sessionId) &&
    Number.isSafeInteger(value.round) && (value.round as number) >= 1 &&
    Number.isSafeInteger(value.step) && (value.step as number) >= 0 && (value.step as number) <= ANSWER_REVIEW_MAX_REVIEWERS &&
    answerReviewText(value.modelName, ANSWER_REVIEW_TEXT_LIMITS.modelName) &&
    (review
      ? (value.reviewer === 0 || value.reviewer === 1) && value.step === value.reviewer && value.findingKeys === undefined &&
        (value.rejectedKeys === undefined || keyList(value.rejectedKeys))
      : value.reviewer === undefined && value.rejectedKeys === undefined && value.step !== 0 &&
        keyList(value.findingKeys) && (value.findingKeys as readonly string[]).length > 0);
}

type AnswerReviewRequest = Readonly<{ answerReviewStep?: unknown }>;

function nullableText(maximum: number): Record<string, unknown> {
  return { maxLength: maximum, type: ["string", "null"] };
}

export const submitAnswerReviewTool: RunTool = {
  capability: "session",
  description: [
    "Report your review of the previous answer to the user's question. Call it exactly once, after any checks, before",
    "your short final reply. verdict \"clean\" with no findings when nothing substantive needs to change; otherwise",
    "\"changes_needed\" with each issue that affects correctness, completeness for the question, safety or the user's",
    "goal (never style or minor wording). claim quotes or paraphrases the answer's statement, problem says what is wrong,",
    "suggestion what to change; evidence (or null) names what you checked. repeatsFindingId is null unless the finding",
    "repeats one the author already rejected, with new evidence: then that finding's key."
  ].join(" "),
  inputSchema: {
    additionalProperties: false,
    properties: {
      findings: {
        items: {
          additionalProperties: false,
          properties: {
            claim: { maxLength: ANSWER_REVIEW_TEXT_LIMITS.claim, type: "string" },
            evidence: nullableText(ANSWER_REVIEW_TEXT_LIMITS.evidence),
            id: { description: "A short id unique in this review, e.g. F1.", maxLength: ANSWER_REVIEW_TEXT_LIMITS.findingId,
              type: "string" },
            problem: { maxLength: ANSWER_REVIEW_TEXT_LIMITS.problem, type: "string" },
            repeatsFindingId: nullableText(64),
            severity: { enum: [...ANSWER_REVIEW_SEVERITIES], type: "string" },
            suggestion: { maxLength: ANSWER_REVIEW_TEXT_LIMITS.suggestion, type: "string" }
          },
          required: ["id", "severity", "claim", "problem", "suggestion", "evidence", "repeatsFindingId"],
          type: "object"
        },
        maxItems: ANSWER_REVIEW_MAX_FINDINGS,
        type: "array"
      },
      verdict: { enum: ["clean", "changes_needed"], type: "string" }
    },
    required: ["verdict", "findings"],
    type: "object"
  },
  name: SUBMIT_ANSWER_REVIEW_TOOL_NAME,
  strict: true
};

export const recordReviewDecisionsTool: RunTool = {
  capability: "session",
  description: [
    "Record your decision on every review finding of this round, by its key, before you write the revised answer.",
    "Call it exactly once. \"accepted\" when the finding is right and you change the answer for it; \"rejected\" when it is",
    "wrong or not worth changing. reason says why, briefly."
  ].join(" "),
  inputSchema: {
    additionalProperties: false,
    properties: {
      decisions: {
        items: {
          additionalProperties: false,
          properties: {
            decision: { enum: ["accepted", "rejected"], type: "string" },
            findingId: { description: "The finding's key, e.g. R1.1.F1.", maxLength: 64, type: "string" },
            reason: { maxLength: ANSWER_REVIEW_TEXT_LIMITS.reason, type: "string" }
          },
          required: ["findingId", "decision", "reason"],
          type: "object"
        },
        maxItems: ANSWER_REVIEW_MAX_FINDINGS * ANSWER_REVIEW_MAX_REVIEWERS,
        type: "array"
      }
    },
    required: ["decisions"],
    type: "object"
  },
  name: RECORD_REVIEW_DECISIONS_TOOL_NAME,
  strict: true
};

function marker(request: AnswerReviewRequest): AnswerReviewStepMarker | null {
  return isAnswerReviewStepMarker(request.answerReviewStep) ? request.answerReviewStep : null;
}

/** The step's tool its run admitted, or none. Execution and recovery list the same tool. */
export function answerReviewToolsForRequest(request: AnswerReviewRequest): RunTool[] {
  const step = marker(request);
  return !step ? [] : step.kind === "review" ? [submitAnswerReviewTool] : [recordReviewDecisionsTool];
}

/** The name of the step's tool, reserved outside the business tool budgets; null without a step. */
export function answerReviewToolName(request: AnswerReviewRequest): string | null {
  const step = marker(request);
  return !step ? null : step.kind === "review" ? SUBMIT_ANSWER_REVIEW_TOOL_NAME : RECORD_REVIEW_DECISIONS_TOOL_NAME;
}

/** Whether a call of an accepted run is its step's review tool. */
export function isAnswerReviewCall(request: AnswerReviewRequest, toolName: string): boolean {
  const name = answerReviewToolName(request);
  return name !== null && name === toolName;
}

/** The ephemeral last provider message of a round that offers only the reserved review tool. */
export function answerReviewReservedInstruction(toolName: string): string {
  return `The tool budget for this step is used up except for one call reserved for ${toolName}. Call ${toolName} ` +
    "now with what the results already obtained show, and no other tool, then finish.";
}

function result(call: ModelToolCall, status: ToolExecutionResult["status"], content: ToolExecutionResult["content"],
  artifacts?: ToolExecutionResult["artifacts"]): ToolExecutionResult {
  return { ...(artifacts ? { artifacts } : {}), callId: call.id, content, name: call.name, status };
}

function refusal(call: ModelToolCall, text: string): ToolExecutionResult {
  return result(call, "error", [{ text, type: "text" }]);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

/** `null` and absent are the same for the optional fields strict providers send as null. */
function optionalText(value: unknown, maximum: number): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return answerReviewText(value, maximum) ? value : null;
}

function reviewFindings(call: ModelToolCall, step: AnswerReviewStepMarker): AnswerReviewFinding[] | string {
  const findings = call.arguments.findings;
  if (!Array.isArray(findings) || findings.length > ANSWER_REVIEW_MAX_FINDINGS) {
    return `findings is a list of at most ${ANSWER_REVIEW_MAX_FINDINGS} issues.`;
  }
  const rejected = new Set(step.rejectedKeys ?? []);
  const decoded: AnswerReviewFinding[] = [];
  for (const [index, entry] of findings.entries()) {
    const at = `Finding ${index + 1}`;
    if (!record(entry) || !Object.keys(entry).every((key) =>
      ["claim", "evidence", "id", "problem", "repeatsFindingId", "severity", "suggestion"].includes(key))) {
      return `${at} has unknown fields.`;
    }
    if (typeof entry.id !== "string" || !/^[A-Za-z0-9_-]{1,24}$/u.test(entry.id) ||
      decoded.some((finding) => finding.id === entry.id)) {
      return `${at} needs a unique id of letters, digits, "_" or "-" (at most 24).`;
    }
    if (!(ANSWER_REVIEW_SEVERITIES as readonly unknown[]).includes(entry.severity)) {
      return `${at}: severity is critical, high or medium.`;
    }
    if (!answerReviewText(entry.claim, ANSWER_REVIEW_TEXT_LIMITS.claim) ||
      !answerReviewText(entry.problem, ANSWER_REVIEW_TEXT_LIMITS.problem) ||
      !answerReviewText(entry.suggestion, ANSWER_REVIEW_TEXT_LIMITS.suggestion)) {
      return `${at}: claim, problem and suggestion are required text within ${ANSWER_REVIEW_TEXT_LIMITS.claim}, ` +
        `${ANSWER_REVIEW_TEXT_LIMITS.problem} and ${ANSWER_REVIEW_TEXT_LIMITS.suggestion} characters.`;
    }
    const evidence = optionalText(entry.evidence, ANSWER_REVIEW_TEXT_LIMITS.evidence);
    if (evidence === null) return `${at}: evidence is null or text within ${ANSWER_REVIEW_TEXT_LIMITS.evidence} characters.`;
    const repeats = entry.repeatsFindingId === undefined || entry.repeatsFindingId === null ? undefined : entry.repeatsFindingId;
    if (repeats !== undefined && (typeof repeats !== "string" || !rejected.has(repeats))) {
      return `${at}: repeatsFindingId is null or the key of a finding the author rejected earlier.`;
    }
    decoded.push({
      claim: entry.claim,
      ...(evidence !== undefined ? { evidence } : {}),
      id: entry.id,
      problem: entry.problem,
      ...(repeats !== undefined ? { repeatsFindingId: repeats } : {}),
      severity: entry.severity as AnswerReviewSeverity,
      suggestion: entry.suggestion
    });
  }
  return decoded;
}

function reviewDecisions(call: ModelToolCall, step: AnswerReviewStepMarker): AnswerReviewDecision[] | string {
  const keys = step.findingKeys ?? [];
  const decisions = call.arguments.decisions;
  if (!Array.isArray(decisions)) return "decisions is a list with one decision per finding key.";
  const decoded: AnswerReviewDecision[] = [];
  for (const [index, entry] of decisions.entries()) {
    const at = `Decision ${index + 1}`;
    if (!record(entry) || !exactKeys(entry, ["decision", "findingId", "reason"])) {
      return `${at} takes findingId, decision and reason.`;
    }
    if (typeof entry.findingId !== "string" || !keys.includes(entry.findingId)) {
      return `${at}: findingId is one of ${keys.join(", ")}.`;
    }
    if (decoded.some((decision) => decision.findingId === entry.findingId)) return `${at} repeats ${entry.findingId}.`;
    if (entry.decision !== "accepted" && entry.decision !== "rejected") return `${at}: decision is accepted or rejected.`;
    if (!answerReviewText(entry.reason, ANSWER_REVIEW_TEXT_LIMITS.reason)) {
      return `${at}: reason is required text within ${ANSWER_REVIEW_TEXT_LIMITS.reason} characters.`;
    }
    decoded.push({ decision: entry.decision, findingId: entry.findingId, reason: entry.reason });
  }
  const missing = keys.filter((key) => !decoded.some((decision) => decision.findingId === key));
  return missing.length > 0 ? `Decide every finding; missing: ${missing.join(", ")}.` : decoded;
}

/**
 * Validates one call of the step's tool and returns its card. An invalid
 * call is a tool error the model sees and may correct. After a call of the
 * step settled with its card (`submitted`), another one is refused: the step
 * reports once. Executing the same call again gives the same card, so a
 * recovered call cannot change or duplicate anything.
 */
export function executeAnswerReviewCall(
  call: ModelToolCall,
  request: AnswerReviewRequest,
  options: Readonly<{ submitted: boolean }>
): ToolExecutionResult {
  const step = marker(request);
  if (!step || !isAnswerReviewCall(request, call.name)) return refusal(call, "This tool is not part of this step.");
  if (options.submitted) {
    return refusal(call, `${call.name} was already called for this step. Do not call it again; finish your reply.`);
  }
  if (step.kind === "review") {
    if (!exactKeys(call.arguments, ["findings", "verdict"])) {
      return refusal(call, `${SUBMIT_ANSWER_REVIEW_TOOL_NAME} takes verdict and findings.`);
    }
    const verdict = call.arguments.verdict;
    if (verdict !== "clean" && verdict !== "changes_needed") return refusal(call, "verdict is clean or changes_needed.");
    const findings = reviewFindings(call, step);
    if (typeof findings === "string") return refusal(call, findings);
    if (verdict === "clean" && findings.length > 0) return refusal(call, "A clean review reports no findings.");
    if (verdict === "changes_needed" && findings.length === 0) return refusal(call, "changes_needed needs at least one finding.");
    const card: AnswerReviewCard = {
      findings, reviewer: step.reviewer ?? 0, reviewerName: step.modelName, round: step.round, verdict, version: 1
    };
    return result(call, "complete", [{ type: "json", value: { findings: findings.length, recorded: true, verdict } }],
      [{ data: { artifactType: "answer_review", payload: card }, type: "artifact" }]);
  }
  if (!exactKeys(call.arguments, ["decisions"])) return refusal(call, `${RECORD_REVIEW_DECISIONS_TOOL_NAME} takes decisions.`);
  const decisions = reviewDecisions(call, step);
  if (typeof decisions === "string") return refusal(call, decisions);
  const card: AnswerReviewDecisionsCard = { decisions, round: step.round, version: 1 };
  return result(call, "complete", [{ type: "json", value: { decisions: decisions.length, recorded: true } }],
    [{ data: { artifactType: "answer_review_decisions", payload: card }, type: "artifact" }]);
}

/** Whether a persisted call of the run settled its step's report (its result holds the card). */
export function answerReviewCallSubmitted(
  request: AnswerReviewRequest,
  call: Readonly<{ result?: unknown; state?: string; toolName: string }>
): boolean {
  if (!isAnswerReviewCall(request, call.toolName) || call.state !== "complete" || !record(call.result)) return false;
  const artifacts = call.result.artifacts;
  return Array.isArray(artifacts) && artifacts.some((artifact) => record(artifact) && record(artifact.data) &&
    (artifact.data.artifactType === "answer_review" || artifact.data.artifactType === "answer_review_decisions"));
}
