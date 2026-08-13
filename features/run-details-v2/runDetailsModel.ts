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

// Raw adapter/config ids (`openai_compatible`) and prettified raw model ids
// are dev leaks in ordinary UI; unresolvable historical bindings fall back to
// neutral copy instead (RUN_CONTROLS.md: display names or neutral copy).
function resolveProviderLabel(run: PersistedRun, catalog: Catalog | null): string {
  const provider = catalog?.providers?.find((candidate) => candidate.id === run.provider);
  if (provider) return provider.name;
  const fallback = providerDisplayName(run.provider);
  return fallback === run.provider ? "Provider unavailable" : fallback;
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
  return "Model unavailable";
}

function acceptedAtLabel(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    timeZone: "UTC"
  }).format(date)} UTC`;
}

function statusLabel(status: PersistedRun["status"]): string {
  if (status === "complete") return "Complete";
  if (status === "cancelled") return "Stopped";
  if (status === "error") return "Error";
  if (status === "queued") return "Queued";
  if (status === "streaming") return "Streaming";
  return "Running";
}

function toolStatusLabel(status: PersistedRun["toolCalls"][number]["status"]): string {
  if (status === "complete") return "Complete";
  if (status === "cancelled") return "Stopped";
  if (status === "error") return "Error";
  return "Running";
}

function parameterLabel(name: string): string {
  if (name === "max_output_tokens") return "Max output tokens";
  if (name === "temperature") return "Temperature";
  if (name === "reasoning_effort") return "Reasoning effort";
  if (name === "reasoning_mode") return "Reasoning mode";
  if (name === "background") return "Background";
  return "Streaming";
}

function parameterValue(value: boolean | number | string): string {
  if (typeof value === "boolean") return value ? "On" : "Off";
  return String(value);
}

function memoryItemTypeLabel(value: MemoryReceiptItem["itemType"]): string {
  if (value === "FACT_VERSION") return "Saved fact";
  if (value === "RECALL_CHUNK") return "Previous-chat excerpt";
  if (value === "EPISODE") return "Previous-chat episode";
  return "Memory summary";
}

function memorySourceModeLabel(value: MemoryReceiptItem["sourceMode"]): string {
  if (value === "EXPLICIT") return "Saved explicitly";
  if (value === "AUTOMATIC") return "Learned automatically";
  if (value === "HISTORY") return "Chat history";
  return "Memory summary";
}

function memoryScopeLabel(value: MemoryReceiptItem["scopeType"]): string {
  if (value === "GLOBAL_USER") return "Your account";
  if (value === "CHAT") return "Chat";
  if (value === "FOLDER") return "Folder";
  if (value === "ASSISTANT") return "Assistant";
  return "No scope";
}

function memoryLifecycleLabel(value: MemoryReceiptItem["lifecycleState"]): string {
  if (value === "LATER_FORGOTTEN") return "Later forgotten";
  if (value === "SOURCE_DELETED") return "Source deleted";
  return "Current for this run";
}

function memoryOutcomeLabel(value: MemoryReceipt["outcome"]): string {
  if (value === "USED") return "Used";
  if (value === "DEGRADED") return "Used with safe degradation";
  if (value === "EMPTY") return "No matching memories";
  if (value === "DISABLED") return "Memory was off";
  return "Safely skipped";
}

function memoryActionLabel(value: MemoryActionFeedback["operation"]): string {
  if (value === "SAVE") return "Saved";
  if (value === "UPDATE") return "Updated";
  if (value === "FORGET") return "Forgotten";
  return "Marked incorrect";
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
    { label: "Provider", value: providerLabel },
    { label: "Model", value: modelLabel }
  ];
  if (run.assistant) {
    bindings.push({
      label: "Assistant",
      value: `${run.assistant.name} · revision ${run.assistant.revisionNumber}`
    });
  }
  if (inspection) {
    bindings.push({
      label: "Branch context",
      value: `${inspection.branchMessageCount} previous messages`
    });
    if (inspection.searchBindings.length > 0) {
      bindings.push({
        label: "Search",
        value: inspection.searchBindings.map((binding) => binding.displayName).join(" · ")
      });
    }
    if (inspection.knowledgeBaseCount > 0) {
      bindings.push({ label: "Knowledge", value: `${inspection.knowledgeBaseCount} ${inspection.knowledgeBaseCount === 1 ? "base" : "bases"}` });
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
        label: "Memory",
        value: `${inspection.memoryContextItemCount} frozen items`
      });
    }
    if (inspection.attachmentCount > 0) {
      bindings.push({
        label: "Input files",
        value: `${inspection.attachmentCount} · private`
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
        if (source === "personal") return "personal credential";
        if (source === "shared") return "shared credential";
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
