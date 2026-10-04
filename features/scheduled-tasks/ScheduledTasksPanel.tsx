"use client";

import { useEffect, useRef, useState } from "react";
import { UiV2Button, UiV2Icon, UiV2IconButton, UiV2MenuItem, UiV2Switch } from "@/components/ui-v2";
import { UiV2ResponsiveMenu } from "@/components/ui-v2/ResponsiveMenuV2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import { SectionHeading } from "@/features/library-v2/LibraryV2";
import type { Catalog } from "@/lib/contracts/catalog";
import type { ScheduledTask, ScheduledTaskRun } from "@/lib/contracts/scheduledTasks";
import { ScheduledTaskSheet, type ScheduledTaskRecentRuns } from "./ScheduledTaskSheet";
import {
  blankScheduledTaskDraft,
  scheduledTaskCreateRequest,
  scheduledTaskDraftFromTask,
  scheduledTaskUpdateRequest,
  validateScheduledTaskDraft,
  type ScheduledTaskEditorDraft,
  type ScheduledTaskFieldErrors
} from "./scheduledTaskDraft";
import {
  browserTimeZone,
  scheduledTaskFailureMessage,
  scheduledTaskLastRunLine,
  scheduledTaskScheduleText,
  scheduledTaskStatusLine,
  sortScheduledTasks,
  WORKDAYS
} from "./scheduledTaskPresentation";
import {
  createScheduledTask,
  deleteScheduledTask,
  getScheduledTask,
  runScheduledTaskNow,
  ScheduledTaskApiError,
  updateScheduledTask
} from "./scheduledTasksApi";
import {
  activateScheduledTasksAccount,
  applyScheduledTask,
  refreshScheduledTasks,
  removeScheduledTask,
  takeScheduledTaskEditRequest,
  useScheduledTasksStore
} from "./scheduledTasksStore";
import { markScheduledTaskRunsSeen } from "./useScheduledTaskUpdates";

type Editor = Readonly<{
  draft: ScheduledTaskEditorDraft;
  errors: ScheduledTaskFieldErrors;
  initialDraft: ScheduledTaskEditorDraft;
  notice: string | null;
  original: ScheduledTask | null;
  recentRuns: ScheduledTaskRecentRuns | null;
}>;

type Idea = Readonly<{ label: string; preset: Partial<ScheduledTaskEditorDraft> }>;

const IDEAS: readonly Idea[] = [
  {
    label: "Weekday news brief at 09:00",
    preset: {
      title: "Weekday news brief",
      prompt: "Give me a short brief of the most important news from the last 24 hours: five bullet points, each with one sentence of context.",
      repeat: "weekdays", time: "09:00", days: WORKDAYS
    }
  },
  {
    label: "Weekly summary every Friday at 17:00",
    preset: {
      title: "Weekly summary",
      prompt: "Help me close the week: list three questions to reflect on what went well, what slipped and what to plan for next week.",
      repeat: "weekly", time: "17:00", days: ["fri"]
    }
  },
  {
    label: "Reminder on the 1st of each month",
    preset: {
      title: "Monthly reminder",
      prompt: "Remind me to review subscriptions, pay recurring bills and back up my files. Keep it to a short checklist.",
      repeat: "monthly", time: "10:00", dayOfMonth: 1
    }
  }
];

const FIELD_FOR_CODE: Readonly<Record<string, keyof ScheduledTaskFieldErrors>> = {
  scheduled_task_schedule_invalid: "schedule",
  scheduled_task_once_in_past: "schedule",
  scheduled_task_time_zone_invalid: "timeZone",
  scheduled_task_hourly_limit: "schedule",
  scheduled_task_chat_mode_invalid: "chatMode",
  scheduled_task_model_unavailable: "model",
  scheduled_task_search_unavailable: "search"
};

/** A new task opened before the catalog arrived takes its default model once it does. */
function withCatalogDefault(editor: Editor | null, catalog: Catalog | null): Editor | null {
  if (!editor || editor.original || editor.draft.modelId || !catalog) return editor;
  const fallback = blankScheduledTaskDraft(catalog, editor.draft.timeZone);
  if (!fallback.modelId) return editor;
  const model = { modelId: fallback.modelId, provider: fallback.provider };
  return { ...editor, draft: { ...editor.draft, ...model }, initialDraft: { ...editor.initialDraft, ...model } };
}

function errorCode(error: unknown): string | null {
  return error instanceof ScheduledTaskApiError ? error.code : null;
}

