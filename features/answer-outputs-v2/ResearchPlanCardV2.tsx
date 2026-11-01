"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { composerSessionKey, useComposerSessionStore } from "@/components/app-shell/composerSessionStore";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import { writeClipboardText } from "@/components/clipboard/writeClipboardText";
import { UiV2Button, UiV2IconButton } from "@/components/ui-v2";
import { workspacePlanV2 } from "@/features/run-lifecycle-v2/workspaceActivityPresentation";
import { RESEARCH_PLAN_LIMITS, type ResearchPlanEdit, type ResearchPlanRelease } from "@/lib/contracts/research";
import type { ThreadWorkspaceActivity, ThreadWorkspaceActivityEntry } from "@/lib/contracts/workspace";
import {
  actOnResearchPlan,
  readResearchPlan,
  ResearchPlanApiError,
  type ResearchPlanCardView,
  type ResearchPlanOutcome,
  type ResearchPlanRequest
} from "./researchPlanApi";
import {
  RESEARCH_PLAN_CLOSED_COPY,
  RESEARCH_PLAN_COPY as COPY,
  researchPlanAssumptionLabel,
  researchPlanDeleteLabel,
  researchPlanEditText,
  researchPlanHeldElsewhereLeft,
  researchPlanHeldLeft,
  researchPlanStartsIn,
  researchPlanStepLabel,
  researchPlanTime
} from "./researchPlanCopy";
import "./research-plan.css";

const TICK_MS = 1_000;
/** How often an open window re-reads the route: a second tab, an edit elsewhere and a close all show by this read. */
const READ_MS = 5_000;
/** At zero the answer is a moment away, so the read comes sooner; `ZERO_READS` of those, then the ordinary pace. */
const ZERO_READ_MS = 1_000;
const ZERO_READS = 30;
const READ_BACKOFF_MAX_MS = 60_000;
/** A window at zero looks gone for the moment its own timer takes, so a run counts as gone on the second such read. */
const GONE_READS = 2;
/** A lease renews this long before it ends: more than the minute a throttled background tab may wait for its timer. */
const RENEW_MARGIN_MS = 90_000;
const HOLD_RETRY_MS = 5_000;

const failedStatus = (failure: unknown) => failure instanceof ResearchPlanApiError ? failure.status : null;

type PlanWindow = Readonly<{
  act(request: ResearchPlanRequest): Promise<ResearchPlanOutcome>;
  /** The run is gone (Stop, a restart) or the route does not know it. */
  gone: boolean;
  holdFailed: boolean;
  /** The server's last lease ran: renewing no longer moves `heldUntil`. */
  leaseSpent: boolean;
  /** The server's time now, counted from its last read with this tab's monotonic clock. */
  now: number | null;
  read(): void;
  readFailed: boolean;
  view: ResearchPlanCardView | null;
}>;

/**
 * One window as the route says it, the one owner of its state. Times are the server's: `serverTime` anchors a monotonic clock, so a wrong
 * or moved client clock changes nothing, and a timer a background tab throttled comes back late and re-reads. While `editing`, the lease
 * renews before it ends; the server caps it, so a tab left renewing cannot spend the turn.
 */
