"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { UiV2Button } from "@/components/ui-v2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import {
  ANSWER_PROBLEM_REPORT_COMMENT_MAX,
  answerProblemReasonLabels,
  answerProblemReasons,
  type AnswerProblemReason
} from "@/lib/contracts/answerProblemReports";
import {
  loadAnswerProblemReport,
  sendAnswerProblemReport,
  type AnswerProblemReportLoadResult,
  type AnswerProblemReportRequestError,
  type AnswerProblemReportSendResult,
  type AnswerProblemReportTarget
} from "./answerProblemReportApi";
import "./answer-problem-report.css";

const errorCopy: Readonly<Record<AnswerProblemReportRequestError, string>> = {
  failed: "The report could not be sent. Try again.",
  invalid: "The report could not be sent. Shorten the comment and try again.",
  rate_limited: "You have sent many reports today. Try again tomorrow.",
  unauthorized: "Your session has ended. Sign in again to send the report.",
  unavailable: "This answer can no longer be reported."
};

/** Shown when the remaining comment length drops to this. */
const COUNTER_FROM = 100;

/**
 * "Report a problem…" on an answer: one reason, an optional comment and Send.
 * Reopening shows the saved report with Update. Nothing of the question or
 * the answer is sent; the notice under the comment says so.
 */
export function AnswerProblemReportDialogV2({
  load = loadAnswerProblemReport,
  onClose,
  onSent,
  restoreFocus,
  send = sendAnswerProblemReport,
  target
}: Readonly<{
  load?: (target: AnswerProblemReportTarget, signal?: AbortSignal) => Promise<AnswerProblemReportLoadResult>;
  onClose(): void;
  /** After a successful send; the dialog closes itself first. */
  onSent(outcome: "created" | "updated"): void;
  /** Where focus goes on close when the menu item that opened the dialog is gone. */
  restoreFocus?(): HTMLElement | null;
  send?: (target: AnswerProblemReportTarget, input: Readonly<{ comment: string | null; reason: AnswerProblemReason }>) =>
    Promise<AnswerProblemReportSendResult>;
  target: AnswerProblemReportTarget;
}>) {
  const titleId = useId();
  const descriptionId = useId();
  const legendId = useId();
  const commentId = useId();
  const noticeId = useId();
  const counterId = useId();
  const [reason, setReason] = useState<AnswerProblemReason | null>(null);
  const [comment, setComment] = useState("");
  const [saved, setSaved] = useState<"loading" | "none" | "saved">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AnswerProblemReportRequestError | null>(null);
  const touchedRef = useRef(false);
  const firstRadioRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const { chatId, messageId } = target;

  const close = () => {
    if (!busy) onClose();
  };
  const { dialogRef, onDialogKeyDown, portalReady } = useModalLayerV2({ closeBlocked: busy, onClose: close, restoreFocus });

  useEffect(() => {
    if (portalReady) firstRadioRef.current?.focus();
  }, [portalReady]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void load({ chatId, messageId }, controller.signal)
      .catch((): AnswerProblemReportLoadResult => ({ error: "failed", ok: false }))
      .then((result) => {
        if (!active) return;
        if (!result.ok) {
          // A failed read still lets the user send; an unavailable answer cannot be reported.
          setSaved("none");
          if (result.error === "unavailable" || result.error === "unauthorized") setError(result.error);
          return;
        }
        setSaved(result.report ? "saved" : "none");
        // The saved values fill the form unless the user already started a new one.
        if (result.report && !touchedRef.current) {
          setReason(result.report.reason);
          setComment(result.report.comment ?? "");
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [chatId, load, messageId]);

  if (!portalReady) return null;
  const blocked = error === "unavailable" || error === "unauthorized";
  const remaining = ANSWER_PROBLEM_REPORT_COMMENT_MAX - comment.length;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!reason || busy || blocked) return;
    setBusy(true);
    setError(null);
    void send({ chatId, messageId }, { comment: comment.trim() ? comment : null, reason })
      .catch((): AnswerProblemReportSendResult => ({ error: "failed", ok: false }))
      .then((result) => {
        setBusy(false);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        onClose();
        onSent(result.outcome);
      });
  };

  return createPortal(
    <div className="v2-problem-report-scrim" data-testid="answer-problem-report-dialog" role="presentation" onMouseDown={close}>
      <form
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="v2-problem-report-dialog pop-enter"
        noValidate
        onKeyDown={(event) => {
          // The reasons come first and Tab reaches only the checked one, so
          // Shift+Tab from any of them wraps to the last action.
          if (event.key === "Tab" && event.shiftKey && event.target instanceof HTMLInputElement && event.target.type === "radio") {
            event.preventDefault();
            (sendRef.current && !sendRef.current.disabled ? sendRef.current : cancelRef.current)?.focus();
            return;
          }
          onDialogKeyDown(event);
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
        ref={(node) => { dialogRef.current = node; }}
        role="dialog"
      >
        <h2 id={titleId}>Report a problem</h2>
        <p id={descriptionId}>Tell administrators what went wrong with this answer.</p>
        <fieldset aria-labelledby={legendId} disabled={busy || blocked} role="radiogroup">
          <legend id={legendId}>What went wrong?</legend>
          {answerProblemReasons.map((value, index) => (
            <label className="v2-problem-report-option" data-checked={reason === value || undefined} key={value}>
              <input
                checked={reason === value}
                name={`${titleId}-reason`}
                onChange={() => {
                  touchedRef.current = true;
                  setReason(value);
                  if (error === "invalid" || error === "failed" || error === "rate_limited") setError(null);
                }}
                ref={index === 0 ? firstRadioRef : undefined}
                type="radio"
                value={value}
              />
              <span>{answerProblemReasonLabels[value]}</span>
            </label>
          ))}
        </fieldset>
        <div className="v2-problem-report-comment">
          <label htmlFor={commentId}>Comment (optional)</label>
          <textarea
            aria-describedby={remaining <= COUNTER_FROM ? `${noticeId} ${counterId}` : noticeId}
            disabled={busy || blocked}
            id={commentId}
            maxLength={ANSWER_PROBLEM_REPORT_COMMENT_MAX}
            onChange={(event) => {
              touchedRef.current = true;
              setComment(event.target.value);
            }}
            rows={3}
            value={comment}
          />
          <p id={noticeId}>Administrators will see this report. Your question and the answer are not attached.</p>
          {remaining <= COUNTER_FROM ? (
            <p className="v2-problem-report-counter" id={counterId}>{remaining} characters left</p>
          ) : null}
        </div>
        {error ? <p className="v2-problem-report-error" role="alert">{errorCopy[error]}</p> : null}
        <div className="v2-problem-report-actions">
          <UiV2Button disabled={busy} onClick={close} ref={cancelRef} type="button">Cancel</UiV2Button>
          <UiV2Button busy={busy} disabled={!reason || blocked} ref={sendRef} tone="primary" type="submit">
            {saved === "saved" ? "Update" : "Send"}
          </UiV2Button>
        </div>
      </form>
    </div>,
    document.body
  );
}
