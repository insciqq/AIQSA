"use client";

import { useEffect, useRef } from "react";

/* Bar geometry in CSS pixels, and how much time one bar stands for. */
const BAR_WIDTH = 2;
const BAR_PITCH = 4;
const BAR_MIN_HEIGHT = 2;
const BAR_MAX_HEIGHT = 32;
const SLICE_MS = 64;
/* Reduced motion: a still cluster of 21 bars (about 84px) in the middle,
   redrawn about 6–7 times a second. */
const STILL_UPDATE_MS = 150;
const STILL_BARS = 21;
const STILL_EDGE = 0.25;

/** The still cluster's bell envelope: 1 in the middle, `STILL_EDGE` at both ends (a raised cosine). */
function stillEnvelope(index: number): number {
  const offset = (index - (STILL_BARS - 1) / 2) / ((STILL_BARS - 1) / 2);
  return STILL_EDGE + (1 - STILL_EDGE) * (0.5 + 0.5 * Math.cos(Math.PI * offset));
}

/**
 * The recording's voice wave over the message field's box. A still dotted
 * track in a muted text colour spans the whole width from the first frame, a
 * guide rather than a level, so the field never looks empty. Over it, in ink,
 * one thin bar per time slice with the peak measured level inside it, newest
 * at the right edge, travelling left; measured silence draws minimal ink
 * bars, and there is no bar without a measured sample. Under reduced motion a
 * wider centred cluster follows the current level in place instead. Both
 * colours are read from resolved `color` values so the theme decides.
 * Decorative: the dictation's `role="status"` text is the accessible signal.
 */
export function DictationWaveV2({ level }: Readonly<{ level(): number }>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const box = canvas?.parentElement;
    if (!canvas || !box || typeof requestAnimationFrame !== "function") return;
    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext("2d");
    } catch {
      context = null;
    }
    if (!context) return;
    const paint = context;
    const reducedMotion = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

    let bars: { at: number; level: number }[] = [];
    let sliceStart = performance.now();
    let slicePeak = 0;
    let still = 0;
    let stillAt = -Infinity;
    let stillPeak = 0;
    // Live declarations: a theme change shows on the next frame. The box
    // carries the track's muted colour, the canvas the ink (dictation.css).
    const inkStyle = getComputedStyle(canvas);
    const trackStyle = getComputedStyle(box);
    let ink = "";
    let track = "";
    let frame = 0;

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const value = level();
      const ratio = window.devicePixelRatio || 1;
      // The stylesheet sizes the canvas to the field's box; its backing store
      // follows that size and the device pixel ratio.
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const pixelWidth = Math.max(1, Math.round(width * ratio));
      const pixelHeight = Math.max(1, Math.round(height * ratio));
      const resized = canvas.width !== pixelWidth || canvas.height !== pixelHeight;
      if (resized) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      const nextInk = inkStyle.color;
      const nextTrack = trackStyle.color;
      const recoloured = nextInk !== ink || nextTrack !== track;
      ink = nextInk;
      track = nextTrack;
      const middle = height / 2;
      const tallest = Math.max(BAR_MIN_HEIGHT, Math.min(BAR_MAX_HEIGHT, height - 4));
      // Whole device pixels keep the thin bars crisp.
      const snap = (length: number) => Math.round(length * ratio) / ratio;
      const barHeight = (measured: number) => snap(Math.max(BAR_MIN_HEIGHT, measured * tallest));
      const right = width - BAR_WIDTH;
      const drawBar = (x: number, h: number) => paint.fillRect(snap(x), snap(middle - h / 2), BAR_WIDTH, h);
      const drawTrack = () => {
        paint.setTransform(ratio, 0, 0, ratio, 0, 0);
        paint.clearRect(0, 0, width, height);
        paint.fillStyle = track;
        for (let x = right; x > -BAR_WIDTH; x -= BAR_PITCH) drawBar(x, BAR_MIN_HEIGHT);
        paint.fillStyle = ink;
      };

      if (reducedMotion?.matches) {
        stillPeak = Math.max(stillPeak, value);
        if (now - stillAt >= STILL_UPDATE_MS) {
          still = stillPeak;
          stillPeak = 0;
          stillAt = now;
        } else if (!resized && !recoloured) {
          return;
        }
        bars = [];
        sliceStart = now;
        slicePeak = 0;
        drawTrack();
        // On the track's own dots, centred in the field.
        const first = right - Math.round((right - (width - (STILL_BARS - 1) * BAR_PITCH - BAR_WIDTH) / 2) / BAR_PITCH) * BAR_PITCH;
        for (let index = 0; index < STILL_BARS; index += 1) drawBar(first + index * BAR_PITCH, barHeight(still * stillEnvelope(index)));
        return;
      }

      slicePeak = Math.max(slicePeak, value);
      // A tab that was hidden resumes from now: the missed slices were never measured.
      if (now - sliceStart > SLICE_MS * 4) {
        sliceStart = now;
        slicePeak = value;
      } else if (now - sliceStart >= SLICE_MS) {
        sliceStart += SLICE_MS;
        bars.push({ at: sliceStart, level: slicePeak });
        slicePeak = 0;
      }
      drawTrack();
      for (let index = bars.length - 1; index >= 0; index -= 1) {
        const bar = bars[index]!;
        const x = right - ((now - bar.at) / SLICE_MS) * BAR_PITCH;
        if (x < -BAR_WIDTH) {
          bars = bars.slice(index + 1);
          break;
        }
        drawBar(x, barHeight(bar.level));
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [level]);

  return (
    <span className="v2-composer-dictation-wave" aria-hidden="true" data-testid="composer-dictation-wave">
      <canvas ref={canvasRef} />
    </span>
  );
}