function useResearchPlanWindow({ active, chatId, editing, runId }: Readonly<{ active: boolean; chatId: string; editing: boolean; runId: string }>): PlanWindow {
  const [view, setView] = useState<ResearchPlanCardView | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [gone, setGone] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [holdFailed, setHoldFailed] = useState(false);
  const [leaseSpent, setLeaseSpent] = useState(false);
  const live = useRef({
    anchor: null as Readonly<{ local: number; server: number }> | null,
    failures: 0,
    goneReads: 0,
    held: null as Promise<void> | null,
    holdAt: 0,
    holding: false,
    latest: 0,
    nextRead: 0,
    reading: false,
    spent: false,
    view: null as ResearchPlanCardView | null,
    zeroReads: 0
  });

  /** Replies may cross: the newest server time wins. */
  const adopt = useCallback((next: ResearchPlanCardView, local: number) => {
    const state = live.current;
    const server = Date.parse(next.serverTime);
    if (server < state.latest) return;
    state.latest = server;
    state.anchor = { local, server };
    state.view = next;
    const looksGone = next.answer === null && next.heldUntil === null && Date.parse(next.windowEndsAt) <= server;
    state.goneReads = looksGone ? state.goneReads + 1 : 0;
    setView(next);
    setNow(server);
    if (state.goneReads >= GONE_READS) setGone(true);
  }, []);

  const read = useCallback(async () => {
    const state = live.current;
    if (state.reading) return;
    state.reading = true;
    const sent = performance.now();
    try {
      const next = await readResearchPlan({ chatId, runId });
      state.failures = 0;
      setReadFailed(false);
      adopt(next, (sent + performance.now()) / 2);
    } catch (failure) {
      if (failedStatus(failure) === 404) setGone(true);
      else {
        state.failures += 1;
        setReadFailed(true);
      }
    } finally {
      state.reading = false;
      const shown = state.view;
      const atZero = shown !== null && Date.parse(shown.heldUntil ?? shown.windowEndsAt) <= state.latest;
      if (atZero) state.zeroReads += 1;
      const pace = state.failures > 0 ? Math.min(READ_MS * 2 ** (state.failures - 1), READ_BACKOFF_MAX_MS)
        : atZero && state.zeroReads <= ZERO_READS ? ZERO_READ_MS : READ_MS;
      state.nextRead = performance.now() + pace;
    }
  }, [adopt, chatId, runId]);

  const post = useCallback(async (request: ResearchPlanRequest): Promise<ResearchPlanOutcome> => {
    const sent = performance.now();
    try {
      const result = await actOnResearchPlan({ chatId, request, runId });
      adopt(result.view, (sent + performance.now()) / 2);
      return result.outcome;
    } catch (failure) {
      if (failedStatus(failure) === 404) setGone(true);
      throw failure;
    }
  }, [adopt, chatId, runId]);

  const hold = useCallback(() => {
    const state = live.current;
    if (state.held) return;
    const before = state.view?.heldUntil ?? null;
    state.held = post({ action: "hold" }).then(() => {
      const after = state.view?.heldUntil ?? null;
      setHoldFailed(false);
      if (before && after && Date.parse(after) <= Date.parse(before)) {
        state.spent = true;
        setLeaseSpent(true);
      }
    }, () => {
      state.holdAt = performance.now() + HOLD_RETRY_MS;
      setHoldFailed(true);
    }).finally(() => { state.held = null; });
  }, [post]);

  const act = useCallback(async (request: ResearchPlanRequest) => {
    const state = live.current;
    if (request.action === "cancel_hold") state.holding = false;
    // A cancel must not overtake the hold it ends.
    await state.held;
    return post(request);
  }, [post]);

  useEffect(() => {
    const state = live.current;
    state.holding = editing;
    if (editing && active) hold();
  }, [active, editing, hold]);

  const settled = gone || view?.answer != null;
  useEffect(() => {
    if (!active || settled) return;
    const state = live.current;
    const tick = () => {
      const local = performance.now();
      const server = state.anchor ? state.anchor.server + local - state.anchor.local : null;
      if (server !== null) setNow(server);
      const shown = state.view;
      const justAtZero = server !== null && shown !== null && state.zeroReads === 0 && server >= Date.parse(shown.heldUntil ?? shown.windowEndsAt);
      if (local >= state.nextRead || justAtZero) void read();
      if (!state.holding || state.spent || state.held || local < state.holdAt) return;
      const heldUntil = state.view?.heldUntil ?? null;
      if (!heldUntil || (server !== null && server >= Date.parse(heldUntil) - RENEW_MARGIN_MS)) hold();
    };
    const visible = () => {
      if (document.visibilityState !== "visible") return;
      state.nextRead = 0;
      tick();
    };
    tick();
    const timer = setInterval(tick, TICK_MS);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [active, hold, read, settled]);

  return { act, gone, holdFailed, leaseSpent, now, read: () => void read(), readFailed, view };
}

type DraftRow = Readonly<{ id: number; text: string }>;
type Draft = Readonly<{ assumptions: readonly DraftRow[]; steps: readonly DraftRow[]; understood: string }>;

type DraftList = "assumptions" | "steps";

const withRows = (draft: Draft, list: DraftList, rows: readonly DraftRow[]): Draft =>
  list === "steps" ? { ...draft, steps: rows } : { ...draft, assumptions: rows };

function draftWords(draft: Draft): ResearchPlanEdit {
  const texts = (rows: readonly DraftRow[]) => rows.map((row) => row.text.trim()).filter(Boolean);
  return { assumptions: texts(draft.assumptions), steps: texts(draft.steps), understood: draft.understood.trim() };
}

function sameWords(one: ResearchPlanEdit, other: ResearchPlanEdit): boolean {
  const same = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((entry, index) => entry === right[index]);
  return one.understood === other.understood && same(one.steps, other.steps) && same(one.assumptions, other.assumptions);
}

function PlanWordsV2({ words }: Readonly<{ words: ResearchPlanEdit }>) {
  return (
    <>
      {words.understood ? (
        <section className="v2-research-plan-part">
          <h3>{COPY.understood}</h3>
          <p>{words.understood}</p>
        </section>
      ) : null}
      {words.assumptions.length > 0 ? (
        <section className="v2-research-plan-part">
          <h3>{COPY.assumptions}</h3>
          <ul>{words.assumptions.map((entry, index) => <li key={`${index}:${entry}`}>{entry}</li>)}</ul>
        </section>
      ) : null}
      <section className="v2-research-plan-part">
        <h3>{COPY.steps}</h3>
        <ol>{words.steps.map((entry, index) => <li key={`${index}:${entry}`}>{entry}</li>)}</ol>
      </section>
    </>
  );
}

function PlanRowsV2({ addLabel, disabled, heading, labelOf, list, max, maxLength, min, onAdd, onChange, onDelete, rows }: Readonly<{
  addLabel: string;
  disabled: boolean;
  heading: string;
  labelOf(index: number): string;
  list: DraftList;
  max: number;
  maxLength: number;
  min: number;
  onAdd(): void;
  onChange(id: number, text: string): void;
  onDelete(id: number): void;
  rows: readonly DraftRow[];
}>) {
  return (
    <section className="v2-research-plan-part" aria-label={heading}>
      <h3>{heading}</h3>
      {rows.length > 0 ? (
        <ol className="v2-research-plan-rows" data-numbered={list === "steps" || undefined}>
          {rows.map((row, index) => (
            <li key={row.id}>
              <textarea aria-label={labelOf(index)} className="v2-research-plan-field v2-focusable" data-plan-row={row.id} disabled={disabled}
                maxLength={maxLength} onChange={(event) => onChange(row.id, event.target.value)} rows={2} value={row.text} />
              <UiV2IconButton data-plan-delete={row.id} disabled={disabled || rows.length <= min} icon="trash"
                label={researchPlanDeleteLabel(labelOf(index))} onClick={() => onDelete(row.id)} />
            </li>
          ))}
        </ol>
      ) : null}
      {rows.length < max ? (
        <UiV2Button data-plan-add={list} disabled={disabled} icon="plus" onClick={onAdd} type="button">{addLabel}</UiV2Button>
      ) : null}
    </section>
  );
}

/**
 * The window closed under a person's edit. Their text stays here, past the card and the row that held it, and they choose what to do with it:
 * copy it, or put it in the composer, where a message reaches the running research as a follow-up.
 */
function ClosedEditV2({ chatId, how, onDismiss, words }: Readonly<{
  chatId: string;
  how: ResearchPlanRelease | "stopped";
  onDismiss(): void;
  words: ResearchPlanEdit;
}>) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const text = researchPlanEditText(words);
  useEffect(() => {
    // Its editor is gone, so focus would fall to the page.
    if (document.activeElement === document.body) statusRef.current?.focus({ preventScroll: true });
  }, []);

  function putInMessage() {
    const placed = useComposerSessionStore.getState().updateSession(composerSessionKey(chatId), (current) => ({
      draft: [current.draft, text].filter(Boolean).join("\n\n")
    }));
    if (!placed) return;
    document.querySelector<HTMLTextAreaElement>("textarea.v2-composer-input")?.focus();
    onDismiss();
  }

  return (
    <section aria-label={COPY.title} className="v2-research-plan" data-state="closed" data-testid="research-plan-card">
      <div className="v2-research-plan-heading"><strong>{COPY.closedHeading}</strong></div>
      <p className="v2-research-plan-status" ref={statusRef} role="status" tabIndex={-1}>{RESEARCH_PLAN_CLOSED_COPY[how]}</p>
      <section className="v2-research-plan-part">
        <h3>{COPY.mine}</h3>
        <p className="v2-research-plan-kept">{text}</p>
      </section>
      {copied !== null ? <p className="v2-research-plan-status" role="status">{copied ? COPY.copied : COPY.copyFailed}</p> : null}
      <div className="v2-research-plan-actions">
        <UiV2Button onClick={onDismiss} type="button">{COPY.dismiss}</UiV2Button>
        <UiV2Button icon="copy" onClick={() => void writeClipboardText(text).then(() => setCopied(true), () => setCopied(false))} type="button">{COPY.copy}</UiV2Button>
        <UiV2Button onClick={putInMessage} tone="primary" type="button">{COPY.sendAsMessage}</UiV2Button>
      </div>
    </section>
  );
}

