"use client";

import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";

type Props = Readonly<{
  children(initialFocusRef: RefObject<HTMLButtonElement | null>): ReactNode;
  compact: boolean;
  expanded: boolean;
  host: "chat" | "library" | "page";
  onClose(): void;
  title: string;
}>;

/** Keep the iframe in one body portal; reparenting a live iframe resets its browsing context. */
export function ArtifactViewerFrameV2({ children, compact, expanded, host, onClose, title }: Props) {
  const modal = compact || expanded;
  const dockRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const { dialogRef, initialFocusRef, onDialogKeyDown, portalReady } = useModalLayerV2({ enabled: modal, onClose });

  useLayoutEffect(() => {
    if (!portalReady || host === "page") return;
    const dock = dockRef.current;
    const layer = layerRef.current;
    if (!dock || !layer) return;
    const position = () => {
      const rect = dock.getBoundingClientRect();
      Object.assign(layer.style, modal
        ? { left: "0", top: "0", width: "100%", height: "100dvh" }
        : { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    };
    position();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    observer?.observe(dock);
    if (dock.parentElement) observer?.observe(dock.parentElement);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [host, modal, portalReady]);

  if (host === "page") return children(initialFocusRef);
  return <>
    <div aria-hidden="true" className={`v2-artifact-dock${host === "chat" ? " v2-live-artifact-panel" : ""}`}
      data-compact={compact || undefined} ref={dockRef} />
    {portalReady ? createPortal(<div className="v2-artifact-host-layer" data-host={host}
      data-mode={modal ? "modal" : "docked"} ref={layerRef}>
      <section aria-label={`Artifact: ${title}`} aria-modal={modal || undefined} className="v2-artifact-host"
        data-artifact-panel={host === "chat" || undefined} ref={dialogRef} role={modal ? "dialog" : host === "chat" ? "complementary" : undefined}
        tabIndex={-1} onKeyDown={event => {
          if (modal) onDialogKeyDown(event);
          else if (host === "chat" && event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); }
        }}>
        {children(initialFocusRef)}
      </section>
    </div>, document.body) : null}
  </>;
}
