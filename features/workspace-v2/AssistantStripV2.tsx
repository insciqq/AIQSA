"use client";

import { AssistantAvatarV2 } from "@/components/ui-v2/AssistantAvatarV2";
import type { AssistantSummary } from "@/lib/contracts/assistants";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";

const STRIP_LINES = 2;
/* Sub-pixel sizes from layout must not push a fitting pill to the next line. */
export const WIDTH_TOLERANCE_PX = 0.5;

const PINNED_LIMIT = 5;

/**
 * The blank-chat strip (PRD 10.5, D-14): up to five pinned Assistants in list
 * order, then Featured ones not already pinned in their Featured order. No
 * recents (the picker has them). Archived and unavailable Assistants are not
 * offered: a click must start a chat that can send.
 */
export function assistantStripItemsV2(assistants: readonly AssistantSummary[]): AssistantSummary[] {
  const usable = assistants.filter((assistant) => !assistant.archived && assistant.availability.ok);
  const pinned = usable.filter((assistant) => assistant.pinned).slice(0, PINNED_LIMIT);
  const featured = usable
    .filter((assistant) => assistant.featured && !assistant.pinned)
    .sort((left, right) => (left.featuredOrder ?? Number.MAX_SAFE_INTEGER) - (right.featuredOrder ?? Number.MAX_SAFE_INTEGER));
  return [...pinned, ...featured];
}

/**
 * Quiet rows under a blank composer never move it while the user types: a
 * row appears only while the composer is idle (no draft, attachment, upload
 * or send) and, once shown, keeps its space hidden while a draft exists. A
 * row that becomes available over a draft waits until the composer is idle.
 */
export function useQuietRowPresenceV2(idle: boolean): "absent" | "hidden" | "shown" {
  const [revealed, setRevealed] = useState(idle);
  if (idle && !revealed) setRevealed(true);
  return !revealed ? "absent" : idle ? "shown" : "hidden";
}

/**
 * A row whose click removes it (choosing an Assistant, sending a starter)
 * hands focus back to the composer instead of dropping it to the page.
 */
export function useComposerFocusHandoffV2(
  rowRef: RefObject<HTMLElement | null>,
  rendered: boolean,
  restoreFocus: () => void
) {
  const restoreRef = useRef(restoreFocus);
  useLayoutEffect(() => {
    restoreRef.current = restoreFocus;
  });
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!rendered || !row) return;
    return () => {
      if (row.contains(document.activeElement)) {
        window.requestAnimationFrame(() => restoreRef.current());
      }
    };
  }, [rendered, rowRef]);
}

/** A shortened pill keeps at least this many characters of the name before its ellipsis. */
export const ASSISTANT_STRIP_MIN_CHARACTERS = 16;

/** The ellipsis of the product font is about as wide as two average characters. */
const ELLIPSIS_CHARACTERS = 2;

/**
 * The narrowest a pill may be shortened to: everything but the name, then
 * sixteen characters and the ellipsis at the name's own average character
 * width as rendered (its whole width over its length). A name that is not
 * longer is never shortened.
 */
export function assistantStripMinPillWidthV2(input: Readonly<{
  /** Characters in the name. */
  characters: number;
  /** The whole name's rendered width, past the label's cap. */
  labelWidth: number;
  /** The pill's width with its whole name, up to the label's cap. */
  natural: number;
  /** The name's part of `natural`. */
  naturalLabelWidth: number;
}>): number {
  const { characters, labelWidth, natural, naturalLabelWidth } = input;
  if (characters <= ASSISTANT_STRIP_MIN_CHARACTERS || labelWidth <= 0) return natural;
  const kept = (ASSISTANT_STRIP_MIN_CHARACTERS + ELLIPSIS_CHARACTERS) * labelWidth / characters;
  return natural - naturalLabelWidth + Math.min(naturalLabelWidth, kept);
}

export type AssistantStripFitV2 = Readonly<{
  /** Leading pills shown; the rest are left out. */
  count: number;
  /** Per shown pill: the width it is shortened to, or null for its natural width. */
  limits: readonly (number | null)[];
}>;

/**
 * Lays the pills out as flex-wrap does, in at most two rows with "All
 * Assistants…" last. A pill that does not fit the room left on its row
 * (on the second row, the room beside the link) is shortened to that room if
 * it keeps its minimum there (see assistantStripMinPillWidthV2); on the first
 * row a pill that does not fit even then starts the second row, and on the
 * second row it and every later pill are left out, so order is kept and
 * pinned outlast Featured.
 */
export function assistantStripFitV2(input: Readonly<{
  available: number;
  gap: number;
  linkWidth: number;
  /** Per pill: the narrowest it may be shortened to. */
  minimums: readonly number[];
  widths: readonly number[];
}>): AssistantStripFitV2 {
  const { available, gap, linkWidth, minimums } = input;
  const limits: (number | null)[] = [];
  let row = 1;
  let used = 0;
  for (const [index, natural] of input.widths.entries()) {
    const minimum = Math.min(minimums[index] ?? natural, natural);
    for (;;) {
      const room = available - (used > 0 ? used + gap : 0) - (row === STRIP_LINES ? gap + linkWidth : 0);
      if (natural <= room + WIDTH_TOLERANCE_PX) {
        limits.push(null);
        used += (used > 0 ? gap : 0) + natural;
        break;
      }
      if (minimum <= room + WIDTH_TOLERANCE_PX) {
        limits.push(Math.floor(room));
        used = available;
        break;
      }
      if (row === STRIP_LINES) return { count: limits.length, limits };
      row += 1;
      used = 0;
    }
  }
  return { count: limits.length, limits };
}

