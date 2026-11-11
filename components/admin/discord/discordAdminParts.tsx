"use client";

import { focusRing, inputClass } from "@/components/admin/adminPrimitives";
import { adminSectionPath, type AdminSectionId } from "@/components/admin/adminSections";
import { cardClass, sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

export const fieldLabelClass = "mb-1 block text-xs font-medium text-ink-secondary";
export const helpTextClass = "mt-1 block text-xs leading-5 text-ink-muted";
export const fieldErrorClass = "mt-1 block text-xs leading-5 text-critical";
export const alertClass = "rounded-[10px] border border-critical/25 bg-critical/5 px-3 py-2 text-xs leading-5 text-critical";
export const selectClass = `${inputClass} sm:max-w-[24rem]`;
export const discordCardClass = `${cardClass} min-w-0 max-w-[760px]`;
export const cardBodyClass = "grid min-w-0 gap-4 px-5 py-5";
export const cardFooterClass = "flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-trace-subtle px-5 py-4";
export const footerNoteClass = "min-w-0 text-xs leading-5 text-ink-muted";
export { sectionHeadingClass };

/** Where a setup or status action moves focus; the element carries `data-discord-focus`. */
export type DiscordFocusTarget = "assistant" | "guild" | "setup" | "token";

export type DiscordNavigate = (section: AdminSectionId, resource?: string | null) => void;

function currentHref(): string {
  return typeof window === "undefined" ? "/admin" : window.location.href;
}

function primaryClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** A link to another Control Center section that keeps the page and its unsaved input on a plain click. */
export function DiscordSectionLink({
  children,
  onNavigate,
  resource = null,
  section,
  testId
}: Readonly<{ children: ReactNode; onNavigate: DiscordNavigate; resource?: string | null; section: AdminSectionId; testId?: string }>) {
  return (
    <a
      className={`rounded-[4px] text-xs font-medium text-ink underline decoration-trace-strong underline-offset-2 hover:decoration-ink ${focusRing}`}
      data-testid={testId}
      href={adminSectionPath(currentHref(), section, resource)}
      onClick={(event) => {
        if (!primaryClick(event)) return;
        event.preventDefault();
        onNavigate(section, resource);
      }}
    >
      {children}
    </a>
  );
}

/** A small state word with a dot; colour carries state only. */
export function DiscordStatePill({
  children,
  testId,
  tone
}: Readonly<{ children: ReactNode; testId?: string; tone: "critical" | "neutral" | "ok" | "warning" }>) {
  const toneClass = {
    critical: "border-critical/25 bg-critical/10 text-critical",
    neutral: "border-trace-subtle bg-control-surface text-ink-secondary",
    ok: "border-positive/25 bg-positive/10 text-positive",
    warning: "border-caution/25 bg-caution/10 text-caution"
  }[tone];
  return (
    <span
      className={`inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border px-2 text-metadata font-semibold ${toneClass}`}
      data-status-tone={tone}
      data-testid={testId}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      <span>{children}</span>
    </span>
  );
}

/** The current time for relative ages ("5 s ago"), ticking while the section is open. */
export function useDiscordClock(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
