"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { Download, X } from "lucide-react";
import { attachmentDownloadHref } from "@/components/app-shell/workspaceClient";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import { SaveFileButtonV2 } from "./SaveFileButtonV2";

type ImageProps = Readonly<{ attachmentId: string; label: string; canSave?: boolean; width?: number; height?: number }>;

function ImageViewer({ attachmentId, label, onClose }: ImageProps & { onClose(): void }) {
  const { portalReady, onDialogKeyDown, dialogRef, initialFocusRef } = useModalLayerV2({ onClose });
  if (!portalReady) return null;
  const href = attachmentDownloadHref(attachmentId);
  return createPortal(<div className="v2-image-overlay" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section aria-label={label} aria-modal="true" className="v2-image-viewer" onKeyDown={onDialogKeyDown} ref={dialogRef} role="dialog">
      <div className="v2-image-viewer-actions">
        <a className="v2-focusable" download href={href}><Download aria-hidden="true" size={18} /> Download</a>
        <button aria-label="Close image" className="v2-focusable" onClick={onClose} ref={initialFocusRef} type="button"><X aria-hidden="true" size={22} /></button>
      </div>
      {/* Authenticated image bytes must bypass the public Next image optimizer. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img alt={label} src={`${href}?preview=image`} />
    </section>
  </div>, document.body);
}

export function ChatImageV2({ attachmentId, label, canSave = false, width, height }: ImageProps) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const href = attachmentDownloadHref(attachmentId);
  return <figure className="v2-chat-image" data-testid="chat-image">
    {failed ? <p role="status">Image preview unavailable</p> : <button aria-label={`Open image: ${label}`} className="v2-chat-image-preview v2-focusable" onClick={() => setOpen(true)} type="button">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img alt={label} height={height} loading="lazy" onError={() => setFailed(true)} src={`${href}?preview=image`} width={width} />
    </button>}
    <figcaption><a className="v2-focusable" download href={href}><Download aria-hidden="true" size={14} /> Download</a>
      {canSave ? <SaveFileButtonV2 attachmentId={attachmentId} /> : null}</figcaption>
    {open ? <ImageViewer attachmentId={attachmentId} label={label} onClose={() => setOpen(false)} /> : null}
  </figure>;
}
