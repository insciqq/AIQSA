import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  ANSWER_REVIEW_AUTO_MAX_MS,
  type AnswerReviewState,
  type AnswerReviewStopReason
} from "../../contracts/answerReviews";
import type { AnswerReviewNextStep } from "../../domain/answerReviewProgress";
import type { AuthenticatedUser, RequestAuthResolver } from "../auth/requestAuth";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { observedFailureCode } from "../providers/providerObservability";
import { activeRunControllerRegistry } from "../runs/activeRunControllerRegistry";
import {
  loadAnswerReviewSessionSnapshot,
  settleAnswerReviewSession,
  type AnswerReviewSessionSnapshot
} from "./repository";
import { answerReviewAutoStepControls, decodeAnswerReviewAutoControls } from "./stepControls";
import {
  answerReviewSnapshotProgress,
  startAnswerReviewStep,
  type AnswerReviewStepStart,
  type AnswerReviewStepStartDeps
} from "./stepStart";

/**
 * The driver of automatic answer review sessions ("ask and leave"). It owns
 * no state of its own: a session's progress is read from its settled
 * messages each time (`answerReviewProgress`), and each step starts through
 * the one step start the manual routes use, as the session's initiator,
 * server-side, with the controls the user's send froze. A step therefore runs
 * once: its admission claims (session, round, step) in the transaction that
 * creates its turn, so a second start of the same step (another trigger, a
 * retry after a lost response, a restart) is refused.
 *
 * Triggers: a run of a session settling (`onRunSettled`, from the committed
 * terminal signal), and a periodic reconciler tick that resumes every running
 * automatic session, e.g. one whose last step settled while the process
 * restarted, and handles every ended one whose end was not handled yet. Work
 * for one session is serialized in this process (a single replica).
 */

/** How a session ended, for its one notification. */
export type AnswerReviewEndedEvent = Readonly<{
  /** The answer itself failed before any step ran. */
  answerFailed: boolean;
  chatId: string;
  /** The run whose end a device that showed it already saw; null without one. */
  lastRunId: string | null;
  /** Rounds that had a settled step. */
  rounds: number;
  sessionId: string;
  state: Exclude<AnswerReviewState, "running">;
  stopReason: AnswerReviewStopReason;
  userId: string;
}>;

export type AnswerReviewDriverDeps = Readonly<{
  /** Detaches a session's work from its trigger; defaults to a plain promise. */
  background?: (work: () => Promise<void>) => Promise<void>;
  now?: () => Date;
  /** The session's single end notification; never awaited. */
  notifyEnded?: (event: AnswerReviewEndedEvent) => void;
  /** The session's initiator, resolved again on every call: an inactive account refuses the step. */
  ownerAuth: (userId: string) => RequestAuthResolver;
  prisma: PrismaClient;
  steps: () => AnswerReviewStepStartDeps;
  /** Stops a run through the ordinary Stop path, keeping the given terminal cause. */
  stopRun: (input: Readonly<{ code: string; message: string; runId: string; userId: string }>) => Promise<unknown>;
}>;

export type AnswerReviewDriverDecision =
  | Readonly<{ kind: "wait" }>
  | Readonly<{
      kind: "settle";
      state: Exclude<AnswerReviewState, "running">;
      stopReason: AnswerReviewStopReason;
      /** A running step the session's end also stops. */
      stopRunId?: string;
    }>
  | Readonly<{ kind: "start"; next: AnswerReviewNextStep }>;

const TIME_LIMIT_MESSAGE = "Answer review stopped at its time limit";

/**
 * What an automatic session needs now, from its snapshot alone: wait for a
 * running step (or for the answer under review, or for the last run's
 * Workspace to settle), persist how it ended, or start its next step. A
 * session past its wall-time ceiling stops (`time_limit`) and stops a running
 * step, never the user's own answer, which it waits for first; a chat whose
 * path moved away from the session's last message supersedes it.
 */
