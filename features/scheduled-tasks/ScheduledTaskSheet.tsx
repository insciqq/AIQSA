"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { UiV2Button, UiV2Switch } from "@/components/ui-v2";
import { UiV2Sheet } from "@/components/ui-v2/SheetV2";
import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { useBeforeUnloadGuard } from "@/components/app-shell/useBeforeUnloadGuard";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import type { Catalog } from "@/lib/contracts/catalog";
import {
  SCHEDULED_TASK_PROMPT_MAX_LENGTH,
  SCHEDULED_TASK_TITLE_MAX_LENGTH,
  SCHEDULED_TASK_WEEKDAYS,
  type ScheduledTask,
  type ScheduledTaskChatMode,
  type ScheduledTaskEveryHours,
  type ScheduledTaskRun,
  type ScheduledTaskWeekday
} from "@/lib/contracts/scheduledTasks";
import {
  SCHEDULED_TASK_EVERY_HOURS_OPTIONS,
  SCHEDULED_TASK_REPEAT_OPTIONS,
  catalogModel,
  modelHasSearch,
  modelKey,
  sameScheduledTaskDraft,
  scheduledTaskDraftChatMode,
  scheduledTaskPreview,
  scheduledTaskToday,
  type ScheduledTaskEditorDraft,
  type ScheduledTaskFieldErrors,
  type ScheduledTaskHourlyWindow,
  type ScheduledTaskRepeat
} from "./scheduledTaskDraft";
import {
  SCHEDULED_TASK_CHAT_MODE_LABELS,
  WEEKDAY_LONG_LABELS,
  WEEKDAY_SHORT_LABELS,
  scheduledTaskRunRow,
  scheduledTaskTimeZoneOptions,
  timeZoneLabel
} from "./scheduledTaskPresentation";

const field = "v2-scheduled-field w-full min-w-0 rounded-lg border border-trace bg-answer-paper px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60";
const PROMPT_COUNTER_FROM = SCHEDULED_TASK_PROMPT_MAX_LENGTH - 1_000;
const CHAT_MODES: readonly ScheduledTaskChatMode[] = ["new", "same"];
const HOURLY_WINDOWS: readonly Readonly<{ label: string; value: ScheduledTaskHourlyWindow }>[] = [
  { label: "All day", value: "all_day" },
  { label: "Set hours", value: "hours" }
];

export type ScheduledTaskRecentRuns =
  | Readonly<{ state: "loading" }>
  | Readonly<{ state: "error" }>
  | Readonly<{ state: "ready"; runs: readonly ScheduledTaskRun[] }>;

export type ScheduledTaskSheetProps = Readonly<{
  busy: boolean;
  catalog: Catalog | null;
  draft: ScheduledTaskEditorDraft;
  emailAvailable: boolean;
  errors: ScheduledTaskFieldErrors;
  initialDraft: ScheduledTaskEditorDraft;
  notice: string | null;
  onChange(patch: Partial<ScheduledTaskEditorDraft>): void;
  onClose(): void;
  /** Leaves the editor for a run's chat; unsaved changes are confirmed first. */
  onOpenRunChat(chatId: string): void;
  /** The runs the history rendered with unread results, once per load. */
  onRunsShown(runs: readonly ScheduledTaskRun[]): void;
  onSubmit(): void;
  original: ScheduledTask | null;
  recentRuns: ScheduledTaskRecentRuns | null;
  viewerTimeZone: string;
}>;

function FieldError({ id, children }: Readonly<{ id: string; children: ReactNode }>) {
  return <p className="v2-scheduled-field-error" id={id} role="alert">{children}</p>;
}

function DayChips({ days, labelId, onToggle }: Readonly<{
  days: readonly ScheduledTaskWeekday[];
  labelId: string;
  onToggle(day: ScheduledTaskWeekday): void;
}>) {
  return (
    <div className="v2-scheduled-days" role="group" aria-labelledby={labelId}>
      {SCHEDULED_TASK_WEEKDAYS.map((day) => (
        <button
          key={day}
          type="button"
          className="v2-scheduled-day v2-focusable"
          aria-label={WEEKDAY_LONG_LABELS[day]}
          aria-pressed={days.includes(day)}
          onClick={() => onToggle(day)}
        >
          {WEEKDAY_SHORT_LABELS[day]}
        </button>
      ))}
    </div>
  );
}

function toggled(days: readonly ScheduledTaskWeekday[], day: ScheduledTaskWeekday): ScheduledTaskWeekday[] {
  return days.includes(day) ? days.filter((entry) => entry !== day) : [...days, day];
}

