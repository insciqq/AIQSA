import { Prisma, type PrismaClient } from "@prisma/client";
import {
  ANSWER_REVIEW_MAX_REVIEWERS,
  ANSWER_REVIEW_TEXT_LIMITS,
  ANSWER_REVISION_REQUEST_KIND,
  answerReviewFindingKey,
  answerReviewText,
  decodeAnswerReviewCard,
  decodeAnswerReviewDecisionsCard,
  isAnswerReviewTurnKind,
  type AnswerReviewCard,
  type AnswerReviewDecisionsCard,
  type AnswerReviewMessageWire,
  type AnswerReviewMode,
  type AnswerReviewModelWire,
  type AnswerReviewSessionWire,
  type AnswerReviewState,
  type AnswerReviewStopReason
} from "../../contracts/answerReviews";
import type { AnswerReviewStepFacts } from "../../domain/answerReviewProgress";
import { isAnswerReviewStepMarker } from "../tools/answerReview";
import type { AnswerReviewRejectedFinding } from "./prompts";

/**
 * Persistence of answer review sessions. A session's steps are its messages
 * (`Message.answerReviewSessionId`): each step's server-written turn records
 * its round and ordinal (a unique claim) and its answer is an ordinary run.
 * Progress is read from those settled messages; the row keeps the frozen
 * models and the durable conclusion.
 */

export type AnswerReviewModelRef = AnswerReviewModelWire;

export type AnswerReviewSessionRecord = Readonly<{
  authorModel: AnswerReviewModelRef;
  chatId: string;
  id: string;
  maxRounds: number | null;
  mode: AnswerReviewMode;
  reviewers: readonly AnswerReviewModelRef[];
  round: number;
  sourceAssistantMessageId: string;
  state: AnswerReviewState;
  stopReason: AnswerReviewStopReason | null;
  userId: string | null;
}>;

/** One step as its messages left it. */
export type AnswerReviewStepRecord = AnswerReviewStepFacts & Readonly<{
  answerId: string | null;
  decisionsCard?: AnswerReviewDecisionsCard;
  reviewCard?: AnswerReviewCard;
  reviewer?: number;
  runId: string | null;
  turnId: string;
}>;

export type AnswerReviewSessionSnapshot = Readonly<{
  chat: Readonly<{ activeLeafMessageId: string | null; assistantId: string | null; projectId: string | null }>;
  /** The session's newest message: its latest step's answer (or turn), else the source answer. */
  lastMessageId: string;
  /** The group's latest version: the newest complete revision answer, else the source answer. */
  latestVersionId: string;
  session: AnswerReviewSessionRecord;
  steps: readonly AnswerReviewStepRecord[];
}>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function decodeAnswerReviewModelRef(value: unknown): AnswerReviewModelRef | null {
  return record(value) && typeof value.provider === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.provider) &&
    typeof value.modelId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.modelId) &&
    answerReviewText(value.name, ANSWER_REVIEW_TEXT_LIMITS.modelName)
    ? { modelId: value.modelId, name: value.name, provider: value.provider }
    : null;
}

function decodeReviewers(value: unknown): AnswerReviewModelRef[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > ANSWER_REVIEW_MAX_REVIEWERS) return null;
  const reviewers = value.map(decodeAnswerReviewModelRef);
  return reviewers.every((reviewer): reviewer is AnswerReviewModelRef => reviewer !== null) ? reviewers : null;
}

const sessionSelect = {
  authorModel: true, chatId: true, id: true, maxRounds: true, mode: true, reviewers: true, round: true,
  sourceAssistantMessageId: true, state: true, stopReason: true, userId: true
} satisfies Prisma.AnswerReviewSessionSelect;

type SessionRow = Prisma.AnswerReviewSessionGetPayload<{ select: typeof sessionSelect }>;

/** A stored row whose frozen models do not decode is unusable, never guessed. */
export function decodeAnswerReviewSessionRow(row: SessionRow): AnswerReviewSessionRecord | null {
  const authorModel = decodeAnswerReviewModelRef(row.authorModel);
  const reviewers = decodeReviewers(row.reviewers);
  if (!authorModel || !reviewers) return null;
  return {
    authorModel, chatId: row.chatId, id: row.id, maxRounds: row.maxRounds, mode: row.mode, reviewers, round: row.round,
    sourceAssistantMessageId: row.sourceAssistantMessageId, state: row.state, stopReason: row.stopReason, userId: row.userId
  };
}

