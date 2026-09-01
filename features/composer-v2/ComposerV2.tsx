"use client";

import { mcpReadinessPresentation } from "@/components/app-shell/mcpReadiness";

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
  type UiV2IconName,
  UiV2Icon,
  UiV2IconButton,
  UiV2Monogram
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
import type { McpRunSelection } from "@/lib/contracts/mcp";
import { SKILL_MAX_SELECTED } from "@/lib/contracts/skills";
import type {
  ComposerConfig,
  ComposerConfigKnowledgeBase,
  ComposerConfigKnowledgeSource
} from "@/lib/contracts/composerConfig";
import {
  allMyKnowledgeSelection,
  EMPTY_KNOWLEDGE_SELECTION,
  explicitKnowledgeSelection,
  KNOWLEDGE_SOURCE_SEARCH_MAX_LENGTH,
  type KnowledgeSelection
} from "@/lib/contracts/knowledge";
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
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type CSSProperties
} from "react";

export type ComposerV2Layer = "add" | "knowledge" | "model" | "search" | "tools" | null;

const LAYER_LABELS: Record<Exclude<ComposerV2Layer, null>, string> = {
  add: "Add",
  knowledge: "Knowledge",
  model: "Choose model",
  search: "Web search",
  tools: "MCP tools"
};
const LAYER_TITLES: Record<Exclude<ComposerV2Layer, null>, string> = {
  add: "Add",
  knowledge: "Knowledge",
  model: "Model",
  search: "Web search",
  tools: "MCP tools"
};
/* Desktop popover widths (see composer.css) used to keep a chip-anchored layer
   inside the composer frame. */
const LAYER_WIDTH_PX: Record<Exclude<ComposerV2Layer, null>, number> = {
  add: 300,
  knowledge: 340,
  model: 380,
  search: 330,
  tools: 340
};

/** Left offset (px, relative to the composer frame) for a chip-anchored layer. */
function layerAnchorLeft(
  opener: HTMLElement,
  composer: HTMLElement | null,
  kind: Exclude<ComposerV2Layer, null>
): number {
  if (!composer || kind === "add" || kind === "model") return 0;
  const composerBox = composer.getBoundingClientRect();
  const openerBox = opener.getBoundingClientRect();
  const max = Math.max(0, composerBox.width - LAYER_WIDTH_PX[kind]);
  return Math.round(Math.max(0, Math.min(openerBox.left - composerBox.left, max)));
}

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
  /** "Reasoning medium · Temp 1.0" for the picker's Parameters row. */
  modelParametersSummary?: string | null;
  onAttachmentCountLimitExceeded?(input: {
    attemptedCount: number;
    currentCount: number;
    maxCount: number;
  }): void;
  onDraftChange(value: string): void;
  onDismissAssistantRemovedNotice?(): void;
  onMakeModelDefault?(model: CatalogModel): void;
  onOpenAssistantPicker?(): void;
  /** Opens the Library's Knowledge section ("Manage in Library ›"). */
  onOpenKnowledgeLibrary?(): void;
  onOpenMcpSettings?(): void;
  onOpenSkillLibrary?(): void;
  onOpenModelParameters?(): void;
  onRemoveAssistant?(): void;
  onRemoveAttachment?(id: string): void;
  onRejectedFiles?(files: readonly File[]): void;
  onRetryConfig?(): void;
  onRetryAttachment?(id: string): void;
  onSearchKnowledgeSources?(query: string): Promise<readonly ComposerConfigKnowledgeSource[]>;
  onSelectKnowledgeSelection?(selection: KnowledgeSelection): void;
  /** @deprecated Use onSelectKnowledgeSelection. */
  onSelectKnowledgeBaseIds?(baseIds: readonly string[]): void;
  onSelectModel?(model: CatalogModel): void;
  onSelectMcp?(selection: McpRunSelection): void;
  onSelectSearchOptionIds?(optionIds: readonly string[]): void;
  onSelectSkillIds?(skillIds: readonly string[]): void;
  onSend?(): void;
  onStop?(runId: string): void;
  /** @deprecated MCP availability is configured in Settings; runs use onSelectMcp. */
  onToggleMcpServer?(serverId: string, enabled: boolean): void;
  onUploadFiles?(files: readonly File[]): Promise<void> | void;
  runId?: string | null;
  selectedAssistant?: (Pick<AssistantSummary, "id" | "name"> & {
    includedSkills?: readonly { id: string; name: string }[];
  }) | null;
  mcpSelection?: McpRunSelection;
  selectedKnowledgeSelection?: KnowledgeSelection;
  /** @deprecated Use selectedKnowledgeSelection. */
  selectedKnowledgeBaseIds?: readonly string[];
  selectedModelId: string;
  selectedProvider: string;
  selectedSearchOptionIds?: readonly string[];
  selectedSkillIds?: readonly string[];
  selectedSkills?: readonly { id: string; name: string }[];
  /** Shared Project uploads are visible to Project members. */
  sharedProject?: boolean;
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
        <span>{gauge.percent === null ? "·" : gauge.percent > 0 ? gauge.percent : ""}</span>
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

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]'
  )).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

function optionElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-v2-composer-option]:not(:disabled)"));
}

/*
 * One menu row for every composer popover: a radio glyph (single choice),
 * an icon plus trailing check (multi-select), or a plain action item.
 */