export function answerReviewDriverDecision(snapshot: AnswerReviewSessionSnapshot, now: Date): AnswerReviewDriverDecision {
  const { session } = snapshot;
  if (session.mode !== "auto" || session.state !== "running") return { kind: "wait" };
  const progress = answerReviewSnapshotProgress(snapshot);
  if (progress.settle && progress.stopReason && progress.state !== "running") {
    return { kind: "settle", state: progress.state, stopReason: progress.stopReason };
  }
  // The user's own answer is never cut short: its session waits for it, then counts its time.
  if (progress.awaitingAnswer) return { kind: "wait" };
  const runningStep = progress.running
    ? snapshot.steps.find((step) => step.round === progress.running!.round && step.step === progress.running!.step) ?? null
    : null;
  if (now.getTime() - session.createdAt.getTime() >= ANSWER_REVIEW_AUTO_MAX_MS) {
    return { kind: "settle", state: "stopped", stopReason: "time_limit", ...(runningStep?.runId ? { stopRunId: runningStep.runId } : {}) };
  }
  if (progress.running) return { kind: "wait" };
  // Nothing follows this session's last message any more: a branch switch or a deleted message.
  if (snapshot.chat.activeLeafMessageId !== snapshot.lastMessageId) {
    return { kind: "settle", state: "stopped", stopReason: "superseded" };
  }
  // The last run still settles (its Workspace): the next step waits for its terminal.
  const last = snapshot.steps.at(-1);
  if (!(last ? last.runTerminal : snapshot.source?.runTerminal ?? true)) return { kind: "wait" };
  return progress.next ? { kind: "start", next: progress.next } : { kind: "wait" };
}

/** A step's send identity: the same step always retries with the same one. */
export function answerReviewStepAdmissionId(sessionId: string, next: Pick<AnswerReviewNextStep, "round" | "step">): string {
  const digest = createHash("sha256").update(`answer-review:${sessionId}:${next.round}:${next.step}`).digest("hex");
  return `answer-review-${digest.slice(0, 40)}`;
}

/** The initiator as the ordinary send handler authenticates a request, while the account is active. */
export function answerReviewOwnerAuth(
  prisma: Pick<PrismaClient, "user">,
  userId: string
): RequestAuthResolver {
  return async () => {
    const user: AuthenticatedUser | null = await prisma.user.findUnique({
      select: { displayName: true, email: true, id: true, role: true, status: true }, where: { id: userId }
    });
    return user && user.id === userId && user.status === "active"
      ? { expiresAt: new Date(Date.now() + 60_000), id: "answer-review", user, userId: user.id }
      : null;
  };
}

/** Send refusals a later trigger may still overcome; any other ends the session (`error`). */
const TRANSIENT_REFUSALS: ReadonlySet<string> = new Set([
  "active_run_in_progress", "answer_review_step_unavailable", "mcp_not_ready", "provider_admission_changed",
  "usage_limits_unavailable", "workspace_busy"
]);

type StepOutcome = "again" | "done";

/** Content-free: session and run identities, stable codes only. */
function log(fields: Readonly<{
  action?: "fail" | "retry" | "skip"; code: string; job_id: string; outcome: "completed" | "failed" | "skipped" | "waiting";
  prisma_code?: string; run_id?: string; stage: "dispatch" | "reconcile" | "settle";
}>): void {
  logEvent("job_attempt", { subsystem: "answer_review", ...fields });
}