export function answerReviewSessionWire(session: AnswerReviewSessionRecord, viewerUserId: string | null): AnswerReviewSessionWire {
  return {
    author: session.authorModel,
    ...(viewerUserId !== null && session.userId === viewerUserId ? { canAct: true as const } : {}),
    id: session.id,
    maxRounds: session.maxRounds,
    mode: session.mode,
    reviewers: session.reviewers,
    round: session.round,
    sourceAssistantMessageId: session.sourceAssistantMessageId,
    state: session.state,
    stopReason: session.stopReason
  };
}

type ReadClient = Pick<Prisma.TransactionClient, "answerReviewSession" | "message">;

const stepMessageSelect = {
  answerReviewRound: true,
  answerReviewStep: true,
  assistantModelRuns: {
    orderBy: { createdAt: "desc" },
    select: {
      events: {
        orderBy: { sequence: "asc" },
        select: { payload: true },
        where: {
          eventType: "artifact",
          OR: [
            { payload: { equals: "answer_review", path: ["artifactType"] } },
            { payload: { equals: "answer_review_decisions", path: ["artifactType"] } }
          ]
        }
      },
      id: true,
      mcpToolApprovals: { select: { id: true }, take: 1, where: { decision: null } },
      normalizedRequest: true
    },
    take: 1
  },
  createdAt: true,
  id: true,
  parentMessageId: true,
  role: true,
  status: true,
  systemTurnKind: true
} satisfies Prisma.MessageSelect;

type StepMessageRow = Prisma.MessageGetPayload<{ select: typeof stepMessageSelect }>;

function cardsOf(row: StepMessageRow | undefined): { decisions?: AnswerReviewDecisionsCard; review?: AnswerReviewCard } {
  let review: AnswerReviewCard | undefined;
  let decisions: AnswerReviewDecisionsCard | undefined;
  for (const event of row?.assistantModelRuns[0]?.events ?? []) {
    const payload = record(event.payload) ? event.payload : null;
    if (!payload) continue;
    if (payload.artifactType === "answer_review") review ??= decodeAnswerReviewCard(payload.payload) ?? undefined;
    if (payload.artifactType === "answer_review_decisions") decisions ??= decodeAnswerReviewDecisionsCard(payload.payload) ?? undefined;
  }
  return { ...(decisions ? { decisions } : {}), ...(review ? { review } : {}) };
}

function stepStatus(status: string | undefined): AnswerReviewStepFacts["status"] {
  return status === "complete" || status === "error" || status === "cancelled" ? status : "running";
}

/** A session's steps, in round and step order, from its messages. */
export function answerReviewStepsFromMessages(rows: readonly StepMessageRow[]): AnswerReviewStepRecord[] {
  const answers = new Map<string, StepMessageRow>();
  for (const row of rows) {
    if (row.role !== "assistant" || !row.parentMessageId) continue;
    const current = answers.get(row.parentMessageId);
    if (!current || current.createdAt <= row.createdAt) answers.set(row.parentMessageId, row);
  }
  return rows.flatMap((turn) => {
    if (turn.role !== "user" || turn.answerReviewRound === null || turn.answerReviewStep === null ||
      !isAnswerReviewTurnKind(turn.systemTurnKind)) return [];
    const answer = answers.get(turn.id);
    const run = answer?.assistantModelRuns[0];
    const marker = run && record(run.normalizedRequest) && isAnswerReviewStepMarker(run.normalizedRequest.answerReviewStep)
      ? run.normalizedRequest.answerReviewStep : null;
    const cards = cardsOf(answer);
    const kind = turn.systemTurnKind === ANSWER_REVISION_REQUEST_KIND ? "revision" as const : "review" as const;
    const reviewer = kind === "review" ? marker?.reviewer ?? turn.answerReviewStep : undefined;
    return [{
      answerId: answer?.id ?? null,
      ...(run?.mcpToolApprovals.length ? { approvalPending: true as const } : {}),
      ...(cards.decisions ? { decisions: true as const, decisionsCard: cards.decisions } : {}),
      kind,
      ...(cards.review && kind === "review"
        ? { review: { findings: cards.review.findings.length, verdict: cards.review.verdict }, reviewCard: cards.review }
        : {}),
      ...(reviewer !== undefined ? { reviewer } : {}),
      round: turn.answerReviewRound,
      runId: run?.id ?? null,
      status: answer ? stepStatus(answer.status) : "running",
      step: turn.answerReviewStep,
      turnId: turn.id
    }];
  }).sort((left, right) => left.round - right.round || left.step - right.step);
}

