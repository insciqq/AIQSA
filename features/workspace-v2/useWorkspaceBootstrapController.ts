"use client";

import {
  chatIdFromComposerSessionKey,
  folderIdFromComposerSessionKey,
  selectComposerSession,
  useComposerSessionStore
} from "@/components/app-shell/composerSessionStore";
import {
  useComposerControlStore,
  type ComposerControlSnapshot
} from "@/components/app-shell/composerControlStore";
import {
  resolveModelControlDefaults,
  resolvePreferredSearchPlan
} from "@/components/app-shell/powerAppShellData";
import { shellFetch } from "@/components/app-shell/shellApi";
import { errorMessage } from "@/components/app-shell/shellFormatting";
import {
  clearSessionExpiredDraft,
  storedSessionExpiredDraft
} from "@/components/app-shell/shellStorage";
import type { Catalog, ChatDetail } from "@/components/app-shell/types";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import type { useWorkspaceActions } from "@/components/app-shell/workspaceActions";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import { decodeCatalogResponse } from "@/lib/contracts/catalog";
import { useEffect, useMemo, useRef } from "react";

type ComposerControlState = ReturnType<typeof useComposerControlStore.getState>;
type WorkspaceActions = ReturnType<typeof useWorkspaceActions>;
type WorkspaceState = ReturnType<typeof useWorkspaceStore.getState>;

export function workspaceDefaultControlsFingerprint(state: ComposerControlSnapshot): string {
  return JSON.stringify({
    backgroundMode: state.backgroundMode,
    maxOutputTokens: state.maxOutputTokens,
    knowledgePlanSource: state.knowledgePlanSource,
    reasoningEffort: state.reasoningEffort,
    reasoningMode: state.reasoningMode,
    selectedAssistantId: state.selectedAssistant?.id ?? null,
    selectedKnowledgeBaseIds: state.selectedKnowledgeBaseIds,
    selectedModelId: state.selectedModelId,
    selectedProvider: state.selectedProvider,
    selectedSearchOptionIds: state.selectedSearchOptionIds,
    searchPlanMode: state.searchPlanMode,
    streamMode: state.streamMode,
    temperature: state.temperature
  });
}

export function runCatalogLoadDeduped<T>({
  getLoadedCatalog,
  load,
  requestRef
}: {
  getLoadedCatalog(): T | null;
  load(): Promise<T | null>;
  requestRef: { current: Promise<T | null> | null };
}): Promise<T | null> {
  const loadedCatalog = getLoadedCatalog();
  if (loadedCatalog) {
    return Promise.resolve(loadedCatalog);
  }
  if (requestRef.current) {
    return requestRef.current;
  }

  const request = load();
  requestRef.current = request;
  const clear = () => {
    if (requestRef.current === request) {
      requestRef.current = null;
    }
  };
  void request.then(clear, clear);
  return request;
}

