import { memorySha256 } from "../persistence/lexical";
import type { MemorySecretSourceMapEntry } from "../explicit/safety";
import { detectMemoryTextLanguage, type MemoryTextLanguage } from "./language";
import {
  projectMemoryHistorySafeRecallGroupText,
  projectMemoryHistorySafeText,
  type MemoryDerivedSafetyClass,
  type MemoryRedactionState
} from "./safety";

export const MEMORY_HISTORY_SOURCE_PROJECTION_VERSION =
  "memory-history-source-projection-v5";

export const MEMORY_HISTORY_SOURCE_ORIGINS = [
  "DEVELOPER",
  "DIRECT_USER",
  "HIDDEN_ASSISTANT",
  "KNOWLEDGE",
  "PROVIDER_PAYLOAD",
  "SEARCH",
  "SYSTEM",
  "TOOL",
  "VISIBLE_ASSISTANT"
] as const;

export const MEMORY_HISTORY_TAINT_SOURCES = [
  "ATTACHMENT",
  "DEVELOPER",
  "HIDDEN_ASSISTANT",
  "KNOWLEDGE",
  "PROVIDER_PAYLOAD",
  "SEARCH",
  "SYSTEM",
  "TOOL"
] as const;

export type MemoryHistorySourceOrigin =
  (typeof MEMORY_HISTORY_SOURCE_ORIGINS)[number];
export type MemoryHistoryTaintSource =
  (typeof MEMORY_HISTORY_TAINT_SOURCES)[number];
export type MemoryHistorySourceMode = "EXCLUDED" | "NORMAL" | "TEMPORARY";
export type MemoryHistoryMessageProvenanceInput = Readonly<{
  assistantId: string | null;
  complete: boolean;
  influencedByMessageIds: readonly string[];
  modelRunId: string | null;
  origin: MemoryHistorySourceOrigin;
  taintSources: readonly MemoryHistoryTaintSource[];
}>;

export type MemoryHistorySourceMessageInput = Readonly<{
  chatId: string;
  content: unknown;
  createdAt: Date | string;
  id: string;
  parentMessageId: string | null;
  provenance: MemoryHistoryMessageProvenanceInput;
  role: string;
  status: string;
  updatedAt: Date | string;
}>;

export type MemoryHistorySourceSnapshotInput = Readonly<{
  activeLeafMessageId: string | null;
  branchGeneration: number;
  chatId: string;
  folderId: string | null;
  messages: readonly MemoryHistorySourceMessageInput[];
  mode: MemoryHistorySourceMode;
  sourceContentHash: string;
  sourceRevision: number;
  timeZone: string;
  userId: string;
}>;

export type MemoryHistoryProjectedMessage = Readonly<{
  contentHash: string;
  createdAt: string;
  id: string;
  languageCode: MemoryTextLanguage;
  providerSafeText: string;
  provenance: Readonly<{
    assistantId: string | null;
    influencedByMessageIds: readonly string[];
    modelRunId: string | null;
    origin: "DIRECT_USER" | "VISIBLE_ASSISTANT";
  }>;
  redactionReasonCodes: readonly string[];
  redactionSourceMap: readonly MemorySecretSourceMapEntry[];
  redactionState: Exclude<MemoryRedactionState, "EXCLUDED">;
  role: "assistant" | "user";
  safeText: string;
  safeTextHash: string;
  safetyClass: Exclude<MemoryDerivedSafetyClass, "HIGHLY_SENSITIVE" | "SECRET_TAINTED">;
  updatedAt: string;
}>;

export type MemoryHistoryRecallTurnGroup = Readonly<{
  assistantMessageId: string | null;
  id: string;
  kind: "STANDALONE" | "TURN";
  languageCode: MemoryTextLanguage;
  messages: readonly MemoryHistoryProjectedMessage[];
  occurredFrom: string;
  occurredTo: string;
  ordinal: number;
  redactionReasonCodes: readonly string[];
  redactionState: "NOT_NEEDED" | "REDACTED";
  safeTextHash: string;
  safetyClass: "NORMAL" | "SENSITIVE";
  sourceAssistantId: string | null;
  userMessageId: string | null;
}>;

export type MemoryHistoryProvenanceNode = Readonly<{
  contentHash: string;
  directTaintSources: readonly MemoryHistoryTaintSource[];
  eligibleForFactEvidence: boolean;
  eligibleForRecall: boolean;
  influencedByMessageIds: readonly string[];
  messageId: string;
  origin: MemoryHistorySourceOrigin;
  reasonCodes: readonly string[];
  role: string;
  transitiveTaint: boolean;
}>;

