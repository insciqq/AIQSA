import type { PrismaClient } from "@prisma/client";
import {
  ANSWER_REVIEW_REQUEST_KIND,
  ANSWER_REVISION_REQUEST_KIND,
  answerReviewFindingKey,
  type AnswerReviewCard,
  type AnswerReviewStepKind,
  type AnswerReviewStopReason
} from "../../contracts/answerReviews";
import { answerReviewProgress, type AnswerReviewProgress } from "../../domain/answerReviewProgress";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { activeRunControllerRegistry } from "../runs/activeRunControllerRegistry";
import { createSendMessageHandler, type RunHandlerDeps } from "../runs/handlers";
import type { AnswerReviewStepPreparation } from "../runs/runPreparation";
import { answerReviewRequestText, answerRevisionRequestText } from "./prompts";
import {
  loadAnswerReviewSessionSnapshot,
  rejectedAnswerReviewFindings,
  settleAnswerReviewSession,
  type AnswerReviewSessionSnapshot
} from "./repository";

/**
 * The one way a review step starts, for the manual routes now and the
 * automatic driver later: as the session's initiator, through the ordinary
 * send handler, with a turn the server writes, the step's model and the
 * chat's current controls. The step's admission claims (session, round,
 * step) in the transaction that creates its turn, so a step never runs twice.
 */

export type AnswerReviewStepStartDeps = Readonly<{
  prisma: PrismaClient;
  /** The ordinary send services; the step adds who sends and which step. */
  sendDeps: Omit<RunHandlerDeps, "answerReviewStep" | "resolveAuth" | "scheduledOccurrence">;
}>;

export type AnswerReviewStepStartInput = Readonly<{
  /** The send's invocation identity: a lost response retried with it never admits a second run. */
  admissionId: string;
  /**
   * The chat's current controls: Search (reconciled to the step's model),
   * MCP, Workspace, Knowledge, Skills and the time zone. Prompt text, models,
   * params and drafts are never taken from here.
   */
  controls: Readonly<Record<string, unknown>>;
  /** The session's last message, which the step appends to. */
  expectedActiveLeafId: string;
  /** The step the caller means to start; it must be the session's next one. */
  kind: AnswerReviewStepKind;
  /** Resolves the initiator again on every call, so authority lost mid-admission refuses the step. */
  resolveAuth: RequestAuthResolver;
  sessionId: string;
  userId: string;
}>;

export type AnswerReviewStepStart =
  | Readonly<{ assistantMessageId: string; ok: true; response: Response; runId: string; userMessageId: string }>
  /** No run started: the response explains why; `stopped` is set when the refusal ended the session. */
  | Readonly<{ code: string; ok: false; response: Response; stopped?: AnswerReviewStopReason }>;

/** The control keys a step takes from the chat; everything else in a send body is the server's. */
const STEP_CONTROL_KEYS = [
  "agentEnabled", "knowledgePlan", "mcp", "searchPlan", "searchPreferencePlan", "searchPreferenceSource", "skillIds",
  "skills", "timeZone", "tools", "workspace"
] as const;

export function answerReviewStepControls(controls: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(STEP_CONTROL_KEYS.flatMap((key) => Object.hasOwn(controls, key) ? [[key, controls[key]]] : []));
}

function refusal(code: string, status: number, stopped?: AnswerReviewStopReason): AnswerReviewStepStart {
  return { code, ok: false, response: Response.json({ error: code }, { headers: { "cache-control": "no-store" }, status }),
    ...(stopped ? { stopped } : {}) };
}

/** The progress of a loaded session, read from its settled steps. */
export function answerReviewSnapshotProgress(snapshot: AnswerReviewSessionSnapshot): AnswerReviewProgress {
  const { session, steps } = snapshot;
  return answerReviewProgress({
    maxRounds: session.maxRounds, mode: session.mode, reviewerCount: session.reviewers.length, round: session.round,
    state: session.state, steps, stopReason: session.stopReason
  });
}

/**
 * Persists the conclusion a session's settled steps reached (stopped,
 * failed, an approval card, an unreadable or all-clean review) while its row
 * still says running. Idempotent; a session that ended keeps its first reason.
 */
export async function reconcileAnswerReviewSession(prisma: PrismaClient, sessionId: string): Promise<AnswerReviewProgress | null> {
  const snapshot = await loadAnswerReviewSessionSnapshot(prisma, sessionId);
  if (!snapshot) return null;
  const progress = answerReviewSnapshotProgress(snapshot);
  if (progress.settle && progress.stopReason && progress.state !== "running") {
    await settleAnswerReviewSession(prisma, { sessionId, state: progress.state, stopReason: progress.stopReason });
  }
  return progress;
}

async function stopSession(prisma: PrismaClient, sessionId: string, stopReason: AnswerReviewStopReason): Promise<void> {
  await settleAnswerReviewSession(prisma, { sessionId, state: "stopped", stopReason }).catch(() => undefined);
}

/** Send refusals that end the session: the step can never run as it is. */
function refusalStopReason(status: number, code: string | null): AnswerReviewStopReason | null {
  if (status === 429) return "budget";
  if (code && ["answer_review_agent_unsupported", "answer_review_assistant_unsupported", "answer_review_knowledge_unsupported",
    "answer_review_model_unsupported", "provider_not_available", "credential_assignment_ambiguous", "model_not_available"].includes(code)) {
    return "error";
  }
  return null;
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.clone().json();
    return typeof body === "object" && body !== null && typeof (body as Record<string, unknown>).error === "string"
      ? (body as Record<string, string>).error : null;
  } catch {
    return null;
  }
}

