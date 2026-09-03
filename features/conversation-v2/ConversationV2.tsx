"use client";

import {
  MarkdownMessage,
  type MarkdownCitationRenderer
} from "@/components/chat/MarkdownMessage";
import {
  UiV2Button,
  UiV2Icon,
  UiV2IconButton,
  UiV2MenuItem,
  UiV2MenuSeparator,
  UiV2MenuSurface,
  UiV2Skeleton,
  moveMenuFocusV2
} from "@/components/ui-v2";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject
} from "react";
import { createPortal } from "react-dom";

export type ConversationMessageV2 = Readonly<{
  content: string;
  id: string;
  optimistic?: boolean;
  role: "assistant" | "user";
  renderCitation?: MarkdownCitationRenderer;
  streaming?: boolean;
}>;

export type ConversationMessageActionsV2 = Readonly<{
  branchDisabled?: boolean;
  deleteDisabled?: boolean;
  disabledReason?: string | null;
  editDisabled?: boolean;
  moreDisabled?: boolean;
  onBranchFromHere?(): void;
  onCopy?(): void;
  onDelete?(): void;
  onEdit?(): void;
  onMore?(): void;
  onRegenerate?(): void;
  regenerateDisabled?: boolean;
}>;

export type ConversationMessagePresentationV2 = Readonly<{
  /** Rendered under the actions row (the expanded Sources list). */
  afterActions?: ReactNode;
  afterContent?: ReactNode;
  beforeContent?: ReactNode;
  edit?: ConversationInlineEditV2Props;
  renderCitation?: MarkdownCitationRenderer;
  /** Always-visible controls at the start of the actions row (pager, Sources chip). */
  toolbarLeading?: ReactNode;
}>;

export type ConversationInlineEditV2Props = Readonly<{
  attachmentSlot?: ReactNode;
  draft: string;
  error?: string | null;
  onCancel(): void;
  onChange(value: string): void;
  onSubmit(): void;
  pending?: boolean;
  sendWithEnter?: boolean;
}>;

type ConversationTurnV2Props = Readonly<{
  actions?: ConversationMessageActionsV2;
  afterActions?: ReactNode;
  afterContent?: ReactNode;
  anchorId?: string;
  ariaLabel?: string;
  beforeContent?: ReactNode;
  className?: string;
  content: string;
  emptyText?: string;
  edit?: ConversationInlineEditV2Props;
  expandForReadingAnchor?: boolean;
  hideEmptyContent?: boolean;
  role: "assistant" | "user";
  renderCitation?: MarkdownCitationRenderer;
  streaming?: boolean;
  toolbarLeading?: ReactNode;
}>;

export function ConversationInlineEditV2({
  attachmentSlot = null,
  draft,
  error = null,
  onCancel,
  onChange,
  onSubmit,
  pending = false,
  sendWithEnter = true
}: ConversationInlineEditV2Props) {
  const descriptionId = useId();
  const errorId = useId();
  const inputId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSubmit = Boolean(draft.trim()) && !pending;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  function submit() {
    if (canSubmit) onSubmit();
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      if (pending) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey || (sendWithEnter && !event.shiftKey && !event.altKey))
    ) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form
      className="v2-inline-message-edit"
      data-testid="inline-message-edit-v2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="v2-sr-only" htmlFor={inputId}>Edit question</label>
      <textarea
        ref={textareaRef}
        aria-describedby={`${descriptionId}${error ? ` ${errorId}` : ""}`}
        aria-invalid={Boolean(error) || undefined}
        className="v2-inline-message-edit-input v2-focusable"
        disabled={pending}
        id={inputId}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleInputKeyDown}
        rows={1}
        value={draft}
      />
      {attachmentSlot ? (
        <div aria-label="Attachments in this message" className="v2-inline-message-edit-attachments">
          {attachmentSlot}
        </div>
      ) : null}
      <p className="v2-inline-message-edit-note" id={descriptionId}>
        <UiV2Icon name="branch" />
        <span>Sending creates a new branch; the original history stays unchanged.</span>
      </p>
      {error ? (
        <p className="v2-inline-message-edit-error" id={errorId} role="alert">{error}</p>
      ) : null}
      <div className="v2-inline-message-edit-actions">
        <UiV2Button disabled={pending} onClick={onCancel} type="button">Cancel</UiV2Button>
        <UiV2Button busy={pending} disabled={!canSubmit} tone="primary" type="submit">
          Send
        </UiV2Button>
      </div>
    </form>
  );
}

function interactiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(
    target.closest("a, button, input, select, textarea, [role='button'], [role='menuitem']")
  );
}

const USER_BUBBLE_CLAMP_LINE_LIMIT = 14;
const USER_BUBBLE_CLAMP_CHARACTER_LIMIT = 1600;

/**
 * A long question clamps to roughly fourteen bubble lines with a
 * "Show full message" expander (audit §18.12). The candidate check is a
 * deterministic content heuristic — line and character counts, never a layout
 * measurement — so server render, tests, and the browser agree.
 */
export function shouldClampUserBubbleV2(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  return (
    trimmed.split("\n").length > USER_BUBBLE_CLAMP_LINE_LIMIT ||
    trimmed.length > USER_BUBBLE_CLAMP_CHARACTER_LIMIT
  );
}

export function ConversationTurnV2({
  actions,
  afterActions,
  afterContent,
  anchorId,
  ariaLabel,
  beforeContent,
  className = "",
  content,
  emptyText = "This message has no text.",
  edit,
  expandForReadingAnchor = false,
  hideEmptyContent = false,
  role,
  renderCitation,
  streaming = false,
  toolbarLeading = null
}: ConversationTurnV2Props) {
  const [controlsOpen, setControlsOpen] = useState(false);
  const [bubbleExpansion, setBubbleExpansion] = useState<
    "automatic" | "collapsed" | "expanded"
  >("automatic");
  const [moreOpen, setMoreOpen] = useState(false);
  const [morePosition, setMorePosition] = useState<{
    left: number;
    placement: "above" | "below";
    top: number;
  } | null>(null);
  const moreMenuId = useId();
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const isUser = role === "user";
  const editing = isUser && Boolean(edit);
  const hasActions = Boolean(
    actions?.onBranchFromHere || actions?.onCopy || actions?.onDelete ||
    actions?.onEdit || actions?.onMore || actions?.onRegenerate
  );
  const hasMoreMenu = Boolean(actions?.onDelete || actions?.onBranchFromHere);
  const label = ariaLabel ?? (isUser ? "Question" : "Answer");
  const bubbleClampCandidate = isUser && shouldClampUserBubbleV2(content);
  const bubbleExpanded = bubbleExpansion === "expanded" ||
    (bubbleExpansion === "automatic" && expandForReadingAnchor);
  const bubbleClamped = bubbleClampCandidate && !bubbleExpanded;

  useEffect(() => {
    if (!moreOpen) return;
    queueMicrotask(() => {
      moreMenuRef.current?.querySelector<HTMLElement>("[role='menuitem']:not(:disabled)")?.focus();
    });
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (moreMenuRef.current?.contains(target) || moreButtonRef.current?.contains(target)) return;
      setMoreOpen(false);
      setMorePosition(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [moreOpen]);

  useLayoutEffect(() => {
    if (!moreOpen) return;

    function placeMenu() {
      const trigger = moreButtonRef.current;
      const menu = moreMenuRef.current;
      if (!trigger || !menu) return;
      const triggerBounds = trigger.getBoundingClientRect();
      const menuBounds = menu.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const below = window.innerHeight - triggerBounds.bottom >= menuBounds.height + gap + margin;
      const placement = below ? "below" : "above";
      const unclampedLeft = isUser
        ? triggerBounds.right - menuBounds.width
        : triggerBounds.left;
      const left = Math.max(
        margin,
        Math.min(unclampedLeft, window.innerWidth - menuBounds.width - margin)
      );
      const top = placement === "below"
        ? triggerBounds.bottom + gap
        : Math.max(margin, triggerBounds.top - menuBounds.height - gap);
      setMorePosition({ left, placement, top });
    }

    placeMenu();
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", placeMenu, true);
    return () => {
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", placeMenu, true);
    };
  }, [isUser, moreOpen]);

  function closeMoreMenu({ restoreFocus = false } = {}) {
    setMoreOpen(false);
    setMorePosition(null);
    if (restoreFocus) queueMicrotask(() => moreButtonRef.current?.focus());
  }

  function handleMoreMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    moveMenuFocusV2(event, moreMenuRef.current, () => closeMoreMenu({ restoreFocus: true }));
  }

  function toggleControlsOnSurface(event: MouseEvent<HTMLElement>) {
    if (!hasActions || interactiveTarget(event.target)) return;
    setControlsOpen((open) => !open);
  }

  // The turn itself is not a tab stop (UX audit 2026-09-02 A15): keyboard
  // users reach the action dock directly, and Escape from inside it folds
  // the dock and its menu again.
  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!hasActions || event.key !== "Escape" || moreOpen) return;
    setControlsOpen(false);
  }

  function cancelInlineEdit() {
    edit?.onCancel();
    if (!anchorId) return;
    const restoreFocus = () => {
      const turn = [...document.querySelectorAll<HTMLElement>("[data-message-id]")]
        .find((candidate) => candidate.dataset.messageId === anchorId);
      const button = turn?.querySelector<HTMLButtonElement>(
        'button[aria-label="Edit question"]'
      );
      button?.focus();
      return Boolean(button);
    };
    queueMicrotask(() => {
      if (!restoreFocus() && typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => restoreFocus());
      }
    });
  }

  return (
    <article
      className={`v2-conversation-turn ${className}`.trim()}
      data-controls-open={controlsOpen || undefined}
      data-conversation-message-id={anchorId}
      data-editing={editing || undefined}
      data-message-id={anchorId}
      data-role={role}
      aria-label={ariaLabel ?? label}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setControlsOpen(false);
      }}
      onClick={toggleControlsOnSurface}
      onKeyDown={handleKeyDown}
    >
      <div
        className="v2-conversation-turn-content"
        data-bubble-clamped={bubbleClamped ? "true" : undefined}
        data-thread-message-content
      >
        {beforeContent}
        {editing && edit ? (
          <ConversationInlineEditV2 {...edit} onCancel={cancelInlineEdit} />
        ) : (
          <>
            <div className="v2-conversation-markdown">
              {content.trim() ? (
                <MarkdownMessage
                  content={content}
                  renderCitation={role === "assistant" && !streaming ? renderCitation : undefined}
                  streaming={streaming}
                />
              ) : !hideEmptyContent ? (
                <p className="v2-conversation-empty-turn">{emptyText}</p>
              ) : null}
            </div>
            {bubbleClampCandidate ? (
              <button
                className="v2-bubble-expander v2-focusable"
                type="button"
                aria-expanded={bubbleExpanded}
                onClick={() => setBubbleExpansion(bubbleClamped ? "expanded" : "collapsed")}
              >
                {bubbleExpanded ? "Collapse" : "Show full message"}
              </button>
            ) : null}
            {afterContent}
          </>
        )}
      </div>

      {!editing && ((actions && hasActions) || toolbarLeading) ? (
        <div
          className="v2-message-actions"
          data-testid="conversation-message-actions"
          role="toolbar"
          aria-label={`${label} actions`}
        >
          {toolbarLeading}
          {actions && hasActions ? <span className="v2-message-actions-verbs">
          {actions?.onRegenerate ? (
            <UiV2IconButton
              disabled={actions.regenerateDisabled}
              icon="regenerate"
              label={`Regenerate ${label.toLowerCase()}`}
              tooltip={actions.regenerateDisabled ? actions.disabledReason ?? "Regenerate" : "Regenerate"}
              onClick={actions.onRegenerate}
            />
          ) : null}
          {actions?.onEdit ? (
            <UiV2IconButton
              disabled={actions.editDisabled}
              icon="edit"
              label={`Edit ${label.toLowerCase()}`}
              tooltip={actions.editDisabled ? actions.disabledReason ?? "Edit" : "Edit"}
              onClick={actions.onEdit}
            />
          ) : null}
          {actions?.onCopy ? (
            <UiV2IconButton
              icon="copy"
              label={`Copy ${label.toLowerCase()}`}
              tooltip="Copy"
              onClick={actions.onCopy}
            />
          ) : null}
          {actions?.onMore || hasMoreMenu ? (
            <span className="v2-message-more-wrap">
              <UiV2IconButton
                ref={moreButtonRef}
                aria-controls={hasMoreMenu && moreOpen ? moreMenuId : undefined}
                aria-expanded={hasMoreMenu ? moreOpen : undefined}
                aria-haspopup={hasMoreMenu ? "menu" : undefined}
                disabled={actions.moreDisabled}
                icon="more"
                label={`More ${label.toLowerCase()} actions`}
                tooltip={actions.moreDisabled ? actions.disabledReason ?? "More" : "More"}
                onClick={() => {
                  if (hasMoreMenu) {
                    setMoreOpen((open) => {
                      if (open) setMorePosition(null);
                      return !open;
                    });
                  }
                  else actions.onMore?.();
                }}
              />
              {moreOpen && typeof document !== "undefined" ? createPortal(
                <UiV2MenuSurface
                  ref={moreMenuRef}
                  className="v2-message-more-menu"
                  data-placement={morePosition?.placement}
                  id={moreMenuId}
                  label={`${label} menu`}
                  onKeyDown={handleMoreMenuKeyDown}
                  style={{
                    left: morePosition?.left ?? 0,
                    top: morePosition?.top ?? 0,
                    visibility: morePosition ? "visible" : "hidden"
                  }}
                >
                  {/* Branch first; Delete last and destructive (UX audit
                      2026-09-02 B4). */}
                  {actions.onBranchFromHere ? (
                    <UiV2MenuItem
                      disabled={actions.branchDisabled}
                      icon="branch"
                      onClick={() => {
                        closeMoreMenu();
                        actions.onBranchFromHere?.();
                      }}
                    >
                      Branch from here
                    </UiV2MenuItem>
                  ) : null}
                  {actions.onBranchFromHere && actions.onDelete ? <UiV2MenuSeparator /> : null}
                  {actions.onDelete ? (
                    <UiV2MenuItem
                      disabled={actions.deleteDisabled}
                      icon="trash"
                      tone="destructive"
                      onClick={() => {
                        closeMoreMenu();
                        actions.onDelete?.();
                      }}
                    >
                      Delete
                    </UiV2MenuItem>
                  ) : null}
                </UiV2MenuSurface>,
                document.body
              ) : null}
            </span>
          ) : null}
          {/* The reason reaches pointer users as the disabled controls'
              tooltips (B6) and screen readers through this hidden text. */}
          {actions?.disabledReason && (
            actions.branchDisabled || actions.deleteDisabled || actions.editDisabled ||
            actions.moreDisabled || actions.regenerateDisabled
          ) ? (
            <span className="v2-sr-only">{actions.disabledReason}</span>
          ) : null}
          </span> : null}
        </div>
      ) : null}
      {!editing ? afterActions : null}
    </article>
  );
}