type Phase = "answered" | "closing" | "editing" | "failed" | "gone" | "held" | "loading" | "window";

function phaseOf(plan: PlanWindow, draft: Draft | null, remaining: number): Phase {
  if (plan.view?.answer) return "answered";
  if (draft) return "editing";
  if (plan.gone) return "gone";
  if (!plan.view) return plan.readFailed ? "failed" : "loading";
  if (remaining <= 0) return "closing";
  return plan.view.heldUntil ? "held" : "window";
}

/** What assistive technology hears: it changes only at these moments, never with the seconds. */
function announcementOf(phase: Phase, held: boolean, remaining: number, live: boolean): string {
  switch (phase) {
    case "answered": return live ? COPY.answerLive : COPY.answerSettled;
    case "closing": return COPY.announceClosing;
    case "gone": return COPY.gone;
    case "failed": return COPY.loadFailed;
    case "loading": return "";
    case "editing": case "held": case "window":
      if (held) return COPY.announceHeld;
      return remaining <= 10_000 ? COPY.announceTen : remaining <= 30_000 ? COPY.announceThirty : COPY.announceOpen;
  }
}

function ResearchPlanRunV2({ chatId, live, row, runId }: Readonly<{ chatId: string; live: boolean; row: ThreadWorkspaceActivityEntry | null; runId: string }>) {
  const state = row?.researchPlan?.state ?? null;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<"cancel" | "resume" | "save" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plan = useResearchPlanWindow({ active: state === "window" || draft !== null, chatId, editing: draft !== null, runId });
  const pending = useRef(false);
  const rootRef = useRef<HTMLElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const focusTarget = useRef<string | null>(null);
  const nextRowId = useRef(0);

  const { view } = plan;
  const due = view ? Date.parse(view.heldUntil ?? view.windowEndsAt) : 0;
  const remaining = view ? due - (plan.now ?? Date.parse(view.serverTime)) : 0;
  const phase = phaseOf(plan, draft, remaining);
  const previousPhase = useRef(phase);

  useEffect(() => {
    const target = focusTarget.current;
    if (!target) return;
    focusTarget.current = null;
    rootRef.current?.querySelector<HTMLElement>(target)?.focus();
  });
  useEffect(() => {
    const from = previousPhase.current;
    previousPhase.current = phase;
    if ((phase !== "answered" && phase !== "gone") || (from !== "editing" && from !== "window" && from !== "held" && from !== "closing")) return;
    // The controls that held focus are gone: it stays in the card, on what happened.
    const active = document.activeElement;
    if (active === document.body || rootRef.current?.contains(active)) statusRef.current?.focus({ preventScroll: true });
  }, [phase]);

  if (state === "scoping" && !draft) {
    return (
      <div className="v2-research-plan-scoping" data-state="scoping" data-testid="research-plan-card" role="status">
        <span className="v2-spinner" aria-hidden="true" />
        <span>{row?.items?.[0]?.text}</span>
      </div>
    );
  }

  const answer = view?.answer ?? null;
  if (draft && (answer ? !sameWords(answer.plan, draftWords(draft)) : plan.gone)) {
    return <ClosedEditV2 chatId={chatId} how={answer?.releasedBy ?? "stopped"} onDismiss={() => setDraft(null)} words={draftWords(draft)} />;
  }
  // The row's update took over: an ordinary plan shows in the fold. An edit waits here for the read that says how the window closed.
  if (!row && (!draft || answer)) return null;

  async function run(action: "cancel" | "resume" | "save" | "start", work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(action);
    setError(null);
    try {
      await work();
    } finally {
      pending.current = false;
      setBusy(null);
    }
  }

  const start = () => run("start", async () => {
    await plan.act({ action: "start" }).catch((failure: unknown) => {
      if (failedStatus(failure) !== 404) setError(COPY.startFailed);
    });
  });

  /** The start button under an edit: what the person wrote goes with it, and an edit that changed nothing is a plain start. */
  const save = (current: Draft) => run("save", async () => {
    const words = draftWords(current);
    if (!words.understood || words.steps.length === 0) {
      setError(COPY.invalid);
      return;
    }
    const request: ResearchPlanRequest = view && sameWords(words, view.proposal) ? { action: "start" } : { action: "save", plan: words };
    await plan.act(request).catch((failure: unknown) => {
      const status = failedStatus(failure);
      if (status !== 404) setError(status === 400 ? COPY.saveRefused : COPY.saveFailed);
    });
  });

  const cancel = () => run("cancel", async () => {
    // A failed cancel leaves the lease to run out, and the next read shows it held.
    await plan.act({ action: "cancel_hold" }).catch(() => undefined);
    setDraft(null);
    focusTarget.current = "[data-plan-edit]";
  });

  const resume = () => run("resume", async () => {
    await plan.act({ action: "cancel_hold" }).catch(() => setError(COPY.resumeFailed));
  });

  function beginEdit() {
    if (!view) return;
    const rows = (texts: readonly string[]) => texts.map((text) => ({ id: nextRowId.current++, text }));
    setDraft({ assumptions: rows(view.proposal.assumptions), steps: rows(view.proposal.steps), understood: view.proposal.understood });
    setError(null);
    focusTarget.current = "[data-plan-understood]";
  }

  function addRow(list: DraftList) {
    const id = nextRowId.current++;
    setDraft((current) => current && withRows(current, list, [...current[list], { id, text: "" }]));
    focusTarget.current = `[data-plan-row="${id}"]`;
  }

  function changeRow(list: DraftList, id: number, text: string) {
    setDraft((current) => current && withRows(current, list, current[list].map((row) => row.id === id ? { ...row, text } : row)));
  }

  /** Focus goes to the next row's delete, else the one before, else Add, so a keyboard stays where it was and a phone raises no keyboard. */
  function deleteRow(list: DraftList, id: number) {
    if (!draft) return;
    const rows = draft[list];
    const index = rows.findIndex((row) => row.id === id);
    const neighbour = rows[index + 1] ?? rows[index - 1];
    const min = list === "steps" ? 1 : 0;
    focusTarget.current = neighbour && rows.length - 1 > min ? `[data-plan-delete="${neighbour.id}"]` : `[data-plan-add="${list}"]`;
    setDraft(withRows(draft, list, rows.filter((row) => row.id !== id)));
  }

  const saving = busy === "save";
  const held = view?.heldUntil != null;
  const time = researchPlanTime(remaining);
  const words: ResearchPlanEdit = answer?.plan ?? view?.proposal ??
    { assumptions: [], steps: (row?.items ?? []).map((item) => item.text), understood: "" };
  const clock = phase === "window" ? researchPlanStartsIn(time)
    : phase === "held" ? researchPlanHeldElsewhereLeft(time)
    : phase === "editing" && view ? held ? plan.leaseSpent ? researchPlanHeldLeft(time) : COPY.held : remaining > 0 ? researchPlanStartsIn(time) : null
    : null;
  const statusText = phase === "answered" ? live ? COPY.answerLive : COPY.answerSettled
    : phase === "gone" ? COPY.gone
    : phase === "closing" ? COPY.closing
    : phase === "loading" ? COPY.loading
    : phase === "failed" ? COPY.loadFailed : null;

  return (
    <section aria-label={COPY.title} className="v2-research-plan" data-held={held || undefined} data-saving={saving || undefined} data-state={phase}
      data-testid="research-plan-card" ref={rootRef}>
      <div className="v2-research-plan-heading">
        <strong>{COPY.title}</strong>
        {clock ? <span aria-hidden="true" className="v2-research-plan-clock" data-testid="research-plan-clock">{clock}</span> : null}
      </div>
      <p className="v2-sr-only" role="status">{announcementOf(phase, held, remaining, live)}</p>
      {phase === "editing" && draft ? (
        <>
          <section className="v2-research-plan-part">
            <h3><label htmlFor={`research-plan-understood-${runId}`}>{COPY.understood}</label></h3>
            <textarea className="v2-research-plan-field v2-focusable" data-plan-understood disabled={saving}
              id={`research-plan-understood-${runId}`} maxLength={RESEARCH_PLAN_LIMITS.understoodCharacters}
              onChange={(event) => { const understood = event.target.value; setDraft((current) => current && { ...current, understood }); }}
              rows={3} value={draft.understood} />
          </section>
          <PlanRowsV2 addLabel={COPY.addAssumption} disabled={saving} heading={COPY.assumptions} labelOf={researchPlanAssumptionLabel} list="assumptions"
            max={RESEARCH_PLAN_LIMITS.assumptions} maxLength={RESEARCH_PLAN_LIMITS.assumptionCharacters} min={0} onAdd={() => addRow("assumptions")}
            onChange={(id, text) => changeRow("assumptions", id, text)} onDelete={(id) => deleteRow("assumptions", id)} rows={draft.assumptions} />
          <PlanRowsV2 addLabel={COPY.addStep} disabled={saving} heading={COPY.steps} labelOf={researchPlanStepLabel} list="steps"
            max={RESEARCH_PLAN_LIMITS.userStepsMax} maxLength={RESEARCH_PLAN_LIMITS.stepCharacters} min={1} onAdd={() => addRow("steps")}
            onChange={(id, text) => changeRow("steps", id, text)} onDelete={(id) => deleteRow("steps", id)} rows={draft.steps} />
        </>
      ) : <PlanWordsV2 words={words} />}
      {statusText ? <p className="v2-research-plan-status" ref={statusRef} tabIndex={-1}>{statusText}</p> : null}
      {phase === "editing" && plan.holdFailed ? <p className="v2-research-plan-status" role="status">{COPY.holdFailed}</p> : null}
      {plan.readFailed && phase !== "failed" && phase !== "answered" ? <p className="v2-research-plan-status" role="status">{COPY.refreshFailed}</p> : null}
      {error ? <p className="v2-research-plan-error" role="alert">{error}</p> : null}
      {phase === "failed" ? (
        <div className="v2-research-plan-actions">
          <UiV2Button onClick={plan.read} type="button">{COPY.retry}</UiV2Button>
        </div>
      ) : null}
      {phase === "editing" && draft ? (
        <div className="v2-research-plan-actions">
          <UiV2Button busy={busy === "cancel"} disabled={busy !== null} onClick={() => void cancel()} type="button">{COPY.cancel}</UiV2Button>
          <UiV2Button busy={saving} disabled={busy !== null} lang={COPY.startLanguage} onClick={() => void save(draft)} tone="primary" type="button">{COPY.start}</UiV2Button>
        </div>
      ) : null}
      {phase === "window" || phase === "held" ? (
        <div className="v2-research-plan-actions">
          <UiV2Button data-plan-edit disabled={busy !== null} icon="edit" onClick={beginEdit} type="button">{COPY.edit}</UiV2Button>
          {phase === "held" ? <UiV2Button busy={busy === "resume"} disabled={busy !== null} onClick={() => void resume()} type="button">{COPY.resume}</UiV2Button> : null}
          <UiV2Button busy={busy === "start"} disabled={busy !== null} lang={COPY.startLanguage} onClick={() => void start()} tone="primary" type="button">{COPY.start}</UiV2Button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The research plan's row while it is not yet a plan: scoping's line while the run works, or a window. On an answer that ended in scoping
 * nothing is being made any more, so that row stays the ordinary plan it always was.
 */
export function researchPlanCardRowV2(activity: ThreadWorkspaceActivity | null, live: boolean): ThreadWorkspaceActivityEntry | null {
  const plan = workspacePlanV2(activity);
  return plan?.researchPlan && (plan.researchPlan.state === "window" || live) ? plan : null;
}

/**
 * The plan of a research before it stands: the line that one is being made, then the plan a person may change for a moment (the window,
 * `agent_docs/RUN_CONTRACTS.md`, Research). Everything of a window comes from its route, so a reload, a background tab and a second tab
 * show what the server holds. Once the plan stands the row loses `researchPlan` and this gives way to the ordinary plan.
 */
export function ResearchPlanCardV2({ activity, live }: Readonly<{ activity: ThreadWorkspaceActivity | null; live: boolean }>) {
  const chatId = useWorkspaceStore((state) => state.activeChatId);
  const row = researchPlanCardRowV2(activity, live);
  const runId = row?.researchPlan?.runId ?? null;
  // Kept past the row: a person's edit outlives the window it was written in.
  const [seenRunId, setSeenRunId] = useState(runId);
  if (runId !== null && runId !== seenRunId) setSeenRunId(runId);
  const shown = runId ?? seenRunId;
  if (!chatId || !shown) return null;
  return <ResearchPlanRunV2 chatId={chatId} key={`${chatId}:${shown}`} live={live} row={row} runId={shown} />;
}
