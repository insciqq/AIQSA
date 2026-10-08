/**
 * Client-safe contract of cross-model answer review (operator decisions
 * 2026-10-08). One or two reviewer models critique the latest answer with the
 * chat's tools and the answer's author model evaluates each finding and
 * writes a complete revised answer. Every step is an ordinary run of a user
 * turn the server writes (`MessageSystemTurnKind`); the transcript shows the
 * session's messages as one answer with a collapsible history.
 */

export const ANSWER_REVIEW_REQUEST_KIND = "answer_review_request";
export const ANSWER_REVISION_REQUEST_KIND = "answer_revision_request";
export const ANSWER_REVIEW_TURN_KINDS = [ANSWER_REVIEW_REQUEST_KIND, ANSWER_REVISION_REQUEST_KIND] as const;
export type AnswerReviewTurnKind = (typeof ANSWER_REVIEW_TURN_KINDS)[number];

export function isAnswerReviewTurnKind(value: unknown): value is AnswerReviewTurnKind {
  return value === ANSWER_REVIEW_REQUEST_KIND || value === ANSWER_REVISION_REQUEST_KIND;
}

/** Reviewers of one round, run one after another. */
export const ANSWER_REVIEW_MAX_REVIEWERS = 2;
/** Findings one review reports at most. */
export const ANSWER_REVIEW_MAX_FINDINGS = 10;
/** Bounds of the model-written fields of a review and of its decisions (code points). */
export const ANSWER_REVIEW_TEXT_LIMITS = Object.freeze({
  claim: 400,
  evidence: 800,
  findingId: 24,
  modelName: 160,
  problem: 800,
  reason: 400,
  suggestion: 800
});

export type AnswerReviewMode = "manual" | "auto";
export type AnswerReviewState = "running" | "finished" | "stopped";
export const ANSWER_REVIEW_STOP_REASONS = [
  "clean", "max_rounds", "disagreement", "budget", "approval_required", "user_stopped", "superseded",
  "review_unreadable", "error"
] as const;
export type AnswerReviewStopReason = (typeof ANSWER_REVIEW_STOP_REASONS)[number];
export type AnswerReviewStepKind = "review" | "revision";
export const ANSWER_REVIEW_SEVERITIES = ["critical", "high", "medium"] as const;
export type AnswerReviewSeverity = (typeof ANSWER_REVIEW_SEVERITIES)[number];
export type AnswerReviewVerdict = "clean" | "changes_needed";

/** One issue as its reviewer reported it; `repeatsFindingId` names an earlier rejected finding's key. */
export type AnswerReviewFinding = Readonly<{
  claim: string;
  evidence?: string;
  id: string;
  problem: string;
  repeatsFindingId?: string;
  severity: AnswerReviewSeverity;
  suggestion: string;
}>;

/**
 * One reviewer's review, as its `submit_answer_review` call left it. `round`,
 * `reviewer` (0-based, in the round's order) and `reviewerName` (the admitted
 * model's display name) are server-owned facts of the step.
 */
export type AnswerReviewCard = Readonly<{
  findings: readonly AnswerReviewFinding[];
  reviewer: number;
  reviewerName: string;
  round: number;
  verdict: AnswerReviewVerdict;
  version: 1;
}>;

/** The author's decision on one finding, by its key (`answerReviewFindingKey`). */
export type AnswerReviewDecision = Readonly<{
  decision: "accepted" | "rejected";
  findingId: string;
  reason: string;
}>;

/** The author's decisions of one round, as its `record_review_decisions` call left them. */
export type AnswerReviewDecisionsCard = Readonly<{
  decisions: readonly AnswerReviewDecision[];
  round: number;
  version: 1;
}>;

/** A frozen model reference with its display snapshot; `provider`/`modelId` are catalog identities. */
export type AnswerReviewModelWire = Readonly<{ modelId: string; name: string; provider: string }>;

/**
 * A session as the transcript shows it. `canAct` marks the initiator, who
 * alone starts its steps; others (Project members) see it read-only.
 */
export type AnswerReviewSessionWire = Readonly<{
  author: AnswerReviewModelWire;
  canAct?: true;
  id: string;
  maxRounds: number | null;
  mode: AnswerReviewMode;
  reviewers: readonly AnswerReviewModelWire[];
  round: number;
  sourceAssistantMessageId: string;
  state: AnswerReviewState;
  stopReason: AnswerReviewStopReason | null;
}>;