/** Create and edit sheet: one form, a live next-run preview and the task's recent runs. */
export function ScheduledTaskSheet({
  busy, catalog, draft, emailAvailable, errors, initialDraft, notice, onChange, onClose, onOpenRunChat, onRunsShown, onSubmit,
  original, recentRuns, viewerTimeZone
}: ScheduledTaskSheetProps) {
  const formId = useId();
  const ids = {
    title: useId(), prompt: useId(), promptCount: useId(), repeat: useId(), time: useId(), schedule: useId(),
    days: useId(), dayOfMonth: useId(), date: useId(), timeZone: useId(), model: useId(), search: useId(),
    searchHelp: useId(), email: useId(), emailHelp: useId(), form: useId(), monthHint: useId(),
    scheduleHeading: useId(), answerHeading: useId(), everyHours: useId(), until: useId(), untilHint: useId(),
    chatMode: useId(), chatModeHint: useId()
  };
  const titleInput = useRef<HTMLInputElement>(null);
  /** The navigation waiting for a discard answer: closing, or leaving for a run's chat. */
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const [now, setNow] = useState(() => new Date());
  const dirty = !sameScheduledTaskDraft(draft, initialDraft);
  useBeforeUnloadGuard(dirty || busy);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => titleInput.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);
  // The preview names a wall-clock time; keep it current while the sheet stays open.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const zones = useMemo(() => scheduledTaskTimeZoneOptions(viewerTimeZone, draft.timeZone), [viewerTimeZone, draft.timeZone]);
  const models = catalog?.models ?? [];
  const selectedModel = catalogModel(catalog, draft);
  const searchAvailable = modelHasSearch(catalog, selectedModel);
  const preview = scheduledTaskPreview(draft, original, now);
  const promptLength = Array.from(draft.prompt).length;
  const hourly = draft.repeat === "hourly";
  const chatMode = scheduledTaskDraftChatMode(draft);
  const leave = (proceed: () => void) => {
    if (busy) return;
    if (dirty) setPendingLeave(() => proceed);
    else proceed();
  };
  const requestClose = () => leave(onClose);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy) onSubmit();
  };
  const changeModel = (key: string) => {
    const model = models.find((candidate) => modelKey(candidate) === key);
    if (!model) return;
    onChange({
      modelId: model.modelId,
      provider: model.provider,
      ...(draft.searchEnabled && !modelHasSearch(catalog, model) ? { searchEnabled: false } : {})
    });
  };
  const describedBy = (...entries: (string | false | null | undefined)[]) => entries.filter(Boolean).join(" ") || undefined;
  const editing = Boolean(original);
  const timeInput = (id: string, label: string) => (
    <div className="v2-scheduled-control">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className={field}
        type="time"
        step={60}
        required
        value={draft.time}
        aria-invalid={Boolean(errors.schedule) || undefined}
        onChange={(event) => onChange({ time: event.target.value.slice(0, 5) })}
      />
    </div>
  );

  return (
    <UiV2Sheet
      open
      phoneFullScreen
      width="wide"
      testId="scheduled-task-sheet"
      title={editing ? "Edit scheduled task" : "New scheduled task"}
      description="Runs your instructions on a schedule and adds each answer to a chat."
      closeBlocked={busy}
      onClose={requestClose}
      footer={<>
        <p className="v2-scheduled-preview" aria-live="polite" data-testid="scheduled-task-preview">{preview}</p>
        <span className="v2-scheduled-footer-actions">
          <UiV2Button type="button" disabled={busy} onClick={requestClose}>Cancel</UiV2Button>
          <UiV2Button type="submit" form={formId} tone="primary" busy={busy}>{editing ? "Save changes" : "Create task"}</UiV2Button>
        </span>
      </>}
    >
      <form id={formId} className="v2-scheduled-form" noValidate aria-label={editing ? "Edit scheduled task" : "New scheduled task"} onSubmit={submit}>
        {notice ? <p className="v2-scheduled-sheet-notice" role="status">{notice}</p> : null}
        {errors.form ? <p className="v2-scheduled-form-error" id={ids.form} role="alert">{errors.form}</p> : null}
        <fieldset className="v2-scheduled-fields" disabled={busy}>
          <div className="v2-scheduled-control">
            <label htmlFor={ids.title}>Name</label>
            <input
              ref={titleInput}
              id={ids.title}
              className={field}
              autoComplete="off"
              maxLength={SCHEDULED_TASK_TITLE_MAX_LENGTH}
              placeholder="Morning news brief"
              value={draft.title}
              aria-invalid={Boolean(errors.title) || undefined}
              aria-describedby={describedBy(errors.title && `${ids.title}-error`)}
              onChange={(event) => onChange({ title: event.target.value })}
            />
            {errors.title ? <FieldError id={`${ids.title}-error`}>{errors.title}</FieldError> : null}
          </div>
          <div className="v2-scheduled-control">
            <label htmlFor={ids.prompt}>Instructions</label>
            <textarea
              id={ids.prompt}
              className={`${field} v2-scheduled-prompt`}
              rows={5}
              placeholder="Summarize the most important technology news from the last day in five bullet points."
              value={draft.prompt}
              aria-invalid={Boolean(errors.prompt) || undefined}
              aria-describedby={describedBy(promptLength >= PROMPT_COUNTER_FROM && ids.promptCount, errors.prompt && `${ids.prompt}-error`)}
              onChange={(event) => onChange({ prompt: event.target.value })}
            />
            {promptLength >= PROMPT_COUNTER_FROM ? (
              <p className="v2-scheduled-hint" id={ids.promptCount} data-over={promptLength > SCHEDULED_TASK_PROMPT_MAX_LENGTH || undefined}>
                {promptLength.toLocaleString("en-US")} of {SCHEDULED_TASK_PROMPT_MAX_LENGTH.toLocaleString("en-US")} characters
              </p>
            ) : null}
            {errors.prompt ? <FieldError id={`${ids.prompt}-error`}>{errors.prompt}</FieldError> : null}
          </div>

          <div className="v2-scheduled-group" role="group" aria-labelledby={ids.scheduleHeading}
            aria-describedby={describedBy(errors.schedule && ids.schedule)}>
            <h3 id={ids.scheduleHeading}>Schedule</h3>
            <div className="v2-scheduled-pair">
              <div className="v2-scheduled-control">
                <label htmlFor={ids.repeat}>Repeat</label>
                <select id={ids.repeat} className={field} value={draft.repeat}
                  onChange={(event) => onChange({ repeat: event.target.value as ScheduledTaskRepeat })}>
                  {SCHEDULED_TASK_REPEAT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
              {hourly ? (
                <div className="v2-scheduled-control">
                  <label htmlFor={ids.everyHours}>Interval</label>
                  <select id={ids.everyHours} className={field} value={draft.everyHours}
                    onChange={(event) => onChange({ everyHours: Number(event.target.value) as ScheduledTaskEveryHours })}>
                    {SCHEDULED_TASK_EVERY_HOURS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
              ) : timeInput(ids.time, "Time")}
            </div>
            {hourly ? (
              <>
                <fieldset className="v2-scheduled-choice">
                  <legend className="v2-scheduled-label">Hours</legend>
                  <div className="v2-scheduled-options" data-inline="">
                    {HOURLY_WINDOWS.map((option) => (
                      <label key={option.value} className="v2-scheduled-option">
                        <input
                          type="radio"
                          name={`${formId}-window`}
                          checked={draft.hourlyWindow === option.value}
                          onChange={() => onChange({ hourlyWindow: option.value })}
                        />
                        <span>{option.label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                {draft.hourlyWindow === "hours" ? (
                  <div className="v2-scheduled-pair">
                    {timeInput(ids.time, "From")}
                    <div className="v2-scheduled-control">
                      <label htmlFor={ids.until}>Until</label>
                      <input
                        id={ids.until}
                        className={field}
                        type="time"
                        step={60}
                        value={draft.until}
                        aria-invalid={Boolean(errors.schedule) || undefined}
                        aria-describedby={describedBy(!draft.until && ids.untilHint)}
                        onChange={(event) => onChange({ until: event.target.value.slice(0, 5) })}
                      />
                    </div>
                    {!draft.until ? <p className="v2-scheduled-hint v2-scheduled-pair-hint" id={ids.untilHint}>Without an end time it runs until the end of the day.</p> : null}
                  </div>
                ) : null}
                <div className="v2-scheduled-control">
                  <span id={ids.days} className="v2-scheduled-label">Days</span>
                  <DayChips days={draft.hourlyDays} labelId={ids.days}
                    onToggle={(day) => onChange({ hourlyDays: toggled(draft.hourlyDays, day) })} />
                </div>
              </>
            ) : null}
            {draft.repeat === "weekly" ? (
              <div className="v2-scheduled-control">
                <span id={ids.days} className="v2-scheduled-label">Days</span>
                <DayChips days={draft.days} labelId={ids.days} onToggle={(day) => onChange({ days: toggled(draft.days, day) })} />
              </div>
            ) : null}
            {draft.repeat === "monthly" ? (
              <div className="v2-scheduled-control">
                <label htmlFor={ids.dayOfMonth}>Day of the month</label>
                <select
                  id={ids.dayOfMonth}
                  className={`${field} v2-scheduled-narrow`}
                  value={draft.dayOfMonth}
                  aria-describedby={ids.monthHint}
                  onChange={(event) => onChange({ dayOfMonth: Number(event.target.value) })}
                >
                  {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => <option key={day} value={day}>{day}</option>)}
                </select>
                <p className="v2-scheduled-hint" id={ids.monthHint}>Shorter months use their last day.</p>
              </div>
            ) : null}
            {draft.repeat === "once" ? (
              <div className="v2-scheduled-control">
                <label htmlFor={ids.date}>Date</label>
                <input
                  id={ids.date}
                  className={`${field} v2-scheduled-narrow`}
                  type="date"
                  required
                  min={scheduledTaskToday(draft.timeZone, now)}
                  value={draft.date}
                  aria-invalid={Boolean(errors.schedule) || undefined}
                  onChange={(event) => onChange({ date: event.target.value })}
                />
              </div>
            ) : null}
            {errors.schedule ? <FieldError id={ids.schedule}>{errors.schedule}</FieldError> : null}
            <div className="v2-scheduled-control">
              <label htmlFor={ids.timeZone}>Time zone</label>
              <select
                id={ids.timeZone}
                className={field}
                value={draft.timeZone}
                aria-invalid={Boolean(errors.timeZone) || undefined}
                aria-describedby={describedBy(errors.timeZone && `${ids.timeZone}-error`)}
                onChange={(event) => onChange({ timeZone: event.target.value })}
              >
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone === viewerTimeZone ? `${timeZoneLabel(zone)} (this device)` : timeZoneLabel(zone)}
                  </option>
                ))}
              </select>
              {errors.timeZone ? <FieldError id={`${ids.timeZone}-error`}>{errors.timeZone}</FieldError> : null}
            </div>
          </div>

          <div className="v2-scheduled-group" role="group" aria-labelledby={ids.answerHeading}>
            <h3 id={ids.answerHeading}>Answer</h3>
            <div className="v2-scheduled-control">
              <label htmlFor={ids.model}>Model</label>
              <select
                id={ids.model}
                className={field}
                value={draft.modelId ? modelKey(draft) : ""}
                disabled={!catalog || models.length === 0}
                aria-invalid={Boolean(errors.model) || undefined}
                aria-describedby={describedBy(errors.model && `${ids.model}-error`)}
                onChange={(event) => changeModel(event.target.value)}
              >
                {!draft.modelId ? <option value="" disabled>{catalog ? "No models available" : "Loading models…"}</option> : null}
                {draft.modelId && !selectedModel ? <option value={modelKey(draft)} disabled>Unavailable model</option> : null}
                {models.map((model) => {
                  const provider = catalog?.providers.find((entry) => entry.id === model.provider)?.name;
                  return <option key={modelKey(model)} value={modelKey(model)}>{provider ? `${model.displayName} · ${provider}` : model.displayName}</option>;
                })}
              </select>
              {errors.model ? <FieldError id={`${ids.model}-error`}>{errors.model}</FieldError> : null}
            </div>
            <fieldset className="v2-scheduled-choice" id={ids.chatMode}
              aria-describedby={describedBy(hourly && ids.chatModeHint, errors.chatMode && `${ids.chatMode}-error`)}>
              <legend className="v2-scheduled-label">Chat</legend>
              <div className="v2-scheduled-options">
                {CHAT_MODES.map((mode) => (
                  <label key={mode} className="v2-scheduled-option">
                    <input
                      type="radio"
                      name={`${formId}-chat-mode`}
                      checked={chatMode === mode}
                      disabled={hourly && mode === "new"}
                      onChange={() => onChange({ chatMode: mode })}
                    />
                    <span>{SCHEDULED_TASK_CHAT_MODE_LABELS[mode]}</span>
                  </label>
                ))}
              </div>
              {hourly ? <p className="v2-scheduled-hint" id={ids.chatModeHint}>Hourly tasks always continue in one chat.</p> : null}
              {errors.chatMode ? <FieldError id={`${ids.chatMode}-error`}>{errors.chatMode}</FieldError> : null}
            </fieldset>
            <div className="v2-scheduled-toggle">
              <span className="v2-scheduled-toggle-copy">
                <span id={ids.search} className="v2-scheduled-label">Web search</span>
                <span id={ids.searchHelp} className="v2-scheduled-hint">
                  {searchAvailable || draft.searchEnabled
                    ? "Lets the model look up current information for each run."
                    : "Not available with this model."}
                </span>
              </span>
              <UiV2Switch
                checked={draft.searchEnabled}
                disabled={busy || (!searchAvailable && !draft.searchEnabled)}
                label="Web search"
                aria-describedby={describedBy(ids.searchHelp, errors.search && `${ids.search}-error`)}
                onChange={(searchEnabled) => onChange({ searchEnabled })}
              />
              {errors.search ? <FieldError id={`${ids.search}-error`}>{errors.search}</FieldError> : null}
            </div>
            {emailAvailable ? (
              <div className="v2-scheduled-toggle">
                <span className="v2-scheduled-toggle-copy">
                  <span id={ids.email} className="v2-scheduled-label">Email me when it runs</span>
                  <span id={ids.emailHelp} className="v2-scheduled-hint">The email contains the task title and a link, never the answer.</span>
                </span>
                <UiV2Switch
                  checked={draft.emailNotify}
                  disabled={busy}
                  label="Email me when it runs"
                  aria-describedby={ids.emailHelp}
                  onChange={(emailNotify) => onChange({ emailNotify })}
                />
              </div>
            ) : null}
          </div>

          {recentRuns ? (
            <RecentRuns
              recentRuns={recentRuns}
              timeZone={original?.timeZone ?? draft.timeZone}
              now={now}
              onOpenChat={(chatId) => leave(() => onOpenRunChat(chatId))}
              onRunsShown={onRunsShown}
            />
          ) : null}
        </fieldset>
      </form>
      {pendingLeave ? (
        <ConfirmationDialog
          cancelLabel="Keep editing"
          confirmLabel="Discard changes"
          dialogLabel="Unsaved scheduled task"
          title="Discard unsaved changes?"
          testId="scheduled-task-discard"
          tone="warning"
          onCancel={() => setPendingLeave(null)}
          onConfirm={() => { const proceed = pendingLeave; setPendingLeave(null); proceed(); }}
        >
          Your changes to this scheduled task will be lost.
        </ConfirmationDialog>
      ) : null}
    </UiV2Sheet>
  );
}

