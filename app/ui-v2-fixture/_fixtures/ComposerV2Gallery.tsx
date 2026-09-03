"use client";

import type { McpRunSelection } from "@/lib/contracts/mcp";
import type { ComposerConfig } from "@/lib/contracts/composerConfig";
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
import { HeaderModelSelectorV2 } from "@/features/workspace-v2/WorkspaceHeaderV2";
import type { ComposerAttachmentItemV2 } from "@/features/attachments-v2/attachmentPresentation";

export type ComposerGalleryState =
  | "assistant"
  | "assistant-knowledge"
  | "add"
  | "attachments"
  | "default"
  | "error"
  | "model"
  | "knowledge"
  | "project-knowledge"
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
    availability: { ok: true },
    avatar,
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
    revisionNumber: 4,
    scope: { kind: "owner" },
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
  folderId: null,
  id: "composer-fixture",
  title: "Квартальный отчёт",
  updatedAt: "2026-08-13T09:00:00.000Z"
}];

function initialLayer(state: ComposerGalleryState): ComposerV2Layer {
  if (state === "model") return "model";
  if (state === "add" || state === "assistant") return "add";
  if (state === "assistant-knowledge" || state === "knowledge" || state === "project-knowledge") {
    return "knowledge";
  }
  return null;
}

export function ComposerV2Gallery({ state = "default" }: { state?: ComposerGalleryState }) {
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
    : composerGalleryConfig);
  const [draft, setDraft] = useState(state === "default" ? "Подготовь краткое резюме" : "");
  const [selectedModel, setSelectedModel] = useState({ modelId: "gpt-5.2", provider: "openai-work" });
  const [searchIds, setSearchIds] = useState<string[]>(state === "zero" ? [] : ["web-primary"]);
  const [knowledgeSelection, setKnowledgeSelection] = useState<KnowledgeSelection>(() => {
    if (state === "zero") return EMPTY_KNOWLEDGE_SELECTION;
    if (state === "assistant-knowledge") return inheritedKnowledgeSelection("assistant");
    if (state === "project-knowledge") {
      return explicitKnowledgeSelection({ baseIds: ["kb-product"], sourceIds: ["source-7"] });
    }
    return explicitKnowledgeSelection({ baseIds: ["kb-finance"] });
  });
  const [knowledgePlanSource, setKnowledgePlanSource] = useState<
    "assistant" | "explicit" | "off" | "project"
  >(() => state === "assistant-knowledge"
    ? "assistant"
    : state === "project-knowledge" ? "project" : state === "zero" ? "off" : "explicit");
  const [mcpSelection, setMcpSelection] = useState<McpRunSelection>({ mode: "auto" });
  const [attachmentItems, setAttachmentItems] = useState<ComposerAttachmentItemV2[]>(
    state === "attachments" ? attachmentGalleryItems : []
  );
  const attachmentSequenceRef = useRef(0);
  const [assistant, setAssistant] = useState(() => {
    const selected = state === "assistant" || state === "assistant-knowledge"
      ? config.assistants[0] ?? null
      : null;
    return selected ? {
      ...selected,
      knowledgeLabel: selected.fingerprint.knowledgeLabel,
      knowledgeResourceCount: selected.fingerprint.knowledgeResourceCount
    } : null;
  });
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

  // Gallery states open the same real trigger a user would. Supplying only
  // `initialLayer` skips anchor measurement and can make a healthy popover
  // appear detached from its chip or even clipped outside the viewport.
  useEffect(() => {
    const layer = initialLayer(state);
    if (!layer || initiallyOpenedStateRef.current === state) return;
    const selector = layer === "model"
      ? '[data-testid="header-model-trigger"]'
      : layer === "knowledge"
        ? 'button[aria-label="Choose Knowledge"]'
        : 'button[aria-label="Add"]';
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
                locked: Boolean(assistant),
                name: assistant ? `${assistant.name} · ${modelName}` : modelName,
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
              attachmentItems={attachmentItems}
              attachmentLimitUsage={state === "attachments" ? attachmentGalleryUsage : null}
              config={state === "error" ? null : config}
              configError={state === "error"}
              draft={draft}
              layerController={layerController}
              mcpSelection={mcpSelection}
              modelParametersSummary="Reasoning medium · Temp 1.0"
              onAttachmentCountLimitExceeded={() => undefined}
              onDraftChange={setDraft}
              onLayerChange={setOpenLayer}
              onMakeModelDefault={() => undefined}
              onOpenAssistantPicker={() => undefined}
              onOpenKnowledgeLibrary={() => undefined}
              onOpenMcpSettings={() => undefined}
              onOpenModelParameters={() => undefined}
              onOpenSkillLibrary={() => undefined}
              onOverrideKnowledgePlan={() => {
                setAssistant(null);
                setKnowledgePlanSource("explicit");
                if (knowledgeSelection.mode === "inherited") {
                  setKnowledgeSelection(EMPTY_KNOWLEDGE_SELECTION);
                }
              }}
              onRemoveAssistant={() => setAssistant(null)}
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
                setKnowledgeSelection(selection);
                setKnowledgePlanSource(selection.mode === "none" ? "off" : "explicit");
              }}
              onSelectMcp={setMcpSelection}
              onSelectModel={(model) => setSelectedModel({ modelId: model.modelId, provider: model.provider })}
              onSelectSearchOptionIds={(ids) => setSearchIds([...ids])}
              onSend={() => setDraft("")}
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
              selectedAssistant={assistant}
              knowledgePlanSource={knowledgePlanSource}
              selectedKnowledgeSelection={knowledgeSelection}
              selectedModelId={selectedModel.modelId}
              selectedProvider={selectedModel.provider}
              selectedSearchOptionIds={searchIds}
              sharedProject={state === "project-knowledge"}
            />
          </div>
        </main>
      </ReadingRoomShellV2>
    </div>
  );
}