/** A step of a session: its turn's kind, round and ordinal, and the step model's display name. */
export type AnswerReviewStepWire = Readonly<{
  kind: AnswerReviewStepKind;
  modelName?: string;
  reviewer?: number;
  round: number;
  step: number;
}>;

/** What a message of a session carries: the session, and the step for a step's turn and answer. */
export type AnswerReviewMessageWire = Readonly<{
  session: AnswerReviewSessionWire;
  step?: AnswerReviewStepWire;
}>;

/** Starts a round on the chat's latest answer (`POST /api/chats/[chatId]/answer-reviews`). */
export type AnswerReviewStartRequest = Readonly<{
  answerMessageId: string;
  expectedActiveLeafId: string;
  reviewers: readonly Readonly<{ modelId: string; provider: string }>[];
}>;

/** Starts a session's next step (`POST /api/answer-reviews/[sessionId]/steps`); the response is the step's run. */
export type AnswerReviewStepRequest = Readonly<{
  admissionId: string;
  /** The chat's current controls (Search, MCP, Workspace, Knowledge, Skills, time zone), never prompt text or a model. */
  controls: Readonly<Record<string, unknown>>;
  expectedActiveLeafId: string;
  kind: AnswerReviewStepKind;
}>;

/** Refusals of the review routes and of a step's admission, beside the ordinary send refusals. */
export const ANSWER_REVIEW_REFUSALS = [
  "answer_review_invalid",
  "answer_review_unavailable",
  "answer_review_not_latest",
  "answer_review_assistant_unsupported",
  "answer_review_agent_unsupported",
  "answer_review_knowledge_unsupported",
  "answer_review_image_unsupported",
  "answer_review_model_unsupported",
  "answer_review_reviewer_unavailable",
  "answer_review_ended",
  "answer_review_step_unavailable"
] as const;
export type AnswerReviewRefusal = (typeof ANSWER_REVIEW_REFUSALS)[number];

const REFUSAL_COPY: Readonly<Record<AnswerReviewRefusal, string>> = {
  answer_review_agent_unsupported: "Review isn't available while Agent is on. Turn Agent off to review this answer.",
  answer_review_assistant_unsupported: "Review isn't available in Assistant chats yet: the Assistant fixes the model.",
  answer_review_ended: "This review has ended. Use Review… on the latest answer to start a new round.",
  answer_review_image_unsupported: "Answers with generated images can't be reviewed.",
  answer_review_invalid: "This review request is invalid.",
  answer_review_knowledge_unsupported: "Review isn't available with Knowledge: Knowledge answers stay bound to their sources.",
  answer_review_model_unsupported: "This answer's model can't use tools, so it can't take part in a review.",
  answer_review_not_latest: "Only the latest answer can be reviewed.",
  answer_review_reviewer_unavailable: "A chosen reviewer model is unavailable or can't use tools. Choose another one.",
  answer_review_step_unavailable: "This review step already ran or isn't next. Refresh the chat to see the review.",
  answer_review_unavailable: "This review is unavailable."
};

export function isAnswerReviewRefusal(value: unknown): value is AnswerReviewRefusal {
  return (ANSWER_REVIEW_REFUSALS as readonly unknown[]).includes(value);
}

/** User-facing text of a review refusal; null for other codes (the ordinary send copy applies). */
export function answerReviewRefusalCopy(code: string | null | undefined): string | null {
  return isAnswerReviewRefusal(code) ? REFUSAL_COPY[code] : null;
}

const STOP_COPY: Readonly<Record<AnswerReviewStopReason, string>> = {
  approval_required: "Stopped: a tool needs your approval",
  budget: "Stopped: usage limit reached",
  clean: "No substantive issues",
  disagreement: "Stopped: the reviewers repeat findings the author rejected",
  error: "Stopped: a step failed",
  max_rounds: "Finished all rounds",
  review_unreadable: "Stopped: the review could not be read",
  superseded: "Stopped: the chat moved on",
  user_stopped: "Stopped"
};

export function answerReviewStopCopy(reason: AnswerReviewStopReason): string {
  return STOP_COPY[reason];
}

/**
 * The key a finding is decided and referred to by across a session: its
 * round, its reviewer's position in that round and the reviewer's own id.
 */
