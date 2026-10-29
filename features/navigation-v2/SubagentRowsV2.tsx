"use client";

import { UiV2Icon } from "@/components/ui-v2";
import { isActiveSubagentState } from "@/lib/contracts/subagents";
import type { SubagentChatThreads, SubagentThreadSummary } from "@/lib/contracts/subagentViews";
import { orderedSubagentThreads, subagentStatePresentation } from "@/features/subagents-v2/subagentPresentation";
import type { SubagentThreadTarget } from "@/features/subagents-v2/subagentStore";
import type { KeyboardEvent } from "react";

/**
 * A chat's sub-agents as the chat list shows them (operator decision
 * 2026-10-29): rows nested under the chat, never chats of their own, so they
 * have no row menu and never appear in search results. The list owner passes
 * the server's projections and the disclosure; rows only render them.
 */
export type NavigationSubagentsV2 = Readonly<{
  chats: Readonly<Record<string, SubagentChatThreads>>;
  /** Chats whose latest refresh failed; their last known rows stay. */
  errors: Readonly<Record<string, true>>;
  expanded(chatId: string): boolean;
  onRetry(chatId: string): void;
  onShowAll(chatId: string): void;
  onToggle(chatId: string): void;
  openThread: SubagentThreadTarget | null;
  showAllEnded: Readonly<Record<string, true>>;
}>;

/** Ended sub-agents listed under a chat before "Show all"; active ones are always listed. */
export const SUBAGENT_ROWS_ENDED_VISIBLE = 5;

export function subagentGroupId(chatId: string, scope: string): string {
  return `v2-subagents-${scope}-${chatId.replace(/[^A-Za-z0-9_-]/gu, "")}`;
}

/**
 * Arrow keys on a chat row with sub-agents open and close its rows, as on a
 * folder; the tree moves focus for every other key.
 */
export function subagentDisclosureKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  expanded: boolean,
  toggle: () => void
): void {
  if ((event.key === "ArrowRight" && !expanded) || (event.key === "ArrowLeft" && expanded)) {
    event.preventDefault();
    event.stopPropagation();
    toggle();
  }
}

export function SubagentDisclosureV2({
  chat,
  controls,
  expanded,
  onToggle,
  title
}: Readonly<{
  chat: SubagentChatThreads;
  controls: string;
  expanded: boolean;
  onToggle(): void;
  title: string;
}>) {
  const count = chat.threads.length;
  const summary = chat.running > 0
    ? `${count} sub-agent${count === 1 ? "" : "s"}, ${chat.running} active`
    : `${count} sub-agent${count === 1 ? "" : "s"}`;
  return (
    <button
      aria-controls={expanded ? controls : undefined}
      aria-expanded={expanded}
      aria-label={`${expanded ? "Hide" : "Show"} sub-agents of ${title}: ${summary}`}
      className="v2-subagent-disclosure v2-focusable"
      data-running={chat.running > 0 || undefined}
      tabIndex={-1}
      title={summary}
      type="button"
      onClick={onToggle}
    >
      <span aria-hidden="true">{chat.truncated ? `${count}+` : count}</span>
      <UiV2Icon name={expanded ? "chevron-down" : "chevron-right"} />
    </button>
  );
}

function SubagentRowV2({
  disabled,
  level,
  onOpen,
  selected,
  thread
}: Readonly<{
  disabled?: boolean;
  level: number;
  onOpen(thread: SubagentThreadSummary): void;
  selected: boolean;
  thread: SubagentThreadSummary;
}>) {
  const state = subagentStatePresentation(thread.state, thread.outcome);
  return (
    <div className="v2-subagent-row-wrap" data-navigation-subagent-id={thread.id} data-v2-tree-row="true">
      <button
        aria-current={selected ? "page" : undefined}
        aria-level={level}
        aria-selected={selected}
        className="v2-subagent-row v2-focusable"
        data-selected={selected || undefined}
        data-state={thread.state}
        data-tone={state.tone}
        data-v2-tree-item="true"
        disabled={disabled}
        role="treeitem"
        tabIndex={-1}
        title={thread.type ? `${thread.name} (${thread.type})` : thread.name}
        type="button"
        onClick={() => onOpen(thread)}
      >
        <span aria-hidden="true" className="v2-subagent-state">
          {state.icon ? <UiV2Icon name={state.icon} /> : <span className="v2-subagent-dot" />}
        </span>
        <span className="v2-chat-title">{thread.name}</span>
        <span className="sr-only">, {state.label}</span>
      </button>
    </div>
  );
}

export function SubagentRowsV2({
  chat,
  disabled,
  error,
  id,
  level,
  onOpen,
  onRetry,
  onShowAll,
  openThreadId,
  showAllEnded,
  title
}: Readonly<{
  chat: SubagentChatThreads;
  disabled?: boolean;
  error: boolean;
  id: string;
  level: number;
  onOpen(thread: SubagentThreadSummary): void;
  onRetry(): void;
  onShowAll(): void;
  openThreadId: string | null;
  showAllEnded: boolean;
  title: string;
}>) {
  const ordered = orderedSubagentThreads(chat);
  const activeCount = ordered.filter((thread) => isActiveSubagentState(thread.state)).length;
  const limit = showAllEnded ? ordered.length : activeCount + SUBAGENT_ROWS_ENDED_VISIBLE;
  // The open thread stays listed even when it is an older ended one.
  const visible = ordered.filter((thread, index) => index < limit || thread.id === openThreadId);
  const hidden = ordered.length - visible.length;
  return (
    <div aria-label={`Sub-agents of ${title}`} className="v2-subagent-rows" id={id} role="group">
      {visible.map((thread) => (
        <SubagentRowV2
          disabled={disabled}
          key={thread.id}
          level={level}
          onOpen={onOpen}
          selected={thread.id === openThreadId}
          thread={thread}
        />
      ))}
      {hidden > 0 ? (
        <div className="v2-subagent-row-wrap" data-v2-tree-row="true">
          <button
            aria-level={level}
            aria-selected={false}
            className="v2-subagent-more v2-focusable"
            data-v2-tree-item="true"
            role="treeitem"
            tabIndex={-1}
            type="button"
            onClick={onShowAll}
          >
            Show {hidden} more
          </button>
        </div>
      ) : null}
      {chat.truncated ? <div className="v2-subagent-note">Older sub-agents are not listed.</div> : null}
      {error ? (
        <div className="v2-subagent-note" role="status">
          <span>Could not update sub-agents.</span>
          <button className="v2-navigation-retry v2-focusable" type="button" onClick={onRetry}>Retry</button>
        </div>
      ) : null}
    </div>
  );
}
