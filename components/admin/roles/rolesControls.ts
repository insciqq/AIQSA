import { focusRing, touchTarget } from "@/components/admin/adminPrimitives";

/** 32 px controls for table rows (PRD 2.7); page-level inputs keep 40 px. */
export const compactSelectClass =
  `min-h-control-sm w-full min-w-0 rounded-control border border-control-boundary bg-answer-paper px-2.5 text-[13px] text-ink ${focusRing} ${touchTarget} hover:border-trace-strong disabled:cursor-not-allowed disabled:border-trace-subtle disabled:text-ink-disabled`;

export const compactInputClass =
  `min-h-control-sm rounded-control border border-control-boundary bg-answer-paper px-2.5 font-mono text-[13px] text-ink ${focusRing} ${touchTarget} aria-[invalid=true]:border-critical disabled:cursor-not-allowed disabled:border-trace-subtle disabled:text-ink-disabled`;

export const cardClass = "overflow-visible rounded-[12px] border border-trace-subtle bg-answer-paper";

export const sectionHeadingClass = "text-[13px] font-semibold tracking-[0.02em] text-ink-secondary";
