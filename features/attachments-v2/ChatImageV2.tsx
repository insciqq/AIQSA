"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, X } from "lucide-react";
import { attachmentDownloadHref } from "@/components/app-shell/workspaceClient";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import { FileActionsMenuV2 } from "./FileActionsMenuV2";

type ImageProps = Readonly<{
  attachmentId: string;
  label: string;
  canSave?: boolean;
  /** False when the image's own file card already carries Download and the file menu. */
  caption?: boolean;
  onUseInArtifact?(): void | Promise<void>;
  width?: number;
  height?: number;
}>;

/** The full-size viewer of an image attachment, through the same authorized preview route as the inline image. */
export function ChatImageViewerV2({ attachmentId, label, onClose }: Readonly<{ attachmentId: string; label: string; onClose(): void }>) {
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

export function ChatImageV2({ attachmentId, label, canSave = false, caption = true, onUseInArtifact, width, height }: ImageProps) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [using, setUsing] = useState(false);
  const [useFailed, setUseFailed] = useState(false);
  const pending = useRef(false);
  async function attachToArtifact() {
    if (pending.current) return;
    pending.current = true; setUsing(true); setUseFailed(false);
    try { await onUseInArtifact?.(); }
    catch { setUseFailed(true); }
    finally { pending.current = false; setUsing(false); }
  }
  const href = attachmentDownloadHref(attachmentId);
  return <figure className="v2-chat-image" data-testid="chat-image">
    {failed ? <p role="status">Image preview unavailable</p> : <button aria-label={`Open image: ${label}`} className="v2-chat-image-preview v2-focusable" onClick={() => setOpen(true)} type="button">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img alt={label} height={height} loading="lazy" onError={() => setFailed(true)} src={`${href}?preview=image`} width={width} />
    </button>}
    {caption ? <figcaption><a className="v2-focusable" download href={href}><Download aria-hidden="true" size={14} /> Download</a>
      {onUseInArtifact ? <button className="v2-focusable v2-chat-image-use" disabled={using} onClick={() => void attachToArtifact()} type="button">{using ? "Attaching…" : "Use in artifact"}</button> : null}
      {canSave ? <FileActionsMenuV2 attachmentId={attachmentId} fileName={label} /> : null}</figcaption> : null}
    {useFailed ? <p role="status">Could not attach this image. Try again.</p> : null}
    {open ? <ChatImageViewerV2 attachmentId={attachmentId} label={label} onClose={() => setOpen(false)} /> : null}
  </figure>;
}
