"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import type { ArtifactDetail } from "@/lib/contracts/artifacts";
import type { ArtifactRuntimeError } from "@/lib/contracts/artifactRuntime";
import { UiV2Button, UiV2Icon, UiV2IconButton, UiV2MenuItem, UiV2MenuLink } from "@/components/ui-v2";
import { UiV2ResponsiveMenu } from "@/components/ui-v2/ResponsiveMenuV2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { PrivateArtifactView } from "./PrivateArtifactView";
import { ArtifactCodeV2 } from "./ArtifactCodeV2";
import { ArtifactShareDialog } from "./ArtifactShareDialog";
import { ArtifactViewerFrameV2 } from "./ArtifactViewerFrameV2";
import { artifactRequest, loadArtifactDetail, loadArtifactVersionPage } from "./artifactClient";
import { artifactKindIcon } from "./artifactPresentation";
import { resetArtifactSavedState } from "./artifactBrowserStorage";

export type ArtifactViewerV2Props = Readonly<{
  artifactId: string;
  versionId: string;
  host: "chat" | "library" | "page";
  compact?: boolean;
  onVersionChange(versionId: string): void;
  onEditRequest(intent: "edit" | "runtime_error", error?: ArtifactRuntimeError): void | Promise<void>;
  onClose?(): void;
  onOpenSourceChat?(chatId: string): void | Promise<void>;
  onDetailChange?(detail: ArtifactDetail): void;
  updatedVersionNumber?: number | null;
}>;

