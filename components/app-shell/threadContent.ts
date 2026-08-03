import { isRecord, numberValue } from "@/components/app-shell/shellValues";
import type {
  RunEventView,
  ThreadArtifactSummary,
  ThreadCitation
} from "@/components/app-shell/types";
import { safeExternalHref } from "@/lib/domain/links";
import {
  projectClientSearchActivity,
  projectHostedSearchActivity
} from "@/lib/domain/searchDisclosure";
import {
  mergeThreadToolActivity,
  projectThreadToolActivity
} from "@/lib/domain/toolActivity";

function artifactTypeFromEvent(event: RunEventView): string | null {
  return event.type === "artifact" &&
    isRecord(event.data) &&
    typeof event.data.artifactType === "string"
    ? event.data.artifactType
    : null;
}

function artifactPayload(event: RunEventView): unknown {
  return isRecord(event.data) && "payload" in event.data ? event.data.payload : null;
}

function safeSnippet(value: unknown): string {
  if (typeof value === "string") {
    return value.trim().slice(0, 1200);
  }

  try {
    return JSON.stringify(value, null, 2).slice(0, 1200);
  } catch {
    return "";
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function reasoningTextFromValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map(reasoningTextFromValue)
      .filter((text): text is string => Boolean(text));
    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  if (!isRecord(value)) {
    const text = safeSnippet(value);
    return text || null;
  }

  for (const key of ["delta", "summary", "reasoning", "text"]) {
    if (key in value) {
      return reasoningTextFromValue(value[key]);
    }
  }

  if (Object.keys(value).length === 0) {
    return null;
  }

  const text = safeSnippet(value);
  return text || null;
}

function citationFromValue(value: unknown, fallbackIndex: number): ThreadCitation | null {
  if (typeof value === "string" && value.trim()) {
    const url = safeExternalHref(value);
    if (!url) {
      return null;
    }

    return {
      index: fallbackIndex,
      title: `Source ${fallbackIndex}`,
      url
    };
  }

  if (!isRecord(value)) {
    return null;
  }

  const url = safeExternalHref(optionalString(value.url) ?? optionalString(value.href));
  if (!url) {
    return null;
  }

  const index =
    typeof value.index === "number" && Number.isFinite(value.index)
      ? value.index
      : fallbackIndex;

  return {
    index,
    snippet: optionalString(value.snippet),
    source: optionalString(value.source),
    title: optionalString(value.title) ?? `Source ${index}`,
    url
  };
}

function groundingDisplayFromEvent(event: RunEventView): {
  citations: ThreadCitation[];
  display: NonNullable<ThreadArtifactSummary["groundingDisplay"]>;
} | null {
  if (event.type !== "grounding_display" || !isRecord(event.data)) {
    return null;
  }
  const data = event.data;
  if (
    data.provider !== "gemini" ||
    typeof data.suggestionsHtml !== "string" ||
    data.suggestionsHtml.length === 0 ||
    new TextEncoder().encode(data.suggestionsHtml).byteLength > 256 * 1_024 ||
    !isRecord(data.runSearch)
  ) {
    return null;
  }
  const callCount = numberValue(data.runSearch.callCount, 0);
  const queryCount = numberValue(data.runSearch.queryCount, 0);
  if (callCount < 1 || callCount > 100 || queryCount < 0 || queryCount > 100) {
    return null;
  }
  const citations = (Array.isArray(data.citations) ? data.citations : [])
    .slice(0, 100)
    .map((citation, index) => citationFromValue(citation, index + 1))
    .filter((citation): citation is ThreadCitation => Boolean(citation));
  return {
    citations,
    display: {
      callCount,
      provider: "gemini",
      queryCount,
      suggestionsHtml: data.suggestionsHtml
    }
  };
}

function reasoningSnippet(event: RunEventView): string | null {
  return reasoningTextFromValue(artifactPayload(event));
}

function searchStrategyFromPayloadValue(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (typeof payload.strategyId === "string") {
    return payload.strategyId;
  }

  return payload.type === "web_search_call" ? "openai-native-web-search" : null;
}

function searchStrategyFromEvent(event: RunEventView): string | null {
  if (isRecord(event.data) && typeof event.data.searchStrategy === "string") {
    return event.data.searchStrategy;
  }
  return searchStrategyFromPayloadValue(artifactPayload(event));
}

function searchDisplayNameFromEvent(event: RunEventView): string | null {
  return isRecord(event.data) && typeof event.data.searchDisplayName === "string" &&
    event.data.searchDisplayName.trim()
    ? event.data.searchDisplayName.trim()
    : null;
}

function searchRunsCount(searchRuns: unknown[] | undefined): number {
  return searchRuns?.length ?? 0;
}

function contextTruncationFromValue(
  value: unknown
): ThreadArtifactSummary["contextTruncation"] {
  if (!isRecord(value)) {
    return null;
  }

  const droppedMessages = numberValue(value.droppedMessages, 0);
  const approxDroppedTokens = numberValue(value.approxDroppedTokens, 0);

  return droppedMessages > 0
    ? {
        approxDroppedTokens,
        droppedMessages
      }
    : null;
}

export function summarizeThreadArtifacts(
  events: RunEventView[],
  searchRuns?: unknown[],
  durableToolCalls: ThreadArtifactSummary["toolCalls"] = [],
  runStatus?: string
): ThreadArtifactSummary | null {
  const grounding = events
    .map(groundingDisplayFromEvent)
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .at(-1) ?? null;
  const searchArtifacts = events.filter(
    (event) => artifactTypeFromEvent(event) === "search"
  );
  const reasoningEvents = events.filter(
    (event) => artifactTypeFromEvent(event) === "reasoning"
  );
  const citationEvents = events.filter(
    (event) => artifactTypeFromEvent(event) === "citation"
  );
  const contextTruncation =
    events
      .filter((event) => artifactTypeFromEvent(event) === "context_truncated")
      .map((event) => contextTruncationFromValue(artifactPayload(event)))
      .filter(
        (
          summary
        ): summary is NonNullable<ThreadArtifactSummary["contextTruncation"]> =>
          Boolean(summary)
      )
      .at(-1) ?? null;
  const citations = (grounding?.citations ?? citationEvents
    .map((event, index) => citationFromValue(artifactPayload(event), index + 1))
    .filter((citation): citation is ThreadCitation => Boolean(citation)));
  const citationCount = Math.max(citationEvents.length, citations.length);
  const observedSearchCount = Math.max(
    grounding?.display.callCount ?? 0,
    searchArtifacts.length,
    searchRunsCount(searchRuns)
  );
  const reasoningText = reasoningEvents
    .map(reasoningSnippet)
    .filter((text): text is string => Boolean(text));
  const reasoningCount =
    reasoningText.length > 0 ? reasoningText.length : reasoningEvents.length;
  const eventToolCalls = projectThreadToolActivity(
    events.filter((event) => event.type === "artifact").map((event) => event.data),
    runStatus
  );
  const toolCallsById = new Map(eventToolCalls.map((call) => [call.callId, call]));
  for (const call of durableToolCalls) {
    const eventCall = toolCallsById.get(call.callId);
    toolCallsById.set(
      call.callId,
      eventCall ? mergeThreadToolActivity(eventCall, call) : call
    );
  }
  const observedToolCalls = [...toolCallsById.values()].sort(
    (left, right) => left.round - right.round || left.ordinal - right.ordinal
  );
  const searchDisplayName =
    (grounding ? ["Google Search"] : searchArtifacts
      .map(searchDisplayNameFromEvent)
      .filter((displayName): displayName is string => Boolean(displayName)))
      .at(0) ?? null;
  const hostedSearchActivity = grounding
    ? null
    : projectHostedSearchActivity({
        displayName: searchDisplayName,
        payloads: searchArtifacts.map(artifactPayload),
        runStatus
      });
  const clientSearchActivity = projectClientSearchActivity({
    fallbackDisplayName: searchDisplayName ?? "Search source",
    searchRuns: searchRuns ?? [],
    toolCalls: observedToolCalls
  });
  const geminiSearchActivity = grounding
    ? [{
        displayName: "Google Search",
        providerOperations: null,
        providerOperationsTruncated: false,
        query: null,
        sourceCount: citations.length,
        sources: citations.map((citation, index) => ({
          rank: index + 1,
          ...(citation.snippet ? { snippet: citation.snippet } : {}),
          title: citation.title,
          url: citation.url
        })),
        status: "complete" as const
      }]
    : [];
  const searchActivity = [
    ...geminiSearchActivity,
    ...(hostedSearchActivity ? [hostedSearchActivity] : []),
    ...clientSearchActivity
  ].slice(0, 12);
  const searchCount = Math.max(observedSearchCount, searchActivity.length);
  const toolCalls = observedToolCalls.filter((call) => call.capability === "mcp");

  if (
    searchCount === 0 &&
    reasoningEvents.length === 0 &&
    citationCount === 0 &&
    !contextTruncation &&
    toolCalls.length === 0
  ) {
    return null;
  }

  return {
    citationCount,
    citations,
    contextTruncation,
    groundingDisplay: grounding?.display ?? null,
    reasoningCount,
    reasoningText,
    searchActivity,
    searchCount,
    searchDisplayName,
    searchStrategy:
      (grounding ? ["gemini-google-search"] : searchArtifacts
        .map(searchStrategyFromEvent)
        .filter((strategy): strategy is string => Boolean(strategy)))
        .at(0) ?? null,
    toolCallCount: toolCalls.length,
    toolCalls
  };
}

export function textFromPersistedContent(content: unknown): string {
  if (!isRecord(content) || !Array.isArray(content.blocks)) {
    return "";
  }

  return content.blocks
    .map((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? block.text
        : ""
    )
    .filter(Boolean)
    .join("\n");
}

export type ThreadAttachmentBlock = {
  attachmentId: string;
  label: string;
  type: "file" | "image";
};

export function textFromThreadContent(content: unknown): string {
  return typeof content === "string" ? content : textFromPersistedContent(content);
}

export function attachmentBlocksFromThreadContent(
  content: unknown
): ThreadAttachmentBlock[] {
  if (!isRecord(content) || !Array.isArray(content.blocks)) {
    return [];
  }

  return content.blocks
    .map((block): ThreadAttachmentBlock | null => {
      if (!isRecord(block) || typeof block.attachmentId !== "string") {
        return null;
      }

      if (block.type === "image") {
        return {
          attachmentId: block.attachmentId,
          label:
            typeof block.alt === "string" && block.alt.trim()
              ? block.alt
              : "Image attachment",
          type: "image"
        };
      }

      if (block.type === "file") {
        return {
          attachmentId: block.attachmentId,
          label:
            typeof block.fileName === "string" && block.fileName.trim()
              ? block.fileName
              : "File attachment",
          type: "file"
        };
      }

      return null;
    })
    .filter((block): block is ThreadAttachmentBlock => Boolean(block));
}
