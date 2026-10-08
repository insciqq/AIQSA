"use client";

import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { UiV2Button } from "@/components/ui-v2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import {
  type AnswerReviewAutoConfig,
  type AnswerReviewModelIdentity,
  type AnswerReviewRounds
} from "@/lib/contracts/answerReviews";
import { ANSWER_REVIEW_PICK_LIMIT, answerReviewAutoCostHintV2, type AnswerReviewCatalogModelV2 } from "./answerReviewModel";
import "./answer-review.css";

const ROUNDS: readonly AnswerReviewRounds[] = [1, 2, 3];

function sameModel(left: AnswerReviewModelIdentity, right: AnswerReviewModelIdentity): boolean {
  return left.provider === right.provider && left.modelId === right.modelId;
}

/**
 * Automatic answer review of a chat, or the default new chats start with: on
 * or off, one or two reviewer models in order (the second sees the first's
 * review; the answer's own model is never offered), up to three rounds, and
 * what that can cost. Nothing changes until Save.
 */
export function AnswerReviewSettingsDialogV2({
  busy = false,
  candidates,
  error = null,
  initial,
  mode,
  onCancel,
  onSave,
  unavailableReason = null
}: Readonly<{
  busy?: boolean;
  candidates: readonly AnswerReviewCatalogModelV2[];
  error?: string | null;
  initial: AnswerReviewAutoConfig;
  /** A chat's own review, or the Settings default for new chats. */
  mode: "chat" | "defaults";
  onCancel(): void;
  onSave(config: AnswerReviewAutoConfig): void;
  /** Why review cannot run in this chat now; it still saves the choice. */
  unavailableReason?: string | null;
}>) {
  const titleId = useId();
  const descriptionId = useId();
  const roundsId = useId();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [maxRounds, setMaxRounds] = useState<AnswerReviewRounds>(initial.maxRounds);
  const [reviewers, setReviewers] = useState<AnswerReviewModelIdentity[]>(() => {
    const kept = initial.reviewers.filter((pick) => candidates.some((model) => sameModel(model, pick)))
      .slice(0, ANSWER_REVIEW_PICK_LIMIT).map(({ modelId, provider }) => ({ modelId, provider }));
    return kept.length || initial.reviewers.length ? kept
      : candidates[0] ? [{ modelId: candidates[0].modelId, provider: candidates[0].provider }] : [];
  });
  const close = () => {
    if (!busy) onCancel();
  };
  const { dialogRef, initialFocusRef, onDialogKeyDown, portalReady } = useModalLayerV2({ closeBlocked: busy, onClose: close });
  if (!portalReady) return null;
  const toggle = (model: AnswerReviewCatalogModelV2) => setReviewers((current) => current.some((pick) => sameModel(pick, model))
    ? current.filter((pick) => !sameModel(pick, model))
    : current.length < ANSWER_REVIEW_PICK_LIMIT ? [...current, { modelId: model.modelId, provider: model.provider }] : current);
  const missingReviewer = enabled && reviewers.length === 0;
  return createPortal(
    <div className="v2-answer-review-dialog-scrim" data-testid="answer-review-settings" role="presentation" onMouseDown={close}>
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="v2-answer-review-dialog pop-enter"
        onKeyDown={onDialogKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
        ref={(node) => { dialogRef.current = node; }}
        role="dialog"
      >
        <h2 id={titleId}>{mode === "defaults" ? "Answer review for new chats" : "Answer review"}</h2>
        <p id={descriptionId}>
          Other models check each answer with {mode === "defaults" ? "the chat's" : "this chat's"} tools, then the
          answer&apos;s model decides on each finding and revises it. The review runs on the server: you can leave and get
          one notification when it ends.
        </p>
        {unavailableReason ? <p className="v2-answer-review-dialog-note" role="status">{unavailableReason}</p> : null}
        <button aria-checked={enabled} className="v2-answer-review-switch v2-focusable" disabled={busy} onClick={() => setEnabled((value) => !value)}
          ref={initialFocusRef} role="switch" type="button">
          <span>{mode === "defaults" ? "Review answers in new chats" : "Review answers automatically"}</span>
          <span className="v2-answer-review-switch-state">
            <strong>{enabled ? "On" : "Off"}</strong>
            <span aria-hidden="true" className="v2-answer-review-switch-track" />
          </span>
        </button>
        <fieldset disabled={busy}>
          <legend>Reviewers, in order</legend>
          {candidates.length === 0 ? (
            <p className="v2-answer-review-dialog-note" role="status">No other model that can use tools is available to review.</p>
          ) : (
            <ul>
              {candidates.map((model) => {
                const position = reviewers.findIndex((pick) => sameModel(pick, model));
                const checked = position >= 0;
                return (
                  <li key={`${model.provider}:${model.modelId}`}>
                    <label className="v2-answer-review-dialog-option" data-checked={checked || undefined}>
                      <input
                        checked={checked}
                        disabled={!checked && reviewers.length >= ANSWER_REVIEW_PICK_LIMIT}
                        onChange={() => toggle(model)}
                        type="checkbox"
                      />
                      <span>{model.displayName}</span>
                      {checked && reviewers.length > 1 ? <small>{position === 0 ? "First" : "Second"}</small> : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
        <fieldset disabled={busy}>
          <legend id={roundsId}>Rounds</legend>
          <div aria-labelledby={roundsId} className="v2-answer-review-rounds" role="radiogroup">
            {ROUNDS.map((value) => (
              <label key={value} className="v2-answer-review-round" data-selected={value === maxRounds || undefined}>
                <input checked={value === maxRounds} name={roundsId} onChange={() => setMaxRounds(value)} type="radio" value={value} />
                <span>{value === 1 ? "1 round" : `Up to ${value}`}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="v2-answer-review-dialog-hint" data-testid="answer-review-cost-hint">
          {answerReviewAutoCostHintV2({ maxRounds, reviewers })}. Each review step counts toward your usage; a round
          that finds no substantive issue ends the review early.
        </p>
        {missingReviewer ? <p className="v2-answer-review-dialog-error" role="alert">Choose at least one reviewer.</p> : null}
        {error ? <p className="v2-answer-review-dialog-error" role="alert">{error}</p> : null}
        <div className="v2-answer-review-dialog-actions">
          <UiV2Button disabled={busy} onClick={close} type="button">Cancel</UiV2Button>
          <UiV2Button busy={busy} disabled={missingReviewer} onClick={() => onSave({ enabled, maxRounds, reviewers })}
            tone="primary" type="button">
            Save
          </UiV2Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