export type MemorySafeSourceSnapshot = Readonly<{
  activeLeafMessageId: string | null;
  activePathMessageIds: readonly string[];
  branchGeneration: number;
  chatId: string;
  factEvidenceProjection: Readonly<{
    messages: readonly MemoryHistoryProjectedMessage[];
    projectionHash: string;
  }>;
  folderId: string | null;
  mode: MemoryHistorySourceMode;
  projectionVersion: typeof MEMORY_HISTORY_SOURCE_PROJECTION_VERSION;
  provenanceGraph: readonly MemoryHistoryProvenanceNode[];
  recallChunkProjection: Readonly<{
    projectionHash: string;
    turnGroups: readonly MemoryHistoryRecallTurnGroup[];
  }>;
  snapshotHash: string;
  sourceContentHash: string;
  sourceRevision: number;
  timeZone: string;
  userId: string;
}>;

type ExtractedMessageText = Readonly<{
  attachmentBlocksOmitted: boolean;
  text: string;
}>;

type EvaluatedMessage = {
  contentHash: string;
  createdAt: string;
  directTaintSources: MemoryHistoryTaintSource[];
  factEligible: boolean;
  influencedByMessageIds: string[];
  input: MemoryHistorySourceMessageInput;
  projected: MemoryHistoryProjectedMessage | null;
  reasonCodes: string[];
  recallEligible: boolean;
  transitiveTaint: boolean;
  updatedAt: string;
};

const sha256Pattern = /^[a-f0-9]{64}$/u;
const sourceModeSet = new Set<MemoryHistorySourceMode>([
  "EXCLUDED",
  "NORMAL",
  "TEMPORARY"
]);
const sourceOriginSet = new Set<MemoryHistorySourceOrigin>(
  MEMORY_HISTORY_SOURCE_ORIGINS
);
const taintSourceSet = new Set<MemoryHistoryTaintSource>(
  MEMORY_HISTORY_TAINT_SOURCES
);
const eligibleRoleOrigins = new Map<string, MemoryHistorySourceOrigin>([
  ["assistant", "VISIBLE_ASSISTANT"],
  ["user", "DIRECT_USER"]
]);

export class MemoryHistorySourceProjectionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MemoryHistorySourceProjectionError";
  }
}

function fail(code: string): never {
  throw new MemoryHistorySourceProjectionError(code);
}

function validIdentity(value: string | null): boolean {
  return value === null ||
    (value.length >= 1 && value.length <= 256 && !/\s/u.test(value));
}

function nonNegativeCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
}

function isoTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail("memory_history_timestamp_invalid");
  return date.toISOString();
}

function canonicalTimeZone(value: string): string {
  if (!value || value.length > 128) fail("memory_history_time_zone_invalid");
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value })
      .resolvedOptions().timeZone;
  } catch {
    return fail("memory_history_time_zone_invalid");
  }
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function contentHash(content: unknown): string {
  try {
    return memorySha256(content);
  } catch {
    return fail("memory_history_content_invalid");
  }
}

function extractMessageText(content: unknown): ExtractedMessageText | null {
  if (
    typeof content !== "object" ||
    content === null ||
    Array.isArray(content) ||
    !Array.isArray((content as { blocks?: unknown }).blocks) ||
    (content as { blocks: unknown[] }).blocks.length > 128
  ) {
    return null;
  }
  const textParts: string[] = [];
  let attachmentBlocksOmitted = false;
  for (const block of (content as { blocks: unknown[] }).blocks) {
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      return null;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      textParts.push(record.text);
      continue;
    }
    if (
      (record.type === "file" || record.type === "image") &&
      typeof record.attachmentId === "string" &&
      record.attachmentId.length > 0
    ) {
      attachmentBlocksOmitted = true;
      continue;
    }
    return null;
  }
  return {
    attachmentBlocksOmitted,
    text: textParts.join("\n")
  };
}

function validateSource(input: MemoryHistorySourceSnapshotInput): string {
  if (
    !validIdentity(input.userId) ||
    !validIdentity(input.chatId) ||
    !validIdentity(input.folderId) ||
    !validIdentity(input.activeLeafMessageId) ||
    !sourceModeSet.has(input.mode) ||
    !nonNegativeCounter(input.branchGeneration) ||
    !nonNegativeCounter(input.sourceRevision) ||
    !sha256Pattern.test(input.sourceContentHash) ||
    input.messages.length > 100_000
  ) {
    fail("memory_history_source_identity_invalid");
  }
  return canonicalTimeZone(input.timeZone);
}

