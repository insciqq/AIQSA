"use client";

import type { ProviderStatusTone } from "@/components/admin/providers/providerListView";
import {
  UiV2IconButton,
  UiV2MenuActions,
  UiV2Monogram,
  UiV2ProviderMark,
  type UiV2MenuAction
} from "@/components/ui-v2";
import { UiV2ResponsiveMenu } from "@/components/ui-v2/ResponsiveMenuV2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { useState, type CSSProperties, type ReactNode } from "react";

const pillTone: Record<ProviderStatusTone, string> = {
  neutral: "border-trace-subtle bg-control-surface text-ink-secondary",
  ok: "border-positive/25 bg-positive/10 text-positive",
  warn: "border-caution/25 bg-caution/10 text-caution"
};

/** Status pill sized to its word (PRD 5.2): a dot plus one of the four status words. */
export function ProviderStatusPill({
  label,
  tone
}: Readonly<{ label: string; tone: ProviderStatusTone }>) {
  return (
    <span
      className={`inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border px-2 text-metadata font-semibold ${pillTone[tone]}`}
      data-status-tone={tone}
      data-testid="provider-status"
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

/** Small `Used as` / `Default key` tag; the accent tone marks the installation default. */
export function ProviderTag({
  accent = false,
  children,
  className = ""
}: Readonly<{ accent?: boolean; children: ReactNode; className?: string }>) {
  return (
    <span
      className={[
        "inline-flex h-5 max-w-full shrink-0 items-center whitespace-nowrap rounded-[6px] border px-1.5 text-metadata font-medium",
        accent
          ? "border-proof/25 bg-proof/10 text-proof"
          : "border-trace-subtle bg-control-surface text-ink-secondary",
        className
      ].join(" ")}
    >
      {children}
    </span>
  );
}

/**
 * The provider tile: a monochrome vendor mark for built-in families and the
 * name's monogram for custom endpoints (the artboards' `OA` / `C` tiles).
 */
export function ProviderAvatar({
  family,
  label,
  size = "row"
}: Readonly<{ family: string; label: string; size?: "header" | "row" }>) {
  const dimensions = size === "header" ? "size-11 rounded-[10px]" : "size-8 rounded-[8px]";
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center border border-trace-strong bg-answer-paper text-ink-secondary ${dimensions}`}
      style={{
        "--v2-monogram-size": size === "header" ? "1.5rem" : "1.125rem",
        "--v2-provider-mark-size": size === "header" ? "1.375rem" : "1rem"
      } as CSSProperties}
    >
      {family === "openai_compatible"
        ? <UiV2Monogram className="border-0 bg-transparent" label={label} />
        : <UiV2ProviderMark family={family} label={label} />}
    </span>
  );
}

/** The `⋯` menu on a row: 3–5 actions behind one control. */
export function ProviderRowMenu({
  actions,
  label,
  tooltipSide
}: Readonly<{ actions: readonly UiV2MenuAction[]; label: string; tooltipSide?: "top" }>) {
  const [open, setOpen] = useState(false);
  const { closeForAction, menuRef, triggerRef } = useMenuDismissalV2({ onClose: () => setOpen(false), open });
  return (
    <div className="relative">
      <UiV2IconButton
        aria-expanded={open}
        aria-haspopup="menu"
        icon="more"
        label={label}
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        tooltip="More"
        tooltipSide={tooltipSide}
      />
      {open ? (
        <UiV2ResponsiveMenu anchorRef={triggerRef} label={label} menuRef={menuRef} onClose={() => setOpen(false)}>
          <UiV2MenuActions actions={actions} onClose={closeForAction} />
        </UiV2ResponsiveMenu>
      ) : null}
    </div>
  );
}
