"use client";

import { isImeCompositionEvent } from "@/components/keyboard";
import type { AttachmentLimitUsage } from "@/components/app-shell/attachmentLimitUsage";
import {
  composerContextGauge,
  composerContextGaugeTitle,
  type ComposerContextStats
} from "@/components/app-shell/composerContextStats";
import { formatTokenCount } from "@/components/app-shell/shellFormatting";
import {
  attachmentAcceptForPolicy,
  dataTransferHasFiles,
  DEFAULT_COMPOSER_ATTACHMENT_POLICY,
  partitionAttachmentSelection,
  type ComposerAttachmentPolicy
} from "@/components/app-shell/attachmentSelection";
import {
  UiV2Icon,
  UiV2IconButton,
  type UiV2IconName
} from "@/components/ui-v2";
import { RunComposerActionV2 } from "@/features/run-lifecycle-v2/RunLifecycleV2";
import { AttachmentTrayV2 } from "@/features/attachments-v2/AttachmentTrayV2";
import {
  attachmentItemBlocksSend,
  attachmentSendBlockReasonV2,
  type ComposerAttachmentItemV2
} from "@/features/attachments-v2/attachmentPresentation";
import type { AssistantSummary } from "@/lib/contracts/assistants";
import type { CatalogModel, CatalogProvider, CatalogSearchStrategy } from "@/lib/contracts/catalog";
import type { ChatUsageStats } from "@/lib/contracts/chats";
import type {
  ComposerConfig,
  ComposerConfigKnowledgeBase,
  ComposerConfigMcpServer
} from "@/lib/contracts/composerConfig";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";

export type ComposerV2Layer = "capabilities" | "model" | null;

const EMPTY_MODELS: readonly CatalogModel[] = [];
const EMPTY_PROVIDERS: readonly CatalogProvider[] = [];

export type ComposerV2Props = Readonly<{
  activeRun?: boolean;
  assistantRemovedNotice?: boolean;
  attachmentItems?: readonly ComposerAttachmentItemV2[];
  attachmentLimitUsage?: AttachmentLimitUsage | null;
  attachmentPolicy?: ComposerAttachmentPolicy;
  config: ComposerConfig | null;
  configError?: boolean;
  contextStats?: ComposerContextStats | null;
  disabledReason?: string | null;
  draft: string;
  editStatusSlot?: ReactNode;
  hasReadyAttachments?: boolean;
  initialLayer?: ComposerV2Layer;
  onAttachmentCountLimitExceeded?(input: {
    attemptedCount: number;
    currentCount: number;
    maxCount: number;
  }): void;
  onDraftChange(value: string): void;
  onDismissAssistantRemovedNotice?(): void;
  onMakeModelDefault?(model: CatalogModel): void;
  onOpenAssistantPicker?(): void;
  onOpenMcpSettings?(): void;
  onOpenModelParameters?(): void;
  onRemoveAssistant?(): void;
  onRemoveAttachment?(id: string): void;
  onRejectedFiles?(files: readonly File[]): void;
  onRetryConfig?(): void;
  onRetryAttachment?(id: string): void;
  onSelectKnowledgeBaseIds?(baseIds: readonly string[]): void;
  onSelectModel?(model: CatalogModel): void;
  onSelectSearchOptionIds?(optionIds: readonly string[]): void;
  onSend?(): void;
  onStop?(runId: string): void;
  onToggleMcpServer?(serverId: string, enabled: boolean): void;
  onUploadFiles?(files: readonly File[]): Promise<void> | void;
  runId?: string | null;
  selectedAssistant?: Pick<AssistantSummary, "id" | "name"> | null;
  selectedKnowledgeBaseIds?: readonly string[];
  selectedModelId: string;
  selectedProvider: string;
  selectedSearchOptionIds?: readonly string[];
  sending?: boolean;
  stopping?: boolean;
  uploading?: boolean;
  usageStats?: ChatUsageStats | null;
}>;

