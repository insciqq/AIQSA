import { decodeThreadSearchSource, type ThreadSearchSource } from "../../contracts/searchSources";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { safeExternalHref } from "../../domain/links";
import { projectThreadSearchSources } from "../../domain/searchSources";

const citationTitleLimit = 500;
const citationSnippetLimit = 2_000;
const citationSourceLimit = 200;
const citationUrlLimit = 2_048;
const reasoningTextLimit = 32_000;
const reasoningTraversalLimit = 200;

type RunOutputCitation = {
  index: number;
  snippet?: string;
  source?: string;
  title: string;
  url: string;
};

export type RunOutputArtifactEvent =
  | {
      data: {
        artifactType: "citation";
        payload: RunOutputCitation;
      };
      type: "artifact";
    }
  | {
      data: {
        artifactType: "reasoning";
        payload: { text: string };
      };
      type: "artifact";
    }
  | {
      data: {
        artifactType: "search";
        payload: { action: { sources: ThreadSearchSource[] } };
      };
      type: "artifact";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maximum)
    : null;
}

function citationUrl(value: unknown): string | null {
  const candidate = typeof value === "string" && value.trim().length <= citationUrlLimit
    ? value.trim()
    : null;
  return candidate ? safeExternalHref(candidate) : null;
}

function projectCitation(value: unknown): RunOutputCitation | null {
  if (typeof value === "string") {
    const url = citationUrl(value);
    return url ? { index: 1, title: "Source 1", url } : null;
  }
  if (!isRecord(value)) return null;
  const url = citationUrl(value.url) ?? citationUrl(value.href);
  if (!url) return null;
  const index = typeof value.index === "number" && Number.isSafeInteger(value.index) &&
    value.index >= 0
    ? value.index
    : 1;
  const snippet = boundedString(value.snippet, citationSnippetLimit);
  const source = boundedString(value.source, citationSourceLimit);
  return {
    index,
    ...(snippet ? { snippet } : {}),
    ...(source ? { source } : {}),
    title: boundedString(value.title, citationTitleLimit) ?? `Source ${index}`,
    url
  };
}

function projectReasoningText(value: unknown): string | null {
  let traversed = 0;

  function visit(candidate: unknown, depth: number): string[] {
    traversed += 1;
    if (traversed > reasoningTraversalLimit || depth > 12) return [];
    if (typeof candidate === "string") {
      const text = candidate.trim();
      return text ? [text] : [];
    }
    if (Array.isArray(candidate)) {
      const parts: string[] = [];
      for (const part of candidate) {
        if (traversed >= reasoningTraversalLimit) break;
        parts.push(...visit(part, depth + 1));
      }
      return parts;
    }
    if (!isRecord(candidate)) return [];
    for (const key of ["delta", "summary", "reasoning", "text", "content"] as const) {
      if (key in candidate) return visit(candidate[key], depth + 1);
    }
    return [];
  }

  const text = visit(value, 0).join("\n\n").trim();
  return text ? text.slice(0, reasoningTextLimit) : null;
}

function projectSearchSources(value: unknown): ThreadSearchSource[] {
  if (!isRecord(value)) return [];
  const action = isRecord(value.action) ? value.action : null;
  return action ? projectThreadSearchSources(action.sources) : [];
}

function isExactCitation(value: unknown): value is RunOutputCitation {
  if (!isRecord(value) ||
    !hasOnlyKeys(value, ["index", "snippet", "source", "title", "url"])) return false;
  const projected = projectCitation(value);
  return projected !== null &&
    projected.index === value.index &&
    projected.title === value.title &&
    projected.url === value.url &&
    projected.snippet === value.snippet &&
    projected.source === value.source;
}

function isExactSearchSource(value: unknown, expectedRank: number): value is ThreadSearchSource {
  if (!isRecord(value) || !hasOnlyKeys(value, ["date", "rank", "snippet", "title", "url"])) {
    return false;
  }
  const decoded = decodeThreadSearchSource(value);
  return decoded !== null &&
    decoded.rank === expectedRank &&
    decoded.date === value.date &&
    decoded.rank === value.rank &&
    decoded.snippet === value.snippet &&
    decoded.title === value.title &&
    decoded.url === value.url;
}

/**
 * Projects a live provider event into the exact, reloadable answer-output
 * shape allowed to cross the durable event boundary. Provider operation
 * identifiers, queries, status, request metadata, and wrapper fields stay
 * transient even when the live event also carries a safe output.
 */
export function projectRunOutputArtifactEvent(
  event: ModelRunSseEvent
): RunOutputArtifactEvent | null {
  if (event.type !== "artifact") return null;

  if (event.data.artifactType === "citation") {
    const payload = projectCitation(event.data.payload);
    return payload ? { data: { artifactType: "citation", payload }, type: "artifact" } : null;
  }

  if (event.data.artifactType === "reasoning") {
    const text = projectReasoningText(event.data.payload);
    return text
      ? { data: { artifactType: "reasoning", payload: { text } }, type: "artifact" }
      : null;
  }

  if (event.data.artifactType === "search") {
    const sources = projectSearchSources(event.data.payload);
    return sources.length > 0
      ? {
          data: {
            artifactType: "search",
            payload: { action: { sources } }
          },
          type: "artifact"
        }
      : null;
  }

  return null;
}

/** Validates an already-projected event at the repository boundary. */
export function isRunOutputArtifactEvent(
  event: ModelRunSseEvent
): event is RunOutputArtifactEvent {
  if (event.type !== "artifact" ||
    !hasOnlyKeys(event.data, ["artifactType", "payload"])) return false;

  if (event.data.artifactType === "citation") {
    return isExactCitation(event.data.payload);
  }
  if (event.data.artifactType === "reasoning") {
    return isRecord(event.data.payload) &&
      hasOnlyKeys(event.data.payload, ["text"]) &&
      typeof event.data.payload.text === "string" &&
      event.data.payload.text.length > 0 &&
      event.data.payload.text.length <= reasoningTextLimit &&
      event.data.payload.text.trim() === event.data.payload.text;
  }
  if (event.data.artifactType !== "search" || !isRecord(event.data.payload) ||
    !hasOnlyKeys(event.data.payload, ["action"]) ||
    !isRecord(event.data.payload.action) ||
    !hasOnlyKeys(event.data.payload.action, ["sources"]) ||
    !Array.isArray(event.data.payload.action.sources) ||
    event.data.payload.action.sources.length === 0 ||
    event.data.payload.action.sources.length > 20) return false;
  return event.data.payload.action.sources.every((source, index) =>
    isExactSearchSource(source, index + 1));
}

export function runOutputArtifactEvents(
  events: readonly ModelRunSseEvent[]
): RunOutputArtifactEvent[] {
  return events
    .map(projectRunOutputArtifactEvent)
    .filter((event): event is RunOutputArtifactEvent => event !== null);
}
