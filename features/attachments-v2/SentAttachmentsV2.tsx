"use client";

import type { ThreadAttachmentBlock } from "@/components/app-shell/threadContent";
import { attachmentDownloadHref } from "@/components/app-shell/workspaceClient";
import { UiV2Icon } from "@/components/ui-v2";
import { SaveFileButtonV2 } from "./SaveFileButtonV2";

/**
 * Quiet owner-only line of sent attachments under the user-bubble text. It
 * renders exactly the labels the thread snapshot already exposes to the owner.
 * Bytes remain behind the universal same-origin authorization route.
 */
export function SentAttachmentsV2({ blocks, canSave = false }: Readonly<{
  blocks: readonly ThreadAttachmentBlock[];
  canSave?: boolean;
}>) {
  if (blocks.length === 0) return null;

  return (
    <ul
      aria-label="Message attachments"
      className="v2-sent-attachments"
      data-testid="sent-attachments"
    >
      {blocks.map((block, index) => (
        <li key={`${index}:${block.label}`}>
          <UiV2Icon name="attach" />
          <a
            className="v2-focusable"
            download
            href={attachmentDownloadHref(block.attachmentId)}
          >
            {block.label}
          </a>
          {canSave ? <SaveFileButtonV2 attachmentId={block.attachmentId} /> : null}
        </li>
      ))}
    </ul>
  );
}