type ConversationV2Props = Readonly<{
  composerSlot?: ReactNode;
  error?: string | null;
  getMessageActions?(message: ConversationMessageV2): ConversationMessageActionsV2 | undefined;
  getMessagePresentation?(
    message: ConversationMessageV2
  ): ConversationMessagePresentationV2 | undefined;
  hasOlder?: boolean;
  jumpToLatestBottomOffset?: number;
  loading?: boolean;
  loadingEarlier?: boolean;
  messages: readonly ConversationMessageV2[];
  olderError?: string | null;
  onJumpToLatest?(): void;
  onLoadEarlier?(): Promise<unknown> | unknown;
  onRetry?(): void;
  onScroll?(): void;
  orientationSlot?: ReactNode;
  renderMessage?(message: ConversationMessageV2): ReactNode;
  scrollRef?: RefObject<HTMLDivElement | null>;
  showJumpToLatest?: boolean;
  unavailable?: boolean;
}>;

type ScrollAnchor = {
  id: string;
  top: number;
};

function firstVisibleAnchor(container: HTMLElement): ScrollAnchor | null {
  const containerBounds = container.getBoundingClientRect();
  const messages = container.querySelectorAll<HTMLElement>("[data-conversation-message-id]");

  for (const message of messages) {
    const bounds = message.getBoundingClientRect();
    if (bounds.bottom > containerBounds.top && bounds.top < containerBounds.bottom) {
      const id = message.dataset.conversationMessageId;
      if (id) return { id, top: bounds.top };
    }
  }

  return null;
}

