import type { Notice } from "@/components/app-shell/types";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";

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
    if (notice.kind !== "success" || notice.persistent) {
      return;
    }

    const timer = window.setTimeout(() => onDismissRef.current(), 5000);

    return () => window.clearTimeout(timer);
  }, [notice]);

  return (
    <div
      className={[
        "flex max-h-[min(14rem,40dvh)] w-full max-w-2xl items-start justify-between gap-3 overflow-y-auto rounded-panel border bg-surface-overlay px-3 py-2 text-sm shadow-float",
        "pointer-events-auto",
        notice.kind === "success"
          ? "border-accent-green/25 text-accent-green"
          : "border-accent-rose/25 text-accent-rose"
      ].join(" ")}
      role={notice.kind === "error" ? "alert" : "status"}
      aria-live={notice.kind === "error" ? "assertive" : "polite"}
      aria-busy={notice.action?.disabled || undefined}
      data-testid={notice.href ? "share-link" : "shell-notice"}
    >
      <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-words">{notice.text}</span>
        {notice.href && interactive ? (
          <a className="inline-flex min-h-touch min-w-0 items-center break-all underline-offset-2 hover:underline sm:min-h-control [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch" href={notice.href}>
            {notice.href}
          </a>
        ) : notice.href ? (
          <span className="min-w-0 break-all">{notice.href}</span>
        ) : null}
        {notice.action && interactive ? (
          <button
            className={[
              "inline-flex min-h-touch items-center rounded-control border px-2 font-medium outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-current/65 disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-control-sm [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch",
              notice.action.tone === "destructive"
                ? "border-accent-rose/30 text-accent-rose"
                : notice.kind === "success"
                  ? "border-accent-green/30"
                  : "border-accent-rose/30"
            ].join(" ")}
            disabled={notice.action.disabled}
            type="button"
            onClick={notice.action.onClick}
          >
            {notice.action.label}
          </button>
        ) : null}
      </span>
      {interactive ? (
        <button
          className="grid size-11 shrink-0 place-items-center rounded-control hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current/65 sm:size-9 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
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
