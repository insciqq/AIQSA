"use client";

import type { McpStatusTone } from "@/components/admin/mcp/mcpServerView";
import { UiV2Monogram } from "@/components/ui-v2";
import type { CSSProperties, ReactNode } from "react";

export const sectionHeadingClass = "text-[13px] font-semibold tracking-[0.02em] text-ink-secondary";
export const cardClass = "overflow-hidden rounded-[12px] border border-trace-subtle bg-answer-paper";
export const fieldLabelClass = "mb-1 block text-xs font-medium text-ink-secondary";
export const helpTextClass = "mt-1 block text-xs leading-5 text-ink-muted";

const pillTone: Record<McpStatusTone, string> = {
  critical: "border-critical/25 bg-critical/10 text-critical",
  neutral: "border-trace-subtle bg-control-surface text-ink-secondary",
  ok: "border-positive/25 bg-positive/10 text-positive",
  warn: "border-caution/25 bg-caution/10 text-caution"
};

/** Status pill sized to its words: a dot plus one status label. */
export function McpStatusPill({
  label,
  testId = "mcp-server-status",
  tone
}: Readonly<{ label: string; testId?: string; tone: McpStatusTone }>) {
  return (
    <span
      className={`inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border px-2 text-metadata font-semibold ${pillTone[tone]}`}
      data-status-tone={tone}
      data-testid={testId}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

/** The server tile: the name's monogram, so a server reads the same in the list and on its page. */
export function McpServerTile({
  label,
  size = "row"
}: Readonly<{ label: string; size?: "header" | "row" }>) {
  const dimensions = size === "header" ? "size-11 rounded-[10px]" : "size-8 rounded-[8px]";
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center border border-trace-strong bg-answer-paper text-ink-secondary ${dimensions}`}
      style={{ "--v2-monogram-size": size === "header" ? "1.5rem" : "1.125rem" } as CSSProperties}
    >
      <UiV2Monogram className="border-0 bg-transparent" label={label} />
    </span>
  );
}

const noteTone: Record<McpStatusTone, string> = {
  critical: "border-critical/25 bg-critical/5 text-critical",
  neutral: "border-trace-subtle bg-control-surface/45 text-ink-secondary",
  ok: "border-positive/25 bg-positive/5 text-positive",
  warn: "border-caution/25 bg-caution/5 text-caution"
};

/** One toned note block: the trust caution, an authorization hint, a failed check. */
export function McpNote({
  children,
  tone = "neutral",
  ...props
}: Readonly<{ children: ReactNode; role?: "alert" | "status"; "data-testid"?: string; tone?: McpStatusTone }>) {
  return (
    <div className={`rounded-[10px] border px-3 py-2.5 text-xs leading-5 ${noteTone[tone]}`} {...props}>
      {children}
    </div>
  );
}