function activePath(
  messages: readonly MemoryHistorySourceMessageInput[],
  chatId: string,
  activeLeafMessageId: string
): MemoryHistorySourceMessageInput[] {
  const byId = new Map<string, MemoryHistorySourceMessageInput>();
  for (const message of messages) {
    if (
      !validIdentity(message.id) ||
      !validIdentity(message.parentMessageId) ||
      message.chatId !== chatId ||
      byId.has(message.id)
    ) {
      fail("memory_history_source_path_invalid");
    }
    byId.set(message.id, message);
  }
  const path: MemoryHistorySourceMessageInput[] = [];
  const seen = new Set<string>();
  let cursor: string | null = activeLeafMessageId;
  while (cursor !== null) {
    if (seen.has(cursor)) fail("memory_history_source_path_cycle");
    const message = byId.get(cursor);
    if (!message) fail("memory_history_source_path_incomplete");
    seen.add(cursor);
    path.push(message);
    cursor = message.parentMessageId;
  }
  return path.reverse();
}

function emptySnapshot(
  input: MemoryHistorySourceSnapshotInput,
  timeZone: string
): MemorySafeSourceSnapshot {
  const emptyProjectionHash = memorySha256([]);
  const snapshotHash = memorySha256({
    branchGeneration: input.branchGeneration,
    chatId: input.chatId,
    mode: input.mode,
    projectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
    sourceContentHash: input.sourceContentHash,
    sourceRevision: input.sourceRevision,
    timeZone,
    userId: input.userId
  });
  return {
    activeLeafMessageId: input.activeLeafMessageId,
    activePathMessageIds: [],
    branchGeneration: input.branchGeneration,
    chatId: input.chatId,
    factEvidenceProjection: {
      messages: [],
      projectionHash: emptyProjectionHash
    },
    folderId: input.folderId,
    mode: input.mode,
    projectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
    provenanceGraph: [],
    recallChunkProjection: {
      projectionHash: emptyProjectionHash,
      turnGroups: []
    },
    snapshotHash,
    sourceContentHash: input.sourceContentHash,
    sourceRevision: input.sourceRevision,
    timeZone,
    userId: input.userId
  };
}

