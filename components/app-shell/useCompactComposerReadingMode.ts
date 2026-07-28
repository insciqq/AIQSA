import { useCallback, useEffect, useRef, useState } from "react";

export const compactComposerReadingMediaQuery =
  "(max-width: 639px), (max-height: 32rem)";
export const compactComposerCollapseDistancePx = 48;
export const compactComposerScrollIntentWindowMs = 1_200;

type ScrollPosition = Pick<HTMLElement, "scrollTop">;
type ReadingState = {
  collapsed: boolean;
  compact: boolean;
  forceExpanded: boolean;
  resetKey: unknown;
};

function currentCompactMatch(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(compactComposerReadingMediaQuery).matches
    : false;
}

export function useCompactComposerReadingMode({
  forceExpanded,
  resetKey,
  thresholdPx = compactComposerCollapseDistancePx
}: {
  forceExpanded: boolean;
  resetKey: unknown;
  thresholdPx?: number;
}) {
  const [compact, setCompact] = useState(currentCompactMatch);
  const [readingState, setReadingState] = useState<ReadingState>(() => ({
    collapsed: false,
    compact,
    forceExpanded,
    resetKey
  }));
  const consecutiveDirectionalDistanceRef = useRef(0);
  const lastScrollTopRef = useRef<number | null>(null);
  const scrollDirectionRef = useRef<-1 | 0 | 1>(0);
  const scrollIntentExpiresAtRef = useRef(0);
  const stateMatchesInputs =
    readingState.compact === compact &&
    readingState.forceExpanded === forceExpanded &&
    Object.is(readingState.resetKey, resetKey);

  if (!stateMatchesInputs) {
    setReadingState({
      collapsed: false,
      compact,
      forceExpanded,
      resetKey
    });
  }

  const resetGesture = useCallback(() => {
    consecutiveDirectionalDistanceRef.current = 0;
    lastScrollTopRef.current = null;
    scrollDirectionRef.current = 0;
    scrollIntentExpiresAtRef.current = 0;
  }, []);

  const expand = useCallback(() => {
    resetGesture();
    setReadingState((current) =>
      current.collapsed ? { ...current, collapsed: false } : current
    );
  }, [resetGesture]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }

    const media = window.matchMedia(compactComposerReadingMediaQuery);

    function handleChange(event: MediaQueryListEvent) {
      setCompact(event.matches);
      if (!event.matches) {
        expand();
      } else {
        resetGesture();
      }
    }

    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [expand, resetGesture]);

  useEffect(() => {
    resetGesture();
  }, [compact, forceExpanded, resetGesture, resetKey]);

  const collapsedState = stateMatchesInputs && readingState.collapsed;

  const noteScrollIntent = useCallback(() => {
    if (!compact || forceExpanded) {
      return;
    }
    scrollIntentExpiresAtRef.current = Date.now() + compactComposerScrollIntentWindowMs;
  }, [compact, forceExpanded]);

  const handleScroll = useCallback(
    (element: ScrollPosition) => {
      const nextScrollTop = Math.max(0, element.scrollTop);
      const previousScrollTop = lastScrollTopRef.current;
      lastScrollTopRef.current = nextScrollTop;

      const hasRecentScrollIntent = scrollIntentExpiresAtRef.current >= Date.now();
      if (
        !compact ||
        forceExpanded ||
        collapsedState ||
        !hasRecentScrollIntent ||
        previousScrollTop === null
      ) {
        consecutiveDirectionalDistanceRef.current = 0;
        scrollDirectionRef.current = 0;
        return;
      }

      const delta = nextScrollTop - previousScrollTop;
      if (delta === 0) {
        return;
      }

      const direction = delta > 0 ? 1 : -1;
      if (scrollDirectionRef.current !== direction) {
        consecutiveDirectionalDistanceRef.current = 0;
        scrollDirectionRef.current = direction;
      }

      consecutiveDirectionalDistanceRef.current += Math.abs(delta);
      if (consecutiveDirectionalDistanceRef.current >= thresholdPx) {
        consecutiveDirectionalDistanceRef.current = 0;
        scrollDirectionRef.current = 0;
        setReadingState({
          collapsed: true,
          compact,
          forceExpanded,
          resetKey
        });
      }
    },
    [collapsedState, compact, forceExpanded, resetKey, thresholdPx]
  );

  return {
    collapsed: compact && !forceExpanded && collapsedState,
    expand,
    handleScroll,
    noteScrollIntent
  };
}
