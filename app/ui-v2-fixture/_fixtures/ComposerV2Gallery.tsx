"use client";

import type { ComposerConfig } from "@/lib/contracts/composerConfig";
import type { ComposerMcpSelection } from "@/components/app-shell/composerControlStore";
import type { ShellComposerAssistant } from "@/components/app-shell/powerAppShellV2Contracts";
import {
  ASSISTANT_ROW_KEYS,
  type AssistantRowDeviation,
  type AssistantRowKey,
  type AssistantRowPolicy,
  type AssistantRowProvenance,
  type AssistantRowValues
} from "@/lib/contracts/assistants";
import type { ChatAssistantRowValues } from "@/lib/contracts/chats";
import type { AttachmentLimitUsage } from "@/components/app-shell/attachmentLimitUsage";
import type { ChatNavigationSummaryWire } from "@/lib/contracts/chats";
import {
  EMPTY_KNOWLEDGE_SELECTION,
  explicitKnowledgeSelection,
  inheritedKnowledgeSelection,
  type KnowledgeSelection
} from "@/lib/contracts/knowledge";
import { ConversationV2 } from "@/features/conversation-v2/ConversationV2";
import {
  NavigationSidebar,
  ReadingRoomShellV2
} from "@/features/navigation-v2/NavigationV2";
import { useEffect, useRef, useState } from "react";
import {
  ComposerV2,
  type ComposerV2Layer,
  type ComposerV2LayerController
} from "@/features/composer-v2/ComposerV2";
import type { ComposerV2Assistant } from "@/features/composer-v2/AssistantRowProvenanceV2";
import { HeaderModelSelectorV2 } from "@/features/workspace-v2/WorkspaceHeaderV2";
import { headerModelProvenanceV2 } from "@/features/workspace-v2/HeaderAssistantSelectorV2";
import type { ComposerAttachmentItemV2 } from "@/features/attachments-v2/attachmentPresentation";

export type ComposerGalleryState =
  | "assistant"
  | "assistant-changed"
  | "assistant-fallback"
  | "assistant-fixed"
  | "assistant-fixed-model"
  | "assistant-project-fallback"
  | "assistant-knowledge"
  | "add"
  | "attachments"
  | "capabilities"
  | "chips-wide"
  | "chips-wide-comments"
  | "chips-off"
  | "chips-off-pinned"
  | "chips-agent"
  | "workspace-running"
  | "workspace-failed"
  | "default"
  | "error"
  | "model"
  | "knowledge"
  | "project-knowledge"
  | "reasoning"
  | "reasoning-hidden"
  | "reasoning-locked"
  | "reasoning-running"
  | "zero";

const avatar = {
  accents: [1, 4],
  backgroundShape: "circle" as const,
  foregroundShape: "ring" as const,
  kind: "generated" as const,
  paletteId: "ocean" as const,
  recipeVersion: 1 as const,
  rotations: [0, 1] as [0, 1]
};