export function useWorkspaceBootstrapController({
  accountEmail,
  accountId,
  activateBlankWorkspace,
  applyControlDefaults,
  reapplyActiveChatDefaults,
  refreshWorkspace,
  setCatalog,
  setCatalogError,
  setSelectedModelId,
  setSelectedProvider,
  setSelectedSearchPlan,
  setShowCitations,
  setShowReasoningBlocks,
  workspaceRefreshPromiseRef
}: Readonly<{
  accountEmail: string | null;
  accountId: string;
  activateBlankWorkspace: WorkspaceActions["activateBlankWorkspace"];
  applyControlDefaults: ComposerControlState["applyControlDefaults"];
  reapplyActiveChatDefaults: WorkspaceActions["reapplyActiveChatDefaults"];
  refreshWorkspace: WorkspaceActions["refreshWorkspace"];
  setCatalog: WorkspaceState["setCatalog"];
  setCatalogError: WorkspaceState["setCatalogError"];
  setSelectedModelId: ComposerControlState["setSelectedModelId"];
  setSelectedProvider: ComposerControlState["setSelectedProvider"];
  setSelectedSearchPlan: ComposerControlState["setSelectedSearchPlan"];
  setShowCitations: ComposerControlState["setShowCitations"];
  setShowReasoningBlocks: ComposerControlState["setShowReasoningBlocks"];
  workspaceRefreshPromiseRef: { current: Promise<ChatDetail | null> | null };
}>) {
  const scope = useMemo(() => ({
    token: Symbol(accountId),
    request: { current: null as Promise<Catalog | null> | null }
  }), [accountId]);
  const activeScopeRef = useRef<symbol | null>(scope.token);
  const currentCatalog = () => {
    const workspace = useWorkspaceStore.getState();
    return workspace.catalogAccountId === accountId ? workspace.catalog : null;
  };

  const loadCatalog = useEventCallback((): Promise<Catalog | null> => {
    return runCatalogLoadDeduped({
      getLoadedCatalog: currentCatalog,
      load: async () => {
        setCatalogError(null);
        try {
          const response = await shellFetch("/api/me/catalog");
          if (!response.ok) {
            throw new Error("catalog_unavailable");
          }

          const nextCatalog = decodeCatalogResponse(await response.json());
          if (!nextCatalog) {
            throw new Error("catalog_malformed");
          }

          if (activeScopeRef.current !== scope.token) {
            return null;
          }

          const defaultModel =
            nextCatalog.models.find(
              (model) =>
                model.provider === nextCatalog.defaults.provider && model.modelId === nextCatalog.defaults.modelId
            );
          setCatalog(nextCatalog, accountId);
          setCatalogError(null);
          setSelectedProvider(defaultModel?.provider ?? "", "system");
          setSelectedModelId(defaultModel?.modelId ?? "", "system");
          const defaultSearchPlan = resolvePreferredSearchPlan(
            nextCatalog.defaults.searchPlan,
            nextCatalog.searchStrategies
          );
          setSelectedSearchPlan(defaultSearchPlan.optionIds, defaultSearchPlan.mode, "system");
          setShowCitations(nextCatalog.defaults.showCitations);
          setShowReasoningBlocks(nextCatalog.defaults.showReasoningBlocks);
          if (defaultModel) {
            const defaults = resolveModelControlDefaults(defaultModel, nextCatalog.defaults.controlValues);
            applyControlDefaults(defaults);
          }
          return nextCatalog;
        } catch (error) {
          if (activeScopeRef.current === scope.token) {
            setCatalogError(errorMessage(error));
          }
          return null;
        }
      },
      requestRef: scope.request
    });
  });
  const refreshWorkspaceEvent = useEventCallback(refreshWorkspace);
  const activateBlankWorkspaceEvent = useEventCallback(activateBlankWorkspace);
  const retryWorkspace = useEventCallback(() =>
    refreshWorkspaceEvent(useWorkspaceStore.getState().activeChatId, {
      catalogOverride: useWorkspaceStore.getState().catalog
    })
  );
  const retryCatalog = useEventCallback(async () => {
    if (currentCatalog()) {
      return;
    }

    const loadedCatalog = await loadCatalog();
    if (!loadedCatalog || activeScopeRef.current !== scope.token) {
      return;
    }

    const activeChatIdBeforeRefresh = useWorkspaceStore.getState().activeChatId;
    const controlsBeforeRefresh = workspaceDefaultControlsFingerprint(useComposerControlStore.getState());
    const pendingWorkspaceRefresh = workspaceRefreshPromiseRef.current;
    await refreshWorkspaceEvent(activeChatIdBeforeRefresh, {
      catalogOverride: loadedCatalog
    });
    if (
      pendingWorkspaceRefresh &&
      activeScopeRef.current === scope.token &&
      useWorkspaceStore.getState().activeChatId === activeChatIdBeforeRefresh &&
      workspaceDefaultControlsFingerprint(useComposerControlStore.getState()) === controlsBeforeRefresh
    ) {
      reapplyActiveChatDefaults(loadedCatalog);
    }
  });

  useEffect(() => {
    activeScopeRef.current = scope.token;
    if (useWorkspaceStore.getState().catalogAccountId !== accountId) setCatalog(null, accountId);

    async function bootstrap() {
      const recoveredDraft = storedSessionExpiredDraft();
      const ownedRecoveredDraft = recoveredDraft?.accountEmail === accountEmail
        ? recoveredDraft
        : null;
      if (recoveredDraft && !ownedRecoveredDraft) {
        clearSessionExpiredDraft();
      }
      const recoveredChatId = ownedRecoveredDraft
        ? chatIdFromComposerSessionKey(ownedRecoveredDraft.sessionKey)
        : null;
      const loadedCatalog = await loadCatalog();
      if (activeScopeRef.current === scope.token) {
        await refreshWorkspaceEvent(
          recoveredChatId ?? useWorkspaceStore.getState().activeChatId,
          {
            catalogOverride: loadedCatalog
          }
        );
      }
      if (activeScopeRef.current !== scope.token || !ownedRecoveredDraft) {
        return;
      }

      const recoveredFolderId = folderIdFromComposerSessionKey(ownedRecoveredDraft.sessionKey);
      if (recoveredFolderId) {
        if (!useWorkspaceStore.getState().folders.some((folder) => folder.id === recoveredFolderId)) {
          clearSessionExpiredDraft();
          return;
        }
        activateBlankWorkspaceEvent(recoveredFolderId);
      } else if (!recoveredChatId) {
        activateBlankWorkspaceEvent();
      } else if (!useWorkspaceStore.getState().chats.some((chat) => chat.id === recoveredChatId)) {
        clearSessionExpiredDraft();
        return;
      }

      const composerState = useComposerSessionStore.getState();
      const target = selectComposerSession(composerState, ownedRecoveredDraft.sessionKey);
      if (!target.draft && !target.pendingSend && !target.pendingEdit) {
        composerState.updateSession(ownedRecoveredDraft.sessionKey, {
          draft: ownedRecoveredDraft.draft
        });
      }
      clearSessionExpiredDraft();
    }

    void bootstrap();

    return () => {
      activeScopeRef.current = null;
    };
  }, [accountEmail, accountId, activateBlankWorkspaceEvent, loadCatalog, refreshWorkspaceEvent, scope, setCatalog]);

  return { activateBlankWorkspaceEvent, retryCatalog, retryWorkspace };
}
