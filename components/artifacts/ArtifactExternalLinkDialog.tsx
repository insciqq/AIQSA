"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { UiV2Button } from "@/components/ui-v2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import { artifactLinkCarriesData } from "@/lib/contracts/artifactRuntime";

export function ArtifactExternalLinkDialog({ href, onClose }: { href: string; onClose(): void }) {
  const { dialogRef, initialFocusRef, onDialogKeyDown, portalReady } = useModalLayerV2({ onClose });
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const url = new URL(href);
  const userInfoLength = url.username || url.password ? url.username.length + (url.password ? url.password.length + 1 : 0) + 1 : 0;
  const hostStart = url.host ? href.indexOf("//") + 2 + userInfoLength : -1;
  async function copyAddress() {
    try { await navigator.clipboard.writeText(href); setCopy("copied"); }
    catch { setCopy("failed"); }
  }
  if (!portalReady) return null;
  return createPortal(<div className="v2-artifact-share-layer v2-artifact-link-layer" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section aria-label="Open external link?" aria-modal="true" className="v2-artifact-share" onKeyDown={onDialogKeyDown} ref={dialogRef} role="dialog">
      <div className="v2-artifact-share-section">
        <h2 className="v2-artifact-link-title">Open external link?</h2>
        <p>This link was created by the artifact. AIQSA doesn’t control the destination.</p>
        <div aria-label="Full link address" className="v2-artifact-link-address v2-focusable" tabIndex={0}>
          <code>{hostStart >= 0 ? <>{href.slice(0, hostStart)}<strong>{url.host}</strong>{href.slice(hostStart + url.host.length)}</> : href}</code>
        </div>
        {artifactLinkCarriesData(href) ? <p className="v2-artifact-link-warning">This link carries additional data in its address.</p> : null}
        <div className="v2-artifact-share-actions">
          <UiV2Button onClick={() => { window.open(href, "_blank", "noopener,noreferrer"); onClose(); }} tone="primary" type="button">Open link</UiV2Button>
          <UiV2Button icon={copy === "copied" ? "check" : "copy"} onClick={() => void copyAddress()} type="button">{copy === "copied" ? "Copied" : "Copy address"}</UiV2Button>
          <UiV2Button onClick={onClose} ref={initialFocusRef} tone="ghost" type="button">Cancel</UiV2Button>
        </div>
        {copy === "failed" ? <p role="status">Select the address and copy it manually.</p> : null}
      </div>
    </section>
  </div>, document.body);
}
