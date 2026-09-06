"use client";

import { useId, useState } from "react";
import { formatMemoryUiCopy, memoryUiCopy, MEMORY_UI_LOCALE } from "@/components/app-shell/memoryUiCopy";
import { UiV2Icon } from "@/components/ui-v2";
import type { MemoryAnswerSource } from "@/lib/contracts/memoryClient";
import { MemorySourceRowV2 } from "./AnswerOutputsV2";
import type { PastChatGroupV2 } from "./memorySourcePresentation";

function PastChatV2({ group, hidden }: Readonly<{ group: PastChatGroupV2; hidden: boolean }>) {
  const [changed, setChanged] = useState(false);
  const source = group.sources.find((entry) => entry.sourceAvailable) ?? group.sources[0]!;
  const title = source.sourceAvailable
    ? source.origin ?? memoryUiCopy("source.pastChat")
    : memoryUiCopy("source.unavailableLabel");
  return (
    <article className="v2-past-chat" data-testid="past-chat-source" hidden={hidden}>
      <div className="v2-past-chat-heading">
        <UiV2Icon name="chat" />
        {source.sourceAvailable && !changed ? (
          <a className="v2-focusable" href={
            `/api/me/memory/source-actions/open?memoryRef=${encodeURIComponent(source.memoryRef)}`
          } target="_blank" rel="noreferrer">{title}</a>
        ) : <span>{title}</span>}
        <time dateTime={source.date}>{new Date(source.date).toLocaleDateString(
          MEMORY_UI_LOCALE, { day: "numeric", month: "short", year: "numeric" }
        )}</time>
      </div>
      {!changed ? <p className="v2-past-chat-preview">{source.sourceAvailable
        ? source.text : memoryUiCopy("source.unavailableBody")}</p> : null}
      <details className="v2-past-chat-excerpts">
        <summary className="v2-focusable">{formatMemoryUiCopy("source.excerpts", {
          count: group.sources.length
        })}</summary>
        <div className="v2-memory-source-list">{group.sources.map((entry, index) => (
          <MemorySourceRowV2 key={entry.memoryRef ?? index} source={entry} onSettled={() => setChanged(true)} />
        ))}</div>
      </details>
    </article>
  );
}

export function MemorySourcesV2({ memories, pastChats }: Readonly<{
  memories: readonly MemoryAnswerSource[];
  pastChats: readonly PastChatGroupV2[];
}>) {
  const [showAll, setShowAll] = useState(false);
  const listId = `past-chats-${useId()}`;
  return (
    <section className="v2-memory-sources" data-testid="answer-memory-sources">
      {pastChats.length > 0 ? (
        <details className="v2-answer-process-section v2-memory-disclosure" data-testid="past-chats-disclosure">
          <summary className="v2-focusable">{formatMemoryUiCopy("source.pastChatsHeading", {
            count: pastChats.length
          })}</summary>
          <div id={listId} className="v2-past-chat-list">{
            pastChats.map((group, index) => (
              <PastChatV2 key={group.key} group={group} hidden={!showAll && index >= 3} />
            ))
          }</div>
          {pastChats.length > 3 ? (
            <button type="button" className="v2-memory-show-all v2-focusable"
              aria-controls={listId} aria-expanded={showAll}
              onClick={() => setShowAll((value) => !value)}>
              {showAll ? memoryUiCopy("source.showLess") : formatMemoryUiCopy("source.showAll", {
                count: pastChats.length
              })}
            </button>
          ) : null}
        </details>
      ) : null}
      {memories.length > 0 ? (
        <details className="v2-answer-process-section v2-memory-disclosure" data-testid="memories-disclosure">
          <summary className="v2-focusable">{formatMemoryUiCopy("source.heading", { count: memories.length })}</summary>
          <div className="v2-memory-source-list">{memories.map((source, index) => (
            <MemorySourceRowV2 key={source.memoryRef ?? index} source={source} />
          ))}</div>
        </details>
      ) : null}
    </section>
  );
}
