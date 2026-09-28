"use client";

import { AdminAssistantTile, RequestStatusChip } from "@/components/admin/assistants/adminAssistantsPrimitives";
import {
  AdminAssistantsRequestError,
  decideAdminAssistantRequest,
  loadAdminAssistantRequest,
  setAdminAssistantFeatured
} from "@/components/admin/assistants/adminAssistantsApi";
import {
  adminAssistantsErrorMessage,
  assistantSetupRows,
  categoryLabel,
  formatAssistantDate,
  isAbortError,
  policyLabel
} from "@/components/admin/assistants/adminAssistantsPresentation";
import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import { UiV2Sheet } from "@/components/ui-v2/SheetV2";
import type { AdminAssistantDefinitionReview, AdminAssistantListingRequestDetail } from "@/lib/contracts/adminAssistants";
import { ASSISTANT_FEATURED_LIMIT, ASSISTANT_LISTING_REVIEW_NOTE_MAX_LENGTH } from "@/lib/contracts/assistantListing";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

const readOnlyText = "whitespace-pre-wrap break-words rounded-lg border border-trace-subtle bg-control-surface p-3 text-sm leading-6 text-ink-secondary [overflow-wrap:anywhere]";

function ReviewSection({ children, title }: Readonly<{ children: ReactNode; title: string }>) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-ink" id={headingId}>{title}</h3>
      {children}
    </section>
  );
}

function ReadOnlyBlock({ empty, testId, value }: Readonly<{ empty: string; testId: string; value: string }>) {
  return value.trim()
    ? <div className={readOnlyText} data-testid={`admin-assistant-review-${testId}`}>{value}</div>
    : <p className="text-sm text-ink-muted">{empty}</p>;
}

