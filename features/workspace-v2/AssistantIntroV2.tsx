"use client";

import { AssistantAvatarV2 } from "@/components/ui-v2/AssistantAvatarV2";
import { assistantBylineV2 } from "@/features/composer-v2/AssistantPickerV2";
import type { AssistantAvatarRecipe } from "@/lib/contracts/assistants";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useComposerFocusHandoffV2, useQuietRowPresenceV2, WIDTH_TOLERANCE_PX } from "./AssistantStripV2";

/** Desktop shows four starters; phones and short screens hide the fourth in CSS. */
const STARTER_LIMIT = 4;

/**
 * The longest start of `text` that `fits` with an ellipsis after it, cut
 * after a whole word (and the punctuation that ended it); by characters only
 * when not even the first word fits. Null when the whole text fits. `fits`
 * must hold for every shorter candidate once it holds for a longer one.
 */
export function clampTextToWordsV2(text: string, fits: (candidate: string) => boolean): string | null {
  if (fits(text)) return null;
  const cut = (end: number) => `${text.slice(0, end).replace(/[\s,;:.!?]+$/u, "")}…`;
  const longest = (ends: readonly number[]) => {
    let low = 0;
    let high = ends.length - 1;
    let best: string | null = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = cut(ends[middle]!);
      if (fits(candidate)) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return best;
  };
  const wordEnds = [...text.matchAll(/\S(?=\s)/gu)].map((match) => (match.index ?? 0) + 1);
  const characterEnds: number[] = [];
  for (const character of text.slice(0, wordEnds[0] ?? text.length)) {
    characterEnds.push((characterEnds.at(-1) ?? 0) + character.length);
  }
  return longest(wordEnds) ?? longest(characterEnds) ?? "…";
}

/**
 * Centred text clamped by `-webkit-line-clamp` gets its ellipsis after the
 * line was centred: the last line leans right, can overhang the column and
 * is cut mid-word. So the text is cut here instead, at a word, to the lines
 * the stylesheet clamps the element to, and lays out as ordinary centred
 * lines; the stylesheet's clamp stays as the fallback before this runs.
 * Returns the cut text, or null while the whole text fits.
 */
function useWordClamp(ref: RefObject<HTMLElement | null>, text: string): string | null {
  const [clamped, setClamped] = useState<string | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    const box = element?.parentElement;
    if (!element || !box) return;
    let active = true;
    const measure = () => {
      if (!active) return;
      const style = getComputedStyle(element);
      const lines = parseInt(style.getPropertyValue("-webkit-line-clamp"), 10);
      const lineHeight = parseFloat(style.lineHeight);
      const cap = parseFloat(style.maxWidth);
      const boxStyle = getComputedStyle(box);
      const width = Math.min(
        box.clientWidth - (parseFloat(boxStyle.paddingLeft) || 0) - (parseFloat(boxStyle.paddingRight) || 0),
        Number.isFinite(cap) ? cap : Number.POSITIVE_INFINITY
      );
      if (!(lines > 0 && lineHeight > 0 && width > 0)) {
        setClamped(null);
        return;
      }
      // An unclamped copy in the same place, at the width the element may take.
      const probe = element.cloneNode(false) as HTMLElement;
      probe.setAttribute("aria-hidden", "true");
      probe.removeAttribute("title");
      probe.style.cssText = `position: absolute; display: block; visibility: hidden; pointer-events: none; ` +
        `width: ${width}px; max-width: none; overflow: visible; -webkit-line-clamp: none;`;
      box.append(probe);
      try {
        const limit = lines * lineHeight + WIDTH_TOLERANCE_PX;
        setClamped(clampTextToWordsV2(text, (candidate) => {
          probe.textContent = candidate;
          return probe.getBoundingClientRect().height <= limit;
        }));
      } finally {
        probe.remove();
      }
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(box);
    observer?.observe(element);
    void document.fonts?.ready.then(measure);
    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [ref, text]);
  return clamped;
}

/** Cut text on screen, the whole text for assistive technology. */
function ClampedText({ clamped, text }: Readonly<{ clamped: string | null; text: string }>) {
  if (clamped === null) return text;
  return (
    <>
      <span aria-hidden="true">{clamped}</span>
      <span className="v2-sr-only">{text}</span>
    </>
  );
}