/** The session, its chat's leaf and its steps; null when the session or its rows are unusable. */
export async function loadAnswerReviewSessionSnapshot(
  db: ReadClient & Pick<Prisma.TransactionClient, "chat">,
  sessionId: string
): Promise<AnswerReviewSessionSnapshot | null> {
  const row = await db.answerReviewSession.findUnique({ select: sessionSelect, where: { id: sessionId } });
  const session = row ? decodeAnswerReviewSessionRow(row) : null;
  if (!session) return null;
  const chat = await db.chat.findFirst({
    select: { activeLeafMessageId: true, assistantId: true, projectId: true },
    where: { archived: false, id: session.chatId, permanentDeletionAt: null }
  });
  if (!chat) return null;
  const rows = await db.message.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: stepMessageSelect,
    take: 400,
    where: { answerReviewSessionId: session.id, chatId: session.chatId }
  });
  const steps = answerReviewStepsFromMessages(rows);
  // Steps append in round and step order, so the newest one ends the chain.
  const lastStep = steps.at(-1);
  const lastMessageId = lastStep ? lastStep.answerId ?? lastStep.turnId : session.sourceAssistantMessageId;
  const versions = steps.filter((step) => step.kind === "revision" && step.status === "complete" && step.answerId);
  return {
    chat,
    lastMessageId,
    latestVersionId: versions.at(-1)?.answerId ?? session.sourceAssistantMessageId,
    session,
    steps
  };
}

/** Findings the author rejected in earlier rounds, with the claim their reviewer made. */
export function rejectedAnswerReviewFindings(steps: readonly AnswerReviewStepRecord[], beforeRound: number): AnswerReviewRejectedFinding[] {
  const claims = new Map<string, string>();
  for (const step of steps) {
    for (const finding of step.reviewCard?.findings ?? []) {
      claims.set(answerReviewFindingKey(step.reviewCard!.round, step.reviewCard!.reviewer, finding.id), finding.claim);
    }
  }
  return steps.filter((step) => step.round < beforeRound).flatMap((step) => (step.decisionsCard?.decisions ?? [])
    .filter((decision) => decision.decision === "rejected" && claims.has(decision.findingId))
    .map((decision) => ({ claim: claims.get(decision.findingId)!, key: decision.findingId, reason: decision.reason })))
    .slice(-40);
}

/**
 * Persists a conclusion the session's steps reached while the row still says
 * running; a session that already ended keeps its first conclusion.
 */
export async function settleAnswerReviewSession(
  db: Pick<PrismaClient, "answerReviewSession"> | Pick<Prisma.TransactionClient, "answerReviewSession">,
  input: Readonly<{ sessionId: string; state: "finished" | "stopped"; stopReason: AnswerReviewStopReason }>
): Promise<boolean> {
  const updated = await db.answerReviewSession.updateMany({
    data: { state: input.state, stopReason: input.stopReason },
    where: { id: input.sessionId, state: "running" }
  });
  return updated.count === 1;
}

/** What a step's card names about its session's messages, for the transcript. */
export type AnswerReviewProjectionInput = Readonly<{
  answerReviewSessionId: string | null;
  answerReviewRound: number | null;
  answerReviewStep: number | null;
  id: string;
  parentMessageId: string | null;
  role: string;
  systemTurnKind: string | null;
  /** The answer's run's frozen step marker, for its model name. */
  stepModelName?: string | null;
}>;

