"use client";

import { useId, useState, type ReactNode } from "react";
import { UiV2Button, UiV2Chip, UiV2Icon } from "@/components/ui-v2";
import {
  answerReviewFindingKey,
  type AnswerReviewCard,
  type AnswerReviewDecision,
  type AnswerReviewDecisionsCard,
  type AnswerReviewSeverity
} from "@/lib/contracts/answerReviews";
import type { AnswerReviewProgress } from "@/lib/domain/answerReviewProgress";
import {
  answerReviewCardOf,
  answerReviewDecisionsOf,
  answerReviewRoundCountV2,
  answerReviewStatusTextV2,
  answerReviewStepModelNameV2,
  type AnswerReviewGroupStepV2,
  type AnswerReviewGroupV2
} from "./answerReviewModel";
import "./answer-review.css";

const SEVERITY_LABELS: Readonly<Record<AnswerReviewSeverity, string>> = {
  critical: "Critical",
  high: "High",
  medium: "Medium"
};

function findingCount(count: number): string {
  return `${count} ${count === 1 ? "finding" : "findings"}`;
}

/** One reviewer's review: its verdict, then each finding as the reviewer wrote it. */
export function AnswerReviewCardV2({ card, decisions = [] }: Readonly<{
  card: AnswerReviewCard;
  /** The author's decisions of the round, when made: each finding shows its own. */
  decisions?: readonly AnswerReviewDecision[];
}>) {
  const clean = card.verdict === "clean";
  return (
    <section className="v2-answer-review-card" data-verdict={card.verdict} data-testid="answer-review-card"
      aria-label={`Review by ${card.reviewerName}`}>
      <header className="v2-answer-review-card-heading">
        <UiV2Icon name={clean ? "check" : "alert"} />
        <strong>Review by {card.reviewerName}: {clean ? "No substantive issues" : findingCount(card.findings.length)}</strong>
      </header>
      {card.findings.length ? (
        <ol className="v2-answer-review-findings">
          {card.findings.map((finding) => {
            const key = answerReviewFindingKey(card.round, card.reviewer, finding.id);
            const decision = decisions.find((entry) => entry.findingId === key);
            return (
              <li key={finding.id} className="v2-answer-review-finding" data-severity={finding.severity}>
                <div className="v2-answer-review-finding-top">
                  <UiV2Chip tone={finding.severity === "medium" ? "neutral" : finding.severity === "high" ? "warn" : "danger"}>
                    {SEVERITY_LABELS[finding.severity]}
                  </UiV2Chip>
                  {decision ? (
                    <UiV2Chip tone={decision.decision === "accepted" ? "ok" : "neutral"}>
                      {decision.decision === "accepted" ? "Accepted" : "Rejected"}
                    </UiV2Chip>
                  ) : null}
                  {finding.repeatsFindingId ? <span className="v2-answer-review-repeat">Repeats a rejected finding</span> : null}
                </div>
                <p><span>Claim</span>{finding.claim}</p>
                <p><span>Problem</span>{finding.problem}</p>
                <p><span>Suggestion</span>{finding.suggestion}</p>
                {finding.evidence ? <p><span>Checked</span>{finding.evidence}</p> : null}
                {decision ? <p className="v2-answer-review-decision-reason"><span>Author</span>{decision.reason}</p> : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

/** The author's decisions of a round, shown once before its revised version. */
export function AnswerReviewDecisionsCardV2({ card }: Readonly<{ card: AnswerReviewDecisionsCard }>) {
  const accepted = card.decisions.filter((decision) => decision.decision === "accepted").length;
  const rejected = card.decisions.length - accepted;
  return (
    <section className="v2-answer-review-card" data-testid="answer-review-decisions" aria-label="Decisions on the findings">
      <header className="v2-answer-review-card-heading">
        <UiV2Icon name="check" />
        <strong>Decisions: {accepted} accepted, {rejected} rejected</strong>
      </header>
    </section>
  );
}

/**
 * The group's quiet status line above its answer: a running step, how the
 * session ended, or what comes next, with the one action that moves it on
 * (Revise, Continue review) for its initiator while the group is the chat's
 * latest answer and no run is active.
 */
export function AnswerReviewStatusV2({
  actionsEnabled,
  group,
  onContinue,
  onRevise,
  onStop,
  progress,
  stopUnavailableReason = null,
  stopping = false
}: Readonly<{
  actionsEnabled: boolean;
  group: AnswerReviewGroupV2;
  onContinue?(): void;
  onRevise?(): void;
  onStop?(): void;
  progress: AnswerReviewProgress;
  /** Why the running step cannot be stopped yet, as the answer's own Stop says (its run is not acknowledged yet). */
  stopUnavailableReason?: string | null;
  stopping?: boolean;
}>) {
  const settledText = answerReviewStatusTextV2(group, progress);
  if (!settledText) return null;
  const text = progress.running && stopping ? `Review · round ${progress.running.round} · Stopping…` : settledText;
  const clean = progress.state === "finished" && progress.stopReason === "clean";
  const canAct = actionsEnabled && group.session.canAct === true && progress.state === "running" && !progress.running;
  const stopReasonId = `answer-review-stop-${group.session.id}`;
  return (
    <div className="v2-answer-review-status" data-testid="answer-review-status" data-state={progress.running ? "running"
      : progress.state} role="status">
      <UiV2Icon name={progress.running ? "shield" : clean ? "check" : progress.state === "stopped" ? "alert" : "shield"} />
      <span>{text}</span>
      {progress.running && onStop ? (
        <UiV2Button icon="stop" disabled={stopping || Boolean(stopUnavailableReason)} aria-busy={stopping || undefined}
          aria-describedby={stopUnavailableReason ? stopReasonId : undefined} onClick={onStop}
          title={stopUnavailableReason ?? undefined} type="button">
          {stopping ? "Stopping…" : "Stop"}
        </UiV2Button>
      ) : null}
      {progress.running && onStop && stopUnavailableReason ? (
        <span className="v2-sr-only" id={stopReasonId}>{stopUnavailableReason}</span>
      ) : null}
      {canAct && progress.next?.kind === "revision" && onRevise ? (
        <UiV2Button icon="wand" onClick={onRevise} tone="primary" type="button">Revise</UiV2Button>
      ) : null}
      {canAct && progress.next?.kind === "review" && progress.reviews.done > 0 && onContinue ? (
        <UiV2Button icon="shield" onClick={onContinue} type="button">Continue review</UiV2Button>
      ) : null}
    </div>
  );
}

function stepLabel(group: AnswerReviewGroupV2, entry: AnswerReviewGroupStepV2): string {
  const name = answerReviewStepModelNameV2(group.session, entry.step);
  return entry.step.kind === "review" ? `Review by ${name} · round ${entry.step.round}` : `Revision by ${name} · round ${entry.step.round}`;
}

function stepState(entry: AnswerReviewGroupStepV2): string | null {
  const answer = entry.answer;
  if (!answer || answer.status === "streaming") return entry.step.kind === "review" ? "Checking…" : "Revising…";
  if (answer.status === "cancelled") return "Stopped";
  if (answer.status === "error") return "Failed";
  if (entry.step.kind === "review" && !answerReviewCardOf(answer.artifactSummary)) return "The review could not be read";
  return null;
}

/**
 * "Review history · N rounds", collapsed by default: Version 1, each step
 * (its review card or decisions, then the step's answer as an ordinary
 * answer) and each revised version. `renderAnswer` renders a step's answer
 * or an earlier version exactly as the transcript renders answers; the
 * version shown above is named, not repeated.
 */
export function AnswerReviewHistoryV2({
  defaultOpen = false,
  group,
  renderAnswer
}: Readonly<{
  defaultOpen?: boolean;
  group: AnswerReviewGroupV2;
  renderAnswer(message: AnswerReviewGroupStepV2["answer"] & object, leading: ReactNode): ReactNode;
}>) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const rounds = answerReviewRoundCountV2(group);
  if (group.steps.length === 0) return null;
  const decisionsByRound = new Map<number, readonly AnswerReviewDecision[]>();
  for (const entry of group.steps) {
    const card = entry.step.kind === "revision" ? answerReviewDecisionsOf(entry.answer?.artifactSummary) : null;
    if (card) decisionsByRound.set(card.round, card.decisions);
  }
  // Version 1 is the source answer; each completed revision is the next version.
  const versions = new Map<AnswerReviewGroupStepV2, number>();
  for (const entry of group.steps) {
    if (entry.step.kind === "revision" && entry.answer?.status === "complete") versions.set(entry, versions.size + 2);
  }
  return (
    <div className="v2-answer-review-history" data-open={open || undefined} data-testid="answer-review-history">
      <button aria-controls={panelId} aria-expanded={open} className="v2-answer-review-history-toggle v2-focusable"
        onClick={() => setOpen((current) => !current)} type="button">
        <UiV2Icon name={open ? "chevron-down" : "chevron-right"} />
        <span>Review history · {rounds} {rounds === 1 ? "round" : "rounds"}</span>
      </button>
      {open ? (
        <ol className="v2-answer-review-history-panel" id={panelId}>
          {group.source && group.latest.id !== group.source.id ? (
            <li className="v2-answer-review-entry" data-kind="version">
              {renderAnswer(group.source, <p className="v2-answer-review-entry-label">Version 1</p>)}
            </li>
          ) : null}
          {group.steps.map((entry) => {
            const state = stepState(entry);
            const review = entry.step.kind === "review" ? answerReviewCardOf(entry.answer?.artifactSummary) : null;
            const decisions = entry.step.kind === "revision" ? answerReviewDecisionsOf(entry.answer?.artifactSummary) : null;
            const version = versions.get(entry);
            const revised = version !== undefined;
            const leading = (
              <>
                <p className="v2-answer-review-entry-label">
                  {stepLabel(group, entry)}{state ? <span> · {state}</span> : null}
                </p>
                {review ? <AnswerReviewCardV2 card={review} decisions={decisionsByRound.get(review.round)} /> : null}
                {decisions ? <AnswerReviewDecisionsCardV2 card={decisions} /> : null}
                {revised ? <p className="v2-answer-review-entry-label">Version {version}</p> : null}
              </>
            );
            const key = `${entry.step.round}.${entry.step.step}`;
            if (revised && entry.answer?.id === group.latest.id) {
              return (
                <li key={key} className="v2-answer-review-entry" data-kind={entry.step.kind}>
                  {leading}
                  <p className="v2-answer-review-entry-note">Version {version} is the answer shown above.</p>
                </li>
              );
            }
            return (
              <li key={key} className="v2-answer-review-entry" data-kind={entry.step.kind}>
                {entry.answer ? renderAnswer(entry.answer, leading) : leading}
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}

/** A review step's server-written turn outside its group: a quiet chip, never a speech bubble. */
export function AnswerReviewTurnV2({ anchorId, kind }: Readonly<{ anchorId: string; kind: string }>) {
  return (
    <article className="v2-conversation-turn v2-system-turn" data-conversation-message-id={anchorId} data-message-id={anchorId}
      data-role="user" data-system-turn={kind} aria-label="Review step">
      <span className="v2-system-turn-chip">
        <UiV2Icon name="shield" />
        <span>{kind === "answer_revision_request" ? "Revision request" : "Review request"}</span>
      </span>
    </article>
  );
}
