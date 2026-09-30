import { clampedNumber, defaultParameterControls } from "@/components/app-shell/controlDefaults";
import type { ComposerContextStats } from "@/components/app-shell/composerContextStats";
import {
  summarizeThreadArtifacts,
  textFromThreadContent
} from "@/components/app-shell/threadContent";
import { pdfProcessingForAttachment } from "@/components/app-shell/attachmentCapabilities";
import type { RunSurfaceSnapshot } from "@/components/app-shell/runSurfaceStore";
import type {
  Catalog,
  ChatContextStats,
  WorkspaceChatSummary,
  CatalogModel,
  FolderSummary,
  ThreadMessage
} from "@/components/app-shell/types";
import type { ComposerAttachment } from "@/components/app-shell/attachmentContracts";
import { calculateContextBudgetLimits, estimateApproxTokens } from "@/lib/domain/contextBudget";
import { STANDARD_CHAT_BASELINE_TEMPLATE } from "@/lib/domain/promptTemplates";
import { decodeSessionContextStatus } from "@/lib/contracts/sessionStatus";
import { pdfPageCountFromMetadata } from "@/lib/contracts/uploads";
import { isRecord } from "./shellValues";
import { useEffect, useMemo, useRef, useState } from "react";

type PowerAppShellViewModelInput = {
  activeChatId: string | null;
  activeChatStreaming: boolean;
  activeThreadContextStats?: ChatContextStats | null;
  attachments: ComposerAttachment[];
  catalog: Catalog | null;
  chats: WorkspaceChatSummary[];
  draft: string;
  contextConfigurationKey?: string;
  contextRejectionGeneration?: number | null;
  folders: FolderSummary[];
  maxOutputTokens: string;
  pendingChatFolderId: string | null;
  projectSettingsFolderId: string | null;
  renderActiveLeafId: string | null;
  runSurface: RunSurfaceSnapshot;
  selectedAssistantPromptCharacterCount: number | null;
  selectedSkillPromptCharacterCount?: number;
  selectedModelId: string;
  selectedProvider: string;
  visibleMessages: ThreadMessage[];
};

function metadataRecord(attachment: ComposerAttachment, key: string): Record<string, unknown> {
  const metadata = attachment.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return {};
  }

  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function providerAttachmentText(attachment: ComposerAttachment): string | null {
  if (!attachment.extractedText?.trim()) {
    return null;
  }

  const label =
    attachment.kind === "pdf"
      ? `Attached PDF: ${attachment.fileName}`
      : `Attached document: ${attachment.fileName} (${attachment.mimeType || "unknown type"})`;

  return `[${label}]\n${attachment.extractedText}`;
}

function imageProxyTokens(attachment: ComposerAttachment): number {
  const image = metadataRecord(attachment, "image");
  const width = numberValue(image.width);
  const height = numberValue(image.height);

  if (!width || !height) {
    return 512;
  }

  return 85 + Math.ceil(width / 512) * Math.ceil(height / 512) * 170;
}

function nativePdfProxyTokens(attachment: ComposerAttachment): number {
  const pageCount = pdfPageCountFromMetadata({ pdfPageCount: attachment.pageCount })
    ?? pdfPageCountFromMetadata({ pdfPageCount: pdfProcessingForAttachment(attachment)?.pageCount });
  const extractedTextTokens = attachment.extractedText?.trim() ? estimateApproxTokens(attachment.extractedText) : 0;
  const pageTokens = pageCount ? pageCount * 512 : 0;
  const fallbackByteTokens =
    !pageTokens && !extractedTextTokens ? Math.ceil(Math.max(attachment.byteSize ?? 1, 1) / 4096) * 256 : 0;

  return Math.max(256, extractedTextTokens + pageTokens, fallbackByteTokens);
}

function stagedAttachmentTokens(attachments: ComposerAttachment[], model: CatalogModel | undefined, limit: number): number {
  return attachments.reduce((total, attachment) => {
    if (attachment.kind === "image") {
      return model?.capabilities.imageInput ? Math.min(limit, total + imageProxyTokens(attachment)) : total;
    }

    if (attachment.kind === "pdf") {
      if (model?.capabilities.documentInputMode === "native_pdf") {
        return Math.min(limit, total + nativePdfProxyTokens(attachment));
      }

      if (model?.capabilities.documentInputMode !== "pdf_text_extraction") {
        return total;
      }
    }

    const text = providerAttachmentText(attachment);
    return Math.min(limit, total + (text ? estimateApproxTokens(text) : 0));
  }, 0);
}

