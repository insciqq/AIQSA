"use client";

import { useId, useState } from "react";
import { MEMORY_NOTE_COPY as copy, memoryNoteDate } from "@/components/app-shell/memoryNoteUiCopy";
import { UiV2Icon } from "@/components/ui-v2";
import { pastChatPath, type PastChatSource } from "@/lib/contracts/pastChats";
import { shellLinkClick } from "./shellLinkClick";

/** Chats listed before Show all. */
const SHOWN_CHATS = 3;

export type PastChatGroup = Readonly<{ chatId: string; sources: readonly PastChatSource[] }>;

/** An answer's past-chat sources by chat, in the order the search ranked them: a chat leads where its best turn did. */
export function groupPastChatSources(sources: readonly PastChatSource[]): PastChatGroup[] {
  const groups = new Map<string, PastChatSource[]>();
  for (const source of sources) {
    const group = groups.get(source.chatId);
    if (group) group.push(source);
    else groups.set(source.chatId, [source]);
  }
  return [...groups].map(([chatId, grouped]) => ({ chatId, sources: grouped }));
}

/** The chat page a source opens, scrolled to the turn it came from. */
export function pastChatSourceHref(source: Pick<PastChatSource, "chatId" | "messageId">): string {
  return `${pastChatPath(source.chatId)}?message=${encodeURIComponent(source.messageId)}`;
}

type OpenChatMessage = (chatId: string, messageId: string) => void;

function SourceLinkV2({ children, label, onOpen, source }: Readonly<{
  children: string;
  label?: string;
  onOpen?: OpenChatMessage;
  source: PastChatSource;
}>) {
  return (
    <a className="v2-focusable" aria-label={label} href={pastChatSourceHref(source)}
      onClick={shellLinkClick(onOpen ? () => onOpen(source.chatId, source.messageId) : undefined)}>
      {children}
    </a>
  );
}

function PastChatGroupV2({ group, hidden, onOpen }: Readonly<{ group: PastChatGroup; hidden: boolean; onOpen?: OpenChatMessage }>) {
  const [first, ...rest] = group.sources;
  if (!first) return null;
  return (
    <article className="v2-past-chat" data-testid="past-chat-source" hidden={hidden}>
      <div className="v2-past-chat-heading">
        <UiV2Icon name="chat" />
        <SourceLinkV2 label={copy.pastChatOpenLabel(first.chatTitle)} onOpen={onOpen} source={first}>{first.chatTitle}</SourceLinkV2>
        <time dateTime={first.date}>{memoryNoteDate(first.date)}</time>
      </div>
      <p className="v2-past-chat-preview">{pastChatExcerptText(first.excerpt)}</p>
      {rest.length ? (
        <details className="v2-past-chat-excerpts">
          <summary className="v2-focusable">{copy.pastChatMore(rest.length)}</summary>
          <ul className="v2-past-chat-more">
            {rest.map((source) => (
              <li key={source.messageId}>
                <SourceLinkV2 label={`${copy.pastChatOpenLabel(source.chatTitle)}, ${memoryNoteDate(source.date)}`} onOpen={onOpen}
                  source={source}>{memoryNoteDate(source.date)}</SourceLinkV2>
                <p>{pastChatExcerptText(source.excerpt)}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}

/**
 * An excerpt as a reader sees it: the index labels each turn's parts ("User:", "Assistant:") for the model, which a
 * person does not need, so the labels go and the question and answer read as one line.
 */
export function pastChatExcerptText(excerpt: string): string {
  return excerpt.split(/\n+/u).map((line) => line.replace(/^(?:User|Assistant):\s*/u, "").trim()).filter(Boolean).join(" — ");
}

/**
 * How the sources are headed in the answer's fold. `summary`: their own "Past chats · N" disclosure beside other work.
 * When the fold's own line already reads "Past chats · N", a second heading would only repeat it, so the list sits
 * open in the fold: `title` heads it "Past chats" among the fold's other sections, `none` leaves it unheaded as the
 * fold's only content.
 */
export type PastChatSourcesHeading = "summary" | "title" | "none";

/**
 * "Past chats · N" under an answer: the past chats the answer's search brought into its context, each with its title,
 * date and excerpt, linking to the chat at the turn it came from. `onOpenChatMessage` opens it in the shell; without
 * it the link loads the chat page. Counts describe what entered the context, not proven influence.
 */
export function PastChatSourcesV2({ heading = "summary", onOpenChatMessage, sources }: Readonly<{
  heading?: PastChatSourcesHeading;
  onOpenChatMessage?: OpenChatMessage;
  sources: readonly PastChatSource[];
}>) {
  const [showAll, setShowAll] = useState(false);
  const listId = `past-chat-sources-${useId()}`;
  const groups = groupPastChatSources(sources);
  if (groups.length === 0) return null;
  const body = (
    <>
      <div id={listId} className="v2-past-chat-list">
        {groups.map((group, index) => (
          <PastChatGroupV2 group={group} hidden={!showAll && index >= SHOWN_CHATS} key={group.chatId} onOpen={onOpenChatMessage} />
        ))}
      </div>
      {groups.length > SHOWN_CHATS ? (
        <button type="button" className="v2-memory-show-all v2-focusable" aria-controls={listId} aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}>
          {showAll ? copy.pastChatsShowLess : copy.pastChatsShowAll(groups.length)}
        </button>
      ) : null}
    </>
  );
  if (heading !== "summary") {
    return (
      <section className="v2-answer-process-section v2-past-chat-sources" data-heading={heading} data-testid="past-chat-sources">
        {heading === "title" ? <h3>{copy.pastChatsTitle}</h3> : null}
        {body}
      </section>
    );
  }
  return (
    <details className="v2-answer-process-section v2-memory-disclosure" data-testid="past-chat-sources">
      <summary className="v2-focusable">{copy.pastChatsHeading(groups.length)}</summary>
      {body}
    </details>
  );
}
