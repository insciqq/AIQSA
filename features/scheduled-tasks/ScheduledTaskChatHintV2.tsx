"use client";

import { UiV2Icon } from "@/components/ui-v2";

/**
 * Quiet, persistent line in a task chat that later runs continue: replies
 * written here never change the task, its editor does. Rendered above the
 * composer in the scheduled turn chip's type and colour.
 */
export function ScheduledTaskChatHintV2({ onEdit, title }: Readonly<{ onEdit?(): void; title: string }>) {
  return (
    <div className="v2-scheduled-chat-hint" data-testid="scheduled-task-chat-hint">
      <UiV2Icon name="clock" />
      <p>Replies here don&apos;t change the scheduled task.</p>
      {onEdit ? (
        <button className="v2-scheduled-chat-hint-action v2-focusable" type="button" aria-label={`Edit task ${title}`} onClick={onEdit}>
          Edit task
        </button>
      ) : null}
    </div>
  );
}
