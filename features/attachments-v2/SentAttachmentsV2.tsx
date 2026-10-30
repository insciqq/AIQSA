"use client";

import { useState } from "react";
import { ChatImageV2 } from "./ChatImageV2";
import type { ThreadAttachmentBlock } from "@/components/app-shell/threadContent";
import { attachmentDownloadHref } from "@/components/app-shell/workspaceClient";
import { UiV2Icon } from "@/components/ui-v2";
import { FilePreviewV2 } from "@/features/library-v2/FilePreviewV2";
import { fileExtension, fileTypeLabel } from "@/features/library-v2/filePresentation";
import { isPdfFileName, isTextPreviewFileName } from "@/lib/domain/attachmentPreview";
import { FileActionsMenuV2 } from "./FileActionsMenuV2";

/**
 * The one place that decides what clicking a sent file does: open the viewer
 * or download. A thread block carries only id, label and type, so this goes by
 * extension; an oversized or undecodable file gets the route's 415, which the
 * viewer turns into its Download fallback, and a PDF's refusals are the PDF
 * viewer's own.
 */
function sentFileOpensInViewer(fileName: string): boolean {
  return isPdfFileName(fileName) || isTextPreviewFileName(fileName);
}

function SentFileCardV2({ block, canSave, onOpen }: Readonly<{
  block: ThreadAttachmentBlock;
  canSave: boolean;
  onOpen(): void;
}>) {
  const caption = fileExtension(block.label).slice(0, 4).toUpperCase();
  const body = <>
    <span aria-hidden="true" className="v2-sent-file-icon">
      <UiV2Icon name="file" />
      {caption || null}
    </span>
    <span className="v2-sent-file-copy">
      <strong title={block.label}>{block.label}</strong>
      <small>{fileTypeLabel(block.label)}</small>
    </span>
  </>;
  return (
    <div className="v2-sent-file">
      {sentFileOpensInViewer(block.label) ? (
        <button aria-haspopup="dialog" aria-label={`Open ${block.label}`} className="v2-sent-file-open v2-focusable"
          onClick={onOpen} type="button">
          {body}
        </button>
      ) : (
        <a aria-label={`Download ${block.label}`} className="v2-sent-file-open v2-focusable" download
          href={attachmentDownloadHref(block.attachmentId)}>
          {body}
        </a>
      )}
      {canSave ? <FileActionsMenuV2 attachmentId={block.attachmentId} fileName={block.label} /> : null}
    </div>
  );
}

/**
 * The owner-only files sent with a message: cards and small images. It renders
 * exactly the labels the thread snapshot already exposes to the owner; bytes
 * remain behind the universal same-origin authorization route.
 */
export function SentAttachmentsV2({ blocks, canSave = false }: Readonly<{
  blocks: readonly ThreadAttachmentBlock[];
  canSave?: boolean;
}>) {
  const [viewing, setViewing] = useState<ThreadAttachmentBlock | null>(null);
  if (blocks.length === 0) return null;
  const viewedFile = viewing ? {
    byteSize: null, canOpenChat: false, id: viewing.attachmentId, name: viewing.label,
    previewKind: isPdfFileName(viewing.label) ? "pdf" as const : "text" as const, status: "ready" as const
  } : null;

  return (
    <>
      <ul
        aria-label="Message attachments"
        className="v2-sent-attachments"
        data-testid="sent-attachments"
      >
        {blocks.map((block, index) => (
          <li data-kind={block.type} key={`${index}:${block.label}`}>
            {block.type === "image"
              ? <ChatImageV2 attachmentId={block.attachmentId} canSave={canSave} label={block.label} thumbnail />
              : <SentFileCardV2 block={block} canSave={canSave} onOpen={() => setViewing(block)} />}
          </li>
        ))}
      </ul>
      {viewedFile ? (
        <FilePreviewV2 canSave={canSave} compact file={viewedFile} group={[viewedFile]} onClose={() => setViewing(null)}
          onSelect={() => undefined} saved={false} useDisabled={false} />
      ) : null}
    </>
  );
}