export function answerReviewFindingKey(round: number, reviewer: number, findingId: string): string {
  return `R${round}.${reviewer + 1}.${findingId}`;
}

const FINDING_KEY = /^R[1-9]\d{0,3}\.[12]\.[A-Za-z0-9_-]{1,24}$/u;

export function isAnswerReviewFindingKey(value: unknown): value is string {
  return typeof value === "string" && FINDING_KEY.test(value);
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const findingId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,24}$/u.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 9_999;
const ordinal = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 9_999;

/** Bounded non-blank text without NUL; the bound counts code points. */
export function answerReviewText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= maximum && !value.includes("\0");
}

function decodeFinding(value: unknown): AnswerReviewFinding | null {
  if (!record(value) || !only(value, ["claim", "evidence", "id", "problem", "repeatsFindingId", "severity", "suggestion"]) ||
    !findingId(value.id) || !(ANSWER_REVIEW_SEVERITIES as readonly unknown[]).includes(value.severity) ||
    !answerReviewText(value.claim, ANSWER_REVIEW_TEXT_LIMITS.claim) ||
    !answerReviewText(value.problem, ANSWER_REVIEW_TEXT_LIMITS.problem) ||
    !answerReviewText(value.suggestion, ANSWER_REVIEW_TEXT_LIMITS.suggestion) ||
    (value.evidence !== undefined && !answerReviewText(value.evidence, ANSWER_REVIEW_TEXT_LIMITS.evidence)) ||
    (value.repeatsFindingId !== undefined && !isAnswerReviewFindingKey(value.repeatsFindingId))) return null;
  return {
    claim: value.claim,
    ...(value.evidence !== undefined ? { evidence: value.evidence as string } : {}),
    id: value.id,
    problem: value.problem,
    ...(value.repeatsFindingId !== undefined ? { repeatsFindingId: value.repeatsFindingId as string } : {}),
    severity: value.severity as AnswerReviewSeverity,
    suggestion: value.suggestion
  };
}

export function decodeAnswerReviewCard(value: unknown): AnswerReviewCard | null {
  if (!record(value) || !only(value, ["findings", "reviewer", "reviewerName", "round", "verdict", "version"]) ||
    value.version !== 1 || !positive(value.round) || (value.reviewer !== 0 && value.reviewer !== 1) ||
    !answerReviewText(value.reviewerName, ANSWER_REVIEW_TEXT_LIMITS.modelName) ||
    (value.verdict !== "clean" && value.verdict !== "changes_needed") ||
    !Array.isArray(value.findings) || value.findings.length > ANSWER_REVIEW_MAX_FINDINGS) return null;
  const findings: AnswerReviewFinding[] = [];
  for (const entry of value.findings) {
    const finding = decodeFinding(entry);
    if (!finding || findings.some((existing) => existing.id === finding.id)) return null;
    findings.push(finding);
  }
  // A clean review reports nothing to change; one that needs changes names them.
  if ((value.verdict === "clean") !== (findings.length === 0)) return null;
  return {
    findings, reviewer: value.reviewer, reviewerName: value.reviewerName, round: value.round,
    verdict: value.verdict, version: 1
  };
}

export function decodeAnswerReviewDecisionsCard(value: unknown): AnswerReviewDecisionsCard | null {
  if (!record(value) || !only(value, ["decisions", "round", "version"]) || value.version !== 1 || !positive(value.round) ||
    !Array.isArray(value.decisions) || value.decisions.length === 0 ||
    value.decisions.length > ANSWER_REVIEW_MAX_FINDINGS * ANSWER_REVIEW_MAX_REVIEWERS) return null;
  const decisions: AnswerReviewDecision[] = [];
  for (const entry of value.decisions) {
    if (!record(entry) || !only(entry, ["decision", "findingId", "reason"]) || !isAnswerReviewFindingKey(entry.findingId) ||
      (entry.decision !== "accepted" && entry.decision !== "rejected") ||
      !answerReviewText(entry.reason, ANSWER_REVIEW_TEXT_LIMITS.reason) ||
      decisions.some((existing) => existing.findingId === entry.findingId)) return null;
    decisions.push({ decision: entry.decision, findingId: entry.findingId, reason: entry.reason });
  }
  return { decisions, round: value.round, version: 1 };
}

