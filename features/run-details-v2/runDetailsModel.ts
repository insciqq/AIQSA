import { summarizeInspectorEvents } from "@/components/app-shell/eventLog";
import { providerDisplayName } from "@/components/app-shell/providerDisplay";
import { summarizeThreadArtifacts } from "@/components/app-shell/threadContent";
import type { Catalog } from "@/components/app-shell/types";
import type {
  MemoryActionFeedback,
  MemoryReceipt,
  MemoryReceiptItem
} from "@/lib/contracts/memory";
import type { PersistedRun } from "@/lib/contracts/runs";

export type RunDetailsTargetV2 = Readonly<{
  answerLabel: string;
  assistantMessageId: string;
  runId: string;
}>;

export type GeneratedFileRunFactV2 = Readonly<{
  format: string;
  name: string;
  status: "failed" | "ready";
  versionLabel: string;
}>;

export type RunDetailsProjectionV2 = Readonly<{
  acceptedAtLabel: string | null;
  bindings: readonly Readonly<{ label: string; value: string }>[];
  errorText: string | null;
  generatedFiles: readonly GeneratedFileRunFactV2[];
  knowledge: readonly Readonly<{
    baseNames: readonly string[];
    candidateCount: number;
    durationMs: number;
    includedCount: number;
    invocationOrdinal: number;
    outcomeLabel: string;
    query: string;
    results: readonly Readonly<{
      baseName: string;
      fileName: string;
      includedText: string;
      page: number;
      scoreLabel: string;
      truncated: boolean;
    }>[];
  }>[];
  memory: ReturnType<typeof projectMemoryDetails>;
  parameters: readonly Readonly<{ label: string; value: string }>[];
  providerLabel: string;
  modelLabel: string;
  requestPreview: string | null;
  searchAttempts: readonly Readonly<{
    displayName: string;
    query: string | null;
    sourceCount: number | null;
    status: string;
    warning: string | null;
  }>[];
  status: PersistedRun["status"];
  statusLabel: string;
  target: RunDetailsTargetV2;
  timeline: readonly Readonly<{
    detail: string | null;
    label: string;
    tone: "default" | "error" | "success" | "warning";
    value: string;
  }>[];
  tools: readonly Readonly<{
    argumentsPreview: string | null;
    credentialLabel: string | null;
    durationMs: number | null;
    errorMessage: string | null;
    resultPreview: string | null;
    round: number;
    serverName: string;
    status: string;
    toolName: string;
  }>[];
  usage: Readonly<{
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  }> | null;
}>;

const opaqueUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const secretKeyPattern = /(?:api[_-]?key|authorization|cookie|credential|password|secret|signature|(?:access|refresh|identity|id|bearer)[_-]?token)/iu;
const jwtPattern = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const providerKeyPattern = /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{10,}\b/gu;
const bearerPattern = /\bBearer\s+[^\s"']+/giu;
const secretAssignmentPattern = /\b(api[_-]?key|authorization|cookie|credential|password|secret|signature|(?:access|refresh|identity|id|bearer)[_-]?token)\s*([:=])\s*[^\s,;"']+/giu;

function boundedText(value: unknown, maxLength = 1_200): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function redactString(value: string, maxLength = 1_200): string {
  if (/-----BEGIN [A-Z ]+PRIVATE KEY-----/u.test(value)) return "‹redacted›";
  const redacted = value
    .replace(secretAssignmentPattern, "$1$2‹redacted›")
    .replace(bearerPattern, "Bearer ‹redacted›")
    .replace(jwtPattern, "‹redacted›")
    .replace(providerKeyPattern, "‹redacted›");
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 1)}…` : redacted;
}

function redactPreviewValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet()
): unknown {
  if (value === null || typeof value === "boolean" ||
    typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return redactString(value, 600);
  if (depth >= 5) return "‹nested value omitted›";
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redactPreviewValue(item, depth + 1, seen));
  }
  if (typeof value !== "object") return "‹unsupported value›";
  if (seen.has(value)) return "‹circular value omitted›";
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value).slice(0, 40)) {
    output[key] = secretKeyPattern.test(key)
      ? "‹redacted›"
      : redactPreviewValue(nested, depth + 1, seen);
  }
  return output;
}

export function safeRunPreviewJson(value: unknown, maxLength = 2_400): string | null {
  try {
    const serialized = JSON.stringify(redactPreviewValue(value), null, 2);
    if (!serialized) return null;
    return serialized.length > maxLength
      ? `${serialized.slice(0, maxLength - 2)}\n…`
      : serialized;
  } catch {
    return null;
  }
}

function readableIdentifier(value: string): string {
  return value.replace(/[_-]+/gu, " ").trim().split(/\s+/u).filter(Boolean)
    .map((word, index) => index === 0
      ? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`
      : word)
    .join(" ");
}

