import type { MouseEvent } from "react";

/**
 * Click handler of a card link the chat shell opens itself. The shell reads
 * its address (`/assistant/<id>`, `?library=…`) only on load and on history
 * traversal, so a framework link from inside a chat would change the address
 * and keep showing that chat. A plain primary click goes to `navigate`;
 * modified clicks keep the link's own behavior (a new tab loads the address),
 * and without `navigate` the browser loads it as a whole page.
 */
export function shellLinkClick(navigate: (() => void) | undefined) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (!navigate || event.defaultPrevented || event.button !== 0 ||
      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate();
  };
}
