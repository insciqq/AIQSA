"use client";

import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import { shellLinkClick } from "@/features/answer-outputs-v2/shellLinkClick";
import {
  subagentCallbackLabel,
  subagentStatePresentation,
  subagentWorkingPhrase
} from "@/features/subagents-v2/subagentPresentation";
import {
  stopAllSubagents,
  subagentStopAllKey,
  useSubagentStore,
  type SubagentThreadTarget
} from "@/features/subagents-v2/subagentStore";
import { subagentThreadHref } from "@/features/subagents-v2/subagentThreadAddress";
import type { ThreadToolActivity } from "@/lib/contracts/chats";
import { CALL_SUBAGENT_TOOL_NAME, type SubagentActivityRef } from "@/lib/contracts/subagents";

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

/**
 * A compact card per sub-agent an answer started or continued: its name,
 * its live state from the chat's projection (none until that is known) and
 * the way to its read-only thread.
 */
export function SubagentCardsV2({
  chatId,
  onOpen,
  toolActivity
}: Readonly<{
  chatId: string | null;
  onOpen(target: SubagentThreadTarget): void;
  toolActivity: ThreadToolActivity | null | undefined;
}>) {
  const chat = useSubagentStore((state) => chatId ? state.chats[chatId] : undefined);
  const refs = subagentRefsOf(toolActivity);
  if (!chatId || refs.length === 0) return null;
  return (
    <section aria-label="Sub-agents" className="v2-subagent-cards">
      <ul>
        {refs.map((ref) => {
          const thread = chat?.threads.find((candidate) => candidate.id === ref.threadId) ?? null;
          const state = thread ? subagentStatePresentation(thread.state, thread.outcome) : null;
          const target = { chatId, threadId: ref.threadId };
          return (
            <li className="v2-subagent-card" data-state={thread?.state} data-tone={state?.tone} key={ref.threadId}>
              <span aria-hidden="true" className="v2-subagent-state">
                {state?.icon ? <UiV2Icon name={state.icon} /> : state ? <span className="v2-subagent-dot" /> : <UiV2Icon name="bot" />}
              </span>
              <span className="v2-subagent-card-name" title={ref.name}>{ref.name}</span>
              {state ? <span className="v2-subagent-card-state">{state.label}</span> : null}
              <a
                aria-label={`Open ${ref.name}`}
                className="v2-subagent-card-open v2-focusable"
                href={subagentThreadHref(target)}
                onClick={shellLinkClick(() => onOpen(target))}
              >
                Open
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The chat's live sub-agent line above the composer while any of them is
 * active: the real phase ("2 sub-agents working · 1 waiting for you"), the
 * way to the one that waits for the user, and "Stop all".
 */
export function SubagentChatStatusV2({
  chatId,
  onOpen
}: Readonly<{
  chatId: string | null;
  onOpen(target: SubagentThreadTarget): void;
}>) {
  const chat = useSubagentStore((state) => chatId ? state.chats[chatId] : undefined);
  const stopping = useSubagentStore((state) => chatId ? Boolean(state.stopping[subagentStopAllKey(chatId)]) : false);
  const failed = useSubagentStore((state) => chatId ? Boolean(state.stopErrors[subagentStopAllKey(chatId)]) : false);
  if (!chatId || !chat || chat.running === 0) return null;
  const phrase = subagentWorkingPhrase(chat.threads);
  const waiting = chat.threads.filter((thread) => thread.state === "waiting");
  return (
    <div className="v2-subagent-status" data-testid="subagent-chat-status">
      <span className="v2-subagent-status-phrase" role="status">{phrase}</span>
      {waiting.length === 1 ? (
        <a
          className="v2-subagent-status-link v2-focusable"
          href={subagentThreadHref({ chatId, threadId: waiting[0]!.id })}
          title={waiting[0]!.name}
          onClick={shellLinkClick(() => onOpen({ chatId, threadId: waiting[0]!.id }))}
        >
          Open {waiting[0]!.name}
        </a>
      ) : null}
      {failed ? <span className="v2-subagent-status-error" role="alert">Could not stop them. Try again.</span> : null}
      <UiV2Button busy={stopping} icon="stop" onClick={() => void stopAllSubagents(chatId)}>Stop all</UiV2Button>
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
