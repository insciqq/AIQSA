import {
  forwardRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode
} from "react";

export type UiV2IconName =
  | "archive"
  | "arrow-up"
  | "assistant"
  | "attach"
  | "book"
  | "branch"
  | "brand"
  | "check"
  | "chevron-down"
  | "chevron-right"
  | "close"
  | "copy"
  | "download"
  | "edit"
  | "file"
  | "folder"
  | "history"
  | "library"
  | "lock"
  | "menu"
  | "memory"
  | "monitor"
  | "moon"
  | "more"
  | "plus"
  | "regenerate"
  | "search"
  | "sliders"
  | "settings"
  | "stop"
  | "sun"
  | "slides"
  | "table"
  | "tool";

export function UiV2IconSprite() {
  return (
    <svg aria-hidden="true" className="absolute size-0 overflow-hidden">
      <defs>
        <symbol id="v2-icon-archive" viewBox="0 0 24 24">
          <path d="M4 8h16v12H4zM3 4h18v4H3zM9 12h6" />
        </symbol>
        <symbol id="v2-icon-arrow-up" viewBox="0 0 24 24">
          <path d="M12 19V5M6.5 10.5 12 5l5.5 5.5" />
        </symbol>
        <symbol id="v2-icon-assistant" viewBox="0 0 24 24">
          <circle cx="12" cy="8" r="4" />
          <path d="M4.5 21a7.5 7.5 0 0 1 15 0M18.5 3.5v3M17 5h3" />
        </symbol>
        <symbol id="v2-icon-attach" viewBox="0 0 24 24">
          <path d="m20.5 11.5-8.4 8.4a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7L9.3 17a2 2 0 1 1-2.8-2.8l8.5-8.5" />
        </symbol>
        <symbol id="v2-icon-brand" viewBox="0 0 24 24">
          <rect x="3.5" y="3.5" width="14" height="14" rx="4.5" />
          <path d="M12.5 12.5 21 21" />
        </symbol>
        <symbol id="v2-icon-branch" viewBox="0 0 24 24">
          <circle cx="6" cy="5" r="2" />
          <circle cx="18" cy="7" r="2" />
          <circle cx="18" cy="18" r="2" />
          <path d="M8 5h2a4 4 0 0 1 4 4v5a4 4 0 0 0 4 4M14 10a3 3 0 0 1 3-3h1M6 7v12" />
        </symbol>
        <symbol id="v2-icon-book" viewBox="0 0 24 24">
          <path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H12v18H7.5A3.5 3.5 0 0 0 4 23zM20 5.5A3.5 3.5 0 0 0 16.5 2H12v18h4.5A3.5 3.5 0 0 1 20 23z" />
        </symbol>
        <symbol id="v2-icon-check" viewBox="0 0 24 24">
          <path d="m5 12.5 4.2 4.2L19 7" />
        </symbol>
        <symbol id="v2-icon-chevron-down" viewBox="0 0 24 24">
          <path d="m6 9 6 6 6-6" />
        </symbol>
        <symbol id="v2-icon-chevron-right" viewBox="0 0 24 24">
          <path d="m9 6 6 6-6 6" />
        </symbol>
        <symbol id="v2-icon-close" viewBox="0 0 24 24">
          <path d="m6 6 12 12M18 6 6 18" />
        </symbol>
        <symbol id="v2-icon-copy" viewBox="0 0 24 24">
          <rect x="8" y="8" width="11" height="11" rx="2" />
          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
        </symbol>
        <symbol id="v2-icon-download" viewBox="0 0 24 24">
          <path d="M12 3v12m-5-5 5 5 5-5M5 21h14" />
        </symbol>
        <symbol id="v2-icon-edit" viewBox="0 0 24 24">
          <path d="M13.5 6.5 17.5 10.5M4 20l4.3-1 10.9-10.9a2.8 2.8 0 0 0-4-4L4.3 15 4 20Z" />
        </symbol>
        <symbol id="v2-icon-file" viewBox="0 0 24 24">
          <path d="M6 3h8l4 4v14H6zM14 3v5h5M9 13h6M9 17h6" />
        </symbol>
        <symbol id="v2-icon-folder" viewBox="0 0 24 24">
          <path d="M3 6.5h6l2 2h10v10H3z" />
        </symbol>
        <symbol id="v2-icon-history" viewBox="0 0 24 24">
          <path d="M4 5v5h5M5.6 9.2A8 8 0 1 1 4 14M12 8v5l3 2" />
        </symbol>
        <symbol id="v2-icon-library" viewBox="0 0 24 24">
          <path d="M5 4h3v16H5zM10.5 4h3v16h-3zM16 5l3-.8L22 19l-3 .8z" />
        </symbol>
        <symbol id="v2-icon-lock" viewBox="0 0 24 24">
          <rect x="5" y="10" width="14" height="10" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </symbol>
        <symbol id="v2-icon-menu" viewBox="0 0 24 24">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </symbol>
        <symbol id="v2-icon-memory" viewBox="0 0 24 24">
          <rect x="6" y="6" width="12" height="12" rx="2" />
          <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M18 9h4M2 15h4M18 15h4M10 10h4v4h-4z" />
        </symbol>
        <symbol id="v2-icon-monitor" viewBox="0 0 24 24">
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </symbol>
        <symbol id="v2-icon-moon" viewBox="0 0 24 24">
          <path d="M20.5 15.2A8.5 8.5 0 0 1 8.8 3.5 8.5 8.5 0 1 0 20.5 15.2Z" />
        </symbol>
        <symbol id="v2-icon-more" viewBox="0 0 24 24">
          <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" />
        </symbol>
        <symbol id="v2-icon-plus" viewBox="0 0 24 24">
          <path d="M12 5v14M5 12h14" />
        </symbol>
        <symbol id="v2-icon-regenerate" viewBox="0 0 24 24">
          <path d="M20 7v5h-5M4 17v-5h5" />
          <path d="M6.1 8.5A7 7 0 0 1 18.5 7M17.9 15.5A7 7 0 0 1 5.5 17" />
        </symbol>
        <symbol id="v2-icon-search" viewBox="0 0 24 24">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 5 5" />
        </symbol>
        <symbol id="v2-icon-sliders" viewBox="0 0 24 24">
          <path d="M4 6h8M16 6h4M4 12h3M11 12h9M4 18h10M18 18h2" />
          <circle cx="14" cy="6" r="2" />
          <circle cx="9" cy="12" r="2" />
          <circle cx="16" cy="18" r="2" />
        </symbol>
        <symbol id="v2-icon-settings" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" />
        </symbol>
        <symbol id="v2-icon-stop" viewBox="0 0 24 24">
          <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />
        </symbol>
        <symbol id="v2-icon-sun" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
        </symbol>
        <symbol id="v2-icon-slides" viewBox="0 0 24 24">
          <rect x="3" y="5" width="18" height="13" rx="2" />
          <path d="M8 21h8M12 18v3M7 14l3-3 2 2 4-5" />
        </symbol>
        <symbol id="v2-icon-table" viewBox="0 0 24 24">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18M9 9v11M15 9v11M3 14h18" />
        </symbol>
        <symbol id="v2-icon-tool" viewBox="0 0 24 24">
          <path d="M14.5 6.5a4 4 0 0 0-5-5l2.2 2.2-3 3-2.2-2.2a4 4 0 0 0 5 5L19 17l-2 2-7.5-7.5" />
        </symbol>
      </defs>
    </svg>
  );
}

