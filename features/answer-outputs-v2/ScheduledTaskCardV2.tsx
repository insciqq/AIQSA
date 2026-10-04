"use client";

import { useEffect, useId, useRef, useState } from "react";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import type { ScheduledTaskCard } from "@/lib/contracts/scheduledTasks";
import { describeScheduledTaskSchedule } from "@/lib/domain/scheduledTaskSchedule";
import {
  browserTimeZone,
  formatScheduledInstant,
  scheduledTaskFailureMessage,
  timeZoneLabel
} from "@/features/scheduled-tasks/scheduledTaskPresentation";
import { deleteScheduledTask, ScheduledTaskApiError } from "@/features/scheduled-tasks/scheduledTasksApi";
import {
  refreshScheduledTasksAfterChange,
  removeScheduledTask,
  requestScheduledTaskEdit,
  useScheduledTasksStore
} from "@/features/scheduled-tasks/scheduledTasksStore";

/** Tasks whose card already asked the account's list to read them; once per task and page. */
const listedTaskReads = new Set<string>();
/**
 * Tasks deleted from a card on this page: the card a settling answer mounts
 * again, or the same task's card in another branch, keeps saying so until a
 * transcript read marks the task deleted itself.
 */
const deletedTaskIds = new Set<string>();

/**
 * Opens Studio › Scheduled on the task's editor. The account's task list is
 * read first, so the editor finds a task the answer has just created.
 */
export async function openScheduledTaskEditorV2(
  taskId: string,
  openScheduled: (afterSelect: () => void) => void
): Promise<void> {
  await refreshScheduledTasksAfterChange();
  openScheduled(() => requestScheduledTaskEdit(taskId));
}

/** "Every weekday at 09:00 · Monitoring · Tools · Workspace", with the zone when it is not the viewer's or was a fallback. */
function scheduleLine(card: ScheduledTaskCard, viewerZone: string): string {
  return [
    describeScheduledTaskSchedule(card.schedule),
    ...(card.timeZoneFallback || card.timeZone !== viewerZone ? [timeZoneLabel(card.timeZone)] : []),
    ...(card.kind === "monitoring" ? ["Monitoring"] : []),
    ...(card.toolsEnabled ? ["Tools"] : []),
    ...(card.workspaceEnabled ? ["Workspace"] : [])
  ].join(" · ");
}

function statusLine(card: ScheduledTaskCard): string {
  if (card.status === "paused") return "Paused";
  if (card.status === "completed") return "Completed";
  return card.nextRunAt ? `Next run ${formatScheduledInstant(card.nextRunAt, card.timeZone)}` : "No upcoming run";
}

function ScheduledTaskCardV2({ card, onEdit }: Readonly<{
  card: ScheduledTaskCard;
  onEdit?(taskId: string): void | Promise<void>;
}>) {
  const headingId = useId();
  const [deletedHere, setDeletedHere] = useState(() => deletedTaskIds.has(card.taskId));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"delete" | "edit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLParagraphElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const deleted = deletedHere || card.deleted === true;

  useEffect(() => {
    if (confirming) keepRef.current?.focus();
  }, [confirming]);

  // A task this answer just created is news to the account's task list, whose
  // reads also start the watch for its results: the list owner reads it once.
  useEffect(() => {
    if (card.deleted || deletedTaskIds.has(card.taskId) || listedTaskReads.has(card.taskId)) return;
    const { loadState, tasks } = useScheduledTasksStore.getState();
    if (loadState !== "ready" || tasks.some((task) => task.id === card.taskId)) return;
    listedTaskReads.add(card.taskId);
    void refreshScheduledTasksAfterChange();
  }, [card.deleted, card.taskId]);

  async function edit() {
    if (!onEdit || busy) return;
    setBusy("edit");
    setError(null);
    try {
      await onEdit(card.taskId);
    } catch {
      setError("The task could not be opened. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function confirmDelete() {
    if (busy) return;
    setBusy("delete");
    setError(null);
    try {
      await deleteScheduledTask(card.taskId);
    } catch (failure) {
      // A task already gone is deleted for the viewer too.
      if (!(failure instanceof ScheduledTaskApiError && failure.code === "scheduled_task_not_found")) {
        setError(scheduledTaskFailureMessage(failure instanceof ScheduledTaskApiError ? failure.code : null));
        setBusy(null);
        return;
      }
    }
    deletedTaskIds.add(card.taskId);
    removeScheduledTask(card.taskId);
    setDeletedHere(true);
    setConfirming(false);
    setBusy(null);
    // The actions are gone: focus stays on the card, whose line now says so.
    queueMicrotask(() => headingRef.current?.focus());
  }

  function cancelDelete() {
    setConfirming(false);
    queueMicrotask(() => deleteRef.current?.focus());
  }

  return (
    <li className="v2-scheduled-task-card" data-state={deleted ? "deleted" : card.status} data-testid="scheduled-task-card"
      aria-labelledby={headingId}>
      <span className="v2-scheduled-task-card-tile" aria-hidden="true"><UiV2Icon name="clock" /></span>
      <div className="v2-scheduled-task-card-copy">
        <p className="v2-scheduled-task-card-heading" id={headingId} ref={headingRef} tabIndex={-1} role="status">
          {deleted ? "Scheduled task deleted" : "Scheduled task created"}
        </p>
        <strong title={card.title}>{card.title}</strong>
        <small>{scheduleLine(card, browserTimeZone())}</small>
        {deleted ? null : <small>{statusLine(card)}</small>}
      </div>
      {deleted || confirming ? null : (
        <div className="v2-scheduled-task-card-actions">
          {onEdit ? (
            <UiV2Button busy={busy === "edit"} disabled={busy !== null} icon="edit" type="button"
              aria-label={`Edit scheduled task ${card.title}`} onClick={() => void edit()}>
              Edit
            </UiV2Button>
          ) : null}
          <UiV2Button ref={deleteRef} disabled={busy !== null} icon="trash" type="button"
            aria-label={`Delete scheduled task ${card.title}`} onClick={() => { setError(null); setConfirming(true); }}>
            Delete
          </UiV2Button>
        </div>
      )}
      {confirming && !deleted ? (
        <div className="v2-scheduled-task-card-confirm" role="group" aria-label={`Delete ${card.title}`}>
          <p>Delete “{card.title}”? Its chats and answers stay in your history.</p>
          <span>
            <UiV2Button busy={busy === "delete"} disabled={busy !== null && busy !== "delete"} tone="destructive" type="button"
              onClick={() => void confirmDelete()}>
              Delete task
            </UiV2Button>
            <UiV2Button ref={keepRef} disabled={busy !== null} type="button" onClick={cancelDelete}>Keep task</UiV2Button>
          </span>
        </div>
      ) : null}
      {error ? <p className="v2-scheduled-task-card-error" role="alert">{error}</p> : null}
    </li>
  );
}

/**
 * The tasks an answer created through its `create_scheduled_task` call:
 * frequency, capabilities and next run, with Edit (the task's editor) and
 * Delete (after an inline confirmation). A deleted task keeps a quiet line.
 */
export function ScheduledTaskCardsV2({ cards, onEdit }: Readonly<{
  cards: readonly ScheduledTaskCard[];
  onEdit?(taskId: string): void | Promise<void>;
}>) {
  if (cards.length === 0) return null;
  return (
    <section className="v2-scheduled-task-cards" aria-label="Scheduled tasks">
      <ul>{cards.map((card) => <ScheduledTaskCardV2 key={card.taskId} card={card} onEdit={onEdit} />)}</ul>
    </section>
  );
}