export function usePowerAppShellViewModel({
  activeChatId,
  activeChatStreaming,
  activeThreadContextStats = null,
  attachments,
  catalog,
  chats,
  draft,
  contextConfigurationKey,
  contextRejectionGeneration = null,
  folders,
  maxOutputTokens,
  projectSettingsFolderId,
  renderActiveLeafId,
  runSurface,
  selectedAssistantPromptCharacterCount,
  selectedSkillPromptCharacterCount = 0,
  selectedModelId,
  selectedProvider,
  visibleMessages
}: PowerAppShellViewModelInput) {
  const { events: runEvents } = runSurface;
  const currentModel = useMemo(
    () => catalog?.models.find((model) => model.provider === selectedProvider && model.modelId === selectedModelId),
    [catalog, selectedModelId, selectedProvider]
  );
  const currentParameterControls = useMemo(() => defaultParameterControls(currentModel), [currentModel]);
  const threadFollowKey = useMemo(() => {
    const tail = visibleMessages.at(-1);

    return [
      activeChatId ?? "blank",
      renderActiveLeafId ?? "none",
      visibleMessages.length,
      tail?.id ?? "none",
      tail ? textFromThreadContent(tail.content).length : 0,
      tail?.status ?? "none",
      runEvents.length
    ].join(":");
  }, [activeChatId, renderActiveLeafId, runEvents.length, visibleMessages]);
  const threadReadingAnchorKey = useMemo(() => {
    const tail = visibleMessages.at(-1);
    if (tail?.role !== "assistant" || tail.status !== "streaming") {
      return null;
    }

    const userTurnStart = tail.parentMessageId
      ? visibleMessages.find(
          (message) => message.id === tail.parentMessageId && message.role === "user"
        )
      : null;

    return userTurnStart?.id ?? tail.id;
  }, [visibleMessages]);
  const activeChat = useMemo(() => chats.find((chat) => chat.id === activeChatId) ?? null, [activeChatId, chats]);
  const liveArtifactSummary = useMemo(
    () => summarizeThreadArtifacts(runEvents),
    [runEvents]
  );
  const projectSettingsFolder = folders.find((folder) => folder.id === projectSettingsFolderId) ?? null;
  const activeChatTitle = activeChat?.title ?? "New Chat";
  const composerDisabledHint =
    catalog && catalog.models.length === 0
      ? "No model access. Ask an admin to grant model access."
      : catalog && !currentModel
        ? "Select an available model before sending."
        : null;
  const currentContextWindow =
    currentModel && typeof currentModel.contextWindow === "number" &&
        Number.isFinite(currentModel.contextWindow) && currentModel.contextWindow > 0
      ? Math.floor(currentModel.contextWindow)
      : 0;
  const selectedMaxOutputTokens = Math.round(
    clampedNumber(
      maxOutputTokens,
      currentParameterControls.maxOutputTokens.defaultValue,
      1,
      currentParameterControls.maxOutputTokens.maxValue
    )
  );
  const contextLimits = useMemo(() => currentContextWindow
    ? calculateContextBudgetLimits({
        contextWindow: currentContextWindow,
        maxOutputTokens: selectedMaxOutputTokens,
        provider: currentModel?.providerFamily
      })
    : null, [currentContextWindow, currentModel?.providerFamily, selectedMaxOutputTokens]);
  // Rejection applies only to the exact attempted inputs, including its draft.
  const requestInputKey = JSON.stringify({
    activeChatId, attachments, draft, renderActiveLeafId, contextConfigurationKey,
    selectedAssistantPromptCharacterCount, selectedMaxOutputTokens,
    selectedModelId, selectedProvider, selectedSkillPromptCharacterCount
  });
  const lastAssistant = [...visibleMessages].reverse().find((message) => message.role === "assistant");
  const sourceKey = JSON.stringify([activeChatId, lastAssistant?.id ?? null]);
  const liveStartIndex = runEvents.reduce((last, event, index) => event.type === "message_start" ? index : last, -1);
  const liveStartData = isRecord(runEvents[liveStartIndex]?.data) ? runEvents[liveStartIndex]!.data : null;
  const liveSource = isRecord(liveStartData) && liveStartData.assistantMessageId === lastAssistant?.id;
  const [rejectedSource, setRejectedSource] = useState({ sourceKey, rejected: contextRejectionGeneration !== null });
  if (rejectedSource.sourceKey !== sourceKey) {
    setRejectedSource({ sourceKey, rejected: contextRejectionGeneration !== null });
  } else if (contextRejectionGeneration !== null && !rejectedSource.rejected) {
    setRejectedSource({ ...rejectedSource, rejected: true });
  }
  // The description only; the server-owned measured base never depends on it.
  // A send from this page binds the exact submitted controls to its answer.
  const sendBound = Boolean(lastAssistant && runSurface.contextConfigurationKey &&
    runSurface.contextMessageId === lastAssistant.id);
  // Otherwise (reload, cache eviction, another branch) the controls of the
  // historical run are unknown to the browser. The controls in place when the
  // user first interacts with the loaded chat stand for it, so defaults the
  // system applies while the chat loads never read as a change.
  const loadedSourceKey = lastAssistant ? sourceKey : null;
  const [interactionBaseline, setInteractionBaseline] =
    useState<{ sourceKey: string; configurationKey: string | undefined } | null>(null);
  if (interactionBaseline && interactionBaseline.sourceKey !== loadedSourceKey) {
    setInteractionBaseline(null);
  }
  const latestConfigurationRef = useRef({ configurationKey: contextConfigurationKey, sourceKey: loadedSourceKey });
  useEffect(() => {
    latestConfigurationRef.current = { configurationKey: contextConfigurationKey, sourceKey: loadedSourceKey };
  });
  useEffect(() => {
    // Capture phase: the baseline records the controls before the handler of
    // the control that the user is about to change runs.
    const recordBaseline = () => {
      const { configurationKey, sourceKey: loaded } = latestConfigurationRef.current;
      if (loaded === null) return;
      setInteractionBaseline((current) => current?.sourceKey === loaded ? current : { configurationKey, sourceKey: loaded });
    };
    const types = ["pointerdown", "keydown", "click"] as const;
    for (const type of types) document.addEventListener(type, recordBaseline, true);
    return () => {
      for (const type of types) document.removeEventListener(type, recordBaseline, true);
    };
  }, []);
  const baseline = interactionBaseline?.sourceKey === loadedSourceKey ? interactionBaseline : null;
  const unchangedConfiguration = sendBound
    ? runSurface.contextConfigurationKey === contextConfigurationKey
    : !baseline || baseline.configurationKey === contextConfigurationKey;
  const [rejection, setRejection] = useState({ contextRejectionGeneration, requestInputKey });
  if (rejection.contextRejectionGeneration !== contextRejectionGeneration) {
    setRejection({ contextRejectionGeneration, requestInputKey });
  }
  const requestRejected = contextRejectionGeneration !== null &&
    rejection.contextRejectionGeneration === contextRejectionGeneration && rejection.requestInputKey === requestInputKey;
  const sessionSnapshot = activeThreadContextStats?.session;
  const sessionMessageId = activeThreadContextStats?.sessionMessageId;
  const composerContextStats = useMemo<ComposerContextStats>(() => {
    const liveStatus = liveSource
      ? runEvents.slice(liveStartIndex + 1).reverse().find((event) => event.type === "artifact" && isRecord(event.data) && event.data.artifactType === "context_status")
      : undefined;
    const liveSnapshot = isRecord(liveStatus?.data)
      ? decodeSessionContextStatus(liveStatus.data.payload)
      : null;
    const onAnswerLeaf = Boolean(lastAssistant && lastAssistant.id === renderActiveLeafId);
    const persistedMatchesBranch = activeThreadContextStats?.sessionBranchLeafId
      ? activeThreadContextStats.sessionBranchLeafId === renderActiveLeafId
      : onAnswerLeaf && sessionMessageId === lastAssistant?.id;
    // Recovery may settle the answer after the browser loses its stream. Its
    // canonical final phase supersedes an earlier live request measurement.
    const settledSnapshot = persistedMatchesBranch && sessionMessageId === lastAssistant?.id &&
      sessionSnapshot?.phase === "after_answer" && liveSnapshot?.phase === "request"
      ? sessionSnapshot : null;
    const preferredLiveSnapshot = onAnswerLeaf && !settledSnapshot ? liveSnapshot : null;
    const rejectedBranch = rejectedSource.sourceKey === sourceKey && rejectedSource.rejected;
    const snapshot = !requestRejected && !rejectedBranch
      ? preferredLiveSnapshot ?? (persistedMatchesBranch ? sessionSnapshot : null)
      : null;
    const snapshotSource = preferredLiveSnapshot ? "live" : "persisted";
    const afterSnapshotTokens = snapshotSource === "persisted"
      ? activeThreadContextStats?.approximateInputTokensAfterSession ?? 0 : 0;
    // A draft can already exhaust the model window. Bound low-fidelity file
    // proxies to one full window while preserving the measured base unchanged.
    const deltaLimit = currentContextWindow || Number.MAX_SAFE_INTEGER;
    const draftInputTokens = Math.min(deltaLimit, estimateApproxTokens(draft.trim()) +
      stagedAttachmentTokens(attachments, currentModel, deltaLimit));
    if (snapshot) {
      const sameModelLimits = snapshot.modelId === (currentModel?.upstreamModelId ?? currentModel?.modelId) &&
        snapshot.provider === (currentModel?.providerFamily ?? currentModel?.provider) &&
        snapshot.contextWindow === (currentContextWindow || null) &&
        snapshot.maxOutputTokens === contextLimits?.maxOutputTokens &&
        snapshot.safetyMarginTokens === contextLimits?.safetyMarginTokens;
      const earlierSnapshot = snapshotSource === "persisted" &&
        (sessionMessageId !== lastAssistant?.id || afterSnapshotTokens > 0);
      return {
        approximateInputTokens: Math.min(Number.MAX_SAFE_INTEGER,
          snapshot.approximateInputTokens + afterSnapshotTokens + draftInputTokens),
        approximateInputTokensAfterSession: afterSnapshotTokens,
        basis: earlierSnapshot ? "preliminary" : unchangedConfiguration && sameModelLimits ? "measured" : "settings_changed",
        requestInFlight: snapshot.phase === "request" && (activeChatStreaming || lastAssistant?.status === "streaming"),
        snapshotSource,
        draftInputTokens,
        safeInputBudgetTokens: contextLimits?.budgetTokens ?? null,
        answerReserveTokens: contextLimits?.maxOutputTokens ?? null,
        safetyMarginTokens: contextLimits?.safetyMarginTokens ?? null,
        session: snapshot,
        totalContextTokens: currentContextWindow || null
      };
    }
    // Approximation only: the authoritative prompt is resolved server-side (the
    // standard-chat baseline or the selected Assistant definition). The raw
    // template stands in for the rendered baseline: substituting the live
    // clock/zone/locale here would make SSR and hydration disagree.
    const promptSystem = [
      selectedAssistantPromptCharacterCount === null
        ? STANDARD_CHAT_BASELINE_TEMPLATE
        : ""
    ]
      .filter((part): part is string => Boolean(part?.trim()))
      .join("\n\n");
    const promptTokens =
      estimateApproxTokens(promptSystem) +
      (selectedAssistantPromptCharacterCount !== null
        ? Math.ceil(selectedAssistantPromptCharacterCount / 4)
        : 0) +
      Math.ceil(selectedSkillPromptCharacterCount / 4);
    const branchTokens = activeThreadContextStats?.approximateActiveBranchInputTokens ??
      visibleMessages.reduce((total, message) => total + estimateApproxTokens(message.content), 0);
    const currentTokens = Math.min(Number.MAX_SAFE_INTEGER, promptTokens + branchTokens + draftInputTokens);

    return {
      approximateInputTokens: currentTokens,
      basis: "preliminary",
      answerReserveTokens: contextLimits?.maxOutputTokens ?? null,
      safetyMarginTokens: contextLimits?.safetyMarginTokens ?? null,
      safeInputBudgetTokens: contextLimits?.budgetTokens ?? null,
      requestRejected,
      totalContextTokens: currentContextWindow || null
    };
  }, [activeChatStreaming, activeThreadContextStats, attachments, contextLimits, currentContextWindow, currentModel, draft,
    lastAssistant, liveSource, liveStartIndex, rejectedSource, renderActiveLeafId, requestRejected, runEvents, selectedAssistantPromptCharacterCount, sourceKey,
    selectedSkillPromptCharacterCount, sessionMessageId, sessionSnapshot, unchangedConfiguration, visibleMessages]);
  return {
    activeChat,
    activeChatStreaming,
    activeChatTitle,
    composerDisabledHint,
    composerContextStats,
    currentModel,
    currentParameterControls,
    liveArtifactSummary,
    projectSettingsFolder,
    renderActiveLeafId,
    threadFollowKey,
    threadReadingAnchorKey,
    visibleMessages
  };
}