export function createAnswerReviewDriver(deps: AnswerReviewDriverDeps) {
  const clock = deps.now ?? (() => new Date());
  const background = deps.background ?? ((work) => work());
  const inFlight = new Map<string, Promise<void>>();
  const pending = new Set<string>();

  /** Stops a running automatic session whose chat is gone or archived. */
  async function endOrphan(sessionId: string): Promise<void> {
    await deps.prisma.answerReviewSession.updateMany({
      data: { state: "stopped", stopReason: "superseded" }, where: { id: sessionId, mode: "auto", state: "running" }
    });
    await deps.prisma.answerReviewSession.updateMany({
      data: { endNotifiedAt: clock() }, where: { endNotifiedAt: null, id: sessionId, mode: "auto", state: { not: "running" } }
    });
  }

  /**
   * The session's end, handled once: the claim on `endNotifiedAt` admits one
   * notification whatever settled the session (this driver, a refused step,
   * Stop, a later send). The user's own Stop and moving on notify nothing.
   */
  async function handleEnd(snapshot: AnswerReviewSessionSnapshot): Promise<void> {
    const { session } = snapshot;
    const claimed = await deps.prisma.answerReviewSession.updateMany({
      data: { endNotifiedAt: clock() },
      where: { endNotifiedAt: null, id: session.id, mode: "auto", state: { not: "running" } }
    });
    if (claimed.count !== 1 || session.state === "running" || !session.stopReason) return;
    log({ code: "answer_review_session_ended", job_id: session.id, outcome: "completed", stage: "settle" });
    if (session.stopReason === "user_stopped" || session.stopReason === "superseded" || !session.userId) return;
    const settled = snapshot.steps.filter((step) => step.status !== "running");
    const lastRun = snapshot.steps.at(-1)?.runId ?? snapshot.source?.runId ?? null;
    try {
      deps.notifyEnded?.({
        answerFailed: snapshot.steps.length === 0 && snapshot.source?.status === "error",
        chatId: session.chatId,
        lastRunId: lastRun,
        rounds: Math.max(0, ...settled.map((step) => step.round)),
        sessionId: session.id,
        state: session.state,
        stopReason: session.stopReason,
        userId: session.userId
      });
    } catch {
      // Notifications are best effort and never hold a session.
    }
  }

  /** Starts the session's next step as its initiator; "again" re-reads the session. */
  async function start(snapshot: AnswerReviewSessionSnapshot, next: AnswerReviewNextStep): Promise<StepOutcome> {
    const { session } = snapshot;
    if (next.round > session.round) {
      // The step's admission requires its round to be the session's: move to it once, guarded.
      await deps.prisma.answerReviewSession.updateMany({
        data: { round: next.round }, where: { id: session.id, mode: "auto", round: session.round, state: "running" }
      });
      return "again";
    }
    const row = await deps.prisma.answerReviewSession.findUnique({ select: { controls: true }, where: { id: session.id } });
    const frozen = row ? decodeAnswerReviewAutoControls(row.controls) : null;
    if (!frozen || !session.userId) {
      await settleAnswerReviewSession(deps.prisma, { sessionId: session.id, state: "stopped", stopReason: "error" });
      return "again";
    }
    let started: AnswerReviewStepStart;
    try {
      started = await startAnswerReviewStep(deps.steps(), {
        admissionId: answerReviewStepAdmissionId(session.id, next),
        controls: answerReviewAutoStepControls(frozen, next.kind === "review" ? { kind: "review", reviewer: next.reviewer }
          : { kind: "revision" }),
        expectedActiveLeafId: snapshot.lastMessageId,
        expectedMode: "auto",
        kind: next.kind,
        resolveAuth: deps.ownerAuth(session.userId),
        sessionId: session.id,
        userId: session.userId
      });
    } catch (error) {
      log({ action: "retry", code: observedFailureCode(error), job_id: session.id, outcome: "failed",
        prisma_code: databaseFailureCode(error), stage: "dispatch" });
      return "done";
    }
    if (started.ok) {
      log({ code: "answer_review_step_started", job_id: session.id, outcome: "completed", run_id: started.runId, stage: "dispatch" });
      // The run executes here whether or not its stream is read; nobody reads this one.
      void started.response.body?.cancel().catch(() => undefined);
      void activeRunControllerRegistry.settled(started.runId)?.then(() => kick(session.id)).catch(() => undefined);
      return "done";
    }
    void started.response.body?.cancel().catch(() => undefined);
    if (started.stopped) return "again";
    if (started.code === "active_leaf_changed") {
      await settleAnswerReviewSession(deps.prisma, { sessionId: session.id, state: "stopped", stopReason: "superseded" });
      return "again";
    }
    if (started.code === "answer_review_ended") return "again";
    if (TRANSIENT_REFUSALS.has(started.code) || started.response.status >= 500) {
      log({ action: "retry", code: "answer_review_step_waiting", job_id: session.id, outcome: "waiting", stage: "dispatch" });
      return "done";
    }
    log({ action: "fail", code: "answer_review_step_refused", job_id: session.id, outcome: "failed", stage: "dispatch" });
    await settleAnswerReviewSession(deps.prisma, { sessionId: session.id, state: "stopped", stopReason: "error" });
    return "again";
  }

  /** One session brought as far as it can go now; a few passes cover settle-then-notify and a new round. */
  async function advance(sessionId: string): Promise<void> {
    for (let pass = 0; pass < 4; pass += 1) {
      const snapshot = await loadAnswerReviewSessionSnapshot(deps.prisma, sessionId);
      if (!snapshot) return endOrphan(sessionId);
      if (snapshot.session.mode !== "auto") return;
      if (snapshot.session.state !== "running") return handleEnd(snapshot);
      const decision = answerReviewDriverDecision(snapshot, clock());
      if (decision.kind === "wait") return;
      if (decision.kind === "settle") {
        await settleAnswerReviewSession(deps.prisma, { sessionId, state: decision.state, stopReason: decision.stopReason });
        if (decision.stopReason === "time_limit") {
          log({ action: "fail", code: "answer_review_time_limit", job_id: sessionId, outcome: "failed", stage: "settle" });
        }
        if (decision.stopRunId && snapshot.session.userId) {
          await deps.stopRun({ code: "answer_review_time_limit", message: TIME_LIMIT_MESSAGE, runId: decision.stopRunId,
            userId: snapshot.session.userId }).catch(() => undefined);
        }
        continue;
      }
      if (await start(snapshot, decision.next) === "done") return;
    }
  }

  /** Serializes one session's work in this process; a trigger during it runs it once more afterwards. */
  function kick(sessionId: string): void {
    if (inFlight.has(sessionId)) {
      pending.add(sessionId);
      return;
    }
    const work = background(async () => {
      try {
        await advance(sessionId);
      } catch (error) {
        log({ action: "retry", code: "answer_review_driver_failed", job_id: sessionId, outcome: "failed",
          prisma_code: databaseFailureCode(error), stage: "reconcile" });
      }
    }).catch(() => undefined).finally(() => {
      inFlight.delete(sessionId);
      if (pending.delete(sessionId)) kick(sessionId);
    });
    inFlight.set(sessionId, work);
  }

  return {
    kick,
    /**
     * The initiator's Stop of an automatic session: it ends `user_stopped`
     * (the first conclusion wins) and its running step stops through the
     * ordinary Stop path; the answer under review is the user's own and keeps
     * its own Stop. Null for anyone else and for missing sessions alike.
     */
    async stop(input: Readonly<{ sessionId: string; userId: string }>): Promise<AnswerReviewSessionSnapshot | null> {
      const snapshot = await loadAnswerReviewSessionSnapshot(deps.prisma, input.sessionId);
      if (!snapshot || snapshot.session.userId !== input.userId || snapshot.session.mode !== "auto") return null;
      if (snapshot.session.state === "running") {
        await settleAnswerReviewSession(deps.prisma, { sessionId: input.sessionId, state: "stopped", stopReason: "user_stopped" });
      }
      // Read after the session stopped, so a step admitted just before it is stopped too.
      const stopped = await loadAnswerReviewSessionSnapshot(deps.prisma, input.sessionId);
      for (const step of stopped?.steps ?? []) {
        if (step.status !== "running" || !step.runId) continue;
        await deps.stopRun({ code: "model_run_cancelled", message: "Model run cancelled", runId: step.runId, userId: input.userId })
          .catch(() => undefined);
      }
      kick(input.sessionId);
      return stopped;
    },
    /** A settled run of an automatic session (its answer or a step) moves that session on. */
    async onRunSettled(runId: string): Promise<void> {
      const run = await deps.prisma.modelRun.findUnique({
        select: { assistantMessage: { select: {
          answerReviewSession: { select: { id: true, mode: true } },
          answerReviewSources: { select: { id: true }, where: { mode: "auto" } }
        } } },
        where: { id: runId }
      });
      const message = run?.assistantMessage;
      if (message?.answerReviewSession?.mode === "auto") kick(message.answerReviewSession.id);
      for (const source of message?.answerReviewSources ?? []) kick(source.id);
    },
    /**
     * The reconciler: every running automatic session (a restart resumes it
     * from its settled messages) and every ended one whose end is unhandled.
     */
    async tick(): Promise<void> {
      const sessions = await deps.prisma.answerReviewSession.findMany({
        orderBy: { updatedAt: "asc" },
        select: { id: true },
        take: 200,
        where: { mode: "auto", OR: [{ state: "running" }, { endNotifiedAt: null, state: { not: "running" } }] }
      });
      for (const session of sessions) kick(session.id);
    },
    /** Resolves when every session's work started so far has settled (tests and shutdown). */
    async idle(): Promise<void> {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight.values()]);
    }
  };
}

export type AnswerReviewDriver = ReturnType<typeof createAnswerReviewDriver>;