export function UiV2Icon({ name }: { name: UiV2IconName }) {
  return (
    <svg className="v2-icon" aria-hidden="true">
      <use href={`#v2-icon-${name}`} />
    </svg>
  );
}

type UiV2ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  icon?: UiV2IconName;
  tone?: "destructive" | "ghost" | "primary";
};

export const UiV2Button = forwardRef<HTMLButtonElement, UiV2ButtonProps>(
  function UiV2Button(
    { busy = false, children, className = "", disabled, icon, tone = "ghost", ...props },
    ref
  ) {
    return (
      <button
        {...props}
        ref={ref}
        className={`v2-button v2-focusable ${className}`.trim()}
        data-busy={busy || undefined}
        data-tone={tone}
        aria-busy={busy || undefined}
        disabled={disabled || busy}
      >
        {busy ? <span className="v2-spinner" aria-hidden="true" /> : icon ? <UiV2Icon name={icon} /> : null}
        <span>{children}</span>
      </button>
    );
  }
);

type UiV2IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: UiV2IconName;
  label: string;
  round?: boolean;
};

export const UiV2IconButton = forwardRef<HTMLButtonElement, UiV2IconButtonProps>(
  function UiV2IconButton(
    { className = "", icon, label, round = false, title = label, type = "button", ...props },
    ref
  ) {
    return (
      <button
        {...props}
        type={type}
        ref={ref}
        className={`v2-icon-button v2-focusable ${className}`.trim()}
        data-round={round || undefined}
        aria-label={label}
        title={title}
      >
        <UiV2Icon name={icon} />
      </button>
    );
  }
);

export const UiV2MenuSurface = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & { label: string }
>(function UiV2MenuSurface({ children, className = "", label, ...props }, ref) {
  return (
    <div
      {...props}
      ref={ref}
      className={`v2-menu ${className}`.trim()}
      role="menu"
      aria-label={label}
    >
      {children}
    </div>
  );
});

export function UiV2MenuItem({
  children,
  selected = false,
  sub,
  tone,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  selected?: boolean;
  sub?: string;
  /** Destructive items keep their place in the menu but read in the danger color. */
  tone?: "destructive";
}) {
  return (
    <button
      {...props}
      className="v2-menu-item v2-focusable"
      role="menuitem"
      aria-current={selected ? "true" : undefined}
      data-tone={tone}
    >
      <span>
        {children}
        {sub ? <span className="v2-menu-item-sub">{sub}</span> : null}
      </span>
      {selected ? <span className="v2-menu-item-check"><UiV2Icon name="check" /></span> : null}
    </button>
  );
}

/**
 * A navigation entry inside a menu: the same metrics as a menu item, but a
 * real link (it keeps the link role so it reads as navigation, not a command).
 */
export function UiV2MenuLink({
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a {...props} className="v2-menu-item v2-focusable">
      <span>{children}</span>
    </a>
  );
}

/** Visual group boundary inside a menu surface. */
export function UiV2MenuSeparator() {
  return <div className="v2-menu-separator" role="separator" />;
}

export function UiV2Chip({
  children,
  tone = "neutral"
}: {
  children: ReactNode;
  tone?: "danger" | "neutral" | "ok" | "warn";
}) {
  return <span className="v2-chip" data-tone={tone}>{children}</span>;
}

export function UiV2Skeleton({ className = "" }: { className?: string }) {
  return <span className={`v2-skeleton ${className}`.trim()} aria-hidden="true" />;
}

export function UiV2Toast({
  action,
  children,
  onAction
}: {
  action?: string;
  children: ReactNode;
  onAction?(): void;
}) {
  return (
    <div className="v2-toast" role="status">
      <span>{children}</span>
      {action ? (
        <>
          <span aria-hidden="true">·</span>
          <button className="v2-focusable" type="button" onClick={onAction}>
            {action}
          </button>
        </>
      ) : null}
    </div>
  );
}
