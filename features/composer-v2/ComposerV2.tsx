"use client";

import { mcpReadinessPresentation } from "@/components/app-shell/mcpReadiness";
import type { ComposerMcpSelection } from "@/components/app-shell/composerControlStore";
import type { ComposerArtifactEdit } from "@/components/app-shell/composerSessionStore";
import {
  AssistantRowNoticeV2,
  assistantRowDescription,
  assistantRowNoticeText,
  assistantRowProvenance,
  assistantRowResettable,
  boundComposerAssistantV2,
  type AssistantRowProvenanceV2,
  type ComposerV2Assistant
} from "./AssistantRowProvenanceV2";

import { isImeCompositionEvent } from "@/components/keyboard";
import { RUN_FOLLOWUP_MAX_CHARS } from "@/lib/contracts/runFollowups";
import type { AttachmentLimitUsage } from "@/components/app-shell/attachmentLimitUsage";
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
  UiV2ProviderMark
} from "@/components/ui-v2";
import { RunComposerActionV2 } from "@/features/run-lifecycle-v2/RunLifecycleV2";
import { AttachmentTrayV2 } from "@/features/attachments-v2/AttachmentTrayV2";
import { SavedFilePickerV2 } from "@/features/attachments-v2/SavedFilePickerV2";
import {
  attachmentItemBlocksSend,
  attachmentSendBlockReasonV2,
  type ComposerAttachmentItemV2
} from "@/features/attachments-v2/attachmentPresentation";
import { SearchPlanPickerV2 } from "@/components/ui-v2/SearchPlanPickerV2";
import type { SearchPlanMode } from "@/lib/domain/search";
import type { CatalogModel, CatalogProvider, CatalogSearchStrategy } from "@/lib/contracts/catalog";
import type { McpRunSelection } from "@/lib/contracts/mcp";
import type {
  ChatWorkspaceState,
  WorkspaceUnavailableReason
} from "@/lib/contracts/workspace";
import { resolveEffectiveSkillIds } from "@/lib/contracts/skills";
import type {
  ComposerConfig,
  ComposerConfigKnowledgeBase,
  ComposerConfigKnowledgeSource
} from "@/lib/contracts/composerConfig";
import {
  allMyKnowledgeSelection,
  EMPTY_KNOWLEDGE_SELECTION,
  explicitKnowledgeSelection,
  KNOWLEDGE_SELECTION_MAX_EXPLICIT_RESOURCES,
  KNOWLEDGE_SOURCE_SEARCH_MAX_LENGTH,
  type KnowledgeSelection
} from "@/lib/contracts/knowledge";
import { knowledgeAggregateStatus } from "@/lib/domain/knowledgePresentation";
import { createPortal } from "react-dom";
import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type CSSProperties
} from "react";

export type ComposerV2Layer = "add" | "files" | "knowledge" | "model" | "search" | "tools" | "skills" | "workspace" | null;

/**
 * Imperative handle for openers outside the composer (the header model
 * selector): the composer keeps owning the layer, its dismissal, keyboard
 * contract, and focus return while the anchor lives anywhere in the document.
 */
export type ComposerV2LayerController = Readonly<{
  close(): void;
  toggle(layer: Exclude<ComposerV2Layer, null>, anchor: HTMLButtonElement): void;
}>;

const LAYER_LABELS: Record<Exclude<ComposerV2Layer, null>, string> = {
  add: "Add",
  files: "Saved files",
  knowledge: "Knowledge",
  model: "Choose model",
  search: "Web search",
  workspace: "Workspace",
  skills: "Skills",
  tools: "MCP tools"
};
const LAYER_TITLES: Record<Exclude<ComposerV2Layer, null>, string> = {
  add: "Add",
  files: "Saved files",
  knowledge: "Knowledge",
  model: "Model",
  search: "Web search",
  workspace: "Workspace",
  skills: "Skills",
  tools: "MCP tools"
};
/* Desktop popover widths (see composer.css) used to keep a chip-anchored layer
   inside the composer frame. */
const LAYER_WIDTH_PX: Record<Exclude<ComposerV2Layer, null>, number> = {
  add: 300,
  files: 380,
  knowledge: 380,
  model: 380,
  search: 330,
  workspace: 340,
  skills: 340,
  tools: 340
};
const SEARCH_PROVIDER_FAMILY_NAMES: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  google: "Google",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  perplexity: "Perplexity"
};

const AGENT_HELP = "Codex carries out your task in Workspace. Uses the selected model, Skills, MCP mode and saved Workspace secrets. Can create artifacts and use the configured image model. Available while this Workspace exists. Personal Memory and Knowledge are unavailable.";

function CapabilityChipContent({ label, icon, count = 0, signal, description, descriptionId }: Readonly<{
  label: string;
  icon: UiV2IconName;
  count?: number;
  signal?: "running" | "attention";
  description: string;
  descriptionId: string;
}>) {
  return <>
    <span className="v2-composer-indicator-face" aria-hidden="true">
      <span className="v2-composer-indicator-icon">
        <UiV2Icon className="v2-composer-indicator-glyph" name={icon} />
        {signal ? <span className="v2-composer-indicator-signal" data-signal={signal} /> : null}
      </span>
      <span className="v2-composer-indicator-label">{label}</span>
      {count > 0 ? <span className="v2-composer-indicator-count">{count > 99 ? "99+" : count}</span> : null}
    </span>
    <span className="v2-sr-only" id={descriptionId}>{description}</span>
  </>;
}

function searchEngineShortName(
  strategy: CatalogSearchStrategy,
  providerFamily: string | undefined
): string {
  const withoutSuffix = strategy.displayName
    .replace(/\s+web\s+search$/iu, "")
    .replace(/\s+search$/iu, "")
    .trim();
  const normalized = withoutSuffix.toLocaleLowerCase();
  if (withoutSuffix && normalized !== "search" && normalized !== "web") {
    return withoutSuffix;
  }
  return (providerFamily && SEARCH_PROVIDER_FAMILY_NAMES[providerFamily.toLocaleLowerCase()]) ||
    strategy.displayName;
}

function documentCountLabel(count: number): string {
  return `${count} ${count === 1 ? "document" : "documents"}`;
}

function resourceCountLabel(count: number): string {
  return `${count} ${count === 1 ? "resource" : "resources"}`;
}

function knowledgeBaseReason(base: ComposerConfigKnowledgeBase): string {
  const status = knowledgeAggregateStatus({
    attentionDocuments: base.attentionDocumentCount,
    processingDocuments: base.processingDocumentCount,
    readyDocuments: base.readyDocumentCount,
    state: base.readinessState
  }).label;
  return `${documentCountLabel(base.documentCount)} · ${
    status.charAt(0).toLocaleLowerCase() + status.slice(1)
  }`;
}

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

/**
 * Viewport position of a layer opened from outside the composer: directly
 * below its anchor, kept inside the viewport horizontally.
 */
function externalLayerAnchor(
  anchor: HTMLElement,
  kind: Exclude<ComposerV2Layer, null>
): Readonly<{ left: number; top: number }> {
  const box = anchor.getBoundingClientRect();
  const margin = 8;
  const maxLeft = Math.max(margin, window.innerWidth - LAYER_WIDTH_PX[kind] - margin);
  return {
    left: Math.round(Math.min(Math.max(margin, box.left), maxLeft)),
    top: Math.round(box.bottom + margin)
  };
}

/* An anchored popover wants this much room; with less above the composer it
   flips below when there is more room there (blank chat, UX audit A11). */
const LAYER_PREFERRED_PX = 480;

const EMPTY_MODELS: readonly CatalogModel[] = [];
const EMPTY_PROVIDERS: readonly CatalogProvider[] = [];

export type ComposerV2Props = Readonly<{
  /** Scopes transient notices without remounting the draft or its controls. */
  sessionKey?: string;
  agent?: Readonly<{ enabled: boolean; unavailableReason?: string; onToggle(value: boolean): void }>;
  activeRun?: boolean;
  artifactEdit?: ComposerArtifactEdit | null;
  artifactCreate?: boolean;
  artifactUnavailableReason?: string | null;
  onCreateArtifact?(): void;
  onRemoveArtifactCreate?(): void;
  /**
   * The chat's Assistant: each control shows the Assistant's part in its row
   * and resets it. Without one the composer behaves as an ordinary chat.
   */
  assistant?: ComposerV2Assistant | null;
  attachmentItems?: readonly ComposerAttachmentItemV2[];
  attachmentLimitUsage?: AttachmentLimitUsage | null;
  attachmentPolicy?: ComposerAttachmentPolicy;
  config: ComposerConfig | null;
  configError?: boolean;
  disabledReason?: string | null;
  draft: string;
  hasReadyAttachments?: boolean;
  initialLayer?: ComposerV2Layer;
  /** Lets an opener outside the composer (the header model selector) toggle a layer. */
  layerController?: Ref<ComposerV2LayerController | null>;
  /** "Reasoning medium · Temp 1.0" for the picker's Parameters row. */
  modelParametersSummary?: string | null;
  onAttachmentCountLimitExceeded?(input: {
    attemptedCount: number;
    currentCount: number;
    maxCount: number;
  }): void;
  onDraftChange(value: string): void;
  /** Observes which layer is open (the header selector mirrors it as aria-expanded). */
  onLayerChange?(layer: ComposerV2Layer): void;
  onMakeModelDefault?(model: CatalogModel): void;
  /** Opens the Knowledge section ("Manage Knowledge ›"). */
  onOpenKnowledgeLibrary?(): void;
  onOpenMcpSettings?(): void;
  onOpenSkillLibrary?(): void;
  /** Detaches an inherited Project plan before manual selection. */
  onOverrideKnowledgePlan?(): void;
  onOpenModelParameters?(): void;
  onRemoveAttachment?(id: string): void;
  onRemoveArtifactEdit?(): void;
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
  searchPlanMode?: SearchPlanMode;
  onSelectSearchPlanMode?(mode: SearchPlanMode): void;
  onResetSearchPlan?(): void;
  onSend?(): void;
  onFollowup?(runId: string): void;
  followupSending?: boolean;
  onStop?(runId: string): void;
  /** Keyboard contract: Enter sends (default), or inserts a newline while Ctrl/⌘+Enter sends. */
  sendWithEnter?: boolean;
  /** @deprecated MCP availability is configured in MCP servers; runs use onSelectMcp. */
  onToggleMcpServer?(serverId: string, enabled: boolean): void;
  onUploadFiles?(files: readonly File[]): Promise<void> | void;
  onReuseFile?(attachmentId: string, fileName: string): Promise<boolean>;
  runId?: string | null;
  knowledgePlanSource?: "assistant" | "chat" | "explicit" | "off" | "project";
  /** The effective MCP selection; an Assistant's exact server list is read from `assistant`. */
  mcpSelection?: ComposerMcpSelection;
  skillsMode?: "auto" | "off";
  onSelectSkillsMode?(mode: "auto" | "off"): void;
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
  uploadLimitHint?: string;
  workspace?: Readonly<{
    available: boolean;
    busy: boolean;
    commandRunning?: boolean;
    enabled: boolean;
    internetEnabled: boolean | null;
    loading: boolean;
    onToggle(value: boolean): void;
    sessionState: ChatWorkspaceState["sessionState"];
    unavailableReason?: WorkspaceUnavailableReason;
  }>;
}>;