/**
 * The quiet intro of a blank chat with an Assistant (PRD 10.6): avatar, name,
 * description and who made it (a Project's Assistant reads as the Project's).
 * The header already names the Assistant, so
 * there is no kicker, publication scope, accent colour or framed block. The
 * name and description are clamped (see workspace.css) so the composer below
 * stays in view on short screens, cut at a word with every line centred;
 * the description's title and Studio show it whole.
 */
export function AssistantIntroV2({
  avatar,
  description,
  name,
  owned,
  ownerDisplayName,
  projectName
}: Readonly<{
  avatar: AssistantAvatarRecipe;
  description: string;
  name: string;
  owned: boolean;
  ownerDisplayName: string;
  /** Only for a Project's Assistant: the Project's name, or null while unknown. */
  projectName?: string | null;
}>) {
  const byline = assistantBylineV2({ owned, ownerDisplayName, projectName });
  const nameRef = useRef<HTMLHeadingElement>(null);
  const descriptionRef = useRef<HTMLSpanElement>(null);
  const clampedName = useWordClamp(nameRef, name);
  const clampedDescription = useWordClamp(descriptionRef, description);
  return (
    <div className="v2-live-assistant-intro" data-testid="assistant-blank-intro">
      <AssistantAvatarV2 recipe={avatar} size={56} />
      <h1 ref={nameRef}><ClampedText clamped={clampedName} text={name} /></h1>
      {description ? (
        <span className="v2-live-assistant-description" ref={descriptionRef} title={description}>
          <ClampedText clamped={clampedDescription} text={description} />
        </span>
      ) : null}
      <span className="v2-live-assistant-by">{`${byline.charAt(0).toUpperCase()}${byline.slice(1)}`}</span>
    </div>
  );
}

/**
 * How many pills, in order, flex-wrap places within `room` of height: a pill
 * keeps its natural width up to the row's and one that does not fit the room
 * left on its line starts the next; a line is as tall as its tallest pill (a
 * long starter takes two lines of text).
 */
export function startersThatFitV2(input: Readonly<{
  available: number;
  columnGap: number;
  pills: readonly Readonly<{ height: number; width: number }>[];
  room: number;
  rowGap: number;
}>): number {
  const { available, columnGap, room, rowGap } = input;
  let count = 0;
  /** The lines above the current one, each with the gap under it. */
  let above = 0;
  let lineHeight = 0;
  let used = 0;
  for (const pill of input.pills) {
    const width = Math.min(pill.width, available);
    if (used > 0 && used + columnGap + width > available + WIDTH_TOLERANCE_PX) {
      above += lineHeight + rowGap;
      lineHeight = pill.height;
      used = width;
    } else {
      lineHeight = Math.max(lineHeight, pill.height);
      used = used > 0 ? used + columnGap + width : width;
    }
    if (above + lineHeight > room + WIDTH_TOLERANCE_PX) break;
    count += 1;
  }
  return count;
}

/**
 * The starters that fit whole in the blank chat: the height left in its
 * scroll area once everything else in it (padding, intro, composer, notice)
 * is counted, so the page never scrolls and the composer never moves. The
 * row's own height is left out, so the count does not depend on what it
 * currently shows.
 */
function startersThatFit(row: HTMLElement, orientation: HTMLElement, scroller: HTMLElement): number {
  const rowStyle = getComputedStyle(row);
  const available = row.clientWidth - (parseFloat(rowStyle.paddingLeft) || 0) - (parseFloat(rowStyle.paddingRight) || 0);
  // Starters hidden in CSS (the fourth) have no box and are not counted.
  const pills = [...row.children].filter((pill) => pill.getClientRects().length > 0);
  if (available <= 0 || scroller.clientHeight <= 0 || pills.length === 0) return Number.POSITIVE_INFINITY;
  const orientationStyle = getComputedStyle(orientation);
  const blocks = [...orientation.children];
  const content = (parseFloat(orientationStyle.paddingTop) || 0) + (parseFloat(orientationStyle.paddingBottom) || 0) +
    blocks.reduce((sum, block) => sum + block.getBoundingClientRect().height, 0) +
    (parseFloat(orientationStyle.rowGap) || 0) * Math.max(0, blocks.length - 1);
  return startersThatFitV2({
    available,
    columnGap: parseFloat(rowStyle.columnGap) || 0,
    pills: pills.map((pill) => {
      const rect = pill.getBoundingClientRect();
      const style = getComputedStyle(pill);
      // On touch a pill's target reaches past its face into the gaps
      // (negative margins): its line takes the height of its margin box.
      return {
        height: rect.height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0),
        width: rect.width
      };
    }),
    room: scroller.clientHeight - (content - row.getBoundingClientRect().height),
    rowGap: parseFloat(rowStyle.rowGap) || 0
  });
}

