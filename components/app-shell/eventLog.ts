import { providerDisplayName } from "./providerDisplay";
import { isRecord } from "./shellValues";

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

function artifactDetail(type: string, payload: unknown): string {
  if (!isRecord(payload)) {
    return compactJson(payload);
  }

  if (type === "summary") {
    const problem = payloadProblem(payload);
    return [
      stringField(payload, "provider"),
      stringField(payload, "model"),
      stringField(payload, "stage"),
      stringField(payload, "status"),
      stringField(payload, "reason"),
      typeof payload.attempt === "number" ? `attempt ${payload.attempt}` : null,
      stringField(payload, "searchStrategy"),
      stringField(payload, "source"),
      problem ? `error: ${problem}` : null
    ]
      .filter((part): part is string => Boolean(part))
      .join(" / ");
  }

  if (type === "citation") {
    return [stringField(payload, "title"), stringField(payload, "url")]
      .filter((part): part is string => Boolean(part))
      .join(" / ");
  }

  if (type === "search") {
    const citationCount = numberField(payload, "citationCount");
    return [
      stringField(payload, "provider"),
      stringField(payload, "strategy") ?? stringField(payload, "strategyId"),
      stringField(payload, "model"),
      stringField(payload, "status"),
      stringField(payload, "query") ? compactText(stringField(payload, "query")!) : null,
      stringField(payload, "url"),
      citationCount !== null ? `${citationCount} citation${citationCount === 1 ? "" : "s"}` : null,
      payloadProblem(payload)
    ]
      .filter((part): part is string => Boolean(part))
      .join(" / ");
  }

  if (type === "tool_call" || type === "tool_result") {
    const problem = payloadProblem(payload);
    return [
      stringField(payload, "name"),
      stringField(payload, "status"),
      typeof payload.round === "number" ? `round ${payload.round}` : null,
      problem
    ]
      .filter((part): part is string => Boolean(part))
      .join(" / ");
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

      return text ? compactText(text) : "no reasoning summary captured";
    }

    if (typeof payload.reasoning === "string" && payload.reasoning.trim()) {
      return compactText(payload.reasoning.trim());
    }

    if (typeof payload.delta === "string" && payload.delta.trim()) {
      return compactText(payload.delta.trim());
    }

    return "no reasoning summary captured";
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
    citation: "Citations",
    context_truncated: "Context window",
    reasoning: "Reasoning artifacts",
    search: "Search artifacts",
    summary: "Provider status",
    tool_call: "Tool calls",
    tool_result: "Tool results"
  };

  if (labels[type]) {
    return labels[type];
  }

  const words = type.replace(/[_-]+/g, " ").trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)} artifacts` : "Artifacts";
}

function artifactSummary(type: string, aggregate: ArtifactAggregate): InspectorEventSummary {
  if (type === "context_truncated" && isRecord(aggregate.latest)) {
    const droppedMessages = numberField(aggregate.latest, "droppedMessages") ?? 0;
    const droppedTokens = numberField(aggregate.latest, "approxDroppedTokens") ?? 0;

    return {
      detail: droppedTokens > 0 ? `~${droppedTokens} estimated tokens` : undefined,
      id: "artifact-context-truncated",
      label: "Context window",
      stage: "Q",
      tone: "warning",
      value: `dropped ${droppedMessages} message${droppedMessages === 1 ? "" : "s"}`
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
        ? `${aggregate.count} update${aggregate.count === 1 ? "" : "s"}`
        : `${aggregate.count}`
  };
}

function tokenSummary(count: number, characterCount: number): InspectorEventSummary {
  return {
    detail: `${characterCount} character${characterCount === 1 ? "" : "s"}`,
    id: "answer-text",
    label: "Answer text",
    stage: "A",
    tone: "default",
    value: `${count} chunk${count === 1 ? "" : "s"}`
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
      `input ${input}`,
      `cached ${cached}`,
      `cache write ${cacheWrite}`,
      `output ${output}`,
      `reasoning ${reasoning}`,
      `total ${total}`
    ].join(" / "),
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
      label: "Cancelled",
      stage,
      tone: "warning",
      value: "response stopped"
    };
  }

  if (status.includes("error") || status.includes("fail") || status.includes("incomplete")) {
    return {
      detail: eventDetail(event),
      id: `done-${index}`,
      label: "Run ended",
      stage,
      tone: "error",
      value: status
    };
  }

  return {
    detail: eventDetail(event),
    id: `done-${index}`,
    label: "Done",
    stage,
    tone: "success",
    value: status
  };
}

export function summarizeInspectorEvents(events: InspectorRunEvent[]): InspectorEventSummary[] {
  const summaries: InspectorEventSummary[] = [];
  const artifactGroups = new Map<string, ArtifactAggregate>();
  const unknownGroups = new Map<string, { count: number; summaryIndex: number }>();
  let tokenGroup: { characterCount: number; count: number; summaryIndex: number } | null = null;
  let usageGroup: { count: number; summaryIndex: number } | null = null;
  let currentStage = "Q";

  events.forEach((event, eventIndex) => {
    if (event.type === "run_start") {
      const detail = isRecord(event.data)
        ? [stringField(event.data, "provider"), stringField(event.data, "modelId")]
            .map((part, index) => (index === 0 && part ? providerDisplayName(part) : part))
            .filter((part): part is string => Boolean(part))
            .join(" / ")
        : "";
      summaries.push({
        detail: detail || undefined,
        id: `run-${eventIndex}`,
        label: "Run",
        stage: "Q",
        tone: "default",
        value: eventMessage(event) || "started"
      });
      currentStage = "Q";
      return;
    }

    if (event.type === "message_start") {
      summaries.push({
        id: `message-${eventIndex}`,
        label: "Assistant message",
        stage: "A",
        tone: "default",
        value: "created"
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
      const nextDetail = artifactDetail(type, payload);
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