export const composerGalleryConfig: ComposerConfig = {
  assistants: [{
    archived: false,
    audience: { everyone: false, groupNames: [] },
    availability: { ok: true },
    avatar,
    featured: false,
    featuredOrder: null,
    rowAvailability: {},
    category: "research",
    description: "Собирает и сравнивает проверяемые источники.",
    fingerprint: {
      knowledgeLabel: "Knowledge · 2",
      knowledgeResourceCount: 2,
      mcpServerCount: 1,
      modelLabel: "GPT-5.2",
      reasoningEffort: "high",
      searchOptionCount: 1
    },
    id: "assistant-research",
    name: "Research editor",
    owned: true,
    ownerDisplayName: "Мария",
    pinned: true,
    published: false,
    scope: { kind: "owner" },
    skillLinkCount: 0,
    starterPrompts: ["Сравни источники"],
    updatedAt: "2026-08-13T09:00:00.000Z"
  }],
  catalog: {
    attachmentLimits: {
      maxCount: 20,
      maxEncodedBytes: 100_663_296,
      maxMaterializedBytes: 67_108_864
    },
    defaults: {
      controlValues: {},
      hasPersonalModelDefault: true,
      modelId: "gpt-5.2",
      modelPreferenceSource: "personal",
      organizationModelDefault: { modelId: "gemini-3-pro", provider: "google-work" },
      organizationSearchPlan: { mode: "all_selected", optionIds: ["web-primary"] },
      personalModelDefault: { modelId: "gpt-5.2", provider: "openai-work" },
      provider: "openai-work",
      searchPlan: { mode: "all_selected", optionIds: ["web-primary"] },
      searchPreferenceSource: "personal",
      showCitations: true,
      showReasoningBlocks: false,
    },
    models: [{
      capabilities: {
        background: true,
        documentInputMode: "native_pdf",
        imageInput: true,
        nativeWebSearch: true,
        openRouterPerplexitySearch: false,
        reasoning: true,
        streaming: true,
        toolCalling: true
      },
      contextWindow: 200_000,
      defaultParams: {},
      displayName: "GPT-5.2",
      modelId: "gpt-5.2",
      parameterControls: {
        background: { defaultValue: true, supported: true },
        maxOutputTokens: { defaultValue: 8_192, maxValue: 128_000 },
        reasoningEffort: {
          defaultValue: "medium",
          options: ["low", "medium", "high"],
          supported: true
        },
        stream: { defaultValue: false, supported: true },
        temperature: { defaultValue: 0.7, maxValue: 2, minValue: 0, supported: true }
      },
      provider: "openai-work",
      providerFamily: "openai",
      searchOptionCompatibility: {
        "web-primary": { clientToolCompatible: true, executionModes: ["all_selected", "model_choice"] },
        "research-search": { clientToolCompatible: true, executionModes: ["all_selected", "model_choice"] }
      },
      searchStrategyIds: ["search-disabled", "web-primary", "research-search"],
      upstreamModelId: "gpt-5.2"
    }, {
      capabilities: {
        background: false,
        documentInputMode: "pdf_text_extraction",
        imageInput: true,
        nativeWebSearch: false,
        openRouterPerplexitySearch: false,
        reasoning: true,
        streaming: true,
        toolCalling: true
      },
      contextWindow: 128_000,
      defaultParams: {},
      displayName: "GPT-5.2 mini",
      modelId: "gpt-5.2-mini",
      parameterControls: {
        background: { defaultValue: false, supported: false },
        maxOutputTokens: { defaultValue: 8_192, maxValue: 32_000 },
        reasoningEffort: {
          defaultValue: "medium",
          options: ["low", "medium", "high"],
          supported: true
        },
        stream: { defaultValue: true, supported: true },
        temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
      },
      provider: "openai-work",
      providerFamily: "openai",
      searchOptionCompatibility: {
        "web-primary": { clientToolCompatible: true, executionModes: ["all_selected"] }
      },
      searchStrategyIds: ["search-disabled", "web-primary"],
      upstreamModelId: "gpt-5.2-mini"
    }, {
      capabilities: {
        background: false,
        documentInputMode: "native_pdf",
        imageInput: true,
        nativeWebSearch: true,
        openRouterPerplexitySearch: false,
        reasoning: true,
        streaming: true,
        toolCalling: true
      },
      contextWindow: 1_000_000,
      defaultParams: {},
      displayName: "Gemini 3 Pro",
      modelId: "gemini-3-pro",
      parameterControls: {
        background: { defaultValue: false, supported: false },
        maxOutputTokens: { defaultValue: 8_192, maxValue: 65_536 },
        reasoningEffort: {
          defaultValue: "medium",
          options: ["low", "medium", "high"],
          supported: true
        },
        stream: { defaultValue: true, supported: true },
        temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
      },
      provider: "google-work",
      providerFamily: "google",
      searchOptionCompatibility: {
        "web-primary": { clientToolCompatible: false, executionModes: ["model_choice"] }
      },
      searchStrategyIds: ["search-disabled", "web-primary"],
      upstreamModelId: "gemini-3-pro"
    }],
    providers: [{
      family: "openai",
      id: "openai-work",
      models: ["gpt-5.2", "gpt-5.2-mini"],
      name: "OpenAI · рабочий"
    }, {
      family: "google",
      id: "google-work",
      models: ["gemini-3-pro"],
      name: "Google"
    }],
    searchStrategies: [{
      displayName: "No Search",
      kind: "none",
      strategyId: "search-disabled"
    }, {
      description: "Fresh web sources",
      displayName: "Web Search",
      kind: "web_search",
      strategyId: "web-primary"
    }, {
      description: "Research-grade search",
      displayName: "Research Search",
      kind: "provider_model_web_search",
      strategyId: "research-search"
    }]
  },
  knowledgeBases: [{
    archived: false,
    attentionDocumentCount: 0,
    description: "Финансовые планы и квартальные данные",
    documentCount: 42,
    id: "kb-finance",
    name: "Финансы 2026",
    owned: true,
    processingDocumentCount: 0,
    readinessState: "ready",
    readyDocumentCount: 42
  }, {
    archived: false,
    attentionDocumentCount: 1,
    description: "Исследования продукта",
    documentCount: 27,
    id: "kb-product",
    name: "Product research",
    owned: false,
    processingDocumentCount: 3,
    readinessState: "ready",
    readyDocumentCount: 23
  }, {
    archived: true,
    attentionDocumentCount: 0,
    description: "Архивная база",
    documentCount: 8,
    id: "kb-archived",
    name: "Архив проекта",
    owned: true,
    processingDocumentCount: 0,
    readinessState: "archived",
    readyDocumentCount: 8
  }],
  knowledgeDocumentTotal: 89,
  knowledgeSources: Array.from({ length: 7 }, (_, index) => ({
    description: index === 1 ? "Still joining the active index" : `Reference document ${index + 1}`,
    id: `source-${index + 1}`,
    name: index === 6 ? "Governance appendix" : `Quarterly source ${index + 1}`,
    owned: true,
    readiness: index === 1 ? "processing" as const : "ready" as const
  })),
  mcpServers: [{
    description: "Создание и проверка офисных документов",
    enabled: true,
    id: "mcp-office",
    knownToolCount: 2,
    name: "office-compute",
    readiness: "ready"
  }, {
    description: "Работа с задачами",
    enabled: false,
    id: "mcp-jira",
    knownToolCount: 4,
    name: "jira",
    readiness: "needs_authorization"
  }]
};

