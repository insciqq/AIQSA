"use client";

import { useEffect, useRef, useState } from "react";
import { UiV2Icon, UiV2MenuItem, UiV2MenuSeparator } from "@/components/ui-v2";
import { UiV2ResponsiveMenu } from "@/components/ui-v2/ResponsiveMenuV2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { shellLinkClick } from "@/features/answer-outputs-v2/shellLinkClick";
import {
  subagentCallbackLabel,
  subagentCountsPhrase,
  subagentDetailText,
  subagentModelText,
  subagentStatePresentation,
  subagentWorkingPhrase,
  type SubagentStatePresentation
} from "@/features/subagents-v2/subagentPresentation";
import {
  stopAllSubagents,
  stopSubagent,
  subagentStopAllKey,
  subagentThreadKey,
  useSubagentStore,
  type SubagentThreadTarget
} from "@/features/subagents-v2/subagentStore";
import { subagentThreadHref } from "@/features/subagents-v2/subagentThreadAddress";
import type { ThreadToolActivity } from "@/lib/contracts/chats";
import { CALL_SUBAGENT_TOOL_NAME, isActiveSubagentState, type SubagentActivityRef } from "@/lib/contracts/subagents";
import type { SubagentThreadSummary } from "@/lib/contracts/subagentViews";

/** More rows than this in one answer collapse into a summary row that unfolds. */
const SUBAGENT_ROWS_SHOWN = 3;

/**
 * The sub-agents an answer started or continued, once each in the order the
 * answer first addressed them (a later call on the same thread wins).
 */
export function subagentRefsOf(toolActivity: ThreadToolActivity | null | undefined): SubagentActivityRef[] {
  const byThread = new Map<string, SubagentActivityRef>();
  for (const call of toolActivity?.calls ?? []) {
    if (call.toolName !== CALL_SUBAGENT_TOOL_NAME || !call.subagent) continue;
    byThread.set(call.subagent.threadId, call.subagent);
  }
  return [...byThread.values()];
}

function SubagentStateMark({ state }: Readonly<{ state: SubagentStatePresentation | null }>) {
  return (
    <span aria-hidden="true" className="v2-subagent-state">
      {state?.icon ? <UiV2Icon name={state.icon} /> : state ? <span className="v2-subagent-dot" /> : <UiV2Icon name="bot" />}
    </span>
  );
}

/** One sub-agent's place in an answer: the whole row is the way to its thread. */
function SubagentAnswerRow({ chatId, name, onOpen, thread, threadId }: Readonly<{
  chatId: string;
  name: string;
  onOpen(target: SubagentThreadTarget): void;
  thread: SubagentThreadSummary | null;
  threadId: string;
}>) {
  const state = thread ? subagentStatePresentation(thread.state, thread.outcome) : null;
  const detail = thread ? subagentDetailText(thread) : null;
  const model = thread ? subagentModelText(thread.model) : null;
  const target = { chatId, threadId };
  return (
    <li>
      <a
        aria-label={[`Open ${name}`, detail, model].filter(Boolean).join(", ")}
        className="v2-subagent-answer-row v2-focusable"
        data-state={thread?.state}
        data-tone={state?.tone}
        href={subagentThreadHref(target)}
        onClick={shellLinkClick(() => onOpen(target))}
      >
        <SubagentStateMark state={state} />
        <span className="v2-subagent-line">
          <span className="v2-subagent-line-name" title={name}>{name}</span>
          {detail ? <span className="v2-subagent-line-detail" title={detail}>{detail}</span> : null}
          {model ? <span className="v2-subagent-line-model" title={model}>{model}</span> : null}
        </span>
        <UiV2Icon className="v2-subagent-chevron" name="chevron-right" />
      </a>
    </li>
  );
}

/**
 * A sub-agent an answer started or continued, in that answer: one borderless
 * row while the answer waits for it and once it has ended. An active one with
 * a place elsewhere has none here, because each state has one place: a
 * background one lives in the chip above the composer, and a foreground one
 * in the answer still running it, not in an earlier answer of its thread.
 */