function ContextGaugeV2({
  stats,
  usage
}: Readonly<{
  stats: ComposerContextStats;
  usage: ChatUsageStats | null;
}>) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const gauge = composerContextGauge(stats);
  const circumference = 2 * Math.PI * 9;
  const progress = gauge.fraction === null ? 0 : Math.min(1, gauge.fraction);
  const open = pinned || hovered;
  const close = () => {
    setPinned(false);
    setHovered(false);
    triggerRef.current?.focus();
  };
  const usageFacts = usage ?? {
    activeBranchMessageCount: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    totalTokens: 0
  };

  return (
    <span
      className="v2-composer-context"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${gauge.accessibleLabel}. Open context details`}
        className="v2-composer-context-trigger v2-focusable"
        data-context-tone={gauge.tone}
        title={composerContextGaugeTitle(stats)}
        type="button"
        onClick={() => setPinned((value) => !value)}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <circle className="v2-composer-context-track" cx="12" cy="12" fill="none" r="9" strokeWidth="3" />
          {gauge.fraction !== null ? (
            <circle
              className="v2-composer-context-progress"
              cx="12"
              cy="12"
              fill="none"
              r="9"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - progress)}
              strokeLinecap="round"
              strokeWidth="3"
            />
          ) : null}
        </svg>
        <span>{gauge.percent === null ? "·" : gauge.percent}</span>
      </button>
      {open ? (
        <section
          aria-label="Context and usage statistics"
          className="v2-composer-context-popover"
          role="dialog"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
        >
          <header>
            <strong>Context and usage</strong>
            <UiV2IconButton icon="close" label="Close context and usage statistics" onClick={close} />
          </header>
          <dl>
            <div><dt>Approximate input</dt><dd>~{formatTokenCount(stats.approximateInputTokens)}</dd></div>
            <div><dt>Safe input budget</dt><dd>{stats.safeInputBudgetTokens === null ? "Unavailable" : formatTokenCount(stats.safeInputBudgetTokens)}</dd></div>
            <div><dt>Total context</dt><dd>{stats.totalContextTokens === null ? "Unavailable" : formatTokenCount(stats.totalContextTokens)}</dd></div>
            <div><dt>Safe budget used</dt><dd>{gauge.percent === null ? "Unavailable" : `${gauge.percent}%`}</dd></div>
            <div><dt>Total messages</dt><dd>{usageFacts.activeBranchMessageCount}</dd></div>
            <div><dt>Provider-reported tokens</dt><dd>{formatTokenCount(usageFacts.totalTokens)}</dd></div>
            <div><dt>Total tokens cached</dt><dd>{formatTokenCount(usageFacts.cachedInputTokens)}</dd></div>
            <div><dt>Cache-write tokens</dt><dd>{formatTokenCount(usageFacts.cacheWriteInputTokens)}</dd></div>
          </dl>
        </section>
      ) : null}
    </span>
  );
}

function modelCapabilityLabels(model: CatalogModel): string[] {
  const labels: string[] = [];
  if (model.capabilities.reasoning) labels.push("Reasoning");
  if (model.capabilities.documentInputMode !== "none") labels.push("PDF and documents");
  if (model.capabilities.imageInput) labels.push("Images");
  if (model.capabilities.nativeWebSearch || model.capabilities.openRouterPerplexitySearch) {
    labels.push("Web search");
  }
  if (model.capabilities.toolCalling) labels.push("Tools");
  if (model.capabilities.streaming) labels.push("Streaming");
  return labels;
}

function readinessLabel(server: ComposerConfigMcpServer): string {
  if (!server.enabled) return "off";
  switch (server.readiness) {
    case "ready":
      return `${server.knownToolCount} ${server.knownToolCount === 1 ? "tool" : "tools"}`;
    case "authorizing":
      return "authorizing…";
    case "needs_authorization":
      return "needs authorization";
    case "reauthorization_required":
      return "reconnect required";
    case "needs_setup":
      return "needs setup";
    case "queued":
      return "queued";
    case "idle":
    case "restarting":
    case "starting":
      return "starting…";
    case "disabled":
      return "off";
    case "unavailable":
      return "not ready";
  }
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]'
  )).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

function optionElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-v2-composer-option]:not(:disabled)"));
}

function CapabilityRow({
  children,
  disabled = false,
  icon,
  onClick,
  reason,
  selected = false
}: Readonly<{
  children: ReactNode;
  disabled?: boolean;
  icon: UiV2IconName;
  onClick?(): void;
  reason?: string | null;
  selected?: boolean;
}>) {
  return (
    <button
      className="v2-composer-capability-row v2-focusable"
      data-v2-composer-option="true"
      type="button"
      role="menuitemcheckbox"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
    >
      <UiV2Icon name={icon} />
      <span className="v2-composer-capability-copy">
        <span>{children}</span>
        {reason ? <span>{reason}</span> : null}
      </span>
      {selected ? <UiV2Icon name="check" /> : null}
    </button>
  );
}

export function ComposerV2({
  activeRun = false,
  assistantRemovedNotice = false,
  attachmentItems = [],
  attachmentLimitUsage = null,
  attachmentPolicy = DEFAULT_COMPOSER_ATTACHMENT_POLICY,
  config,
  configError = false,
  contextStats = null,
  disabledReason = null,
  draft,
  editStatusSlot,
  hasReadyAttachments = false,
  initialLayer = null,
  onAttachmentCountLimitExceeded,
  onDraftChange,
  onDismissAssistantRemovedNotice,
  onMakeModelDefault,
  onOpenAssistantPicker,
  onOpenMcpSettings,
  onOpenModelParameters,
  onRemoveAssistant,
  onRemoveAttachment,
  onRejectedFiles,
  onRetryConfig,
  onRetryAttachment,
  onSelectKnowledgeBaseIds,
  onSelectModel,
  onSelectSearchOptionIds,
  onSend,
  onStop,
  onToggleMcpServer,
  onUploadFiles,
  runId = null,
  selectedAssistant = null,
  selectedKnowledgeBaseIds = [],
  selectedModelId,
  selectedProvider,
  selectedSearchOptionIds = [],
  sending = false,
  stopping = false,
  uploading = false,
  usageStats = null
}: ComposerV2Props) {
  const [layer, setLayer] = useState<ComposerV2Layer>(initialLayer);
  const [modelQuery, setModelQuery] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const plusTriggerRef = useRef<HTMLButtonElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const layerId = useId();
  const statusId = useId();

  const models = config?.catalog.models ?? EMPTY_MODELS;
  const providers = config?.catalog.providers ?? EMPTY_PROVIDERS;
  const currentModel = models.find(
    (model) => model.modelId === selectedModelId && model.provider === selectedProvider
  );
  const noModels = Boolean(config && models.length === 0);
  const controlsLocked = Boolean(selectedAssistant);
  const bootstrapReason = configError
    ? "Could not load available capabilities."
    : !config
      ? "Loading available capabilities…"
      : noModels
        ? "No models available. Contact your administrator."
        : disabledReason;
  const inputDisabled = Boolean(configError || !config || noModels || disabledReason);
  const attachmentBlockReason = attachmentSendBlockReasonV2(
    attachmentItems,
    attachmentLimitUsage,
    uploading
  );
  const readyAttachment = hasReadyAttachments || attachmentItems.some(
    (item) => item.status === "ready" && !attachmentItemBlocksSend(item)
  );
  const sendDisabled = Boolean(
    sending || inputDisabled || attachmentBlockReason || (!draft.trim() && !readyAttachment)
  );
  const sendDisabledReason = sending
    ? "Sending message…"
    : bootstrapReason ?? attachmentBlockReason ??
      (!draft.trim() && !readyAttachment ? "Type a message." : null);

  const attachmentAccept = attachmentAcceptForPolicy(attachmentPolicy);
  const attachmentSelectionDisabled = Boolean(
    !onUploadFiles || !attachmentAccept || inputDisabled || activeRun || uploading
  );

  const concreteSearchOptions = config?.catalog.searchStrategies.filter(
    (option) => option.kind !== "none"
  ) ?? [];
  const compatibleSearchOptionIds = new Set(
    currentModel?.searchStrategyIds.filter((id) => id !== "search-disabled") ?? []
  );
  const selectedSearchSet = new Set(selectedSearchOptionIds);
  const selectedKnowledgeSet = new Set(selectedKnowledgeBaseIds);
  const knowledgeById = new Map(
    (config?.knowledgeBases ?? []).map((base) => [base.id, base])
  );
  const selectedKnowledgeNames = selectedKnowledgeBaseIds.map(
    (id) => knowledgeById.get(id)?.name ?? "unavailable"
  );
  const enabledMcpServers = config?.mcpServers.filter((server) => server.enabled) ?? [];
  const readyMcpServers = enabledMcpServers.filter((server) => server.readiness === "ready");

  const groupedModels = useMemo(() => {
    const normalizedQuery = modelQuery.trim().toLocaleLowerCase();
    const groups = providers.map((provider) => ({
      models: models.filter((model) => {
        if (model.provider !== provider.id) return false;
        if (!normalizedQuery) return true;
        const haystack = [
          provider.name,
          model.displayName,
          model.upstreamModelId ?? "",
          ...modelCapabilityLabels(model)
        ].join(" ").toLocaleLowerCase();
        return haystack.includes(normalizedQuery);
      }),
      provider
    })).filter((group) => group.models.length > 0);
    const groupedIds = new Set(providers.map((provider) => provider.id));
    const ungrouped = models.filter((model) => {
      if (groupedIds.has(model.provider)) return false;
      if (!normalizedQuery) return true;
      return [model.displayName, model.upstreamModelId ?? "", ...modelCapabilityLabels(model)]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
    return ungrouped.length > 0
      ? [...groups, { models: ungrouped, provider: { id: "", models: [], name: "Other models" } }]
      : groups;
  }, [modelQuery, models, providers]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.max(36, Math.min(textarea.scrollHeight, 200))}px`;
  }, [draft]);

  useEffect(() => {
    if (!layer) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || !layerRef.current) return;
      const target = layer === "model"
        ? layerRef.current.querySelector<HTMLElement>("[data-v2-model-search]")
        : optionElements(layerRef.current)[0];
      target?.focus();
    });
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        layerRef.current?.contains(target) ||
        plusTriggerRef.current?.contains(target) ||
        modelTriggerRef.current?.contains(target)
      ) {
        return;
      }
      closeLayer();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => {
      cancelled = true;
      document.removeEventListener("pointerdown", dismiss);
    };
  }, [layer]);

  function openLayer(next: Exclude<ComposerV2Layer, null>, opener: HTMLButtonElement) {
    if (layer === next) {
      closeLayer();
      return;
    }
    openerRef.current = opener;
    if (next === "model") setModelQuery("");
    setLayer(next);
  }

  function closeLayer() {
    const opener = openerRef.current;
    setLayer(null);
    queueMicrotask(() => opener?.focus());
  }

  function handleLayerKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (isImeCompositionEvent(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeLayer();
      return;
    }
    const container = layerRef.current;
    if (!container) return;
    if (event.key === "Tab") {
      const focusable = focusableElements(container);
      if (focusable.length === 0) return;
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? (current <= 0 ? focusable.length - 1 : current - 1)
        : (current < 0 || current === focusable.length - 1 ? 0 : current + 1);
      event.preventDefault();
      focusable[next]?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const options = optionElements(container);
    if (options.length === 0) return;
    const current = options.indexOf(document.activeElement as HTMLElement);
    const next = current < 0
      ? event.key === "ArrowUp" || event.key === "End"
        ? options.length - 1
        : 0
      : event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % options.length
            : (current - 1 + options.length) % options.length;
    event.preventDefault();
    options[next]?.focus();
  }

  function submitFromKeyboard(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (isImeCompositionEvent(event) || event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (!activeRun && !sendDisabled) onSend?.();
  }

  function submitFiles(files: FileList | readonly File[]) {
    const { accepted, rejected } = partitionAttachmentSelection(files, attachmentPolicy);
    const currentCount = attachmentLimitUsage?.count ?? attachmentItems.filter(
      (item) => item.status !== "rejected"
    ).length;
    const maxCount = attachmentLimitUsage?.limits?.maxCount ??
      config?.catalog.attachmentLimits?.maxCount;
    const attemptedCount = currentCount + accepted.length;
    if (
      accepted.length > 0 &&
      typeof maxCount === "number" &&
      attemptedCount > maxCount
    ) {
      onAttachmentCountLimitExceeded?.({ attemptedCount, currentCount, maxCount });
    } else if (accepted.length > 0) {
      void onUploadFiles?.(accepted);
    }
    if (rejected.length > 0) onRejectedFiles?.(rejected);
  }

  function pasteFiles(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = event.clipboardData.files;
    if (files.length === 0) return;
    event.preventDefault();
    if (!attachmentSelectionDisabled) submitFiles(files);
  }

  function updateDropEffect(event: ReactDragEvent<HTMLDivElement>) {
    event.dataTransfer.dropEffect = attachmentSelectionDisabled ? "none" : "copy";
  }

  function clearDragState() {
    dragDepthRef.current = 0;
    setDragActive(false);
  }

  function handleDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    updateDropEffect(event);
    setDragActive(true);
  }

  function handleDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  function handleDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    updateDropEffect(event);
    setDragActive(true);
  }

  function handleDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const files = event.dataTransfer.files;
    clearDragState();
    if (!attachmentSelectionDisabled && files.length > 0) submitFiles(files);
  }

  function toggleSearch(option: CatalogSearchStrategy) {
    if (!onSelectSearchOptionIds) return;
    const next = selectedSearchSet.has(option.strategyId)
      ? selectedSearchOptionIds.filter((id) => id !== option.strategyId)
      : [...selectedSearchOptionIds, option.strategyId];
    onSelectSearchOptionIds(next);
    closeLayer();
  }

  function toggleKnowledge(base: ComposerConfigKnowledgeBase) {
    if (!onSelectKnowledgeBaseIds) return;
    const next = selectedKnowledgeSet.has(base.id)
      ? selectedKnowledgeBaseIds.filter((id) => id !== base.id)
      : [...selectedKnowledgeBaseIds, base.id];
    onSelectKnowledgeBaseIds(next);
    closeLayer();
  }

  return (
    <div className="v2-composer-wrap" data-testid="composer-v2">
      <div
        className="v2-composer"
        data-testid="composer-v2-surface"
        data-drop-active={dragActive ? "true" : undefined}
        data-layer-open={layer ?? undefined}
        onDragEnd={clearDragState}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {dragActive ? (
          <div className="v2-attachment-drop-overlay" role="status">
            {attachmentSelectionDisabled
              ? "Files cannot be attached right now"
              : "Drop files to attach"}
          </div>
        ) : null}
        <input
          ref={fileInputRef}
          className="v2-sr-only"
          type="file"
          accept={attachmentAccept}
          aria-label="Attach files"
          disabled={attachmentSelectionDisabled}
          multiple
          onChange={(event) => {
            if (event.currentTarget.files?.length) submitFiles(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
        {selectedAssistant ? (
          <div className="v2-composer-assistant" data-testid="composer-v2-assistant-lock">
            <UiV2Icon name="lock" />
            <span>Assistant: <strong>{selectedAssistant.name}</strong></span>
            {onRemoveAssistant ? (
              <button className="v2-focusable" type="button" onClick={onRemoveAssistant}>
                Remove
              </button>
            ) : null}
          </div>
        ) : null}
        {assistantRemovedNotice && !selectedAssistant ? (
          <div
            className="v2-composer-status"
            data-testid="composer-assistant-removed-notice"
            role="status"
          >
            <span>Assistant removed. Your manual settings now apply.</span>
            {onDismissAssistantRemovedNotice ? (
              <button
                className="v2-focusable"
                type="button"
                onClick={onDismissAssistantRemovedNotice}
              >
                Dismiss
              </button>
            ) : null}
          </div>
        ) : null}

        <AttachmentTrayV2
          items={attachmentItems}
          onRemove={onRemoveAttachment}
          onRetry={onRetryAttachment}
          usage={attachmentLimitUsage}
        />

        {editStatusSlot}

        <label className="v2-composer-input-label" htmlFor={`${layerId}-input`}>
          Message
        </label>
        <textarea
          ref={textareaRef}
          className="v2-composer-input"
          id={`${layerId}-input`}
          rows={1}
          value={draft}
          disabled={inputDisabled}
          aria-describedby={bootstrapReason ? statusId : undefined}
          placeholder="Ask anything…"
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={submitFromKeyboard}
          onPaste={pasteFiles}
        />

        {bootstrapReason ? (
          <div className="v2-composer-status" id={statusId} role={configError ? "alert" : "status"}>
            <span>{bootstrapReason}</span>
            {configError && onRetryConfig ? (
              <button className="v2-focusable" type="button" onClick={onRetryConfig}>
                Retry
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="v2-composer-controls">
          <UiV2IconButton
            ref={plusTriggerRef}
            icon="plus"
            label="Capabilities"
            aria-controls={`${layerId}-capabilities`}
            aria-expanded={layer === "capabilities"}
            aria-haspopup="menu"
            disabled={!config || configError || noModels || activeRun}
            onClick={(event) => openLayer("capabilities", event.currentTarget)}
          />

          <button
            ref={modelTriggerRef}
            className="v2-composer-model-trigger v2-focusable"
            type="button"
            aria-controls={`${layerId}-model`}
            aria-expanded={layer === "model"}
            aria-haspopup="dialog"
            disabled={!config || configError || noModels || activeRun || controlsLocked}
            title={controlsLocked ? "Managed by the Assistant" : "Choose model"}
            onClick={(event) => openLayer("model", event.currentTarget)}
          >
            <strong>{currentModel?.displayName ?? (noModels ? "No models available" : "Choose model")}</strong>
            {controlsLocked ? <UiV2Icon name="lock" /> : <UiV2Icon name="chevron-down" />}
          </button>

          <div className="v2-composer-indicators" aria-label="Active capabilities">
            {config && selectedSearchOptionIds.length > 0 ? (
              <button
                className="v2-composer-indicator v2-focusable"
                type="button"
                disabled={controlsLocked || activeRun || !onSelectSearchOptionIds}
                aria-label="Turn off Search"
                onClick={() => onSelectSearchOptionIds?.([])}
              >
                <span aria-hidden="true" />Search
                {!controlsLocked ? <UiV2Icon name="close" /> : null}
              </button>
            ) : null}
            {config && selectedKnowledgeBaseIds.length > 0 ? (
              <button
                className="v2-composer-indicator v2-focusable"
                type="button"
                disabled={controlsLocked || activeRun || !onSelectKnowledgeBaseIds}
                aria-label="Turn off Knowledge"
                onClick={() => onSelectKnowledgeBaseIds?.([])}
              >
                <span aria-hidden="true" />
                {selectedKnowledgeNames.length === 1
                  ? `Knowledge: ${selectedKnowledgeNames[0]}`
                  : `Knowledge: ${selectedKnowledgeNames.length}`}
                {!controlsLocked ? <UiV2Icon name="close" /> : null}
              </button>
            ) : null}
            {enabledMcpServers.length > 0 ? (
              <button
                className="v2-composer-indicator v2-focusable"
                type="button"
                disabled={activeRun || !onOpenMcpSettings}
                aria-label="Open MCP settings"
                onClick={onOpenMcpSettings}
              >
                <span aria-hidden="true" />MCP: {readyMcpServers.length}/{enabledMcpServers.length}
              </button>
            ) : null}
          </div>

          <span className="v2-composer-spacer" />
          {contextStats ? <ContextGaugeV2 stats={contextStats} usage={usageStats} /> : null}
          <span className="v2-composer-run-action">
            <RunComposerActionV2
              active={activeRun}
              onSend={onSend}
              onStop={onStop}
              runId={runId}
              sendDisabled={sendDisabled}
              sendDisabledReason={sendDisabledReason}
              stopping={stopping}
            />
          </span>
        </div>

        {layer ? (
          <>
            <button
              className="v2-composer-layer-backdrop"
              type="button"
              aria-label="Close menu"
              onClick={closeLayer}
            />
            <div
              ref={layerRef}
              className="v2-composer-layer"
              data-kind={layer}
              id={`${layerId}-${layer}`}
              role={layer === "model" ? "dialog" : "menu"}
              aria-label={layer === "model" ? "Choose model" : "Capabilities"}
              onKeyDown={handleLayerKeyDown}
            >
              <header className="v2-composer-layer-header">
                <strong>{layer === "model" ? "Model" : "Capabilities"}</strong>
                <UiV2IconButton icon="close" label="Close" onClick={closeLayer} />
              </header>

              {layer === "model" ? (
                <ModelLayer
                  config={config}
                  groups={groupedModels}
                  query={modelQuery}
                  selectedModelId={selectedModelId}
                  selectedProvider={selectedProvider}
                  onMakeDefault={onMakeModelDefault}
                  onQuery={setModelQuery}
                  onSelect={(model) => {
                    onSelectModel?.(model);
                    closeLayer();
                  }}
                />
              ) : (
                <div className="v2-composer-layer-scroll">
                  <CapabilityRow
                    icon="assistant"
                    disabled={activeRun || !onOpenAssistantPicker}
                    reason={selectedAssistant
                      ? `Selected: ${selectedAssistant.name}`
                      : "Pinned · Recent · Yours · Shared"}
                    selected={Boolean(selectedAssistant)}
                    onClick={() => {
                      onOpenAssistantPicker?.();
                      closeLayer();
                    }}
                  >
                    Use an Assistant…
                  </CapabilityRow>

                  <CapabilityRow
                    icon="attach"
                    disabled={attachmentSelectionDisabled}
                    reason={attachmentSelectionDisabled ? "Unavailable" : "XLSX · DOCX · PDF…"}
                    onClick={() => {
                      fileInputRef.current?.click();
                      closeLayer();
                    }}
                  >
                    Attach files
                  </CapabilityRow>

                  <div className="v2-composer-layer-divider" />
                  <p className="v2-composer-layer-label">Search</p>
                  {concreteSearchOptions.length === 0 ? (
                    <CapabilityRow icon="search" disabled reason="Not configured by the administrator">
                      Search
                    </CapabilityRow>
                  ) : concreteSearchOptions.map((option) => {
                    const selected = selectedSearchSet.has(option.strategyId);
                    const compatible = compatibleSearchOptionIds.has(option.strategyId);
                    const reason = controlsLocked
                      ? "Managed by the Assistant"
                      : !compatible
                        ? "Not available for this model"
                        : option.description ?? null;
                    return (
                      <CapabilityRow
                        key={option.strategyId}
                        icon="search"
                        selected={selected}
                        disabled={controlsLocked || activeRun || (!compatible && !selected)}
                        reason={reason}
                        onClick={() => toggleSearch(option)}
                      >
                        {option.displayName}
                      </CapabilityRow>
                    );
                  })}

                  <p className="v2-composer-layer-label">Knowledge</p>
                  {(config?.knowledgeBases.length ?? 0) === 0 && selectedKnowledgeBaseIds.length === 0 ? (
                    <CapabilityRow icon="library" disabled reason="No knowledge bases available">
                      Knowledge
                    </CapabilityRow>
                  ) : null}
                  {config?.knowledgeBases.map((base) => {
                    const selected = selectedKnowledgeSet.has(base.id);
                    const atLimit = selectedKnowledgeBaseIds.length >= 3 && !selected;
                    const reason = controlsLocked
                      ? "Managed by the Assistant"
                      : base.archived
                        ? "Access revoked or base archived"
                        : atLimit
                          ? "Select up to three bases"
                          : base.description || null;
                    return (
                      <CapabilityRow
                        key={base.id}
                        icon="library"
                        selected={selected}
                        disabled={controlsLocked || activeRun || atLimit || (base.archived && !selected)}
                        reason={reason}
                        onClick={() => toggleKnowledge(base)}
                      >
                        {base.name}
                      </CapabilityRow>
                    );
                  })}
                  {selectedKnowledgeBaseIds
                    .filter((id) => !knowledgeById.has(id))
                    .map((id) => (
                      <CapabilityRow
                        key={id}
                        icon="library"
                        selected
                        disabled={controlsLocked || activeRun}
                        reason={controlsLocked ? "Managed by the Assistant" : "Access revoked"}
                        onClick={() => {
                          onSelectKnowledgeBaseIds?.(
                            selectedKnowledgeBaseIds.filter((candidate) => candidate !== id)
                          );
                          closeLayer();
                        }}
                      >
                        Unavailable knowledge base
                      </CapabilityRow>
                    ))}

                  <p className="v2-composer-layer-label">MCP</p>
                  {(config?.mcpServers.length ?? 0) === 0 ? (
                    <CapabilityRow icon="tool" disabled reason="Not configured by the administrator">
                      MCP tools
                    </CapabilityRow>
                  ) : config?.mcpServers.map((server) => {
                    const canDisable = server.enabled;
                    const runnable = server.readiness === "ready";
                    const reason = controlsLocked
                      ? "Managed by the Assistant"
                      : !currentModel?.capabilities.toolCalling
                        ? "Not supported by this model"
                        : readinessLabel(server);
                    return (
                      <CapabilityRow
                        key={server.id}
                        icon="tool"
                        selected={server.enabled}
                        disabled={
                          controlsLocked ||
                          activeRun ||
                          !currentModel?.capabilities.toolCalling ||
                          !onToggleMcpServer ||
                          (!runnable && !canDisable)
                        }
                        reason={reason}
                        onClick={() => {
                          onToggleMcpServer?.(server.id, !server.enabled);
                          closeLayer();
                        }}
                      >
                        {server.name}
                      </CapabilityRow>
                    );
                  })}
                  {onOpenMcpSettings ? (
                    <button
                      className="v2-composer-text-action v2-focusable"
                      data-v2-composer-option="true"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onOpenMcpSettings();
                        closeLayer();
                      }}
                    >
                      Set up MCP…
                    </button>
                  ) : null}

                  <div className="v2-composer-layer-divider" />
                  <CapabilityRow
                    icon="sliders"
                    disabled={controlsLocked || !onOpenModelParameters}
                    reason={controlsLocked ? "Managed by the Assistant" : "Temperature · reasoning · stream"}
                    onClick={() => {
                      onOpenModelParameters?.();
                      closeLayer();
                    }}
                  >
                    Model parameters
                  </CapabilityRow>
                  <p className="v2-composer-privacy-note">
                    Files are private and visible only to you. Unavailable capabilities show a reason.
                  </p>
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function ModelLayer({
  config,
  groups,
  onMakeDefault,
  onQuery,
  onSelect,
  query,
  selectedModelId,
  selectedProvider
}: Readonly<{
  config: ComposerConfig | null;
  groups: Array<{ models: CatalogModel[]; provider: CatalogProvider }>;
  onMakeDefault?(model: CatalogModel): void;
  onQuery(value: string): void;
  onSelect(model: CatalogModel): void;
  query: string;
  selectedModelId: string;
  selectedProvider: string;
}>) {
  const personalDefault = config?.catalog.defaults.personalModelDefault;
  const organizationDefault = config?.catalog.defaults.organizationModelDefault;
  const hasMatches = groups.some((group) => group.models.length > 0);

  return (
    <>
      <label className="v2-composer-model-search-wrap">
        <span className="v2-sr-only">Search models</span>
        <UiV2Icon name="search" />
        <input
          data-v2-model-search="true"
          type="search"
          value={query}
          placeholder="Search models…"
          onChange={(event) => onQuery(event.target.value)}
        />
      </label>
      <div className="v2-composer-layer-scroll" role="listbox" aria-label="Available models">
        {!hasMatches ? (
          <p className="v2-composer-empty-options" role="status">
            {config?.catalog.models.length ? "No models match your search" : "No models available"}
          </p>
        ) : groups.map((group) => (
          <section className="v2-composer-model-group" key={group.provider.id || group.provider.name}>
            <h3>{group.provider.name}<span>{group.models.length}</span></h3>
            {group.models.map((model) => {
              const selected = model.modelId === selectedModelId && model.provider === selectedProvider;
              const isPersonalDefault = personalDefault?.modelId === model.modelId &&
                personalDefault.provider === model.provider;
              const isOrganizationDefault = organizationDefault?.modelId === model.modelId &&
                organizationDefault.provider === model.provider;
              const capabilityLabels = modelCapabilityLabels(model);
              const capabilityTags = capabilityLabels.length > 0 ? capabilityLabels : ["Text"];
              return (
                <div className="v2-composer-model-row" key={`${model.provider}:${model.modelId}`}>
                  <button
                    className="v2-composer-model-option v2-focusable"
                    data-model-id={model.modelId}
                    data-provider-id={model.provider}
                    data-v2-composer-option="true"
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => onSelect(model)}
                  >
                    <span className="v2-composer-model-copy">
                      <strong>{model.displayName}</strong>
                      {/* One joined line with a single trailing ellipsis: per-tag
                          truncation turned narrow rows into unreadable fragments. */}
                      <span className="v2-composer-model-tags" title={capabilityTags.join(" · ")}>
                        {capabilityTags.slice(0, 3).join(" · ")}
                        {capabilityTags.length > 3 ? ` · +${capabilityTags.length - 3}` : ""}
                      </span>
                      <span className="v2-composer-model-facts">
                        {selected ? <em>Current</em> : null}
                        {isPersonalDefault ? <em>My default</em> : null}
                        {isOrganizationDefault ? <em>Org default</em> : null}
                      </span>
                    </span>
                    {selected ? <UiV2Icon name="check" /> : null}
                  </button>
                  {onMakeDefault && !isPersonalDefault ? (
                    <button
                      className="v2-composer-model-default v2-focusable"
                      type="button"
                      aria-label={`Make ${model.displayName} your default model`}
                      onClick={() => onMakeDefault(model)}
                    >
                      Make default
                    </button>
                  ) : null}
                </div>
              );
            })}
          </section>
        ))}
      </div>
      <p className="v2-composer-model-note">
        Applies to your next message.
      </p>
    </>
  );
}
