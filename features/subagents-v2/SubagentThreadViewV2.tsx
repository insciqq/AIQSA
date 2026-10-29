"use client";

import { useEffect, useId } from "react";
import { UiV2Button, UiV2Icon, UiV2Skeleton } from "@/components/ui-v2";
import { AnswerProcessV2 } from "@/features/answer-outputs-v2/AnswerProcessV2";
import { shellLinkClick } from "@/features/answer-outputs-v2/shellLinkClick";
import { BrowserLivePanelV2 } from "@/features/browser-live/BrowserLivePanelV2";
import { ConversationTurnV2 } from "@/features/conversation-v2/ConversationV2";
import { describeToolCallV2, planCallHiddenV2, runWaitingPhraseV2, stepDurationSumV2 } from "@/features/run-lifecycle-v2/runPresentation";
import { workspaceActiveLabelV2 } from "@/features/run-lifecycle-v2/workspaceActivityPresentation";
import type { ThreadToolActivity } from "@/lib/contracts/chats";
import { isActiveSubagentState } from "@/lib/contracts/subagents";
import type { SubagentThreadSummary, SubagentTurnMessage, SubagentTurnView } from "@/lib/contracts/subagentViews";
import { formatChatRoutePath } from "@/lib/domain/chatRoute";
import { subagentReasonText, subagentStatePresentation } from "./subagentPresentation";
import {
  SUBAGENT_POLL_INTERVAL_MS,
  refreshSubagentThreadView,
  stopSubagent,
  subagentThreadKey,
  useSubagentStore,
  type SubagentThreadTarget
} from "./subagentStore";

const DELIVERY_LABELS: Readonly<Record<SubagentTurnMessage["delivery"], string>> = {
  accepted: "Sent",
  delivered: "Read by the sub-agent",
  undelivered: "Not delivered"
};

function newer(left: SubagentThreadSummary | null, right: SubagentThreadSummary | null): SubagentThreadSummary | null {
  if (!left || !right) return left ?? right;
  return Date.parse(right.updatedAt) > Date.parse(left.updatedAt) ? right : left;
}

function runningStepLabel(activity: ThreadToolActivity | null): string | null {
  const calls = activity?.calls ?? [];
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]!;
    if (call.status === "running" && !planCallHiddenV2(call)) return `${describeToolCallV2(call, "running")}…`;
  }
  return null;
}

/**
 * Loads the thread view and refreshes it while the sub-agent is active, or
 * when the chat's rows say it changed since. A branch switch is the store's
 * (`invalidateChatSubagents`): it clears and reloads the view itself.
 */
