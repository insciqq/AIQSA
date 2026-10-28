/*
 * Browsers paint the keyboard focus ring on a control that script focuses
 * whenever the element focused before it matched :focus-visible, and text
 * fields always do. iOS Safari also keeps focus in the text field when a button
 * is tapped, so a drawer opened by a tap after typing rang its close button
 * (GitHub #65). FocusOptions.focusVisible would say this directly, but WebKit
 * and Chromium do not reliably honour it, so a surface opened by a pointer
 * focuses itself instead; it is tabindex=-1 and draws no ring. A keyboard open
 * keeps its first control, and a text field takes focus either way.
 */

let pointerWasLast = false;

if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", () => { pointerWasLast = true; }, true);
  document.addEventListener("keydown", () => { pointerWasLast = false; }, true);
}

const nonTextInputTypes = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit"
]);

function takesText(element: HTMLElement) {
  return element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && !nonTextInputTypes.has(element.type)) ||
    element.isContentEditable;
}

/** The element a just-opened surface focuses: its first control, or itself after a pointer open. */
export function openingFocusTarget(surface: HTMLElement, control: HTMLElement | null): HTMLElement {
  return control && (!pointerWasLast || takesText(control)) ? control : surface;
}