/**
 * A pill's width with its whole name (up to the label's own cap), whatever
 * it is shortened to now; the narrowest it may be shortened to; and whether
 * the cap alone already cuts the name.
 */
function measurePill(pill: HTMLElement): Readonly<{ capped: boolean; minimum: number; natural: number }> {
  const width = pill.getBoundingClientRect().width;
  const label = pill.querySelector<HTMLElement>(".v2-composer-indicator-label");
  if (!label) return { capped: false, minimum: width, natural: width };
  const capValue = parseFloat(getComputedStyle(label).maxWidth);
  const cap = Number.isFinite(capValue) ? capValue : Number.POSITIVE_INFINITY;
  const whole = label.scrollWidth;
  const full = Math.min(whole, cap);
  const natural = width + Math.max(0, full - label.getBoundingClientRect().width);
  return {
    capped: whole > cap + WIDTH_TOLERANCE_PX,
    minimum: assistantStripMinPillWidthV2({
      characters: [...(label.textContent ?? "")].length,
      labelWidth: whole,
      natural,
      naturalLabelWidth: full
    }),
    natural
  };
}

type AssistantStripLayout = AssistantStripFitV2 & Readonly<{
  /** Per pill: its label's cap cuts the name even at its natural width. */
  capped: readonly boolean[];
}>;

const ALL_PILLS_FIT: AssistantStripLayout = { capped: [], count: Number.POSITIVE_INFINITY, limits: [] };

function sameValues<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Measures the strip and keeps its two-row layout current. */
function useStripFit(
  rowRef: RefObject<HTMLDivElement | null>,
  rendered: boolean,
  /** Changes whenever the pills change, so new pills are measured and observed. */
  itemsKey: string
): AssistantStripLayout {
  const [fit, setFit] = useState<AssistantStripLayout>(ALL_PILLS_FIT);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!rendered || !row) return;
    const measure = () => {
      const style = getComputedStyle(row);
      const available = row.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      if (available <= 0) return;
      const pills = [...row.querySelectorAll<HTMLElement>("[data-strip-item]")].map(measurePill);
      const link = row.querySelector<HTMLElement>("[data-strip-all]");
      const next: AssistantStripLayout = {
        ...assistantStripFitV2({
          available,
          gap: parseFloat(style.columnGap) || 0,
          linkWidth: link?.getBoundingClientRect().width ?? 0,
          minimums: pills.map((pill) => pill.minimum),
          widths: pills.map((pill) => pill.natural)
        }),
        capped: pills.map((pill) => pill.capped)
      };
      setFit((current) => current.count === next.count &&
        sameValues(current.limits, next.limits) &&
        sameValues(current.capped, next.capped)
        ? current
        : next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    for (const child of row.children) observer.observe(child);
    return () => observer.disconnect();
  }, [itemsKey, rendered, rowRef]);
  return fit;
}

/**
 * Pinned and Featured Assistants under the blank personal composer: pills in
 * the style of an inactive composer chip, then "All Assistants…" for the
 * picker. It never takes more than two rows: a pill that does not fit is
 * shortened first and left out only when even that fails (see
 * assistantStripFitV2). A pill whose name is cut shows it whole as its
 * title. The caller mounts it only when there is something to offer.
 */
export function AssistantStripV2({
  idle,
  items,
  onChoose,
  onOpenPicker,
  restoreFocus
}: Readonly<{
  /** The composer has no draft, attachment, upload or send. */
  idle: boolean;
  items: readonly AssistantSummary[];
  onChoose(assistantId: string): void;
  onOpenPicker(): void;
  restoreFocus(): void;
}>) {
  const rowRef = useRef<HTMLDivElement>(null);
  const presence = useQuietRowPresenceV2(idle);
  useComposerFocusHandoffV2(rowRef, presence !== "absent", restoreFocus);
  const fit = useStripFit(rowRef, presence !== "absent",
    items.map((assistant) => `${assistant.id}\u0000${assistant.name}`).join("\u0001"));
  if (presence === "absent") return null;
  const hidden = presence === "hidden";
  return (
    <div
      aria-hidden={hidden || undefined}
      aria-label="Pinned and Featured Assistants"
      className="v2-assistant-strip"
      data-reserved={hidden ? "" : undefined}
      data-testid="assistant-strip"
      inert={hidden}
      ref={rowRef}
      role="group"
    >
      {items.map((assistant, index) => {
        // Pills past two rows stay measurable but are neither shown,
        // focusable nor announced; a shortened pill ends in an ellipsis.
        const left = index >= fit.count;
        const limit = left ? null : fit.limits[index] ?? null;
        const cut = !left && (limit !== null || fit.capped[index] === true);
        return (
          <button
            aria-hidden={left || undefined}
            className="v2-composer-indicator v2-focusable"
            data-overflow={left ? "" : undefined}
            data-quiet=""
            data-strip-item=""
            inert={left}
            key={assistant.id}
            style={limit === null ? undefined : { maxWidth: `${limit}px` }}
            tabIndex={left ? -1 : undefined}
            title={cut ? assistant.name : undefined}
            type="button"
            onClick={() => onChoose(assistant.id)}
          >
            <span className="v2-composer-indicator-face">
              <span className="v2-composer-indicator-icon" aria-hidden="true">
                <AssistantAvatarV2 recipe={assistant.avatar} size={16} />
              </span>
              <span className="v2-composer-indicator-label">{assistant.name}</span>
            </span>
          </button>
        );
      })}
      <button className="v2-assistant-strip-all v2-focusable" data-strip-all="" type="button" onClick={onOpenPicker}>
        All Assistants…
      </button>
    </div>
  );
}