/** The text and step facts of the session's next step. */
function stepTurn(snapshot: AnswerReviewSessionSnapshot, next: NonNullable<AnswerReviewProgress["next"]>): Readonly<{
  preparation: AnswerReviewStepPreparation;
  text: string;
}> {
  const roundReviews: AnswerReviewCard[] = snapshot.steps
    .filter((step) => step.round === next.round && step.kind === "review" && step.status === "complete" && step.reviewCard)
    .map((step) => step.reviewCard!);
  if (next.kind === "review") {
    const rejected = rejectedAnswerReviewFindings(snapshot.steps, next.round);
    return {
      preparation: {
        kind: "review", reviewer: next.reviewer, round: next.round, sessionId: snapshot.session.id, step: next.step,
        ...(rejected.length ? { rejectedKeys: rejected.map((finding) => finding.key) } : {})
      },
      text: answerReviewRequestText({ earlierReviews: roundReviews.filter((card) => card.reviewer < next.reviewer), rejected })
    };
  }
  return {
    preparation: {
      findingKeys: roundReviews.flatMap((card) => card.findings.map((finding) =>
        answerReviewFindingKey(card.round, card.reviewer, finding.id))),
      kind: "revision", round: next.round, sessionId: snapshot.session.id, step: next.step
    },
    text: answerRevisionRequestText({ reviews: roundReviews })
  };
}

export async function startAnswerReviewStep(
  deps: AnswerReviewStepStartDeps,
  input: AnswerReviewStepStartInput
): Promise<AnswerReviewStepStart> {
  const snapshot = await loadAnswerReviewSessionSnapshot(deps.prisma, input.sessionId);
  // Only the initiator starts steps; any other reader learns nothing more.
  if (!snapshot || snapshot.session.userId !== input.userId) return refusal("answer_review_unavailable", 404);
  const progress = answerReviewSnapshotProgress(snapshot);
  if (progress.settle && progress.stopReason && progress.state !== "running") {
    await settleAnswerReviewSession(deps.prisma, { sessionId: snapshot.session.id, state: progress.state, stopReason: progress.stopReason });
    return refusal("answer_review_ended", 409);
  }
  if (progress.state !== "running") return refusal("answer_review_ended", 409);
  const next = progress.next;
  if (progress.running || !next || next.kind !== input.kind) return refusal("answer_review_step_unavailable", 409);
  if (snapshot.chat.assistantId) return refusal("answer_review_assistant_unsupported", 409);
  if (snapshot.lastMessageId !== input.expectedActiveLeafId || snapshot.chat.activeLeafMessageId !== snapshot.lastMessageId) {
    return refusal("active_leaf_changed", 409);
  }
  const model = next.kind === "review" ? snapshot.session.reviewers[next.reviewer] : snapshot.session.authorModel;
  if (!model) return refusal("answer_review_step_unavailable", 409);
  const turn = stepTurn(snapshot, next);
  const controls = answerReviewStepControls(input.controls);
  const body: Record<string, unknown> = {
    ...controls,
    admissionId: input.admissionId,
    content: { blocks: [{ text: turn.text, type: "text" }] },
    expectedActiveLeafId: snapshot.lastMessageId,
    modelId: model.modelId,
    provider: model.provider,
    // A personal send names its Search; without one the step searches nothing.
    ...(!snapshot.chat.projectId && controls.searchPlan === undefined ? { searchPlan: { mode: "all_selected", optionIds: [] } } : {})
  };
  const chatId = snapshot.session.chatId;
  const response = await createSendMessageHandler({
    ...deps.sendDeps,
    answerReviewStep: {
      preparation: turn.preparation,
      turnKind: next.kind === "review" ? ANSWER_REVIEW_REQUEST_KIND : ANSWER_REVISION_REQUEST_KIND
    },
    resolveAuth: input.resolveAuth
  })(new Request(`http://localhost/api/chats/${encodeURIComponent(chatId)}/messages`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  }), { params: { chatId } });
  // The claimed turn, not the HTTP outcome, says whether the step exists.
  const claimed = await deps.prisma.message.findFirst({
    select: { id: true, userModelRuns: { orderBy: { createdAt: "desc" }, select: { assistantMessageId: true, id: true }, take: 1 } },
    where: {
      answerReviewRound: turn.preparation.round, answerReviewSessionId: snapshot.session.id,
      answerReviewStep: turn.preparation.step, chatId, role: "user"
    }
  });
  const run = claimed?.userModelRuns[0];
  if (claimed && run?.assistantMessageId) {
    // Best effort: a step that ends the session settles it as soon as its run's
    // terminal handling finishes here; the next step start reconciles otherwise.
    void activeRunControllerRegistry.settled(run.id)?.then(() => reconcileAnswerReviewSession(deps.prisma, snapshot.session.id))
      .catch(() => undefined);
    return { assistantMessageId: run.assistantMessageId, ok: true, response, runId: run.id, userMessageId: claimed.id };
  }
  const code = response.ok ? "answer_review_step_unavailable" : await errorCode(response);
  const stopped = response.ok ? null : refusalStopReason(response.status, code);
  if (stopped) await stopSession(deps.prisma, snapshot.session.id, stopped);
  if (response.ok) {
    // Accepted without a visible claim: never leave a stream unread.
    void response.body?.cancel().catch(() => undefined);
    return refusal("answer_review_step_unavailable", 409);
  }
  return { code: code ?? "unknown", ok: false, response, ...(stopped ? { stopped } : {}) };
}
