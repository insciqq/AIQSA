import { decodeGroundingDisplay } from "../../lib/domain/groundingDisplay";
import { isRecord } from "@/components/app-shell/shellValues";
import type {
  RunEventView,
  ThreadArtifactSummary,
  ThreadCitation
} from "@/components/app-shell/types";
import { safeExternalHref } from "@/lib/domain/links";
import { projectThreadSearchSources } from "@/lib/domain/searchSources";

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
  if (typeof value === "string") return value.trim().slice(0, 1200);
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
  if (typeof value === "string") return value.trim() || null;
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
    if (key in value) return reasoningTextFromValue(value[key]);
  }
  if (Object.keys(value).length === 0) return null;
  const text = safeSnippet(value);
  return text || null;
}

function citationFromValue(value: unknown, fallbackIndex: number): ThreadCitation | null {
  if (typeof value === "string" && value.trim()) {
    const url = safeExternalHref(value);
    return url
      ? { index: fallbackIndex, title: `Source ${fallbackIndex}`, url }
      : null;
  }
  if (!isRecord(value)) return null;
  const url = safeExternalHref(optionalString(value.url) ?? optionalString(value.href));
  if (!url) return null;
  const index = typeof value.index === "number" && Number.isSafeInteger(value.index) &&
    value.index >= 0
    ? value.index
    : fallbackIndex;
  const snippet = optionalString(value.snippet);
  const source = optionalString(value.source);
  return {
    index,
    ...(snippet ? { snippet } : {}),
    ...(source ? { source } : {}),
    title: optionalString(value.title) ?? `Source ${index}`,
    url
  };
}

function groundingDisplayFromEvent(event: RunEventView): {
  citations: ThreadCitation[];
  display: NonNullable<ThreadArtifactSummary["groundingDisplay"]>;
} | null {
  if (event.type !== "grounding_display" || !isRecord(event.data)) return null;
  const data = decodeGroundingDisplay(event.data);
  if (!data) return null;
  const citations = (Array.isArray(data.citations) ? data.citations : [])
    .slice(0, 100)
    .map((citation, index) => citationFromValue(citation, index + 1))
    .filter((citation): citation is ThreadCitation => Boolean(citation));
  return {
    citations,
    display: {
      provider: "gemini",
      suggestionsHtml: data.suggestionsHtml
    }
  };
}

function sourceValuesFromSearchEvent(event: RunEventView): unknown[] {
  const payload = artifactPayload(event);
  if (!isRecord(payload)) return [];
  const action = isRecord(payload.action) ? payload.action : null;
  return Array.isArray(action?.sources) ? [action.sources] : [];
}

export function summarizeThreadArtifacts(
  events: RunEventView[]
): ThreadArtifactSummary | null {
  const grounding = events
    .map(groundingDisplayFromEvent)
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .at(-1) ?? null;
  const reasoningText = events
    .filter((event) => artifactTypeFromEvent(event) === "reasoning")
    .map((event) => reasoningTextFromValue(artifactPayload(event)))
    .filter((text): text is string => Boolean(text));
  const citationEvents = events.filter(
    (event) => artifactTypeFromEvent(event) === "citation"
  );
  const citations = grounding?.citations ?? citationEvents
    .map((event, index) => citationFromValue(artifactPayload(event), index + 1))
    .filter((citation): citation is ThreadCitation => Boolean(citation));
  const searchEvents = events.filter(
    (event) => artifactTypeFromEvent(event) === "search"
  );
  const sources = projectThreadSearchSources([
    ...searchEvents.flatMap(sourceValuesFromSearchEvent),
    ...(grounding ? [grounding.citations] : [])
  ]);

  if (
    citations.length === 0 &&
    sources.length === 0 &&
    reasoningText.length === 0 &&
    !grounding
  ) {
    return null;
  }

  return {
    citations,
    groundingDisplay: grounding?.display ?? null,
    reasoningText,
    sources
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
