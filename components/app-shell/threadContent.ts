import { decodeThreadWorkspaceCheckpointOutput, type ThreadGeneratedFile } from "@/lib/contracts/workspace";
import { decodeThreadGeneratedImage } from "@/lib/contracts/imageGeneration";
import { THREAD_SEARCH_SOURCE_MAX_ITEMS, decodeThreadGeneratedArtifact } from "@/lib/contracts/chats";
import { foldScheduledTaskCards } from "@/lib/contracts/scheduledTasks";
import { foldSkillSaveCards } from "@/lib/contracts/skillSaves";
import { foldMcpApprovalCards } from "@/lib/contracts/mcpApprovals";
import { decodeGroundingDisplay } from "../../lib/domain/groundingDisplay";
import { isRecord } from "@/components/app-shell/shellValues";
import type {
  RunEventView,
  ThreadArtifactSummary,
  ThreadCitation
} from "@/components/app-shell/types";
import { collectThreadSearchSources } from "@/lib/domain/searchSources";
import {
  answerCitationsFromGrounding,
  foldAnswerCitations,
  projectAnswerCitation
} from "@/lib/domain/answerCitations";
import { foldReasoningEntries, streamedReasoningFoldItem } from "@/lib/domain/answerReasoning";
import { latestGeneratedArtifactsForAnswer } from "@/lib/domain/generatedArtifacts";
import { decodeContextCompactionStatus, mergeContextCompactionStatus, type ContextCompactionStatus } from "@/lib/contracts/contextCompaction";

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

