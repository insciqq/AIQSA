"use client";

import type { ThreadAttachmentBlock } from "@/components/app-shell/threadContent";
import { UiV2Icon } from "@/components/ui-v2";

/**
 * Quiet owner-only line of sent attachments under the user-bubble text. It
 * renders exactly the labels the thread snapshot already exposes to the owner
 * (file names / image labels) and never storage keys, URLs, or byte access.
 */
export function SentAttachmentsV2({ blocks }: Readonly<{
  blocks: readonly ThreadAttachmentBlock[];
}>) {
  if (blocks.length === 0) return null;

  return (
    <ul
      aria-label="Вложения сообщения"
      className="v2-sent-attachments"
      data-testid="sent-attachments"
    >
      {blocks.map((block, index) => (
        <li key={`${index}:${block.label}`}>
          <UiV2Icon name="attach" />
          <span>{block.label}</span>
        </li>
      ))}
    </ul>
  );
}
