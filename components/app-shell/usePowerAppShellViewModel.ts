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
  ChatUsageStats,
  WorkspaceChatSummary,
  CatalogModel,
  FolderSummary,
  ThreadMessage
} from "@/components/app-shell/types";
import type { ComposerAttachment } from "@/components/app-shell/attachmentContracts";
import { calculateContextBudgetLimits, estimateApproxTokens } from "@/lib/domain/contextBudget";
import { STANDARD_CHAT_BASELINE_TEMPLATE } from "@/lib/domain/promptTemplates";
import { useMemo } from "react";

type PowerAppShellViewModelInput = {
  activeChatId: string | null;
  activeChatStreaming: boolean;
  activeThreadContextStats?: ChatContextStats | null;
  activeThreadUsageStats: ChatUsageStats | null;
  attachments: ComposerAttachment[];
  catalog: Catalog | null;
  chats: WorkspaceChatSummary[];
  draft: string;
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
  const pageCount = pdfProcessingForAttachment(attachment)?.pageCount ?? null;
  const extractedTextTokens = attachment.extractedText?.trim() ? estimateApproxTokens(attachment.extractedText) : 0;
  const pageTokens = pageCount ? pageCount * 512 : 0;
  const fallbackByteTokens =
    !pageTokens && !extractedTextTokens ? Math.ceil(Math.max(attachment.byteSize ?? 1, 1) / 4096) * 256 : 0;

  return Math.max(256, extractedTextTokens + pageTokens, fallbackByteTokens);
}

function stagedAttachmentTokens(attachments: ComposerAttachment[], model?: CatalogModel): number {
  return attachments.reduce((total, attachment) => {
    if (attachment.kind === "image") {
      return model?.capabilities.imageInput ? total + imageProxyTokens(attachment) : total;
    }

    if (attachment.kind === "pdf") {
      if (model?.capabilities.documentInputMode === "native_pdf") {
        return total + nativePdfProxyTokens(attachment);
      }

      if (model?.capabilities.documentInputMode !== "pdf_text_extraction") {
        return total;
      }
    }

    const text = providerAttachmentText(attachment);
    return total + (text ? estimateApproxTokens(text) : 0);
  }, 0);
}

export function usePowerAppShellViewModel({
  activeChatId,
  activeChatStreaming,
  activeThreadContextStats = null,
  activeThreadUsageStats,
  attachments,
  catalog,
  chats,
  draft,
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
  const safeInputBudget = currentContextWindow
    ? calculateContextBudgetLimits({
        contextWindow: currentContextWindow,
        maxOutputTokens: selectedMaxOutputTokens,
        provider: currentModel?.providerFamily
      }).budgetTokens
    : 0;
  const composerContextStats = useMemo<ComposerContextStats>(() => {
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
    const draftTokens = estimateApproxTokens({
      blocks: draft.trim()
        ? [
            {
              text: draft.trim(),
              type: "text"
            }
          ]
        : []
    });
    const attachmentTokens = stagedAttachmentTokens(attachments, currentModel);
    const currentTokens = promptTokens + branchTokens + draftTokens + attachmentTokens;

    return {
      approximateInputTokens: currentTokens,
      safeInputBudgetTokens: currentContextWindow ? safeInputBudget : null,
      totalContextTokens: currentContextWindow || null
    };
  }, [activeThreadContextStats, attachments, currentContextWindow, currentModel, draft, safeInputBudget, selectedAssistantPromptCharacterCount, selectedSkillPromptCharacterCount, visibleMessages]);
  const composerUsageStats = activeThreadUsageStats ?? {
    activeBranchMessageCount: visibleMessages.length,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    totalTokens: 0
  };
  return {
    activeChat,
    activeChatStreaming,
    activeChatTitle,
    composerDisabledHint,
    composerContextStats,
    composerUsageStats,
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
