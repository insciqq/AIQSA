"use client";

import { UiV2Icon } from "@/components/ui-v2";
import { scheduledChecksLabel } from "./scheduledCheckGroups";

/**
 * Quiet transcript line in place of consecutive monitoring checks with no
 * update, in the scheduled turn chip's type. Show reveals the checks
 * unchanged below it; Hide folds them again.
 */
export function ScheduledChecksRowV2({ checks, expanded, onToggle }: Readonly<{
  checks: number;
  expanded: boolean;
  onToggle(): void;
}>) {
  const label = scheduledChecksLabel(checks);
  return (
    <div className="v2-scheduled-checks" data-testid="scheduled-checks-row">
      <UiV2Icon name="clock" />
      <p>{label}</p>
      <span aria-hidden="true">·</span>
      <button
        className="v2-scheduled-checks-action v2-focusable"
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Hide" : "Show"} ${label}`}
        onClick={onToggle}
      >
        {expanded ? "Hide" : "Show"}
      </button>
    </div>
  );
}
