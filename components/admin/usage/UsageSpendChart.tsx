"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { focusRing } from "@/components/admin/adminPrimitives";
import type { AdminUsageBucket, AdminUsageSeriesPoint } from "@/lib/contracts/adminUsageAnalytics";
import {
  formatBucketDate,
  formatCompactTokens,
  formatCount,
  formatMetricValue,
  formatUsdTick,
  niceTicks,
  USAGE_CATEGORY_META,
  USAGE_CATEGORY_ORDER,
  type UsageChartMetric
} from "./usageFormat";

const HEIGHT = 232;
const MARGIN = { bottom: 28, right: 12, top: 12 } as const;
const MAX_BAR = 24;
const GAP = 2;
const RADIUS = 4;
const DEFAULT_WIDTH = 720;
const TOOLTIP_WIDTH = 216;

export type UsageSpendChartProps = Readonly<{
  bucket: AdminUsageBucket;
  metric: UsageChartMetric;
  series: readonly AdminUsageSeriesPoint[];
  timeZone: string;
}>;

function pointValue(point: AdminUsageSeriesPoint, category: (typeof USAGE_CATEGORY_ORDER)[number], metric: UsageChartMetric) {
  const value = point.categories[category];
  return metric === "cost" ? value.estimatedCostMicros : value.totalTokens;
}

function pointTotal(point: AdminUsageSeriesPoint, metric: UsageChartMetric): number {
  return USAGE_CATEGORY_ORDER.reduce((sum, category) => sum + pointValue(point, category, metric), 0);
}

/** Rounded data end, square baseline. */
function columnPath(x: number, top: number, bottom: number, width: number, rounded: boolean): string {
  const radius = rounded ? Math.min(RADIUS, width / 2, bottom - top) : 0;
  if (radius <= 0) return `M${x},${bottom}V${top}H${x + width}V${bottom}Z`;
  return `M${x},${bottom}V${top + radius}Q${x},${top} ${x + radius},${top}` +
    `H${x + width - radius}Q${x + width},${top} ${x + width},${top + radius}V${bottom}Z`;
}

function useMeasuredWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const next = Math.round(element.clientWidth);
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/**
 * Stacked columns per bucket by usage category in fixed slot order. Values
 * stay reachable without the chart through the hover/focus readout and a
 * visually hidden table.
 */