/**
 * What a Project chat's composer receives (`PowerAppShellV2View`): the
 * Project's Knowledge and MCP servers only, no personal documents, and the
 * composer marked as a shared Project, which never offers All my knowledge.
 */
export const composerGalleryProjectConfig: ComposerConfig = {
  ...composerGalleryConfig,
  knowledgeBases: [{
    archived: false,
    attentionDocumentCount: 0,
    description: "Shared with the Project",
    documentCount: 12,
    id: "kb-launch",
    name: "Launch playbooks",
    owned: false,
    processingDocumentCount: 0,
    readinessState: "ready",
    readyDocumentCount: 12
  }],
  knowledgeDocumentTotal: 2,
  knowledgeSources: [{
    description: "Shared with the Project",
    id: "project-source-1",
    name: "Launch checklist",
    owned: false,
    readiness: "ready"
  }, {
    description: "Shared with the Project",
    id: "project-source-2",
    name: "Rollout calendar",
    owned: false,
    readiness: "ready"
  }],
  mcpServers: composerGalleryConfig.mcpServers.filter((server) => server.id === "mcp-office")
};

const attachmentGalleryItems: ComposerAttachmentItemV2[] = [{
  byteSize: 12_400,
  fileName: "budget.csv",
  id: "local-upload-budget",
  progress: 64,
  status: "uploading"
}, {
  byteSize: 24_800,
  fileName: "plan.docx",
  id: "attachment-plan",
  kind: "document",
  status: "processing"
}, {
  byteSize: 43_008,
  fileName: "sales_q3.csv",
  id: "attachment-sales",
  kind: "document",
  status: "ready"
}, {
  fileName: "setup.exe",
  id: "local-rejected-setup",
  rejection: "unsupported_format",
  status: "rejected"
}, {
  detail: "Over 25 MB",
  fileName: "archive.pdf",
  id: "local-rejected-archive",
  rejection: "too_large",
  status: "rejected"
}, {
  detail: "Could not extract text from the PDF.",
  fileName: "scan.pdf",
  id: "attachment-scan",
  kind: "pdf",
  retryable: true,
  status: "failed"
}];

const attachmentGalleryUsage: AttachmentLimitUsage = {
  binaryAttachmentCount: 0,
  blocking: false,
  count: 4,
  encodedBytes: 0,
  feedback: null,
  limits: composerGalleryConfig.catalog.attachmentLimits ?? null,
  materializedBytes: 0,
  summary: "4 files · 78.3 KB",
  tone: "neutral",
  totalSourceBytes: 80_208
};

const navigationChats: ChatNavigationSummaryWire[] = [{
  activeRun: false,
  assistant: null,
  folderId: null,
  id: "composer-fixture",
  title: "Квартальный отчёт",
  updatedAt: "2026-08-13T09:00:00.000Z"
}];

type BoundGalleryAssistant = Extract<ShellComposerAssistant, { state: "bound" }>;

