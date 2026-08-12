import { normalizeMemorySearchText } from "../../persistence/lexical";
import { detectMemoryTextLanguage } from "../language";
import { projectMemoryHistorySafeText } from "../safety";
import {
  MEMORY_EPISODE_MAX_CHUNKS_PER_EPISODE,
  MEMORY_EPISODE_MAX_OUTPUT_EPISODES,
  memoryEpisodeExtractionOutputHash,
  type MemoryEpisodeCandidate,
  type MemoryEpisodeExtractionInput,
  type MemoryEpisodeExtractionPlan
} from "./contract";
import { MEMORY_EPISODE_TOOL_NAME } from "./prompt";
import type { ModelToolCall } from "../../../tools/types";

const languageCodes = new Set(["en", "mixed", "ru", "und"]);
const exactEpisodeKeys = [
  "keywords",
  "language",
  "occurred_from",
  "occurred_to",
  "source_chunk_ids",
  "source_message_ids",
  "summary"
].sort();

export class MemoryEpisodeDecodeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MemoryEpisodeDecodeError";
  }
}

function fail(code = "memory_episode_output_invalid"): never {
  throw new MemoryEpisodeDecodeError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
}

function boundedStrings(
  value: unknown,
  options: Readonly<{ maxItems: number; maxLength: number; minItems?: number }>
): string[] {
  if (!Array.isArray(value) ||
    value.length < (options.minItems ?? 0) ||
    value.length > options.maxItems) fail();
  const strings = value.map((entry) => {
    if (
      typeof entry !== "string" || entry.trim() !== entry || !entry ||
      entry.length > options.maxLength || /[\u0000-\u001f\u007f]/u.test(entry)
    ) fail();
    return entry;
  });
  if (new Set(strings).size !== strings.length) fail();
  return strings;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function exactTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) fail();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail();
  return value;
}

function decodeEpisode(
  value: unknown,
  input: MemoryEpisodeExtractionInput,
  usedChunkIds: Set<string>,
  usedMessageIds: Set<string>
): MemoryEpisodeCandidate {
  if (!isRecord(value) || !hasExactKeys(value, exactEpisodeKeys)) fail();
  const chunkIds = boundedStrings(value.source_chunk_ids, {
    maxItems: MEMORY_EPISODE_MAX_CHUNKS_PER_EPISODE,
    maxLength: 256,
    minItems: 1
  });
  const chunks = chunkIds.map((id) => input.chunks.find((chunk) => chunk.id === id) ?? fail());
  if (
    chunks.some((chunk, index) => index > 0 &&
      chunk.ordinal !== chunks[index - 1]!.ordinal + 1) ||
    chunks.some((chunk) => usedChunkIds.has(chunk.id))
  ) fail();
  const expectedMessageIds = uniqueInOrder(chunks.flatMap((chunk) => chunk.messageIds));
  const messageIds = boundedStrings(value.source_message_ids, {
    maxItems: 24,
    maxLength: 256,
    minItems: 1
  });
  if (
    !sameStrings(messageIds, expectedMessageIds) ||
    messageIds.some((messageId) => usedMessageIds.has(messageId))
  ) fail();

  if (typeof value.summary !== "string") fail("memory_episode_output_ungrounded");
  const summary = value.summary;
  if (
    summary.trim() !== summary || summary.length < 1 || summary.length > 1_200 ||
    !chunks.some((chunk) => chunk.safeProjectedText.includes(summary))
  ) fail("memory_episode_output_ungrounded");
  const safety = projectMemoryHistorySafeText(summary);
  if (
    !safety.eligible || safety.safeText !== summary ||
    safety.providerSafeText !== summary
  ) fail("memory_episode_output_unsafe");
  if (typeof value.language !== "string" || !languageCodes.has(value.language)) fail();
  const languageCode = detectMemoryTextLanguage(summary);

  const occurredFrom = exactTimestamp(value.occurred_from);
  const occurredTo = exactTimestamp(value.occurred_to);
  const expectedFrom = chunks.map((chunk) => chunk.occurredFrom).sort()[0];
  const expectedTo = chunks.map((chunk) => chunk.occurredTo).sort().at(-1);
  if (occurredFrom !== expectedFrom || occurredTo !== expectedTo ||
    new Date(occurredFrom) > new Date(occurredTo)) fail();

  const keywords = boundedStrings(value.keywords, { maxItems: 12, maxLength: 80 });
  const normalizedSource = normalizeMemorySearchText(
    chunks.map((chunk) => chunk.safeProjectedText).join("\n\n")
  );
  if (keywords.some((keyword) => {
    const normalizedKeyword = normalizeMemorySearchText(keyword);
    return !normalizedKeyword || !normalizedSource.includes(normalizedKeyword);
  })) {
    fail("memory_episode_output_ungrounded");
  }
  const projectionVersions = new Set(chunks.map((chunk) => chunk.sourceProjectionVersion));
  if (projectionVersions.size !== 1) fail();
  const assistantIds = new Set(chunks.map((chunk) => chunk.sourceAssistantId));
  const folderIds = new Set(chunks.map((chunk) => chunk.sourceFolderId));
  const redactionReasonCodes = [...new Set(
    chunks.flatMap((chunk) => chunk.redactionReasonCodes)
  )].sort();
  for (const id of chunkIds) usedChunkIds.add(id);
  for (const id of messageIds) usedMessageIds.add(id);
  return {
    chunkIds,
    entities: [],
    keywords,
    languageCode,
    messageIds,
    occurredFrom,
    occurredTo,
    redactionReasonCodes,
    redactionState: chunks.some((chunk) => chunk.redactionState === "REDACTED")
      ? "REDACTED"
      : "NOT_NEEDED",
    safeSummary: summary,
    safetyClass: chunks.some((chunk) => chunk.safetyClass === "SENSITIVE")
      ? "SENSITIVE"
      : "NORMAL",
    sourceAssistantId: assistantIds.size === 1 ? chunks[0]!.sourceAssistantId : null,
    sourceFolderId: folderIds.size === 1 ? chunks[0]!.sourceFolderId : null,
    sourceProjectionVersion: chunks[0]!.sourceProjectionVersion
  };
}

export function decodeMemoryEpisodeExtraction(
  calls: readonly ModelToolCall[] | undefined,
  input: MemoryEpisodeExtractionInput
): MemoryEpisodeExtractionPlan {
  if (
    !calls || calls.length !== 1 || calls[0]?.name !== MEMORY_EPISODE_TOOL_NAME ||
    !isRecord(calls[0].arguments) ||
    !hasExactKeys(calls[0].arguments, ["episodes"]) ||
    !Array.isArray(calls[0].arguments.episodes) ||
    calls[0].arguments.episodes.length > MEMORY_EPISODE_MAX_OUTPUT_EPISODES
  ) fail();
  const usedChunkIds = new Set<string>();
  const usedMessageIds = new Set<string>();
  const episodes = calls[0].arguments.episodes.map((episode) =>
    decodeEpisode(episode, input, usedChunkIds, usedMessageIds));
  if (episodes.some((episode, index) => index > 0 &&
    input.chunks.find((chunk) => chunk.id === episode.chunkIds[0])!.ordinal <=
      input.chunks.find((chunk) => chunk.id === episodes[index - 1]!.chunkIds[0])!.ordinal)) {
    fail();
  }
  return {
    episodes,
    input,
    outputHash: memoryEpisodeExtractionOutputHash(input, episodes)
  };
}
