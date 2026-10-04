"use client";

import { UiV2Icon } from "@/components/ui-v2";

/**
 * Quiet label above a user turn that a scheduled task posted. It opens
 * Studio › Scheduled when Studio is reachable, and is plain text otherwise.
 */
export function ScheduledMessageChipV2({ onOpen, title }: Readonly<{ onOpen?(): void; title: string }>) {
  const content = <>
    <UiV2Icon name="clock" />
    <span className="v2-scheduled-message-chip-text">Scheduled · {title}</span>
  </>;
  return onOpen ? (
    <button
      className="v2-scheduled-message-chip v2-focusable"
      title="Open scheduled tasks"
      type="button"
      onClick={onOpen}
    >
      {content}
    </button>
  ) : <span className="v2-scheduled-message-chip">{content}</span>;
}
