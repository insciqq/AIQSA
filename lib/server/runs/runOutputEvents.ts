import { decodeMemorySearchActivity, type MemorySearchActivitySnapshot } from "../../contracts/memorySearchActivity";
import { decodeGroundingDisplay, type GroundingDisplay } from "../../domain/groundingDisplay";
import { validateGeminiSearchSuggestionsHtml } from "../providers/geminiInteractionsGrounding";
import { decodeThreadSearchSource, type ThreadSearchSource } from "../../contracts/searchSources";
import {
  decodeThreadWorkspaceCheckpointOutput,
  type ThreadWorkspaceCheckpointOutput,
  decodeThreadWorkspaceActivityEntry,
  type ThreadWorkspaceActivityEntry
} from "../../contracts/workspace";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { projectThreadSearchSources, SEARCH_EVENT_SOURCE_LIMIT } from "../../domain/searchSources";
import { projectAnswerCitation } from "../../domain/answerCitations";
import { projectReasoningRecord, type ReasoningRecord } from "../../domain/answerReasoning";
import { decodeSessionContextStatus, type SessionContextStatus } from "../../contracts/sessionStatus";
import { decodeThreadGeneratedImage, type ThreadGeneratedImage } from "../../contracts/imageGeneration";
import { decodeThreadGeneratedArtifact, type ThreadCitation } from "../../contracts/chats";
import { decodeContextCompactionStatus, type ContextCompactionStatus } from "../../contracts/contextCompaction";
import { decodeThreadSearchActivitySnapshot, type ThreadSearchActivitySnapshot } from "../../contracts/searchActivity";

type RunOutputGeneratedArtifact = {
  byteSize?: number;
  artifactId: string;
  entrypoint: string | null;
  kind: "chart" | "game" | "html" | "image" | "slides" | "svg";
  title: string;
  versionId: string;
  versionNumber: number;
};

export type RunOutputArtifactEvent =
  | { type: "artifact"; data: { artifactType: "memory_search_activity"; payload: MemorySearchActivitySnapshot } }
  | { type: "artifact"; data: { artifactType: "workspace_checkpoint"; payload: ThreadWorkspaceCheckpointOutput } }
  | { type: "artifact"; data: { artifactType: "generated_artifact"; payload: RunOutputGeneratedArtifact } }
  | { type: "artifact"; data: { artifactType: "image"; payload: ThreadGeneratedImage } }
  | { type: "artifact"; data: { artifactType: "context_status"; payload: SessionContextStatus } }
  | { type: "artifact"; data: { artifactType: "context_compaction"; payload: ContextCompactionStatus } }
  | { type: "artifact"; data: { artifactType: "search_activity"; payload: ThreadSearchActivitySnapshot } }
  | { type: "grounding_display"; data: GroundingDisplay }
  | {
      data: {
        artifactType: "citation";
        payload: ThreadCitation;
      };
      type: "artifact";
    }
  | {
      data: {
        artifactType: "reasoning";
        payload: ReasoningRecord;
      };
      type: "artifact";
    }
  | {
      data: {
        artifactType: "search";
        payload: { action: { sources: ThreadSearchSource[] } };
      };
      type: "artifact";
    }
  | {
      data: {
        artifactType: "workspace_activity";
        payload: ThreadWorkspaceActivityEntry;
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

function projectSearchSources(value: unknown): ThreadSearchSource[] {
  if (!isRecord(value)) return [];
  const action = isRecord(value.action) ? value.action : null;
  return action ? projectThreadSearchSources(action.sources) : [];
}

function projectGeneratedArtifact(value: unknown): RunOutputGeneratedArtifact | null {
  const decoded = decodeThreadGeneratedArtifact(value);
  if (!decoded || decoded.artifactId.length > 128 || decoded.versionId.length > 128 ||
    decoded.title.length > 240 || decoded.versionNumber > 2_147_483_647 ||
    decoded.entrypoint !== null && decoded.entrypoint.length > 192) return null;
  return {
    ...(decoded.byteSize !== undefined ? { byteSize: decoded.byteSize } : {}),
    artifactId: decoded.artifactId,
    entrypoint: decoded.entrypoint,
    kind: decoded.kind,
    title: decoded.title,
    versionId: decoded.versionId,
    versionNumber: decoded.versionNumber
  };
}

function isExactCitation(value: unknown): value is ThreadCitation {
  if (!isRecord(value) ||
    !hasOnlyKeys(value, ["index", "snippet", "source", "title", "url"])) return false;
  const projected = projectAnswerCitation(value);
  return projected !== null &&
    projected.index === value.index &&
    projected.title === value.title &&
    projected.url === value.url &&
    projected.snippet === value.snippet &&
    projected.source === value.source;
}

/** Only the projection's own output: exact text, a known entry, `truncated` only as `true`. */
function isExactReasoningRecord(value: unknown): value is ReasoningRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, ["entry", "text", "truncated"])) return false;
  const projected = projectReasoningRecord(value);
  return projected !== null &&
    projected.entry === value.entry &&
    projected.text === value.text &&
    projected.truncated === value.truncated;
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

