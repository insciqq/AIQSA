const TOUCH_INPUT_QUERY = "(hover: none), (pointer: coarse)";

/**
 * Whether touch is the primary input. There a focused text field raises the
 * software keyboard over half the screen, so a picker opens on itself rather
 * than its search field; a tap on the field still searches.
 */
export function touchInputPrimaryV2(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" &&
    window.matchMedia(TOUCH_INPUT_QUERY).matches;
}
