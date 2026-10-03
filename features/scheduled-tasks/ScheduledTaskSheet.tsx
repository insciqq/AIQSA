"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { UiV2Button, UiV2Switch } from "@/components/ui-v2";
import { UiV2Sheet } from "@/components/ui-v2/SheetV2";
import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { useBeforeUnloadGuard } from "@/components/app-shell/useBeforeUnloadGuard";
import type { Catalog } from "@/lib/contracts/catalog";
import {
  SCHEDULED_TASK_PROMPT_MAX_LENGTH,
  SCHEDULED_TASK_TITLE_MAX_LENGTH,
  SCHEDULED_TASK_WEEKDAYS,
  type ScheduledTask,
  type ScheduledTaskRun
} from "@/lib/contracts/scheduledTasks";
import {
  SCHEDULED_TASK_REPEAT_OPTIONS,
  catalogModel,
  modelHasSearch,
  modelKey,
  sameScheduledTaskDraft,
  scheduledTaskPreview,
  scheduledTaskToday,
  type ScheduledTaskEditorDraft,
  type ScheduledTaskFieldErrors,
  type ScheduledTaskRepeat
} from "./scheduledTaskDraft";
import {
  WEEKDAY_LONG_LABELS,
  WEEKDAY_SHORT_LABELS,
  scheduledTaskRunRow,
  scheduledTaskTimeZoneOptions,
  timeZoneLabel
} from "./scheduledTaskPresentation";

const field = "v2-scheduled-field w-full min-w-0 rounded-lg border border-trace bg-answer-paper px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60";
const PROMPT_COUNTER_FROM = SCHEDULED_TASK_PROMPT_MAX_LENGTH - 1_000;

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
  onSubmit(): void;
  original: ScheduledTask | null;
  recentRuns: ScheduledTaskRecentRuns | null;
  viewerTimeZone: string;
}>;

function FieldError({ id, children }: Readonly<{ id: string; children: ReactNode }>) {
  return <p className="v2-scheduled-field-error" id={id} role="alert">{children}</p>;
}

/** Create and edit sheet: one form, a live next-run preview and the task's recent runs. */
export function ScheduledTaskSheet({
  busy, catalog, draft, emailAvailable, errors, initialDraft, notice, onChange, onClose, onSubmit, original,
  recentRuns, viewerTimeZone
}: ScheduledTaskSheetProps) {
  const formId = useId();
  const ids = {
    title: useId(), prompt: useId(), promptCount: useId(), repeat: useId(), time: useId(), schedule: useId(),
    days: useId(), dayOfMonth: useId(), date: useId(), timeZone: useId(), model: useId(), search: useId(),
    searchHelp: useId(), email: useId(), emailHelp: useId(), form: useId(), monthHint: useId(),
    scheduleHeading: useId(), answerHeading: useId()
  };
  const titleInput = useRef<HTMLInputElement>(null);
  const [discarding, setDiscarding] = useState(false);
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
  const requestClose = () => {
    if (busy) return;
    if (dirty) setDiscarding(true);
    else onClose();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy) onSubmit();
  };
  const changeRepeat = (repeat: ScheduledTaskRepeat) => onChange({ repeat });
  const toggleDay = (day: (typeof SCHEDULED_TASK_WEEKDAYS)[number]) => onChange({
    days: draft.days.includes(day) ? draft.days.filter((entry) => entry !== day) : [...draft.days, day]
  });
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

  return (
    <UiV2Sheet
      open
      phoneFullScreen
      width="wide"
      testId="scheduled-task-sheet"
      title={editing ? "Edit scheduled task" : "New scheduled task"}
      description="Runs your instructions on a schedule. Each answer is added to the task's own chat."
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
                <select id={ids.repeat} className={field} value={draft.repeat} onChange={(event) => changeRepeat(event.target.value as ScheduledTaskRepeat)}>
                  {SCHEDULED_TASK_REPEAT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
              <div className="v2-scheduled-control">
                <label htmlFor={ids.time}>Time</label>
                <input
                  id={ids.time}
                  className={field}
                  type="time"
                  step={60}
                  required
                  value={draft.time}
                  aria-invalid={Boolean(errors.schedule) || undefined}
                  onChange={(event) => onChange({ time: event.target.value.slice(0, 5) })}
                />
              </div>
            </div>
            {draft.repeat === "weekly" ? (
              <div className="v2-scheduled-control">
                <span id={ids.days} className="v2-scheduled-label">Days</span>
                <div className="v2-scheduled-days" role="group" aria-labelledby={ids.days}>
                  {SCHEDULED_TASK_WEEKDAYS.map((day) => (
                    <button
                      key={day}
                      type="button"
                      className="v2-scheduled-day v2-focusable"
                      aria-label={WEEKDAY_LONG_LABELS[day]}
                      aria-pressed={draft.days.includes(day)}
                      onClick={() => toggleDay(day)}
                    >
                      {WEEKDAY_SHORT_LABELS[day]}
                    </button>
                  ))}
                </div>
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

          {recentRuns ? <RecentRuns recentRuns={recentRuns} timeZone={original?.timeZone ?? draft.timeZone} now={now} /> : null}
        </fieldset>
      </form>
      {discarding ? (
        <ConfirmationDialog
          cancelLabel="Keep editing"
          confirmLabel="Discard changes"
          dialogLabel="Unsaved scheduled task"
          title="Discard unsaved changes?"
          testId="scheduled-task-discard"
          tone="warning"
          onCancel={() => setDiscarding(false)}
          onConfirm={() => { setDiscarding(false); onClose(); }}
        >
          Your changes to this scheduled task will be lost.
        </ConfirmationDialog>
      ) : null}
    </UiV2Sheet>
  );
}

function RecentRuns({ recentRuns, timeZone, now }: Readonly<{ recentRuns: ScheduledTaskRecentRuns; timeZone: string; now: Date }>) {
  const headingId = useId();
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
                  return (
                    <li key={`${run.trigger}:${run.scheduledFor}`} data-tone={row.tone}>
                      <span className="v2-scheduled-run-time">{row.time}</span>
                      <span className="v2-scheduled-run-trigger">{row.trigger}</span>
                      <span className="v2-scheduled-run-outcome">{row.outcome}</span>
                    </li>
                  );
                })}
              </ul>
            )}
    </section>
  );
}
