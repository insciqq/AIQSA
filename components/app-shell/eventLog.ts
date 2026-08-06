import { providerDisplayName } from "./providerDisplay";
import { isRecord } from "./shellValues";
import type { Catalog } from "./types";

export type InspectorRunEvent = {
  data: unknown;
  type: string;
};

export type InspectorEventSummary = {
  detail?: string;
  id: string;
  label: string;
  stage: string;
  tone: "default" | "error" | "success" | "warning";
  value: string;
};

type InspectorEventTone = InspectorEventSummary["tone"];

type ArtifactAggregate = {
  count: number;
  detail: string;
  detailTone: InspectorEventTone;
  latest: unknown;
  stage: string;
  summaryIndex: number;
  tone: InspectorEventTone;
};

function stringField(value: unknown, field: string): string | null {
  if (!isRecord(value) || typeof value[field] !== "string") {
    return null;
  }

  const text = value[field].trim();
  return text || null;
}

function rawStringField(value: unknown, field: string): string | null {
  return isRecord(value) && typeof value[field] === "string" ? value[field] : null;
}

function numberField(value: unknown, field: string): number | null {
  if (!isRecord(value) || typeof value[field] !== "number" || !Number.isFinite(value[field])) {
    return null;
  }

  return value[field];
}

function jsonText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function compactText(value: string, maxLength = 180): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function compactJson(value: unknown, maxLength = 180): string {
  return compactText(jsonText(value), maxLength);
}

function fullDetail(value: unknown): string {
  return jsonText(value).trim();
}

const readableAcronyms: Readonly<Record<string, string>> = {
  api: "API",
  gpt: "GPT",
  http: "HTTP",
  https: "HTTPS",
  id: "ID",
  mcp: "MCP",
  qsa: "Run",
  sse: "SSE",
  url: "URL"
};

