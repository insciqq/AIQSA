import type { Catalog } from "@/components/app-shell/types";
import type { MemoryReceipt } from "@/lib/contracts/memory";
import type { PersistedRun } from "@/lib/contracts/runs";
import { boundArtifactVersion } from "@/features/artifacts-v2/artifactModel";
import {
  readyDeckArtifact,
  readyReportArtifact
} from "@/features/artifacts-v2/fixtures";
import type {
  GeneratedFileRunFactV2,
  RunDetailsTargetV2
} from "./runDetailsModel";

export type RunDetailsFixtureState =
  | "closed"
  | "complete"
  | "empty"
  | "error"
  | "loading"
  | "memory"
  | "redacted";

export const runDetailsTargetFixture: RunDetailsTargetV2 = {
  answerLabel: "Answer “Квартальный отчёт”",
  assistantMessageId: "assistant-message-private-run-details",
  runId: "run-private-run-details"
};

export const runDetailsCatalogFixture = {
  models: [{
    displayName: "GPT-5.2",
    modelId: "gpt-5.2",
    provider: "openai-primary",
    providerFamily: "openai",
    upstreamModelId: "gpt-5.2"
  }],
  providers: [{
    family: "openai",
    id: "openai-primary",
    models: ["gpt-5.2"],
    name: "OpenAI · рабочий ключ"
  }],
  searchStrategies: []
} as unknown as Catalog;

const inspection: NonNullable<PersistedRun["inspection"]> = {
  acceptedAt: "2026-08-13T11:32:05.000Z",
  answerMessageId: runDetailsTargetFixture.assistantMessageId,
  attachmentCount: 2,
  branchMessageCount: 6,
  firstPartyTools: ["Memory actions", "Memory search"],
  knowledgeBaseCount: 1,
  mcpServers: [{
    externalAccountLabel: "Finance workspace",
    name: "office-compute",
    toolNames: ["create_workbook", "validate_xlsx"]
  }],
  memoryContextItemCount: 2,
  parameters: [
    { name: "max_output_tokens", value: 2_048 },
    { name: "temperature", value: 0.7 },
    { name: "stream", value: true },
    { name: "reasoning_effort", value: "medium" }
  ],
  searchBindings: [{ displayName: "Research Search" }],
  searchMode: "all_selected",
  toolMode: "auto"
};

const ordinaryMemoryReceipt: MemoryReceipt = {
  degradationCode: null,
  itemCount: 1,
  items: [{
    factId: "fact-private-quarterly-format",
    feedbackState: "AVAILABLE",
    includedText: "Пользователь предпочитает квартальные отчёты в XLSX с проверенными формулами.",
    itemType: "FACT_VERSION",
    lifecycleState: "CURRENT",
    ordinal: 0,
    runId: "run-private-run-details",
    runItemId: "run-item-private-quarterly-format",
    scopeType: "GLOBAL_USER",
    selectionReason: "core_tier",
    sourceChatId: null,
    sourceMessageIds: [],
    sourceMode: "AUTOMATIC",
    versionId: "version-private-quarterly-format"
  }],
  outcome: "USED",
  summary: "memory_receipt:used:1"
};

const lifecycleMemoryReceipt: MemoryReceipt = {
  degradationCode: "memory_vector_unavailable",
  itemCount: 4,
  items: [
    ordinaryMemoryReceipt.items[0]!,
    {
      includedText: "В удалённом исходном чате пользователь просил сравнивать кварталы в одной сводной таблице.",
      itemType: "RECALL_CHUNK",
      lifecycleState: "SOURCE_DELETED",
      ordinal: 1,
      scopeType: "CHAT",
      selectionReason: "history_vector_relevance",
      sourceChatId: null,
      sourceMessageIds: ["source-message-private-deleted"],
      sourceMode: "HISTORY",
      versionId: null
    },
    {
      includedText: "В доступном исходном чате пользователь подтвердил рубли как валюту отчёта.",
      itemType: "RECALL_CHUNK",
      lifecycleState: "CURRENT",
      ordinal: 2,
      scopeType: "CHAT",
      selectionReason: "history_lexical_relevance",
      sourceChatId: "source-chat-private-live",
      sourceMessageIds: ["source-message-private-1", "source-message-private-2"],
      sourceMode: "HISTORY",
      versionId: null
    },
    {
      factId: "fact-private-old-currency",
      includedText: "Ранее пользователь предпочитал показывать суммы в долларах.",
      itemType: "FACT_VERSION",
      lifecycleState: "LATER_FORGOTTEN",
      ordinal: 3,
      scopeType: "GLOBAL_USER",
      selectionReason: "relevance_selected",
      sourceChatId: null,
      sourceMessageIds: [],
      sourceMode: "EXPLICIT",
      versionId: "version-private-old-currency"
    }
  ],
  outcome: "DEGRADED",
  summary: "memory_receipt:degraded:4"
};

