"use client";

import { touchTarget } from "@/components/admin/adminPrimitives";
import {
  UiV2IconButton,
  UiV2MenuActions,
  type UiV2MenuAction
} from "@/components/ui-v2";
import { UiV2ResponsiveMenu } from "@/components/ui-v2/ResponsiveMenuV2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { useState, type ReactNode } from "react";

export const fieldLabelClass = "mb-1 block text-xs font-medium text-ink-secondary";
export const helpTextClass = "mt-1 block text-xs leading-5 text-ink-muted";
export const sectionHeadingClass = "text-sm font-semibold text-ink";

/** Initials tile for a person (the artboards' `AA` / `PP` circles). */
export function UserAvatar({
  initials,
  size = "row"
}: Readonly<{ initials: string; size?: "header" | "row" }>) {
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-full border border-trace-strong bg-answer-paper font-semibold text-ink-secondary ${
        size === "header" ? "size-11 text-sm" : "size-8 text-incidental"
      }`}
    >
      {initials}
    </span>
  );
}

type UsersTagTone = "caution" | "critical" | "neutral";

const tagTone: Record<UsersTagTone, string> = {
  caution: "border-caution/25 bg-caution/10 text-caution",
  critical: "border-critical/25 bg-critical/10 text-critical",
  neutral: "border-trace-subtle bg-control-surface text-ink-secondary"
};

/** Small group tag or status word in a row; `dot` marks a state rather than a name. */
export function UsersTag({
  children,
  dot = false,
  tone = "neutral"
}: Readonly<{ children: ReactNode; dot?: boolean; tone?: UsersTagTone }>) {
  return (
    <span
      className={`inline-flex h-5 max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] border px-1.5 text-metadata font-medium ${tagTone[tone]}`}
      data-tone={tone}
    >
      {dot ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

const pillTone: Record<"accent" | "caution" | "critical" | "neutral" | "ok", string> = {
  accent: "border-proof/30 bg-proof/10 text-proof",
  caution: "border-caution/25 bg-caution/10 text-caution",
  critical: "border-critical/25 bg-critical/10 text-critical",
  neutral: "border-trace-subtle bg-control-surface text-ink-secondary",
  ok: "border-positive/25 bg-positive/10 text-positive"
};

/** Status pill for the user page header: a dot plus one status word. */
export function UserStatusPill({ status }: Readonly<{ status: "active" | "denied" | "disabled" | "pending" }>) {
  const tone = status === "active" ? "ok" : status === "pending" ? "caution" : status === "denied" ? "critical" : "neutral";
  const label = status === "active" ? "Active" : status === "pending" ? "Pending" : status === "denied" ? "Denied" : "Disabled";
  return (
    <span
      className={`inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border px-2 text-metadata font-semibold ${pillTone[tone]}`}
      data-user-status={status}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

/** Toolbar filter pill: `Pending · 3`; selected pills take the accent, states keep their dot. */
export function FilterPill({
  count,
  label,
  onSelect,
  selected,
  tone = "neutral"
}: Readonly<{
  count: number;
  label: string;
  onSelect(): void;
  selected: boolean;
  tone?: "caution" | "neutral";
}>) {
  const dot = tone === "caution" && count > 0;
  return (
    <button
      aria-pressed={selected}
      className={`inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border px-2.5 text-metadata font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus ${touchTarget} ${
        selected ? pillTone.accent : dot ? pillTone.caution : `${pillTone.neutral} hover:bg-control-hover hover:text-ink`
      }`}
      onClick={onSelect}
      type="button"
    >
      {dot ? <span aria-hidden="true" className="size-1.5 rounded-full bg-current" /> : null}
      {label} · {count}
    </button>
  );
}

/** The `⋯` menu on a row: a few actions behind one control. */
export function UsersRowMenu({
  actions,
  label
}: Readonly<{ actions: readonly UiV2MenuAction[]; label: string }>) {
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
      />
      {open ? (
        <UiV2ResponsiveMenu anchorRef={triggerRef} label={label} menuRef={menuRef} onClose={() => setOpen(false)}>
          <UiV2MenuActions actions={actions} onClose={closeForAction} />
        </UiV2ResponsiveMenu>
      ) : null}
    </div>
  );
}