export function UsageSpendChart({ bucket, metric, series, timeZone }: UsageSpendChartProps) {
  const { ref, width } = useMeasuredWidth();
  const [active, setActive] = useState<number | null>(null);
  const unit = bucket === "month" ? "month" : "day";

  const totals = useMemo(() => series.map((point) => pointTotal(point, metric)), [metric, series]);
  const max = Math.max(0, ...totals);
  const ticks = niceTicks(max, 4, metric === "cost" ? 10_000 : 1);
  const step = ticks[1] ?? 1;
  const top = ticks[ticks.length - 1] ?? 1;
  const tickLabel = (value: number) => metric === "cost" ? formatUsdTick(value, step) : formatCompactTokens(value);
  const longestTick = Math.max(...ticks.map((tick) => tickLabel(tick).length));
  const left = Math.max(32, longestTick * 7 + 12);
  const plotWidth = Math.max(1, width - left - MARGIN.right);
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const baseline = MARGIN.top + plotHeight;
  const slot = series.length ? plotWidth / series.length : plotWidth;
  const barWidth = Math.min(MAX_BAR, Math.max(1, slot * 0.64));
  const y = (value: number) => MARGIN.top + plotHeight * (1 - value / top);
  const labelSpacing = bucket === "month" ? 76 : 60;
  const labelEvery = Math.max(1, Math.ceil(series.length / Math.max(1, Math.floor(plotWidth / labelSpacing))));
  const activeIndex = active !== null && active < series.length ? active : null;
  const activePoint = activeIndex !== null ? series[activeIndex] : undefined;

  function indexAt(event: PointerEvent<SVGSVGElement>): number | null {
    const box = event.currentTarget.getBoundingClientRect();
    const scale = box.width > 0 ? width / box.width : 1;
    const x = (event.clientX - box.left) * scale - left;
    if (x < 0 || x > plotWidth || !series.length) return null;
    return Math.min(series.length - 1, Math.floor(x / slot));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!series.length) return;
    const last = series.length - 1;
    const current = activeIndex ?? last;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = Math.min(last, current + 1);
    else if (event.key === "ArrowLeft") next = Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Escape") {
      setActive(null);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    setActive(next);
  }

  // The readout sits beside the inspected column, never over it, inside the chart's width.
  const activeCenter = activeIndex !== null ? left + slot * (activeIndex + 0.5) : 0;
  const tooltipWidth = Math.min(TOOLTIP_WIDTH, width);
  const tooltipLeft = Math.min(Math.max(0, activeCenter > width / 2
    ? activeCenter - slot / 2 - 6 - tooltipWidth
    : activeCenter + slot / 2 + 6), width - tooltipWidth);

  return (
    <div className="min-w-0">
      <div
        aria-label={`Spend over time by source. Use the arrow keys to read each ${unit}.`}
        className={`relative min-w-0 rounded-control ${focusRing}`}
        data-testid="usage-spend-chart"
        onBlur={() => setActive(null)}
        onFocus={() => setActive((current) => current ?? (series.length ? series.length - 1 : null))}
        onKeyDown={onKeyDown}
        ref={ref}
        role="group"
        tabIndex={0}
      >
        <svg
          aria-hidden="true"
          className="block touch-pan-y select-none"
          height={HEIGHT}
          onPointerDown={(event) => setActive(indexAt(event))}
          // A tap keeps its readout after the finger lifts; leaving focus clears it.
          onPointerLeave={(event) => {
            if (event.pointerType !== "touch") setActive(null);
          }}
          onPointerMove={(event) => setActive(indexAt(event))}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          width="100%"
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                shapeRendering="crispEdges"
                stroke={tick === 0 ? "var(--v2-color-border2)" : "var(--v2-color-border)"}
                strokeWidth={1}
                x1={left}
                x2={width - MARGIN.right}
                y1={Math.round(y(tick)) + 0.5}
                y2={Math.round(y(tick)) + 0.5}
              />
              <text
                dominantBaseline="middle"
                fill="var(--v2-color-text3)"
                fontSize={12}
                textAnchor="end"
                x={left - 8}
                y={y(tick)}
              >
                {tickLabel(tick)}
              </text>
            </g>
          ))}
          {activeIndex !== null ? (
            <rect
              data-testid="usage-chart-active-column"
              fill="var(--v2-color-hover)"
              height={plotHeight}
              width={slot}
              x={left + slot * activeIndex}
              y={MARGIN.top}
            />
          ) : null}
          {series.map((point, index) => {
            const x = left + slot * index + (slot - barWidth) / 2;
            const drawn = USAGE_CATEGORY_ORDER.flatMap((category) => {
              const value = pointValue(point, category, metric);
              return value > 0 ? [{ category, value }] : [];
            });
            let cumulative = 0;
            const segments = drawn.map(({ category, value }, segmentIndex) => {
              const bottom = y(cumulative) - (segmentIndex > 0 ? GAP : 0);
              cumulative += value;
              return { bottom, category, top: y(cumulative) };
            }).filter((segment) => segment.bottom - segment.top > 0.25);
            return (
              <g data-bucket={point.start} key={point.start}>
                {segments.map((segment, segmentIndex) => (
                  <path
                    d={columnPath(x, segment.top, segment.bottom, barWidth, segmentIndex === segments.length - 1)}
                    data-category={segment.category}
                    key={segment.category}
                    style={{ fill: USAGE_CATEGORY_META[segment.category].color }}
                  />
                ))}
              </g>
            );
          })}
          {series.map((point, index) => {
            if ((series.length - 1 - index) % labelEvery !== 0) return null;
            const x = left + slot * (index + 0.5);
            const anchor = x + 32 > width ? "end" : x - 32 < 0 ? "start" : "middle";
            return (
              <text
                fill="var(--v2-color-text3)"
                fontSize={12}
                key={point.start}
                textAnchor={anchor}
                x={anchor === "end" ? width - 2 : x}
                y={baseline + 18}
              >
                {formatBucketDate(point.start, timeZone, bucket)}
              </text>
            );
          })}
        </svg>
        {activePoint && activeIndex !== null ? (
          <div
            className="pointer-events-none absolute z-10 rounded-control border border-trace-subtle bg-overlay-surface px-3 py-2 text-xs text-ink-secondary shadow-[var(--v2-shadow-float)]"
            data-testid="usage-chart-tooltip"
            role="status"
            style={{ left: tooltipLeft, top: MARGIN.top, width: tooltipWidth }}
          >
            <p className="font-medium text-ink">{formatBucketDate(activePoint.start, timeZone, bucket, true)}</p>
            <ul className="mt-1.5 grid gap-1">
              {USAGE_CATEGORY_ORDER.map((category) => (
                <li className="flex items-center gap-2" key={category}>
                  <span
                    aria-hidden="true"
                    className="h-0.5 w-3 shrink-0 rounded-full"
                    style={{ background: USAGE_CATEGORY_META[category].color }}
                  />
                  <span className="min-w-0 flex-1 truncate">{USAGE_CATEGORY_META[category].label}</span>
                  <span className="font-mono font-medium tabular-nums text-ink">
                    {formatMetricValue(metric, pointValue(activePoint, category, metric))}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 flex items-center gap-2 border-t border-trace-subtle pt-1.5">
              <span className="flex-1">Total · {formatCount(activePoint.runCount)} runs</span>
              <span className="font-mono font-semibold tabular-nums text-ink">
                {formatMetricValue(metric, totals[activeIndex] ?? 0)}
              </span>
            </p>
          </div>
        ) : null}
      </div>
      <ul aria-label="Legend" className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-ink-secondary">
        {USAGE_CATEGORY_ORDER.map((category) => (
          <li className="flex items-center gap-1.5" key={category}>
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-[2px]"
              style={{ background: USAGE_CATEGORY_META[category].color }}
            />
            {USAGE_CATEGORY_META[category].label}
          </li>
        ))}
      </ul>
      {/* A table cannot shrink below its content, so the wrapper carries the visually hidden clip. */}
      <div className="sr-only">
        <table>
          <caption>{metric === "cost" ? "Estimated cost" : "Tokens"} per {unit} by source</caption>
          <thead>
            <tr>
              <th scope="col">{unit === "month" ? "Month" : "Day"}</th>
              {USAGE_CATEGORY_ORDER.map((category) => (
                <th key={category} scope="col">{USAGE_CATEGORY_META[category].label}</th>
              ))}
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {series.map((point, index) => (
              <tr key={point.start}>
                <th scope="row">{formatBucketDate(point.start, timeZone, bucket, true)}</th>
                {USAGE_CATEGORY_ORDER.map((category) => (
                  <td key={category}>{formatMetricValue(metric, pointValue(point, category, metric))}</td>
                ))}
                <td>{formatMetricValue(metric, totals[index] ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