function VersionMenu({ busy, detail, onChange, onMore, versionId }: {
  busy: boolean;
  detail: ArtifactDetail | null;
  onChange(versionId: string): void;
  onMore(): void;
  versionId: string;
}) {
  const [open, setOpen] = useState(false);
  const { closeForAction, menuRef, triggerRef } = useMenuDismissalV2({ open, onClose: () => setOpen(false) });
  const selected = detail?.versions.find(version => version.id === versionId);
  return <div className="v2-artifact-version-control">
    <UiV2Button aria-expanded={open} aria-haspopup="menu" aria-label={selected ? `Version v${selected.versionNumber}` : "Version"} disabled={busy || !detail} onClick={() => setOpen(value => !value)} ref={triggerRef} type="button">
      {selected ? `v${selected.versionNumber}` : "Version"}<UiV2Icon name="chevron-down" />
    </UiV2Button>
    {open && detail ? <UiV2ResponsiveMenu anchorRef={triggerRef} className="v2-artifact-menu" label="Artifact versions" menuRef={menuRef} onClose={() => setOpen(false)}>
      {[...detail.versions].sort((a, b) => b.versionNumber - a.versionNumber).map(version => <UiV2MenuItem key={version.id} selected={version.id === versionId} onClick={() => { closeForAction(); onChange(version.id); }} type="button">
        v{version.versionNumber}{version.id === detail.currentVersionId ? " · current" : version.createdAt ? ` · ${new Date(version.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}
      </UiV2MenuItem>)}
      {detail.versionsNextCursor ? <UiV2MenuItem disabled={busy} onClick={onMore} type="button">Load more versions</UiV2MenuItem> : null}
    </UiV2ResponsiveMenu> : null}
  </div>;
}

function MoreMenu({ artifactId, busy, host, onOpenSourceChat, onReset, sourceChatId, versionId }: {
  artifactId: string;
  busy: boolean;
  host: ArtifactViewerV2Props["host"];
  onOpenSourceChat?(chatId: string): void;
  onReset(): void;
  sourceChatId: string | null;
  versionId: string;
}) {
  const [open, setOpen] = useState(false);
  const { closeForAction, menuRef, triggerRef } = useMenuDismissalV2({ open, onClose: () => setOpen(false) });
  const contentPath = `/api/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/content`;
  return <div className="v2-artifact-more-control">
    <UiV2IconButton aria-expanded={open} aria-haspopup="menu" icon="more" label="Artifact actions" onClick={() => setOpen(value => !value)} ref={triggerRef} />
    {open ? <UiV2ResponsiveMenu anchorRef={triggerRef} className="v2-artifact-menu" label="Artifact actions" menuRef={menuRef} onClose={() => setOpen(false)}>
      <UiV2MenuLink download href={`${contentPath}?download=zip`} icon="download" onClick={closeForAction} role="menuitem">Download ZIP (all files)</UiV2MenuLink>
      <UiV2MenuLink download href={`${contentPath}?download=file`} icon="file" onClick={closeForAction} role="menuitem">Download main file</UiV2MenuLink>
      <UiV2MenuItem disabled={busy} onClick={() => { closeForAction(); onReset(); }} type="button">Reset saved state</UiV2MenuItem>
      {host !== "page" ? <UiV2MenuLink href={`/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}`} icon="external" onClick={closeForAction} rel="noreferrer" role="menuitem" target="_blank">Open in new tab</UiV2MenuLink> : null}
      {host !== "chat" && sourceChatId ? onOpenSourceChat
        ? <UiV2MenuItem disabled={busy} icon="chat" onClick={() => { closeForAction(); onOpenSourceChat(sourceChatId); }} type="button">Open source chat</UiV2MenuItem>
        : <UiV2MenuLink href={`/?chat=${encodeURIComponent(sourceChatId)}`} icon="chat" onClick={closeForAction} role="menuitem">Open source chat</UiV2MenuLink> : null}
    </UiV2ResponsiveMenu> : null}
  </div>;
}

export function ArtifactViewerV2(props: ArtifactViewerV2Props) {
  return <ArtifactViewer key={props.artifactId} {...props} />;
}

function ArtifactViewer({ artifactId, versionId, host, compact = false, onClose, onDetailChange, onEditRequest, onOpenSourceChat, onVersionChange, updatedVersionNumber }: ArtifactViewerV2Props) {
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [shareTarget, setShareTarget] = useState<{ versionId: string; versionNumber: number } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [reload, setReload] = useState(0);
  const [dismissedUpdate, setDismissedUpdate] = useState<string | null>(null);
  const mutation = useRef(false);
  const mounted = useRef(true);
  const expandRef = useRef<HTMLButtonElement>(null);
  const wasExpanded = useRef(false);
  const detailCallback = useRef(onDetailChange);
  const id = useId();
  useEffect(() => { detailCallback.current = onDetailChange; }, [onDetailChange]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    void loadArtifactDetail(artifactId, controller.signal, versionId).then(value => {
      if (controller.signal.aborted) return;
      setDetail(value); setLoadError(null); detailCallback.current?.(value);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "Could not load version history.");
    });
    return () => controller.abort();
  }, [artifactId, versionId, reload]);
  useEffect(() => {
    if (host === "page" && detail) document.title = `${detail.title} · AIQSA`;
  }, [detail, host]);
  useEffect(() => {
    if (wasExpanded.current && !expanded) expandRef.current?.focus();
    wasExpanded.current = expanded;
  }, [expanded]);

  const selected = detail?.versions.find(version => version.id === versionId);
  const current = detail?.currentVersionId === versionId;
  const currentVersion = detail?.versions.find(version => version.id === detail.currentVersionId);
  const title = detail?.title ?? "Artifact";
  const updateKey = updatedVersionNumber ? `${versionId}:${updatedVersionNumber}` : null;
  const refresh = () => setReload(value => value + 1);
  async function mutate(action: () => Promise<void> | void) {
    if (mutation.current) return;
    mutation.current = true; setBusy(true); setNotice(null);
    try { await action(); }
    catch (error) { if (mounted.current) setNotice(error instanceof Error ? error.message : "The request could not finish."); }
    finally { mutation.current = false; if (mounted.current) setBusy(false); }
  }
  async function restore() {
    await artifactRequest(`/api/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/restore`, { method: "POST" });
    if (mounted.current) { setNotice(`v${selected?.versionNumber} is now the current version.`); refresh(); }
  }
  function changeVersion(next: string) { setNotice(null); onVersionChange(next); }
  async function moreVersions() {
    if (!detail?.versionsNextCursor) return;
    const page = await loadArtifactVersionPage(artifactId, { cursor: detail.versionsNextCursor });
    if (mounted.current) setDetail(current => current ? { ...current, versionsNextCursor: page.nextCursor,
      versions: [...current.versions, ...page.versions.filter(version => !current.versions.some(item => item.id === version.id))] } : current);
  }

  function viewer(initialFocusRef: RefObject<HTMLButtonElement | null>) {
    return <div className="v2-artifact-viewer" data-host={host} onClickCapture={() => { if (updateKey) setDismissedUpdate(updateKey); }}>
      <div aria-label="Artifact controls" className="v2-artifact-toolbar">
        {host === "page" ? <Link aria-label="All artifacts" className="v2-icon-button v2-focusable v2-artifact-leading" href="/?library=artifacts" title="All artifacts"><UiV2Icon name="brand" /></Link> : null}
        {host === "chat" && onClose ? <UiV2IconButton className="v2-artifact-close" icon="close" label="Close artifact" onClick={onClose} ref={compact && !expanded ? initialFocusRef : undefined} /> : null}
        <div className="v2-artifact-title">{selected ? <UiV2Icon name={artifactKindIcon(selected.kind)} /> : null}<h2 title={title}>{title}</h2></div>
        <VersionMenu busy={busy} detail={detail} onChange={changeVersion} onMore={() => void mutate(moreVersions)} versionId={versionId} />
        <div aria-label="Artifact view" className="v2-artifact-tabs" role="tablist" onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? "preview" : event.key === "End" ? "code" : tab === "preview" ? "code" : "preview";
          setTab(next); document.getElementById(`${id}-${next}-tab`)?.focus();
          if (updateKey) setDismissedUpdate(updateKey);
        }}>
          {(["preview", "code"] as const).map(value => <button aria-controls={`${id}-${value}`} aria-selected={tab === value} className="v2-artifact-tab v2-focusable" id={`${id}-${value}-tab`} key={value} onClick={() => setTab(value)} role="tab" tabIndex={tab === value ? 0 : -1} type="button">{value === "preview" ? "Preview" : "Code"}</button>)}
        </div>
        <div className="v2-artifact-primary-actions">
          <UiV2Button busy={busy} disabled={!selected || !current} icon="edit" onClick={() => void mutate(() => onEditRequest("edit"))} title={!current ? "Restore this version to edit it" : undefined} type="button">Edit with AI</UiV2Button>
          <UiV2Button disabled={busy || !selected} icon="share" onClick={() => { if (selected) setShareTarget({ versionId: selected.id, versionNumber: selected.versionNumber }); }} type="button">Share</UiV2Button>
        </div>
        <MoreMenu artifactId={artifactId} busy={busy} host={host}
          onReset={() => void mutate(async () => setNotice(await resetArtifactSavedState(artifactId) ? "Saved state reset for this artifact." : "Could not clear saved state in this browser. This preview has been reset."))}
          onOpenSourceChat={onOpenSourceChat ? chatId => void mutate(() => onOpenSourceChat(chatId)) : undefined}
          sourceChatId={detail?.sourceChatId ?? null} versionId={versionId} />
        {host !== "page" ? <UiV2IconButton className="v2-artifact-expand" icon={expanded ? "collapse" : "expand"} label={expanded ? "Collapse artifact" : "Expand artifact"} onClick={() => setExpanded(value => !value)} ref={expanded ? initialFocusRef : expandRef} /> : null}
      </div>
      {selected && currentVersion && !current ? <div className="v2-artifact-banner">
        <span>You’re viewing v{selected.versionNumber}. The current version is v{currentVersion.versionNumber}.</span>
        <UiV2Button busy={busy} onClick={() => void mutate(restore)} type="button">Restore v{selected.versionNumber}</UiV2Button>
        <UiV2Button disabled={busy} onClick={() => changeVersion(currentVersion.id)} type="button">Back to current</UiV2Button>
      </div> : null}
      {notice ? <div className="v2-artifact-banner" role="status"><span>{notice}</span></div> : null}
      {updateKey && dismissedUpdate !== updateKey ? <div className="v2-artifact-banner" role="status">Updated to v{updatedVersionNumber}</div> : null}
      {loadError ? <div className="v2-artifact-empty" role="alert"><p>{loadError}</p><UiV2Button onClick={() => { setLoadError(null); refresh(); }} type="button">Retry</UiV2Button></div> : detail && !selected ? <div className="v2-artifact-empty" role="alert"><p>This version is unavailable.</p>{currentVersion ? <UiV2Button onClick={() => changeVersion(currentVersion.id)} type="button">Back to current</UiV2Button> : null}</div> : <>
        <section aria-labelledby={`${id}-preview-tab`} className="v2-artifact-tabpanel" hidden={tab !== "preview"} id={`${id}-preview`} role="tabpanel">
          <PrivateArtifactView key={versionId} artifactId={artifactId} versionId={versionId}
            onEscape={() => { if (expanded) setExpanded(false); else if (host === "chat" || host === "library") onClose?.(); }}
            onFix={error => void mutate(() => onEditRequest("runtime_error", error))} fixDisabled={!current || busy} />
        </section>
        <section aria-labelledby={`${id}-code-tab`} className="v2-artifact-tabpanel" hidden={tab !== "code"} id={`${id}-code`} role="tabpanel">
          {tab === "code" ? <ArtifactCodeV2 key={versionId} artifactId={artifactId} versionId={versionId} /> : null}
        </section>
      </>}
      {shareTarget ? <ArtifactShareDialog artifactId={artifactId} {...shareTarget} onClose={() => setShareTarget(null)} onPublished={refresh} /> : null}
    </div>;
  }
  return <ArtifactViewerFrameV2 compact={compact} expanded={expanded} host={host}
    onClose={() => { if (expanded) setExpanded(false); else onClose?.(); }} title={title}>{viewer}</ArtifactViewerFrameV2>;
}