/** Studio › Scheduled: the account's tasks, their next runs and the editor sheet. */
export function ScheduledTasksPanel({
  accountId,
  catalog,
  onBusyChange,
  onOpenChat
}: Readonly<{
  accountId: string;
  catalog: Catalog | null;
  onBusyChange?(busy: boolean): void;
  onOpenChat(chatId: string): Promise<void> | void;
}>) {
  const tasks = useScheduledTasksStore((state) => state.tasks);
  const loadState = useScheduledTasksStore((state) => state.loadState);
  const limits = useScheduledTasksStore((state) => state.limits);
  const emailAvailable = useScheduledTasksStore((state) => state.emailAvailable);
  const [viewerTimeZone] = useState(browserTimeZone);
  const [editorState, setEditor] = useState<Editor | null>(null);
  const editor = withCatalogDefault(editorState, catalog);
  const [saving, setSaving] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});
  const [deleting, setDeleting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const pending = useRef(false);
  const active = useRef(true);
  const editorEpoch = useRef(0);
  const newButton = useRef<HTMLButtonElement>(null);
  const headings = useRef(new Map<string, HTMLHeadingElement>());
  const restoreFocus = useRef<string | null>(null);
  /** Run ids the editor already marked seen (or is marking). */
  const seenRuns = useRef(new Set<string>());
  const busy = saving || rowBusy !== null;

  useEffect(() => {
    active.current = true;
    activateScheduledTasksAccount(accountId);
    void refreshScheduledTasks();
    return () => { active.current = false; };
  }, [accountId]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => {
    if (editor || !restoreFocus.current) return;
    const target = restoreFocus.current === "new" ? newButton.current : headings.current.get(restoreFocus.current) ?? newButton.current;
    restoreFocus.current = null;
    // The sheet restores its opener first; the row or New task owns focus after a change.
    const frame = window.requestAnimationFrame(() => { if (target?.isConnected) target.focus(); });
    return () => window.cancelAnimationFrame(frame);
  }, [editor, tasks]);

  const activeCount = tasks.filter((task) => task.status === "active").length;
  const atActiveLimit = activeCount >= limits.maxActive;
  const atTotalLimit = tasks.length >= limits.maxTotal;
  const limitReason = atTotalLimit
    ? `You have ${limits.maxTotal} saved tasks. Delete one to add another.`
    : atActiveLimit ? `You have ${limits.maxActive} active tasks. Pause or delete one to add another.` : null;
  const sorted = sortScheduledTasks(tasks);

  function openCreate(preset: Partial<ScheduledTaskEditorDraft> = {}) {
    if (busy || limitReason) return;
    editorEpoch.current += 1;
    // An idea only prefills the sheet; closing it unchanged needs no confirmation.
    const draft = blankScheduledTaskDraft(catalog, viewerTimeZone, new Date(), preset);
    setNotice(null); setDeleting(null);
    setEditor({ draft, errors: {}, initialDraft: draft, notice: null, original: null, recentRuns: null });
  }

  function loadRecentRuns(task: ScheduledTask, epoch: number, onTask?: (latest: ScheduledTask) => void) {
    getScheduledTask(task.id).then((detail) => {
      if (!active.current || editorEpoch.current !== epoch) return;
      applyScheduledTask(detail.task);
      onTask?.(detail.task);
      setEditor((current) => current && current.original?.id === task.id
        ? { ...current, recentRuns: { state: "ready", runs: detail.recentRuns } } : current);
    }, (error: unknown) => {
      if (!active.current || editorEpoch.current !== epoch) return;
      if (errorCode(error) === "scheduled_task_not_found") { closeMissing(task.id); return; }
      setEditor((current) => current && current.original?.id === task.id ? { ...current, recentRuns: { state: "error" } } : current);
    });
  }

  function openEdit(task: ScheduledTask) {
    if (busy) return;
    const epoch = ++editorEpoch.current;
    const draft = scheduledTaskDraftFromTask(task);
    setNotice(null); setDeleting(null);
    setEditor({ draft, errors: {}, initialDraft: draft, notice: null, original: task, recentRuns: { state: "loading" } });
    loadRecentRuns(task, epoch);
  }

  /** The editor rendered these unread results; only they become seen. */
  function runsShown(task: ScheduledTask, runs: readonly ScheduledTaskRun[]) {
    const fresh = runs.filter((run) => !seenRuns.current.has(run.id));
    if (!fresh.length) return;
    for (const run of fresh) seenRuns.current.add(run.id);
    void markScheduledTaskRunsSeen(task.id, fresh.map((run) => run.id), fresh.flatMap((run) => run.chatId ? [run.chatId] : []))
      .then((marked) => { if (!marked) for (const run of fresh) seenRuns.current.delete(run.id); });
  }

  /** Leaves the editor for one run's chat; a chat that is gone reports on the task's row. */
  function openRunChat(task: ScheduledTask, chatId: string) {
    restoreFocus.current = task.id;
    editorEpoch.current += 1;
    setEditor(null);
    void rowMutation(task, async () => { await onOpenChat(chatId); });
  }

  // "Edit task" in a task's chat opens Studio › Scheduled with that task's editor.
  const editRequest = useScheduledTasksStore((state) => state.editRequest);
  const takeEditRequest = useEventCallback(() => {
    const taskId = takeScheduledTaskEditRequest();
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (task) openEdit(task);
    else setNotice("This task is no longer available.");
  });
  useEffect(() => {
    if (editRequest && loadState === "ready" && !busy && !editorState) takeEditRequest();
  }, [busy, editRequest, editorState, loadState, takeEditRequest]);

  function closeEditor() {
    restoreFocus.current = editor?.original?.id ?? "new";
    editorEpoch.current += 1;
    setEditor(null);
  }

  function closeMissing(taskId: string) {
    removeScheduledTask(taskId);
    editorEpoch.current += 1;
    restoreFocus.current = "new";
    setEditor(null);
    setNotice("This task is no longer available.");
  }

  async function save() {
    if (!editor || pending.current) return;
    const errors = validateScheduledTaskDraft(editor.draft, catalog, editor.original);
    if (Object.keys(errors).length) { setEditor({ ...editor, errors }); return; }
    const original = editor.original;
    const create = original ? null : scheduledTaskCreateRequest(editor.draft);
    const update = original ? scheduledTaskUpdateRequest(editor.draft, original) : null;
    if (!create && !update) { setEditor({ ...editor, errors: { schedule: "Complete the schedule." } }); return; }
    if (update && Object.keys(update).length === 1) { closeEditor(); return; }
    pending.current = true; setSaving(true);
    setEditor({ ...editor, errors: {}, notice: null });
    try {
      const task = original ? await updateScheduledTask(original.id, update!) : await createScheduledTask(create!);
      if (!active.current) return;
      applyScheduledTask(task);
      restoreFocus.current = task.id;
      editorEpoch.current += 1;
      setEditor(null);
      setNotice(original ? "Changes saved." : `“${task.title}” is scheduled.`);
    } catch (error) {
      if (!active.current) return;
      const code = errorCode(error);
      if (code === "scheduled_task_not_found" && original) { closeMissing(original.id); return; }
      if (code === "scheduled_task_stale" && original) {
        const epoch = editorEpoch.current;
        setEditor((current) => current && { ...current, recentRuns: { state: "loading" } });
        loadRecentRuns(original, epoch, (latest) => setEditor((current) => current && current.original?.id === latest.id
          ? { ...current, original: latest, notice: "This task changed elsewhere. The latest version is loaded and your edits are kept; save again to apply them." }
          : current));
        return;
      }
      const field = code ? FIELD_FOR_CODE[code] : undefined;
      setEditor((current) => current && { ...current, errors: { [field ?? "form"]: scheduledTaskFailureMessage(code) } });
    } finally {
      pending.current = false;
      if (active.current) setSaving(false);
    }
  }

  async function rowMutation(task: ScheduledTask, operation: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setRowBusy(task.id); setNotice(null);
    setRowErrors(({ [task.id]: _removed, ...rest }) => rest);
    try {
      await operation();
    } catch (error) {
      if (!active.current) return;
      const code = errorCode(error);
      if (code === "scheduled_task_not_found") { removeScheduledTask(task.id); setNotice("This task is no longer available."); return; }
      if (code === "scheduled_task_stale") {
        void refreshScheduledTasks();
        setRowErrors((current) => ({ ...current, [task.id]: "This task changed elsewhere. Its latest state is shown; try again." }));
        return;
      }
      const message = error instanceof Error && !(error instanceof ScheduledTaskApiError) ? error.message
        : code === "scheduled_task_once_in_past" ? "Its time has passed. Edit the task to choose a new date or time."
          : scheduledTaskFailureMessage(code);
      setRowErrors((current) => ({ ...current, [task.id]: message }));
    } finally {
      pending.current = false;
      if (active.current) setRowBusy(null);
    }
  }

  const setPaused = (task: ScheduledTask, resume: boolean) => rowMutation(task, async () => {
    applyScheduledTask(await updateScheduledTask(task.id, { expectedRevision: task.revision, status: resume ? "active" : "paused" }));
  });
  const runNow = (task: ScheduledTask) => rowMutation(task, async () => {
    applyScheduledTask(await runScheduledTaskNow(task.id));
    if (active.current) setNotice(`“${task.title}” is running now. The answer will appear in ${task.chatMode === "new" ? "a new chat" : "its chat"}.`);
  });
  const remove = (task: ScheduledTask) => rowMutation(task, async () => {
    await deleteScheduledTask(task.id);
    removeScheduledTask(task.id);
    restoreFocus.current = "new";
    setDeleting(null);
    if (active.current) setNotice(`“${task.title}” was deleted. Its chats and answers stay in your history.`);
  });
  const openChat = (task: ScheduledTask) => rowMutation(task, async () => {
    if (task.chatId) await onOpenChat(task.chatId);
  });
  const retry = async () => {
    setRetrying(true);
    await refreshScheduledTasks();
    if (active.current) setRetrying(false);
  };

  return (
    <section className="v2-studio-settings-page v2-scheduled-page" aria-label="Scheduled tasks" data-testid="scheduled-tasks-panel">
      <SectionHeading
        description="Run a prompt on a schedule. Answers arrive in your chats."
        meta={loadState === "ready" ? <span className="v2-scheduled-meta">{activeCount} of {limits.maxActive} active</span> : undefined}
        action={<UiV2Button ref={newButton} type="button" tone="primary" icon="plus" disabled={busy || loadState !== "ready" || Boolean(limitReason)}
          aria-describedby={limitReason ? "v2-scheduled-limit" : undefined} onClick={() => openCreate()}>New task</UiV2Button>}
      >
        Scheduled tasks
      </SectionHeading>
      {limitReason && loadState === "ready" ? <p className="v2-scheduled-note" id="v2-scheduled-limit">{limitReason}</p> : null}
      {notice ? <p className="v2-scheduled-notice" role="status">{notice}</p> : null}
      {loadState === "idle" || loadState === "loading" ? <p className="v2-scheduled-note" role="status">Loading scheduled tasks…</p> : null}
      {loadState === "error" ? (
        <div className="v2-scheduled-load-error" role="alert">
          <p>Scheduled tasks could not be loaded.</p>
          <UiV2Button type="button" icon="regenerate" busy={retrying} onClick={() => void retry()}>Try again</UiV2Button>
        </div>
      ) : null}
      {loadState === "ready" && tasks.length === 0 ? (
        <div className="v2-scheduled-empty" data-testid="scheduled-tasks-empty">
          <span className="v2-scheduled-empty-icon" aria-hidden="true"><UiV2Icon name="clock" /></span>
          <h3>No scheduled tasks yet</h3>
          <p>Ask for a news brief every morning, a weekly summary or a monthly reminder. Start from an idea or write your own.</p>
          <ul aria-label="Ideas">
            {IDEAS.map((idea) => (
              <li key={idea.label}>
                <UiV2Button type="button" disabled={busy} onClick={() => openCreate(idea.preset)}>{idea.label}</UiV2Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {tasks.length > 0 ? (
        <ul className="v2-scheduled-list" aria-label="Scheduled tasks">
          {sorted.map((task) => (
            <ScheduledTaskRow
              key={task.id}
              busy={busy}
              deleting={deleting === task.id}
              error={rowErrors[task.id] ?? null}
              headingRef={(node) => { if (node) headings.current.set(task.id, node); else headings.current.delete(task.id); }}
              rowBusy={rowBusy === task.id}
              task={task}
              viewerTimeZone={viewerTimeZone}
              onCancelDelete={() => setDeleting(null)}
              onConfirmDelete={() => void remove(task)}
              onDelete={() => { setNotice(null); setDeleting(task.id); }}
              onEdit={() => openEdit(task)}
              onOpenChat={() => void openChat(task)}
              onRunNow={() => void runNow(task)}
              onToggle={(resume) => void setPaused(task, resume)}
            />
          ))}
        </ul>
      ) : null}
      {editor ? (
        <ScheduledTaskSheet
          busy={saving}
          catalog={catalog}
          draft={editor.draft}
          emailAvailable={emailAvailable || Boolean(editor.original?.emailNotify)}
          errors={editor.errors}
          initialDraft={editor.initialDraft}
          notice={editor.notice}
          original={editor.original}
          recentRuns={editor.recentRuns}
          viewerTimeZone={viewerTimeZone}
          onChange={(patch) => setEditor((current) => current && {
            ...current,
            draft: { ...current.draft, ...patch },
            errors: Object.fromEntries(Object.entries(current.errors).filter(([key]) => key === "form"))
          })}
          onClose={closeEditor}
          onOpenRunChat={(chatId) => { if (editor.original) openRunChat(editor.original, chatId); }}
          onRunsShown={(runs) => { if (editor.original) runsShown(editor.original, runs); }}
          onSubmit={() => void save()}
        />
      ) : null}
    </section>
  );
}

function ScheduledTaskRow({
  busy, deleting, error, headingRef, onCancelDelete, onConfirmDelete, onDelete, onEdit, onOpenChat, onRunNow, onToggle,
  rowBusy, task, viewerTimeZone
}: Readonly<{
  busy: boolean;
  deleting: boolean;
  error: string | null;
  headingRef(node: HTMLHeadingElement | null): void;
  onCancelDelete(): void;
  onConfirmDelete(): void;
  onDelete(): void;
  onEdit(): void;
  onOpenChat(): void;
  onRunNow(): void;
  onToggle(resume: boolean): void;
  rowBusy: boolean;
  task: ScheduledTask;
  viewerTimeZone: string;
}>) {
  const status = scheduledTaskStatusLine(task);
  const lastRun = scheduledTaskLastRunLine(task);
  const headingId = `v2-scheduled-task-${task.id}`;
  return (
    <li className="v2-scheduled-row" data-status={task.status} aria-labelledby={headingId}>
      <span className="v2-scheduled-row-icon" aria-hidden="true"><UiV2Icon name="clock" /></span>
      <div className="v2-scheduled-row-copy">
        <h3 id={headingId} ref={headingRef} tabIndex={-1} className="v2-focusable">
          <span>{task.title}</span>
          {task.unseenResult ? <><span className="v2-scheduled-unread" aria-hidden="true" /><span className="sr-only">New result</span></> : null}
        </h3>
        <p className="v2-scheduled-row-schedule">{scheduledTaskScheduleText(task.schedule, task.timeZone, viewerTimeZone)}</p>
        <p className="v2-scheduled-row-status" data-tone={status.tone}>{status.text}</p>
        {lastRun ? <p className="v2-scheduled-row-last" data-tone={task.lastRun?.state === "failed" ? "attention" : undefined}>{lastRun}</p> : null}
        {error ? <p className="v2-scheduled-row-error" role="alert">{error}</p> : null}
      </div>
      <div className="v2-scheduled-row-actions">
        {task.chatId ? (
          <UiV2Button type="button" disabled={busy} aria-label={`Open chat for ${task.title}`} onClick={onOpenChat}>Open chat</UiV2Button>
        ) : null}
        {task.status !== "completed" ? (
          <UiV2Switch
            checked={task.status === "active"}
            disabled={busy}
            aria-busy={rowBusy || undefined}
            label={`Run ${task.title} on schedule`}
            onChange={onToggle}
          />
        ) : null}
        <ScheduledTaskMenu busy={busy} running={task.running} title={task.title} onDelete={onDelete} onEdit={onEdit} onRunNow={onRunNow} />
      </div>
      {deleting ? (
        <div className="v2-scheduled-row-delete" role="group" aria-label={`Delete ${task.title}`}>
          <p>Delete “{task.title}”? Its chats and answers stay in your history.</p>
          <span>
            <UiV2Button type="button" tone="destructive" busy={rowBusy} disabled={busy && !rowBusy} onClick={onConfirmDelete}>Delete task</UiV2Button>
            <UiV2Button type="button" disabled={busy} onClick={onCancelDelete}>Keep task</UiV2Button>
          </span>
        </div>
      ) : null}
    </li>
  );
}

function ScheduledTaskMenu({ busy, running, title, onDelete, onEdit, onRunNow }: Readonly<{
  busy: boolean;
  running: boolean;
  title: string;
  onDelete(): void;
  onEdit(): void;
  onRunNow(): void;
}>) {
  const [open, setOpen] = useState(false);
  const { triggerRef, menuRef, closeForAction } = useMenuDismissalV2({ open, onClose: () => setOpen(false) });
  const select = (action: () => void) => { closeForAction(); action(); };
  return (
    <>
      <UiV2IconButton ref={triggerRef} icon="more" label={`More actions for ${title}`} disabled={busy}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)} />
      {open ? (
        <UiV2ResponsiveMenu anchorRef={triggerRef} menuRef={menuRef} label={`Actions for ${title}`} onClose={() => setOpen(false)}>
          <UiV2MenuItem icon="edit" onClick={() => select(onEdit)}>Edit</UiV2MenuItem>
          <UiV2MenuItem icon="regenerate" disabled={running} sub={running ? "A run is in progress" : undefined} onClick={() => select(onRunNow)}>Run now</UiV2MenuItem>
          <UiV2MenuItem icon="trash" tone="destructive" onClick={() => select(onDelete)}>Delete</UiV2MenuItem>
        </UiV2ResponsiveMenu>
      ) : null}
    </>
  );
}
