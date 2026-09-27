"use client";

import { composerSessionKey, useComposerSessionStore } from "@/components/app-shell/composerSessionStore";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import { loadArtifactDetail, prepareArtifactEdit } from "@/components/artifacts/artifactClient";
import { setArtifactEditSession } from "@/components/artifacts/artifactEditSession";
import { openArtifactPanel } from "@/components/artifacts/artifactPanelStore";
import { consumeArtifactRuntimeError } from "@/components/artifacts/artifactRuntimeSession";
import { parseChatRoutePath } from "@/lib/domain/chatRoute";
import { useEffect, useRef } from "react";

const ARTIFACT_EDIT_PARAMETERS = ["artifactEdit", "artifactId", "versionId"] as const;

/**
 * The artifact page hands an edit, or a runtime-error fix, to its chat through
 * the chat's address (`…/c/<id>?artifactEdit=…&artifactId=…&versionId=…`).
 * Once the chat that address names is shown and loaded, the edit enters that
 * chat's composer and the one-shot parameters leave the address.
 */
export function useArtifactEditAddress(input: Readonly<{
  activeChatId: string | null;
  detailLoading: boolean;
  /** Whether the shown workspace is wide enough to dock the artifact beside the chat. */
  panelFits(): boolean;
}>): void {
  const { activeChatId, detailLoading } = input;
  const handledRef = useRef<string | null>(null);
  const panelFitsRef = useRef(input.panelFits);
  useEffect(() => {
    panelFitsRef.current = input.panelFits;
  });
  useEffect(() => {
    const url = new URL(window.location.href);
    const intent = url.searchParams.get("artifactEdit");
    if (intent !== "edit" && intent !== "runtime_error") return;
    const chatId = parseChatRoutePath(url.pathname)?.chatId ?? null;
    if (!chatId || activeChatId !== chatId || detailLoading) return;
    const artifactId = url.searchParams.get("artifactId")?.trim() ?? "";
    const versionId = url.searchParams.get("versionId")?.trim() ?? "";
    if (!artifactId || !versionId || /[\u0000-\u001f\u007f]/u.test(artifactId + versionId) || artifactId.length > 128 || versionId.length > 128) return;
    const requestKey = `${chatId}:${artifactId}:${versionId}:${intent}`;
    if (handledRef.current === requestKey) return;
    let active = true;
    const controller = new AbortController();
    void prepareArtifactEdit(artifactId, versionId, chatId)
      .then(() => loadArtifactDetail(artifactId, controller.signal, versionId))
      .then(detail => {
        if (!active || useWorkspaceStore.getState().activeChatId !== chatId) return;
        const version = detail.versions.find(candidate => candidate.id === versionId);
        if (!version) throw new Error("This artifact is no longer available.");
        handledRef.current = requestKey;
        setArtifactEditSession(chatId, { artifactId, versionId, title: detail.title, versionNumber: version.versionNumber }, intent,
          intent === "runtime_error" ? consumeArtifactRuntimeError(versionId) : undefined);
        if (panelFitsRef.current()) openArtifactPanel({ chatId, artifactId, versionId });
        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-testid="composer-v2"] textarea')?.focus({ preventScroll: true }));
        const current = new URL(window.location.href);
        for (const key of ARTIFACT_EDIT_PARAMETERS) current.searchParams.delete(key);
        window.history.replaceState(null, "", `${current.pathname}${current.search}${current.hash}`);
      })
      .catch((error: unknown) => {
        if (!active) return;
        useComposerSessionStore.getState().updateSession(composerSessionKey(chatId), {
          operationError: error instanceof Error ? error.message : "Could not prepare this artifact for editing."
        });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [activeChatId, detailLoading]);
}
