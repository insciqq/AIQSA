"use client";

import type { SearchStatusTone } from "@/components/admin/search/searchSourceView";
import { UiV2Monogram } from "@/components/ui-v2";
import type { CSSProperties } from "react";

const pillTone: Record<SearchStatusTone, string> = {
  critical: "border-critical/25 bg-critical/10 text-critical",
  neutral: "border-trace-subtle bg-control-surface text-ink-secondary",
  ok: "border-positive/25 bg-positive/10 text-positive",
  warn: "border-caution/25 bg-caution/10 text-caution"
};

/** Status pill sized to its words: a dot plus one of the five status labels. */
export function SearchStatusPill({
  label,
  tone
}: Readonly<{ label: string; tone: SearchStatusTone }>) {
  return (
    <span
      className={`inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border px-2 text-metadata font-semibold ${pillTone[tone]}`}
      data-status-tone={tone}
      data-testid="search-source-status"
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

/** The source tile: the name's monogram, so each source reads the same in the list and on its page. */
export function SearchSourceTile({
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
