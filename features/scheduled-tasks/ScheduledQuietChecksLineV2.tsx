"use client";

import { UiV2Icon } from "@/components/ui-v2";
import type { ChatQuietChecksSummary } from "@/lib/contracts/chats";
import { formatScheduledTranscriptTime, quietChecksLabel } from "./scheduledCheckGroups";
import { browserTimeZone } from "./scheduledTaskPresentation";

/**
 * The one line at the top of a task chat that counts the checks its history
 * leaves out because nothing changed (operator decision 2026-11-11): how
 * many, when the latest ran and, while the task continues here, when it
 * checks next, in the viewer's zone. It shows nothing to open: those checks
 * have no news.
 */
export function ScheduledQuietChecksLineV2({ nextRunAt, now, summary, timeZone }: Readonly<{
  /** The next check of the task continuing in this chat; null when none is due. */
  nextRunAt?: string | null;
  /** Fixed clock and zone for tests; the viewer's by default. */
  now?: Date;
  summary: ChatQuietChecksSummary;
  timeZone?: string;
}>) {
  const zone = timeZone ?? browserTimeZone();
  const last = formatScheduledTranscriptTime(summary.lastAt, zone, now);
  const next = nextRunAt ? formatScheduledTranscriptTime(nextRunAt, zone, now) : null;
  return (
    <div className="v2-scheduled-checks v2-scheduled-quiet-checks" data-testid="scheduled-quiet-checks">
      <UiV2Icon name="clock" />
      {/* Each optional part is its own element, so a page translator's wrappers never strand a text node React removes. */}
      <p>
        <span>{quietChecksLabel(summary.count)}</span>
        {last ? <span> · last <time dateTime={summary.lastAt}>{last}</time></span> : null}
        {next && nextRunAt ? <span> · next <time dateTime={nextRunAt}>{next}</time></span> : null}
      </p>
    </div>
  );
}
