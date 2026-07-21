import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compactComposerReadingMediaQuery,
  useCompactComposerReadingMode
} from "./useCompactComposerReadingMode";

function installCompactViewport(initialMatches = true) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    addEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    get matches() {
      return matches;
    },
    media: compactComposerReadingMediaQuery,
    removeEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    }
  } as MediaQueryList;
  const matchMedia = vi.fn(() => media);
  vi.stubGlobal("matchMedia", matchMedia);

  return {
    matchMedia,
    setMatches(nextMatches: boolean) {
      matches = nextMatches;
      const event = { matches, media: compactComposerReadingMediaQuery } as MediaQueryListEvent;
      for (const listener of listeners) {
        listener(event);
      }
    }
  };
}

function scrollTop(value: number): Pick<HTMLElement, "scrollTop"> {
  return { scrollTop: value };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useCompactComposerReadingMode", () => {
  it("collapses after consecutive deliberate scrolling in either direction and resets on reversal", () => {
    installCompactViewport();
    const { result } = renderHook(() =>
      useCompactComposerReadingMode({ forceExpanded: false, resetKey: "chat:one" })
    );

    act(() => result.current.handleScroll(scrollTop(60)));
    act(() => result.current.handleScroll(scrollTop(120)));
    expect(result.current.collapsed).toBe(false);

    act(() => result.current.noteScrollIntent());
    act(() => result.current.handleScroll(scrollTop(120)));
    act(() => result.current.handleScroll(scrollTop(150)));
    expect(result.current.collapsed).toBe(false);

    act(() => result.current.handleScroll(scrollTop(145)));
    act(() => result.current.handleScroll(scrollTop(170)));
    expect(result.current.collapsed).toBe(false);

    act(() => result.current.handleScroll(scrollTop(195)));
    expect(result.current.collapsed).toBe(true);

    act(() => result.current.expand());
    act(() => result.current.noteScrollIntent());
    act(() => result.current.handleScroll(scrollTop(220)));
    act(() => result.current.handleScroll(scrollTop(190)));
    expect(result.current.collapsed).toBe(false);
    act(() => result.current.handleScroll(scrollTop(160)));
    expect(result.current.collapsed).toBe(true);
  });

  it("expands for a hard composition condition, focus request, and session reset", () => {
    installCompactViewport();
    const { result, rerender } = renderHook(
      ({ forceExpanded, resetKey }) =>
        useCompactComposerReadingMode({ forceExpanded, resetKey }),
      { initialProps: { forceExpanded: false, resetKey: "chat:one" } }
    );

    act(() => result.current.noteScrollIntent());
    act(() => result.current.handleScroll(scrollTop(100)));
    act(() => result.current.handleScroll(scrollTop(160)));
    expect(result.current.collapsed).toBe(true);

    rerender({ forceExpanded: true, resetKey: "chat:one" });
    expect(result.current.collapsed).toBe(false);

    rerender({ forceExpanded: false, resetKey: "chat:one" });
    act(() => result.current.noteScrollIntent());
    act(() => result.current.handleScroll(scrollTop(100)));
    act(() => result.current.handleScroll(scrollTop(160)));
    expect(result.current.collapsed).toBe(true);

    act(() => result.current.expand());
    expect(result.current.collapsed).toBe(false);

    act(() => result.current.noteScrollIntent());
    act(() => result.current.handleScroll(scrollTop(100)));
    act(() => result.current.handleScroll(scrollTop(160)));
    expect(result.current.collapsed).toBe(true);

    rerender({ forceExpanded: false, resetKey: "chat:two" });
    expect(result.current.collapsed).toBe(false);
  });

  it("never collapses outside compact composition and expands on a viewport change", () => {
    const viewport = installCompactViewport(false);
    const { result } = renderHook(() =>
      useCompactComposerReadingMode({ forceExpanded: false, resetKey: "chat:one" })
    );

    expect(viewport.matchMedia).toHaveBeenCalledWith(compactComposerReadingMediaQuery);
    act(() => result.current.handleScroll(scrollTop(100)));
    act(() => result.current.handleScroll(scrollTop(200)));
    expect(result.current.collapsed).toBe(false);

    act(() => viewport.setMatches(true));
    act(() => result.current.noteScrollIntent());
    act(() => result.current.handleScroll(scrollTop(100)));
    act(() => result.current.handleScroll(scrollTop(160)));
    expect(result.current.collapsed).toBe(true);

    act(() => viewport.setMatches(false));
    expect(result.current.collapsed).toBe(false);
  });
});
