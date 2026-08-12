import {
  CitationBlock,
  ContextTruncationBlock,
  ReasoningBlock,
  SearchSummaryBlock,
  ToolActivityBlock
} from "@/components/app-shell/ThreadArtifacts";
import { RunReceipt } from "@/components/app-shell/RunReceipt";
import { KnowledgeEvidenceBlock } from "@/components/app-shell/KnowledgeEvidenceBlock";
import {
  MemoryActionConfirmation,
  MemoryEvidenceBlock,
  memoryReceiptFact,
  visibleMemoryReceipt
} from "@/components/app-shell/MemoryEvidenceBlock";
import {
  refreshMemorySettings,
  useMemorySettingsStore
} from "@/components/app-shell/memorySettingsStore";
import { MEMORY_PRESENTATION_LOCALE } from "@/lib/contracts/memoryPresentation";
import { AssistantAvatar } from "@/components/assistants/AssistantAvatar";
import {
  deriveRunReceipt,
  type RunReceiptSegmentKind
} from "@/components/app-shell/runReceiptModel";
import { runActivityLabel, type PipelineSnapshot } from "@/components/app-shell/runState";
import {
  attachmentBlocksFromThreadContent,
  textFromThreadContent
} from "@/components/app-shell/threadContent";
import type {
  PersistedRun,
  ThreadArtifactSummary,
  ThreadMessage
} from "@/components/app-shell/types";
import { MarkdownMessage } from "@/components/chat/MarkdownMessage";
import { GeminiSearchSuggestions } from "@/components/app-shell/GeminiSearchSuggestions";
import {
  CircleAlert,
  Copy,
  FileText,
  GitBranch,
  Image as ImageIcon,
  ListTree,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Square,
  Trash2
} from "lucide-react";
import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { createPortal } from "react-dom";

const iconActionClass =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-control text-ink-muted outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-50 sm:size-9 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11";

const messageMenuItemClass =
  "flex min-h-11 w-full items-center gap-2 rounded-control px-3 text-left text-sm font-medium text-ink-secondary outline-none hover:bg-control-hover hover:text-ink focus-visible:bg-control-hover focus-visible:text-ink focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-50 sm:min-h-9 [@media(hover:none)]:!min-h-11 [@media(pointer:coarse)]:!min-h-11";

const actionStripClass =
  "absolute bottom-0 right-2 z-10 flex min-h-11 translate-y-1/2 items-center gap-0.5 rounded-panel border border-trace-subtle bg-overlay-surface p-0.5 shadow-float [@media(hover:none)]:!min-h-11 [@media(pointer:coarse)]:!min-h-11 sm:min-h-9";

const messageMenuViewportGutter = 8;
const messageMenuTriggerGap = 8;
export const compactMessageControlsQuery =
  "(max-width: 639px), (max-height: 32rem), (hover: none), (pointer: coarse)";

type MessageMenuPlacement = Readonly<{
  left: number;
  side: "above" | "below";
  top: number;
}>;

type InlineReceiptDisclosure =
  | "citations"
  | "knowledge"
  | "memory"
  | "reasoning"
  | "search"
  | "tools";

function ThreadRunActivity({ pipeline }: { pipeline: PipelineSnapshot }) {
  const label = runActivityLabel(pipeline);
  const error = pipeline.phase === "error";

  return (
    <div
      className={`pipeline-indicator mb-4 inline-flex min-h-5 items-center gap-2 text-xs font-medium ${error ? "text-critical" : "text-ink-secondary"}`}
      data-phase={pipeline.phase}
      data-testid="thread-run-activity"
      aria-label={`Run status: ${label}`}
    >
      {error ? (
        <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <span className="size-2 shrink-0 rounded-full bg-proof" data-run-activity aria-hidden="true" />
      )}
      <span>
        {label}
        {error ? "" : "…"}
      </span>
    </div>
  );
}

function turnActionDescription(message: ThreadMessage): string {
  const role = message.role === "user" ? "Question" : "Answer";
  const content = textFromThreadContent(message.content).replace(/\s+/g, " ").trim();
  const attachments =
    message.role === "user" ? attachmentBlocksFromThreadContent(message.content) : [];
  const fallback =
    attachments.length > 0
      ? `${attachments.length} ${attachments.length === 1 ? "attachment" : "attachments"}`
      : "No text";
  const summary = content || fallback;
  const preview = summary.length > 72 ? `${summary.slice(0, 69).trimEnd()}…` : summary;

  return `${role}: ${preview}`;
}