export function SubagentAnswerRowsV2({
  chatId,
  live,
  messageId,
  onOpen,
  toolActivity
}: Readonly<{
  chatId: string | null;
  /** This answer is still running. */
  live: boolean;
  /** This answer's message, the server's id once the run has started. */
  messageId: string;
  onOpen(target: SubagentThreadTarget): void;
  toolActivity: ThreadToolActivity | null | undefined;
}>) {
  const chat = useSubagentStore((state) => chatId ? state.chats[chatId] : undefined);
  const failed = useSubagentStore((state) => chatId ? Boolean(state.chatErrors[chatId]) : false);
  const [unfolded, setUnfolded] = useState(false);
  if (!chatId) return null;
  // A live step names no sub-agent, so a running answer's own come from the server: the threads whose latest turn it started.
  const refs = subagentRefsOf(toolActivity);
  const addressed = [...refs, ...(chat?.threads ?? [])
    .filter((thread) => thread.latestAnswerMessageId === messageId && !refs.some((ref) => ref.threadId === thread.id))
    .map((thread) => ({ name: thread.name, threadId: thread.id }))];
  const rows = addressed.flatMap((ref) => {
    const thread = chat?.threads.find((candidate) => candidate.id === ref.threadId) ?? null;
    if (thread && isActiveSubagentState(thread.state) && (thread.mode === "background" || !live)) return [];
    return [{ ref, thread }];
  });
  if (rows.length === 0) return null;
  const known = rows.flatMap(({ thread }) => thread ? [thread] : []);
  const collapsible = rows.length > SUBAGENT_ROWS_SHOWN;
  const stale = failed && rows.some(({ thread }) => !thread || isActiveSubagentState(thread.state));
  return (
    <section aria-label="Sub-agents" className="v2-subagent-answer-rows">
      {collapsible ? (
        <button
          aria-expanded={unfolded}
          className="v2-subagent-answer-row v2-focusable"
          data-tone={known.some((thread) => thread.state === "waiting") ? "warn" : undefined}
          type="button"
          onClick={() => setUnfolded((open) => !open)}
        >
          <SubagentStateMark state={null} />
          <span className="v2-subagent-line">
            <span className="v2-subagent-line-name">{subagentCountsPhrase(rows.length, known)}</span>
          </span>
          <UiV2Icon className="v2-subagent-chevron" name={unfolded ? "chevron-down" : "chevron-right"} />
        </button>
      ) : null}
      {!collapsible || unfolded ? (
        <ul>
          {rows.map(({ ref, thread }) => (
            <SubagentAnswerRow chatId={chatId} key={ref.threadId} name={ref.name} thread={thread} threadId={ref.threadId} onOpen={onOpen} />
          ))}
        </ul>
      ) : null}
      {stale ? <p className="v2-subagent-refresh-error" role="status">Could not refresh sub-agents.</p> : null}
    </section>
  );
}

/** One row of the list: its thread, and a stop of its own whose failure stays visible. */
function SubagentListRow({ chatId, onOpen, thread }: Readonly<{
  chatId: string;
  onOpen(target: SubagentThreadTarget): void;
  thread: SubagentThreadSummary;
}>) {
  const target = { chatId, threadId: thread.id };
  const key = subagentThreadKey(target);
  const stopping = useSubagentStore((state) => Boolean(state.stopping[key]));
  const failed = useSubagentStore((state) => Boolean(state.stopErrors[key]));
  const state = subagentStatePresentation(thread.state, thread.outcome);
  const detail = subagentDetailText(thread);
  const model = subagentModelText(thread.model);
  return (
    <div className="v2-subagent-list-row" data-state={thread.state} data-tone={state.tone} role="none">
      <SubagentStateMark state={state} />
      <a
        aria-label={[`Open ${thread.name}`, detail, model].filter(Boolean).join(", ")}
        className="v2-subagent-list-open v2-focusable"
        href={subagentThreadHref(target)}
        role="menuitem"
        onClick={shellLinkClick(() => onOpen(target))}
      >
        <span className="v2-subagent-list-title">
          <span className="v2-subagent-line-name" title={thread.name}>{thread.name}</span>
          {model ? <span className="v2-subagent-line-model" title={model}>{model}</span> : null}
        </span>
        <span className="v2-subagent-line-detail" title={detail}>{detail}</span>
      </a>
      <button
        aria-busy={stopping || undefined}
        aria-label={`Stop ${thread.name}`}
        className="v2-subagent-list-stop v2-focusable"
        role="menuitem"
        type="button"
        onClick={() => void stopSubagent(target)}
      >
        <UiV2Icon name="stop" />
      </button>
      {failed ? <p className="v2-subagent-stop-error" role="alert">Could not stop {thread.name}. Try again.</p> : null}
    </div>
  );
}

/**
 * The chat's background sub-agents above the composer, only while one is
 * active, so they stay reachable however far the answer that started them has
 * scrolled away: one links straight to its thread and shows its step; several
 * open a list (a bottom sheet on a phone) with a stop each and "Stop all".
 * The composer's Stop spares them, and foreground sub-agents never show here.
 */
