"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useRef } from "react";

/**
 * Escape in Settings goes one step out (operator decision 2026-11-16): an open
 * inline confirmation cancels, an inline pane (the Skill detail or editor, the
 * Sub-agents editor) takes its own Back, a sub-view takes its Back, and only
 * then does Settings return to the chat. Inline confirmations and panes
 * register here while they are open; the most recently opened one answers
 * first, wherever focus is inside Settings. Outside Settings there is no
 * registry and the hook does nothing.
 */
type EscapeStepState = { blocked: boolean; onEscape(): void };
type EscapeStep = { readonly current: EscapeStepState };

export type SettingsEscapeRegistry = Readonly<{
  register(step: EscapeStep): () => void;
  /** The innermost open step, if any. */
  top(): EscapeStepState | null;
}>;

export function createSettingsEscapeRegistry(): SettingsEscapeRegistry {
  const steps: EscapeStep[] = [];
  return {
    register(step) {
      steps.push(step);
      return () => {
        const index = steps.lastIndexOf(step);
        if (index >= 0) steps.splice(index, 1);
      };
    },
    top: () => steps.at(-1)?.current ?? null
  };
}

export const SettingsEscapeContext = createContext<SettingsEscapeRegistry | null>(null);

/**
 * While `active`, Escape in Settings runs `onEscape` (what the step's own
 * Cancel or Back does) before anything further out. A `blocked` step (its
 * action is in flight) consumes the key and does nothing, so Escape never
 * skips past a busy confirmation to leave Settings.
 */
export function useSettingsEscapeStep(active: boolean, onEscape: () => void, blocked = false): void {
  const registry = useContext(SettingsEscapeContext);
  const state = useRef<EscapeStepState>({ blocked, onEscape });
  useLayoutEffect(() => {
    state.current = { blocked, onEscape };
  });
  useEffect(() => (active && registry ? registry.register(state) : undefined), [active, registry]);
}

/** Where Escape means "cancel the typing" rather than "go back": text fields, selects and comboboxes. */
const fieldSelector = [
  "input:not([type='button']):not([type='checkbox']):not([type='radio']):not([type='range']):not([type='color'])"
    + ":not([type='file']):not([type='image']):not([type='reset']):not([type='submit'])",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='combobox']",
  "[role='searchbox']",
  "[role='spinbutton']",
  "[role='textbox']"
].join(", ");

/**
 * Whether an Escape keydown is Settings' to take. It yields to every handler
 * that used the key (they prevent default), to IME composition, to a field
 * (a habit of "cancel" must not throw away typed text), to an open modal
 * dialog or alert dialog (some let the key through while busy), and to focus
 * outside Settings.
 */
export function settingsEscapeApplies(event: KeyboardEvent, root: Element | null): boolean {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229) return false;
  if (!root?.isConnected) return false;
  const target = event.target;
  if (target instanceof Element) {
    const document = target.ownerDocument;
    if (target !== document.body && target !== document.documentElement && !root.contains(target)) return false;
    if (target.closest(fieldSelector)) return false;
  }
  return !root.ownerDocument.querySelector("[role='dialog'][aria-modal='true'], [role='alertdialog']");
}