/** Positive output projection. Invalid or marker-only input has no display. */
export function projectGroundingDisplay(value: unknown): GroundingDisplay | null {
  const data = decodeGroundingDisplay(value);
  if (!data) return null;
  try {
    return { ...data, suggestionsHtml: validateGeminiSearchSuggestionsHtml(data.suggestionsHtml) };
  } catch {
    return null;
  }
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
  if (event.type === "grounding_display") {
    const data = projectGroundingDisplay(event.data);
    return data ? { type: "grounding_display", data } : null;
  }
  if (event.type !== "artifact") return null;

  if (event.data.artifactType === "image") {
    const payload = decodeThreadGeneratedImage(event.data.payload);
    return payload ? { type: "artifact", data: { artifactType: "image", payload } } : null;
  }

  if (event.data.artifactType === "generated_artifact") {
    const payload = projectGeneratedArtifact(event.data.payload);
    return payload ? { type: "artifact", data: { artifactType: "generated_artifact", payload } } : null;
  }

  if (event.data.artifactType === "citation") {
    const payload = projectAnswerCitation(event.data.payload);
    return payload ? { data: { artifactType: "citation", payload }, type: "artifact" } : null;
  }

  if (event.data.artifactType === "reasoning") {
    const payload = projectReasoningRecord(event.data.payload);
    return payload ? { data: { artifactType: "reasoning", payload }, type: "artifact" } : null;
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

  if (event.data.artifactType === "memory_search_activity") {
    const payload = decodeMemorySearchActivity(event.data.payload);
    return payload ? { type: "artifact", data: { artifactType: "memory_search_activity", payload } } : null;
  }

  if (event.data.artifactType === "search_activity") {
    const payload = decodeThreadSearchActivitySnapshot(event.data.payload);
    return payload ? { type: "artifact", data: { artifactType: "search_activity", payload } } : null;
  }

  if (event.data.artifactType === "workspace_checkpoint") {
    const payload = decodeThreadWorkspaceCheckpointOutput(event.data.payload);
    return payload ? { type: "artifact", data: { artifactType: "workspace_checkpoint", payload } } : null;
  }

  if (event.data.artifactType === "workspace_activity") {
    // Already a client-safe projection; the exact decoder is the only gate.
    const entry = decodeThreadWorkspaceActivityEntry(event.data.payload);
    return entry
      ? { data: { artifactType: "workspace_activity", payload: entry }, type: "artifact" }
      : null;
  }
  return null;
}

function isExactWorkspaceActivity(value: unknown): value is ThreadWorkspaceActivityEntry {
  const decoded = decodeThreadWorkspaceActivityEntry(value);
  return decoded !== null && JSON.stringify(decoded) === JSON.stringify(sortedKeys(value));
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortedKeys(value[key])])
  );
}

/** Validates an already-projected event at the repository boundary. */
export function isRunOutputArtifactEvent(
  event: ModelRunSseEvent
): event is RunOutputArtifactEvent {
  if (event.type === "grounding_display") {
    const data = projectGroundingDisplay(event.data);
    return data !== null && hasOnlyKeys(event.data, ["provider", "suggestionsHtml", "citations"]) &&
      data.suggestionsHtml === event.data.suggestionsHtml &&
      event.data.citations.every((citation, index) =>
        hasOnlyKeys(citation, ["startIndex", "endIndex", "title", "url"]) &&
        citation.title === data.citations[index]?.title &&
        citation.url === data.citations[index]?.url);
  }
  if (event.type !== "artifact" ||
    !hasOnlyKeys(event.data, ["artifactType", "payload"])) return false;

  if (event.data.artifactType === "generated_artifact") return isRecord(event.data.payload) &&
    hasOnlyKeys(event.data.payload, ["artifactId", "byteSize", "entrypoint", "kind", "title", "versionId", "versionNumber"]) &&
    projectGeneratedArtifact(event.data.payload) !== null;
  if (event.data.artifactType === "image") return decodeThreadGeneratedImage(event.data.payload) !== null;
  if (event.data.artifactType === "context_status") {
    return decodeSessionContextStatus(event.data.payload) !== null;
  }
  if (event.data.artifactType === "context_compaction") {
    return decodeContextCompactionStatus(event.data.payload) !== null;
  }

  if (event.data.artifactType === "citation") {
    return isExactCitation(event.data.payload);
  }
  if (event.data.artifactType === "reasoning") {
    return isExactReasoningRecord(event.data.payload);
  }
  if (event.data.artifactType === "workspace_checkpoint") {
    return decodeThreadWorkspaceCheckpointOutput(event.data.payload) !== null;
  }
  if (event.data.artifactType === "workspace_activity") {
    return isExactWorkspaceActivity(event.data.payload);
  }
  if (event.data.artifactType === "memory_search_activity") {
    const decoded = decodeMemorySearchActivity(event.data.payload);
    return decoded !== null && JSON.stringify(sortedKeys(decoded)) === JSON.stringify(sortedKeys(event.data.payload));
  }
  if (event.data.artifactType === "search_activity") {
    const decoded = decodeThreadSearchActivitySnapshot(event.data.payload);
    return decoded !== null && JSON.stringify(sortedKeys(decoded)) === JSON.stringify(sortedKeys(event.data.payload));
  }
  if (event.data.artifactType !== "search" || !isRecord(event.data.payload) ||
    !hasOnlyKeys(event.data.payload, ["action"]) ||
    !isRecord(event.data.payload.action) ||
    !hasOnlyKeys(event.data.payload.action, ["sources"]) ||
    !Array.isArray(event.data.payload.action.sources) ||
    event.data.payload.action.sources.length === 0 ||
    event.data.payload.action.sources.length > SEARCH_EVENT_SOURCE_LIMIT) return false;
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
