import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const defaultPinnedThresholdPx = 96;
const defaultUnseenLatestThresholdPx = 48;
const defaultReadingContextMinPx = 96;
const defaultReadingContextMaxPx = 220;
const defaultReadingContextViewportRatio = 0.42;

type ScrollMetrics = Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">;
type LayoutObservation = {
  element: HTMLElement;
  content: Element | null;
  refresh(): void;
  release(): void;
};

const threadMessageSelector = "[data-message-id]";
const threadMessageContentSelector = "[data-thread-message-content]";
const readingSpacerSelector = "[data-thread-reading-spacer]";
const threadComposerDockSelector = "[data-thread-composer-dock]";
/** How long a toggled disclosure keeps its place while its content reflows. */
const toggleHoldMs = 600;

/**
 * Height of the docked composer overlapping the container's bottom edge (0
 * while the composer is in flow). The reading-anchor math works with the
 * visible height, so a question taller than the viewport still shows the
 * answer start above the composer (UX audit 2026-09-02 A3).
 */
function readingBottomInset(element: HTMLElement): number {
  const dock = element.ownerDocument.querySelector<HTMLElement>(threadComposerDockSelector);
  if (!dock) {
    return 0;
  }
  const containerBottom = element.getBoundingClientRect().bottom;
  const dockTop = dock.getBoundingClientRect().top;
  if (!Number.isFinite(containerBottom) || !Number.isFinite(dockTop)) {
    return 0;
  }
  return Math.max(0, containerBottom - dockTop);
}

function visibleReadingHeight(element: HTMLElement): number {
  return Math.max(0, element.clientHeight - readingBottomInset(element));
}

export function isPinnedToBottom(element: ScrollMetrics, thresholdPx = defaultPinnedThresholdPx): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= thresholdPx;
}

export function hasUnseenLatestMessageContent(
  element: HTMLElement,
  thresholdPx = defaultUnseenLatestThresholdPx
): boolean {
  const messages = element.querySelectorAll<HTMLElement>(threadMessageSelector);
  const latestMessage = messages.item(messages.length - 1);
  if (!latestMessage) {
    return false;
  }

  const containerBottom = element.getBoundingClientRect().bottom - readingBottomInset(element);
  const latestMessageContent = latestMessage.querySelector<HTMLElement>(threadMessageContentSelector);
  const latestMessageBottom = (latestMessageContent ?? latestMessage).getBoundingClientRect().bottom;
  return (
    Number.isFinite(containerBottom) &&
    Number.isFinite(latestMessageBottom) &&
    latestMessageBottom - containerBottom > thresholdPx
  );
}