/** The gallery Assistant's own values: a recommended model, no web search, one MCP server, one base, two Skills. */
export const composerGalleryAssistantValues: AssistantRowValues = {
  controls: { reasoningEffort: "high" },
  knowledge: { baseIds: ["kb-finance"], mode: "explicit", sourceIds: [] },
  model: { mode: "model", modelId: "gpt-5.2" },
  search: { mode: "off" },
  skills: {
    links: [
      { delivery: "always", skillId: "skill-citations" },
      { delivery: "on_demand", skillId: "skill-charts" }
    ],
    mode: "auto"
  },
  tools: { mode: "exact", serverIds: ["mcp-office"] }
};

/**
 * A bound Assistant as the shell projects it. Rows default to adjustable,
 * set by the Assistant and unchanged; `values` are the effective values.
 */
export function composerGalleryAssistant(input: Readonly<{
  assistantValues?: Partial<AssistantRowValues>;
  deviations?: Partial<Record<AssistantRowKey, AssistantRowDeviation>>;
  origins?: Partial<Record<AssistantRowKey, AssistantRowProvenance>>;
  policies?: Partial<Record<AssistantRowKey, AssistantRowPolicy>>;
  /** A Project chat's Assistant: fallback rows use the Project default. */
  project?: boolean;
  values?: Partial<ChatAssistantRowValues>;
}> = {}): BoundGalleryAssistant {
  const assistantValues = { ...composerGalleryAssistantValues, ...input.assistantValues };
  const rows = Object.fromEntries(ASSISTANT_ROW_KEYS.map((row) => [row, {
    assistantValue: assistantValues[row],
    deviation: input.deviations?.[row] ?? null,
    origin: input.origins?.[row] ?? "assistant",
    policy: input.policies?.[row] ?? "adjustable",
    value: input.values?.[row] ?? assistantValues[row]
  }])) as BoundGalleryAssistant["rows"];
  const origins = input.origins ?? {};
  return {
    availability: { ok: true },
    avatar,
    blockReason: null,
    changedRows: ASSISTANT_ROW_KEYS.filter((row) => origins[row] === "chat"),
    description: "Собирает и сравнивает проверяемые источники.",
    id: "assistant-research",
    includedSkills: [
      { id: "skill-citations", mode: "pinned", name: "Policy citations" },
      { id: "skill-charts", mode: "available", name: "Charts" }
    ],
    name: "Research editor",
    owned: !input.project,
    ownerDisplayName: input.project ? "Project" : "Мария",
    ...(input.project ? { project: true as const } : {}),
    rows,
    scope: "chat",
    starterPrompts: ["Сравни источники"],
    state: "bound"
  };
}

type GalleryAssistantSetup = Readonly<{
  assistantValues?: Partial<AssistantRowValues>;
  deviations?: Partial<Record<AssistantRowKey, AssistantRowDeviation>>;
  origins: Partial<Record<AssistantRowKey, AssistantRowProvenance>>;
  policies?: Partial<Record<AssistantRowKey, AssistantRowPolicy>>;
  project?: boolean;
}>;

const ALL_FIXED: Record<AssistantRowKey, AssistantRowPolicy> = {
  controls: "fixed", knowledge: "fixed", model: "fixed", search: "fixed", skills: "fixed", tools: "fixed"
};

function galleryAssistantSetup(state: ComposerGalleryState): GalleryAssistantSetup | null {
  switch (state) {
    case "assistant":
      return { origins: {} };
    case "assistant-fixed":
      return { origins: {}, policies: ALL_FIXED };
    // A new Assistant's default: a fixed model with adjustable parameters.
    case "assistant-fixed-model":
      return { origins: {}, policies: { model: "fixed" } };
    case "assistant-changed":
      return { origins: { knowledge: "chat", search: "chat", skills: "chat", tools: "chat" } };
    case "assistant-project-fallback":
      // The Project provides neither the Assistant's model nor its
      // Knowledge: its entry counts that Knowledge without naming it.
      return {
        assistantValues: {
          knowledge: { baseIds: [], hiddenCount: 1, mode: "explicit", sourceIds: [] },
          model: { mode: "model", modelId: null }
        },
        deviations: {
          knowledge: { reason: "knowledge_access" },
          model: { reason: "model_access" }
        },
        origins: { controls: "default", knowledge: "fallback", model: "fallback" },
        project: true
      };
    case "assistant-fallback":
      return {
        assistantValues: { model: { mode: "model", modelId: null } },
        deviations: {
          knowledge: { reason: "knowledge_access" },
          model: { reason: "model_access" }
        },
        origins: { controls: "default", knowledge: "fallback", model: "fallback" }
      };
    case "assistant-knowledge":
      return {
        assistantValues: { knowledge: { baseIds: [], hiddenCount: 2, mode: "explicit", sourceIds: [] } },
        origins: {}
      };
    // Fixed parameters need a fixed model; the Assistant's level is "high".
    case "reasoning-locked":
      return { origins: {}, policies: { controls: "fixed", model: "fixed" } };
    default:
      return null;
  }
}