function groundingDisplayFromEvent(event: RunEventView): {
  citations: ThreadCitation[];
  display: NonNullable<ThreadArtifactSummary["groundingDisplay"]>;
} | null {
  if (event.type !== "grounding_display" || !isRecord(event.data)) return null;
  const data = decodeGroundingDisplay(event.data);
  if (!data) return null;
  const citations = answerCitationsFromGrounding(data.citations);
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

function contextCompactionFromEvents(
  events: readonly RunEventView[]
): ContextCompactionStatus | null {
  let latest: ContextCompactionStatus | null = null;
  for (const event of events) {
    if (artifactTypeFromEvent(event) !== "context_compaction") continue;
    const status = decodeContextCompactionStatus(artifactPayload(event));
    if (!status) continue;
    latest = mergeContextCompactionStatus(latest, status);
  }
  return latest;
}

export function summarizeThreadArtifacts(
  events: RunEventView[]
): ThreadArtifactSummary | null {
  const skillCatalogOmittedCount = events.flatMap((event) => {
    const payload = artifactPayload(event);
    return artifactTypeFromEvent(event) === "summary" && isRecord(payload) &&
      Number.isSafeInteger(payload.skillCatalogOmittedCount) && Number(payload.skillCatalogOmittedCount) > 0
      ? [Number(payload.skillCatalogOmittedCount)] : [];
  }).at(-1);
  const contextCompaction = contextCompactionFromEvents(events);
  const grounding = events
    .map(groundingDisplayFromEvent)
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .at(-1) ?? null;
  const checkpointFiles = new Map<string, ThreadGeneratedFile>();
  for (const event of events) {
    if (artifactTypeFromEvent(event) !== "workspace_checkpoint") continue;
    const output = decodeThreadWorkspaceCheckpointOutput(artifactPayload(event));
    for (const file of output?.files ?? []) {
      // Redelivery cannot rename or replace an already selected immutable version.
      if (!checkpointFiles.has(file.attachmentId)) checkpointFiles.set(file.attachmentId, file);
    }
  }
  const generatedFiles = [...checkpointFiles.values()];
  const generatedImages = [...new Map(events.filter((event) => artifactTypeFromEvent(event) === "image").flatMap((event) => {
    const image = decodeThreadGeneratedImage(artifactPayload(event));
    return image ? [[image.attachmentId, image] as const] : [];
  })).values()];
  const generatedArtifacts = latestGeneratedArtifactsForAnswer(events.filter((event) => artifactTypeFromEvent(event) === "generated_artifact").flatMap((event) => {
    const decoded = decodeThreadGeneratedArtifact(artifactPayload(event));
    return decoded ? [decoded] : [];
  }));
  // The same fold as a reload: one card per task the answer created or managed.
  const scheduledTasks = foldScheduledTaskCards(events
    .filter((event) => artifactTypeFromEvent(event) === "scheduled_task").map(artifactPayload));
  const skillSaves = foldSkillSaveCards(events.filter((event) => artifactTypeFromEvent(event) === "skill_save").map(artifactPayload));
  // Live approval cards; the saved answer's cards carry their decisions.
  const mcpApprovals = foldMcpApprovalCards(events.filter((event) => artifactTypeFromEvent(event) === "mcp_approval")
    .map(artifactPayload));
  // The same projections and folds as a reload, so a finished live answer
  // shows the thinking, citations and sources its saved summary will show.
  const reasoning = foldReasoningEntries(events.map((event) =>
    artifactTypeFromEvent(event) === "reasoning"
      ? streamedReasoningFoldItem(artifactPayload(event))
      : { kind: "other" as const }));
  const citationList = foldAnswerCitations(grounding?.citations ?? events.flatMap((event) => {
    const citation = artifactTypeFromEvent(event) === "citation"
      ? projectAnswerCitation(artifactPayload(event))
      : null;
    return citation ? [citation] : [];
  }));
  const citations = citationList.citations;
  const searchEvents = events.filter(
    (event) => artifactTypeFromEvent(event) === "search"
  );
  const sourceList = collectThreadSearchSources([
    ...searchEvents.flatMap(sourceValuesFromSearchEvent),
    ...(grounding ? [citations] : [])
  ], THREAD_SEARCH_SOURCE_MAX_ITEMS);
  const sources = sourceList.sources;

  if (
    generatedFiles.length === 0 &&
    generatedImages.length === 0 &&
    !skillCatalogOmittedCount &&
    generatedArtifacts.length === 0 &&
    scheduledTasks.length === 0 &&
    skillSaves.length === 0 &&
    mcpApprovals.length === 0 &&
    citations.length === 0 &&
    sources.length === 0 &&
    reasoning.entries.length === 0 &&
    !grounding &&
    !contextCompaction
  ) {
    return null;
  }

  return {
    citations,
    ...(citationList.truncated ? { citationsTruncated: true as const } : {}),
    ...(contextCompaction ? { contextCompaction } : {}),
    ...(skillCatalogOmittedCount ? { skillCatalogOmittedCount } : {}),
    groundingDisplay: grounding?.display ?? null,
    ...(generatedFiles.length ? { generatedFiles } : {}),
    ...(generatedImages.length ? { generatedImages } : {}),
    ...(generatedArtifacts.length ? { generatedArtifacts } : {}),
    reasoningText: reasoning.entries,
    ...(reasoning.truncated ? { reasoningTruncated: true as const } : {}),
    ...(scheduledTasks.length ? { scheduledTasks } : {}),
    ...(skillSaves.length ? { skillSaves } : {}),
    ...(mcpApprovals.length ? { mcpApprovals } : {}),
    sources,
    ...(sourceList.truncated ? { sourcesTruncated: true as const } : {})
  };
}

/**
 * Persisted outputs and live settled checkpoints share immutable attachment
 * identities. A live summary built from only some events (for example only
 * compaction) never blanks saved citations, sources, reasoning or grounding.
 */
export function mergeLiveThreadArtifacts(
  saved: ThreadArtifactSummary | null | undefined,
  live: ThreadArtifactSummary | null | undefined
): ThreadArtifactSummary | null {
  if (!live) return saved ?? null;
  if (!saved) return live;
  const files = new Map<string, ThreadGeneratedFile>();
  for (const file of [...saved.generatedFiles ?? [], ...live.generatedFiles ?? []]) {
    if (!files.has(file.attachmentId)) files.set(file.attachmentId, file);
  }
  const savedCompaction = saved.contextCompaction;
  const liveCompaction = live.contextCompaction;
  const contextCompaction = mergeContextCompactionStatus(savedCompaction, liveCompaction);
  const groundingDisplay = live.groundingDisplay ?? saved.groundingDisplay;
  // A list and its completeness mark always come from the same summary.
  const citationOwner = live.citations.length > 0 ? live : saved;
  const reasoningOwner = live.reasoningText.length > 0 ? live : saved;
  const sourceOwner = live.sources.length > 0 ? live : saved;
  // One card per approval: a saved card carries the decision, so it wins.
  const mcpApprovals = foldMcpApprovalCards([...live.mcpApprovals ?? [], ...saved.mcpApprovals ?? []]);
  const {
    citationsTruncated: _citationsTruncated,
    mcpApprovals: _mcpApprovals,
    reasoningTruncated: _reasoningTruncated,
    sourcesTruncated: _sourcesTruncated,
    ...merged
  } = { ...saved, ...live };
  return {
    ...merged,
    ...(mcpApprovals.length ? { mcpApprovals } : {}),
    citations: citationOwner.citations,
    ...(citationOwner.citationsTruncated ? { citationsTruncated: true as const } : {}),
    ...(contextCompaction ? { contextCompaction } : {}),
    ...(files.size ? { generatedFiles: [...files.values()] } : {}),
    groundingDisplay: groundingDisplay ?? null,
    reasoningText: reasoningOwner.reasoningText,
    ...(reasoningOwner.reasoningTruncated ? { reasoningTruncated: true as const } : {}),
    sources: sourceOwner.sources,
    ...(sourceOwner.sourcesTruncated ? { sourcesTruncated: true as const } : {})
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
