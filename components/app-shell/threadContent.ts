import { isRecord, numberValue } from "@/components/app-shell/shellValues";
import type {
  RunEventView,
  ThreadArtifactSummary,
  ThreadCitation
} from "@/components/app-shell/types";
import { safeExternalHref } from "@/lib/domain/links";
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
  return searchStrategyFromPayloadValue(artifactPayload(event));
}

function searchRunsCount(searchRuns: unknown[] | undefined): number {
  return (
    searchRuns?.filter(
      (searchRun) => !isRecord(searchRun) || searchRun.status === "complete"
    ).length ?? 0
  );
}

function responsePreviewFromSearchArtifacts(artifacts: unknown): unknown {
  return isRecord(artifacts) && "finalProviderResponsePreview" in artifacts
    ? artifacts.finalProviderResponsePreview
    : artifacts;
}

function searchDetailsFromRuns(
  searchRuns: unknown[] | undefined
): ThreadArtifactSummary["searchDetails"] {
  return (searchRuns ?? []).flatMap((searchRun) => {
    if (!isRecord(searchRun)) {
      return [];
    }

    return [
      {
        modelId: typeof searchRun.modelId === "string" ? searchRun.modelId : null,
        provider: typeof searchRun.provider === "string" ? searchRun.provider : null,
        requestPreview: searchRun.requestPreview,
        responsePreview: responsePreviewFromSearchArtifacts(searchRun.artifacts),
        status: typeof searchRun.status === "string" ? searchRun.status : null,
        strategyId:
          typeof searchRun.strategyId === "string" ? searchRun.strategyId : null
      }
    ];
  });
}

function searchDetailsFromArtifacts(
  searchArtifacts: RunEventView[]
): ThreadArtifactSummary["searchDetails"] {
  return searchArtifacts.flatMap((event) => {
    const payload = artifactPayload(event);
    if (!isRecord(payload)) {
      return [];
    }

    return [
      {
        callPreview: payload,
        status: typeof payload.status === "string" ? payload.status : null,
        strategyId: searchStrategyFromPayloadValue(payload)
      }
    ];
  });
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
  const citations = citationEvents
    .map((event, index) => citationFromValue(artifactPayload(event), index + 1))
    .filter((citation): citation is ThreadCitation => Boolean(citation));
  const citationCount = Math.max(citationEvents.length, citations.length);
  const searchCount = Math.max(searchArtifacts.length, searchRunsCount(searchRuns));
  const runSearchDetails = searchDetailsFromRuns(searchRuns) ?? [];
  const searchDetails =
    runSearchDetails.length > 0
      ? runSearchDetails
      : searchDetailsFromArtifacts(searchArtifacts);
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
  const toolCalls = [...toolCallsById.values()].sort(
    (left, right) => left.round - right.round || left.ordinal - right.ordinal
  );

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
    reasoningCount,
    reasoningText,
    searchCount,
    searchDetails,
    searchStrategy:
      searchArtifacts
        .map(searchStrategyFromEvent)
        .find((strategy): strategy is string => Boolean(strategy)) ?? null,
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
