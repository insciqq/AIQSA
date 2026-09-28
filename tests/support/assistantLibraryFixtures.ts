import { vi } from "vitest";
import {
  defaultAssistantDraftRows,
  type AssistantEditorDraft
} from "@/components/assistants/libraryViewContracts";
import type { AssistantLibraryControllerInput } from "@/components/app-shell/assistantLibraryController";
import {
  initialAssistantLibrarySnapshot,
  useAssistantLibraryStore,
  type AssistantLibraryEditorState
} from "@/components/app-shell/assistantLibraryStore";
import {
  assistantRowsFromLegacyFields,
  type AssistantAvatarRecipe,
  type AssistantContent,
  type AssistantDetail,
  type AssistantListResponse,
  type AssistantOwnerAudience,
  type AssistantSummary
} from "@/lib/contracts/assistants";
import type { Catalog, CatalogModel } from "@/lib/contracts/catalog";

export const assistantAvatar: AssistantAvatarRecipe = {
  accents: [0, 4],
  backgroundShape: "circle",
  foregroundShape: "diamond",
  kind: "generated",
  paletteId: "ocean",
  recipeVersion: 1,
  rotations: [0, 2]
};

export function assistantContent(overrides: Partial<AssistantContent> = {}): AssistantContent {
  return {
    answerRules: null,
    avatar: assistantAvatar,
    category: "coding",
    description: "Reviews changes with care.",
    knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    mcpServerIds: [],
    name: "Code reviewer",
    providerModelId: "model-1",
    rows: assistantRowsFromLegacyFields({
      knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      mcpServerIds: [],
      providerModelId: "model-1",
      runControls: {},
      searchPlan: { mode: "model_choice", optionIds: [] },
      skillIds: []
    }),
    runControls: {},
    searchPlan: { mode: "model_choice", optionIds: [] },
    skillIds: [],
    starterPrompts: [],
    systemPrompt: "Review carefully.",
    ...overrides
  };
}

/** The owner's audience by default; null for a viewer who does not own it. */
function defaultAudience(owned: boolean | undefined): AssistantOwnerAudience | null {
  return owned === false ? null : { everyone: false, groupNames: [] };
}

export function assistantDetail(version = 3, overrides: Partial<AssistantDetail> = {}): AssistantDetail {
  return {
    archived: false,
    audience: defaultAudience(overrides.owned),
    availability: { ok: true },
    featured: false,
    featuredOrder: null,
    id: "assistant-1",
    listingRequest: { canRequest: true, canWithdraw: false, listed: false, request: null },
    owned: true,
    ownerDisplayName: "Dana Ops",
    pinned: false,
    publications: [],
    rowAvailability: {},
    scope: { kind: "owner" },
    content: assistantContent(),
    updatedAt: "2026-09-20T00:00:00.000Z",
    version,
    ...overrides
  };
}

export function assistantSummary(overrides: Partial<AssistantSummary> = {}): AssistantSummary {
  return {
    archived: false,
    audience: defaultAudience(overrides.owned),
    availability: { ok: true },
    avatar: assistantAvatar,
    category: "coding",
    description: "Reviews changes with care.",
    featured: false,
    featuredOrder: null,
    fingerprint: {
      knowledgeLabel: null,
      knowledgeResourceCount: 0,
      mcpServerCount: 0,
      modelLabel: "Model one",
      reasoningEffort: null,
      searchOptionCount: 0
    },
    id: "assistant-1",
    name: "Code reviewer",
    owned: true,
    ownerDisplayName: "Dana Ops",
    pinned: false,
    published: false,
    rowAvailability: {},
    scope: { kind: "owner" },
    skillLinkCount: 0,
    starterPrompts: [],
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...overrides
  };
}

export function assistantList(overrides: Partial<AssistantListResponse> = {}): AssistantListResponse {
  return {
    assistants: [],
    publishableGroups: [],
    recentAssistantIds: [],
    viewer: { canPublishInstallation: false, defaultAssistantId: null },
    ...overrides
  };
}