/** What a person sees in the Assistant's detail sheet, plus the read-only prompt layers a reviewer needs. */
function DefinitionReview({ definition, ownerDisplayName, updatedAt }: Readonly<{
  definition: AdminAssistantDefinitionReview;
  ownerDisplayName: string;
  updatedAt: string;
}>) {
  const category = categoryLabel(definition.category);
  return (
    <div className="flex flex-col gap-6" data-testid="admin-assistant-review-definition">
      <header className="flex min-w-0 items-start gap-4">
        <AdminAssistantTile avatar={definition.avatar} name={definition.name} size={64} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="break-words text-lg font-semibold text-ink [overflow-wrap:anywhere]">{definition.name}</p>
          {definition.description ? (
            <p className="break-words text-sm leading-6 text-ink-secondary [overflow-wrap:anywhere]">{definition.description}</p>
          ) : null}
          <p className="text-xs text-ink-muted">By {ownerDisplayName} · Updated {formatAssistantDate(updatedAt)} · Version {definition.version}</p>
          {category ? (
            <span className="mt-1 inline-flex h-5 w-fit items-center rounded-pill border border-trace-subtle bg-control-surface px-2 text-metadata font-medium text-ink-secondary">
              {category}
            </span>
          ) : null}
        </div>
      </header>
      <ReviewSection title="Conversation starters">
        {definition.starterPrompts.length ? (
          <ul className="flex flex-wrap gap-2">
            {definition.starterPrompts.map((prompt, index) => (
              <li className="max-w-full break-words rounded-control border border-trace-subtle bg-control-surface px-3 py-1.5 text-xs text-ink-secondary [overflow-wrap:anywhere]" key={`${index}-${prompt}`}>
                {prompt}
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-ink-muted">No conversation starters.</p>}
      </ReviewSection>
      <ReviewSection title="Setup">
        <table className="w-full table-fixed border-collapse text-sm">
          <caption className="sr-only">Setup of {definition.name}</caption>
          <thead className="sr-only">
            <tr><th scope="col">Setting</th><th scope="col">Value</th><th scope="col">Policy</th></tr>
          </thead>
          <tbody className="divide-y divide-trace-subtle border-y border-trace-subtle">
            {assistantSetupRows(definition).map((row) => (
              <tr data-testid={`admin-assistant-setup-${row.label}`} key={row.label}>
                <th className="w-[38%] py-2.5 pr-3 text-left align-top font-medium text-ink sm:w-[30%]" scope="row">{row.label}</th>
                <td className="break-words py-2.5 pr-3 align-top text-ink-secondary [overflow-wrap:anywhere]">{row.value}</td>
                <td className="w-[7.5rem] py-2.5 text-right align-top text-xs text-ink-muted">
                  <span className="inline-flex items-center gap-1">
                    <UiV2Icon name={row.policy === "fixed" ? "lock" : "edit"} />
                    {policyLabel(row.policy)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ReviewSection>
      <ReviewSection title="Instructions">
        <ReadOnlyBlock empty="No instructions." testId="instructions" value={definition.instructions} />
      </ReviewSection>
      <ReviewSection title="Answer rules">
        <ReadOnlyBlock empty="Standard AIQSA answer rules." testId="answer-rules" value={definition.answerRules} />
      </ReviewSection>
      <ReviewSection title="Response reminder">
        <ReadOnlyBlock empty="No response reminder." testId="response-reminder" value={definition.responseReminder} />
      </ReviewSection>
    </div>
  );
}

type Decision = Readonly<{ action: "approve" | "reject"; notified: boolean }>;

export type AdminAssistantRequestSheetProps = Readonly<{
  /** Reports a committed decision or Featured change so the lists and counts reload. */
  onChanged(): void;
  onClose(): void;
  requestId: string;
}>;

/**
 * Review of one listing request in a wide sheet. The request id stays in the
 * URL, so the sheet reopens after reload; the definition is shown only while
 * the request can still be decided (the server returns it only then).
 */
export function AdminAssistantRequestSheet({ onChanged, onClose, requestId }: AdminAssistantRequestSheetProps) {
  const [detail, setDetail] = useState<AdminAssistantListingRequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<{ gone: boolean; message: string } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "feature" | "reject" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [featuredAt, setFeaturedAt] = useState<number | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const active = useRef(true);
  const pending = useRef<AbortController | null>(null);
  const noteId = useId();
  const noteCountId = useId();
  const noteHelpId = useId();

  const fetchDetail = useCallback(() => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    loadAdminAssistantRequest(requestId, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setDetail(result); })
      .catch((failure: unknown) => {
        if (controller.signal.aborted || isAbortError(failure)) return;
        const gone = failure instanceof AdminAssistantsRequestError && failure.code === "assistant_listing_request_not_available";
        // A request that was decided or withdrawn elsewhere no longer shows its old buttons.
        if (gone) setDetail(null);
        setLoadError({ gone, message: adminAssistantsErrorMessage(failure) });
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
  }, [requestId]);

  useEffect(() => {
    active.current = true;
    fetchDetail();
    return () => {
      active.current = false;
      pending.current?.abort();
    };
  }, [fetchDetail]);

  const load = () => {
    setLoading(true);
    setLoadError(null);
    fetchDetail();
  };

  const noteLength = [...note].length;
  const noteTooLong = noteLength > ASSISTANT_LISTING_REVIEW_NOTE_MAX_LENGTH;
  const canDecide = Boolean(detail?.canReview && detail.definition && !decision);

  const requestClose = () => {
    if (busy) return;
    if (canDecide && note.trim()) {
      setDiscarding(true);
      return;
    }
    onClose();
  };

  async function decide(action: "approve" | "reject") {
    if (!detail || !canDecide || busy || noteTooLong) return;
    setBusy(action);
    setActionError(null);
    const trimmed = note.trim();
    try {
      await decideAdminAssistantRequest(detail.id, { action, ...(trimmed ? { note: trimmed } : {}) });
      if (!active.current) return;
      setDecision({ action, notified: Boolean(trimmed) });
      setNote("");
      onChanged();
    } catch (failure) {
      if (!active.current) return;
      setActionError(adminAssistantsErrorMessage(failure));
      const code = failure instanceof AdminAssistantsRequestError ? failure.code : null;
      // The request moved on under us: show its current state instead of stale buttons.
      if (code === "assistant_listing_request_outdated" || code === "assistant_listing_request_conflict" ||
        code === "assistant_listing_request_not_available") {
        onChanged();
        load();
      }
    } finally {
      if (active.current) setBusy(null);
    }
  }

  async function feature() {
    if (!detail || busy || featuredAt !== null) return;
    setBusy("feature");
    setActionError(null);
    try {
      // The last slot appends: the server places it after every Featured Assistant.
      const featured = await setAdminAssistantFeatured(detail.assistantId, ASSISTANT_FEATURED_LIMIT - 1);
      if (!active.current) return;
      const position = featured.findIndex((item) => item.assistantId === detail.assistantId);
      setFeaturedAt(position >= 0 ? position + 1 : featured.length);
      onChanged();
    } catch (failure) {
      if (active.current) setActionError(adminAssistantsErrorMessage(failure));
    } finally {
      if (active.current) setBusy(null);
    }
  }

  const status = decision
    ? decision.action === "approve" ? "approved" : "rejected"
    : detail?.outdated ? "outdated" : "pending";

  const footer = canDecide ? (
    <>
      <UiV2Button busy={busy === "approve"} disabled={busy !== null || noteTooLong} onClick={() => void decide("approve")} tone="primary" type="button">
        Approve
      </UiV2Button>
      <UiV2Button busy={busy === "reject"} disabled={busy !== null || noteTooLong} onClick={() => void decide("reject")} tone="destructive" type="button">
        Reject
      </UiV2Button>
    </>
  ) : decision?.action === "approve" && featuredAt === null ? (
    <>
      <UiV2Button busy={busy === "feature"} disabled={busy !== null} icon="star" onClick={() => void feature()} tone="primary" type="button">
        Feature it
      </UiV2Button>
      <UiV2Button disabled={busy !== null} onClick={requestClose} type="button">Done</UiV2Button>
    </>
  ) : decision ? (
    <UiV2Button disabled={busy !== null} onClick={requestClose} type="button">Done</UiV2Button>
  ) : undefined;

  return (
    <UiV2Sheet
      closeBlocked={busy !== null}
      description="Approving lists this Assistant for everyone in this installation."
      footer={footer}
      onClose={requestClose}
      open
      testId="admin-assistant-request-sheet"
      title="Review listing request"
      width="wide"
    >
      <div className="flex flex-col gap-5">
        {loading && !detail ? <p className="text-sm text-ink-muted" role="status">Loading request…</p> : null}
        {loadError ? (
          <div className="flex flex-col items-start gap-3 text-sm" role="alert">
            <p className={loadError.gone ? "text-ink-secondary" : "text-critical"}>{loadError.message}</p>
            {loadError.gone ? null : <UiV2Button disabled={loading} onClick={load} type="button">Try again</UiV2Button>}
          </div>
        ) : null}
        {detail ? (
          <>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2" data-request-status={status} data-testid="admin-assistant-review-status">
              <RequestStatusChip status={status} />
              <p className="min-w-0 text-xs text-ink-muted">
                Requested {formatAssistantDate(detail.createdAt)} for version {detail.definitionVersion}
              </p>
            </div>
            {decision ? (
              <div className="rounded-lg border border-trace-subtle bg-control-surface p-3 text-sm text-ink-secondary" role="status">
                {decision.action === "approve" ? (
                  <p>
                    {detail.name} is now listed for everyone.
                    {featuredAt !== null ? ` It is Featured at #${featuredAt}.` : " Feature it to show it among Featured Assistants for everyone."}
                  </p>
                ) : (
                  <p>Request rejected.{decision.notified ? " The owner can read your note in Sharing." : ""}</p>
                )}
              </div>
            ) : null}
            {detail.definition ? (
              <DefinitionReview definition={detail.definition} ownerDisplayName={detail.ownerDisplayName} updatedAt={detail.updatedAt} />
            ) : (
              <div className="flex flex-col gap-4">
                <header className="flex min-w-0 items-center gap-4">
                  <AdminAssistantTile avatar={detail.avatar} name={detail.name} size={64} />
                  <div className="min-w-0">
                    <p className="break-words text-lg font-semibold text-ink [overflow-wrap:anywhere]">{detail.name}</p>
                    <p className="text-xs text-ink-muted">By {detail.ownerDisplayName}</p>
                  </div>
                </header>
                <p className="text-sm leading-6 text-ink-secondary" data-testid="admin-assistant-review-unavailable">
                  {detail.outdated
                    ? "The owner changed this Assistant after asking to list it, so this request can no longer be decided and its definition is not available for review. The owner can send a new request from Sharing."
                    : "This request can no longer be decided, and its definition is not available for review."}
                </p>
              </div>
            )}
            {canDecide ? (
              <div className="flex flex-col gap-2 border-t border-trace-subtle pt-5">
                <label className="text-sm font-medium text-ink" htmlFor={noteId}>
                  Review note <span className="font-normal text-ink-muted">(optional)</span>
                </label>
                <textarea
                  aria-describedby={`${noteHelpId} ${noteCountId}`}
                  aria-invalid={noteTooLong || undefined}
                  className="min-h-28 w-full resize-y rounded-lg border border-control-boundary bg-answer-paper p-3 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-focus aria-[invalid=true]:border-critical disabled:text-ink-disabled"
                  disabled={busy !== null}
                  id={noteId}
                  onChange={(event) => setNote(event.currentTarget.value)}
                  value={note}
                />
                <p className="text-xs text-ink-muted" id={noteHelpId}>The owner sees this note with your decision.</p>
                <p className={`text-xs ${noteTooLong ? "text-critical" : "text-ink-muted"}`} id={noteCountId}>
                  {noteLength.toLocaleString()} / {ASSISTANT_LISTING_REVIEW_NOTE_MAX_LENGTH.toLocaleString()} characters
                </p>
              </div>
            ) : null}
            {actionError ? <p className="text-sm text-critical" role="alert">{actionError}</p> : null}
          </>
        ) : null}
      </div>
      {discarding ? (
        <ConfirmationDialog
          cancelLabel="Keep reviewing"
          confirmLabel="Discard note"
          dialogLabel="Discard review note"
          icon="x"
          onCancel={() => setDiscarding(false)}
          onConfirm={() => {
            setDiscarding(false);
            onClose();
          }}
          testId="admin-assistant-review-discard"
          title="Discard the review note?"
          tone="warning"
        >
          The request stays pending and the note you typed will be lost.
        </ConfirmationDialog>
      ) : null}
    </UiV2Sheet>
  );
}
