"use client";

import { isImeCompositionEvent } from "@/components/keyboard";
import { UiV2Icon } from "@/components/ui-v2";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import {
  filterComposerPaletteEntries,
  paletteEntryRunnable,
  type ComposerPaletteEntry,
  type ComposerPaletteGroup
} from "./paletteModel";
import "./command-palette.css";

/** How long typing pauses before a filter also searches the Skill library. */
const SKILL_SEARCH_DELAY_MS = 200;

export type ComposerCommandPaletteState = Readonly<{
  groups: readonly ComposerPaletteGroup[];
  /** The highlighted entry, which Enter and Tab run; null when nothing can run. */
  activeEntry: ComposerPaletteEntry | null;
  /** The DOM id of each listed entry, for `aria-activedescendant`. */
  optionId(entry: ComposerPaletteEntry): string;
  setActive(entry: ComposerPaletteEntry): void;
  /** Handles the message field's keys while the palette is open; true when it took the key. */
  handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean;
}>;

/**
 * The palette's list state behind the message field: the field keeps focus
 * and its keys move the highlight (`aria-activedescendant`) or run the entry.
 * The composer's layer owns opening, closing and placement.
 */
export function useComposerCommandPaletteV2(input: Readonly<{
  open: boolean;
  query: string;
  entries: readonly ComposerPaletteEntry[];
  listboxId: string;
  /** Closes the palette and keeps the draft as ordinary text. */
  onClose(): void;
  /** Removes the `/query` text, closes the palette and runs the entry. */
  onChoose(entry: ComposerPaletteEntry): void;
  /** Asks the Skill library for Skills matching the filter (beyond its first page). */
  onSearchSkills?(query: string): void;
}>): ComposerCommandPaletteState {
  const { entries, listboxId, onChoose, onClose, onSearchSkills, open, query } = input;
  const groups = useMemo(
    () => open ? filterComposerPaletteEntries(entries, query) : [],
    [entries, open, query]
  );
  const flat = useMemo(() => groups.flatMap((group) => group.entries), [groups]);
  const runnable = useMemo(() => flat.filter(paletteEntryRunnable), [flat]);
  // A new filter starts at its best match; arrows and hover move from there.
  const [active, setActiveState] = useState<Readonly<{ id: string; query: string }> | null>(null);
  const activeEntry = (active?.query === query ? runnable.find((entry) => entry.id === active.id) : undefined) ??
    runnable[0] ?? null;
  const indexById = useMemo(() => new Map(flat.map((entry, index) => [entry.id, index] as const)), [flat]);
  const optionId = (entry: ComposerPaletteEntry) => `${listboxId}-option-${indexById.get(entry.id) ?? 0}`;
  const setActive = (entry: ComposerPaletteEntry) => {
    if (paletteEntryRunnable(entry)) setActiveState({ id: entry.id, query });
  };

  // The latest search callback is read when the pause ends, so a parent
  // re-render never restarts the wait.
  const searchSkillsRef = useRef(onSearchSkills);
  useLayoutEffect(() => {
    searchSkillsRef.current = onSearchSkills;
  });
  const searchQuery = query.trim();
  const searches = Boolean(onSearchSkills);
  useEffect(() => {
    if (!open || !searches) return;
    const timer = window.setTimeout(() => searchSkillsRef.current?.(searchQuery), SKILL_SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [open, searchQuery, searches]);

  const activeDomId = activeEntry ? optionId(activeEntry) : null;
  useLayoutEffect(() => {
    if (!activeDomId) return;
    document.getElementById(activeDomId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeDomId]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open || isImeCompositionEvent(event)) return false;
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return true;
    }
    if (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey)) {
      event.preventDefault();
      // Nothing to run: the text stays as typed and the next Enter sends it.
      if (activeEntry) onChoose(activeEntry);
      else onClose();
      return true;
    }
    if (event.key === "Tab") {
      // Shift+Tab leaves the field; the palette does not stay behind.
      onClose();
      return false;
    }
    if (!plain || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return false;
    event.preventDefault();
    if (runnable.length === 0) return true;
    const current = activeEntry ? runnable.indexOf(activeEntry) : -1;
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? runnable.length - 1
        : event.key === "ArrowDown"
          ? (current + 1) % runnable.length
          : (current - 1 + runnable.length) % runnable.length;
    const entry = runnable[next];
    if (entry) setActiveState({ id: entry.id, query });
    return true;
  }

  return { activeEntry, groups, handleKeyDown, optionId, setActive };
}

/**
 * The palette list: grouped options with a bounded, scrolling height. Rows
 * never take focus (a press keeps the caret and the on-screen keyboard in
 * the message field); a tap or click runs a row, hover highlights it.
 */
export function ComposerCommandPaletteV2({
  listboxId,
  note,
  onRun,
  state
}: Readonly<{
  listboxId: string;
  /** A Skills list that is still loading or failed, said above the rows. */
  note: string | null;
  onRun(entry: ComposerPaletteEntry): void;
  state: ComposerCommandPaletteState;
}>) {
  const { activeEntry, groups, optionId, setActive } = state;
  return (
    <>
      {note ? <p className="v2-composer-palette-note" role="status">{note}</p> : null}
      {groups.length === 0 ? <p className="v2-composer-palette-note" role="status">No matches</p> : null}
      <div className="v2-composer-palette-list" id={listboxId} role="listbox" aria-label="Commands">
        {groups.map((group) => (
          <div className="v2-composer-palette-group" key={group.id} role="group" aria-labelledby={`${listboxId}-${group.id}`}>
            <div className="v2-composer-palette-heading" id={`${listboxId}-${group.id}`} role="presentation">
              {group.label}
            </div>
            {group.entries.map((entry) => {
              const runnable = paletteEntryRunnable(entry);
              const active = entry === activeEntry;
              const detail = entry.disabledReason ?? entry.detail;
              return (
                <div
                  key={entry.id}
                  id={optionId(entry)}
                  className="v2-composer-palette-option"
                  role="option"
                  aria-selected={active}
                  aria-disabled={!runnable || undefined}
                  data-active={active || undefined}
                  data-current={entry.current || undefined}
                  data-disabled={entry.disabledReason ? true : undefined}
                  // The message field keeps focus, so the touch keyboard stays open.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => {
                    if (runnable && !active) setActive(entry);
                  }}
                  onClick={() => {
                    if (runnable) onRun(entry);
                  }}
                >
                  {entry.icon ? <UiV2Icon name={entry.icon} /> : <span aria-hidden="true" />}
                  <span className="v2-composer-palette-copy">
                    <span className="v2-composer-palette-label">{entry.label}</span>
                    {detail ? <span className="v2-composer-palette-detail">{detail}</span> : null}
                  </span>
                  {entry.checked || entry.current ? <UiV2Icon className="v2-composer-palette-check" name="check" /> : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}