export function catalogModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    capabilities: {
      background: true,
      documentInputMode: "none",
      imageInput: false,
      nativeWebSearch: false,
      openRouterPerplexitySearch: false,
      reasoning: true,
      streaming: true,
      toolCalling: true
    },
    contextWindow: 128_000,
    defaultParams: {},
    displayName: "Model one",
    modelId: "model-1",
    parameterControls: {
      background: { defaultValue: false, supported: true },
      maxOutputTokens: { defaultValue: 4096, maxValue: 8192 },
      reasoningEffort: {
        defaultValue: "medium",
        options: ["low", "medium", "high", "max"],
        supported: true
      },
      stream: { defaultValue: true, supported: true },
      temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
    },
    provider: "provider-1",
    searchOptionCompatibility: {},
    searchStrategyIds: [],
    ...overrides
  };
}

export function catalog(models: CatalogModel[] = [catalogModel()]): Catalog {
  return {
    defaults: {
      controlValues: {},
      hasPersonalModelDefault: false,
      modelId: "model-1",
      modelPreferenceSource: "organization",
      organizationModelDefault: { modelId: "model-1", provider: "provider-1" },
      organizationSearchPlan: { mode: "all_selected", optionIds: [] },
      personalModelDefault: null,
      provider: "provider-1",
      searchPlan: { mode: "all_selected", optionIds: [] },
      searchPreferenceSource: "organization",
      showCitations: true,
      showReasoningBlocks: false
    },
    models,
    providers: [{ id: "provider-1", models: models.map((model) => model.modelId), name: "Provider" }],
    searchStrategies: []
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

/** The saved draft of `assistantDetail()`: a fixed model-1 and fixed Off rows. */
export function savedEditorDraft(): AssistantEditorDraft {
  const rows = defaultAssistantDraftRows();
  return {
    answerRules: null,
    avatar: assistantAvatar,
    category: "coding",
    description: "Reviews changes with care.",
    name: "Code reviewer",
    responseReminder: "",
    rows: {
      ...rows,
      knowledge: { policy: "fixed", value: { mode: "none" } },
      model: { policy: "fixed", value: { mode: "model", modelId: "model-1" } },
      search: { policy: "fixed", value: { mode: "off" } },
      skills: { policy: "fixed", value: { links: [], mode: "auto" } },
      tools: { policy: "fixed", value: { mode: "off" } }
    },
    starterPrompts: [],
    systemPrompt: "Review carefully."
  };
}

export function assistantControllerInput(): AssistantLibraryControllerInput {
  return {
    activateBlankWorkspace: vi.fn(),
    chooseAssistant: vi.fn(async (_detail: AssistantDetail): Promise<string | null> => null),
    catalog: catalog(),
    catalogError: null,
    knowledgeBases: [],
    knowledgeSources: [],
    knowledgeDataError: null,
    knowledgeDataState: "ready",
    openMcpSettings: vi.fn(),
    retryCatalog: vi.fn(),
    retryKnowledge: vi.fn(),
    setShellNotice: vi.fn(),
    skills: []
  };
}

export function editorState(overrides: Partial<AssistantLibraryEditorState> = {}): AssistantLibraryEditorState {
  const draft = overrides.draft ?? savedEditorDraft();
  return {
    assistantId: "assistant-1",
    archived: false,
    availability: { ok: true },
    baseline: JSON.stringify(draft),
    conflict: null,
    createdAssistantId: null,
    draft,
    error: null,
    errors: null,
    expectedVersion: 3,
    initialExpandedRow: null,
    rowAvailability: {},
    savedName: draft.name,
    selectedSkills: [],
    saving: false,
    ...overrides
  };
}

export function installAssistantEditor(options: { busy?: boolean; editor?: Partial<AssistantLibraryEditorState> } = {}) {
  useAssistantLibraryStore.setState({
    ...initialAssistantLibrarySnapshot,
    busy: options.busy ?? false,
    editor: editorState(options.editor),
    open: true,
    task: "editor"
  });
}
