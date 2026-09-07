"use client";

import { UiV2IconButton } from "@/components/ui-v2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import { useId, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type AdminSheetProps = Readonly<{
  children: ReactNode;
  /** Keeps Escape and the scrim from closing while a save is in flight. */
  closeBlocked?: boolean;
  description?: ReactNode;
  footer?: ReactNode;
  onClose(): void;
  open: boolean;
  testId: string;
  title: string;
  /** 520 px by default; `wide` is the 600 px editor sheet. */
  width?: "narrow" | "wide";
}>;

function AdminSheetLayer({
  children,
  closeBlocked = false,
  description,
  footer,
  onClose,
  testId,
  title,
  width = "narrow"
}: Omit<AdminSheetProps, "open">) {
  const titleId = useId();
  const descriptionId = useId();
  const { dialogRef, initialFocusRef, onDialogKeyDown, portalReady } = useModalLayerV2({ closeBlocked, onClose });
  if (!portalReady) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" data-testid={testId}>
      <button
        aria-label="Dismiss"
        className="absolute inset-0 bg-scrim/70"
        disabled={closeBlocked}
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <aside
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className={`relative flex h-full w-full flex-col border-l border-trace-strong bg-answer-paper text-ink shadow-overlay ${
          width === "wide" ? "sm:w-[37.5rem]" : "sm:w-[32.5rem]"
        }`}
        onKeyDown={onDialogKeyDown}
        ref={dialogRef as React.RefObject<HTMLElement>}
        role="dialog"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-trace-subtle px-6 py-4">
          <div className="min-w-0">
            <h2 className="break-words text-base font-semibold [overflow-wrap:anywhere]" id={titleId}>{title}</h2>
            {description ? (
              <p className="mt-1 text-xs leading-5 text-ink-muted" id={descriptionId}>{description}</p>
            ) : null}
          </div>
          <UiV2IconButton
            disabled={closeBlocked}
            icon="close"
            label="Close"
            onClick={onClose}
            ref={initialFocusRef}
          />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5">{children}</div>
        {footer ? (
          <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-trace-subtle px-6 py-3.5">
            {footer}
          </footer>
        ) : null}
      </aside>
    </div>,
    document.body
  );
}

/**
 * Right-hand editor sheet over the current Control Center page (PRD 3.1):
 * one modal layer with a scrim, focus containment, Escape, inert background
 * and focus restoration. Mount it only while open so the modal layer never
 * inerts the page without a dialog to hand focus to.
 */
export function AdminSheet(props: AdminSheetProps) {
  if (!props.open) return null;
  const { open: _open, ...layerProps } = props;
  return <AdminSheetLayer {...layerProps} />;
}