function CapabilityRow({
  children,
  disabled = false,
  icon,
  onClick,
  reason,
  selected = false,
  selectionRole = "checkbox"
}: Readonly<{
  children: ReactNode;
  disabled?: boolean;
  icon?: UiV2IconName;
  onClick?(event: ReactMouseEvent<HTMLButtonElement>): void;
  reason?: string | null;
  selected?: boolean;
  selectionRole?: "checkbox" | "item" | "radio";
}>) {
  const role = selectionRole === "radio"
    ? "menuitemradio"
    : selectionRole === "item" ? "menuitem" : "menuitemcheckbox";
  return (
    <button
      className="v2-composer-capability-row v2-focusable"
      data-v2-composer-option="true"
      data-selection={selectionRole}
      type="button"
      role={role}
      aria-checked={selectionRole === "item" ? undefined : selected}
      disabled={disabled}
      onClick={onClick}
    >
      {selectionRole === "radio" ? (
        <span className="v2-composer-radio" data-checked={selected || undefined} aria-hidden="true" />
      ) : icon ? (
        <UiV2Icon name={icon} />
      ) : (
        <span aria-hidden="true" />
      )}
      <span className="v2-composer-capability-copy">
        <span>{children}</span>
        {reason ? <span>{reason}</span> : null}
      </span>
      {selectionRole === "checkbox" && selected ? <UiV2Icon name="check" /> : null}
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
  modelParametersSummary = null,
  onAttachmentCountLimitExceeded,
  onDraftChange,
  onDismissAssistantRemovedNotice,
  onMakeModelDefault,
  onOpenAssistantPicker,
  onOpenKnowledgeLibrary,
  onOpenMcpSettings,
  onOpenModelParameters,
  onOpenSkillLibrary,
  onRemoveAssistant,
  onRemoveAttachment,
  onRejectedFiles,
  onRetryConfig,
  onRetryAttachment,
  onSearchKnowledgeSources,
  onSelectKnowledgeSelection,
  onSelectKnowledgeBaseIds,
  onSelectMcp,
  onSelectModel,
  onSelectSearchOptionIds,
  onSelectSkillIds,
  onSend,
  onStop,
  onUploadFiles,
  runId = null,
  selectedAssistant = null,
  mcpSelection = { mode: "auto" },
  selectedKnowledgeSelection,
  selectedKnowledgeBaseIds = [],
  selectedModelId,
  selectedProvider,
  selectedSearchOptionIds = [],
  selectedSkillIds = [],
  selectedSkills = [],
  sharedProject = false,
  sending = false,
  stopping = false,
  uploading = false,
  usageStats = null
}: ComposerV2Props) {
  const [layer, setLayer] = useState<ComposerV2Layer>(initialLayer);
  const [layerLeft, setLayerLeft] = useState(0);
  const [modelQuery, setModelQuery] = useState("");
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [knowledgeSourceSearch, setKnowledgeSourceSearch] = useState<Readonly<{
    query: string;
    sources: readonly ComposerConfigKnowledgeSource[];
  }> | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const plusTriggerRef = useRef<HTMLButtonElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const knowledgeTriggerRef = useRef<HTMLButtonElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const layerId = useId();
  const statusId = useId();

  const models = config?.catalog.models ?? EMPTY_MODELS;
  const providers = config?.catalog.providers ?? EMPTY_PROVIDERS;
  const currentModel = models.find(
    (model) => model.modelId === selectedModelId && model.provider === selectedProvider
  );
  // The chip monogram comes from the provider family (a known vendor glyph),
  // never from the operator-authored provider name, which may carry hosts.
  const currentProviderGlyph = currentModel
    ? (() => {
        const provider = providers.find((candidate) => candidate.id === currentModel.provider);
        return provider?.family || provider?.name || currentModel.provider;
      })()
    : "";
  // The context gauge is not a permanent control (PRD §4.5): it appears only
  // once the estimate reaches 70% of the safe input budget.
  const contextGaugeVisible = contextStats
    ? (composerContextGauge(contextStats).fraction ?? 0) >= 0.7
    : false;
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
    (item) => !attachmentItemBlocksSend(item)
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
  const knowledgeSelection = selectedKnowledgeSelection ??
    explicitKnowledgeSelection({ baseIds: selectedKnowledgeBaseIds });
  const selectedKnowledgeSet = new Set(knowledgeSelection.baseIds);
  const selectedKnowledgeSourceSet = new Set(knowledgeSelection.sourceIds);
  const knowledgeById = new Map(
    (config?.knowledgeBases ?? []).map((base) => [base.id, base])
  );
  const normalizedKnowledgeQuery = knowledgeQuery.trim().toLocaleLowerCase();
  const remotelyMatchedSources = knowledgeSourceSearch?.query === normalizedKnowledgeQuery
    ? knowledgeSourceSearch.sources
    : [];
  const allKnowledgeSources = [...new Map([
    ...(config?.knowledgeSources ?? []),
    ...remotelyMatchedSources
  ].map((source) => [source.id, source] as const)).values()];
  const sourceById = new Map(allKnowledgeSources.map((source) => [source.id, source]));
  const selectedKnowledgeNames = [
    ...knowledgeSelection.baseIds.map((id) => knowledgeById.get(id)?.name ?? "unavailable"),
    ...knowledgeSelection.sourceIds.map((id) => sourceById.get(id)?.name ?? "unavailable")
  ];
  const visibleKnowledgeBases = (config?.knowledgeBases ?? []).filter((base) =>
    !normalizedKnowledgeQuery || `${base.name} ${base.description}`.toLocaleLowerCase()
      .includes(normalizedKnowledgeQuery));
  const visibleKnowledgeSources = allKnowledgeSources.filter((source) =>
    !normalizedKnowledgeQuery || `${source.name} ${source.description}`.toLocaleLowerCase()
      .includes(normalizedKnowledgeQuery));
  const availableSkills = (config?.skills ?? []).filter((skill) => !skill.archived);
  const selectedSkillSet = new Set(selectedSkillIds);
  const selectedSkillNames = selectedSkillIds.map((id) =>
    selectedSkills.find((skill) => skill.id === id)?.name ??
    availableSkills.find((skill) => skill.id === id)?.name ??
    "Selected Skill"
  );
  const assistantSkills = selectedAssistant?.includedSkills ?? [];

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
    // Grow with the draft; the stylesheet's `max-height` and `min-height`
    // (which differ per surface and viewport) bound the box, so the measure
    // repeats when the viewport changes.
    const fit = () => {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.max(36, textarea.scrollHeight)}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [draft]);

  useEffect(() => {
    const query = knowledgeQuery.trim();
    if (layer !== "knowledge" || !onSearchKnowledgeSources || !query) return;
    let cancelled = false;
    const normalizedQuery = query.toLocaleLowerCase();
    const timer = window.setTimeout(() => {
      void onSearchKnowledgeSources(query).then((sources) => {
        if (!cancelled) setKnowledgeSourceSearch({ query: normalizedQuery, sources });
      }).catch(() => {
        if (!cancelled) setKnowledgeSourceSearch({ query: normalizedQuery, sources: [] });
      });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [knowledgeQuery, layer, onSearchKnowledgeSources]);

  useEffect(() => {
    if (!layer) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || !layerRef.current) return;
      const target = layer === "model"
        ? layerRef.current.querySelector<HTMLElement>("[data-v2-model-search]")
        : layer === "knowledge"
          ? layerRef.current.querySelector<HTMLElement>("[data-v2-knowledge-search]") ??
            optionElements(layerRef.current)[0]
          : optionElements(layerRef.current)[0];
      target?.focus();
    });
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        layerRef.current?.contains(target) ||
        plusTriggerRef.current?.contains(target) ||
        modelTriggerRef.current?.contains(target) ||
        openerRef.current?.contains(target)
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
    if (next === "knowledge") setKnowledgeQuery("");
    setLayerLeft(layerAnchorLeft(opener, composerRef.current, next));
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

  // Search, Knowledge, Skills, and MCP rows are selection toggles: the menu
  // stays open so several can be combined in one visit. Only rows that hand
  // off to another surface (Assistant picker, file dialog, Skill Library,
  // MCP settings, Model parameters) close it.
  function toggleSearch(option: CatalogSearchStrategy) {
    if (!onSelectSearchOptionIds) return;
    const next = selectedSearchSet.has(option.strategyId)
      ? selectedSearchOptionIds.filter((id) => id !== option.strategyId)
      : [...selectedSearchOptionIds, option.strategyId];
    onSelectSearchOptionIds(next);
  }

  function toggleKnowledge(base: ComposerConfigKnowledgeBase) {
    if (!onSelectKnowledgeSelection && !onSelectKnowledgeBaseIds) return;
    const next = selectedKnowledgeSet.has(base.id)
      ? knowledgeSelection.baseIds.filter((id) => id !== base.id)
      : [...knowledgeSelection.baseIds, base.id];
    selectKnowledge(explicitKnowledgeSelection({
      baseIds: next,
      sourceIds: knowledgeSelection.sourceIds
    }));
  }

  function selectKnowledge(selection: KnowledgeSelection) {
    if (onSelectKnowledgeSelection) onSelectKnowledgeSelection(selection);
    else onSelectKnowledgeBaseIds?.(selection.baseIds);
  }

  function toggleKnowledgeSource(source: ComposerConfigKnowledgeSource) {
    if (!onSelectKnowledgeSelection) return;
    const next = selectedKnowledgeSourceSet.has(source.id)
      ? knowledgeSelection.sourceIds.filter((id) => id !== source.id)
      : [...knowledgeSelection.sourceIds, source.id];
    selectKnowledge(explicitKnowledgeSelection({
      baseIds: knowledgeSelection.baseIds,
      sourceIds: next
    }));
  }

  function selectMcpMode(mode: McpRunSelection["mode"]) {
    if (!onSelectMcp) return;
    onSelectMcp({ mode });
  }

  function toggleSkill(skillId: string) {
    if (!onSelectSkillIds) return;
    const next = selectedSkillSet.has(skillId)
      ? selectedSkillIds.filter((id) => id !== skillId)
      : selectedSkillIds.length < SKILL_MAX_SELECTED
        ? [...selectedSkillIds, skillId]
        : selectedSkillIds;
    onSelectSkillIds(next);
  }

  // The Knowledge chip is a permanent entry into its picker whenever anything
  // can be selected; the Assistant-locked state keeps only a selected label.
  const knowledgeAvailable = Boolean(onSelectKnowledgeSelection || onSelectKnowledgeBaseIds) && (
    (config?.knowledgeBases.length ?? 0) > 0 ||
    (config?.knowledgeSources?.length ?? 0) > 0 ||
    Boolean(onSearchKnowledgeSources) ||
    (!sharedProject && Boolean(onSelectKnowledgeSelection))
  );
  const knowledgeChipVisible = Boolean(config) && (
    knowledgeSelection.mode !== "none" || (knowledgeAvailable && !controlsLocked)
  );
  const searchActive = selectedSearchOptionIds.length > 0;
  const searchChipVisible = Boolean(config) && (
    searchActive || (concreteSearchOptions.length > 0 && !controlsLocked)
  );
  const enabledMcpServers = config?.mcpServers.filter((server) => server.enabled) ?? [];
  // Transitional states (activating, on-demand idle) are not problems; only
  // the Settings-level "attention"/"failed" presentations count here.
  const mcpServersNeedingAttention = enabledMcpServers.filter((server) => {
    const kind = mcpReadinessPresentation(server.readiness).kind;
    return kind === "attention" || kind === "failed";
  }).length;

  return (
    <div className="v2-composer-wrap" data-testid="composer-v2">
      <div
        ref={composerRef}
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
        {selectedAssistant && (assistantSkills.length > 0 || selectedSkillNames.length > 0) ? (
          <div className="v2-composer-skill-ledger" data-testid="composer-v2-skill-ledger">
            {assistantSkills.length > 0 ? (
              <div>
                <strong>Included by Assistant</strong>
                <ol>
                  {assistantSkills.map((skill, index) => (
                    <li key={skill.id}>{index + 1}. {skill.name}</li>
                  ))}
                </ol>
              </div>
            ) : null}
            {selectedSkillNames.length > 0 ? (
              <div>
                <span className="v2-composer-skill-ledger-heading">
                  <strong>Added manually</strong>
                  {onOpenSkillLibrary ? (
                    <button
                      className="v2-focusable"
                      disabled={activeRun}
                      type="button"
                      onClick={onOpenSkillLibrary}
                    >
                      Manage
                    </button>
                  ) : null}
                </span>
                <ol>
                  {selectedSkillNames.map((name, index) => (
                    <li key={selectedSkillIds[index]}>{index + 1}. {name}</li>
                  ))}
                </ol>
              </div>
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
          sharedProject={sharedProject}
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
            label="Add"
            aria-controls={`${layerId}-add`}
            aria-expanded={layer === "add"}
            aria-haspopup="menu"
            disabled={!config || configError || noModels || activeRun}
            onClick={(event) => openLayer("add", event.currentTarget)}
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
            {currentModel ? <UiV2Monogram label={currentProviderGlyph} /> : null}
            <strong>{currentModel?.displayName ?? (noModels ? "No models available" : "Choose model")}</strong>
            {controlsLocked ? <UiV2Icon name="lock" /> : <UiV2Icon name="chevron-down" />}
          </button>

          <div className="v2-composer-indicators" aria-label="Active capabilities">
            {searchChipVisible ? (
              <span className="v2-composer-indicator-group">
                <button
                  ref={searchTriggerRef}
                  className="v2-composer-indicator v2-focusable"
                  type="button"
                  data-quiet={searchActive ? undefined : ""}
                  data-glyph="globe"
                  disabled={controlsLocked || activeRun || !onSelectSearchOptionIds}
                  aria-controls={`${layerId}-search`}
                  aria-expanded={layer === "search"}
                  aria-haspopup="menu"
                  aria-label="Choose web search"
                  onClick={(event) => openLayer("search", event.currentTarget)}
                >
                  <span aria-hidden="true" />
                  <UiV2Icon className="v2-composer-indicator-glyph" name="globe" />
                  <span className="v2-composer-indicator-label">Search</span>
                  {controlsLocked ? <UiV2Icon name="lock" /> : searchActive ? null : <UiV2Icon name="chevron-down" />}
                </button>
                {searchActive && !controlsLocked ? (
                  <button
                    className="v2-composer-indicator-clear v2-focusable"
                    type="button"
                    disabled={activeRun || !onSelectSearchOptionIds}
                    aria-label="Turn off Search"
                    onClick={() => onSelectSearchOptionIds?.([])}
                  >
                    <UiV2Icon name="close" />
                  </button>
                ) : null}
              </span>
            ) : null}
            {knowledgeChipVisible ? (
              <span className="v2-composer-indicator-group">
                <button
                  ref={knowledgeTriggerRef}
                  className="v2-composer-indicator v2-focusable"
                  type="button"
                  data-quiet={knowledgeSelection.mode === "none" ? "" : undefined}
                  disabled={controlsLocked || activeRun || (!onSelectKnowledgeSelection && !onSelectKnowledgeBaseIds)}
                  aria-controls={`${layerId}-knowledge`}
                  aria-expanded={layer === "knowledge"}
                  aria-haspopup="menu"
                  aria-label="Choose Knowledge"
                  data-glyph="book"
                  onClick={(event) => openLayer("knowledge", event.currentTarget)}
                >
                  <span aria-hidden="true" />
                  <UiV2Icon className="v2-composer-indicator-glyph" name="book" />
                  <span className="v2-composer-indicator-label">
                    {knowledgeSelection.mode === "none" ? (
                      "Knowledge"
                    ) : (
                      <>
                        <span className="v2-composer-indicator-prefix">Knowledge: </span>
                        {knowledgeSelection.mode === "all_my_knowledge"
                          ? "All mine"
                          : selectedKnowledgeNames.length === 1
                            ? selectedKnowledgeNames[0]
                            : selectedKnowledgeNames.length}
                      </>
                    )}
                  </span>
                  {controlsLocked ? <UiV2Icon name="lock" /> : <UiV2Icon name="chevron-down" />}
                </button>
                {knowledgeSelection.mode !== "none" && !controlsLocked ? (
                  <button
                    className="v2-composer-indicator-clear v2-focusable"
                    type="button"
                    disabled={activeRun || (!onSelectKnowledgeSelection && !onSelectKnowledgeBaseIds)}
                    aria-label="Turn off Knowledge"
                    onClick={() => selectKnowledge(EMPTY_KNOWLEDGE_SELECTION)}
                  >
                    <UiV2Icon name="close" />
                  </button>
                ) : null}
              </span>
            ) : null}
            {!controlsLocked ? (
              <button
                className="v2-composer-indicator v2-focusable"
                type="button"
                data-quiet={mcpSelection.mode === "load_all" ? undefined : ""}
                data-glyph="tool"
                data-mcp-mode={mcpSelection.mode}
                disabled={activeRun || controlsLocked}
                aria-controls={`${layerId}-tools`}
                aria-expanded={layer === "tools"}
                aria-haspopup="menu"
                aria-label="Change MCP mode"
                onClick={(event) => openLayer("tools", event.currentTarget)}
              >
                {/* The accent dot marks a loaded capability; Auto (discover
                    on demand) and Off stay quiet so the dot never reads as
                    "tools are on" by default. The chip names MCP, not
                    "Tools": Search and Knowledge are tools too. */}
                <span aria-hidden="true" />
                <UiV2Icon className="v2-composer-indicator-glyph" name="tool" />
                <span className="v2-composer-indicator-label">
                  MCP: {mcpSelection.mode === "load_all"
                    ? "Load all"
                    : mcpSelection.mode === "off" ? "Off" : "Auto"}
                </span>
                <UiV2Icon name="chevron-down" />
              </button>
            ) : null}
            {selectedSkillIds.length > 0 ? (
              <button
                className="v2-composer-indicator v2-focusable"
                type="button"
                disabled={activeRun || !onOpenSkillLibrary}
                aria-label="Manage selected Skills"
                onClick={onOpenSkillLibrary}
              >
                <span aria-hidden="true" />Skills: {selectedSkillIds.length}
              </button>
            ) : null}
          </div>

          <span className="v2-composer-spacer" />
          {contextStats && contextGaugeVisible ? <ContextGaugeV2 stats={contextStats} usage={usageStats} /> : null}
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
              aria-label={LAYER_LABELS[layer]}
              style={{ "--v2-composer-layer-left": `${layerLeft}px` } as CSSProperties}
              onKeyDown={handleLayerKeyDown}
            >
              {/* The header is the mobile sheet's title and close control; the
                  desktop popover hides it and closes from Esc, outside click,
                  or a selection (PRD §4.6). */}
              <header className="v2-composer-layer-header">
                <strong>{LAYER_TITLES[layer]}</strong>
                <UiV2IconButton icon="close" label="Close" onClick={closeLayer} />
              </header>

              {layer === "model" ? (
                <ModelLayer
                  config={config}
                  groups={groupedModels}
                  parametersSummary={modelParametersSummary}
                  query={modelQuery}
                  selectedModelId={selectedModelId}
                  selectedProvider={selectedProvider}
                  onMakeDefault={onMakeModelDefault}
                  onOpenParameters={onOpenModelParameters && !controlsLocked
                    ? () => {
                        onOpenModelParameters();
                        closeLayer();
                      }
                    : undefined}
                  onQuery={setModelQuery}
                  onSelect={(model) => {
                    onSelectModel?.(model);
                    closeLayer();
                  }}
                />
              ) : layer === "search" ? (
                <div className="v2-composer-layer-scroll">
                  <p className="v2-composer-layer-title">Web search</p>
                  <CapabilityRow
                    selected={!searchActive}
                    disabled={controlsLocked || activeRun || !onSelectSearchOptionIds}
                    reason={controlsLocked ? "Managed by the Assistant" : "No web search this turn"}
                    selectionRole="radio"
                    onClick={() => {
                      onSelectSearchOptionIds?.([]);
                      closeLayer();
                    }}
                  >
                    Off
                  </CapabilityRow>
                  {concreteSearchOptions.length === 0 ? (
                    <CapabilityRow disabled reason="Not configured by the administrator" selectionRole="radio">
                      Search
                    </CapabilityRow>
                  ) : concreteSearchOptions.map((option) => {
                    const selected = selectedSearchSet.has(option.strategyId);
                    const compatible = compatibleSearchOptionIds.has(option.strategyId);
                    const reason = controlsLocked
                      ? "Managed by the Assistant"
                      : !compatible
                        ? `Not available for ${currentModel?.displayName ?? "this model"}`
                        : option.description ?? null;
                    return (
                      <CapabilityRow
                        key={option.strategyId}
                        selected={selected}
                        disabled={controlsLocked || activeRun || !onSelectSearchOptionIds || (!compatible && !selected)}
                        reason={reason}
                        selectionRole="radio"
                        onClick={() => {
                          onSelectSearchOptionIds?.([option.strategyId]);
                          closeLayer();
                        }}
                      >
                        {option.displayName}
                      </CapabilityRow>
                    );
                  })}
                  <p className="v2-composer-privacy-note">Applies to your next message.</p>
                </div>
              ) : layer === "tools" ? (
                <div className="v2-composer-layer-scroll">
                  <p className="v2-composer-layer-title">MCP tools</p>
                  {controlsLocked ? (
                    <CapabilityRow
                      selected
                      disabled
                      reason="Defined by the selected Assistant"
                      selectionRole="radio"
                    >
                      Assistant tools
                    </CapabilityRow>
                  ) : (
                    <>
                      <CapabilityRow
                        selected={mcpSelection.mode === "auto"}
                        disabled={activeRun || !currentModel?.capabilities.toolCalling || !onSelectMcp}
                        reason={!currentModel?.capabilities.toolCalling
                          ? "The current model cannot use tools; this mode is preserved"
                          : "Small catalog first; matching tools load when the model asks"}
                        selectionRole="radio"
                        onClick={() => {
                          selectMcpMode("auto");
                          closeLayer();
                        }}
                      >
                        Auto
                      </CapabilityRow>
                      <CapabilityRow
                        selected={mcpSelection.mode === "load_all"}
                        disabled={activeRun || !currentModel?.capabilities.toolCalling || !onSelectMcp}
                        reason={!currentModel?.capabilities.toolCalling
                          ? "The current model cannot use tools; this mode is preserved"
                          : "Every tool from enabled servers, from the first message"}
                        selectionRole="radio"
                        onClick={() => {
                          selectMcpMode("load_all");
                          closeLayer();
                        }}
                      >
                        Load all
                      </CapabilityRow>
                      <CapabilityRow
                        selected={mcpSelection.mode === "off"}
                        disabled={activeRun || !onSelectMcp}
                        reason="No MCP tools this turn"
                        selectionRole="radio"
                        onClick={() => {
                          selectMcpMode("off");
                          closeLayer();
                        }}
                      >
                        Off
                      </CapabilityRow>
                    </>
                  )}
                  {!controlsLocked ? (
                    /* What the modes act on: enabling stays a Settings action
                       (FRONTEND.md), so this is disclosure, not selection. */
                    <div className="v2-composer-layer-footer">
                      <div className="v2-composer-layer-footer-row">
                        <p className="v2-composer-layer-note" data-testid="composer-v2-mcp-enabled">
                          {enabledMcpServers.length === 0
                            ? "No servers enabled."
                            : `Enabled servers · ${enabledMcpServers.length}${
                              mcpServersNeedingAttention > 0
                                ? ` · ${mcpServersNeedingAttention} need${mcpServersNeedingAttention === 1 ? "s" : ""} attention`
                                : ""
                            }`}
                        </p>
                        {onOpenMcpSettings ? (
                          <button
                            className="v2-composer-layer-link v2-focusable"
                            data-v2-composer-option="true"
                            type="button"
                            role="menuitem"
                            aria-label="Manage enabled MCP servers"
                            onClick={() => {
                              onOpenMcpSettings();
                              closeLayer();
                            }}
                          >
                            Manage
                            <UiV2Icon name="chevron-right" />
                          </button>
                        ) : null}
                      </div>
                      {enabledMcpServers.length > 0 ? (
                        <div className="v2-composer-tags" data-testid="composer-v2-mcp-servers">
                          {enabledMcpServers.map((server) => (
                            <span className="v2-composer-tag" key={server.id}>{server.name}</span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : layer === "knowledge" ? (
                <div className="v2-composer-layer-scroll">
                  {onSearchKnowledgeSources ||
                    (config?.knowledgeBases.length ?? 0) + (config?.knowledgeSources?.length ?? 0) > 6 ? (
                    <label className="v2-composer-model-search-wrap">
                      <UiV2Icon name="search" />
                      <input
                        data-v2-knowledge-search
                        aria-label="Search Knowledge resources"
                        maxLength={KNOWLEDGE_SOURCE_SEARCH_MAX_LENGTH}
                        placeholder="Search bases and sources…"
                        type="search"
                        value={knowledgeQuery}
                        onChange={(event) => setKnowledgeQuery(event.currentTarget.value)}
                      />
                    </label>
                  ) : null}
                  <CapabilityRow
                    selected={knowledgeSelection.mode === "none"}
                    disabled={controlsLocked || activeRun}
                    selectionRole="radio"
                    onClick={() => {
                      selectKnowledge(EMPTY_KNOWLEDGE_SELECTION);
                      closeLayer();
                    }}
                  >
                    None
                  </CapabilityRow>
                  {!sharedProject && onSelectKnowledgeSelection ? (
                    <CapabilityRow
                      selected={knowledgeSelection.mode === "all_my_knowledge"}
                      disabled={controlsLocked || activeRun}
                      reason="Every ready Base and Source you own"
                      selectionRole="radio"
                      onClick={() => {
                        selectKnowledge(allMyKnowledgeSelection());
                        closeLayer();
                      }}
                    >
                      All my knowledge
                    </CapabilityRow>
                  ) : null}
                  {(config?.knowledgeBases.length ?? 0) === 0 &&
                    (config?.knowledgeSources?.length ?? 0) === 0 &&
                    knowledgeSelection.mode === "none" ? (
                    <CapabilityRow icon="library" disabled reason="No knowledge bases available">
                      Knowledge
                    </CapabilityRow>
                  ) : null}
                  {visibleKnowledgeBases.length > 0 ? (
                    <p className="v2-composer-layer-label">Bases</p>
                  ) : null}
                  {visibleKnowledgeBases.map((base) => {
                    const selected = selectedKnowledgeSet.has(base.id);
                    const reason = controlsLocked
                      ? "Managed by the Assistant"
                      : base.archived
                        ? "Access revoked or base archived"
                        : base.description || "Includes this Base’s current ready Sources";
                    return (
                      <CapabilityRow
                        key={base.id}
                        icon="library"
                        selected={selected}
                        disabled={controlsLocked || activeRun || (base.archived && !selected)}
                        reason={reason}
                        onClick={() => toggleKnowledge(base)}
                      >
                        {base.name}
                      </CapabilityRow>
                    );
                  })}
                  {visibleKnowledgeSources.length > 0 ? (
                    <p className="v2-composer-layer-label">Sources</p>
                  ) : null}
                  {visibleKnowledgeSources.map((source) => {
                    const selected = selectedKnowledgeSourceSet.has(source.id);
                    const unavailable = source.readiness !== "ready";
                    const reason = controlsLocked
                      ? "Managed by the Assistant"
                      : unavailable
                        ? source.readiness === "processing"
                          ? "Processing · skipped until ready"
                          : "Needs attention before it can be searched"
                        : `Ready${source.description ? ` · ${source.description}` : ""}`;
                    return (
                      <CapabilityRow
                        key={`source:${source.id}`}
                        icon="book"
                        selected={selected}
                        disabled={controlsLocked || activeRun || !onSelectKnowledgeSelection || (unavailable && !selected)}
                        reason={reason}
                        onClick={() => toggleKnowledgeSource(source)}
                      >
                        {source.name}
                      </CapabilityRow>
                    );
                  })}
                  {knowledgeSelection.baseIds
                    .filter((id) => !knowledgeById.has(id))
                    .map((id) => (
                      <CapabilityRow
                        key={id}
                        icon="library"
                        selected
                        disabled={controlsLocked || activeRun}
                        reason={controlsLocked ? "Managed by the Assistant" : "Access revoked"}
                        onClick={() => {
                          selectKnowledge(explicitKnowledgeSelection({
                            baseIds: knowledgeSelection.baseIds.filter((candidate) => candidate !== id),
                            sourceIds: knowledgeSelection.sourceIds
                          }));
                        }}
                      >
                        Unavailable knowledge base
                      </CapabilityRow>
                    ))}
                  {knowledgeSelection.sourceIds
                    .filter((id) => !sourceById.has(id))
                    .map((id) => (
                      <CapabilityRow
                        key={`missing-source:${id}`}
                        icon="book"
                        selected
                        disabled={controlsLocked || activeRun}
                        reason={controlsLocked ? "Managed by the Assistant" : "Access revoked"}
                        onClick={() => {
                          selectKnowledge(explicitKnowledgeSelection({
                            baseIds: knowledgeSelection.baseIds,
                            sourceIds: knowledgeSelection.sourceIds.filter((candidate) => candidate !== id)
                          }));
                        }}
                      >
                        Unavailable Knowledge source
                      </CapabilityRow>
                    ))}
                  <div className="v2-composer-layer-footer">
                    <div className="v2-composer-layer-footer-row">
                      <p className="v2-composer-layer-note">Scope is checked again on the server.</p>
                      {onOpenKnowledgeLibrary ? (
                        <button
                          className="v2-composer-layer-link v2-focusable"
                          data-v2-composer-option="true"
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            onOpenKnowledgeLibrary();
                            closeLayer();
                          }}
                        >
                          Manage in Library
                          <UiV2Icon name="chevron-right" />
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : (
                /* "+" is Add only (PRD §4.6): files, Knowledge, an Assistant,
                   Skills. Search, MCP and parameters live behind their chips. */
                <div className="v2-composer-layer-scroll">
                  <CapabilityRow
                    icon="attach"
                    disabled={attachmentSelectionDisabled}
                    reason={attachmentSelectionDisabled ? "Unavailable" : "XLSX · DOCX · PDF · images"}
                    selectionRole="item"
                    onClick={() => {
                      fileInputRef.current?.click();
                      closeLayer();
                    }}
                  >
                    Attach files
                  </CapabilityRow>
                  <CapabilityRow
                    icon="book"
                    disabled={controlsLocked || activeRun || !knowledgeAvailable}
                    reason={controlsLocked ? "Managed by the Assistant" : "Base or Source for this chat"}
                    selectionRole="item"
                    onClick={(event) => {
                      openLayer("knowledge", knowledgeTriggerRef.current ?? event.currentTarget);
                    }}
                  >
                    Add Knowledge…
                  </CapabilityRow>
                  <CapabilityRow
                    icon="assistant"
                    disabled={activeRun || !onOpenAssistantPicker}
                    reason={selectedAssistant
                      ? `Selected: ${selectedAssistant.name}`
                      : "Pinned · Recent · Yours · Shared"}
                    selectionRole="item"
                    onClick={() => {
                      onOpenAssistantPicker?.();
                      closeLayer();
                    }}
                  >
                    Use an Assistant…
                  </CapabilityRow>
                  <CapabilityRow
                    icon="wand"
                    disabled={activeRun || !onOpenSkillLibrary}
                    reason={selectedSkillIds.length === 0
                      ? "Reusable text instructions"
                      : `${selectedSkillIds.length} selected${selectedSkills.length > 0
                        ? ` · ${selectedSkills.map((skill) => skill.name).join(", ")}`
                        : ""}`}
                    selectionRole="item"
                    onClick={() => {
                      onOpenSkillLibrary?.();
                      closeLayer();
                    }}
                  >
                    Skills…
                  </CapabilityRow>
                  <p className="v2-composer-privacy-note">
                    {sharedProject ? "Files are visible to Project members." : "Files are private and visible only to you."}
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

type ModelCapabilityGlyph = Readonly<{ icon: UiV2IconName; label: string }>;

/* Capability glyphs replace text tags in the picker (PRD §4.6); the same
   labels stay in the row's accessible name and title. */
function modelCapabilityGlyphs(model: CatalogModel): ModelCapabilityGlyph[] {
  const glyphs: ModelCapabilityGlyph[] = [];
  if (model.capabilities.reasoning) glyphs.push({ icon: "memory", label: "Reasoning" });
  if (model.capabilities.documentInputMode !== "none") glyphs.push({ icon: "file", label: "PDF and documents" });
  if (model.capabilities.imageInput) glyphs.push({ icon: "image", label: "Images" });
  if (model.capabilities.nativeWebSearch || model.capabilities.openRouterPerplexitySearch) {
    glyphs.push({ icon: "globe", label: "Web search" });
  }
  if (model.capabilities.toolCalling) glyphs.push({ icon: "tool", label: "Tools" });
  return glyphs;
}

function ModelLayer({
  config,
  groups,
  onMakeDefault,
  onOpenParameters,
  onQuery,
  onSelect,
  parametersSummary,
  query,
  selectedModelId,
  selectedProvider
}: Readonly<{
  config: ComposerConfig | null;
  groups: Array<{ models: CatalogModel[]; provider: CatalogProvider }>;
  onMakeDefault?(model: CatalogModel): void;
  onOpenParameters?(): void;
  onQuery(value: string): void;
  onSelect(model: CatalogModel): void;
  parametersSummary: string | null;
  query: string;
  selectedModelId: string;
  selectedProvider: string;
}>) {
  const personalDefault = config?.catalog.defaults.personalModelDefault;
  const organizationDefault = config?.catalog.defaults.organizationModelDefault;
  const hasMatches = groups.some((group) => group.models.length > 0);
  const modelCount = groups.reduce((count, group) => count + group.models.length, 0);

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
        <span className="v2-composer-model-count" aria-hidden="true">{modelCount}</span>
      </label>
      <div className="v2-composer-layer-scroll" role="listbox" aria-label="Available models">
        {!hasMatches ? (
          <p className="v2-composer-empty-options" role="status">
            {config?.catalog.models.length ? "No models match your search" : "No models available"}
          </p>
        ) : groups.map((group) => (
          <section className="v2-composer-model-group" key={group.provider.id || group.provider.name}>
            <h3>
              <UiV2Monogram label={group.provider.family || group.provider.name} />
              <span>{group.provider.name}</span>
            </h3>
            {group.models.map((model) => {
              const selected = model.modelId === selectedModelId && model.provider === selectedProvider;
              const isPersonalDefault = personalDefault?.modelId === model.modelId &&
                personalDefault.provider === model.provider;
              const isOrganizationDefault = organizationDefault?.modelId === model.modelId &&
                organizationDefault.provider === model.provider;
              const capabilityLabels = modelCapabilityLabels(model);
              const capabilityTags = capabilityLabels.length > 0 ? capabilityLabels : ["Text"];
              const glyphs = modelCapabilityGlyphs(model);
              return (
                <div
                  className="v2-composer-model-row"
                  data-selected={selected || undefined}
                  key={`${model.provider}:${model.modelId}`}
                >
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
                    <span className="v2-composer-model-name">{model.displayName}</span>
                    {/* Capabilities read as glyphs; the joined labels stay in
                        the accessible name and the hover title. */}
                    <span className="v2-sr-only">{capabilityTags.join(" · ")}</span>
                    {isOrganizationDefault ? <em className="v2-composer-model-fact">Org default</em> : null}
                    <span className="v2-composer-model-glyphs" title={capabilityTags.join(" · ")} aria-hidden="true">
                      {glyphs.map((glyph) => <UiV2Icon key={glyph.icon} name={glyph.icon} />)}
                    </span>
                    <span className="v2-composer-model-mark" aria-hidden="true">
                      {isPersonalDefault ? <UiV2Icon className="v2-composer-model-star" name="star-fill" /> : null}
                      {selected ? <UiV2Icon className="v2-composer-model-check" name="check" /> : null}
                    </span>
                  </button>
                  {onMakeDefault && !isPersonalDefault ? (
                    <button
                      className="v2-composer-model-default v2-focusable"
                      type="button"
                      aria-label={`Make ${model.displayName} your default model`}
                      onClick={() => onMakeDefault(model)}
                    >
                      Set as default
                      <UiV2Icon name="star" />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </section>
        ))}
      </div>
      <div className="v2-composer-layer-footer">
        {onOpenParameters ? (
          <button
            className="v2-composer-model-parameters v2-focusable"
            data-testid="composer-v2-model-parameters"
            type="button"
            onClick={onOpenParameters}
          >
            <UiV2Icon name="sliders" />
            <span>Parameters</span>
            {parametersSummary ? (
              <span className="v2-composer-model-parameters-summary">{parametersSummary}</span>
            ) : null}
            <UiV2Icon name="chevron-right" />
          </button>
        ) : null}
        <p className="v2-composer-model-note">
          Applies to your next message.
        </p>
      </div>
    </>
  );
}