export function workspaceStatusCopy(
  state: ChatWorkspaceState["sessionState"],
  commandRunning: boolean
): string {
  if (commandRunning || state === "running") return "Running a command…";
  switch (state) {
    case "creating": return "Creating workspace…";
    case "ready": return "Workspace ready";
    case "stopped": return "Workspace stopped";
    case "failed": return "Workspace unavailable";
    case "not_started":
    case null:
    default:
      return "Workspace has not started";
  }
}

function workspaceUnavailableCopy(reason: WorkspaceUnavailableReason | undefined): string {
  switch (reason) {
    case "model_tools_required":
      return "Workspace requires a model with tool support.";
    case "installation_disabled":
      return "Workspace is disabled by the administrator.";
    case "runtime_unavailable":
    default:
      return "Workspace runtime is unavailable.";
  }
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

/* Tab skips controls the layout does not draw (the desktop popover hides the
   sheet header's Close). */
function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'
  )).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true" &&
    element.checkVisibility?.() !== false);
}

function optionElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    '[data-v2-composer-option]:not(:disabled):not([aria-disabled="true"])'
  ));
}

/*
 * The option a menu opens on: its first enabled choice, never an action that
 * trails the choices (a footer link, "Pin your Skills…", Reset). A menu whose
 * choices are all disabled opens on the layer itself.
 */
function initialOption(container: HTMLElement): HTMLElement | undefined {
  return optionElements(container).find((option) => !option.hasAttribute("data-v2-composer-trailing"));
}

/*
 * One menu row for every composer popover: a radio glyph (single choice),
 * an icon plus trailing check (multi-select), or a plain action item
 * (`button` is the same action inside a dialog layer).
 */
function CapabilityRow({
  children,
  current = false,
  disabled = false,
  icon,
  onClick,
  reason,
  selected = false,
  selectionRole = "checkbox",
  trailing = false
}: Readonly<{
  children: ReactNode;
  /**
   * The value in force, which this menu cannot change: drawn as chosen at
   * full strength and announced as checked but unavailable (`aria-disabled`),
   * unlike a dimmed option that cannot be used.
   */
  current?: boolean;
  disabled?: boolean;
  icon?: UiV2IconName;
  onClick?(event: ReactMouseEvent<HTMLButtonElement>): void;
  reason?: string | null;
  selected?: boolean;
  selectionRole?: "button" | "checkbox" | "item" | "radio";
  /** An action after the menu's choices; the menu never opens on it. */
  trailing?: boolean;
}>) {
  const role = selectionRole === "radio"
    ? "menuitemradio"
    : selectionRole === "item" ? "menuitem" : selectionRole === "button" ? undefined : "menuitemcheckbox";
  const action = selectionRole === "item" || selectionRole === "button";
  const checked = selected || current;
  return (
    <button
      className="v2-composer-capability-row v2-focusable"
      data-v2-composer-option="true"
      data-v2-composer-trailing={trailing || undefined}
      data-selection={selectionRole}
      type="button"
      role={role}
      aria-checked={action ? undefined : checked}
      aria-disabled={current || undefined}
      disabled={disabled && !current}
      onClick={current ? undefined : onClick}
    >
      {selectionRole === "radio" ? (
        <span className="v2-composer-radio" data-checked={checked || undefined} aria-hidden="true" />
      ) : icon ? (
        <UiV2Icon name={icon} />
      ) : (
        <span aria-hidden="true" />
      )}
      <span className="v2-composer-capability-copy">
        <span>{children}</span>
        {reason ? <span>{reason}</span> : null}
      </span>
      {selectionRole === "checkbox" && checked ? <UiV2Icon name="check" /> : null}
    </button>
  );
}

