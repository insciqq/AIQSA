"use client";

import type { McpRunSelection } from "@/lib/contracts/mcp";
import type { ComposerConfig } from "@/lib/contracts/composerConfig";
import type { AttachmentLimitUsage } from "@/components/app-shell/attachmentLimitUsage";
import type { ChatNavigationSummaryWire } from "@/lib/contracts/chats";
import { ConversationV2 } from "@/features/conversation-v2/ConversationV2";
import {
  NavigationSidebar,
  ReadingRoomShellV2
} from "@/features/navigation-v2/NavigationV2";
import { useRef, useState } from "react";
import { ComposerV2, type ComposerV2Layer } from "@/features/composer-v2/ComposerV2";
import type { ComposerAttachmentItemV2 } from "@/features/attachments-v2/attachmentPresentation";

export type ComposerGalleryState =
  | "assistant"
  | "add"
  | "attachments"
  | "default"
  | "error"
  | "model"
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
    description: "Финансовые планы и квартальные данные",
    id: "kb-finance",
    name: "Финансы 2026",
    owned: true
  }, {
    archived: false,
    description: "Исследования продукта",
    id: "kb-product",
    name: "Product research",
    owned: false
  }, {
    archived: true,
    description: "Архивная база",
    id: "kb-archived",
    name: "Архив проекта",
    owned: true
  }],
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
  detail: "Over 50 MB",
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
  const [knowledgeIds, setKnowledgeIds] = useState<string[]>(state === "zero" ? [] : ["kb-finance"]);
  const [mcpSelection, setMcpSelection] = useState<McpRunSelection>({ mode: "auto" });
  const [attachmentItems, setAttachmentItems] = useState<ComposerAttachmentItemV2[]>(
    state === "attachments" ? attachmentGalleryItems : []
  );
  const attachmentSequenceRef = useRef(0);
  const assistant = state === "assistant" ? config.assistants[0] ?? null : null;

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
    <div data-testid="ui-v2-composer-gallery">
      <ReadingRoomShellV2
        onNewChat={() => undefined}
        onSelectChat={() => undefined}
        sidebar={sidebar}
      >
        <main className="v2-composer-gallery-main" data-composer-state={state}>
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
              initialLayer={initialLayer(state)}
              mcpSelection={mcpSelection}
              modelParametersSummary="Reasoning medium · Temp 1.0"
              onAttachmentCountLimitExceeded={() => undefined}
              onDraftChange={setDraft}
              onMakeModelDefault={() => undefined}
              onOpenAssistantPicker={() => undefined}
              onOpenKnowledgeLibrary={() => undefined}
              onOpenMcpSettings={() => undefined}
              onOpenModelParameters={() => undefined}
              onOpenSkillLibrary={() => undefined}
              onRemoveAssistant={() => undefined}
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
              onSelectKnowledgeBaseIds={(ids) => setKnowledgeIds([...ids])}
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
              selectedKnowledgeBaseIds={knowledgeIds}
              selectedModelId={selectedModel.modelId}
              selectedProvider={selectedModel.provider}
              selectedSearchOptionIds={searchIds}
            />
          </div>
        </main>
      </ReadingRoomShellV2>
    </div>
  );
}
