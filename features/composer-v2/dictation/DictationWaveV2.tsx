"use client";

import { useEffect, useRef } from "react";

/* Bar geometry in CSS pixels, and how much time one bar stands for. */
const BAR_WIDTH = 2;
const BAR_PITCH = 4;
const BAR_MIN_HEIGHT = 2;
const BAR_MAX_HEIGHT = 32;
const SLICE_MS = 64;
/* Reduced motion: a still cluster in the middle, redrawn about 6–7 times a second. */
const STILL_UPDATE_MS = 150;
const STILL_SHAPE = [0.45, 0.7, 1, 0.7, 0.45] as const;

/**
 * The recording's voice wave over the message field's box: one thin bar per
 * time slice with the peak measured level inside it, newest at the right
 * edge, travelling left. Silence draws minimal bars; there is no bar without
 * a measured sample. Under reduced motion a short centred cluster follows
 * the current level in place instead. Ink colour only, read from the
 * resolved `color` so the theme decides. Decorative: the dictation's
 * `role="status"` text is the accessible signal.
 */
export function DictationWaveV2({ level }: Readonly<{ level(): number }>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof requestAnimationFrame !== "function") return;
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
    const style = getComputedStyle(canvas);
    let colour = "";
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
      // A live declaration: a theme change shows on the next frame.
      const nextColour = style.color;
      const recoloured = nextColour !== colour;
      colour = nextColour;
      const middle = height / 2;
      const tallest = Math.max(BAR_MIN_HEIGHT, Math.min(BAR_MAX_HEIGHT, height - 4));
      // Whole device pixels keep the thin bars crisp.
      const snap = (length: number) => Math.round(length * ratio) / ratio;
      const barHeight = (measured: number) => snap(Math.max(BAR_MIN_HEIGHT, measured * tallest));

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
        paint.setTransform(ratio, 0, 0, ratio, 0, 0);
        paint.clearRect(0, 0, width, height);
        paint.fillStyle = colour;
        const start = (width - (STILL_SHAPE.length - 1) * BAR_PITCH - BAR_WIDTH) / 2;
        STILL_SHAPE.forEach((shape, index) => {
          const h = barHeight(still * shape);
          paint.fillRect(snap(start + index * BAR_PITCH), snap(middle - h / 2), BAR_WIDTH, h);
        });
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
      paint.setTransform(ratio, 0, 0, ratio, 0, 0);
      paint.clearRect(0, 0, width, height);
      paint.fillStyle = colour;
      const right = width - BAR_WIDTH;
      for (let index = bars.length - 1; index >= 0; index -= 1) {
        const bar = bars[index]!;
        const x = right - ((now - bar.at) / SLICE_MS) * BAR_PITCH;
        if (x < -BAR_WIDTH) {
          bars = bars.slice(index + 1);
          break;
        }
        const h = barHeight(bar.level);
        paint.fillRect(snap(x), snap(middle - h / 2), BAR_WIDTH, h);
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