export function SubagentBackgroundChipV2({
  chatId,
  onOpen
}: Readonly<{
  chatId: string | null;
  onOpen(target: SubagentThreadTarget): void;
}>) {
  const chat = useSubagentStore((state) => chatId ? state.chats[chatId] : undefined);
  const refreshFailed = useSubagentStore((state) => chatId ? Boolean(state.chatErrors[chatId]) : false);
  const stoppingAll = useSubagentStore((state) => chatId ? Boolean(state.stopping[subagentStopAllKey(chatId)]) : false);
  const stopAllFailed = useSubagentStore((state) => chatId ? Boolean(state.stopErrors[subagentStopAllKey(chatId)]) : false);
  const [open, setOpen] = useState(false);
  const { menuRef, triggerRef } = useMenuDismissalV2({ onClose: () => setOpen(false), open });
  const active = chat?.threads.filter((thread) => thread.mode === "background" && isActiveSubagentState(thread.state)) ?? [];
  const activeKey = active.map((thread) => thread.id).join(",");
  // Nothing left to list: the list does not come back by itself with the next sub-agent.
  if (open && active.length === 0) setOpen(false);

  // A stopped row leaves the list: focus stays inside it instead of falling to the page.
  useEffect(() => {
    if (!open || menuRef.current?.contains(document.activeElement)) return;
    menuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
  }, [activeKey, menuRef, open]);

  // Closing a list stops left one row in swaps its trigger for the link: focus goes with it.
  const linkRef = useRef<HTMLAnchorElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open && document.activeElement === document.body) linkRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  if (!chatId || active.length === 0) return null;
  const error = refreshFailed ? <p className="v2-subagent-refresh-error" role="status">Could not refresh sub-agents.</p> : null;
  // The open list keeps its trigger when stops leave one row in it.
  if (active.length === 1 && !open) {
    const thread = active[0]!;
    const target = { chatId, threadId: thread.id };
    const state = subagentStatePresentation(thread.state, thread.outcome);
    const detail = subagentDetailText(thread);
    const model = subagentModelText(thread.model);
    return (
      <div className="v2-subagent-chip-row" data-testid="subagent-chat-chip">
        <a
          aria-label={[`Open ${thread.name}`, detail, model].filter(Boolean).join(", ")}
          className="v2-subagent-chip v2-focusable"
          data-state={thread.state}
          data-tone={state.tone}
          href={subagentThreadHref(target)}
          ref={linkRef}
          onClick={shellLinkClick(() => onOpen(target))}
        >
          <SubagentStateMark state={state} />
          <span className="v2-subagent-line">
            <span className="v2-subagent-line-name" title={thread.name}>{thread.name}</span>
            <span className="v2-subagent-line-detail" title={detail}>{detail}</span>
            {model ? <span className="v2-subagent-line-model" title={model}>{model}</span> : null}
          </span>
          <UiV2Icon className="v2-subagent-chevron" name="chevron-right" />
        </a>
        {error}
      </div>
    );
  }
  const phrase = subagentWorkingPhrase(active) ?? "";
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  return (
    <div className="v2-subagent-chip-row" data-testid="subagent-chat-chip">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className="v2-subagent-chip v2-focusable"
        data-tone={active.some((thread) => thread.state === "waiting") ? "warn" : undefined}
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        <SubagentStateMark state={null} />
        <span className="v2-subagent-line">
          <span className="v2-subagent-line-name">{phrase}</span>
        </span>
        <UiV2Icon className="v2-subagent-chevron" name="chevron-down" />
      </button>
      {error}
      {open ? (
        <UiV2ResponsiveMenu
          align="start"
          anchorRef={triggerRef}
          className="v2-subagent-list"
          label="Background sub-agents"
          menuRef={menuRef}
          onClose={close}
        >
          {active.map((thread) => (
            <SubagentListRow
              chatId={chatId}
              key={thread.id}
              thread={thread}
              onOpen={(target) => {
                setOpen(false);
                onOpen(target);
              }}
            />
          ))}
          <UiV2MenuSeparator />
          <UiV2MenuItem aria-busy={stoppingAll || undefined} icon="stop" onClick={() => void stopAllSubagents(chatId)}>Stop all</UiV2MenuItem>
          {stopAllFailed ? <p className="v2-subagent-stop-error" role="alert">Could not stop them. Try again.</p> : null}
        </UiV2ResponsiveMenu>
      ) : null}
    </div>
  );
}

/**
 * The server-written turn that wakes the main agent with sub-agent results
 * (`subagent_callback`): one quiet line naming them, never a user bubble.
 */
export function SubagentCallbackTurnV2({ anchorId, names }: Readonly<{ anchorId: string; names: readonly string[] }>) {
  const label = subagentCallbackLabel(names);
  return (
    <article aria-label="Sub-agent results" className="v2-conversation-turn v2-system-turn v2-subagent-callback-turn"
      data-conversation-message-id={anchorId} data-message-id={anchorId} data-role="user" data-system-turn="subagent_callback">
      <span className="v2-system-turn-chip" title={label}>
        <UiV2Icon name="bot" />
        <span className="v2-subagent-callback-label">{label}</span>
      </span>
    </article>
  );
}