function evaluateMessages(
  path: readonly MemoryHistorySourceMessageInput[]
): EvaluatedMessage[] {
  const pathIndex = new Map(path.map((message, index) => [message.id, index]));
  const evaluated: EvaluatedMessage[] = [];
  for (let index = 0; index < path.length; index += 1) {
    const input = path[index]!;
    const createdAt = isoTimestamp(input.createdAt);
    const updatedAt = isoTimestamp(input.updatedAt);
    if (updatedAt < createdAt) fail("memory_history_timestamp_order_invalid");
    const reasons = new Set<string>();
    const provenance = input.provenance;
    const origin = provenance?.origin;
    const influencedByMessageIds = Array.isArray(provenance?.influencedByMessageIds)
      ? uniqueSorted(provenance.influencedByMessageIds)
      : [];
    const directTaintSources = Array.isArray(provenance?.taintSources)
      ? uniqueSorted(provenance.taintSources)
      : [];
    if (
      !provenance ||
      provenance.complete !== true ||
      !sourceOriginSet.has(origin) ||
      !Array.isArray(provenance.influencedByMessageIds) ||
      !Array.isArray(provenance.taintSources) ||
      provenance.taintSources.some((source) => !taintSourceSet.has(source)) ||
      !validIdentity(provenance.assistantId) ||
      !validIdentity(provenance.modelRunId)
    ) {
      reasons.add("PROVENANCE_INCOMPLETE");
    }
    if (eligibleRoleOrigins.get(input.role) !== origin) {
      reasons.add("SOURCE_ORIGIN_INELIGIBLE");
    }
    if (input.role === "user") {
      if (
        influencedByMessageIds.length > 0 ||
        provenance.assistantId !== null ||
        provenance.modelRunId !== null
      ) {
        reasons.add("DIRECT_USER_PROVENANCE_INVALID");
      }
    } else if (input.role === "assistant") {
      const hasDirectUserInfluence = influencedByMessageIds.some((messageId) => {
        const influencedIndex = pathIndex.get(messageId);
        return influencedIndex !== undefined && influencedIndex < index &&
          path[influencedIndex]?.role === "user";
      });
      if (
        provenance.modelRunId === null ||
        !hasDirectUserInfluence
      ) {
        reasons.add("ASSISTANT_SOURCE_EDGE_MISSING");
      }
    }
    if (input.status !== "complete") reasons.add("MESSAGE_NOT_SETTLED");
    if (directTaintSources.length > 0) reasons.add("DIRECT_PROVENANCE_TAINT");

    let invalidInfluence = false;
    let transitiveTaint = false;
    for (const influencedId of influencedByMessageIds) {
      const influencedIndex = pathIndex.get(influencedId);
      if (influencedIndex === undefined || influencedIndex >= index) {
        invalidInfluence = true;
        continue;
      }
      if (evaluated[influencedIndex]?.transitiveTaint) transitiveTaint = true;
    }
    if (invalidInfluence) reasons.add("PROVENANCE_EDGE_INVALID");
    if (transitiveTaint) reasons.add("TRANSITIVE_PROVENANCE_TAINT");

    const extracted = extractMessageText(input.content);
    if (!extracted) reasons.add("MESSAGE_CONTENT_INVALID");
    const hash = contentHash(input.content);
    let projected: MemoryHistoryProjectedMessage | null = null;
    if (
      reasons.size === 0 &&
      extracted &&
      (input.role === "user" || input.role === "assistant")
    ) {
      const safety = projectMemoryHistorySafeText(extracted.text);
      if (!safety.eligible) {
        for (const reason of safety.redactionReasonCodes) reasons.add(reason);
      } else {
        projected = {
          contentHash: hash,
          createdAt,
          id: input.id,
          languageCode: detectMemoryTextLanguage(safety.safeText),
          providerSafeText: safety.providerSafeText,
          provenance: {
            assistantId: provenance.assistantId,
            influencedByMessageIds,
            modelRunId: provenance.modelRunId,
            origin: origin as "DIRECT_USER" | "VISIBLE_ASSISTANT"
          },
          redactionReasonCodes: safety.redactionReasonCodes,
          redactionSourceMap: safety.redactionSourceMap,
          redactionState: safety.redactionState,
          role: input.role,
          safeText: safety.safeText,
          safeTextHash: memorySha256(safety.safeText),
          safetyClass: safety.safetyClass,
          updatedAt
        };
        if (extracted.attachmentBlocksOmitted) {
          reasons.add("ATTACHMENT_BLOCK_OMITTED");
        }
      }
    }
    const tainted = projected === null || transitiveTaint || directTaintSources.length > 0;
    evaluated.push({
      contentHash: hash,
      createdAt,
      directTaintSources,
      factEligible: false,
      influencedByMessageIds,
      input,
      projected,
      reasonCodes: [...reasons].sort(),
      recallEligible: false,
      transitiveTaint: tainted,
      updatedAt
    });
  }
  return evaluated;
}

function recallTurnGroups(evaluated: EvaluatedMessage[]): MemoryHistoryRecallTurnGroup[] {
  const groups: MemoryHistoryRecallTurnGroup[] = [];
  for (let index = 0; index < evaluated.length; index += 1) {
    const current = evaluated[index]!;
    if (!current.projected || current.transitiveTaint) continue;
    const following = evaluated[index + 1];
    const paired = current.input.role === "user" &&
      following?.input.role === "assistant" &&
      following.projected !== null &&
      !following.transitiveTaint &&
      following.influencedByMessageIds.includes(current.input.id);
    const selected = paired ? [current, following] : [current];
    const messages = selected.map((message) => message.projected!);
    const combinedText = messages.map((message) => message.safeText).join("\n\n");
    const occurredFrom = selected[0]!.createdAt;
    const occurredTo = selected.at(-1)!.createdAt;
    if (occurredTo < occurredFrom) fail("memory_history_turn_time_invalid");
    const groupSafety = projectMemoryHistorySafeRecallGroupText(combinedText);
    if (!groupSafety.eligible || groupSafety.safeText !== combinedText) {
      for (const message of selected) {
        message.reasonCodes = uniqueSorted([
          ...message.reasonCodes,
          "TURN_GROUP_SAFETY_EXCLUDED"
        ]);
      }
      continue;
    }
    for (const message of selected) message.recallEligible = true;
    const reasonCodes = uniqueSorted(messages.flatMap((message) =>
      message.redactionReasonCodes));
    const ordinal = groups.length;
    const userMessage = selected.find((message) => message.input.role === "user") ?? null;
    const assistantMessage = selected.find((message) =>
      message.input.role === "assistant") ?? null;
    groups.push({
      assistantMessageId: assistantMessage?.input.id ?? null,
      id: memorySha256({
        messageIds: selected.map((message) => message.input.id),
        projectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
      }),
      kind: paired ? "TURN" : "STANDALONE",
      languageCode: detectMemoryTextLanguage(combinedText),
      messages,
      occurredFrom,
      occurredTo,
      ordinal,
      redactionReasonCodes: reasonCodes,
      redactionState: reasonCodes.length > 0 ? "REDACTED" : "NOT_NEEDED",
      safeTextHash: memorySha256(combinedText),
      safetyClass: "NORMAL",
      sourceAssistantId: assistantMessage?.projected?.provenance.assistantId ?? null,
      userMessageId: userMessage?.input.id ?? null
    });
    if (paired) index += 1;
  }
  return groups;
}