/** A step answer's review: its first valid card (one `submit_answer_review` per step). */
export function foldAnswerReviewCards(payloads: readonly unknown[]): AnswerReviewCard[] {
  for (const payload of payloads) {
    const card = decodeAnswerReviewCard(payload);
    if (card) return [card];
  }
  return [];
}

/** A revision answer's decisions: its first valid card (one `record_review_decisions` per step). */
export function foldAnswerReviewDecisionsCards(payloads: readonly unknown[]): AnswerReviewDecisionsCard[] {
  for (const payload of payloads) {
    const card = decodeAnswerReviewDecisionsCard(payload);
    if (card) return [card];
  }
  return [];
}

function decodeModel(value: unknown): AnswerReviewModelWire | null {
  return record(value) && only(value, ["modelId", "name", "provider"]) && id(value.modelId) && id(value.provider) &&
    answerReviewText(value.name, ANSWER_REVIEW_TEXT_LIMITS.modelName)
    ? { modelId: value.modelId, name: value.name, provider: value.provider }
    : null;
}

const MODES: readonly unknown[] = ["manual", "auto"];
const STATES: readonly unknown[] = ["running", "finished", "stopped"];

export function decodeAnswerReviewSessionWire(value: unknown): AnswerReviewSessionWire | null {
  if (!record(value) || !only(value, ["author", "canAct", "id", "maxRounds", "mode", "reviewers", "round",
    "sourceAssistantMessageId", "state", "stopReason"]) || !id(value.id) || !id(value.sourceAssistantMessageId) ||
    !MODES.includes(value.mode) || !STATES.includes(value.state) || !positive(value.round) ||
    (value.maxRounds !== null && !positive(value.maxRounds)) ||
    (value.stopReason !== null && !(ANSWER_REVIEW_STOP_REASONS as readonly unknown[]).includes(value.stopReason)) ||
    ((value.state === "running") !== (value.stopReason === null)) ||
    (value.canAct !== undefined && value.canAct !== true) ||
    !Array.isArray(value.reviewers) || value.reviewers.length < 1 || value.reviewers.length > ANSWER_REVIEW_MAX_REVIEWERS) {
    return null;
  }
  const author = decodeModel(value.author);
  const reviewers = value.reviewers.map(decodeModel);
  if (!author || reviewers.some((reviewer) => reviewer === null)) return null;
  return {
    author,
    ...(value.canAct === true ? { canAct: true as const } : {}),
    id: value.id,
    maxRounds: value.maxRounds as number | null,
    mode: value.mode as AnswerReviewMode,
    reviewers: reviewers as AnswerReviewModelWire[],
    round: value.round,
    sourceAssistantMessageId: value.sourceAssistantMessageId,
    state: value.state as AnswerReviewState,
    stopReason: value.stopReason as AnswerReviewStopReason | null
  };
}

function decodeStep(value: unknown): AnswerReviewStepWire | null {
  if (!record(value) || !only(value, ["kind", "modelName", "reviewer", "round", "step"]) ||
    (value.kind !== "review" && value.kind !== "revision") || !positive(value.round) || !ordinal(value.step) ||
    (value.modelName !== undefined && !answerReviewText(value.modelName, ANSWER_REVIEW_TEXT_LIMITS.modelName)) ||
    // A review names its reviewer's position; a revision has none.
    (value.kind === "review" ? value.reviewer !== 0 && value.reviewer !== 1 : value.reviewer !== undefined)) return null;
  return {
    kind: value.kind,
    ...(value.modelName !== undefined ? { modelName: value.modelName as string } : {}),
    ...(value.kind === "review" ? { reviewer: value.reviewer as number } : {}),
    round: value.round,
    step: value.step
  };
}

export function decodeAnswerReviewMessageWire(value: unknown): AnswerReviewMessageWire | null {
  if (!record(value) || !only(value, ["session", "step"])) return null;
  const session = decodeAnswerReviewSessionWire(value.session);
  const step = value.step === undefined ? undefined : decodeStep(value.step);
  if (!session || step === null) return null;
  return { session, ...(step ? { step } : {}) };
}

export function decodeAnswerReviewStartResponse(value: unknown): AnswerReviewSessionWire | null {
  return record(value) && only(value, ["session"]) ? decodeAnswerReviewSessionWire(value.session) : null;
}
