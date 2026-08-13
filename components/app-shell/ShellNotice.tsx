import type { Notice, NoticeAction } from "@/components/app-shell/types";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";

function NoticeActionButton({
  action,
  noticeKind
}: {
  action: NoticeAction;
  noticeKind: Notice["kind"];
}) {
  return (
    <button
      className={[
        "inline-flex min-h-touch items-center rounded-control border px-2 font-medium outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-control-sm [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch",
        action.tone === "destructive"
          ? "border-critical/30 text-critical"
          : action.tone === "neutral"
            ? "border-trace-subtle text-ink"
            : noticeKind === "success"
              ? "border-positive/30"
              : "border-critical/30"
      ].join(" ")}
      disabled={action.disabled}
      type="button"
      onClick={action.onClick}
    >
      {action.label}
    </button>
  );
}

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

  return (
    <div
      className={[
        "flex max-h-[min(14rem,40dvh)] w-full max-w-2xl items-start justify-between gap-3 overflow-y-auto rounded-control border-l-2 bg-overlay-surface px-3 py-2 text-sm text-ink-secondary shadow-float",
        "pointer-events-auto",
        notice.kind === "success"
          ? "border-positive/45"
          : "border-critical/45"
      ].join(" ")}
      role={notice.kind === "error" ? "alert" : "status"}
      aria-live={notice.kind === "error" ? "assertive" : "polite"}
      aria-busy={notice.action?.disabled || notice.secondaryAction?.disabled || undefined}
      data-testid={notice.href ? "share-link" : "shell-notice"}
    >
      <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-words">{notice.text}</span>
        {notice.href && interactive ? (
          <a className="inline-flex min-h-touch min-w-0 items-center break-all text-proof underline-offset-2 hover:text-proof-hover hover:underline sm:min-h-control [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch" href={notice.href}>
            {notice.href}
          </a>
        ) : notice.href ? (
          <span className="min-w-0 break-all">{notice.href}</span>
        ) : null}
        {notice.secondaryAction && interactive ? (
          <NoticeActionButton action={notice.secondaryAction} noticeKind={notice.kind} />
        ) : null}
        {notice.action && interactive ? (
          <NoticeActionButton action={notice.action} noticeKind={notice.kind} />
        ) : null}
      </span>
      {interactive ? (
        <button
          className="grid size-11 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus sm:size-9 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
          type="button"
          aria-label="Dismiss notice"
          title="Dismiss notice"
          onClick={onDismiss}
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
