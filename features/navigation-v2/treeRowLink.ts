import type { KeyboardEvent } from "react";
import { shellLinkClick } from "@/features/answer-outputs-v2/shellLinkClick";

/**
 * A chat-list row (a chat, a found message, a sub-agent) is a link to its own
 * address, so a middle or modified click opens it in another tab while a
 * plain click opens it in place (`shellLinkClick`). A busy list blocks only
 * the in-place open. The row is never dragged as a link: dragging a chat row
 * moves the chat between folders.
 */
export function treeRowLinkProps(href: string, disabled: boolean | undefined, open: () => void) {
  return {
    "aria-disabled": disabled || undefined,
    draggable: false,
    href,
    onClick: shellLinkClick(() => {
      if (!disabled) open();
    })
  } as const;
}

/** Space opens a row as it opens a button; Enter is the link's own key. */
export function treeRowLinkKeyDown(event: KeyboardEvent<HTMLAnchorElement>): void {
  if (event.key !== " " || event.defaultPrevented || event.repeat) return;
  event.preventDefault();
  event.currentTarget.click();
}