const commonEvents: PersistedRun["events"] = [
  {
    eventType: "run_start",
    payload: { modelId: "gpt-5.2", provider: "openai-primary", status: "streaming" },
    sequence: 0
  },
  {
    eventType: "artifact",
    payload: { artifactType: "summary", payload: { status: "queued" } },
    sequence: 1
  },
  {
    eventType: "artifact",
    payload: {
      artifactType: "search",
      payload: { status: "completed", strategyId: "research-search" }
    },
    sequence: 2
  },
  {
    eventType: "artifact",
    payload: {
      artifactType: "tool_call",
      payload: { name: "create_workbook", round: 1, status: "requested" }
    },
    sequence: 3
  },
  {
    eventType: "memory_retrieval",
    payload: { itemCount: 1, outcome: "USED", types: ["FACT_VERSION"] },
    sequence: 4
  },
  {
    eventType: "token",
    payload: { chunkCount: 12, delta: "private answer text never appears in timeline" },
    sequence: 5
  },
  {
    eventType: "usage",
    payload: { inputTokens: 4_312, outputTokens: 1_208, totalTokens: 5_712 },
    sequence: 6
  },
  {
    eventType: "done",
    payload: { status: "complete" },
    sequence: 7
  }
];

const searchCall: PersistedRun["toolCalls"][number] = {
  argumentsPreview: { query: "quarterly revenue benchmark" },
  callId: "tool-call-private-search",
  capability: "web_search",
  credentialSources: ["shared"],
  durationMs: 2_100,
  errorMessage: null,
  externalAccountLabel: null,
  ordinal: 0,
  resultPreview: { sourceCount: 6 },
  round: 1,
  searchExecutions: [{
    displayName: "Research Search",
    durationMs: 2_100,
    modelId: "search-model-private-id",
    optionId: "search-option-private-id",
    provider: "search-provider-private-id",
    providerOperations: [],
    providerOperationsTruncated: false,
    query: "quarterly revenue benchmark",
    sourceCount: 6,
    sources: [{
      rank: 1,
      title: "Quarterly reporting guide",
      url: "https://example.com/reporting"
    }],
    status: "complete",
    warning: null
  }],
  serverName: null,
  status: "complete",
  toolName: "search_selected_engines"
};

const mcpCall: PersistedRun["toolCalls"][number] = {
  argumentsPreview: {
    api_key: "sk-private-key-must-redact",
    attachment: "‹private›",
    rows: 12
  },
  callId: "tool-call-private-workbook",
  capability: "mcp",
  credentialSources: ["oauth"],
  durationMs: 3_200,
  errorMessage: null,
  externalAccountLabel: "Finance workspace",
  ordinal: 1,
  resultPreview: {
    authorization: "Bearer private-bearer-token",
    content: [{ text: "Workbook validated; result is untrusted until inspected.", type: "text" }]
  },
  round: 1,
  serverName: "office-compute",
  status: "complete",
  toolName: "create_workbook"
};