function factEvidenceMessages(evaluated: EvaluatedMessage[]): MemoryHistoryProjectedMessage[] {
  const candidates = evaluated.filter((message) =>
    message.input.role === "user" &&
    message.projected !== null &&
    !message.transitiveTaint &&
    message.projected.safetyClass === "NORMAL");
  const excludedWindowMessageIds = new Set<string>();
  for (let index = 1; index < candidates.length; index += 1) {
    const previous = candidates[index - 1]!;
    const current = candidates[index]!;
    const windowText = `${previous.projected!.safeText}\n\n${current.projected!.safeText}`;
    const safety = projectMemoryHistorySafeText(windowText);
    if (!safety.eligible || safety.safeText !== windowText) {
      excludedWindowMessageIds.add(previous.input.id);
      excludedWindowMessageIds.add(current.input.id);
    }
  }
  return candidates.flatMap((message) => {
    if (excludedWindowMessageIds.has(message.input.id)) {
      message.reasonCodes = uniqueSorted([
        ...message.reasonCodes,
        "FACT_WINDOW_SAFETY_EXCLUDED"
      ]);
      return [];
    }
    message.factEligible = true;
    return [message.projected!];
  });
}

export function buildMemorySafeSourceSnapshot(
  input: MemoryHistorySourceSnapshotInput
): MemorySafeSourceSnapshot {
  const timeZone = validateSource(input);
  if (input.mode !== "NORMAL" || input.activeLeafMessageId === null) {
    return emptySnapshot(input, timeZone);
  }
  const path = activePath(input.messages, input.chatId, input.activeLeafMessageId);
  const evaluated = evaluateMessages(path);
  const turnGroups = recallTurnGroups(evaluated);
  const factMessages = factEvidenceMessages(evaluated);
  const provenanceGraph = evaluated.map((message): MemoryHistoryProvenanceNode => ({
    contentHash: message.contentHash,
    directTaintSources: message.directTaintSources,
    eligibleForFactEvidence: message.factEligible,
    eligibleForRecall: message.recallEligible,
    influencedByMessageIds: message.influencedByMessageIds,
    messageId: message.input.id,
    origin: message.input.provenance.origin,
    reasonCodes: message.reasonCodes,
    role: message.input.role,
    transitiveTaint: message.transitiveTaint
  }));
  const recallProjectionHash = memorySha256(turnGroups);
  const factProjectionHash = memorySha256(factMessages);
  const snapshotHash = memorySha256({
    activeLeafMessageId: input.activeLeafMessageId,
    activePath: evaluated.map((message) => ({
      contentHash: message.contentHash,
      id: message.input.id,
      parentMessageId: message.input.parentMessageId,
      provenance: {
        assistantId: message.input.provenance.assistantId,
        complete: message.input.provenance.complete,
        influencedByMessageIds: message.influencedByMessageIds,
        modelRunId: message.input.provenance.modelRunId,
        origin: message.input.provenance.origin,
        taintSources: message.directTaintSources
      },
      role: message.input.role,
      status: message.input.status,
      updatedAt: message.updatedAt
    })),
    branchGeneration: input.branchGeneration,
    chatId: input.chatId,
    factProjectionHash,
    folderId: input.folderId,
    mode: input.mode,
    projectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
    recallProjectionHash,
    sourceContentHash: input.sourceContentHash,
    sourceRevision: input.sourceRevision,
    timeZone,
    userId: input.userId
  });
  return {
    activeLeafMessageId: input.activeLeafMessageId,
    activePathMessageIds: path.map((message) => message.id),
    branchGeneration: input.branchGeneration,
    chatId: input.chatId,
    factEvidenceProjection: {
      messages: factMessages,
      projectionHash: factProjectionHash
    },
    folderId: input.folderId,
    mode: input.mode,
    projectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
    provenanceGraph,
    recallChunkProjection: {
      projectionHash: recallProjectionHash,
      turnGroups
    },
    snapshotHash,
    sourceContentHash: input.sourceContentHash,
    sourceRevision: input.sourceRevision,
    timeZone,
    userId: input.userId
  };
}