type StarterFit = Readonly<{
  /** Leading starters shown; the rest are left out. */
  count: number;
  /** Per starter: its text does not fit its two lines and ends in an ellipsis. */
  cut: readonly boolean[];
}>;

const EVERY_STARTER: StarterFit = { count: Number.POSITIVE_INFINITY, cut: [] };

/**
 * How many leading starters are shown, and which are cut. While a draft
 * hides the row the result is kept, so the space the row reserves does not
 * change under the user's typing.
 */
function useStarterFit(rowRef: RefObject<HTMLDivElement | null>, shown: boolean, promptsKey: string): StarterFit {
  const [fit, setFit] = useState(EVERY_STARTER);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!shown || !row) return;
    const orientation = row.closest<HTMLElement>(".v2-conversation-orientation");
    const scroller = orientation?.parentElement ?? null;
    const measure = () => {
      const count = orientation && scroller ? startersThatFit(row, orientation, scroller) : Number.POSITIVE_INFINITY;
      const cut = [...row.querySelectorAll<HTMLElement>(".v2-composer-indicator-label")]
        .map((label) => label.scrollHeight > label.clientHeight + WIDTH_TOLERANCE_PX);
      setFit((current) => current.count === count &&
        current.cut.length === cut.length &&
        current.cut.every((value, index) => value === cut[index])
        ? current
        : { count, cut });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    for (const element of [row, ...row.children, orientation, scroller]) {
      if (element) observer?.observe(element);
    }
    return () => observer?.disconnect();
  }, [promptsKey, rowRef, shown]);
  return fit;
}

/**
 * Starter prompts as quiet pills under the blank composer; a click sends the
 * starter. Pills wrap in centred rows; a long starter takes two lines in its
 * pill, and one longer still ends in an ellipsis with its whole text as the
 * title. Only the starters that fit whole in the blank chat are offered. The
 * caller mounts them only while the Assistant can send.
 */
export function AssistantStartersV2({
  idle,
  onSend,
  prompts,
  restoreFocus
}: Readonly<{
  /** The composer has no draft, attachment, upload or send. */
  idle: boolean;
  onSend(prompt: string): void;
  prompts: readonly string[];
  restoreFocus(): void;
}>) {
  const rowRef = useRef<HTMLDivElement>(null);
  const presence = useQuietRowPresenceV2(idle);
  useComposerFocusHandoffV2(rowRef, presence !== "absent", restoreFocus);
  const offered = prompts.slice(0, STARTER_LIMIT);
  const fit = useStarterFit(rowRef, presence === "shown", offered.join("\u0001"));
  if (presence === "absent") return null;
  const hidden = presence === "hidden";
  return (
    <div
      aria-hidden={hidden || undefined}
      aria-label="Starter prompts"
      className="v2-assistant-strip v2-assistant-starters"
      data-reserved={hidden ? "" : undefined}
      data-testid="assistant-starter-prompts"
      inert={hidden}
      ref={rowRef}
      role="group"
    >
      {offered.map((prompt, index) => {
        // A starter that does not fit stays measurable but is neither shown,
        // focusable nor announced (the strip's rule).
        const left = index >= fit.count;
        return (
          <button
            aria-hidden={left || undefined}
            className="v2-composer-indicator v2-focusable"
            data-overflow={left ? "" : undefined}
            data-quiet=""
            inert={left}
            key={`${index}:${prompt}`}
            tabIndex={left ? -1 : undefined}
            title={!left && fit.cut[index] ? prompt : undefined}
            type="button"
            onClick={() => onSend(prompt)}
          >
            <span className="v2-composer-indicator-face">
              <span className="v2-composer-indicator-label">{prompt}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