function readableIdentifier(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim().split(/\s+/).filter(Boolean);
  return words
    .map((word, index) => {
      const acronym = readableAcronyms[word.toLowerCase()];
      if (acronym) {
        return acronym;
      }

      return index === 0 ? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}` : word.toLowerCase();
    })
    .join(" ");
}

const opaqueUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function providerLabel(catalog: Catalog | null, provider: string): string {
  const providers = catalog?.providers ?? [];
  const exact = providers.find((candidate) => candidate.id === provider);
  if (exact) {
    return exact.name;
  }

  const familyMatches = providers.filter((candidate) => candidate.family === provider);
  if (familyMatches.length === 1) {
    return familyMatches[0]!.name;
  }

  const fallback = providerDisplayName(provider);
  return fallback === provider && opaqueUuidPattern.test(provider) ? "Unavailable" : fallback;
}

function sharedModelDisplayName(models: Catalog["models"]): string | null {
  if (models.length === 0) {
    return null;
  }

  const names = new Set(models.map((model) => model.displayName));
  return names.size === 1 ? models[0]!.displayName : null;
}

function modelDisplayName(catalog: Catalog | null, provider: string | null, modelId: string): string {
  const models = catalog?.models ?? [];
  const providerEntry = provider
    ? (catalog?.providers ?? []).find((candidate) => candidate.id === provider)
    : undefined;
  const identifierMatches = models.filter(
    (model) => model.modelId === modelId || model.upstreamModelId === modelId
  );
  const providerMatches = identifierMatches.filter((model) =>
    !provider ||
    model.provider === provider ||
    model.providerFamily === provider ||
    Boolean(providerEntry?.family && model.providerFamily === providerEntry.family)
  );
  const connectionMatches = provider
    ? identifierMatches.filter((model) => model.provider === provider)
    : [];
  const exactIdentifierMatches = identifierMatches.filter((model) => model.modelId === modelId);
  const exactProviderMatches = providerMatches.filter((model) => model.modelId === modelId);
  const exactConnectionMatches = connectionMatches.filter((model) => model.modelId === modelId);

  for (const candidates of [
    exactConnectionMatches,
    connectionMatches,
    exactProviderMatches,
    providerMatches,
    exactIdentifierMatches,
    identifierMatches
  ]) {
    const displayName = sharedModelDisplayName(candidates);
    if (displayName) {
      return displayName;
    }
  }

  const gptModel = /^gpt-(.+)$/i.exec(modelId);
  if (gptModel) {
    return `GPT-${gptModel[1]}`;
  }

  return opaqueUuidPattern.test(modelId) ? "Unavailable" : readableIdentifier(modelId);
}

function searchStrategyDisplayName(catalog: Catalog | null, strategyId: string): string {
  if (strategyId === "none" || strategyId === "search-disabled") {
    return "Off";
  }

  const catalogName = catalog?.searchStrategies.find(
    (strategy) => strategy.strategyId === strategyId
  )?.displayName;
  if (catalogName) return catalogName;
  if (strategyId === "openai-native-web-search" || strategyId === "openai-provider-web-search") {
    return "OpenAI Search";
  }
  if (strategyId === "perplexity-tool-search") return "Perplexity Search";
  if (strategyId === "gemini-google-search") return "Google Search";
  return "Search source";
}

function artifactType(event: InspectorRunEvent): string | null {
  return event.type === "artifact" && isRecord(event.data) && typeof event.data.artifactType === "string"
    ? event.data.artifactType
    : null;
}

function artifactPayload(event: InspectorRunEvent): unknown {
  return isRecord(event.data) && "payload" in event.data ? event.data.payload : event.data;
}

function nestedMessage(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  if (!isRecord(value)) {
    return null;
  }

  return stringField(value, "message") ?? stringField(value, "detail") ?? stringField(value, "code");
}

function payloadProblem(payload: Record<string, unknown>): string | null {
  const status = stringField(payload, "status")?.toLowerCase();
  const hasFailureStatus = Boolean(
    status &&
      (status.includes("error") ||
        status.includes("fail") ||
        status.includes("incomplete") ||
        status.includes("cancel"))
  );

  return nestedMessage(payload.error) ?? (hasFailureStatus ? stringField(payload, "message") : null);
}

function artifactDetail(type: string, payload: unknown, catalog: Catalog | null): string {
  if (!isRecord(payload)) {
    return compactJson(payload);
  }

  if (type === "summary") {
    const problem = payloadProblem(payload);
    const provider = stringField(payload, "provider");
    const model = stringField(payload, "model");
    const stage = stringField(payload, "stage");
    const status = stringField(payload, "status");
    const reason = stringField(payload, "reason");
    const searchStrategy = stringField(payload, "searchStrategy");
    const source = stringField(payload, "source");
    return [
      provider ? `Provider: ${providerLabel(catalog, provider)}` : null,
      model ? `Model: ${modelDisplayName(catalog, provider, model)}` : null,
      stage ? `Stage: ${readableIdentifier(stage)}` : null,
      status ? `Status: ${readableIdentifier(status)}` : null,
      reason ? `Reason: ${readableIdentifier(reason)}` : null,
      typeof payload.attempt === "number" ? `Attempt: ${payload.attempt}` : null,
      searchStrategy ? `Search: ${searchStrategyDisplayName(catalog, searchStrategy)}` : null,
      source ? `Source: ${readableIdentifier(source)}` : null,
      problem ? `Error: ${problem}` : null
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
  }

  if (type === "citation") {
    return [stringField(payload, "title"), stringField(payload, "url")]
      .filter((part): part is string => Boolean(part))
      .join(" / ");
  }

  if (type === "search") {
    const citationCount = numberField(payload, "citationCount");
    const provider = stringField(payload, "provider");
    const strategy = stringField(payload, "strategy") ?? stringField(payload, "strategyId");
    const model = stringField(payload, "model");
    const status = stringField(payload, "status");
    const query = stringField(payload, "query");
    const url = stringField(payload, "url");
    const problem = payloadProblem(payload);
    return [
      provider ? `Provider: ${providerLabel(catalog, provider)}` : null,
      strategy ? `Strategy: ${searchStrategyDisplayName(catalog, strategy)}` : null,
      model ? `Model: ${modelDisplayName(catalog, provider, model)}` : null,
      status ? `Status: ${readableIdentifier(status)}` : null,
      query ? `Query: ${compactText(query)}` : null,
      url ? `URL: ${url}` : null,
      citationCount !== null ? `Citations: ${citationCount}` : null,
      problem ? `Error: ${problem}` : null
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
  }

  if (type === "tool_call" || type === "tool_result") {
    const problem = payloadProblem(payload);
    const name = stringField(payload, "name");
    const status = stringField(payload, "status");
    return [
      name ? `Tool: ${name}` : null,
      status ? `Status: ${readableIdentifier(status)}` : null,
      typeof payload.round === "number" ? `Round: ${payload.round}` : null,
      problem ? `Error: ${problem}` : null
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
  }

  if (type === "reasoning") {
    const summary = payload.summary;
    if (typeof summary === "string" && summary.trim()) {
      return compactText(summary.trim());
    }

    if (Array.isArray(summary)) {
      const text = summary
        .map((item) =>
          isRecord(item) && typeof item.text === "string"
            ? item.text
            : typeof item === "string"
              ? item
              : ""
        )
        .filter(Boolean)
        .join(" / ")
        .trim();

      return text ? compactText(text) : "No reasoning summary was recorded.";
    }

    if (typeof payload.reasoning === "string" && payload.reasoning.trim()) {
      return compactText(payload.reasoning.trim());
    }

    if (typeof payload.delta === "string" && payload.delta.trim()) {
      return compactText(payload.delta.trim());
    }

    return "No reasoning summary was recorded.";
  }

  return stringField(payload, "message") ?? stringField(payload, "status") ?? compactJson(payload);
}

function eventMessage(event: InspectorRunEvent): string {
  if (typeof event.data === "string" && event.data.trim()) {
    return event.data;
  }

  if (!isRecord(event.data)) {
    return "";
  }

  return (
    stringField(event.data, "message") ??
    nestedMessage(event.data.error) ??
    stringField(event.data, "status") ??
    ""
  );
}

function eventDetail(event: InspectorRunEvent): string | undefined {
  if (!isRecord(event.data)) {
    return undefined;
  }

  const code = stringField(event.data, "code") ?? (isRecord(event.data.error) ? stringField(event.data.error, "code") : null);
  const detailValue = event.data.detail ?? event.data.details;
  const detail = detailValue === undefined ? "" : fullDetail(detailValue);
  const message = eventMessage(event);

  return [code, detail && detail !== message ? detail : null]
    .filter((part): part is string => Boolean(part))
    .join(" / ") || undefined;
}

export function inspectorEventErrorMessage(event: InspectorRunEvent): string {
  return eventMessage(event) || "Request failed";
}

function tonePriority(tone: InspectorEventTone): number {
  if (tone === "error") {
    return 3;
  }

  if (tone === "warning") {
    return 2;
  }

  return 1;
}

function strongerTone(current: InspectorEventTone, next: InspectorEventTone): InspectorEventTone {
  return tonePriority(next) >= tonePriority(current) ? next : current;
}

function artifactTone(type: string, payload: unknown): InspectorEventTone {
  if (type === "context_truncated") {
    return "warning";
  }

  if (!isRecord(payload)) {
    return "default";
  }

  if (payload.error !== undefined) {
    return "error";
  }

  const status = stringField(payload, "status")?.toLowerCase() ?? "";
  if (status.includes("error") || status.includes("fail") || status.includes("incomplete")) {
    return "error";
  }

  if (status.includes("cancel")) {
    return "warning";
  }

  if (
    status === "complete" ||
    status === "completed" ||
    status === "success" ||
    status === "succeeded"
  ) {
    return "success";
  }

  return "default";
}

function stageFromText(value: string | null): string | null {
  const normalized = value?.toLowerCase() ?? "";
  if (normalized.includes("tool")) {
    return "TOOL";
  }

  if (normalized.includes("search")) {
    return "S";
  }

  if (normalized.includes("answer") || normalized.includes("message") || normalized.includes("token")) {
    return "A";
  }

  if (normalized.includes("question") || normalized.includes("context") || normalized.includes("request")) {
    return "Q";
  }

  return null;
}

function artifactStage(type: string, payload: unknown): string {
  if (type === "tool_call" || type === "tool_result") {
    return "TOOL";
  }

  if (type === "search" || type === "citation") {
    return "S";
  }

  if (type === "reasoning") {
    return "A";
  }

  if (type === "context_truncated") {
    return "Q";
  }

  if (type === "summary" && isRecord(payload)) {
    return stageFromText(stringField(payload, "stage") ?? stringField(payload, "status")) ?? "RUN";
  }

  return "ART";
}

function artifactLabel(type: string): string {
  const labels: Record<string, string> = {
    citation: "Citations recorded",
    context_truncated: "Earlier context omitted",
    reasoning: "Reasoning recorded",
    search: "Search evidence",
    summary: "Provider updates",
    tool_call: "Tool calls",
    tool_result: "Tool results"
  };

  if (labels[type]) {
    return labels[type];
  }

  const words = type.replace(/[_-]+/g, " ").trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)} recorded` : "Evidence recorded";
}

function artifactSummary(type: string, aggregate: ArtifactAggregate): InspectorEventSummary {
  if (type === "context_truncated" && isRecord(aggregate.latest)) {
    const droppedMessages = numberField(aggregate.latest, "droppedMessages") ?? 0;
    const droppedTokens = numberField(aggregate.latest, "approxDroppedTokens") ?? 0;

    return {
      detail: droppedTokens > 0 ? `About ${droppedTokens} estimated tokens omitted` : undefined,
      id: "artifact-context-truncated",
      label: "Earlier context omitted",
      stage: "Q",
      tone: "warning",
      value: `${droppedMessages} earlier message${droppedMessages === 1 ? "" : "s"} omitted`
    };
  }

  return {
    detail: aggregate.detail || undefined,
    id: `artifact-${type}`,
    label: artifactLabel(type),
    stage: aggregate.stage,
    tone: aggregate.tone,
    value:
      type === "summary"
        ? `${aggregate.count} recorded update${aggregate.count === 1 ? "" : "s"}`
        : type === "citation"
          ? `${aggregate.count} citation${aggregate.count === 1 ? "" : "s"}`
          : type === "tool_call"
            ? `${aggregate.count} call${aggregate.count === 1 ? "" : "s"}`
            : type === "tool_result"
              ? `${aggregate.count} result${aggregate.count === 1 ? "" : "s"}`
              : `${aggregate.count} recorded item${aggregate.count === 1 ? "" : "s"}`
  };
}

function tokenSummary(count: number, characterCount: number): InspectorEventSummary {
  return {
    detail: `${characterCount} character${characterCount === 1 ? "" : "s"} received`,
    id: "answer-text",
    label: "Answer text",
    stage: "A",
    tone: "default",
    value: `${count} text update${count === 1 ? "" : "s"}`
  };
}

function usageSummary(data: Record<string, unknown>, count: number): InspectorEventSummary {
  const input = numberField(data, "inputTokens") ?? 0;
  const cached = numberField(data, "cachedInputTokens") ?? 0;
  const cacheWrite = numberField(data, "cacheWriteInputTokens") ?? 0;
  const output = numberField(data, "outputTokens") ?? 0;
  const reasoning = numberField(data, "reasoningTokens") ?? 0;
  const total = numberField(data, "totalTokens") ?? input + output;

  return {
    detail: [
      `Input: ${input}`,
      `Cached: ${cached}`,
      `Cache write: ${cacheWrite}`,
      `Output: ${output}`,
      `Reasoning: ${reasoning}`,
      `Total: ${total}`
    ].join(" · "),
    id: "usage",
    label: "Usage",
    stage: "API",
    tone: "default",
    value: count === 1 ? `${total} token${total === 1 ? "" : "s"}` : `${count} updates / ${total} tokens`
  };
}

function terminalSummary(event: InspectorRunEvent, index: number, stage: string): InspectorEventSummary {
  const status = (eventMessage(event) || "complete").toLowerCase();

  if (status.includes("cancel")) {
    return {
      detail: eventDetail(event),
      id: `done-${index}`,
      label: "Run stopped",
      stage,
      tone: "warning",
      value: "Response stopped"
    };
  }

  if (status.includes("error") || status.includes("fail") || status.includes("incomplete")) {
    return {
      detail: eventDetail(event),
      id: `done-${index}`,
      label: "Run ended with an error",
      stage,
      tone: "error",
      value: readableIdentifier(status)
    };
  }

  return {
    detail: eventDetail(event),
    id: `done-${index}`,
    label: "Run complete",
    stage,
    tone: "success",
    value: readableIdentifier(status)
  };
}

export function summarizeInspectorEvents(
  events: InspectorRunEvent[],
  catalog: Catalog | null = null
): InspectorEventSummary[] {
  const summaries: InspectorEventSummary[] = [];
  const artifactGroups = new Map<string, ArtifactAggregate>();
  const unknownGroups = new Map<string, { count: number; summaryIndex: number }>();
  let tokenGroup: { characterCount: number; count: number; summaryIndex: number } | null = null;
  let usageGroup: { count: number; summaryIndex: number } | null = null;
  let currentStage = "Q";

  events.forEach((event, eventIndex) => {
    if (event.type === "run_start") {
      const provider = stringField(event.data, "provider");
      const model = stringField(event.data, "modelId");
      const detail = [
        provider ? `Provider: ${providerLabel(catalog, provider)}` : null,
        model ? `Model: ${modelDisplayName(catalog, provider, model)}` : null
      ]
        .filter((part): part is string => Boolean(part))
        .join(" · ");
      summaries.push({
        detail: detail || undefined,
        id: `run-${eventIndex}`,
        label: "Run started",
        stage: "Q",
        tone: "default",
        value: readableIdentifier(eventMessage(event) || "Started")
      });
      currentStage = "Q";
      return;
    }

    if (event.type === "message_start") {
      summaries.push({
        id: `message-${eventIndex}`,
        label: "Answer created",
        stage: "A",
        tone: "default",
        value: "Ready for response text"
      });
      currentStage = "A";
      return;
    }

    if (event.type === "token") {
      const chunkCount = numberField(event.data, "chunkCount");
      const count = chunkCount !== null && chunkCount > 0 ? Math.floor(chunkCount) : 1;
      const delta = rawStringField(event.data, "delta") ?? "";
      const characterCount = numberField(event.data, "characterCount") ?? delta.length;
      currentStage = "A";

      if (!tokenGroup) {
        tokenGroup = {
          characterCount,
          count,
          summaryIndex: summaries.length
        };
        summaries.push(tokenSummary(tokenGroup.count, tokenGroup.characterCount));
      } else {
        tokenGroup.count += count;
        tokenGroup.characterCount += characterCount;
        summaries[tokenGroup.summaryIndex] = tokenSummary(tokenGroup.count, tokenGroup.characterCount);
      }
      return;
    }

    if (event.type === "artifact") {
      const type = artifactType(event) ?? "artifact";
      const payload = artifactPayload(event);
      const nextTone = artifactTone(type, payload);
      const nextDetail = artifactDetail(type, payload, catalog);
      const nextStage = artifactStage(type, payload);
      const current = artifactGroups.get(type);

      if (nextStage === "S" || nextStage === "TOOL" || nextStage === "A") {
        currentStage = nextStage;
      }

      if (!current) {
        const aggregate: ArtifactAggregate = {
          count: 1,
          detail: nextDetail,
          detailTone: nextTone,
          latest: payload,
          stage: nextStage,
          summaryIndex: summaries.length,
          tone: nextTone
        };
        artifactGroups.set(type, aggregate);
        summaries.push(artifactSummary(type, aggregate));
      } else {
        current.count += 1;
        current.latest = payload;
        current.stage = nextStage === "ART" || nextStage === "RUN" ? current.stage : nextStage;
        current.tone = strongerTone(current.tone, nextTone);
        if (!current.detail || tonePriority(nextTone) >= tonePriority(current.detailTone)) {
          current.detail = nextDetail;
          current.detailTone = nextTone;
        }
        summaries[current.summaryIndex] = artifactSummary(type, current);
      }
      return;
    }

    if (event.type === "usage" && isRecord(event.data)) {
      if (!usageGroup) {
        usageGroup = { count: 1, summaryIndex: summaries.length };
        summaries.push(usageSummary(event.data, usageGroup.count));
      } else {
        usageGroup.count += 1;
        summaries[usageGroup.summaryIndex] = usageSummary(event.data, usageGroup.count);
      }
      return;
    }

    if (event.type === "error") {
      summaries.push({
        detail: eventDetail(event),
        id: `error-${eventIndex}`,
        label: "Error",
        stage: currentStage,
        tone: "error",
        value: inspectorEventErrorMessage(event)
      });
      return;
    }

    if (event.type === "warning") {
      summaries.push({
        detail: eventDetail(event) ?? stringField(event.data, "eventType") ?? undefined,
        id: `warning-${eventIndex}`,
        label: "Warning",
        stage: stageFromText(stringField(event.data, "eventType")) ?? currentStage,
        tone: "warning",
        value: eventMessage(event) || "Check stream details"
      });
      return;
    }

    if (event.type === "done") {
      summaries.push(terminalSummary(event, eventIndex, currentStage));
      return;
    }

    if (event.type === "chat_update") {
      return;
    }

    const current = unknownGroups.get(event.type);
    if (!current) {
      const words = event.type.replace(/[_-]+/g, " ").trim() || "Run event";
      const summaryIndex = summaries.length;
      unknownGroups.set(event.type, { count: 1, summaryIndex });
      summaries.push({
        detail: eventMessage(event) ? compactText(eventMessage(event)) : undefined,
        id: `event-${event.type}`,
        label: `${words[0]!.toUpperCase()}${words.slice(1)}`,
        stage: currentStage,
        tone: "default",
        value: "recorded"
      });
    } else {
      current.count += 1;
      summaries[current.summaryIndex] = {
        ...summaries[current.summaryIndex]!,
        value: `${current.count} events`
      };
    }
  });

  return summaries;
}