function findAnchoredMessage(container: HTMLElement, id: string): HTMLElement | null {
  const messages = container.querySelectorAll<HTMLElement>("[data-conversation-message-id]");
  return [...messages].find((message) => message.dataset.conversationMessageId === id) ?? null;
}

export function ConversationV2({
  composerSlot,
  error = null,
  getMessageActions,
  getMessagePresentation,
  hasOlder = false,
  jumpToLatestBottomOffset = 0,
  loading = false,
  loadingEarlier = false,
  messages,
  olderError = null,
  onJumpToLatest,
  onLoadEarlier,
  onRetry,
  onScroll,
  orientationSlot,
  renderMessage,
  scrollRef: externalScrollRef,
  showJumpToLatest = false,
  unavailable = false
}: ConversationV2Props) {
  const internalScrollRef = useRef<HTMLDivElement>(null);
  const scrollRef = externalScrollRef ?? internalScrollRef;
  const anchorRef = useRef<ScrollAnchor | null>(null);
  const olderSentinelRef = useRef<HTMLButtonElement>(null);
  const messageKey = useMemo(() => messages.map((message) => message.id).join("\0"), [messages]);
  const showOrientation = !loading && !unavailable && !error && messages.length === 0;
  const olderAutoLoadBlocked = !hasOlder || loadingEarlier || Boolean(olderError) || !onLoadEarlier;

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const container = scrollRef.current;
    if (!anchor || !container) return;

    const message = findAnchoredMessage(container, anchor.id);
    if (message) {
      container.scrollTop += message.getBoundingClientRect().top - anchor.top;
    }
    anchorRef.current = null;
  }, [messageKey, scrollRef]);

  function loadEarlier() {
    const container = scrollRef.current;
    if (!container || !onLoadEarlier || loadingEarlier) return;
    anchorRef.current = firstVisibleAnchor(container);
    try {
      void Promise.resolve(onLoadEarlier()).catch(() => {
        anchorRef.current = null;
      });
    } catch {
      anchorRef.current = null;
    }
  }

  // Scrolling up to the start of the loaded history fetches the earlier page
  // by itself; the button stays as the visible keyboard route and as the
  // manual Retry after a failed page (a failure never auto-retries).
  useEffect(() => {
    const sentinel = olderSentinelRef.current;
    const container = scrollRef.current;
    if (
      !sentinel || !container || olderAutoLoadBlocked ||
      typeof IntersectionObserver === "undefined"
    ) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting) || !onLoadEarlier) return;
      anchorRef.current = firstVisibleAnchor(container);
      void Promise.resolve(onLoadEarlier()).catch(() => {
        anchorRef.current = null;
      });
    }, { root: container, rootMargin: "160px 0px 0px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [messageKey, olderAutoLoadBlocked, onLoadEarlier, scrollRef]);

  return (
    <section
      className="v2-conversation"
      data-testid="conversation-v2"
      aria-label="Conversation"
      aria-busy={loading || loadingEarlier || undefined}
    >
      <div
        className="v2-conversation-scroll"
        ref={scrollRef}
        data-testid="conversation-scroll"
        onScroll={onScroll}
      >
        {loading && messages.length === 0 ? (
          <div className="v2-conversation-state" aria-label="Loading conversation">
            <div className="v2-conversation-loading" data-testid="conversation-loading">
              <UiV2Skeleton className="v2-conversation-skeleton-question" />
              <UiV2Skeleton />
              <UiV2Skeleton className="v2-conversation-skeleton-short" />
              <UiV2Skeleton />
            </div>
          </div>
        ) : unavailable ? (
          <div className="v2-conversation-state" data-testid="conversation-unavailable">
            <p className="v2-conversation-state-kicker">Conversation unavailable</p>
            <h1>This chat is unavailable</h1>
            <p>It may have been deleted, or your account no longer has access.</p>
            {onRetry ? <UiV2Button onClick={onRetry}>Retry</UiV2Button> : null}
          </div>
        ) : error && messages.length === 0 ? (
          <div className="v2-conversation-state" role="alert" data-testid="conversation-error">
            <p className="v2-conversation-state-kicker">Could not load conversation</p>
            <h1>Could not open the chat</h1>
            <p>Check your connection and try again.</p>
            {onRetry ? <UiV2Button onClick={onRetry}>Retry</UiV2Button> : null}
          </div>
        ) : showOrientation ? (
          <div className="v2-conversation-orientation" data-testid="conversation-empty">
            {orientationSlot ?? (
              // The blank chat greets quietly: no canvas wordmark and no
              // marketing subtitle — the greeting alone is the welcome state.
              <div className="v2-conversation-orientation-copy">
                <span className="v2-conversation-orientation-mark" aria-hidden="true">
                  <UiV2Icon name="brand" />
                </span>
                <h1>What are we working on?</h1>
              </div>
            )}
            {composerSlot ? <div className="v2-conversation-empty-composer">{composerSlot}</div> : null}
          </div>
        ) : (
          <div className="v2-conversation-document">
            {hasOlder || loadingEarlier || olderError ? (
              <div className="v2-conversation-older">
                {olderError ? (
                  <div role="alert">
                    <span>Could not load earlier messages.</span>
                    <button type="button" onClick={loadEarlier}>Retry</button>
                  </div>
                ) : (
                  <button
                    ref={olderSentinelRef}
                    type="button"
                    disabled={loadingEarlier}
                    aria-busy={loadingEarlier || undefined}
                    onClick={loadEarlier}
                  >
                    {loadingEarlier ? "Loading…" : "Load earlier messages"}
                  </button>
                )}
              </div>
            ) : null}

            {error ? (
              <div className="v2-conversation-inline-error" role="alert">
                <span>Part of the conversation did not load.</span>
                {onRetry ? <button type="button" onClick={onRetry}>Retry</button> : null}
              </div>
            ) : null}

            <ol className="v2-conversation-thread" data-testid="conversation-thread">
              {messages.map((message) => (
                <li key={message.id}>
                  {renderMessage?.(message) ?? (
                    <ConversationTurnV2
                      actions={getMessageActions?.(message)}
                      afterActions={getMessagePresentation?.(message)?.afterActions}
                      afterContent={getMessagePresentation?.(message)?.afterContent}
                      anchorId={message.id}
                      beforeContent={getMessagePresentation?.(message)?.beforeContent}
                      content={message.content}
                      edit={getMessagePresentation?.(message)?.edit}
                      renderCitation={getMessagePresentation?.(message)?.renderCitation}
                      toolbarLeading={getMessagePresentation?.(message)?.toolbarLeading}
                      role={message.role}
                      streaming={message.streaming}
                    />
                  )}
                </li>
              ))}
            </ol>
            <div aria-hidden="true" data-thread-reading-spacer />
          </div>
        )}
      </div>
      {showJumpToLatest && onJumpToLatest ? (
        <UiV2IconButton
          className="v2-conversation-jump-latest"
          icon="chevron-down"
          label="Jump to latest message"
          style={jumpToLatestBottomOffset > 0
            ? { bottom: `calc(${jumpToLatestBottomOffset}px + 1rem)` }
            : undefined}
          onClick={onJumpToLatest}
        />
      ) : null}
    </section>
  );
}