function TurnActions({
  disabledDescriptionId,
  editPending,
  editPendingDescriptionId,
  message,
  onBranchFromMessage,
  onCopyMessage,
  onDeleteMessage,
  onEditMessage,
  onRegenerateMessage,
  onToggleRunDetails,
  runDetailsOpen,
  streaming,
  targetDescriptionId
}: {
  disabledDescriptionId: string;
  editPending: boolean;
  editPendingDescriptionId: string;
  message: ThreadMessage;
  onBranchFromMessage(messageId: string): void;
  onCopyMessage(message: ThreadMessage): void;
  onDeleteMessage(messageId: string): void;
  onEditMessage(message: ThreadMessage): void;
  onRegenerateMessage(messageId: string): void;
  onToggleRunDetails(): void;
  runDetailsOpen: boolean;
  streaming: boolean;
  targetDescriptionId: string;
}): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPlacement, setMenuPlacement] = useState<MessageMenuPlacement | null>(null);
  const menuVisible = menuOpen && !streaming;
  const boundaryRef = useRef<HTMLDivElement>(null);
  const initialMenuFocusRef = useRef<"first" | "last">("first");
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const mutableActionDescriptionIds = streaming
    ? `${targetDescriptionId} ${disabledDescriptionId}`
    : targetDescriptionId;
  const editActionDescriptionIds = editPending
    ? `${mutableActionDescriptionIds} ${editPendingDescriptionId}`
    : mutableActionDescriptionIds;
  const menuId = `message-more-actions-${message.id}`;

  function menuItems(): HTMLButtonElement[] {
    return Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []
    );
  }

  function closeMenu({ restoreFocus = false } = {}) {
    setMenuOpen(false);
    setMenuPlacement(null);
    if (restoreFocus) {
      window.setTimeout(() => triggerRef.current?.focus({ preventScroll: true }), 0);
    }
  }

  function openMenu(initialFocus: "first" | "last" = "first") {
    initialMenuFocusRef.current = initialFocus;
    setMenuPlacement(null);
    setMenuOpen(true);
  }

  function runMenuAction(action: () => void) {
    triggerRef.current?.focus({ preventScroll: true });
    setMenuOpen(false);
    setMenuPlacement(null);
    window.setTimeout(action, 0);
  }

  function moveFocusPastTrigger(backward: boolean) {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger) return;

    const candidates = Array.from(document.querySelectorAll<HTMLElement>([
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      '[tabindex]:not([tabindex="-1"])'
    ].join(","))).filter((element) => {
      if (menu?.contains(element) || element.closest('[hidden], [inert], [aria-hidden="true"]')) {
        return false;
      }
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    });
    const triggerIndex = candidates.indexOf(trigger);
    const target = triggerIndex < 0
      ? trigger
      : candidates[triggerIndex + (backward ? -1 : 1)] ?? trigger;

    setMenuOpen(false);
    setMenuPlacement(null);
    window.setTimeout(() => target.focus({ preventScroll: true }), 0);
  }

  useLayoutEffect(() => {
    if (!menuVisible) {
      return;
    }

    function placeMenu() {
      const menu = menuRef.current;
      const trigger = triggerRef.current;
      if (!menu || !trigger) {
        return;
      }

      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const menuWidth = Math.min(
        menuRect.width || 208,
        Math.max(0, viewportWidth - messageMenuViewportGutter * 2)
      );
      const menuHeight = Math.min(
        menuRect.height || 112,
        Math.max(0, viewportHeight - messageMenuViewportGutter * 2)
      );
      const availableAbove = triggerRect.top - messageMenuTriggerGap - messageMenuViewportGutter;
      const availableBelow = viewportHeight - triggerRect.bottom - messageMenuTriggerGap - messageMenuViewportGutter;
      const side = availableBelow >= menuHeight || availableBelow >= availableAbove ? "below" : "above";
      const idealTop = side === "above"
        ? triggerRect.top - messageMenuTriggerGap - menuHeight
        : triggerRect.bottom + messageMenuTriggerGap;
      const maximumTop = Math.max(messageMenuViewportGutter, viewportHeight - menuHeight - messageMenuViewportGutter);
      const top = Math.min(Math.max(messageMenuViewportGutter, idealTop), maximumTop);
      const maximumLeft = Math.max(messageMenuViewportGutter, viewportWidth - menuWidth - messageMenuViewportGutter);
      const left = Math.min(
        Math.max(messageMenuViewportGutter, triggerRect.right - menuWidth),
        maximumLeft
      );

      setMenuPlacement((current) => (
        current?.left === left && current.side === side && current.top === top
          ? current
          : { left, side, top }
      ));
    }

    placeMenu();
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", placeMenu, true);
    return () => {
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", placeMenu, true);
    };
  }, [menuVisible]);

  useEffect(() => {
    if (!menuVisible) {
      return;
    }

    const timer = window.setTimeout(() => {
      const items = menuItems();
      const item = initialMenuFocusRef.current === "last" ? items.at(-1) : items[0];
      initialMenuFocusRef.current = "first";
      item?.focus({ preventScroll: true });
    }, 0);

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !boundaryRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        closeMenu();
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [menuVisible]);

  useEffect(() => {
    if (!streaming || !menuOpen) {
      return;
    }

    const timer = window.setTimeout(() => {
      setMenuOpen(false);
      setMenuPlacement(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [menuOpen, streaming]);

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu({ restoreFocus: true });
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      moveFocusPastTrigger(event.shiftKey);
      return;
    }

    const items = menuItems();
    if (items.length === 0) {
      return;
    }

    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    } else if (event.key === "ArrowUp") {
      nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = items.length - 1;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      items[nextIndex]?.focus({ preventScroll: true });
    }
  }

  return (
    <>
      <button
        aria-label="Regenerate message"
        aria-describedby={mutableActionDescriptionIds}
        className={`${iconActionClass} hover:text-proof`}
        disabled={streaming}
        title={streaming ? "Regenerate is disabled while a response is streaming" : "Regenerate message"}
        type="button"
        onClick={() => onRegenerateMessage(message.id)}
      >
        <RefreshCw className="size-3.5" aria-hidden="true" />
        <span className="sr-only">Regenerate</span>
      </button>
      {message.role === "user" || message.role === "assistant" ? (
        <button
          aria-label="Edit message"
          aria-describedby={editActionDescriptionIds}
          className={`${iconActionClass} hover:text-proof`}
          disabled={streaming || editPending}
          title={
            streaming
              ? "Edit is disabled while a response is streaming"
              : editPending
                ? "Edit is disabled while another edited branch is saving"
                : "Edit message"
          }
          type="button"
          onClick={() => onEditMessage(message)}
        >
          <Pencil className="size-3.5" aria-hidden="true" />
          <span className="sr-only">Edit</span>
        </button>
      ) : null}
      <button
        aria-label="Copy message"
        aria-describedby={targetDescriptionId}
        className={`${iconActionClass} hover:text-proof`}
        title="Copy message"
        type="button"
        onClick={() => onCopyMessage(message)}
      >
        <Copy className="size-3.5" aria-hidden="true" />
        <span className="sr-only">Copy</span>
      </button>
      <div className="relative" ref={boundaryRef}>
        <button
          ref={triggerRef}
          aria-controls={menuVisible ? menuId : undefined}
          aria-expanded={menuVisible}
          aria-haspopup="menu"
          aria-label="More message actions"
          aria-describedby={streaming ? `${targetDescriptionId} ${disabledDescriptionId}` : targetDescriptionId}
          className={iconActionClass}
          data-message-menu-trigger="true"
          disabled={streaming}
          title={streaming ? "More actions are unavailable while a response is streaming" : "More message actions"}
          type="button"
          onClick={() => (menuOpen ? closeMenu({ restoreFocus: true }) : openMenu())}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              openMenu("first");
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              openMenu("last");
            } else if (event.key === "Escape" && menuOpen) {
              event.preventDefault();
              closeMenu({ restoreFocus: true });
            }
          }}
        >
          <MoreHorizontal className="size-3.5" aria-hidden="true" />
          <span className="sr-only">More</span>
        </button>

        {menuVisible && typeof document !== "undefined" ? createPortal(
          <div
            ref={menuRef}
            className="pop-enter fixed z-50 max-h-[calc(100dvh-1rem)] w-52 max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-panel border border-trace-subtle bg-overlay-surface p-2 shadow-overlay"
            data-placement={menuPlacement?.side}
            id={menuId}
            role="menu"
            aria-label="More message actions"
            style={{
              left: menuPlacement?.left ?? 0,
              top: menuPlacement?.top ?? 0,
              visibility: menuPlacement ? "visible" : "hidden"
            }}
            onKeyDown={handleMenuKeyDown}
          >
            {message.role === "assistant" ? (
              <button
                aria-label={runDetailsOpen ? "Hide run details" : "Show run details"}
                aria-describedby={targetDescriptionId}
                className={messageMenuItemClass}
                type="button"
                role="menuitem"
                onClick={() => runMenuAction(onToggleRunDetails)}
              >
                <ListTree className="size-4 text-ink-muted" aria-hidden="true" />
                {runDetailsOpen ? "Hide run details" : "Show run details"}
              </button>
            ) : null}
            <button
              aria-label="Delete message"
              aria-describedby={mutableActionDescriptionIds}
              className={`${messageMenuItemClass} text-critical hover:bg-critical/10 hover:text-critical focus-visible:bg-critical/10 focus-visible:text-critical`}
              disabled={streaming}
              title={streaming ? "Delete is disabled while a response is streaming" : "Delete message"}
              type="button"
              role="menuitem"
              onClick={() => runMenuAction(() => onDeleteMessage(message.id))}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              Delete
            </button>
            <button
              aria-label="Branch from here"
              aria-describedby={mutableActionDescriptionIds}
              className={messageMenuItemClass}
              disabled={streaming}
              title={streaming ? "Branching is disabled while a response is streaming" : "Branch from here"}
              type="button"
              role="menuitem"
              onClick={() => runMenuAction(() => onBranchFromMessage(message.id))}
            >
              <GitBranch className="size-4 text-ink-muted" aria-hidden="true" />
              Branch from here
            </button>
          </div>,
          document.body
        ) : null}
      </div>
    </>
  );
}