export function ComposerV2({
  sessionKey = "composer",
  agent,
  activeRun = false,
  artifactEdit = null,
  artifactCreate = false,
  artifactUnavailableReason = null,
  onCreateArtifact,
  onRemoveArtifactCreate,
  assistant = null,
  attachmentItems = [],
  attachmentLimitUsage = null,
  attachmentPolicy = DEFAULT_COMPOSER_ATTACHMENT_POLICY,
  config,
  configError = false,
  disabledReason = null,
  draft,
  hasReadyAttachments = false,
  initialLayer = null,
  layerController,
  modelParametersSummary = null,
  onAttachmentCountLimitExceeded,
  onDraftChange,
  onLayerChange,
  onMakeModelDefault,
  onOpenKnowledgeLibrary,
  onOpenMcpSettings,
  onOpenModelParameters,
  onOpenSkillLibrary,
  onOverrideKnowledgePlan,
  onRemoveAttachment,
  onRemoveArtifactEdit,
  onRejectedFiles,
  onRetryConfig,
  onRetryAttachment,
  onSearchKnowledgeSources,
  onSelectKnowledgeSelection,
  onSelectKnowledgeBaseIds,
  onSelectMcp,
  onSelectModel,
  onSelectSearchOptionIds,
  searchPlanMode = "all_selected",
  onSelectSearchPlanMode,
  onResetSearchPlan,
  onSend,
  onFollowup,
  followupSending = false,
  onStop,
  onUploadFiles,
  onReuseFile,
  runId = null,
  sendWithEnter = true,
  mcpSelection = { mode: "auto" },
  skillsMode = "auto",
  onSelectSkillsMode,
  selectedKnowledgeSelection,
  selectedKnowledgeBaseIds = [],
  knowledgePlanSource = "off",
  selectedModelId,
  selectedProvider,
  selectedSearchOptionIds = [],
  selectedSkillIds = [],
  selectedSkills = [],
  sharedProject = false,
  sending = false,
  stopping = false,
  uploading = false,
  uploadLimitHint,
  workspace
}: ComposerV2Props) {
  const [layer, setLayer] = useState<ComposerV2Layer>(initialLayer);
  const [layerLeft, setLayerLeft] = useState(0);
  const [externalAnchor, setExternalAnchor] = useState<Readonly<{ left: number; top: number }> | null>(null);
  const [layerPlacement, setLayerPlacement] = useState<Readonly<{
    below: boolean;
    spaceAbove: number;
    spaceBelow: number;
  }>>({ below: false, spaceAbove: 0, spaceBelow: 0 });
  const [modelQuery, setModelQuery] = useState("");
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [knowledgeSourceSearch, setKnowledgeSourceSearch] = useState<Readonly<{
    query: string;
    sources: readonly ComposerConfigKnowledgeSource[];
  }> | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [agentNotice, setAgentNotice] = useState<{ sessionKey: string; kind: "mode" | "blocked" } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const plusTriggerRef = useRef<HTMLButtonElement>(null);
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
  const currentProvider = providers.find((provider) => provider.id === currentModel?.provider);
  const noModels = Boolean(config && models.length === 0);
  // The Assistant's part in each row: a dot on the control while the value is
  // the Assistant's, and the menu's first line in words. Nothing is hidden.
  const boundAssistant = boundComposerAssistantV2(assistant);
  const modelProvenance = assistantRowProvenance(boundAssistant, "model");
  const searchProvenance = assistantRowProvenance(boundAssistant, "search");
  const toolsProvenance = assistantRowProvenance(boundAssistant, "tools");
  const knowledgeProvenance = assistantRowProvenance(boundAssistant, "knowledge");
  const skillsProvenance = assistantRowProvenance(boundAssistant, "skills");
  const searchFixed = searchProvenance?.kind === "fixed";
  const toolsFixed = toolsProvenance?.kind === "fixed";
  const knowledgeFixed = knowledgeProvenance?.kind === "fixed";
  const skillsFixed = skillsProvenance?.kind === "fixed";
  const effectiveMcpSelection: ComposerMcpSelection = boundAssistant
    ? boundAssistant.rows.tools.value
    : mcpSelection;
  const includedSkills = boundAssistant?.includedSkills ?? [];
  const agentReason = agent?.unavailableReason ??
    ((selectedKnowledgeSelection && selectedKnowledgeSelection.mode !== "none") || selectedKnowledgeBaseIds.length > 0
      ? "Turn off Knowledge to use Agent." : null);
  const agentBlockReason = agent?.enabled ? agentReason : null;
  const artifactReason = artifactUnavailableReason ?? (sharedProject ? "Not available in projects" : null);
  const artifactBlockReason = artifactCreate || artifactEdit ? artifactReason : null;
  const followupMode = activeRun && Boolean(onFollowup) && Boolean(runId);
  const bootstrapReason = followupMode ? disabledReason : configError
    ? "Could not load available capabilities."
    : !config
      ? "Loading available capabilities…"
      : noModels
        ? "No models available. Contact your administrator."
        : disabledReason;
  const inputDisabled = followupMode ? Boolean(disabledReason) : Boolean(configError || !config || noModels || disabledReason);
  const attachmentBlockReason = attachmentSendBlockReasonV2(
    attachmentItems,
    attachmentLimitUsage,
    uploading
  );
  const readyAttachment = hasReadyAttachments || attachmentItems.some(
    (item) => !attachmentItemBlocksSend(item)
  );
  const effectiveSkillIds = resolveEffectiveSkillIds(includedSkills.filter(skill => skill.mode !== "available").map(({ id }) => id), selectedSkillIds);
  const effectiveSkillsMode = skillsMode;
  const followupTooLong = draft.length > RUN_FOLLOWUP_MAX_CHARS;
  const sendDisabled = followupMode ? Boolean(followupSending || stopping || inputDisabled || !draft.trim() || followupTooLong) : Boolean(
    sending || inputDisabled || artifactBlockReason || agentBlockReason || attachmentBlockReason || (!draft.trim() && !readyAttachment)
  );
  const sendDisabledReason = followupMode
    ? followupSending ? "Sending follow-up…" : bootstrapReason ?? (followupTooLong
      ? `Keep the follow-up under ${RUN_FOLLOWUP_MAX_CHARS.toLocaleString()} characters.` : !draft.trim() ? "Type a follow-up." : null)
    : sending
    ? "Sending message…"
    : bootstrapReason ?? artifactBlockReason ?? agentBlockReason ?? attachmentBlockReason ??
      (!draft.trim() && !readyAttachment ? "Type a message." : null);

  const attachmentAccept = attachmentAcceptForPolicy(attachmentPolicy);
  const attachmentSelectionDisabled = Boolean(
    !onUploadFiles || (!attachmentAccept && !attachmentPolicy.files) ||
      inputDisabled || activeRun || uploading
  );
  const workspaceToggleReason = workspace?.loading
    ? "Checking Workspace availability…"
    : workspace && !workspace.available
      ? workspaceUnavailableCopy(workspace.unavailableReason)
      : null;
  const workspaceToggleDisabled = Boolean(
    !workspace || workspace.loading || workspace.busy || activeRun ||
      (!workspace.enabled && !workspace.available)
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
  // A Project default stays locked until the user overrides it for the chat;
  // an Assistant's Knowledge is locked only when the Assistant fixes it.
  const knowledgeInheritedFrom = knowledgePlanSource === "project"
    ? "project" as const
    : knowledgeSelection.mode === "inherited"
      ? knowledgeSelection.inheritedFrom
      : null;
  const knowledgeProjectLocked = knowledgeInheritedFrom === "project";
  const knowledgeControlsLocked = knowledgeProjectLocked || knowledgeFixed;
  const selectedKnowledgeSet = new Set(knowledgeSelection.baseIds);
  const selectedKnowledgeSourceSet = new Set(knowledgeSelection.sourceIds);
  const assistantKnowledge = boundAssistant?.rows.knowledge.assistantValue;
  // A privacy-hidden Assistant plan is only counted, never identified.
  const assistantKnowledgeCount = assistantKnowledge?.mode === "explicit"
    ? assistantKnowledge.baseIds.length + assistantKnowledge.sourceIds.length + (assistantKnowledge.hiddenCount ?? 0)
    : 0;
  const selectedKnowledgeResourceCount = knowledgeSelection.mode === "inherited"
    ? assistantKnowledgeCount
    : knowledgeSelection.baseIds.length + knowledgeSelection.sourceIds.length;
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
  const matchingKnowledgeBases = (config?.knowledgeBases ?? []).filter((base) =>
    !normalizedKnowledgeQuery || `${base.name} ${base.description}`.toLocaleLowerCase()
      .includes(normalizedKnowledgeQuery));
  const visibleKnowledgeBases = [...new Map([
    ...matchingKnowledgeBases,
    ...(config?.knowledgeBases ?? []).filter((base) => selectedKnowledgeSet.has(base.id))
  ].map((base) => [base.id, base] as const)).values()];
  const matchingKnowledgeSources = allKnowledgeSources.filter((source) =>
    !normalizedKnowledgeQuery || `${source.name} ${source.description}`.toLocaleLowerCase()
      .includes(normalizedKnowledgeQuery));
  const visibleKnowledgeSources = [...new Map([
    ...(normalizedKnowledgeQuery ? matchingKnowledgeSources : matchingKnowledgeSources.slice(0, 5)),
    ...allKnowledgeSources.filter((source) => selectedKnowledgeSourceSet.has(source.id))
  ].map((source) => [source.id, source] as const)).values()];
  const hiddenKnowledgeDocumentCount = typeof config?.knowledgeDocumentTotal === "number"
    ? Math.max(0, config.knowledgeDocumentTotal - visibleKnowledgeSources.length)
    : null;
  const explicitSelectionAtLimit = selectedKnowledgeResourceCount >=
    KNOWLEDGE_SELECTION_MAX_EXPLICIT_RESOURCES;

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
        ? layerRef.current.querySelector<HTMLElement>("[data-v2-model-search]") ??
          layerRef.current.querySelector<HTMLElement>('[data-testid="composer-v2-model-parameters"]')
        : layer === "files"
          ? layerRef.current.querySelector<HTMLElement>("[data-v2-file-search]")
        : layer === "knowledge"
          ? layerRef.current.querySelector<HTMLElement>("[data-v2-knowledge-search]") ??
            initialOption(layerRef.current)
          : layer === "search"
            ? focusableElements(layerRef.current)[0]
            : initialOption(layerRef.current);
      // A menu opens at its first line: focus never scrolls it.
      (target ?? layerRef.current).focus({ preventScroll: true });
    });
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        layerRef.current?.contains(target) ||
        plusTriggerRef.current?.contains(target) ||
        openerRef.current?.contains(target)
      ) {
        return;
      }
      closeLayer();
    };
    const dismissSearchKey = (event: KeyboardEvent) => {
      // Clearing Search can disable the focused button and move focus to the body.
      if (layer !== "search" || event.defaultPrevented || event.key !== "Escape" || isImeCompositionEvent(event)) return;
      event.preventDefault();
      closeLayer();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissSearchKey);
    return () => {
      cancelled = true;
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissSearchKey);
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
    const external = !composerRef.current?.contains(opener);
    setExternalAnchor(external ? externalLayerAnchor(opener, next) : null);
    setLayerLeft(external ? 0 : layerAnchorLeft(opener, composerRef.current, next));
    // Free room above and below the composer inside its scroll owner (the
    // reading column; the viewport when there is none).
    const composerBox = composerRef.current?.getBoundingClientRect();
    const ownerBox = composerRef.current?.closest(".v2-conversation-scroll")?.getBoundingClientRect();
    const spaceAbove = composerBox ? Math.max(0, composerBox.top - (ownerBox?.top ?? 0)) : 0;
    const spaceBelow = composerBox
      ? Math.max(0, (ownerBox?.bottom ?? window.innerHeight) - composerBox.bottom)
      : 0;
    setLayerPlacement({
      below: !external && spaceAbove < LAYER_PREFERRED_PX && spaceBelow > spaceAbove,
      spaceAbove: Math.round(spaceAbove),
      spaceBelow: Math.round(spaceBelow)
    });
    setLayer(next);
  }

  function closeLayer() {
    const opener = openerRef.current;
    setLayer(null);
    setExternalAnchor(null);
    queueMicrotask(() => opener?.focus());
  }

  // External openers reach the same open/close path through a stable handle;
  // the latest closures are read at call time.
  const layerApiRef = useRef({ close: closeLayer, toggle: openLayer });
  layerApiRef.current = { close: closeLayer, toggle: openLayer };
  useImperativeHandle(layerController, () => ({
    close: () => layerApiRef.current.close(),
    toggle: (next, anchor) => layerApiRef.current.toggle(next, anchor)
  }), []);
  const onLayerChangeRef = useRef(onLayerChange);
  onLayerChangeRef.current = onLayerChange;
  useEffect(() => {
    onLayerChangeRef.current?.(layer);
  }, [layer]);
  // Follow the actual control when wrapping or resizing moves its anchor.
  const externallyAnchored = externalAnchor !== null;
  useEffect(() => {
    if (!layer) return;
    const reposition = () => {
      const opener = openerRef.current;
      const composer = composerRef.current;
      if (!opener || !composer) return;
      if (externallyAnchored) setExternalAnchor(externalLayerAnchor(opener, layer));
      else {
        setLayerLeft(layerAnchorLeft(opener, composer, layer));
        const box = composer.getBoundingClientRect();
        const owner = composer.closest(".v2-conversation-scroll")?.getBoundingClientRect();
        const above = Math.max(0, box.top - (owner?.top ?? 0));
        const below = Math.max(0, (owner?.bottom ?? window.innerHeight) - box.bottom);
        setLayerPlacement({ below: above < LAYER_PREFERRED_PX && below > above,
          spaceAbove: Math.round(above), spaceBelow: Math.round(below) });
      }
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reposition);
    if (composerRef.current) observer?.observe(composerRef.current);
    window.addEventListener("resize", reposition);
    return () => { observer?.disconnect(); window.removeEventListener("resize", reposition); };
  }, [externallyAnchored, layer]);
  const portalLayer = (node: ReactNode) =>
    externalAnchor && typeof document !== "undefined" ? createPortal(node, document.body) : node;

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
    if (isImeCompositionEvent(event) || event.key !== "Enter") return;
    // Send with Enter on: Enter sends, Shift+Enter inserts a newline.
    // Off: Enter inserts a newline and only Ctrl/⌘+Enter sends. IME rules are unchanged.
    const sends = sendWithEnter ? !event.shiftKey : event.ctrlKey || event.metaKey;
    if (!sends) return;
    event.preventDefault();
    if (sendDisabled) return;
    if (followupMode && runId) onFollowup?.(runId);
    else if (!activeRun) onSend?.();
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
  // off to another surface (file dialog, Skill Library,
  // MCP settings, Model parameters) close it.
  function toggleKnowledge(base: ComposerConfigKnowledgeBase) {
    if (!onSelectKnowledgeSelection && !onSelectKnowledgeBaseIds) return;
    if (!selectedKnowledgeSet.has(base.id) && explicitSelectionAtLimit) return;
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
    if (!selectedKnowledgeSourceSet.has(source.id) && explicitSelectionAtLimit) return;
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

  /* The menu's first line: fixed, adjustable, changed, or fallback in words. */
  function provenanceNotice(provenance: AssistantRowProvenanceV2 | null, assistantValue: string | null) {
    const text = assistantRowNoticeText(provenance, assistantValue);
    return provenance && text ? <AssistantRowNoticeV2 kind={provenance.kind} text={text} /> : null;
  }

  /* "Reset to Assistant" reads "unchanged" until the row is changed for this chat. */
  function resetToAssistantRow(
    provenance: AssistantRowProvenanceV2 | null,
    selectionRole: "button" | "item" = "item"
  ) {
    if (!provenance || !assistantRowResettable(provenance)) return null;
    return (
      <CapabilityRow
        icon="regenerate"
        selectionRole={selectionRole}
        trailing
        disabled={!provenance.changed || activeRun}
        reason={provenance.changed ? "Changed for this chat" : "unchanged"}
        onClick={() => {
          assistant?.resetRow(provenance.row);
          closeLayer();
        }}
      >
        Reset to Assistant
      </CapabilityRow>
    );
  }

  const knowledgeHasBases = (config?.knowledgeBases.length ?? 0) > 0;
  const knowledgeDocumentCount = typeof config?.knowledgeDocumentTotal === "number"
    ? config.knowledgeDocumentTotal
    : (config?.knowledgeSources?.length ?? 0);
  const knowledgeHasDocuments = knowledgeDocumentCount > 0 ||
    (config?.knowledgeDocumentTotal === undefined &&
      (config?.knowledgeBases ?? []).some((base) => base.documentCount > 0));
  // The Knowledge chip is available only when the current catalog contains a
  // selectable base or document. An inherited or Assistant-set plan keeps its
  // chip even when the ordinary picker is unavailable.
  const knowledgeAvailable = Boolean(onSelectKnowledgeSelection || onSelectKnowledgeBaseIds) && (
    knowledgeHasBases || knowledgeHasDocuments
  );
  const knowledgeChipVisible = Boolean(config) && (
    knowledgeInheritedFrom !== null || knowledgeSelection.mode !== "none" || knowledgeAvailable ||
    (knowledgeProvenance !== null && knowledgeProvenance.kind !== "own")
  );
  const knownSingleKnowledgeName = selectedKnowledgeResourceCount === 1
    ? selectedKnowledgeNames[0]
    : null;
  const knowledgeChipValue = knowledgeInheritedFrom === "assistant"
    ? selectedKnowledgeResourceCount > 0
      ? resourceCountLabel(selectedKnowledgeResourceCount)
      : "Selected Knowledge"
    : knowledgeInheritedFrom === "project"
      ? knownSingleKnowledgeName && knownSingleKnowledgeName !== "unavailable"
        ? `${knownSingleKnowledgeName} from Project`
        : selectedKnowledgeResourceCount > 0
          ? `${selectedKnowledgeResourceCount} from Project`
          : "Project default"
      : knowledgeSelection.mode === "all_my_knowledge"
        ? "All"
        : knownSingleKnowledgeName ?? String(selectedKnowledgeResourceCount);
  // Keep unavailable saved choices discoverable so the user can remove them.
  const activeSearchStrategies = concreteSearchOptions.filter((option) =>
    selectedSearchSet.has(option.strategyId) && compatibleSearchOptionIds.has(option.strategyId)
  );
  const activeSearchStrategy = activeSearchStrategies[0];
  const searchActive = Boolean(activeSearchStrategy);
  const activeSearchEngineName = activeSearchStrategy
    ? searchEngineShortName(
        activeSearchStrategy,
        currentModel?.providerFamily ?? currentProvider?.family
      )
    : null;
  const searchDescription = `Search: ${selectedSearchOptionIds.length ? selectedSearchOptionIds.map(id => {
    const option = concreteSearchOptions.find(candidate => candidate.strategyId === id);
    if (!option) return "Unavailable source";
    const name = searchEngineShortName(option, currentModel?.providerFamily ?? currentProvider?.family);
    return compatibleSearchOptionIds.has(id) ? name : `${name} (unavailable for this model)`;
  }).join(", ") : "Off"}${assistantRowDescription(searchProvenance)}`;
  const searchChipVisible = Boolean(config) && (
    selectedSearchOptionIds.length > 0 || concreteSearchOptions.length > 0 ||
    (searchProvenance !== null && searchProvenance.kind !== "own")
  );
  const enabledMcpServers = config?.mcpServers.filter((server) => server.enabled) ?? [];
  // Transitional states (activating, on-demand idle) are not problems; only
  // the Settings-level "attention"/"failed" presentations count here.
  const mcpAttentionServers = (config?.mcpServers ?? []).filter((server) => {
    const kind = mcpReadinessPresentation(server.attention ?? server.readiness).kind;
    return (server.enabled || server.attention) && (kind === "attention" || kind === "failed");
  });
  const mcpServersNeedingAttention = mcpAttentionServers.length;
  const mcpAttentionLabel = mcpServersNeedingAttention
    ? `${mcpServersNeedingAttention} MCP ${mcpServersNeedingAttention === 1 ? "server needs" : "servers need"} attention. Open MCP settings.`
    : undefined;
  // An Assistant's exact server list: names the viewer can see, the rest counted.
  const mcpServerById = new Map((config?.mcpServers ?? []).map((server) => [server.id, server] as const));
  const mcpExactServers = effectiveMcpSelection.mode === "exact"
    ? effectiveMcpSelection.serverIds.flatMap((id) => {
        const server = mcpServerById.get(id);
        return server ? [server] : [];
      })
    : [];
  const mcpExactHiddenCount = effectiveMcpSelection.mode === "exact"
    ? (effectiveMcpSelection.hiddenCount ?? 0) + effectiveMcpSelection.serverIds.length - mcpExactServers.length
    : 0;
  const mcpExactCount = mcpExactServers.length + mcpExactHiddenCount;
  const mcpAssistantList = boundAssistant && effectiveMcpSelection.mode === "exact" ? boundAssistant : null;
  // Names after the third, and servers the user cannot see, are only counted.
  const mcpExactMore = Math.max(0, mcpExactServers.length - 3) + mcpExactHiddenCount;
  const mcpAssistantListReason = mcpExactServers.length > 0
    ? `All tools of: ${mcpExactServers.slice(0, 3).map((server) => server.name).join(", ")}${
      mcpExactMore > 0 ? ` and ${mcpExactMore} more` : ""}`
    : `All tools of: ${mcpExactCount} ${mcpExactCount === 1 ? "server" : "servers"}`;
  const mcpModeLabel = effectiveMcpSelection.mode === "exact"
    ? `${mcpExactCount} ${mcpExactCount === 1 ? "server" : "servers"}`
    : effectiveMcpSelection.mode === "load_all" ? "Load all" : effectiveMcpSelection.mode === "off" ? "Off" : "Auto";
  const mcpDescription = `MCP: ${mcpModeLabel}${assistantRowDescription(toolsProvenance)}${mcpAttentionLabel ? `. ${mcpAttentionLabel}` : ""}`;
  const skillsDescription = `Skills: ${effectiveSkillsMode === "off" ? "Auto off" : "Auto"}${effectiveSkillIds.length ? ` · ${effectiveSkillIds.length} pinned (always loaded)` : ""}${assistantRowDescription(skillsProvenance)}`;
  const knowledgeFallback = knowledgeProvenance?.kind === "fallback";
  // A fallback already names the Project default: the origin is said once.
  const knowledgeDescription = `Knowledge: ${knowledgeSelection.mode === "none" && !knowledgeProjectLocked ? "Off"
    : selectedKnowledgeNames.length ? `${selectedKnowledgeNames.join(", ")}${
      knowledgeProjectLocked && !knowledgeFallback ? " · from Project" : ""}`
      : knowledgeChipValue}${assistantRowDescription(knowledgeProvenance)}`;
  // The Assistant's own value of a changed row in the chip's words ("… starts
  // with Off"); null when the user cannot see all of it.
  const assistantRows = boundAssistant?.rows;
  const assistantSearch = assistantRows?.search.assistantValue;
  const assistantSearchIds = assistantSearch && "optionIds" in assistantSearch && !assistantSearch.hiddenCount
    ? assistantSearch.optionIds
    : [];
  const assistantSearchOptions = assistantSearchIds.flatMap((id) =>
    concreteSearchOptions.filter((option) => option.strategyId === id));
  const assistantSearchLabel = assistantSearch?.mode === "off"
    ? "Off"
    : assistantSearchIds.length > 0 && assistantSearchOptions.length === assistantSearchIds.length
      ? assistantSearchOptions.map((option) =>
          searchEngineShortName(option, currentModel?.providerFamily ?? currentProvider?.family)).join(", ")
      : null;
  const assistantTools = assistantRows?.tools.assistantValue;
  const assistantToolsCount = assistantTools?.mode === "exact"
    ? assistantTools.serverIds.length + (assistantTools.hiddenCount ?? 0)
    : 0;
  const assistantToolsLabel = assistantTools?.mode === "off"
    ? "Off"
    : assistantTools?.mode === "exact" ? `${assistantToolsCount} ${assistantToolsCount === 1 ? "server" : "servers"}` : null;
  const assistantKnowledgeName = assistantKnowledge?.mode === "explicit" && assistantKnowledgeCount === 1
    ? knowledgeById.get(assistantKnowledge.baseIds[0] ?? "")?.name ?? sourceById.get(assistantKnowledge.sourceIds[0] ?? "")?.name
    : undefined;
  const assistantKnowledgeLabel = assistantKnowledge?.mode === "none"
    ? "Off"
    : assistantKnowledge?.mode === "explicit" ? assistantKnowledgeName ?? resourceCountLabel(assistantKnowledgeCount) : null;
  const assistantSkillsLabel = assistantRows ? assistantRows.skills.assistantValue.mode === "off" ? "Auto off" : "Auto" : null;
  const addKnowledgeReason = knowledgeFixed ? assistantRowNoticeText(knowledgeProvenance) : null;
  const overrideKnowledgeAction = onOverrideKnowledgePlan ? (
    <button
      className="v2-composer-layer-link v2-focusable"
      data-v2-composer-option="true"
      type="button"
      role="menuitem"
      onClick={onOverrideKnowledgePlan}
    >
      Override for this chat
    </button>
  ) : null;
  const agentDisabledReason = activeRun ? "A response is running." : !agent?.enabled ? agentReason : null;
  const agentExplanation = activeRun ? "A response is running." : agentReason;
  const agentDescription = `Agent: ${agent?.enabled ? "On" : "Off"}. ${agentExplanation ? `${agentExplanation} ` : ""}${AGENT_HELP}`;
  const agentStatus = agentNotice && agentNotice.sessionKey === sessionKey && agent
    ? agentNotice.kind === "blocked" ? agentDisabledReason : agent.enabled ? "Agent on · Codex in Workspace. Memory and Knowledge are unavailable." : "Agent off."
    : null;
  const workspaceDescription = workspace ? `Workspace: ${workspace.busy ? "Saving" : workspace.enabled ? "On" : "Off"}. ${workspaceStatusCopy(workspace.sessionState, Boolean(workspace.commandRunning))}` : "";

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
          accept={attachmentAccept || undefined}
          aria-label="Attach files"
          disabled={attachmentSelectionDisabled}
          multiple
          onChange={(event) => {
            if (event.currentTarget.files?.length) submitFiles(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />

        {artifactCreate ? <div className="v2-composer-artifact-edit">
          <UiV2Icon name="artifact" /><span>Artifact</span>
          <UiV2IconButton icon="close" label="Remove artifact creation" disabled={sending} onClick={onRemoveArtifactCreate} />
        </div> : artifactEdit ? (
          <div className="v2-composer-artifact-edit">
            <UiV2Icon name="artifact" />
            <span title={`Editing “${artifactEdit.title}” · v${artifactEdit.versionNumber}`}>
              Editing “{artifactEdit.title}” · v{artifactEdit.versionNumber}
            </span>
            <UiV2IconButton icon="close" label="Remove artifact edit" disabled={sending}
              onClick={onRemoveArtifactEdit} />
          </div>
        ) : null}
        {artifactBlockReason && !followupMode ? <p className="v2-composer-status" role="alert">{artifactBlockReason}. Remove the artifact selection or change the chat mode before sending.</p> : null}
        <AttachmentTrayV2
          items={attachmentItems}
          onRemove={onRemoveAttachment}
          onRetry={onRetryAttachment}
          usage={attachmentLimitUsage}
          sharedProject={sharedProject}
        />
        {followupMode && (attachmentItems.length > 0 || artifactCreate || artifactEdit) ? (
          <p className="v2-composer-status">Only your text is sent as a follow-up. Files and artifact choices are kept for your next message.</p>
        ) : null}
        {followupMode && followupTooLong ? <p className="v2-composer-status" role="alert">{sendDisabledReason}</p> : null}

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
        {agentStatus ? <p className="v2-composer-status" role="status">{agentStatus}</p> : null}
        <div className="v2-composer-entry">
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
            placeholder={followupMode ? "Follow up…" : artifactCreate ? "Describe the page, slides, game or chart…" : artifactEdit ? "Describe the change…" : "Ask anything…"}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={submitFromKeyboard}
            onPaste={pasteFiles}
          />

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

            {/* The model is chosen in the header (operator, 2026-09-02); the
                composer row holds only this message's tools. */}
            <div className="v2-composer-indicators" aria-label="Active capabilities">
              {agent ? (
                <button type="button" className="v2-composer-indicator v2-focusable"
                  data-glyph="bot" data-quiet={agent.enabled ? undefined : ""}
                  data-tooltip={agentDescription} data-tooltip-side="top"
                  aria-label="Agent" aria-pressed={agent.enabled}
                  aria-describedby={`${layerId}-agent-reason`} aria-disabled={Boolean(agentDisabledReason)}
                  onClick={() => {
                    if (agentDisabledReason) { setAgentNotice({ sessionKey, kind: "blocked" }); return; }
                    agent.onToggle(!agent.enabled);
                    setAgentNotice({ sessionKey, kind: "mode" });
                  }}>
                  <CapabilityChipContent label="Agent" icon="bot" description={agentDescription} descriptionId={`${layerId}-agent-reason`} />
                </button>
              ) : null}
              {workspace ? (
                <button type="button" className="v2-composer-indicator v2-composer-workspace-toggle v2-focusable"
                  aria-label={`Workspace details. ${workspace.enabled ? "On" : "Off"}. ${workspaceStatusCopy(workspace.sessionState, Boolean(workspace.commandRunning))}`}
                  aria-controls={`${layerId}-workspace`} aria-expanded={layer === "workspace"} aria-haspopup="menu"
                  aria-describedby={`${layerId}-workspace-description`}
                  data-glyph="monitor" data-quiet={workspace.enabled ? undefined : ""}
                  data-workspace-state={workspace.commandRunning ? "running" : workspace.sessionState ?? "off"}
                  data-tooltip={workspaceDescription} data-tooltip-side="top"
                  onClick={event => openLayer("workspace", event.currentTarget)}>
                  <CapabilityChipContent label="Workspace" icon="monitor" signal={workspace.commandRunning ? "running" : undefined}
                    description={workspaceDescription} descriptionId={`${layerId}-workspace-description`} />
                </button>
              ) : null}
              {searchChipVisible ? (
                <button ref={searchTriggerRef} className="v2-composer-indicator v2-focusable" type="button"
                  data-quiet={searchActive ? undefined : ""} data-glyph="globe"
                  data-provenance={searchProvenance?.marker ? "assistant" : undefined}
                  data-tooltip={searchDescription} data-tooltip-side="top"
                  disabled={activeRun || !onSelectSearchOptionIds}
                  aria-controls={`${layerId}-search`} aria-expanded={layer === "search"} aria-haspopup="dialog"
                  aria-label={activeSearchEngineName ? `Choose web search: ${activeSearchEngineName}` : "Choose web search"}
                  aria-describedby={`${layerId}-search-description`}
                  onClick={event => openLayer("search", event.currentTarget)}>
                  <CapabilityChipContent label="Search" icon="globe" count={selectedSearchOptionIds.length > 1 ? selectedSearchOptionIds.length : 0}
                    description={searchDescription} descriptionId={`${layerId}-search-description`} />
                </button>
              ) : null}
              {knowledgeChipVisible ? (
                <button ref={knowledgeTriggerRef} className="v2-composer-indicator v2-focusable" type="button"
                  data-quiet={knowledgeSelection.mode === "none" && !knowledgeProjectLocked ? "" : undefined} data-glyph="book"
                  data-provenance={knowledgeProvenance?.marker ? "assistant" : undefined}
                  disabled={activeRun || (!knowledgeControlsLocked && !onSelectKnowledgeSelection && !onSelectKnowledgeBaseIds)}
                  aria-controls={`${layerId}-knowledge`} aria-expanded={layer === "knowledge"} aria-haspopup="menu"
                  aria-label="Choose Knowledge" aria-describedby={`${layerId}-knowledge-description`}
                  data-tooltip={knowledgeDescription} data-tooltip-side="top"
                  onClick={event => openLayer("knowledge", event.currentTarget)}>
                  <CapabilityChipContent label="Knowledge" icon="book" count={selectedKnowledgeResourceCount > 1 ? selectedKnowledgeResourceCount : 0}
                    description={knowledgeDescription} descriptionId={`${layerId}-knowledge-description`} />
                </button>
              ) : null}
              <button className="v2-composer-indicator v2-focusable" type="button"
                data-quiet={effectiveMcpSelection.mode === "load_all" || effectiveMcpSelection.mode === "exact" ? undefined : ""} data-glyph="tool"
                data-off={effectiveMcpSelection.mode === "off" || undefined} data-mcp-mode={effectiveMcpSelection.mode}
                data-provenance={toolsProvenance?.marker ? "assistant" : undefined}
                disabled={activeRun} aria-controls={`${layerId}-tools`} aria-expanded={layer === "tools"} aria-haspopup="menu"
                aria-label="Change MCP mode" aria-describedby={`${layerId}-mcp-description`}
                data-tooltip={mcpDescription} data-tooltip-side="top"
                onClick={event => openLayer("tools", event.currentTarget)}>
                <CapabilityChipContent label="MCP" icon="tool" signal={mcpAttentionLabel ? "attention" : undefined}
                  description={mcpDescription} descriptionId={`${layerId}-mcp-description`} />
              </button>
              <button className="v2-composer-indicator v2-focusable" type="button"
                data-quiet={effectiveSkillIds.length && effectiveSkillsMode !== "off" ? undefined : ""} data-glyph="wand"
                data-off={effectiveSkillsMode === "off" || undefined} data-skills-mode={effectiveSkillsMode}
                data-provenance={skillsProvenance?.marker ? "assistant" : undefined}
                aria-label="Change Skills mode" aria-controls={`${layerId}-skills`} aria-expanded={layer === "skills"}
                aria-haspopup="menu" aria-describedby={`${layerId}-skills-description`} disabled={activeRun}
                data-tooltip={skillsDescription} data-tooltip-side="top" onClick={event => openLayer("skills", event.currentTarget)}>
                <CapabilityChipContent label="Skills" icon="wand" count={effectiveSkillIds.length}
                  description={skillsDescription} descriptionId={`${layerId}-skills-description`} />
              </button>
            </div>

            <span className="v2-composer-spacer" />
            <span className="v2-composer-run-action" data-followup={followupMode || undefined}>
              <RunComposerActionV2
                active={activeRun}
                followup={followupMode}
                onSend={followupMode && runId ? () => onFollowup?.(runId) : onSend}
                onStop={onStop}
                runId={runId}
                sendDisabled={sendDisabled}
                sendDisabledReason={sendDisabledReason}
                stopping={stopping}
              />
            </span>
          </div>

        </div>

        {layer ? portalLayer(
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
              data-anchor={externalAnchor ? "external" : undefined}
              data-kind={layer}
              data-placement={!externalAnchor && layerPlacement.below ? "below" : undefined}
              id={`${layerId}-${layer}`}
              role={layer === "model" || layer === "files" || layer === "search" ? "dialog" : "menu"}
              tabIndex={-1}
              aria-label={LAYER_LABELS[layer]}
              style={{
                "--v2-composer-layer-left": `${externalAnchor?.left ?? layerLeft}px`,
                "--v2-composer-layer-space-above": `${layerPlacement.spaceAbove}px`,
                "--v2-composer-layer-space-below": `${layerPlacement.spaceBelow}px`,
                "--v2-composer-layer-top": `${externalAnchor?.top ?? 0}px`
              } as CSSProperties}
              onKeyDown={handleLayerKeyDown}
            >
              {/* The header is the mobile sheet's title and close control; the
                  desktop popover hides it and closes from Esc, outside click,
                  or a selection (PRD §4.6). */}
              <header className="v2-composer-layer-header">
                <strong>{LAYER_TITLES[layer]}</strong>
                <UiV2IconButton icon="close" label="Close" onClick={closeLayer} />
              </header>

              {layer === "workspace" && workspace ? (
                <div className="v2-composer-layer-scroll">
                  <p className="v2-composer-layer-title">Workspace</p>
                  <CapabilityRow selected={workspace.enabled} disabled={workspaceToggleDisabled}
                    reason={workspaceToggleReason ?? (activeRun ? "A response is running." : "Applies to future messages. Existing files are preserved.")}
                    onClick={() => workspace.onToggle(!workspace.enabled)}>
                    {workspace.enabled ? "Turn off Workspace" : "Turn on Workspace"}
                  </CapabilityRow>
                  <p className="v2-composer-layer-note" role="status">{workspaceStatusCopy(workspace.sessionState, Boolean(workspace.commandRunning))}</p>
                  <p className="v2-composer-layer-note">Internet: {workspace.internetEnabled === null ? "Not configured" : workspace.internetEnabled ? "On" : "Off"}. Managed by the administrator.</p>
                </div>
              ) : layer === "model" ? (
                <ModelLayer
                  config={config}
                  groups={groupedModels}
                  parametersSummary={modelParametersSummary}
                  provenance={modelProvenance}
                  query={modelQuery}
                  recommendedModelId={boundAssistant?.rows.model.assistantValue.mode === "model"
                    ? boundAssistant.rows.model.assistantValue.modelId
                    : null}
                  selectedModelId={selectedModelId}
                  selectedProvider={selectedProvider}
                  onMakeDefault={onMakeModelDefault}
                  onOpenParameters={onOpenModelParameters
                    ? () => {
                        onOpenModelParameters();
                        closeLayer();
                      }
                    : undefined}
                  onQuery={setModelQuery}
                  onReset={modelProvenance
                    ? () => {
                        assistant?.resetRow("model");
                        closeLayer();
                      }
                    : undefined}
                  onSelect={(model) => {
                    onSelectModel?.(model);
                    closeLayer();
                  }}
                />
              ) : layer === "search" ? (
                <div className="v2-composer-layer-scroll">
                  <p className="v2-composer-layer-title">Web search</p>
                  {provenanceNotice(searchProvenance, assistantSearchLabel)}
                  <SearchPlanPickerV2
                    options={concreteSearchOptions.map(option => ({ ...option,
                      executionModes: currentModel?.searchOptionCompatibility?.[option.strategyId]?.executionModes ?? option.executionModes }))}
                    plan={{ mode: searchPlanMode, optionIds: selectedSearchOptionIds }}
                    availableIds={compatibleSearchOptionIds}
                    disabled={searchFixed || activeRun || !onSelectSearchOptionIds}
                    onChange={plan => {
                      if (plan.mode !== searchPlanMode) onSelectSearchPlanMode?.(plan.mode);
                      else onSelectSearchOptionIds?.(plan.optionIds);
                    }}
                    onReset={onResetSearchPlan}
                    scope="chat"
                  />
                  {resetToAssistantRow(searchProvenance, "button")}
                </div>
              ) : layer === "files" ? (
                <SavedFilePickerV2
                  disabled={inputDisabled || activeRun || uploading}
                  onUse={async (id, fileName) => await onReuseFile?.(id, fileName) ?? false}
                  onUsed={closeLayer}
                />
              ) : layer === "skills" ? (
                <div className="v2-composer-layer-scroll">
                  <p className="v2-composer-layer-title">Skills</p>
                  {boundAssistant ? <>
                    {/* With an Assistant: its Skills stay read-only and the
                        user pins on top of them (FRONTEND.md). */}
                    {provenanceNotice(skillsProvenance, assistantSkillsLabel)}
                    <CapabilityRow selected={skillsMode === "auto"} selectionRole="radio" current={skillsFixed && skillsMode === "auto"}
                      disabled={skillsFixed || activeRun || !currentModel?.capabilities.toolCalling || !onSelectSkillsMode}
                      reason={!currentModel?.capabilities.toolCalling ? "This model cannot load Skills on demand. Always use instructions still apply." : null}
                      onClick={() => { onSelectSkillsMode?.("auto"); closeLayer(); }}>Auto · loads on demand</CapabilityRow>
                    <CapabilityRow selected={skillsMode === "off"} selectionRole="radio" current={skillsFixed && skillsMode === "off"}
                      disabled={skillsFixed || activeRun || !onSelectSkillsMode}
                      onClick={() => { onSelectSkillsMode?.("off"); closeLayer(); }}>Off · Always Skills only</CapabilityRow>
                    {includedSkills.length > 0 || (boundAssistant.rows.skills.assistantValue.hiddenCount ?? 0) > 0 ? (
                      <div className="v2-composer-included" role="group" aria-label="Included by the Assistant">
                        <p className="v2-composer-layer-label" aria-hidden="true">Included by the Assistant</p>
                        {includedSkills.map((skill) => (
                          <p className="v2-composer-included-row" key={skill.id}>
                            <span>{skill.name}</span>
                            <span>{skill.mode === "available" ? "On demand" : "Always"}</span>
                          </p>
                        ))}
                        {(boundAssistant.rows.skills.assistantValue.hiddenCount ?? 0) > 0 ? (
                          <p className="v2-composer-included-row">
                            <span>{boundAssistant.rows.skills.assistantValue.hiddenCount} more not visible to you</span>
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="v2-composer-layer-divider" role="separator" />
                    <CapabilityRow icon="plus" selectionRole="item" trailing disabled={activeRun || !onOpenSkillLibrary}
                      onClick={() => { closeLayer(); onOpenSkillLibrary?.(); }}>Pin your Skills…</CapabilityRow>
                    {resetToAssistantRow(skillsProvenance)}
                  </> : <>
                    <CapabilityRow selected={skillsMode === "auto"} selectionRole="radio" disabled={activeRun || !currentModel?.capabilities.toolCalling || !onSelectSkillsMode}
                      reason={!currentModel?.capabilities.toolCalling ? "This model cannot load Skills on demand. Always use instructions still apply." : "The model loads enabled Skills when useful"}
                      onClick={() => { onSelectSkillsMode?.("auto"); closeLayer(); }}>Auto</CapabilityRow>
                    <CapabilityRow selected={skillsMode === "off"} selectionRole="radio" disabled={activeRun || !onSelectSkillsMode}
                      reason="Always use instructions still apply" onClick={() => { onSelectSkillsMode?.("off"); closeLayer(); }}>Off</CapabilityRow>
                    <CapabilityRow icon="wand" selectionRole="item" trailing disabled={activeRun || !onOpenSkillLibrary} reason="Choose Auto loading or Always use"
                      onClick={() => { closeLayer(); onOpenSkillLibrary?.(); }}>Skills…</CapabilityRow>
                  </>}
                </div>
              ) : layer === "tools" ? (
                <div className="v2-composer-layer-scroll">
                  <p className="v2-composer-layer-title">MCP tools</p>
                  {provenanceNotice(toolsProvenance, assistantToolsLabel)}
                  {/* The Assistant's exact list, while in force, is the chosen
                      option: every tool of those servers. The modes below act
                      on the user's own servers; choosing one changes the row
                      for this chat. */}
                  {mcpAssistantList ? (
                    <CapabilityRow
                      current={toolsFixed}
                      disabled={activeRun}
                      reason={mcpAssistantListReason}
                      selected
                      selectionRole="radio"
                      onClick={closeLayer}
                    >
                      {`${mcpAssistantList.name}'s servers`}
                    </CapabilityRow>
                  ) : null}
                  <CapabilityRow
                    selected={effectiveMcpSelection.mode === "auto"}
                    current={toolsFixed && effectiveMcpSelection.mode === "auto"}
                    disabled={toolsFixed || activeRun || !currentModel?.capabilities.toolCalling || !onSelectMcp}
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
                    selected={effectiveMcpSelection.mode === "load_all"}
                    current={toolsFixed && effectiveMcpSelection.mode === "load_all"}
                    disabled={toolsFixed || activeRun || !currentModel?.capabilities.toolCalling || !onSelectMcp}
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
                    selected={effectiveMcpSelection.mode === "off"}
                    current={toolsFixed && effectiveMcpSelection.mode === "off"}
                    disabled={toolsFixed || activeRun || !onSelectMcp}
                    reason="No MCP tools this turn"
                    selectionRole="radio"
                    onClick={() => {
                      selectMcpMode("off");
                      closeLayer();
                    }}
                  >
                    Off
                  </CapabilityRow>
                  {resetToAssistantRow(toolsProvenance)}
                  {/* What the user's modes act on: enabling stays a Settings
                      action (FRONTEND.md), so this is disclosure, not
                      selection. The Assistant's list keeps only a problem and
                      its Configure path. */}
                  {!mcpAssistantList || mcpAttentionServers.length > 0 ? <div className="v2-composer-layer-footer">
                    {mcpAttentionServers.length > 0 ? (
                      <div className="v2-composer-mcp-problems" role="status">
                        <p>MCP servers need attention</p>
                        {mcpAttentionServers.map((server) => (
                          <p key={server.id}>{server.name} · {mcpReadinessPresentation(server.attention ?? server.readiness, server.runtimeErrorCode).label}</p>
                        ))}
                      </div>
                    ) : null}
                    <div className="v2-composer-layer-footer-row">
                      {!mcpAssistantList ? <p className="v2-composer-layer-note" data-testid="composer-v2-mcp-enabled">
                        {enabledMcpServers.length === 0
                          ? "No servers enabled."
                          : `Enabled servers · ${enabledMcpServers.length}${
                            mcpServersNeedingAttention > 0
                              ? ` · ${mcpServersNeedingAttention} need${mcpServersNeedingAttention === 1 ? "s" : ""} attention`
                              : ""
                          }`}
                      </p> : null}
                      {onOpenMcpSettings ? (
                        <button
                          className="v2-composer-layer-link v2-composer-mcp-settings v2-focusable"
                          data-v2-composer-option="true"
                          data-v2-composer-trailing="true"
                          type="button"
                          role="menuitem"
                          aria-label="Manage enabled MCP servers"
                          onClick={() => {
                            onOpenMcpSettings();
                            closeLayer();
                          }}
                        >
                          {mcpServersNeedingAttention ? "Configure" : "Manage"}
                          <UiV2Icon name="chevron-right" />
                        </button>
                      ) : null}
                    </div>
                    {!mcpAssistantList && enabledMcpServers.length > 0 ? (
                      <div className="v2-composer-tags" data-testid="composer-v2-mcp-servers">
                        {enabledMcpServers.map((server) => (
                          <span className="v2-composer-tag" key={server.id}>{server.name}</span>
                        ))}
                      </div>
                    ) : null}
                  </div> : null}
                </div>
              ) : layer === "knowledge" ? (
                <div className="v2-composer-layer-scroll">
                  {/* One notice for one fact: a fallback line carries the
                      Project's override; the lock box stands alone otherwise. */}
                  {knowledgeFallback ? (
                    <AssistantRowNoticeV2
                      kind="fallback"
                      text={assistantRowNoticeText(knowledgeProvenance) ?? ""}
                      action={knowledgeProjectLocked ? overrideKnowledgeAction : null}
                    />
                  ) : provenanceNotice(knowledgeProvenance, assistantKnowledgeLabel)}
                  {knowledgeProjectLocked && !knowledgeFallback ? (
                    <div className="v2-composer-knowledge-inherited" role="status">
                      <UiV2Icon name="lock" />
                      <span>
                        <strong>This Project controls the default Knowledge.</strong>{" "}
                        Its selection is used until you override it for this chat.
                      </span>
                      {overrideKnowledgeAction}
                    </div>
                  ) : null}
                  {onSearchKnowledgeSources ||
                    (config?.knowledgeBases.length ?? 0) + (config?.knowledgeSources?.length ?? 0) > 6 ? (
                    <label className="v2-composer-model-search-wrap">
                      <UiV2Icon name="search" />
                      <input
                        data-v2-knowledge-search
                        aria-label="Search Knowledge resources"
                        maxLength={KNOWLEDGE_SOURCE_SEARCH_MAX_LENGTH}
                        placeholder="Search bases and documents…"
                        type="search"
                        value={knowledgeQuery}
                        onChange={(event) => setKnowledgeQuery(event.currentTarget.value)}
                      />
                    </label>
                  ) : null}
                  <CapabilityRow
                    selected={knowledgeSelection.mode === "none"}
                    current={knowledgeControlsLocked && knowledgeSelection.mode === "none"}
                    disabled={knowledgeControlsLocked || activeRun}
                    reason="Answer without reading documents"
                    selectionRole="radio"
                    onClick={() => {
                      selectKnowledge(EMPTY_KNOWLEDGE_SELECTION);
                      closeLayer();
                    }}
                  >
                    Off
                  </CapabilityRow>
                  {!sharedProject && onSelectKnowledgeSelection && knowledgeHasDocuments ? (
                    <CapabilityRow
                      selected={knowledgeSelection.mode === "all_my_knowledge"}
                      current={knowledgeControlsLocked && knowledgeSelection.mode === "all_my_knowledge"}
                      disabled={knowledgeControlsLocked || activeRun}
                      reason={`Every ready document you own${
                        typeof config?.knowledgeDocumentTotal === "number"
                          ? ` · ${config.knowledgeDocumentTotal} ${config.knowledgeDocumentTotal === 1 ? "file" : "files"}`
                          : ""
                      }`}
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
                    knowledgeSelection.mode === "none" && !knowledgeControlsLocked ? (
                    <CapabilityRow icon="library" disabled reason="No knowledge bases available">
                      Knowledge
                    </CapabilityRow>
                  ) : null}
                  {knowledgeSelection.mode === "inherited" ? (
                    <>
                      {/* The first line already names the Assistant. */}
                      {knowledgeSelection.inheritedFrom === "assistant" && assistantRowNoticeText(knowledgeProvenance)
                        ? null
                        : (
                          <p className="v2-composer-layer-label">
                            From {knowledgeSelection.inheritedFrom === "assistant"
                              ? boundAssistant?.name ?? "Assistant"
                              : "Project"}
                          </p>
                        )}
                      <CapabilityRow
                        icon="book"
                        current
                        reason={knowledgeSelection.inheritedFrom === "assistant" && assistantKnowledgeCount > 0
                          ? resourceCountLabel(assistantKnowledgeCount)
                          : "Selection details stay private"}
                      >
                        Selected Knowledge
                      </CapabilityRow>
                    </>
                  ) : null}
                  {/* Reset follows the modes, above lists that can run long. */}
                  {resetToAssistantRow(knowledgeProvenance)}
                  {visibleKnowledgeBases.length > 0 ? (
                    <p className="v2-composer-layer-label">Bases</p>
                  ) : null}
                  {visibleKnowledgeBases.map((base) => {
                    const selected = selectedKnowledgeSet.has(base.id);
                    const atLimit = !selected && explicitSelectionAtLimit;
                    const reason = atLimit
                      ? `Selection limit · ${KNOWLEDGE_SELECTION_MAX_EXPLICIT_RESOURCES} resources`
                      : knowledgeBaseReason(base);
                    return (
                      <CapabilityRow
                        key={base.id}
                        icon="library"
                        selected={selected}
                        current={selected && knowledgeControlsLocked}
                        disabled={knowledgeControlsLocked || activeRun ||
                          (base.archived && !selected) || atLimit}
                        reason={reason}
                        onClick={() => toggleKnowledge(base)}
                      >
                        {base.name}
                      </CapabilityRow>
                    );
                  })}
                  {visibleKnowledgeSources.length > 0 ? (
                    <p className="v2-composer-layer-label">Single documents</p>
                  ) : null}
                  {visibleKnowledgeSources.map((source) => {
                    const selected = selectedKnowledgeSourceSet.has(source.id);
                    const unavailable = source.readiness !== "ready";
                    const atLimit = !selected && explicitSelectionAtLimit;
                    const reason = knowledgeProjectLocked
                      ? "Managed by the Project"
                      : atLimit
                        ? `Selection limit · ${KNOWLEDGE_SELECTION_MAX_EXPLICIT_RESOURCES} resources`
                      : unavailable
                        ? source.readiness === "processing"
                          ? "Processing · skipped until ready"
                          : "Unavailable · not searchable"
                        : `Ready${source.description ? ` · ${source.description}` : ""}`;
                    return (
                      <CapabilityRow
                        key={`source:${source.id}`}
                        icon="book"
                        selected={selected}
                        current={selected && knowledgeControlsLocked}
                        disabled={knowledgeControlsLocked || activeRun || !onSelectKnowledgeSelection ||
                          (unavailable && !selected) || atLimit}
                        reason={reason}
                        onClick={() => toggleKnowledgeSource(source)}
                      >
                        {source.name}
                      </CapabilityRow>
                    );
                  })}
                  {!normalizedKnowledgeQuery && hiddenKnowledgeDocumentCount &&
                  hiddenKnowledgeDocumentCount > 0 ? (
                    <p className="v2-composer-layer-note">
                      Type to find any of your other {hiddenKnowledgeDocumentCount} documents.
                    </p>
                  ) : null}
                  {knowledgeSelection.baseIds
                    .filter((id) => !knowledgeById.has(id))
                    .map((id) => (
                      <CapabilityRow
                        key={id}
                        icon="library"
                        selected
                        disabled={knowledgeControlsLocked || activeRun}
                        reason={knowledgeProjectLocked
                          ? "Managed by the Project"
                          : "Access revoked"}
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
                        disabled={knowledgeControlsLocked || activeRun}
                        reason={knowledgeProjectLocked
                          ? "Managed by the Project"
                          : "Access revoked"}
                        onClick={() => {
                          selectKnowledge(explicitKnowledgeSelection({
                            baseIds: knowledgeSelection.baseIds,
                            sourceIds: knowledgeSelection.sourceIds.filter((candidate) => candidate !== id)
                          }));
                        }}
                      >
                        Unavailable Knowledge document
                      </CapabilityRow>
                    ))}
                  <div className="v2-composer-layer-footer">
                    <div className="v2-composer-layer-footer-row">
                      <p className="v2-composer-layer-note">
                        Applies to your next message.
                      </p>
                      {onOpenKnowledgeLibrary ? (
                        <button
                          className="v2-composer-layer-link v2-focusable"
                          data-v2-composer-option="true"
                          data-v2-composer-trailing="true"
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            onOpenKnowledgeLibrary();
                            closeLayer();
                          }}
                        >
                          Manage Knowledge
                          <UiV2Icon name="chevron-right" />
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : (
                /* Search, MCP and parameters live behind their own chips. */
                <div className="v2-composer-layer-scroll">
                  <CapabilityRow icon="artifact" selectionRole="item"
                    disabled={Boolean(artifactReason || !onCreateArtifact || inputDisabled || activeRun)}
                    reason={artifactReason ?? "Page, slides, game or chart"}
                    onClick={() => { onCreateArtifact?.(); closeLayer(); textareaRef.current?.focus({ preventScroll: true }); }}>
                    Create artifact
                  </CapabilityRow>
                  <CapabilityRow
                    icon="attach"
                    disabled={attachmentSelectionDisabled}
                    reason={attachmentSelectionDisabled ? "Unavailable" : uploadLimitHint ?? "XLSX · DOCX · PDF · images"}
                    selectionRole="item"
                    onClick={() => {
                      fileInputRef.current?.click();
                      closeLayer();
                    }}
                  >
                    Attach files
                  </CapabilityRow>
                  {!sharedProject && onReuseFile ? (
                    <CapabilityRow
                      icon="library"
                      disabled={inputDisabled || activeRun || uploading}
                      reason="Reuse a file or template"
                      selectionRole="item"
                      onClick={(event) => openLayer("files", plusTriggerRef.current ?? event.currentTarget)}
                    >Saved files…</CapabilityRow>
                  ) : null}
                  <CapabilityRow
                    icon="book"
                    disabled={knowledgeFixed || activeRun || !knowledgeAvailable}
                    reason={addKnowledgeReason ?? "Base or document for this chat"}
                    selectionRole="item"
                    onClick={(event) => {
                      openLayer("knowledge", knowledgeTriggerRef.current ?? event.currentTarget);
                    }}
                  >
                    Add Knowledge…
                  </CapabilityRow>
                  <CapabilityRow
                    icon="wand"
                    disabled={activeRun || !onOpenSkillLibrary}
                    reason={effectiveSkillIds.length === 0
                      ? "Reusable text instructions"
                      : `${effectiveSkillIds.length} selected${selectedSkills.length > 0
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

/*
 * The model row of the chat's Assistant as the picker's first line: a fixed
 * model, the recommended model, a change for this chat with Reset, or the
 * fallback.
 */
function ModelProvenanceLine({
  currentModelName,
  models,
  onReset,
  provenance,
  recommendedModelId
}: Readonly<{
  currentModelName: string | null;
  models: readonly CatalogModel[];
  onReset?(): void;
  provenance: AssistantRowProvenanceV2 | null;
  recommendedModelId: string | null;
}>) {
  if (!provenance) return null;
  const recommended = models.find((model) => model.modelId === recommendedModelId);
  if (provenance.changed) {
    return (
      <AssistantRowNoticeV2
        kind={provenance.kind}
        text={assistantRowNoticeText(provenance, recommended?.displayName ?? null) ?? ""}
        action={onReset ? (
          <button className="v2-composer-provenance-action v2-focusable" type="button" onClick={onReset}>
            Reset to Assistant
          </button>
        ) : null}
      />
    );
  }
  if (provenance.kind === "own") return null;
  if (provenance.kind === "fixed") {
    return (
      <AssistantRowNoticeV2
        kind="fixed"
        text={`Fixed by ${provenance.assistantName}${currentModelName ? ` — ${currentModelName}` : ""}`}
      />
    );
  }
  if (provenance.kind !== "adjustable") {
    const text = assistantRowNoticeText(provenance);
    return text ? <AssistantRowNoticeV2 kind={provenance.kind} text={text} /> : null;
  }
  if (!recommended) return null;
  return (
    <AssistantRowNoticeV2
      kind="adjustable"
      text={`Recommended by ${provenance.assistantName} — ${recommended.displayName}`}
      action={<span className="v2-composer-provenance-state">In use</span>}
    />
  );
}

function ModelLayer({
  config,
  groups,
  onMakeDefault,
  onOpenParameters,
  onQuery,
  onReset,
  onSelect,
  parametersSummary,
  provenance,
  query,
  recommendedModelId,
  selectedModelId,
  selectedProvider
}: Readonly<{
  config: ComposerConfig | null;
  groups: Array<{ models: CatalogModel[]; provider: CatalogProvider }>;
  onMakeDefault?(model: CatalogModel): void;
  onOpenParameters?(): void;
  onQuery(value: string): void;
  onReset?(): void;
  onSelect(model: CatalogModel): void;
  parametersSummary: string | null;
  provenance: AssistantRowProvenanceV2 | null;
  query: string;
  recommendedModelId: string | null;
  selectedModelId: string;
  selectedProvider: string;
}>) {
  const personalDefault = config?.catalog.defaults.personalModelDefault;
  const organizationDefault = config?.catalog.defaults.organizationModelDefault;
  const hasMatches = groups.some((group) => group.models.length > 0);
  const modelCount = groups.reduce((count, group) => count + group.models.length, 0);
  const fixed = provenance?.kind === "fixed";
  const currentModelName = config?.catalog.models.find((model) =>
    model.modelId === selectedModelId && model.provider === selectedProvider
  )?.displayName ?? null;
  const footer = (
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
  );
  const provenanceLine = (
    <ModelProvenanceLine
      currentModelName={currentModelName}
      models={config?.catalog.models ?? EMPTY_MODELS}
      onReset={onReset}
      provenance={provenance}
      recommendedModelId={recommendedModelId}
    />
  );

  // A model fixed by the Assistant cannot change in the chat: the picker
  // shows why and keeps only its Parameters row.
  if (fixed) {
    return (
      <div className="v2-composer-model-fixed" data-testid="composer-v2-model-fixed">
        {provenanceLine}
        {footer}
      </div>
    );
  }

  return (
    <>
      {provenanceLine}
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
              <UiV2ProviderMark family={group.provider.family ?? null} label={group.provider.name} />
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
                      {glyphs.map((glyph) => <UiV2Icon key={glyph.icon} name={glyph.icon} title={glyph.label} />)}
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
                      <span className="v2-composer-model-default-label">Set as default</span>
                      <UiV2Icon name="star" />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </section>
        ))}
      </div>
      {footer}
    </>
  );
}