function initialLayer(state: ComposerGalleryState): ComposerV2Layer {
  if (state === "model" || state === "assistant-fallback" || state === "assistant-fixed-model") return "model";
  if (state === "assistant-project-fallback") return "knowledge";
  if (state === "add") return "add";
  if (state === "assistant") return "skills";
  if (state === "assistant-fixed") return "tools";
  if (state === "assistant-changed") return "search";
  if (state === "assistant-knowledge" || state === "knowledge" || state === "project-knowledge") {
    return "knowledge";
  }
  return null;
}

const INITIAL_LAYER_TRIGGERS: Readonly<Record<Exclude<ComposerV2Layer, null>, string>> = {
  add: 'button[aria-label="Add"]',
  files: 'button[aria-label="Add"]',
  knowledge: 'button[aria-label="Choose Knowledge"]',
  model: '[data-testid="header-model-trigger"]',
  reasoning: 'button[aria-label^="Reasoning effort"]',
  search: 'button[aria-label^="Choose web search"]',
  skills: 'button[aria-label="Change Skills mode"]',
  tools: 'button[aria-label="Change MCP mode"]',
  workspace: 'button[aria-label^="Workspace details"]'
};

/** A full raw level list, so the chip is measured with its widest values. */
const GALLERY_REASONING_OPTIONS = ["none", "minimal", "low", "medium", "high", "xhigh"];

/* The reasoning chip appears where a state shows it: the reasoning states and
   the worst-case chip rows. `reasoning-hidden` uses a model without it. */
function galleryReasoningConfig(config: ComposerConfig, state: ComposerGalleryState): ComposerConfig {
  const hidden = state === "reasoning-hidden";
  return {
    ...config,
    catalog: {
      ...config.catalog,
      models: config.catalog.models.map((model) => model.modelId !== "gpt-5.2" ? model : {
        ...model,
        capabilities: { ...model.capabilities, reasoning: !hidden },
        parameterControls: {
          ...model.parameterControls,
          reasoningEffort: hidden
            ? { defaultValue: "none", options: ["none"], supported: false }
            : { defaultValue: "medium", options: GALLERY_REASONING_OPTIONS, supported: true }
        }
      })
    }
  };
}