function ThreadMessageRowComponent({
  answerModelLabel,
  artifactSummary,
  compactControls = false,
  editPending = false,
  justCompleted = false,
  message,
  mobileControlsOpen = false,
  onBranchFromMessage,
  onCopyMessage,
  onDeleteMessage,
  onEditMessage,
  onLoadPersistedRun,
  onOpenKnowledgeEvidence,
  onOpenMemorySourceChat,
  onOpenRunDetails,
  onRegenerateMessage,
  onToggleMobileControls,
  persistedRun = null,
  runActivity = null,
  runWarnings = [],
  showCitations,
  showReasoningBlocks,
  showToolActivity,
  streaming
}: {
  answerModelLabel: string | null;
  artifactSummary?: ThreadArtifactSummary | null;
  compactControls?: boolean;
  editPending?: boolean;
  justCompleted?: boolean;
  message: ThreadMessage;
  mobileControlsOpen?: boolean;
  onBranchFromMessage(messageId: string): void;
  onCopyMessage(message: ThreadMessage): void;
  onDeleteMessage(messageId: string): void;
  onEditMessage(message: ThreadMessage): void;
  onLoadPersistedRun?(runId: string): Promise<void> | void;
  onOpenKnowledgeEvidence?(knowledgeBaseId: string): void;
  onOpenMemorySourceChat(chatId: string): void;
  onOpenRunDetails(): void;
  onRegenerateMessage(messageId: string): void;
  onToggleMobileControls?(messageId: string): void;
  persistedRun?: PersistedRun | null;
  runActivity?: PipelineSnapshot | null;
  runWarnings?: string[];
  showCitations: boolean;
  showReasoningBlocks: boolean;
  showToolActivity: boolean;
  streaming: boolean;
}) {
  const disabledDescriptionId = `message-actions-disabled-${message.id}`;
  const compactControlsDescriptionId = `message-actions-disclosure-${message.id}`;
  const editPendingDescriptionId = `message-edit-pending-${message.id}`;
  const messageActionsId = `message-actions-${message.id}`;
  const targetDescriptionId = `message-actions-target-${message.id}`;
  const [runDetailsOpen, setRunDetailsOpen] = useState(false);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [expandedDisclosures, setExpandedDisclosures] = useState<ReadonlySet<InlineReceiptDisclosure>>(
    () => new Set()
  );
  const memorySettings = useMemorySettingsStore((state) => state.data);
  const memorySettingsLoadState = useMemorySettingsStore((state) => state.loadState);
  const hasMemoryProjection = Boolean(
    artifactSummary?.memoryAction || artifactSummary?.memoryReceipt
  );
  const memoryLocale = MEMORY_PRESENTATION_LOCALE;
  useEffect(() => {
    if (!hasMemoryProjection || memorySettings || memorySettingsLoadState === "loading") return;
    void refreshMemorySettings().catch(() => undefined);
  }, [hasMemoryProjection, memorySettings, memorySettingsLoadState]);
  const hasInlineSearch = Boolean(
    artifactSummary?.searchCount || artifactSummary?.searchActivity?.length
  ) &&
    runActivity?.search !== "active";
  const hasInlineTools = showToolActivity && Boolean(
    artifactSummary?.toolCalls.some((call) => call.capability === "mcp")
  );
  const hasInlineCitations = showCitations && Boolean(artifactSummary?.citationCount);
  const hasInlineKnowledge = message.status !== "streaming" &&
    Boolean(artifactSummary?.knowledgeInvocationCount);
  const memoryReceipt = message.status !== "streaming" &&
    visibleMemoryReceipt(artifactSummary?.memoryReceipt)
      ? artifactSummary?.memoryReceipt ?? null
      : null;
  const hasInlineMemory = Boolean(memoryReceipt && memoryLocale);
  const hasInlineReasoning = showReasoningBlocks && Boolean(artifactSummary?.reasoningCount);
  const exactTerminalPersistedRun = persistedRun &&
    persistedRun.id === message.runId &&
    persistedRun.status !== "in_progress" &&
    persistedRun.status !== "queued" &&
    persistedRun.status !== "streaming"
      ? persistedRun
      : null;
  const hasExactRunEvents = Boolean(
    message.runId &&
    exactTerminalPersistedRun?.events.length
  );
  function changeDisclosure(kind: InlineReceiptDisclosure, expanded: boolean) {
    setExpandedDisclosures((current) => {
      const next = new Set(current);
      if (expanded) {
        next.add(kind);
      } else {
        next.delete(kind);
      }
      return next;
    });
  }
  function changeKnowledgeDisclosure(expanded: boolean) {
    changeDisclosure("knowledge", expanded);
    if (
      !expanded ||
      !message.runId ||
      exactTerminalPersistedRun ||
      !onLoadPersistedRun ||
      knowledgeLoading
    ) return;
    setKnowledgeLoading(true);
    void Promise.resolve(onLoadPersistedRun(message.runId)).finally(() => setKnowledgeLoading(false));
  }
  function activateReceiptSegment(kind: RunReceiptSegmentKind) {
    if (kind === "search" && hasInlineSearch) {
      changeDisclosure("search", !expandedDisclosures.has("search"));
      return;
    }
    if (kind === "tools" && hasInlineTools) {
      changeDisclosure("tools", !expandedDisclosures.has("tools"));
      return;
    }
    if (kind === "knowledge" && hasInlineKnowledge) {
      changeKnowledgeDisclosure(!expandedDisclosures.has("knowledge"));
      return;
    }
    if (kind === "memory" && hasInlineMemory) {
      changeDisclosure("memory", !expandedDisclosures.has("memory"));
      return;
    }
    if (kind === "citations" && hasInlineCitations) {
      changeDisclosure("citations", !expandedDisclosures.has("citations"));
      return;
    }
    if (kind === "reasoning" && hasInlineReasoning) {
      changeDisclosure("reasoning", !expandedDisclosures.has("reasoning"));
      return;
    }
    if (hasExactRunEvents) {
      onOpenRunDetails();
    }
  }
  const actionTargetDescription = turnActionDescription(message);
  const compactControlsDescription = mobileControlsOpen
    ? "Message actions are shown. Press Escape to hide them."
    : "Message actions are hidden. Press Enter or Space to show them.";
  const actions = (
    <TurnActions
      disabledDescriptionId={disabledDescriptionId}
      editPending={editPending}
      editPendingDescriptionId={editPendingDescriptionId}
      message={message}
      streaming={streaming}
      onBranchFromMessage={onBranchFromMessage}
      onCopyMessage={onCopyMessage}
      onDeleteMessage={onDeleteMessage}
      onEditMessage={onEditMessage}
      onRegenerateMessage={onRegenerateMessage}
      onToggleRunDetails={() => setRunDetailsOpen((open) => !open)}
      runDetailsOpen={runDetailsOpen}
      targetDescriptionId={targetDescriptionId}
    />
  );
  const contentText = textFromThreadContent(message.content);
  const attachmentBlocks = message.role === "user" ? attachmentBlocksFromThreadContent(message.content) : [];
  const disabledDescription = streaming ? (
    <span className="sr-only" id={disabledDescriptionId}>
      Editing, deleting, branching, and regenerating are unavailable while a response is streaming.
    </span>
  ) : null;
  const editPendingDescription = editPending ? (
    <span className="sr-only" id={editPendingDescriptionId}>
      Another edited branch is saving. Wait for it to finish before editing a message.
    </span>
  ) : null;
  function handleMobileMessageClick(event: ReactMouseEvent<HTMLElement>) {
    if (
      !onToggleMobileControls ||
      !compactControls
    ) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Element) || !target.closest('[data-message-interaction-surface="true"]')) {
      return;
    }
    if (
      target.closest(
        "a, button, input, select, textarea, summary, [contenteditable='true'], [data-message-controls-surface='true'], [data-message-details-surface='true']"
      )
    ) {
      return;
    }

    onToggleMobileControls(message.id);
  }

  function handleMobileMessageKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (
      !onToggleMobileControls ||
      event.repeat ||
      event.target !== event.currentTarget ||
      !compactControls
    ) {
      return;
    }

    const shouldToggle = event.key === "Enter" || event.key === " ";
    const shouldClose = event.key === "Escape" && mobileControlsOpen;
    if (!shouldToggle && !shouldClose) {
      return;
    }

    event.preventDefault();
    onToggleMobileControls(message.id);
  }

  if (message.role === "user") {
    return (
      <article
        className="group/turn px-4 pb-7 pt-8 outline-none sm:px-6"
        data-mobile-controls-open={mobileControlsOpen ? "true" : undefined}
        data-message-id={message.id}
        data-role="user"
        data-status={message.status}
        aria-label="Question"
        aria-controls={compactControls ? messageActionsId : undefined}
        aria-describedby={compactControls ? compactControlsDescriptionId : undefined}
        aria-keyshortcuts={compactControls ? "Enter Space Escape" : undefined}
        tabIndex={0}
        onClick={handleMobileMessageClick}
        onKeyDown={handleMobileMessageKeyDown}
      >
        {compactControls ? (
          <span className="sr-only" id={compactControlsDescriptionId}>
            {compactControlsDescription}
          </span>
        ) : null}
        <div
          className="relative mx-auto w-full max-w-reading rounded-panel px-2 py-2"
          data-message-interaction-surface="true"
        >
          <div
            className="ml-auto w-fit max-w-[min(36rem,88%)] break-words rounded-panel bg-control-surface px-4 py-3 text-[15px] leading-6 text-ink [overflow-wrap:anywhere]"
            data-thread-message-content="true"
          >
            {contentText ? <MarkdownMessage content={contentText} /> : null}
            {attachmentBlocks.length > 0 ? (
              <ul
                className={contentText ? "mt-3 flex flex-wrap gap-1.5" : "flex flex-wrap gap-1.5"}
                aria-label="Message attachments"
              >
                {attachmentBlocks.map((attachment) => (
                  <li
                    className="inline-flex min-h-control-sm max-w-[min(15rem,100%)] items-center gap-1.5 rounded-control bg-control-pressed px-2 text-xs leading-4 text-ink-secondary"
                    key={`${attachment.type}-${attachment.attachmentId}`}
                    title={attachment.label}
                  >
                    {attachment.type === "image" ? (
                      <ImageIcon className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
                    ) : (
                      <FileText className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
                    )}
                    <span className="truncate">{attachment.label}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div
            className={actionStripClass}
            data-message-controls-kind="actions"
            data-message-controls-surface="true"
            data-testid="message-actions"
            id={messageActionsId}
            role="toolbar"
            aria-label="User message actions"
            aria-describedby={targetDescriptionId}
          >
            <span className="sr-only" id={targetDescriptionId}>
              {actionTargetDescription}
            </span>
            {disabledDescription}
            {editPendingDescription}
            {actions}
          </div>
        </div>
      </article>
    );
  }

  const receipt = deriveRunReceipt({
    artifactSummary,
    assistantIdentity: message.assistantIdentity ?? null,
    messageStatus: message.status,
    memoryFact: memoryReceipt && memoryLocale
      ? memoryReceiptFact(memoryReceipt, memoryLocale)
      : null,
    modelLabel: answerModelLabel,
    runActivity,
    runUsage: message.runUsage,
    warningCount: runWarnings.length
  });
  const actionableReceiptSegments = new Set<RunReceiptSegmentKind>();
  if (hasExactRunEvents) {
    actionableReceiptSegments.add("status");
    for (const fact of receipt.facts) {
      actionableReceiptSegments.add(fact.kind);
    }
  }
  if (hasInlineSearch) actionableReceiptSegments.add("search");
  if (hasInlineTools) actionableReceiptSegments.add("tools");
  if (hasInlineKnowledge) actionableReceiptSegments.add("knowledge");
  if (hasInlineMemory) actionableReceiptSegments.add("memory");
  if (hasInlineCitations) actionableReceiptSegments.add("citations");
  if (hasInlineReasoning) actionableReceiptSegments.add("reasoning");
  const disclosureReceiptSegments = new Set<RunReceiptSegmentKind>();
  if (hasInlineSearch) disclosureReceiptSegments.add("search");
  if (hasInlineTools) disclosureReceiptSegments.add("tools");
  if (hasInlineKnowledge) disclosureReceiptSegments.add("knowledge");
  if (hasInlineMemory) disclosureReceiptSegments.add("memory");
  if (hasInlineCitations) disclosureReceiptSegments.add("citations");
  if (hasInlineReasoning) disclosureReceiptSegments.add("reasoning");
  const expandedReceiptSegments = new Set<RunReceiptSegmentKind>(expandedDisclosures);

  return (
    <article
      className="group/turn px-4 pb-10 pt-2 outline-none sm:px-6 [@media(max-height:32rem)]:!pb-7"
      data-mobile-controls-open={mobileControlsOpen ? "true" : undefined}
      data-message-id={message.id}
      data-role="assistant"
      data-status={message.status}
      aria-label={message.assistantIdentity ? `Answer · ${message.assistantIdentity.name}` : "Answer"}
      aria-busy={message.status === "streaming" || undefined}
      aria-controls={compactControls ? messageActionsId : undefined}
      aria-describedby={compactControls ? compactControlsDescriptionId : undefined}
      aria-keyshortcuts={compactControls ? "Enter Space Escape" : undefined}
      tabIndex={0}
      onClick={handleMobileMessageClick}
      onKeyDown={handleMobileMessageKeyDown}
    >
      {compactControls ? (
        <span className="sr-only" id={compactControlsDescriptionId}>
          {compactControlsDescription}
        </span>
      ) : null}
      <div
        className="relative mx-auto w-full max-w-reading rounded-panel px-3 py-3 sm:px-4"
        data-message-interaction-surface="true"
      >
        {message.assistantIdentity ? (
          <div
            className="mb-3 flex min-w-0 items-center gap-1.5 text-xs leading-5 text-ink-muted"
            data-testid="answer-assistant-identity"
            title={`Answer · ${message.assistantIdentity.name}`}
          >
            <AssistantAvatar recipe={message.assistantIdentity.avatar} size={18} />
            <span className="truncate">{message.assistantIdentity.name}</span>
          </div>
        ) : null}
        {message.status === "streaming" && answerModelLabel ? (
          <div
            className="mb-3 truncate text-xs leading-5 text-ink-muted"
            title={answerModelLabel}
          >
            {answerModelLabel}
          </div>
        ) : null}
        {runActivity ? <ThreadRunActivity pipeline={runActivity} /> : null}
        <div
          className="min-w-0 text-[16px] leading-[1.68] text-ink sm:text-[17px]"
          data-thread-message-content="true"
          data-testid="assistant-message-content"
        >
          {artifactSummary?.contextTruncation ? <ContextTruncationBlock summary={artifactSummary} /> : null}

          {message.status === "error" ? (
            <div
              className="border-l-2 border-critical/45 bg-critical/[0.05] px-4 py-3 text-sm leading-6 text-ink-secondary"
              data-testid="assistant-error-state"
            >
              <div className="mb-1 flex items-center gap-2 font-semibold text-critical">
                <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
                Response failed
              </div>
              <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {contentText || "The provider did not return an answer."}
              </p>
              <button
                aria-describedby={streaming ? `${targetDescriptionId} ${disabledDescriptionId}` : targetDescriptionId}
                className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-control bg-proof px-3 text-sm font-semibold text-proof-contrast outline-none hover:bg-proof-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-answer-paper disabled:cursor-not-allowed disabled:bg-control-surface disabled:text-ink-disabled disabled:opacity-60 sm:min-h-9 [@media(hover:none)]:!min-h-11 [@media(pointer:coarse)]:!min-h-11"
                disabled={streaming}
                title={streaming ? "Retry is disabled while a response is streaming" : "Retry answer"}
                type="button"
                onClick={() => onRegenerateMessage(message.id)}
              >
                <RefreshCw className="size-3.5" aria-hidden="true" />
                Retry answer
              </button>
            </div>
          ) : (
            <>
              {contentText && !(message.status === "cancelled" && contentText === "Stopped.") ? (
                <MarkdownMessage content={contentText} streaming={message.status === "streaming"} />
              ) : null}
              {message.status === "streaming" && !contentText && !runActivity ? (
                <div
                  className="flex min-h-12 items-center gap-2 text-sm text-ink-secondary"
                  data-testid="assistant-pending-state"
                >
                  <span className="size-2 animate-pulse rounded-full bg-proof" aria-hidden="true" />
                  Working…
                </div>
              ) : null}
              {message.status === "streaming" && contentText ? (
                <span
                  className="ml-1 inline-block h-4 w-1 animate-pulse bg-proof align-[-2px]"
                  data-testid="streaming-cursor"
                  aria-hidden="true"
                />
              ) : null}
              {message.status === "cancelled" ? (
                <div
                  className={[
                    "flex items-center gap-2 text-xs text-ink-muted",
                    contentText && contentText !== "Stopped." ? "mt-3" : ""
                  ].join(" ")}
                  data-testid="assistant-cancelled-state"
                >
                  <Square className="size-3 fill-current" aria-hidden="true" />
                  Response stopped
                </div>
              ) : null}
              {message.status === "complete" && !contentText ? (
                <p className="text-sm italic text-ink-muted" data-testid="assistant-empty-state">
                  No answer text was returned.
                </p>
              ) : null}
            </>
          )}

          {hasInlineSearch && artifactSummary ? (
            <div className={contentText || message.status !== "streaming" ? "mt-5" : undefined}>
              <SearchSummaryBlock
                expanded={expandedDisclosures.has("search")}
                summary={artifactSummary}
                onExpandedChange={(expanded) => changeDisclosure("search", expanded)}
              />
            </div>
          ) : null}
          {message.status !== "streaming" && artifactSummary?.memoryAction && memoryLocale ? (
            <MemoryActionConfirmation action={artifactSummary.memoryAction} locale={memoryLocale} />
          ) : null}
          {artifactSummary?.groundingDisplay?.provider === "gemini" ? (
            <GeminiSearchSuggestions html={artifactSummary.groundingDisplay.suggestionsHtml} />
          ) : null}
          {hasInlineKnowledge && artifactSummary ? (
            <div className="mt-5">
              <KnowledgeEvidenceBlock
                expanded={expandedDisclosures.has("knowledge")}
                loading={knowledgeLoading}
                persistedRun={exactTerminalPersistedRun}
                showCitations={showCitations}
                summary={artifactSummary}
                onExpandedChange={changeKnowledgeDisclosure}
                onOpenEvidence={(knowledgeBaseId) => onOpenKnowledgeEvidence?.(knowledgeBaseId)}
              />
            </div>
          ) : null}
          {hasInlineTools && artifactSummary ? (
            <div className="mt-5">
              <ToolActivityBlock
                expanded={expandedDisclosures.has("tools")}
                summary={artifactSummary}
                onExpandedChange={(expanded) => changeDisclosure("tools", expanded)}
              />
            </div>
          ) : null}
          {message.status === "streaming" && showCitations && artifactSummary?.citationCount ? (
            <div className="mt-5">
              <CitationBlock
                expanded={expandedDisclosures.has("citations")}
                summary={artifactSummary}
                onExpandedChange={(expanded) => changeDisclosure("citations", expanded)}
              />
            </div>
          ) : null}
          {showReasoningBlocks && artifactSummary?.reasoningCount ? (
            <div className="mt-5">
              <ReasoningBlock
                expanded={expandedDisclosures.has("reasoning")}
                summary={artifactSummary}
                onExpandedChange={(expanded) => changeDisclosure("reasoning", expanded)}
              />
            </div>
          ) : null}
          {runWarnings.length > 0 ? (
            <aside
              className="mt-5 border-l-2 border-caution/45 bg-caution/[0.05] px-4 py-3 text-xs leading-5 text-ink-secondary"
              data-testid="thread-run-warnings"
              aria-label="Run warnings"
            >
              <div className="flex items-center gap-2 font-semibold text-caution">
                <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
                Run {runWarnings.length === 1 ? "warning" : "warnings"}
              </div>
              <ul className="mt-1 space-y-1 pl-5">
                {runWarnings.map((warning, index) => (
                  <li className="list-disc break-words [overflow-wrap:anywhere]" key={`${warning}-${index}`}>
                    {warning}
                  </li>
                ))}
              </ul>
            </aside>
          ) : null}
        </div>
        {message.status !== "streaming" && runDetailsOpen ? (
          <div
            className="fade-in-soft mt-5 border-y border-trace-subtle py-2.5"
            data-message-details-surface="true"
            data-testid="answer-metadata-block"
          >
            <RunReceipt
              actionableSegments={actionableReceiptSegments}
              contained
              disclosureSegments={disclosureReceiptSegments}
              expandedSegments={expandedReceiptSegments}
              receipt={receipt}
              settled={justCompleted}
              onActivate={activateReceiptSegment}
            />
            {hasInlineMemory && memoryReceipt && memoryLocale ? (
              <MemoryEvidenceBlock
                expanded={expandedDisclosures.has("memory")}
                locale={memoryLocale}
                receipt={memoryReceipt}
                onOpenSourceChat={onOpenMemorySourceChat}
                onExpandedChange={(expanded) => changeDisclosure("memory", expanded)}
              />
            ) : null}
            {hasInlineCitations && artifactSummary ? (
              <CitationBlock
                embedded
                expanded={expandedDisclosures.has("citations")}
                summary={artifactSummary}
                onExpandedChange={(expanded) => changeDisclosure("citations", expanded)}
              />
            ) : null}
          </div>
        ) : null}
        <div
          className={actionStripClass}
          data-message-controls-kind="actions"
          data-message-controls-surface="true"
          data-testid="message-actions"
          id={messageActionsId}
          role="toolbar"
          aria-label="Assistant message actions"
          aria-describedby={targetDescriptionId}
        >
          <span className="sr-only" id={targetDescriptionId}>
            {actionTargetDescription}
          </span>
          {disabledDescription}
          {editPendingDescription}
          {actions}
        </div>
      </div>
    </article>
  );
}

export const ThreadMessageRow = memo(ThreadMessageRowComponent);