/**
 * The session projection of each message of `messages` that belongs to an
 * answer review session: its source answer, a step's turn or a step's answer
 * (whose turn may lie outside `messages`). One query for the sessions and one
 * for the turns, whatever the page size.
 */
export async function loadAnswerReviewProjection(
  db: ReadClient,
  input: Readonly<{ chatId: string; messages: readonly AnswerReviewProjectionInput[]; viewerUserId: string | null }>
): Promise<Map<string, AnswerReviewMessageWire>> {
  const projection = new Map<string, AnswerReviewMessageWire>();
  const memberSessionIds = [...new Set(input.messages.flatMap((message) => message.answerReviewSessionId ?? []))];
  const assistantIds = input.messages.filter((message) => message.role === "assistant").map((message) => message.id);
  if (memberSessionIds.length === 0 && assistantIds.length === 0) return projection;
  const rows = await db.answerReviewSession.findMany({
    select: sessionSelect,
    take: 200,
    where: {
      chatId: input.chatId,
      OR: [
        ...(memberSessionIds.length ? [{ id: { in: memberSessionIds } }] : []),
        ...(assistantIds.length ? [{ sourceAssistantMessageId: { in: assistantIds } }] : [])
      ]
    }
  });
  const sessions = new Map(rows.flatMap((row) => {
    const decoded = decodeAnswerReviewSessionRow(row);
    return decoded ? [[decoded.id, decoded] as const] : [];
  }));
  if (sessions.size === 0) return projection;
  // A step's answer takes its round and ordinal from its turn, also off the page.
  const byId = new Map(input.messages.map((message) => [message.id, message]));
  const missingTurnIds = input.messages.flatMap((message) => message.role === "assistant" && message.answerReviewSessionId &&
    message.parentMessageId && !byId.has(message.parentMessageId) ? [message.parentMessageId] : []);
  const turns = missingTurnIds.length ? await db.message.findMany({
    select: { answerReviewRound: true, answerReviewSessionId: true, answerReviewStep: true, id: true, parentMessageId: true,
      role: true, systemTurnKind: true },
    where: { chatId: input.chatId, id: { in: missingTurnIds } }
  }) : [];
  const turnById = new Map<string, AnswerReviewProjectionInput>([...byId, ...turns.map((turn) => [turn.id, turn] as const)]);
  const wires = new Map([...sessions.values()].map((session) => [session.id, answerReviewSessionWire(session, input.viewerUserId)]));
  for (const session of sessions.values()) {
    if (byId.has(session.sourceAssistantMessageId)) projection.set(session.sourceAssistantMessageId, { session: wires.get(session.id)! });
  }
  for (const message of input.messages) {
    const session = message.answerReviewSessionId ? wires.get(message.answerReviewSessionId) : undefined;
    if (!session) continue;
    const turn = message.role === "user" ? message : message.parentMessageId ? turnById.get(message.parentMessageId) : undefined;
    const kind = turn?.systemTurnKind === ANSWER_REVISION_REQUEST_KIND ? "revision" as const
      : isAnswerReviewTurnKind(turn?.systemTurnKind) ? "review" as const : null;
    const step = turn && kind && turn.answerReviewSessionId === session.id && turn.answerReviewRound !== null &&
      turn.answerReviewStep !== null
      ? {
          kind,
          ...(message.stepModelName ? { modelName: message.stepModelName } : {}),
          ...(kind === "review" ? { reviewer: Math.min(turn.answerReviewStep, ANSWER_REVIEW_MAX_REVIEWERS - 1) } : {}),
          round: turn.answerReviewRound,
          step: turn.answerReviewStep
        }
      : undefined;
    projection.set(message.id, { session, ...(step ? { step } : {}) });
  }
  return projection;
}

/** The step model's display name a step answer's run froze (`answerReviewStep.modelName`). */
export function answerReviewStepModelName(normalizedRequest: unknown): string | null {
  return record(normalizedRequest) && isAnswerReviewStepMarker(normalizedRequest.answerReviewStep)
    ? normalizedRequest.answerReviewStep.modelName : null;
}