function safeHistoricalLabel(value: string, fallback: string): string {
  return opaqueUuidPattern.test(value) || value.length > 100 || /[^\p{L}\p{N}._:/+ -]/u.test(value)
    ? fallback
    : readableIdentifier(value);
}

function resolveProviderLabel(run: PersistedRun, catalog: Catalog | null): string {
  const provider = catalog?.providers?.find((candidate) => candidate.id === run.provider);
  if (provider) return provider.name;
  const fallback = providerDisplayName(run.provider);
  return fallback === run.provider
    ? safeHistoricalLabel(run.provider, "Провайдер недоступен")
    : fallback;
}

function resolveModelLabel(run: PersistedRun, catalog: Catalog | null): string {
  const exact = catalog?.models?.find((candidate) =>
    candidate.modelId === run.modelId &&
    (candidate.provider === run.provider || candidate.providerFamily === run.provider)
  );
  if (exact) return exact.displayName;
  const uniqueMatches = catalog?.models?.filter((candidate) =>
    candidate.modelId === run.modelId || candidate.upstreamModelId === run.modelId
  ) ?? [];
  const names = new Set(uniqueMatches.map((candidate) => candidate.displayName));
  if (names.size === 1) return uniqueMatches[0]!.displayName;
  return safeHistoricalLabel(run.modelId, "Модель недоступна");
}

