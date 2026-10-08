"use client";

import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { UiV2Button } from "@/components/ui-v2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import { ANSWER_REVIEW_PICK_LIMIT, type AnswerReviewCatalogModelV2 } from "./answerReviewModel";
import "./answer-review.css";

export type AnswerReviewReviewerPick = Readonly<{ modelId: string; provider: string }>;

function sameModel(left: AnswerReviewReviewerPick, right: AnswerReviewReviewerPick): boolean {
  return left.provider === right.provider && left.modelId === right.modelId;
}

/**
 * Exactly the identity a round request names. An earlier session's reviewer
 * also carries its display name, which the request's strict decoding refuses.
 */
function pickOf(model: AnswerReviewReviewerPick): AnswerReviewReviewerPick {
  return { modelId: model.modelId, provider: model.provider };
}

/**
 * The small picker that starts a review round: one or two other models that
 * can use tools, in the order chosen (the second reviewer sees the first's
 * review). The author's own model is never offered.
 */
export function AnswerReviewDialogV2({
  busy = false,
  candidates,
  error = null,
  initial = [],
  onCancel,
  onStart
}: Readonly<{
  busy?: boolean;
  candidates: readonly AnswerReviewCatalogModelV2[];
  error?: string | null;
  /** The previous choice, kept where its models are still offered. */
  initial?: readonly AnswerReviewReviewerPick[];
  onCancel(): void;
  onStart(reviewers: readonly AnswerReviewReviewerPick[]): void;
}>) {
  const titleId = useId();
  const descriptionId = useId();
  const [selected, setSelected] = useState<AnswerReviewReviewerPick[]>(() => {
    const kept = initial.filter((pick) => candidates.some((model) => sameModel(model, pick))).slice(0, ANSWER_REVIEW_PICK_LIMIT)
      .map(pickOf);
    return kept.length ? kept : candidates[0] ? [pickOf(candidates[0])] : [];
  });
  const close = () => {
    if (!busy) onCancel();
  };
  const { dialogRef, initialFocusRef, onDialogKeyDown, portalReady } = useModalLayerV2({ closeBlocked: busy, onClose: close });
  if (!portalReady) return null;
  const toggle = (model: AnswerReviewCatalogModelV2) => setSelected((current) => current.some((pick) => sameModel(pick, model))
    ? current.filter((pick) => !sameModel(pick, model))
    : current.length < ANSWER_REVIEW_PICK_LIMIT ? [...current, pickOf(model)] : current);
  return createPortal(
    <div className="v2-answer-review-dialog-scrim" data-testid="answer-review-dialog" role="presentation" onMouseDown={close}>
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
        <h2 id={titleId}>Review with another model</h2>
        <p id={descriptionId}>
          Choose one or two models to check this answer. They use this chat&apos;s tools only to verify it; then this
          answer&apos;s model decides on each finding and can revise it. Each review step counts toward your usage.
        </p>
        <fieldset disabled={busy}>
          <legend>Reviewers, in order</legend>
          <ul>
            {candidates.map((model) => {
              const position = selected.findIndex((pick) => sameModel(pick, model));
              const checked = position >= 0;
              return (
                <li key={`${model.provider}:${model.modelId}`}>
                  <label className="v2-answer-review-dialog-option" data-checked={checked || undefined}>
                    <input
                      checked={checked}
                      disabled={!checked && selected.length >= ANSWER_REVIEW_PICK_LIMIT}
                      onChange={() => toggle(model)}
                      type="checkbox"
                    />
                    <span>{model.displayName}</span>
                    {checked && selected.length > 1 ? <small>{position === 0 ? "First" : "Second"}</small> : null}
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
        {error ? <p className="v2-answer-review-dialog-error" role="alert">{error}</p> : null}
        <div className="v2-answer-review-dialog-actions">
          <UiV2Button disabled={busy} onClick={close} ref={initialFocusRef} type="button">Cancel</UiV2Button>
          <UiV2Button busy={busy} disabled={selected.length === 0} onClick={() => onStart(selected.map(pickOf))} tone="primary" type="button">
            Start review
          </UiV2Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