export function usePinnedScroll<T extends HTMLElement>({
  followKey,
  hasContent = true,
  onReadingAnchorApplied,
  readingAnchorExplicit = false,
  readingAnchorKey = null,
  resetKey,
  thresholdPx = defaultPinnedThresholdPx
}: {
  followKey: unknown;
  hasContent?: boolean;
  /** Runs once the anchor's turn is in view, with that turn's element. */
  onReadingAnchorApplied?(anchorKey: string, target: HTMLElement): void;
  /**
   * The anchor is the reader's own request (a message link or a search
   * result): it scrolls even when the reader had moved away, unlike the
   * live answer's anchor, which never takes scroll ownership back.
   */
  readingAnchorExplicit?: boolean;
  readingAnchorKey?: string | null;
  resetKey: unknown;
  thresholdPx?: number;
}) {
  const containerRef = useRef<T | null>(null);
  const layoutObservationRef = useRef<LayoutObservation | null>(null);
  const [isPinned, setIsPinned] = useState(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const pinnedRef = useRef(true);
  const readingAnchorPendingRef = useRef(false);
  const readingAnchorActiveRef = useRef(false);
  const readingAnchorKeyRef = useRef<string | null>(null);
  /** The anchor the reading spacer is sized for; it outlives the stream. */
  const spacerAnchorKeyRef = useRef<string | null>(null);
  const toggleHoldRef = useRef<{ control: Element; top: number; until: number } | null>(null);
  /** The last scroll position the reader or this hook chose; a lower one at
   * the bottom edge is the browser clamping a shrunken thread. */
  const scrollTopRef = useRef(0);
  /** Bumped when the reader takes the scroll: a follow frame already
   * scheduled must not carry the thread to its end afterwards. */
  const followGenerationRef = useRef(0);
  const onReadingAnchorAppliedRef = useRef(onReadingAnchorApplied);
  const resetStateRef = useRef<{ initialized: boolean; value: unknown }>({
    initialized: false,
    value: undefined
  });
  const showJumpToLatestRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const visibilityRafRef = useRef<number | null>(null);
  const viewportRestoreRafRef = useRef<number | null>(null);
  const viewportRestoreResolveRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    onReadingAnchorAppliedRef.current = onReadingAnchorApplied;
  }, [onReadingAnchorApplied]);

  const setJumpToLatestState = useCallback((visible: boolean) => {
    showJumpToLatestRef.current = visible;
    setShowJumpToLatest((current) => (current === visible ? current : visible));
  }, []);

  const setPinnedState = useCallback((nextPinned: boolean) => {
    pinnedRef.current = nextPinned;
    setIsPinned((current) => (current === nextPinned ? current : nextPinned));
    if (nextPinned) {
      setJumpToLatestState(false);
    }
  }, [setJumpToLatestState]);

  const scheduleFrame = useCallback((callback: (element: T) => void) => {
    if (typeof window === "undefined") {
      return;
    }

    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
    }

    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      const element = containerRef.current;
      if (element) {
        callback(element);
      }
    });
  }, []);

  const writeScrollTop = useCallback((element: T, value: number) => {
    element.scrollTop = value;
    scrollTopRef.current = element.scrollTop;
  }, []);

  const scheduleJumpVisibility = useCallback((visible: boolean) => {
    showJumpToLatestRef.current = visible;
    if (typeof window === "undefined") {
      return;
    }
    if (visibilityRafRef.current !== null) {
      window.cancelAnimationFrame(visibilityRafRef.current);
    }
    visibilityRafRef.current = window.requestAnimationFrame(() => {
      visibilityRafRef.current = null;
      setJumpToLatestState(visible);
    });
  }, [setJumpToLatestState]);

  const updateReadingSpacer = useCallback((element: T, anchorKey: string) => {
    const messages = Array.from(element.querySelectorAll<HTMLElement>(threadMessageSelector));
    const target = messages.find(
      (candidate) => candidate.dataset.messageId === anchorKey
    );
    const spacer = element.querySelector<HTMLElement>(readingSpacerSelector);
    if (!target || !spacer) {
      return null;
    }

    const visibleHeight = visibleReadingHeight(element);
    const liveAnswer = messages.at(-1) ?? target;
    const liveAnswerHeight = Math.max(0, liveAnswer.getBoundingClientRect().height);
    const targetRect = target.getBoundingClientRect();
    const targetHeight = Math.max(0, targetRect.height);
    const preferredContext = Math.min(
      defaultReadingContextMaxPx,
      Math.max(
        defaultReadingContextMinPx,
        visibleHeight * defaultReadingContextViewportRatio
      )
    );
    const contextOffset = Math.min(
      preferredContext,
      Math.max(0, visibleHeight - targetHeight)
    );
    const targetViewportOffset =
      targetHeight > visibleHeight && liveAnswer !== target
        ? visibleHeight -
          targetHeight -
          Math.min(preferredContext, liveAnswerHeight)
        : contextOffset;

    // The spacer adds only the room this placement needs, so the bottom of
    // the thread is the anchored view itself: scrolling or following to the
    // end never shows a screen of blank space below a short answer.
    const containerTop = element.getBoundingClientRect().top;
    const anchorScrollTop = Math.max(0, element.scrollTop + targetRect.top - containerTop - targetViewportOffset);
    const spacerRect = spacer.getBoundingClientRect();
    const documentElement = spacer.parentElement !== element ? spacer.parentElement : null;
    const trailing = documentElement
      ? Math.max(0, documentElement.getBoundingClientRect().bottom - spacerRect.bottom)
      : 0;
    const extentWithoutSpacer = element.scrollTop + spacerRect.top - containerTop + trailing;
    spacer.style.height = `${Math.max(0, Math.ceil(anchorScrollTop + element.clientHeight - extentWithoutSpacer))}px`;
    spacerAnchorKeyRef.current = anchorKey;

    return { target, targetViewportOffset };
  }, []);

  const clearReadingSpacer = useCallback((element: T | null) => {
    spacerAnchorKeyRef.current = null;
    const spacer = element?.querySelector<HTMLElement>(readingSpacerSelector);
    if (spacer) spacer.style.height = "0px";
  }, []);

  /** Keeps a disclosure the reader just toggled where it was on screen. */
  const restoreToggledControl = useCallback((element: T) => {
    const hold = toggleHoldRef.current;
    if (!hold) return;
    if (!element.contains(hold.control) || performance.now() > hold.until) {
      toggleHoldRef.current = null;
      return;
    }
    const drift = hold.control.getBoundingClientRect().top - hold.top;
    if (Math.abs(drift) >= 1) writeScrollTop(element, element.scrollTop + drift);
  }, [writeScrollTop]);

  const scheduleReadingAnchor = useCallback((anchorKey: string) => {
    readingAnchorPendingRef.current = true;
    readingAnchorActiveRef.current = true;
    pinnedRef.current = false;
    showJumpToLatestRef.current = false;

    scheduleFrame((element) => {
      const anchor = updateReadingSpacer(element, anchorKey);
      if (!anchor) {
        readingAnchorPendingRef.current = false;
        return;
      }

      const containerTop = element.getBoundingClientRect().top;
      const targetTop = anchor.target.getBoundingClientRect().top;
      writeScrollTop(element, Math.max(
        0,
        element.scrollTop + targetTop - containerTop - anchor.targetViewportOffset
      ));
      readingAnchorPendingRef.current = false;
      setPinnedState(false);
      setJumpToLatestState(false);
      onReadingAnchorAppliedRef.current?.(anchorKey, anchor.target);
    });
  }, [scheduleFrame, setJumpToLatestState, setPinnedState, updateReadingSpacer, writeScrollTop]);

  const scheduleScrollToBottom = useCallback(() => {
    readingAnchorPendingRef.current = false;
    readingAnchorActiveRef.current = false;
    pinnedRef.current = true;
    showJumpToLatestRef.current = false;
    const followGeneration = followGenerationRef.current;
    scheduleFrame((element) => {
      if (followGeneration !== followGenerationRef.current) return;
      writeScrollTop(element, element.scrollHeight);
      setPinnedState(true);
    });
  }, [scheduleFrame, setPinnedState, writeScrollTop]);

  const scheduleScrollToTop = useCallback(() => {
    readingAnchorPendingRef.current = false;
    readingAnchorActiveRef.current = false;
    readingAnchorKeyRef.current = null;
    pinnedRef.current = true;
    showJumpToLatestRef.current = false;
    scheduleFrame((element) => {
      writeScrollTop(element, 0);
      setPinnedState(true);
    });
  }, [scheduleFrame, setPinnedState, writeScrollTop]);

  const preserveViewportWhile = useCallback(async <Result>(
    operation: () => Promise<Result>,
    shouldRestore: () => boolean = () => true
  ): Promise<Result> => {
    const element = containerRef.current;
    if (!element) {
      return operation();
    }

    const containerTop = element.getBoundingClientRect().top;
    const visibleAnchor = Array.from(
      element.querySelectorAll<HTMLElement>(threadMessageSelector)
    ).find((candidate) => candidate.getBoundingClientRect().bottom > containerTop);
    const anchorId = visibleAnchor?.dataset.messageId ?? null;
    const anchorOffset = visibleAnchor
      ? visibleAnchor.getBoundingClientRect().top - containerTop
      : null;
    const previousScrollHeight = element.scrollHeight;
    const previousScrollTop = element.scrollTop;

    readingAnchorPendingRef.current = true;
    readingAnchorActiveRef.current = false;
    pinnedRef.current = false;
    setPinnedState(false);

    let result: Result;
    try {
      result = await operation();
    } finally {
      await new Promise<void>((resolve) => {
        if (viewportRestoreRafRef.current !== null) {
          window.cancelAnimationFrame(viewportRestoreRafRef.current);
          viewportRestoreResolveRef.current?.();
        }
        viewportRestoreResolveRef.current = resolve;
        viewportRestoreRafRef.current = window.requestAnimationFrame(() => {
          viewportRestoreRafRef.current = null;
          viewportRestoreResolveRef.current = null;
          const current = shouldRestore() ? containerRef.current : null;
          if (current) {
            const anchor = anchorId
              ? Array.from(
                  current.querySelectorAll<HTMLElement>(threadMessageSelector)
                ).find((candidate) => candidate.dataset.messageId === anchorId)
              : null;
            if (anchor && anchorOffset !== null) {
              const currentTop = current.getBoundingClientRect().top;
              writeScrollTop(current, current.scrollTop +
                anchor.getBoundingClientRect().top - currentTop - anchorOffset);
            } else {
              writeScrollTop(current, Math.max(
                0,
                previousScrollTop + current.scrollHeight - previousScrollHeight
              ));
            }
            scheduleJumpVisibility(hasUnseenLatestMessageContent(current));
          }
          readingAnchorPendingRef.current = false;
          resolve();
        });
      });
    }
    return result;
  }, [scheduleJumpVisibility, setPinnedState, writeScrollTop]);

  const handleScroll = useCallback(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }
    scrollTopRef.current = element.scrollTop;

    if (!hasContent) {
      // The blank thread starts at its greeting, but its in-flow composer
      // may extend below a short viewport. Keep manual/focus scrolling usable.
      setPinnedState(true);
      return;
    }

    const nextPinned = isPinnedToBottom(element, thresholdPx);
    if (readingAnchorPendingRef.current) {
      setPinnedState(false);
      setJumpToLatestState(false);
      return;
    }
    if (nextPinned && (!readingAnchorActiveRef.current || showJumpToLatestRef.current)) {
      readingAnchorActiveRef.current = false;
      setPinnedState(true);
      return;
    }

    setPinnedState(false);
    setJumpToLatestState(hasUnseenLatestMessageContent(element));
  }, [hasContent, setJumpToLatestState, setPinnedState, thresholdPx]);

  useLayoutEffect(() => {
    if (!hasContent) {
      scheduleScrollToTop();
      return;
    }

    const resetState = resetStateRef.current;
    if (resetState.initialized && Object.is(resetState.value, resetKey)) {
      return;
    }
    resetState.initialized = true;
    resetState.value = resetKey;
    // Another chat (or the first view) never inherits the room a previous
    // live answer needed.
    clearReadingSpacer(containerRef.current);
    toggleHoldRef.current = null;
    readingAnchorKeyRef.current = readingAnchorKey;
    if (readingAnchorKey) {
      pinnedRef.current = true;
      scheduleReadingAnchor(readingAnchorKey);
    } else {
      scheduleScrollToBottom();
    }
  }, [clearReadingSpacer, hasContent, readingAnchorKey, resetKey, scheduleReadingAnchor, scheduleScrollToBottom,
    scheduleScrollToTop]);

  useLayoutEffect(() => {
    if (!hasContent) {
      readingAnchorKeyRef.current = null;
      return;
    }
    if (!readingAnchorKey) {
      readingAnchorKeyRef.current = null;
      return;
    }
    const previousAnchorKey = readingAnchorKeyRef.current;
    if (previousAnchorKey === readingAnchorKey) {
      return;
    }

    readingAnchorKeyRef.current = readingAnchorKey;
    if (
      readingAnchorExplicit ||
      pinnedRef.current ||
      (previousAnchorKey !== null &&
        (readingAnchorPendingRef.current || readingAnchorActiveRef.current))
    ) {
      scheduleReadingAnchor(readingAnchorKey);
    }
  }, [hasContent, readingAnchorExplicit, readingAnchorKey, scheduleReadingAnchor]);

  const holdToggledControl = useCallback((event: Event) => {
    const element = containerRef.current;
    const control = event.target instanceof Element ? event.target.closest("summary") : null;
    if (!element || !control || !element.contains(control) || !control.closest(threadMessageSelector)) {
      return;
    }
    // The reader opened or closed part of an answer: following the tail
    // would carry the control away, so the reader owns the scroll from here
    // and the control stays where it was while its content reflows.
    followGenerationRef.current += 1;
    pinnedRef.current = false;
    setPinnedState(false);
    toggleHoldRef.current = {
      control,
      top: control.getBoundingClientRect().top,
      until: performance.now() + toggleHoldMs
    };
    window.requestAnimationFrame(() => {
      const current = containerRef.current;
      if (!current) return;
      restoreToggledControl(current);
      scheduleJumpVisibility(hasUnseenLatestMessageContent(current));
    });
  }, [restoreToggledControl, scheduleJumpVisibility, setPinnedState]);

  const releaseToggledControl = useCallback(() => {
    toggleHoldRef.current = null;
  }, []);

  const refreshLayout = useCallback(function refreshLayout() {
    const element = containerRef.current;
    if (!hasContent || !element) {
      layoutObservationRef.current?.release();
      layoutObservationRef.current = null;
      spacerAnchorKeyRef.current = null;
      return;
    }

    const content = element.querySelector(".v2-conversation-document");
    const previous = layoutObservationRef.current;
    if (typeof ResizeObserver !== "undefined" && (!previous || previous.element !== element ||
      previous.content !== content || previous.refresh !== refreshLayout)) {
      previous?.release();
      const observer = new ResizeObserver(() => {
        if (layoutObservationRef.current === observation) refreshLayout();
      });
      const observation: LayoutObservation = {
        element, content, refresh: refreshLayout,
        release() {
          observer.disconnect();
          element.removeEventListener("click", holdToggledControl, true);
          element.removeEventListener("wheel", releaseToggledControl);
          element.removeEventListener("touchstart", releaseToggledControl);
        }
      };
      layoutObservationRef.current = observation;
      observer.observe(element, { box: "border-box" });
      if (content) observer.observe(content, { box: "border-box" });
      // Capture: the native <details> toggles after the click's listeners.
      element.addEventListener("click", holdToggledControl, true);
      // Scrolling by hand ends the hold at once.
      element.addEventListener("wheel", releaseToggledControl, { passive: true });
      element.addEventListener("touchstart", releaseToggledControl, { passive: true });
    }

    // Content that shrank under a reader at the bottom edge (a disclosure
    // closing, a live line giving way to a shorter settled one) was clamped
    // by the browser before the spacer could give the room back; returning
    // to the reader's position happens before paint, so nothing jumps.
    const clampedFrom = !pinnedRef.current && !readingAnchorPendingRef.current &&
      element.scrollTop < scrollTopRef.current - 0.5 &&
      element.scrollTop >= element.scrollHeight - element.clientHeight - 0.5
      ? scrollTopRef.current
      : null;
    // The settled answer keeps the room its live answer was given, resized to
    // its final height, until the reader opens another chat or the anchor
    // turn leaves the thread (an edit or a branch switch).
    if (readingAnchorKey) {
      updateReadingSpacer(element, readingAnchorKey);
    } else if (spacerAnchorKeyRef.current && !updateReadingSpacer(element, spacerAnchorKeyRef.current)) {
      clearReadingSpacer(element);
    }
    if (clampedFrom !== null) writeScrollTop(element, clampedFrom);

    if (pinnedRef.current) {
      scheduleScrollToBottom();
    } else if (!readingAnchorPendingRef.current) {
      restoreToggledControl(element);
      scheduleJumpVisibility(hasUnseenLatestMessageContent(element));
    }
  }, [clearReadingSpacer, hasContent, holdToggledControl, readingAnchorKey, releaseToggledControl, restoreToggledControl,
    scheduleJumpVisibility, scheduleScrollToBottom, updateReadingSpacer, writeScrollTop]);

  useLayoutEffect(() => {
    refreshLayout();
  }, [followKey, refreshLayout, thresholdPx]);

  useEffect(() => {
    return () => {
      layoutObservationRef.current?.release();
      layoutObservationRef.current = null;
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
      }
      if (visibilityRafRef.current !== null) {
        window.cancelAnimationFrame(visibilityRafRef.current);
      }
      if (viewportRestoreRafRef.current !== null) {
        window.cancelAnimationFrame(viewportRestoreRafRef.current);
        viewportRestoreResolveRef.current?.();
        viewportRestoreResolveRef.current = null;
      }
    };
  }, []);

  return {
    containerRef,
    handleScroll,
    isPinned,
    jumpToLatest: scheduleScrollToBottom,
    preserveViewportWhile,
    refreshLayout,
    resetToLatest: scheduleScrollToBottom,
    showJumpToLatest
  };
}