function acceptedAtLabel(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "UTC"
  }).format(date)} UTC`;
}

function statusLabel(status: PersistedRun["status"]): string {
  if (status === "complete") return "Завершён";
  if (status === "cancelled") return "Остановлен";
  if (status === "error") return "Ошибка";
  if (status === "queued") return "В очереди";
  if (status === "streaming") return "Стриминг";
  return "Выполняется";
}

function toolStatusLabel(status: PersistedRun["toolCalls"][number]["status"]): string {
  if (status === "complete") return "Завершён";
  if (status === "cancelled") return "Остановлен";
  if (status === "error") return "Ошибка";
  return "Выполняется";
}

function parameterLabel(name: string): string {
  if (name === "max_output_tokens") return "Максимум output-токенов";
  if (name === "temperature") return "Temperature";
  if (name === "reasoning_effort") return "Reasoning effort";
  if (name === "reasoning_mode") return "Reasoning mode";
  if (name === "background") return "Background";
  return "Streaming";
}

function parameterValue(value: boolean | number | string): string {
  if (typeof value === "boolean") return value ? "Включено" : "Выключено";
  return String(value);
}

function memoryItemTypeLabel(value: MemoryReceiptItem["itemType"]): string {
  if (value === "FACT_VERSION") return "Сохранённый факт";
  if (value === "RECALL_CHUNK") return "Фрагмент истории";
  if (value === "EPISODE") return "Исторический эпизод";
  return "Профиль";
}

function memorySourceModeLabel(value: MemoryReceiptItem["sourceMode"]): string {
  if (value === "EXPLICIT") return "Сохранено явно";
  if (value === "AUTOMATIC") return "Извлечено автоматически";
  if (value === "HISTORY") return "История чатов";
  return "Профиль";
}

function memoryScopeLabel(value: MemoryReceiptItem["scopeType"]): string {
  if (value === "GLOBAL_USER") return "Учётная запись";
  if (value === "CHAT") return "Чат";
  if (value === "FOLDER") return "Папка";
  if (value === "ASSISTANT") return "Ассистент";
  return "Без области";
}

function memoryLifecycleLabel(value: MemoryReceiptItem["lifecycleState"]): string {
  if (value === "LATER_FORGOTTEN") return "Позже забыто";
  if (value === "SOURCE_DELETED") return "Источник удалён";
  return "Актуально для этого run";
}

function memoryOutcomeLabel(value: MemoryReceipt["outcome"]): string {
  if (value === "USED") return "Использована";
  if (value === "DEGRADED") return "Использована с ограничениями";
  if (value === "EMPTY") return "Подходящих воспоминаний не было";
  if (value === "DISABLED") return "Была выключена";
  return "Безопасно пропущена";
}

function memoryActionLabel(value: MemoryActionFeedback["operation"]): string {
  if (value === "SAVE") return "Сохранено";
  if (value === "UPDATE") return "Обновлено";
  if (value === "FORGET") return "Забыто";
  return "Отмечено как неверное";
}

function projectMemoryDetails(
  receipt: MemoryReceipt | undefined,
  action: MemoryActionFeedback | undefined
) {
  if (!receipt && !action) return null;
  return {
    action: action ? {
      label: memoryActionLabel(action.operation),
      statement: boundedText(action.statement, 4_000)
    } : null,
    degradation: receipt?.degradationCode
      ? readableIdentifier(receipt.degradationCode)
      : null,
    items: receipt?.items.map((item) => ({
      includedText: item.includedText,
      itemType: memoryItemTypeLabel(item.itemType),
      lifecycle: memoryLifecycleLabel(item.lifecycleState),
      scope: memoryScopeLabel(item.scopeType),
      selectionReason: readableIdentifier(item.selectionReason),
      sourceChatId: item.lifecycleState === "SOURCE_DELETED" ? null : item.sourceChatId,
      sourceMessageCount: item.sourceMessageIds.length,
      sourceMode: memorySourceModeLabel(item.sourceMode)
    })) ?? [],
    outcome: receipt ? memoryOutcomeLabel(receipt.outcome) : null
  };
}

function requestPreview(
  run: PersistedRun,
  modelLabel: string
): string | null {
  const inspection = run.inspection;
  if (!inspection) return null;
  const parameters = Object.fromEntries(
    inspection.parameters.map((parameter) => [parameter.name, parameter.value])
  );
  const mcpTools = inspection.mcpServers.flatMap((server) =>
    server.toolNames.map((toolName) => `${server.name}.${toolName}`)
  );
  return safeRunPreviewJson({
    attachments: inspection.attachmentCount > 0 ? ["‹private›"] : [],
    knowledge: inspection.knowledgeBaseCount > 0
      ? `${inspection.knowledgeBaseCount} accepted`
      : "off",
    memory: inspection.memoryContextItemCount > 0
      ? `${inspection.memoryContextItemCount} frozen items`
      : "none",
    messages: ["‹redacted›"],
    model: modelLabel,
    parameters,
    search: inspection.searchBindings.map((binding) => binding.displayName),
    tools: [...inspection.firstPartyTools, ...mcpTools]
  });
}

function errorText(errorPayload: unknown): string | null {
  if (typeof errorPayload === "string") return redactString(errorPayload);
  if (!errorPayload || typeof errorPayload !== "object" || Array.isArray(errorPayload)) return null;
  const record = errorPayload as Record<string, unknown>;
  const message = boundedText(record.message) ?? boundedText(record.detail) ?? boundedText(record.code);
  return message ? redactString(message) : null;
}

export function runMatchesTargetV2(run: PersistedRun, target: RunDetailsTargetV2): boolean {
  return run.id === target.runId &&
    (!run.inspection?.answerMessageId ||
      run.inspection.answerMessageId === target.assistantMessageId);
}

export function projectRunDetailsV2(input: Readonly<{
  catalog: Catalog | null;
  generatedFiles?: readonly GeneratedFileRunFactV2[];
  run: PersistedRun;
  target: RunDetailsTargetV2;
}>): RunDetailsProjectionV2 | null {
  const { catalog, run, target } = input;
  if (!runMatchesTargetV2(run, target)) return null;
  const providerLabel = resolveProviderLabel(run, catalog);
  const modelLabel = resolveModelLabel(run, catalog);
  const inspection = run.inspection;
  const artifactSummary = summarizeThreadArtifacts(
    run.events.map((event) => ({ data: event.payload, type: event.eventType })),
    run.searchRuns,
    run.toolCalls,
    run.status
  );
  const parameters = inspection?.parameters.map((parameter) => ({
    label: parameterLabel(parameter.name),
    value: parameterValue(parameter.value)
  })) ?? [];
  const bindings: { label: string; value: string }[] = [
    { label: "Провайдер", value: providerLabel },
    { label: "Модель", value: modelLabel }
  ];
  if (run.assistant) {
    bindings.push({
      label: "Ассистент",
      value: `${run.assistant.name} · ревизия ${run.assistant.revisionNumber}`
    });
  }
  if (inspection) {
    bindings.push({
      label: "Контекст ветви",
      value: `${inspection.branchMessageCount} предыдущих сообщений`
    });
    if (inspection.searchBindings.length > 0) {
      bindings.push({
        label: "Search",
        value: inspection.searchBindings.map((binding) => binding.displayName).join(" · ")
      });
    }
    if (inspection.knowledgeBaseCount > 0) {
      bindings.push({ label: "Knowledge", value: `${inspection.knowledgeBaseCount} баз` });
    }
    if (inspection.mcpServers.length > 0) {
      bindings.push({
        label: "MCP",
        value: inspection.mcpServers.map((server) => server.externalAccountLabel
          ? `${server.name} · ${server.externalAccountLabel}`
          : server.name).join(" · ")
      });
    }
    if (inspection.memoryContextItemCount > 0) {
      bindings.push({
        label: "Память",
        value: `${inspection.memoryContextItemCount} frozen items`
      });
    }
    if (inspection.attachmentCount > 0) {
      bindings.push({
        label: "Входные файлы",
        value: `${inspection.attachmentCount} · приватные`
      });
    }
  }
  const events = [...run.events]
    .sort((left, right) => left.sequence - right.sequence)
    .map((event) => ({ data: event.payload, type: event.eventType }));
  const timeline = summarizeInspectorEvents(events, catalog).map((item) => ({
    detail: item.detail ? redactString(item.detail, 1_600) : null,
    label: item.label,
    tone: item.tone,
    value: redactString(item.value, 1_200)
  }));
  const tools = run.toolCalls.filter((call) => call.capability === "mcp").map((call) => ({
    argumentsPreview: safeRunPreviewJson(call.argumentsPreview),
    credentialLabel: [
      call.externalAccountLabel,
      ...call.credentialSources.map((source) => {
        if (source === "personal") return "личный credential";
        if (source === "shared") return "общий credential";
        return "OAuth";
      })
    ].filter((value): value is string => Boolean(value)).join(" · ") || null,
    durationMs: call.durationMs,
    errorMessage: call.errorMessage ? redactString(call.errorMessage) : null,
    resultPreview: safeRunPreviewJson(call.resultPreview),
    round: call.round,
    serverName: call.serverName ?? "MCP server",
    status: toolStatusLabel(call.status),
    toolName: call.toolName
  }));
  const searchAttempts = (artifactSummary?.searchActivity ?? []).map((activity) => ({
    displayName: activity.displayName,
    query: boundedText(activity.query, 2_000),
    sourceCount: activity.sourceCount,
    status: activity.status,
    warning: boundedText(activity.failureReason)
  }));
  const knowledge = (run.knowledgeRuns ?? []).map((receipt) => ({
    baseNames: [...new Set(receipt.baseEvidence.map((base) => base.baseName))],
    candidateCount: receipt.candidateCount,
    durationMs: receipt.durationMs,
    includedCount: receipt.results.length,
    invocationOrdinal: receipt.invocationOrdinal,
    outcomeLabel: receipt.outcome === "complete"
      ? "Evidence retrieved"
      : receipt.outcome === "zero_above_threshold"
        ? "No passage above threshold"
        : receipt.outcome === "base_empty"
          ? "Selected base is empty"
          : receipt.outcome === "base_indexing"
            ? "Selected base is indexing"
            : "Embedding model unavailable",
    query: redactString(receipt.query, 2_000),
    results: receipt.results.map((result) => ({
      baseName: result.baseName,
      fileName: result.fileName,
      includedText: redactString(result.includedText, 4_000),
      page: result.page,
      scoreLabel: result.fusedScore.toFixed(3),
      truncated: result.textTruncated || result.includedText.length > 4_000
    }))
  }));
  const hasUsage = run.inputTokens > 0 || run.outputTokens > 0 ||
    run.reasoningTokens > 0 || run.cachedInputTokens > 0 ||
    run.cacheWriteInputTokens > 0 || run.totalTokens > 0;
  return {
    acceptedAtLabel: acceptedAtLabel(inspection?.acceptedAt),
    bindings,
    errorText: errorText(run.errorPayload),
    generatedFiles: input.generatedFiles ?? [],
    knowledge,
    memory: projectMemoryDetails(run.memoryReceipt, run.memoryAction),
    modelLabel,
    parameters,
    providerLabel,
    requestPreview: requestPreview(run, modelLabel),
    searchAttempts,
    status: run.status,
    statusLabel: statusLabel(run.status),
    target,
    timeline,
    tools,
    usage: hasUsage ? {
      cachedInputTokens: run.cachedInputTokens,
      cacheWriteInputTokens: run.cacheWriteInputTokens,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      reasoningTokens: run.reasoningTokens,
      totalTokens: run.totalTokens
    } : null
  };
}
