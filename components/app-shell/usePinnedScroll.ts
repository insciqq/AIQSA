import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const defaultPinnedThresholdPx = 96;
const defaultUnseenLatestThresholdPx = 48;
const defaultReadingContextMinPx = 96;
const defaultReadingContextMaxPx = 220;
const defaultReadingContextViewportRatio = 0.42;

type ScrollMetrics = Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">;

const threadMessageSelector = "[data-message-id]";
const threadMessageContentSelector = "[data-thread-message-content]";
const readingSpacerSelector = "[data-thread-reading-spacer]";

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

  const containerBottom = element.getBoundingClientRect().bottom;
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
  readingAnchorKey = null,
  resetKey,
  thresholdPx = defaultPinnedThresholdPx
}: {
  followKey: unknown;
  hasContent?: boolean;
  readingAnchorKey?: string | null;
  resetKey: unknown;
  thresholdPx?: number;
}) {
  const containerRef = useRef<T | null>(null);
  const [isPinned, setIsPinned] = useState(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const pinnedRef = useRef(true);
  const readingAnchorPendingRef = useRef(false);
  const readingAnchorActiveRef = useRef(false);
  const readingAnchorPresentRef = useRef(false);
  const resetStateRef = useRef<{ initialized: boolean; value: unknown }>({
    initialized: false,
    value: undefined
  });
  const showJumpToLatestRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const visibilityRafRef = useRef<number | null>(null);
  const viewportRestoreRafRef = useRef<number | null>(null);
  const viewportRestoreResolveRef = useRef<(() => void) | null>(null);

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

    const liveAnswer = messages.at(-1) ?? target;
    const liveAnswerHeight = Math.max(0, liveAnswer.getBoundingClientRect().height);
    spacer.style.height = `${Math.max(0, element.clientHeight - liveAnswerHeight)}px`;

    const targetHeight = Math.max(0, target.getBoundingClientRect().height);
    const preferredContext = Math.min(
      defaultReadingContextMaxPx,
      Math.max(
        defaultReadingContextMinPx,
        element.clientHeight * defaultReadingContextViewportRatio
      )
    );
    const contextOffset = Math.min(
      preferredContext,
      Math.max(0, element.clientHeight - targetHeight)
    );
    const targetViewportOffset =
      targetHeight > element.clientHeight && liveAnswer !== target
        ? element.clientHeight -
          targetHeight -
          Math.min(preferredContext, liveAnswerHeight)
        : contextOffset;

    return { target, targetViewportOffset };
  }, []);

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
      element.scrollTop = Math.max(
        0,
        element.scrollTop + targetTop - containerTop - anchor.targetViewportOffset
      );
      readingAnchorPendingRef.current = false;
      setPinnedState(false);
      setJumpToLatestState(false);
    });
  }, [scheduleFrame, setJumpToLatestState, setPinnedState, updateReadingSpacer]);

  const scheduleScrollToBottom = useCallback(() => {
    readingAnchorPendingRef.current = false;
    readingAnchorActiveRef.current = false;
    pinnedRef.current = true;
    showJumpToLatestRef.current = false;
    scheduleFrame((element) => {
      element.scrollTop = element.scrollHeight;
      setPinnedState(true);
    });
  }, [scheduleFrame, setPinnedState]);

  const scheduleScrollToTop = useCallback(() => {
    readingAnchorPendingRef.current = false;
    readingAnchorActiveRef.current = false;
    readingAnchorPresentRef.current = false;
    pinnedRef.current = true;
    showJumpToLatestRef.current = false;
    scheduleFrame((element) => {
      element.scrollTop = 0;
      setPinnedState(true);
    });
  }, [scheduleFrame, setPinnedState]);

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
              current.scrollTop +=
                anchor.getBoundingClientRect().top - currentTop - anchorOffset;
            } else {
              current.scrollTop = Math.max(
                0,
                previousScrollTop + current.scrollHeight - previousScrollHeight
              );
            }
            scheduleJumpVisibility(hasUnseenLatestMessageContent(current));
          }
          readingAnchorPendingRef.current = false;
          resolve();
        });
      });
    }
    return result;
  }, [scheduleJumpVisibility, setPinnedState]);

  const handleScroll = useCallback(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    if (!hasContent) {
      if (element.scrollTop !== 0) {
        element.scrollTop = 0;
      }
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
    readingAnchorPresentRef.current = Boolean(readingAnchorKey);
    if (readingAnchorKey) {
      pinnedRef.current = true;
      scheduleReadingAnchor(readingAnchorKey);
    } else {
      scheduleScrollToBottom();
    }
  }, [hasContent, readingAnchorKey, resetKey, scheduleReadingAnchor, scheduleScrollToBottom, scheduleScrollToTop]);

  useLayoutEffect(() => {
    if (!hasContent) {
      readingAnchorPresentRef.current = false;
      return;
    }
    if (!readingAnchorKey) {
      readingAnchorPresentRef.current = false;
      return;
    }
    if (readingAnchorPresentRef.current) {
      return;
    }

    readingAnchorPresentRef.current = true;
    if (pinnedRef.current) {
      scheduleReadingAnchor(readingAnchorKey);
    }
  }, [hasContent, readingAnchorKey, scheduleReadingAnchor]);

  useLayoutEffect(() => {
    if (!hasContent) {
      return;
    }

    const element = containerRef.current;
    if (!element) {
      return;
    }

    if (readingAnchorKey) {
      updateReadingSpacer(element, readingAnchorKey);
    }

    if (pinnedRef.current) {
      scheduleScrollToBottom();
    } else if (!readingAnchorPendingRef.current) {
      scheduleJumpVisibility(hasUnseenLatestMessageContent(element));
    }
  }, [followKey, hasContent, readingAnchorKey, scheduleJumpVisibility, scheduleScrollToBottom, thresholdPx, updateReadingSpacer]);

  useEffect(() => {
    return () => {
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
    resetToLatest: scheduleScrollToBottom,
    showJumpToLatest
  };
}
