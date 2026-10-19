"use client";

import { useSyncExternalStore } from "react";

/**
 * How far the software keyboard (or other browser UI) covers the bottom of
 * the layout viewport, in CSS pixels. Android Chrome resizes the layout
 * itself (`interactive-widget=resizes-content`), so this stays 0 there; iOS
 * Safari overlays the keyboard and only the visual viewport shrinks.
 */
export function visualViewportInset(): number {
  if (typeof window === "undefined") return 0;
  const viewport = window.visualViewport;
  if (!viewport) return 0;
  const covered = window.innerHeight - (viewport.height + viewport.offsetTop);
  // Sub-pixel rounding and pinch zoom jitter are not a keyboard.
  return covered > 1 ? Math.round(covered) : 0;
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const viewport = window.visualViewport;
  viewport?.addEventListener("resize", onChange);
  viewport?.addEventListener("scroll", onChange);
  window.addEventListener("resize", onChange);
  window.addEventListener("orientationchange", onChange);
  return () => {
    viewport?.removeEventListener("resize", onChange);
    viewport?.removeEventListener("scroll", onChange);
    window.removeEventListener("resize", onChange);
    window.removeEventListener("orientationchange", onChange);
  };
}

const serverInset = () => 0;

/**
 * The bottom inset of `visualViewportInset`, kept current on visual viewport
 * resize and scroll, window resize and orientation change. Pad a full-height
 * layout by it so its bottom controls stay above an overlaid keyboard.
 */
export function useVisualViewportInset(): number {
  return useSyncExternalStore(subscribe, visualViewportInset, serverInset);
}