function RecentRuns({ recentRuns, timeZone, now, onOpenChat, onRunsShown }: Readonly<{
  recentRuns: ScheduledTaskRecentRuns;
  timeZone: string;
  now: Date;
  onOpenChat(chatId: string): void;
  onRunsShown(runs: readonly ScheduledTaskRun[]): void;
}>) {
  const headingId = useId();
  const shown = useEventCallback(onRunsShown);
  // Runs count as seen only after this list has rendered them.
  useEffect(() => {
    if (recentRuns.state !== "ready") return;
    const unseen = recentRuns.runs.filter((run) => run.unseen);
    if (unseen.length) shown(unseen);
  }, [recentRuns, shown]);
  return (
    <section className="v2-scheduled-runs" aria-labelledby={headingId}>
      <h3 id={headingId}>Recent runs</h3>
      {recentRuns.state === "loading" ? <p className="v2-scheduled-hint" role="status">Loading recent runs…</p>
        : recentRuns.state === "error" ? <p className="v2-scheduled-hint" role="status">Recent runs could not be loaded.</p>
          : recentRuns.runs.length === 0 ? <p className="v2-scheduled-hint">No runs yet.</p>
            : (
              <ul>
                {recentRuns.runs.map((run) => {
                  const row = scheduledTaskRunRow(run, timeZone, now);
                  const chatId = run.chatId;
                  return (
                    <li key={run.id} data-tone={row.tone} data-unseen={run.unseen || undefined}>
                      <span className="v2-scheduled-run-time">{row.time}</span>
                      <span className="v2-scheduled-run-trigger">{row.trigger}</span>
                      <span className="v2-scheduled-run-outcome">
                        {run.unseen ? <><span className="v2-scheduled-unread" aria-hidden="true" /><span className="sr-only">New result: </span></> : null}
                        {row.outcome}
                      </span>
                      {chatId ? (
                        <button type="button" className="v2-scheduled-run-chat v2-focusable"
                          aria-label={`Open chat from ${row.time}`} onClick={() => onOpenChat(chatId)}>
                          Open chat
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
    </section>
  );
}
