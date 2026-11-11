/**
 * Text that sits beside a conditional icon or spinner, in an element of its
 * own. A page translator (Chrome, Yandex) swaps bare text nodes for its own
 * `<font>` elements; React then fails to insert an icon before, or remove, the
 * text node it rendered, and the page crashes. Keyed by the text, a changed
 * label replaces the whole element, so the new words show (and are translated
 * again) instead of landing in a text node the translator detached.
 */
export function TranslatableLabel({ children }: Readonly<{ children: string }>) {
  return <span key={children}>{children}</span>;
}
