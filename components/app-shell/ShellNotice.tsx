import type { Notice, NoticeAction } from "@/components/app-shell/types";
import { UiV2Button, UiV2Icon, UiV2IconButton } from "@/components/ui-v2";
import { useEffect, useRef } from "react";

function NoticeActionButton({ action }: { action: NoticeAction }) {
  return (
    <UiV2Button
      className="v2-notice-action"
      disabled={action.disabled}
      tone={action.tone === "destructive" ? "destructive" : "ghost"}
      onClick={action.onClick}
    >
      {action.label}
    </UiV2Button>
  );
}

/**
 * The shell's one transient notice (UX audit 2026-09-02 C5): a Signal
 * surface with a kind icon, the text, an optional link and actions, and a
 * close control. Success notices and opted-in errors leave after five
 * seconds; other errors and persistent notices wait for the user.
 */
export function ShellNotice({
  interactive = true,
  notice,
  onDismiss
}: {
  interactive?: boolean;
  notice: Notice;
  onDismiss(): void;
}) {
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (notice.persistent || (notice.kind !== "success" && !notice.autoDismiss)) {
      return;
    }

    const timer = window.setTimeout(() => onDismissRef.current(), 5000);

    return () => window.clearTimeout(timer);
  }, [notice]);

  const actions = interactive ? [notice.secondaryAction, notice.action].filter(
    (action): action is NoticeAction => Boolean(action)
  ) : [];

  return (
    <div
      className="v2-notice"
      data-kind={notice.kind}
      role={notice.kind === "error" ? "alert" : "status"}
      aria-live={notice.kind === "error" ? "assertive" : "polite"}
      aria-busy={notice.action?.disabled || notice.secondaryAction?.disabled || undefined}
      data-testid={notice.href ? "share-link" : "shell-notice"}
    >
      <UiV2Icon className="v2-notice-icon" name={notice.kind === "error" ? "alert" : "check"} />
      <div className="v2-notice-body">
        <span className="v2-notice-text">{notice.text}</span>
        {notice.href && interactive ? (
          <a className="v2-notice-link v2-focusable" href={notice.href}>
            {notice.href}
          </a>
        ) : notice.href ? (
          <span className="v2-notice-link">{notice.href}</span>
        ) : null}
        {actions.length > 0 ? (
          <span className="v2-notice-actions">
            {actions.map((action) => <NoticeActionButton action={action} key={action.label} />)}
          </span>
        ) : null}
      </div>
      {interactive ? (
        <UiV2IconButton
          className="v2-notice-close"
          icon="close"
          label="Dismiss notice"
          onClick={onDismiss}
        />
      ) : null}
    </div>
  );
}