export function ComposerV2Gallery({ state = "default" }: { state?: ComposerGalleryState }) {
  const wideChips = state === "chips-wide" || state === "chips-wide-comments";
  const reasoningFixture = wideChips || state.startsWith("reasoning");
  const reasoningRunning = state === "reasoning-running";
  const [comments, setComments] = useState(() => state === "chips-wide-comments"
    ? [1, 2, 3].map(index => ({ id: String(index), quote: `Selected fragment ${index}`, text: `Pending comment ${index}` })) : []);
  const offChips = state === "chips-off" || state === "chips-off-pinned";
  const chipFixture = wideChips || offChips || state === "chips-agent";
  const projectFallback = state === "assistant-project-fallback";
  const [config, setConfig] = useState<ComposerConfig>(() => state === "zero"
    ? {
        ...composerGalleryConfig,
        catalog: {
          ...composerGalleryConfig.catalog,
          defaults: {
            ...composerGalleryConfig.catalog.defaults,
            hasPersonalModelDefault: false,
            modelId: "",
            modelPreferenceSource: "none",
            organizationModelDefault: null,
            personalModelDefault: null,
            provider: ""
          },
          models: [],
          providers: []
        },
        mcpServers: []
      }
    : projectFallback
      ? composerGalleryProjectConfig
      : reasoningFixture
        ? galleryReasoningConfig({ ...composerGalleryConfig, mcpServers: composerGalleryConfig.mcpServers.map((server) =>
            wideChips ? { ...server, enabled: true } : server
          ) }, state)
        : { ...composerGalleryConfig, mcpServers: composerGalleryConfig.mcpServers.map((server) =>
            wideChips || offChips ? { ...server, enabled: true } : server
          ) });
  const [workspaceEnabled, setWorkspaceEnabled] = useState(!offChips);
  const [agentEnabled, setAgentEnabled] = useState(false);
  const allCapabilities = chipFixture || ["capabilities", "workspace-running", "workspace-failed"].includes(state);
  const [draft, setDraft] = useState(state === "default" ? "Подготовь краткое резюме" : "");
  // Assistant states mirror the composer store: a change marks an adjustable
  // row as changed for this chat, a fixed row refuses it, Reset restores it.
  const [assistantSetup] = useState(() => galleryAssistantSetup(state));
  const assistantValues = { ...composerGalleryAssistantValues, ...assistantSetup?.assistantValues };
  const assistantKnowledgeSelection = (): KnowledgeSelection => {
    const knowledge = assistantValues.knowledge;
    return knowledge.mode !== "explicit"
      ? EMPTY_KNOWLEDGE_SELECTION
      : knowledge.hiddenCount
        ? inheritedKnowledgeSelection("assistant")
        : explicitKnowledgeSelection({ baseIds: knowledge.baseIds, sourceIds: knowledge.sourceIds });
  };
  const assistantChanged = state === "assistant-changed";
  const assistantFallback = state === "assistant-fallback" || state === "assistant-project-fallback";
  const [assistantOrigins, setAssistantOrigins] = useState(assistantSetup?.origins ?? {});
  const [selectedModel, setSelectedModel] = useState({ modelId: "gpt-5.2", provider: "openai-work" });
  const [searchIds, setSearchIds] = useState<string[]>(state === "zero" || offChips || state === "chips-agent" ||
    (assistantSetup && !assistantChanged)
    ? [] : wideChips ? ["web-primary", "research-search"] : ["web-primary"]);
  const [knowledgeSelection, setKnowledgeSelection] = useState<KnowledgeSelection>(() => {
    if (state === "zero" || offChips || state === "chips-agent") return EMPTY_KNOWLEDGE_SELECTION;
    if (wideChips) return explicitKnowledgeSelection({ baseIds: ["kb-finance", "kb-product"], sourceIds: ["source-7"] });
    // A Project's fallback row runs with the Project's default Knowledge.
    if (projectFallback) return explicitKnowledgeSelection({ baseIds: ["kb-launch"], sourceIds: [] });
    if (state === "project-knowledge" || assistantChanged || assistantFallback) {
      return explicitKnowledgeSelection({ baseIds: ["kb-product"], sourceIds: ["source-7"] });
    }
    if (assistantSetup) return assistantKnowledgeSelection();
    return explicitKnowledgeSelection({ baseIds: ["kb-finance"] });
  });
  const [knowledgePlanSource, setKnowledgePlanSource] = useState<
    "assistant" | "explicit" | "off" | "project"
  >(() => assistantSetup && !assistantChanged && !assistantFallback
    ? "assistant"
    : state === "project-knowledge" || projectFallback ? "project" : state === "zero" ? "off" : "explicit");
  const [mcpSelection, setMcpSelection] = useState<ComposerMcpSelection>(assistantSetup && !assistantChanged
    ? structuredClone(composerGalleryAssistantValues.tools as ComposerMcpSelection)
    : { mode: wideChips ? "load_all" : offChips ? "off" : "auto" });
  const [skillsMode, setSkillsMode] = useState<"auto" | "off">(offChips || assistantChanged ? "off" : "auto");
  const [reasoningEffort, setReasoningEffort] = useState(wideChips ? "xhigh" : "high");
  const [attachmentItems, setAttachmentItems] = useState<ComposerAttachmentItemV2[]>(
    state === "attachments" ? attachmentGalleryItems : []
  );
  const attachmentSequenceRef = useRef(0);
  const rowFixed = (row: AssistantRowKey) => assistantSetup?.policies?.[row] === "fixed";
  /* A user change of a row; false when the Assistant fixes it. */
  const changeRow = (row: AssistantRowKey): boolean => {
    if (!assistantSetup) return true;
    if (rowFixed(row)) return false;
    setAssistantOrigins((current) => ({ ...current, [row]: "chat" }));
    return true;
  };
  const resetRow = (row: AssistantRowKey) => {
    if (!assistantSetup || rowFixed(row)) return;
    setAssistantOrigins((current) => ({ ...current, [row]: assistantSetup.origins[row] ?? "assistant" }));
    if (row === "model") setSelectedModel({ modelId: "gpt-5.2", provider: "openai-work" });
    if (row === "search") setSearchIds([]);
    if (row === "tools") setMcpSelection(structuredClone(assistantValues.tools as ComposerMcpSelection));
    if (row === "skills") setSkillsMode(assistantValues.skills.mode);
    if (row === "knowledge") {
      setKnowledgeSelection(assistantKnowledgeSelection());
      setKnowledgePlanSource("assistant");
    }
  };
  const galleryAssistant: ComposerV2Assistant | null = assistantSetup ? {
    current: composerGalleryAssistant({
      ...assistantSetup,
      origins: assistantOrigins,
      values: {
        knowledge: knowledgeSelection.mode === "inherited"
          ? assistantValues.knowledge as ChatAssistantRowValues["knowledge"]
          : knowledgeSelection.mode === "explicit"
            ? { baseIds: knowledgeSelection.baseIds, mode: "explicit", sourceIds: knowledgeSelection.sourceIds }
            : { mode: knowledgeSelection.mode },
        model: { mode: "model", modelId: selectedModel.modelId },
        search: searchIds.length > 0 ? { mode: "all_selected", optionIds: searchIds } : { mode: "off" },
        skills: { ...assistantValues.skills, mode: skillsMode },
        tools: mcpSelection
      }
    }),
    resetRow
  } : null;
  // The model is chosen from the header selector, which anchors the
  // composer-owned picker through its layer controller.
  const galleryRef = useRef<HTMLDivElement>(null);
  const layerController = useRef<ComposerV2LayerController | null>(null);
  const initiallyOpenedStateRef = useRef<ComposerGalleryState | null>(null);
  const [openLayer, setOpenLayer] = useState<ComposerV2Layer>(null);
  const currentModel = config.catalog.models.find((model) =>
    model.modelId === selectedModel.modelId && model.provider === selectedModel.provider
  );
  const currentProvider = config.catalog.providers.find((provider) => provider.id === currentModel?.provider);
  const noModels = config.catalog.models.length === 0;
  const modelName = currentModel?.displayName ?? (noModels ? "No models available" : "Choose model");
  const reasoningControl = currentModel?.parameterControls.reasoningEffort;

  // Gallery states open the same real trigger a user would. Supplying only
  // `initialLayer` skips anchor measurement and can make a healthy popover
  // appear detached from its chip or even clipped outside the viewport.
  useEffect(() => {
    const layer = initialLayer(state);
    if (!layer || initiallyOpenedStateRef.current === state) return;
    const selector = INITIAL_LAYER_TRIGGERS[layer];
    const frame = window.requestAnimationFrame(() => {
      initiallyOpenedStateRef.current = state;
      galleryRef.current?.querySelector<HTMLButtonElement>(selector)?.click();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [state]);

  const sidebar = (onClose: () => void) => (
    <NavigationSidebar
      activeChatId="composer-fixture"
      chats={navigationChats}
      error={null}
      folders={[]}
      hasMore={false}
      loading={false}
      now={new Date("2026-08-13T12:00:00.000Z")}
      onClose={onClose}
      onLoadMore={() => undefined}
      onNewChat={() => undefined}
      onRetry={() => undefined}
      onSearch={() => undefined}
      onSelectChat={() => undefined}
      ready
      searchError={null}
      searchLoading={false}
      searchQuery=""
    />
  );

  return (
    <div ref={galleryRef} data-testid="ui-v2-composer-gallery">
      <ReadingRoomShellV2
        onNewChat={() => undefined}
        onSelectChat={() => undefined}
        sidebar={sidebar}
      >
        <main className="v2-composer-gallery-main" data-composer-state={state}>
          <header className="v2-live-header">
            <HeaderModelSelectorV2
              selector={{
                disabled: state === "error" || noModels,
                expanded: openLayer === "model",
                family: currentProvider?.family ?? null,
                label: currentProvider?.name ?? "",
                ...headerModelProvenanceV2(galleryAssistant?.current ?? null, modelName, config.catalog.models),
                name: modelName,
                onToggle: (anchor) => layerController.current?.toggle("model", anchor)
              }}
            />
          </header>
          <ConversationV2
            messages={[{
              content: "Собери квартальный отчёт и отметь источники.",
              id: "composer-question",
              role: "user"
            }, {
              content: "Соберу отчёт в документальном формате. Выбранные возможности видны рядом с моделью, а результат останется в обычном ответе.",
              id: "composer-answer",
              role: "assistant"
            }]}
          />
          <div className="v2-composer-gallery-dock">
            <ComposerV2
              agent={allCapabilities ? {
                enabled: agentEnabled, onToggle: setAgentEnabled,
                unavailableReason: workspaceEnabled ? undefined : "Enable Workspace to use Agent."
              } : undefined}
              assistant={galleryAssistant}
              attachmentItems={attachmentItems}
              attachmentLimitUsage={state === "attachments" ? attachmentGalleryUsage : null}
              config={state === "error" ? null : config}
              configError={state === "error"}
              draft={draft}
              layerController={layerController}
              mcpSelection={mcpSelection}
              modelParametersSummary={`Reasoning ${reasoningFixture ? reasoningEffort : "medium"} · Temp 1.0`}
              reasoningEffort={reasoningFixture && reasoningControl?.supported ? {
                onChange: (value) => { if (changeRow("controls")) setReasoningEffort(value); },
                options: reasoningControl.options,
                value: reasoningEffort
              } : null}
              activeRun={reasoningRunning}
              runId={reasoningRunning ? "gallery-run" : null}
              onStop={() => undefined}
              onAttachmentCountLimitExceeded={() => undefined}
              onDraftChange={setDraft}
              onLayerChange={setOpenLayer}
              onMakeModelDefault={() => undefined}
              onOpenKnowledgeLibrary={projectFallback ? undefined : () => undefined}
              onOpenMcpSettings={() => undefined}
              onOpenModelParameters={() => undefined}
              onOpenSkillLibrary={() => undefined}
              onOverrideKnowledgePlan={() => {
                setKnowledgePlanSource("explicit");
                if (knowledgeSelection.mode === "inherited") {
                  setKnowledgeSelection(EMPTY_KNOWLEDGE_SELECTION);
                }
              }}
              onRemoveAttachment={(id) => setAttachmentItems((current) =>
                current.filter((item) => item.id !== id)
              )}
              onRejectedFiles={(files) => setAttachmentItems((current) => [
                ...current,
                ...files.map((file) => {
                  attachmentSequenceRef.current += 1;
                  return {
                    byteSize: file.size,
                    fileName: file.name,
                    id: `local-rejected-${attachmentSequenceRef.current}`,
                    rejection: "unsupported_format" as const,
                    status: "rejected" as const
                  };
                })
              ])}
              onRetryConfig={() => undefined}
              onRetryAttachment={(id) => setAttachmentItems((current) =>
                current.map((item) => item.id === id
                  ? { ...item, detail: null, status: "processing" as const }
                  : item)
              )}
              onSelectKnowledgeSelection={(selection) => {
                if (!changeRow("knowledge")) return;
                setKnowledgeSelection(selection);
                setKnowledgePlanSource(selection.mode === "none" ? "off" : "explicit");
              }}
              onSelectMcp={(selection) => { if (changeRow("tools")) setMcpSelection(selection); }}
              onSelectSkillsMode={(mode) => { if (changeRow("skills")) setSkillsMode(mode); }}
              onSelectModel={(model) => {
                if (changeRow("model")) setSelectedModel({ modelId: model.modelId, provider: model.provider });
              }}
              onSelectSearchOptionIds={(ids) => { if (changeRow("search")) setSearchIds([...ids]); }}
              comments={comments}
              onUpdateComment={(id, text) => {
                setComments(current => current.map(comment => comment.id === id ? { ...comment, text } : comment));
                return null;
              }}
              onRemoveComment={id => setComments(current => current.filter(comment => comment.id !== id))}
              onSend={() => { setDraft(""); setComments([]); }}
              onToggleMcpServer={(serverId, enabled) => setConfig((current) => ({
                ...current,
                mcpServers: current.mcpServers.map((server) =>
                  server.id === serverId ? { ...server, enabled } : server
                )
              }))}
              onUploadFiles={(files) => setAttachmentItems((current) => [
                ...current,
                ...files.map((file) => {
                  attachmentSequenceRef.current += 1;
                  return {
                    byteSize: file.size,
                    fileName: file.name,
                    id: `local-upload-${attachmentSequenceRef.current}`,
                    progress: null,
                    status: "uploading" as const
                  };
                })
              ])}
              workspace={allCapabilities ? { available: true, busy: false, enabled: workspaceEnabled,
                internetEnabled: false, loading: false, onToggle: setWorkspaceEnabled,
                sessionState: state === "workspace-failed" || offChips ? "failed" : "ready", commandRunning: state === "workspace-running" || wideChips } : undefined}
              skillsMode={skillsMode}
              selectedSkillIds={wideChips || state === "chips-off-pinned"
                ? Array.from({ length: 32 }, (_, index) => `skill-${index}`)
                : allCapabilities && !chipFixture ? ["one", "two", "three"] : []}
              knowledgePlanSource={knowledgePlanSource}
              selectedKnowledgeSelection={knowledgeSelection}
              selectedModelId={selectedModel.modelId}
              selectedProvider={selectedModel.provider}
              selectedSearchOptionIds={searchIds}
              sharedProject={state === "project-knowledge" || projectFallback}
            />
          </div>
        </main>
      </ReadingRoomShellV2>
    </div>
  );
}
