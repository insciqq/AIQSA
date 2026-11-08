"use client";

import { UiV2Icon } from "@/components/ui-v2";
import { formatScheduledTranscriptTime, scheduledChecksLabel, type ScheduledChecksSummary } from "./scheduledCheckGroups";
import { browserTimeZone } from "./scheduledTaskPresentation";

/**
 * Quiet transcript line in place of folded scheduled checks: how many, how
 * many of them failed before a later check succeeded, and when the latest
 * ran, in the viewer's zone. Show reveals the checks unchanged below it
 * (failure cards included); Hide folds them again.
 */
export function ScheduledChecksRowV2({ expanded, now, onToggle, summary, timeZone }: Readonly<{
  expanded: boolean;
  /** Fixed clock and zone for tests; the viewer's by default. */
  now?: Date;
  onToggle(): void;
  summary: ScheduledChecksSummary;
  timeZone?: string;
}>) {
  const label = scheduledChecksLabel(summary);
  const last = summary.lastAt ? formatScheduledTranscriptTime(summary.lastAt, timeZone ?? browserTimeZone(), now) : null;
  return (
    <div className="v2-scheduled-checks" data-testid="scheduled-checks-row">
      <UiV2Icon name="clock" />
      <p>
        {label}
        {last ? <> · last <time dateTime={summary.lastAt ?? undefined}>{last}</time></> : null}
      </p>
      <span aria-hidden="true">·</span>
      <button
        className="v2-scheduled-checks-action v2-focusable"
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Hide" : "Show"} ${label.replaceAll(" · ", ", ")}`}
        onClick={onToggle}
      >
        {expanded ? "Hide" : "Show"}
      </button>
    </div>
  );
}