function useThreadViewLoader(target: SubagentThreadTarget, summaryStamp: string | null): void {
  const key = subagentThreadKey(target);
  useEffect(() => {
    void refreshSubagentThreadView(target);
    const timer = window.setInterval(() => {
      const entry = useSubagentStore.getState().view;
      if (entry?.key === key && entry.status === "ready" && entry.view && isActiveSubagentState(entry.view.thread.state)) {
        void refreshSubagentThreadView(target);
      }
    }, SUBAGENT_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [key, target]);
  useEffect(() => {
    const entry = useSubagentStore.getState().view;
    // Newer rows than the view (it ended, or the main agent continued it) are a reason to look again.
    if (entry?.key === key && entry.status === "ready" && entry.view && summaryStamp &&
      Date.parse(summaryStamp) > Date.parse(entry.view.thread.updatedAt)) void refreshSubagentThreadView(target);
  }, [key, summaryStamp, target]);
}

function TurnV2({ chatId, latest, turn }: Readonly<{ chatId: string; latest: boolean; turn: SubagentTurnView }>) {
  const active = isActiveSubagentState(turn.state);
  const state = subagentStatePresentation(turn.state, turn.outcome);
  const reason = subagentReasonText(turn.reason);
  const liveLabel = !active ? null : turn.state === "waiting" ? "Waiting for you"
    : workspaceActiveLabelV2(turn.workspaceActivity) ?? runningStepLabel(turn.toolActivity) ?? runWaitingPhraseV2(turn.id);
  return (
    <article className="v2-subagent-turn" data-state={turn.state} data-turn-id={turn.id}>
      <div className="v2-subagent-brief">
        <div className="v2-subagent-brief-label">Brief from the main agent</div>
        <p>{turn.brief}</p>
      </div>
      {turn.messages.map((message, index) => (
        <div className="v2-subagent-brief" data-message="" key={`${message.createdAt}:${index}`}>
          <div className="v2-subagent-brief-label">
            Message from the main agent · {DELIVERY_LABELS[message.delivery]}
          </div>
          <p>{message.text}</p>
        </div>
      ))}
      <ConversationTurnV2
        ariaLabel="Sub-agent reply"
        beforeContent={(
          <>
            <AnswerProcessV2
              disclosureId={`subagent-turn-${turn.id}`}
              liveLabel={liveLabel}
              toolActivity={turn.toolActivity}
              workDurationMs={stepDurationSumV2(turn.toolActivity)}
              workspaceActivity={turn.workspaceActivity}
            />
            {latest && active ? (
              <BrowserLivePanelV2 chatId={chatId} live toolActivity={turn.toolActivity} workspaceActivity={turn.workspaceActivity} />
            ) : null}
          </>
        )}
        afterContent={(
          <>
            {turn.files.length > 0 ? (
              <ul aria-label="Files it wrote" className="v2-subagent-files">
                {turn.files.map((path) => (
                  <li key={path}><UiV2Icon name="file" /><span>{path}</span></li>
                ))}
              </ul>
            ) : null}
            {!active ? (
              <p className="v2-subagent-turn-end" data-tone={state.tone}>
                <span aria-hidden="true" className="v2-subagent-state">
                  {state.icon ? <UiV2Icon name={state.icon} /> : <span className="v2-subagent-dot" />}
                </span>
                {/* A stop or interruption reason already says what happened ("Stopped by you"). */}
                <span>{!reason ? state.label : turn.state === "stopped" || turn.state === "interrupted" ? reason : `${state.label}: ${reason}`}</span>
              </p>
            ) : null}
            <p className="v2-subagent-turn-model">
              {turn.model.displayName}{turn.model.effort ? ` · ${turn.model.effort}` : ""}
              {turn.mode === "background" ? " · in the background" : ""}
            </p>
          </>
        )}
        className="v2-subagent-reply"
        content={turn.report ?? ""}
        hideEmptyContent={!turn.report?.trim()}
        quoteEligible={false}
        role="assistant"
        streaming={false}
      />
    </article>
  );
}

/**
 * A sub-agent's thread, read-only (operator decision 2026-10-29): the main
 * agent's briefs and messages, its steps as an answer's process disclosure
 * shows them, its replies and state, Stop while it is active, and the way
 * back to the chat. It has no composer; writing to a sub-agent comes later.
 */
export function SubagentThreadViewV2({
  onBack,
  target
}: Readonly<{
  onBack(): void;
  target: SubagentThreadTarget;
}>) {
  const key = subagentThreadKey(target);
  const headingId = useId();
  const entry = useSubagentStore((state) => state.view?.key === key ? state.view : null);
  const listed = useSubagentStore((state) =>
    state.chats[target.chatId]?.threads.find((thread) => thread.id === target.threadId) ?? null);
  const stopping = useSubagentStore((state) => Boolean(state.stopping[key]));
  const stopFailed = useSubagentStore((state) => Boolean(state.stopErrors[key]));
  useThreadViewLoader(target, listed?.updatedAt ?? null);

  const view = entry?.view ?? null;
  const unavailable = entry?.status === "unavailable";
  const thread = unavailable ? null : newer(view?.thread ?? null, listed);
  const state = thread ? subagentStatePresentation(thread.state, thread.outcome) : null;
  const active = thread ? isActiveSubagentState(thread.state) : false;
  const chatHref = formatChatRoutePath({ chatId: target.chatId });

  return (
    <section aria-labelledby={headingId} className="v2-subagent-thread" data-testid="subagent-thread-view">
      <header className="v2-subagent-thread-head">
        <a className="v2-subagent-thread-back v2-focusable" href={chatHref} onClick={shellLinkClick(onBack)}>
          <UiV2Icon name="arrow-left" />
          <span>Back to chat</span>
        </a>
        <div className="v2-subagent-thread-title">
          <h2 id={headingId} title={thread?.name}>{thread?.name ?? "Sub-agent"}</h2>
          {state ? (
            <span className="v2-subagent-thread-state" data-tone={state.tone}>
              <span aria-hidden="true" className="v2-subagent-state">
                {state.icon ? <UiV2Icon name={state.icon} /> : <span className="v2-subagent-dot" />}
              </span>
              <span>{state.label}</span>
            </span>
          ) : null}
          {thread?.type ? <span className="v2-subagent-thread-type">{thread.type}</span> : null}
        </div>
        {active ? (
          <UiV2Button busy={stopping} icon="stop" onClick={() => void stopSubagent(target)}>Stop</UiV2Button>
        ) : null}
        {stopFailed && active ? (
          <p className="v2-subagent-thread-error" role="alert">Could not stop this sub-agent. Try again.</p>
        ) : null}
      </header>
      <div className="v2-subagent-thread-body">
        {unavailable ? (
          <div className="v2-subagent-thread-status" role="status">
            <p>This sub-agent is not available here. It may belong to another branch of this chat, or the chat is gone.</p>
            <UiV2Button icon="arrow-left" onClick={onBack}>Back to chat</UiV2Button>
          </div>
        ) : !view && entry?.status === "error" ? (
          <div className="v2-subagent-thread-status" role="alert">
            <p>Could not load this sub-agent.</p>
            <UiV2Button icon="regenerate" onClick={() => void refreshSubagentThreadView(target)}>Retry</UiV2Button>
          </div>
        ) : !view ? (
          <div aria-label="Loading sub-agent" className="v2-subagent-thread-loading" role="status">
            {[0, 1, 2].map((index) => <UiV2Skeleton className="block" key={index} />)}
          </div>
        ) : (
          <>
            {entry?.status === "error" ? (
              <div className="v2-subagent-thread-status" data-inline="" role="alert">
                <p>Could not refresh this sub-agent.</p>
                <UiV2Button icon="regenerate" onClick={() => void refreshSubagentThreadView(target)}>Retry</UiV2Button>
              </div>
            ) : null}
            {view.truncated ? <p className="v2-subagent-thread-note">Earlier turns are not shown.</p> : null}
            {view.turns.map((turn, index) => (
              <TurnV2 chatId={target.chatId} key={turn.id} latest={index === view.turns.length - 1} turn={turn} />
            ))}
          </>
        )}
      </div>
    </section>
  );
}
