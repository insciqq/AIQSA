"use client";

import type { AdminFeedbackController } from "@/components/admin/useAdminFeedback";
import { UiV2Icon } from "@/components/ui-v2";
import { useEffect } from "react";

const NOTICE_DISMISS_MS = 6_000;
/** A notice that offers a verb (Undo) stays a little longer. */
const ACTIONABLE_NOTICE_DISMISS_MS = 10_000;

/**
 * Toast host for the one Control Center feedback store. A notice disappears
 * on its own; an error stays until closed or replaced so the administrator
 * can read it. Field errors stay inline in their forms.
 */
export function AdminFeedbackHost({
  feedback
}: Readonly<{
  feedback: Pick<AdminFeedbackController, "clearError" | "clearNotice" | "error" | "notice"> &
    Partial<Pick<AdminFeedbackController, "noticeAction">>;
}>) {
  const { clearNotice, notice } = feedback;
  const action = feedback.noticeAction ?? null;

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(
      clearNotice,
      action ? ACTIONABLE_NOTICE_DISMISS_MS : NOTICE_DISMISS_MS
    );
    return () => window.clearTimeout(timer);
  }, [action, clearNotice, notice]);

  if (!feedback.error && !notice) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-40 flex max-w-[min(28rem,calc(100vw-2rem))] flex-col items-end gap-2"
      data-testid="admin-feedback"
    >
      {notice ? (
        <div className="v2-toast pointer-events-auto" role="status">
          <UiV2Icon className="text-positive" name="check" />
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{notice}</span>
          {action ? (
            <>
              <span aria-hidden="true">·</span>
              <button
                className="v2-focusable"
                onClick={() => {
                  action.onSelect();
                  clearNotice();
                }}
                type="button"
              >
                {action.label}
              </button>
            </>
          ) : null}
          <button aria-label="Dismiss notice" className="v2-focusable ml-1" onClick={clearNotice} type="button">
            <UiV2Icon name="close" />
          </button>
        </div>
      ) : null}
      {feedback.error ? (
        <div className="v2-toast pointer-events-auto border-critical/40" role="alert">
          <UiV2Icon className="text-critical" name="alert" />
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{feedback.error}</span>
          <button
            aria-label="Dismiss error"
            className="v2-focusable ml-1"
            onClick={feedback.clearError}
            type="button"
          >
            <UiV2Icon name="close" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