export const completeRunDetailsFixture: PersistedRun = {
  assistant: { assistantId: "assistant-private-id", name: "Finance Analyst", revisionNumber: 4 },
  cachedInputTokens: 320,
  cacheWriteInputTokens: 0,
  errorPayload: null,
  estimatedCostMicros: 9_100,
  events: commonEvents,
  id: runDetailsTargetFixture.runId,
  inputTokens: 4_312,
  inspection,
  knowledgeBindings: [],
  knowledgePlan: { baseIds: [] },
  knowledgeRuns: [{
    baseEvidence: [{
      baseContentRevision: 8,
      baseName: "Финансы 2026",
      candidateCount: 2,
      indexedContentRevision: 8,
      knowledgeBaseId: "knowledge-base-private-id",
      ordinal: 0,
      state: "ready"
    }],
    candidateCount: 2,
    candidateLimit: 40,
    createdAt: "2026-08-13T11:32:06.000Z",
    durationMs: 840,
    embeddingUsage: [{ inputTokens: 6, totalTokens: 6 }],
    failureCode: null,
    fusion: "rrf_k60",
    id: "knowledge-run-private-id",
    invocationOrdinal: 1,
    modelRunToolCallId: "knowledge-tool-call-private-id",
    outcome: "complete",
    postRerankOrder: null,
    preRerankOrder: null,
    providerText: "Use [K1.1].",
    query: "проверка квартальной выручки и маржи",
    rerankerBinding: null,
    resultLimit: 8,
    results: [{
      baseName: "Финансы 2026",
      bindingOrdinal: 0,
      documentVersionNumber: 3,
      fileName: "reporting-policy.pdf",
      fusedScore: 0.913,
      handle: "K1.1",
      includedText: "Квартальный отчёт должен содержать сводную выручку, маржу и проверку формул.",
      includedTextBytes: 154,
      knowledgeBaseId: "knowledge-base-private-id",
      page: 18,
      sourceTextBytes: 238,
      textTruncated: true
    }],
    threshold: 0.01
  }],
  memoryAction: {
    factId: "fact-private-quarterly-format",
    operation: "SAVE",
    statement: "Предпочитает квартальные отчёты в XLSX с проверенными формулами.",
    status: "COMMITTED",
    versionId: "version-private-quarterly-format"
  },
  memoryReceipt: ordinaryMemoryReceipt,
  modelId: "gpt-5.2",
  outputTokens: 1_208,
  provider: "openai-primary",
  reasoningTokens: 192,
  searchRuns: [],
  status: "complete",
  toolCalls: [searchCall, mcpCall],
  totalTokens: 5_712
};

export const memoryRunDetailsFixture: PersistedRun = {
  ...completeRunDetailsFixture,
  memoryAction: {
    factId: "fact-private-quarterly-format",
    operation: "UPDATE",
    statement: "Предпочитает отчёты в XLSX и суммы в рублях.",
    status: "COMMITTED",
    versionId: "version-private-quarterly-format-v2"
  },
  memoryReceipt: lifecycleMemoryReceipt
};

export const emptyRunDetailsFixture: PersistedRun = {
  ...completeRunDetailsFixture,
  assistant: null,
  cachedInputTokens: 0,
  errorPayload: null,
  estimatedCostMicros: 4_200,
  events: [],
  inputTokens: 0,
  inspection: {
    ...inspection,
    attachmentCount: 0,
    firstPartyTools: [],
    knowledgeBaseCount: 0,
    mcpServers: [],
    memoryContextItemCount: 0,
    parameters: [],
    searchBindings: []
  },
  knowledgeRuns: [],
  memoryAction: undefined,
  memoryReceipt: undefined,
  outputTokens: 0,
  reasoningTokens: 0,
  toolCalls: [],
  totalTokens: 0
};

export const redactedRunDetailsFixture: PersistedRun = {
  ...completeRunDetailsFixture,
  errorPayload: {
    authorization: "Bearer private-error-token",
    message: `Provider rejected password=private-password. ${"unbroken-detail-".repeat(90)}`
  },
  events: [
    ...commonEvents.slice(0, -1),
    {
      eventType: "error",
      payload: {
        code: "provider_bad_request",
        message: "Bearer private-event-token was rejected"
      },
      sequence: 7
    }
  ],
  status: "error"
};

function generatedFileFact(artifact: typeof readyReportArtifact | typeof readyDeckArtifact) {
  const version = boundArtifactVersion(artifact);
  if (!version) return null;
  return {
    format: version.format.toUpperCase(),
    name: artifact.name,
    status: "ready" as const,
    versionLabel: `v${version.number}`
  };
}

export const runDetailsGeneratedFileFacts = [
  readyReportArtifact,
  readyDeckArtifact
].flatMap((artifact) => {
  const fact = generatedFileFact(artifact);
  return fact ? [fact] : [];
}) satisfies readonly GeneratedFileRunFactV2[];

export function runDetailsFixtureForState(state: RunDetailsFixtureState): PersistedRun | null {
  if (state === "empty") return emptyRunDetailsFixture;
  if (state === "memory") return memoryRunDetailsFixture;
  if (state === "redacted") return redactedRunDetailsFixture;
  if (state === "error" || state === "loading") return null;
  return completeRunDetailsFixture;
}
