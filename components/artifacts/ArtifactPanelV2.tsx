"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ArtifactDetail } from "@/lib/contracts/artifacts";
import type { ArtifactRuntimeError } from "@/lib/contracts/artifactRuntime";
import type { ThreadGeneratedArtifact } from "@/lib/contracts/chats";
import { ArtifactViewerV2 } from "./ArtifactViewerV2";
import { closeArtifactPanel, selectArtifactPanelVersion, useArtifactPanelStore, type ArtifactPanelTarget, type SavedArtifactPanelTarget } from "./artifactPanelStore";
import { ArtifactGenerationPanelV2 } from "./ArtifactGenerationPanelV2";
import type { ArtifactGenerationDraft } from "./artifactGenerationState";

type Props = Readonly<{
  target: ArtifactPanelTarget;
  compact: boolean;
  latest: ThreadGeneratedArtifact | null;
  draft?: ArtifactGenerationDraft;
  onEdit(target: ThreadGeneratedArtifact, intent: "edit" | "runtime_error", error?: ArtifactRuntimeError): Promise<void>;
}>;

/** One viewer owns the fetched detail; the panel retains only selection/following intent. */
export function ArtifactPanelV2(props: Props) {
  const saved = props.draft?.artifact;
  useEffect(() => {
    const current = useArtifactPanelStore.getState().open;
    if (saved && props.target.draftId !== undefined && current?.chatId === props.target.chatId && current.draftId === props.target.draftId) {
      useArtifactPanelStore.setState({ open: { chatId: current.chatId, artifactId: saved.artifactId, versionId: saved.versionId } });
    }
  }, [props.target, saved]);
  if (props.target.draftId !== undefined) {
    return <ArtifactGenerationPanelV2 draft={props.draft} compact={props.compact} />;
  }
  return <SavedArtifactPanelV2 {...props} target={props.target} />;
}

function SavedArtifactPanelV2({ target, compact, latest, onEdit }: Omit<Props, "target"> & { target: SavedArtifactPanelTarget }) {
  const [title, setTitle] = useState(latest?.title ?? "Artifact");
  const [updatedVersionNumber, setUpdatedVersionNumber] = useState<number | null>(null);
  const detailRef = useRef<ArtifactDetail | null>(null);
  const lastSeenVersion = useRef(latest);
  const detailLoaded = useCallback((detail: ArtifactDetail) => {
    detailRef.current = detail;
    setTitle(detail.title);
  }, []);
  useEffect(() => {
    const previous = lastSeenVersion.current;
    if (!latest || previous && latest.versionNumber <= previous.versionNumber) return;
    lastSeenVersion.current = latest;
    if (!previous || previous.versionId === latest.versionId) return;
    const open = useArtifactPanelStore.getState().open;
    const previousCurrentVersionId = detailRef.current?.currentVersionId ?? previous.versionId;
    if (open?.artifactId !== latest.artifactId || previousCurrentVersionId !== open.versionId) return;
    selectArtifactPanelVersion(latest.versionId);
    setUpdatedVersionNumber(latest.versionNumber);
  }, [latest]);
  return <ArtifactViewerV2 artifactId={target.artifactId} versionId={target.versionId} compact={compact} host="chat"
    onClose={() => closeArtifactPanel()} onDetailChange={detailLoaded} updatedVersionNumber={updatedVersionNumber}
    onVersionChange={versionId => { setUpdatedVersionNumber(null); selectArtifactPanelVersion(versionId); }}
    onEditRequest={async (intent, error) => {
      const version = detailRef.current?.versions.find(version => version.id === target.versionId);
      if (!version) throw new Error("This artifact is no longer available.");
      await onEdit({ artifactId: target.artifactId, versionId: target.versionId, versionNumber: version.versionNumber,
        title: detailRef.current?.title ?? title, kind: version.kind, entrypoint: version.entrypoint }, intent, error);
    }} />;
}
