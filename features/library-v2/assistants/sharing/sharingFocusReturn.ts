/*
 * Where focus goes when the Sharing sheet closes. The modal layer returns
 * focus to the element that was focused when the sheet opened, but Save can
 * replace that element: the list refresh moves a card into another group, so
 * its "More actions" button is a new node. The sheet therefore also records
 * how to find the opener again (its accessible name) and the surface around
 * it, and repairs focus once the layer is done, never leaving it on the page.
 */

const FOCUSABLE =
  "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), " +
  "textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export type SharingOpenerRecord = Readonly<{
  /** Its ancestors, innermost first: the neighbours when it is gone. */
  ancestors: readonly HTMLElement[];
  element: HTMLElement | null;
  label: string | null;
  text: string | null;
}>;

function reachable(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  if (element.matches(":disabled") || element.closest("[inert], [hidden]")) return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.inert) return false;
  }
  return true;
}

/**
 * Called while rendering the sheet's first frame, before it takes focus. On
 * the server there is no opener and no DOM class to test it against.
 */
export function recordSharingOpener(active: Element | null): SharingOpenerRecord {
  const element = active !== null && typeof HTMLElement !== "undefined" && active instanceof HTMLElement &&
    active !== active.ownerDocument.body ? active : null;
  const ancestors: HTMLElement[] = [];
  for (let current = element?.parentElement ?? null; current && current !== current.ownerDocument.body; current = current.parentElement) {
    ancestors.push(current);
  }
  return {
    ancestors,
    element,
    label: element?.getAttribute("aria-label") ?? null,
    text: element && !element.hasAttribute("aria-label") ? element.textContent?.trim() || null : null
  };
}

function sameControl(record: SharingOpenerRecord): HTMLElement | null {
  if (!record.label && !record.text) return null;
  const candidates = [...document.querySelectorAll<HTMLElement>("button, a[href]")].filter((candidate) =>
    record.label ? candidate.getAttribute("aria-label") === record.label : candidate.textContent?.trim() === record.text);
  return candidates.find(reachable) ?? null;
}

function firstReachable(container: Element): HTMLElement | null {
  return [...container.querySelectorAll(FOCUSABLE)].find(reachable) ?? null;
}

/**
 * Runs after the sheet has closed. Focus that already landed on a reachable
 * control stays; otherwise it goes to the opener, the same control rendered
 * anew, the nearest surviving neighbour, or the open dialog underneath.
 */
export function restoreSharingFocus(record: SharingOpenerRecord): void {
  const active = document.activeElement;
  if (active && active !== document.body && reachable(active)) return;
  if (reachable(record.element)) {
    record.element.focus();
    return;
  }
  const target = sameControl(record) ??
    record.ancestors.filter((ancestor) => ancestor.isConnected).map(firstReachable).find(Boolean) ??
    [...document.querySelectorAll("[role='dialog'][aria-modal='true']")].reverse().map(firstReachable).find(Boolean) ??
    null;
  target?.focus();
}
