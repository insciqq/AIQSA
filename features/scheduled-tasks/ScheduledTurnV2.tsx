"use client";

import { useId, useState, type ReactNode } from "react";
import { UiV2Icon } from "@/components/ui-v2";
import { formatScheduledTranscriptTime } from "./scheduledCheckGroups";
import { ScheduledMessageChipV2 } from "./ScheduledMessageChipV2";
import { browserTimeZone } from "./scheduledTaskPresentation";

/**
 * A user turn that a scheduled task posted, as one quiet line: the task, when
 * the run started in the viewer's zone, and its instructions behind a
 * disclosure. The task wrote it, so it offers no edit or branch actions; Copy
 * sits with the instructions. The title opens Studio › Automations when
 * Studio is reachable.
 */
export function ScheduledTurnV2({ anchorId, content, createdAt, now, onCopy, onOpen, pagerSlot, timeZone, title }: Readonly<{
  anchorId: string;
  content: string;
  /** When the turn was posted; the line omits the time when unknown. */
  createdAt?: string | null;
  /** Fixed clock and zone for tests; the viewer's by default. */
  now?: Date;
  onCopy?(): void;
  onOpen?(): void;
  /** The version pager of a turn with sibling versions; it renders nothing otherwise. */
  pagerSlot?: ReactNode;
  timeZone?: string;
  title: string;
}>) {
  const [open, setOpen] = useState(false);
  const instructionsId = useId();
  const time = createdAt ? formatScheduledTranscriptTime(createdAt, timeZone ?? browserTimeZone(), now) : null;
  const instructions = content.trim();
  return (
    <article
      aria-label={`Automation ${title}`}
      className="v2-conversation-turn v2-scheduled-turn"
      data-conversation-message-id={anchorId}
      data-message-id={anchorId}
      data-role="user"
      data-testid="scheduled-turn"
    >
      <div className="v2-scheduled-turn-line">
        <ScheduledMessageChipV2 title={title} onOpen={onOpen} />
        <span className="v2-scheduled-turn-meta">
          {time ? <>
            <span aria-hidden="true" className="v2-scheduled-turn-sep">·</span>
            <time dateTime={createdAt ?? undefined}>{time}</time>
          </> : null}
          {instructions ? <>
            <span aria-hidden="true" className="v2-scheduled-turn-sep">·</span>
            <button
              aria-controls={open ? instructionsId : undefined}
              aria-expanded={open}
              aria-label={open ? "Hide instructions" : undefined}
              className="v2-scheduled-turn-toggle v2-focusable"
              type="button"
              onClick={() => setOpen((current) => !current)}
            >
              {open ? "Hide" : "Show instructions"}
            </button>
          </> : null}
          {pagerSlot}
        </span>
      </div>
      {open && instructions ? (
        <div className="v2-scheduled-turn-instructions" id={instructionsId}>
          <p>{instructions}</p>
          {onCopy ? (
            <button className="v2-scheduled-turn-copy v2-focusable" type="button" aria-label="Copy instructions" onClick={onCopy}>
              <UiV2Icon name="copy" />
              <span>Copy</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
