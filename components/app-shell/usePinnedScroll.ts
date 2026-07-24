import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const defaultPinnedThresholdPx = 96;
const defaultUnseenLatestThresholdPx = 48;

type ScrollMetrics = Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">;

const threadMessageSelector = "[data-message-id]";
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
  const latestMessageBottom = latestMessage.getBoundingClientRect().bottom;
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
  const readingAnswerRef = useRef(false);
  const readingAnchorPresentRef = useRef(false);
  const resetStateRef = useRef<{ initialized: boolean; value: unknown }>({
    initialized: false,
    value: undefined
  });
  const showJumpToLatestRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const visibilityRafRef = useRef<number | null>(null);

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
    const target = Array.from(element.querySelectorAll<HTMLElement>(threadMessageSelector)).find(
      (candidate) => candidate.dataset.messageId === anchorKey
    );
    const spacer = element.querySelector<HTMLElement>(readingSpacerSelector);
    if (!target || !spacer) {
      return null;
    }

    const targetHeight = target.getBoundingClientRect().height;
    spacer.style.height = `${Math.max(0, element.clientHeight - targetHeight)}px`;
    return target;
  }, []);

  const scheduleAnswerStart = useCallback((anchorKey: string) => {
    readingAnchorPendingRef.current = true;
    readingAnswerRef.current = true;
    pinnedRef.current = false;
    showJumpToLatestRef.current = false;

    scheduleFrame((element) => {
      const target = updateReadingSpacer(element, anchorKey);
      if (!target) {
        readingAnchorPendingRef.current = false;
        return;
      }

      const containerTop = element.getBoundingClientRect().top;
      const targetTop = target.getBoundingClientRect().top;
      element.scrollTop += targetTop - containerTop;
      readingAnchorPendingRef.current = false;
      setPinnedState(false);
      setJumpToLatestState(false);
    });
  }, [scheduleFrame, setJumpToLatestState, setPinnedState, updateReadingSpacer]);

  const scheduleScrollToBottom = useCallback(() => {
    readingAnchorPendingRef.current = false;
    readingAnswerRef.current = false;
    pinnedRef.current = true;
    showJumpToLatestRef.current = false;
    scheduleFrame((element) => {
      element.scrollTop = element.scrollHeight;
      setPinnedState(true);
    });
  }, [scheduleFrame, setPinnedState]);

  const scheduleScrollToTop = useCallback(() => {
    readingAnchorPendingRef.current = false;
    readingAnswerRef.current = false;
    readingAnchorPresentRef.current = false;
    pinnedRef.current = true;
    showJumpToLatestRef.current = false;
    scheduleFrame((element) => {
      element.scrollTop = 0;
      setPinnedState(true);
    });
  }, [scheduleFrame, setPinnedState]);

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
    if (nextPinned && (!readingAnswerRef.current || showJumpToLatestRef.current)) {
      readingAnswerRef.current = false;
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
      scheduleAnswerStart(readingAnchorKey);
    } else {
      scheduleScrollToBottom();
    }
  }, [hasContent, readingAnchorKey, resetKey, scheduleAnswerStart, scheduleScrollToBottom, scheduleScrollToTop]);

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
      scheduleAnswerStart(readingAnchorKey);
    }
  }, [hasContent, readingAnchorKey, scheduleAnswerStart]);

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
    };
  }, []);

  return {
    containerRef,
    handleScroll,
    isPinned,
    jumpToLatest: scheduleScrollToBottom,
    resetToLatest: scheduleScrollToBottom,
    showJumpToLatest
  };
}
