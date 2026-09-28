"use client";

import type { AssistantCardView, AssistantGalleryView } from "@/components/assistants/libraryViewContracts";
import { UiV2Button, UiV2Icon, UiV2IconButton } from "@/components/ui-v2";
import { AssistantAvatarV2 } from "@/components/ui-v2/AssistantAvatarV2";
import { assistantCardStatusText } from "@/features/library-v2/assistantAvailabilityCopy";
import { useId, type MouseEvent } from "react";
import { AssistantActionsMenuV2 } from "./AssistantActionsMenuV2";
import { assistantCapabilityItems, assistantCardMeta } from "./assistantDetailCopy";

/**
 * One gallery card (PRD 10.1): an `article` whose heading button opens the
 * detail sheet, "Start chat" always visible, the pin toggle and the "…"
 * menu. A click anywhere else on the card opens the detail sheet too.
 */
export function AssistantCardV2({
  busy,
  card,
  gallery,
  headingLevel,
  onCopied
}: Readonly<{
  busy: boolean;
  card: AssistantCardView;
  gallery: AssistantGalleryView;
  /** 4 under a group heading, 3 in a flat list. */
  headingLevel: 3 | 4;
  onCopied(copied: boolean): void;
}>) {
  const Heading = headingLevel === 4 ? "h4" : "h3";
  const { assistant, state } = card;
  const headingId = useId();
  const status = assistantCardStatusText(state, assistant.availability);
  const capabilities = assistantCapabilityItems(card.capabilities);
  const meta = assistantCardMeta(assistant);
  const startable = state.kind === "ready";
  const open = () => gallery.onOpenDetail(assistant.id);
  const openFromCard = (event: MouseEvent<HTMLElement>) => {
    // Buttons, menus and their portalled sheets own their clicks.
    if (event.target instanceof Element && event.target.closest("button, a, input, select, [role='menu'], [role='dialog']")) return;
    if (window.getSelection()?.toString()) return;
    open();
  };
  return (
    <article
      aria-labelledby={headingId}
      className="v2-assistants-card"
      data-state={state.kind}
      data-testid={`assistant-card-${assistant.id}`}
      onClick={openFromCard}
    >
      <header className="v2-assistants-card-head">
        <AssistantAvatarV2 className="v2-assistants-avatar" recipe={assistant.avatar} size={40} />
        <div className="v2-assistants-card-title">
          <Heading id={headingId}>
            {/* The title gives a mouse the whole name the line may cut. */}
            <button className="v2-assistants-card-open v2-focusable" title={assistant.name} type="button" onClick={open}>
              {assistant.name}
            </button>
          </Heading>
          {/* Owner and audience keep one line, the owner shortened first; the model follows them
              or takes the second line. Each "·" stays with the segment before it. */}
          <p className="v2-assistants-card-meta">
            <span className="v2-assistants-card-meta-lead">
              <span className="v2-assistants-card-meta-owner">{meta.owner}</span>
              {" · "}
              <span>{meta.audience}</span>
              {meta.model ? " ·" : null}
            </span>
            {meta.model ? <>{" "}<span className="v2-assistants-card-meta-model">{meta.model}</span></> : null}
          </p>
        </div>
        {assistant.featured ? <UiV2Icon className="v2-assistants-featured-mark" name="star-fill" title="Featured" /> : null}
        <AssistantActionsMenuV2
          assistant={assistant}
          canDuplicate
          disabled={busy}
          gallery={gallery}
          includeEdit
          onCopied={onCopied}
        />
      </header>
      {assistant.description ? <p className="v2-assistants-card-description">{assistant.description}</p> : null}
      {capabilities.length > 0 ? (
        <ul aria-label="Capabilities" className="v2-assistants-capabilities">
          {capabilities.map((item) => (
            <li data-tooltip={item.label} key={item.key}>
              <UiV2Icon name={item.icon} />
              <span aria-hidden="true">{item.count}</span>
              <span className="sr-only">{item.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {status ? (
        <p className="v2-assistants-card-status" data-tone={state.kind === "archived" ? "neutral" : "warn"}>{status}</p>
      ) : null}
      <footer className="v2-assistants-card-actions">
        {state.kind === "archived" && assistant.owned ? (
          <>
            <UiV2Button
              aria-label={`Restore ${assistant.name}`}
              disabled={busy}
              icon="regenerate"
              onClick={() => gallery.onArchiveToggle(assistant.id, false)}
            >
              Restore
            </UiV2Button>
            <UiV2Button
              aria-label={`Delete ${assistant.name}`}
              disabled={busy}
              icon="trash"
              onClick={() => gallery.onDelete(assistant.id)}
            >
              Delete
            </UiV2Button>
          </>
        ) : (
          <UiV2Button
            aria-label={`Start chat with ${assistant.name}`}
            className="v2-assistants-start"
            disabled={busy || !startable}
            icon="chat"
            onClick={() => void gallery.onStartChat(assistant.id)}
          >
            Start chat
          </UiV2Button>
        )}
        {state.kind !== "archived" ? (
          <UiV2IconButton
            aria-pressed={assistant.pinned}
            className="v2-assistants-pin"
            disabled={busy}
            icon={assistant.pinned ? "pin-fill" : "pin"}
            label={`Pin ${assistant.name}`}
            tooltip={assistant.pinned ? "Unpin" : "Pin"}
            onClick={() => gallery.onPinToggle(assistant.id, !assistant.pinned)}
          />
        ) : null}
      </footer>
    </article>
  );
}
