"use client";

import {
  healthBucketLabel,
  healthCategoryColors,
  healthCategoryLabels,
  healthCount
} from "@/components/admin/health/healthFormat";
import { adminHealthCategories, type AdminHealthSeriesBucket } from "@/lib/contracts/adminHealth";
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const HEIGHT = 200;
const PAD_TOP = 8;
const PAD_BOTTOM = 24;
const PAD_LEFT = 36;
const PAD_RIGHT = 4;
const GAP = 2;
const RADIUS = 4;
const MAX_BAR = 24;
const FALLBACK_WIDTH = 640;

function niceMax(value: number): number {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value) return Math.ceil(candidate);
  }
  return Math.ceil(10 * magnitude);
}

/** A column segment whose data end (top) is rounded and whose baseline stays square. */
function topRoundedPath(x: number, y: number, width: number, height: number): string {
  const r = Math.min(RADIUS, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

function useWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const next = Math.round(node.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/**
 * Error-level records per hour or day, stacked by category in a fixed order.
 * One tab stop: arrow keys (or pointer/tap) select a column and show its
 * readout; the legend carries range totals and a hidden table holds every value.
 */
export function AdminHealthChart({
  interval,
  series
}: Readonly<{ interval: "hour" | "day"; series: readonly AdminHealthSeriesBucket[] }>) {
  const { ref, width } = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const readoutId = useId();
  const totals = useMemo(() => Object.fromEntries(adminHealthCategories.map((category) =>
    [category, series.reduce((sum, bucket) => sum + bucket.counts[category], 0)])) as Record<(typeof adminHealthCategories)[number], number>,
  [series]);
  const grandTotal = adminHealthCategories.reduce((sum, category) => sum + totals[category], 0);
  const max = niceMax(Math.max(0, ...series.map((bucket) => bucket.total)));
  const plotWidth = Math.max(1, width - PAD_LEFT - PAD_RIGHT);
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const band = plotWidth / Math.max(1, series.length);
  const barWidth = Math.max(2, Math.min(MAX_BAR, band - Math.max(2, band * 0.3)));
  const labelEvery = Math.max(1, Math.ceil(series.length / Math.max(1, Math.floor(plotWidth / 56))));
  const y = (value: number) => PAD_TOP + plotHeight - (value / max) * plotHeight;
  const selected = active === null ? null : series[active] ?? null;
  const caption = `${healthCount(grandTotal)} errors in ${series.length} ${interval === "hour" ? "hours" : "days"}`;

  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - box.left - PAD_LEFT;
    if (x < 0 || x > plotWidth) return;
    setActive(Math.min(series.length - 1, Math.max(0, Math.floor(x / band))));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = series.length - 1;
    const current = active ?? last;
    const next = event.key === "ArrowLeft" ? Math.max(0, current - 1)
      : event.key === "ArrowRight" ? Math.min(last, current + 1)
      : event.key === "Home" ? 0 : event.key === "End" ? last : null;
    if (event.key === "Escape") {
      setActive(null);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    setActive(next);
  };

  const tooltipLeft = selected && active !== null
    ? Math.min(Math.max(PAD_LEFT + band * active + band / 2, 96), Math.max(96, width - 96)) : 0;

  return (
    <figure className="m-0 min-w-0" data-testid="admin-health-chart">
      <figcaption className="sr-only">Errors over time by area: {caption}</figcaption>
      <ul aria-label="Chart legend" className="mb-3 flex min-w-0 flex-wrap gap-x-4 gap-y-1.5">
        {adminHealthCategories.map((category) => (
          <li className="flex min-w-0 items-center gap-1.5 text-xs text-ink-secondary" data-testid={`admin-health-legend-${category}`} key={category}>
            <span aria-hidden="true" className="size-2.5 shrink-0 rounded-[3px]" style={{ background: healthCategoryColors[category] }} />
            <span>{healthCategoryLabels[category]}</span>
            <span className="font-mono tabular-nums text-ink">{healthCount(totals[category])}</span>
          </li>
        ))}
      </ul>
      <div
        aria-describedby={readoutId}
        aria-label={`Errors chart, ${caption}. Use the arrow keys to read each ${interval === "hour" ? "hour" : "day"}.`}
        className="relative min-w-0 rounded-[8px] outline-none focus-visible:ring-2 focus-visible:ring-focus"
        onBlur={() => setActive(null)}
        onKeyDown={onKeyDown}
        ref={ref}
        role="group"
        tabIndex={0}
      >
        <svg
          aria-hidden="true"
          className="block touch-pan-y select-none"
          height={HEIGHT}
          onPointerDown={pick}
          onPointerLeave={(event) => { if (event.pointerType === "mouse") setActive(null); }}
          onPointerMove={pick}
          width={width}
        >
          {[0, max / 2, max].map((tick) => (
            <g key={tick}>
              <line style={{ stroke: "var(--v2-color-border)" }} x1={PAD_LEFT} x2={width - PAD_RIGHT} y1={y(tick)} y2={y(tick)} />
              <text dominantBaseline="middle" fontSize={11} style={{ fill: "var(--v2-color-text3)" }} textAnchor="end" x={PAD_LEFT - 6} y={y(tick)}>
                {healthCount(Math.round(tick))}
              </text>
            </g>
          ))}
          {series.map((bucket, index) => {
            const x = PAD_LEFT + band * index + (band - barWidth) / 2;
            let base = y(0);
            const present = adminHealthCategories.filter((category) => bucket.counts[category] > 0);
            return (
              <g data-testid="admin-health-bar" key={bucket.start} opacity={active === null || active === index ? 1 : 0.45}>
                {present.map((category, position) => {
                  const raw = (bucket.counts[category] / max) * plotHeight;
                  const height = Math.max(2, raw - (position < present.length - 1 ? GAP : 0));
                  const top = base - height;
                  base = top - (position < present.length - 1 ? GAP : 0);
                  const fill = { fill: healthCategoryColors[category] };
                  return position === present.length - 1
                    ? <path d={topRoundedPath(x, top, barWidth, height)} key={category} style={fill} />
                    : <rect height={height} key={category} style={fill} width={barWidth} x={x} y={top} />;
                })}
                {index % labelEvery === 0 ? (
                  <text fontSize={11} style={{ fill: "var(--v2-color-text3)" }} textAnchor="middle" x={x + barWidth / 2} y={HEIGHT - 6}>
                    {healthBucketLabel(bucket.start, interval)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        {grandTotal === 0 ? (
          <p className="pointer-events-none absolute inset-x-0 top-[38%] text-center text-sm text-ink-muted" data-testid="admin-health-chart-empty">
            No errors in this period
          </p>
        ) : null}
        {selected ? (
          <div
            className="pointer-events-none absolute top-1 z-10 w-44 -translate-x-1/2 rounded-[8px] border border-trace-subtle bg-answer-paper p-2.5 text-xs shadow-overlay"
            data-testid="admin-health-chart-readout"
            style={{ left: tooltipLeft }}
          >
            <p className="font-medium text-ink">{healthBucketLabel(selected.start, interval, true)}</p>
            <p className="mt-0.5 text-ink-muted"><strong className="font-mono font-semibold tabular-nums text-ink">{healthCount(selected.total)}</strong> errors</p>
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {adminHealthCategories.filter((category) => selected.counts[category] > 0).map((category) => (
                <li className="flex items-center gap-1.5" key={category}>
                  <span aria-hidden="true" className="h-0.5 w-2.5 shrink-0 rounded-full" style={{ background: healthCategoryColors[category] }} />
                  <strong className="font-mono font-semibold tabular-nums text-ink">{healthCount(selected.counts[category])}</strong>
                  <span className="text-ink-secondary">{healthCategoryLabels[category]}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p aria-live="polite" className="sr-only" id={readoutId}>
          {selected
            ? `${healthBucketLabel(selected.start, interval, true)}: ${healthCount(selected.total)} errors${adminHealthCategories
              .filter((category) => selected.counts[category] > 0)
              .map((category) => `, ${healthCategoryLabels[category]} ${healthCount(selected.counts[category])}`).join("")}`
            : ""}
        </p>
      </div>
      <table className="sr-only">
        <caption>Errors by {interval === "hour" ? "hour" : "day"} and area</caption>
        <thead>
          <tr>
            <th scope="col">{interval === "hour" ? "Hour" : "Day"}</th>
            {adminHealthCategories.map((category) => <th key={category} scope="col">{healthCategoryLabels[category]}</th>)}
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {series.map((bucket) => (
            <tr key={bucket.start}>
              <th scope="row">{healthBucketLabel(bucket.start, interval, true)}</th>
              {adminHealthCategories.map((category) => <td key={category}>{bucket.counts[category]}</td>)}
              <td>{bucket.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
