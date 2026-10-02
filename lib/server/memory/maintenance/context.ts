import { Prisma, type PrismaClient } from "@prisma/client";
import { textFromContentBlocks } from "../../../domain/modelRunEvents";
import { projectMemoryHistorySourceText } from "../history/safety";
import { redactMemorySecrets } from "../explicit/safety";
import { memorySha256 } from "../persistence/lexical";
import type { MemoryMaintenanceSource } from "./policy";

type ContextItem = NonNullable<MemoryMaintenanceSource["context"]>[number];
export type MemoryMaintenanceContextSpan = Readonly<{ messageId: string; startOffset: number; endOffset: number }>;
type TextWindow = Readonly<{ start: number; end: number }>;

/** Provider context bounds in UTF-16 code units: one message, all source
 * windows together, and the whole context of one source. */
const MESSAGE_CHARACTERS = 8_000;
const SOURCE_WINDOW_CHARACTERS = 12_000;
const CONTEXT_CHARACTERS = 16_000;
const MAX_DEPENDENCIES = 6;
const ELLIPSIS = "…";

/** A window boundary never splits a UTF-16 surrogate pair. */
function boundary(text: string, offset: number, direction: 1 | -1): number {
  const bounded = Math.min(text.length, Math.max(0, offset));
  if (bounded <= 0 || bounded >= text.length) return bounded;
  const code = text.charCodeAt(bounded);
  const previous = text.charCodeAt(bounded - 1);
  return code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff ? bounded + direction : bounded;
}

/** At most `budget` code units around this message's evidence spans, which
 * stay whole when they fit. Offsets index the provider-safe projection. */
export function memoryMaintenanceEvidenceWindow(
  text: string, spans: readonly Readonly<{ startOffset: number; endOffset: number }>[], budget: number
): TextWindow {
  if (text.length <= budget) return { start: 0, end: text.length };
  const low = spans.length ? Math.min(text.length, Math.max(0, Math.min(...spans.map(({ startOffset }) => startOffset)))) : 0;
  const high = spans.length ? Math.min(text.length, Math.max(low, ...spans.map(({ endOffset }) => endOffset))) : low;
  const end = Math.min(text.length, Math.max(0, low - Math.floor(Math.max(0, budget - (high - low)) / 2)) + budget);
  return { start: boundary(text, Math.max(0, end - budget), 1), end: boundary(text, end, -1) };
}

/** The last `budget` code units: the part of a preceding text nearest the source. */
export function memoryMaintenanceTailWindow(text: string, budget: number): TextWindow {
  if (text.length <= budget) return { start: 0, end: text.length };
  return { start: boundary(text, text.length - budget, 1), end: text.length };
}

function excerpt(text: string, window: TextWindow): string {
  return `${window.start > 0 ? ELLIPSIS : ""}${text.slice(window.start, window.end)}${window.end < text.length ? ELLIPSIS : ""}`;
}

/** Direct evidence supplies testimony. Surrounding text only resolves scope,
 * reference, and explicit intent; assistant text cannot supply personal facts.
 * Null means the context cannot be shown safely: the source is unreviewable. */
export async function loadMemoryMaintenanceContext(client: Pick<PrismaClient, "$queryRaw">,
  userId: string, versionId: string, spans: readonly MemoryMaintenanceContextSpan[]): Promise<readonly ContextItem[] | null> {
  const messageIds = [...new Set(spans.map(({ messageId }) => messageId))];
  if (messageIds.length === 0) return null;
  const rows = await client.$queryRaw<Array<{
    id: string; role: string; content: Prisma.JsonValue; updatedAt: Date; createdAt: Date; depth: number; eligible: boolean;
  }>>(Prisma.sql`
    WITH RECURSIVE context_message AS (
      SELECT message.id, message."chatId", message."parentMessageId", message.role, message.content, message."updatedAt", message."createdAt", 0 AS depth, TRUE AS eligible
      FROM "Message" message JOIN "Chat" chat ON chat.id = message."chatId"
      WHERE chat."userId" = ${userId} AND chat."projectId" IS NULL AND chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
        AND chat."permanentDeletionAt" IS NULL AND message.id IN (${Prisma.join(messageIds)}) AND message.status = 'complete'
        AND aiqsa_memory_message_dependency_valid(${userId}, message.id, message."updatedAt")
      UNION ALL
      SELECT parent.id, parent."chatId", parent."parentMessageId", parent.role,
        CASE WHEN aiqsa_memory_message_dependency_valid(${userId}, parent.id, parent."updatedAt") THEN parent.content ELSE NULL::jsonb END,
        parent."updatedAt", parent."createdAt", child.depth + 1,
        aiqsa_memory_message_dependency_valid(${userId}, parent.id, parent."updatedAt") AS eligible
      FROM "Message" parent JOIN context_message child ON parent.id = child."parentMessageId" AND parent."chatId" = child."chatId"
      WHERE child.depth < 4 AND child.eligible
    ) SELECT DISTINCT ON (id) id, role, content, "updatedAt", "createdAt", depth, eligible FROM context_message ORDER BY id, depth
  `);
  // A hidden boundary might carry the scope or explicit remember intent of a
  // fragment. Skip this review instead of making a destructive judgment from
  // incomplete context; never traverse or disclose the denied message.
  if (rows.some(({ eligible }) => !eligible) || new Set(rows.filter(({ depth }) => depth === 0)
    .map(({ id }) => id)).size !== messageIds.length) return null;
  const messages: Array<{ row: (typeof rows)[number]; text: string; window?: TextWindow }> = [];
  for (const row of rows.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    const projected = projectMemoryHistorySourceText(textFromContentBlocks(row.content as { blocks?: unknown[] }));
    if (!projected.eligible || projected.processingState !== "COMPLETE" || projected.providerSafeText === null) return null;
    messages.push({ row, text: projected.providerSafeText });
  }
  // A source removed by automatic cleanup has no text left. While its fences
  // hold (aiqsa_memory_fact_dependencies_valid below) it stays a valid hint
  // and is omitted here; it never leaves the dependent unreviewable.
  const dependencies = await client.$queryRaw<Array<{
    id: string; sourceMessageId: string | null; sourceMessageContentHash: string | null;
    sourceMessageUpdatedAt: Date | null; sourceFactVersionId: string | null; content: Prisma.JsonValue | null;
    role: string | null; statement: string | null;
  }>>(Prisma.sql`
    SELECT dep.id, dep."sourceMessageId", dep."sourceMessageContentHash", dep."sourceMessageUpdatedAt", dep."sourceFactVersionId",
      message.content, message.role, version."displayText" AS statement
    FROM "MemoryFactVersionSourceDependency" dep
    LEFT JOIN "Message" message ON message.id = dep."sourceMessageId"
    LEFT JOIN "MemoryFactVersion" version ON version."userId" = dep."userId" AND version.id = dep."sourceFactVersionId"
    WHERE dep."userId" = ${userId} AND dep."targetFactVersionId" = ${versionId}
      AND (dep."sourceFactVersionId" IS NULL
        OR NOT aiqsa_memory_dependency_source_removed(${userId}, dep."sourceFactVersionId"))
      AND aiqsa_memory_fact_dependencies_valid(${userId}, ${versionId}) ORDER BY dep.id LIMIT ${MAX_DEPENDENCIES + 1}
  `);
  if (dependencies.length > MAX_DEPENDENCIES) return null;
  const references: Array<{ dependency: (typeof dependencies)[number]; text: string; window?: TextWindow }> = [];
  for (const dependency of dependencies) {
    const projected = dependency.sourceMessageId
      ? projectMemoryHistorySourceText(textFromContentBlocks(dependency.content as { blocks?: unknown[] })) : null;
    if (dependency.sourceMessageId && (!projected?.eligible || projected.processingState !== "COMPLETE" ||
      memorySha256(projected.providerSafeText) !== dependency.sourceMessageContentHash)) return null;
    const text = projected?.eligible ? projected.providerSafeText : dependency.statement
      ? redactMemorySecrets(dependency.statement).redactedText : null;
    if (!text) return null;
    references.push({ dependency, text });
  }
  // Budget order: source windows, then dependencies, then preceding messages
  // nearest the source. A preceding chain keeps its tail; the far end is cut.
  let remaining = CONTEXT_CHARACTERS;
  const sources = messages.filter(({ row }) => row.depth === 0);
  const sourceBudget = Math.min(MESSAGE_CHARACTERS, Math.floor(SOURCE_WINDOW_CHARACTERS / sources.length));
  for (const source of sources) {
    source.window = memoryMaintenanceEvidenceWindow(source.text, spans.filter(({ messageId }) => messageId === source.row.id), sourceBudget);
    remaining -= source.window.end - source.window.start;
  }
  for (const reference of references) {
    const budget = Math.min(MESSAGE_CHARACTERS, remaining);
    if (budget <= 0) break;
    reference.window = reference.dependency.sourceMessageId ? memoryMaintenanceTailWindow(reference.text, budget)
      : { start: 0, end: boundary(reference.text, Math.min(reference.text.length, budget), -1) };
    remaining -= reference.window.end - reference.window.start;
  }
  for (const preceding of messages.filter(({ row }) => row.depth > 0)
    .sort((left, right) => left.row.depth - right.row.depth || right.row.createdAt.getTime() - left.row.createdAt.getTime())) {
    const budget = Math.min(MESSAGE_CHARACTERS, remaining);
    if (budget <= 0) break;
    preceding.window = memoryMaintenanceTailWindow(preceding.text, budget);
    remaining -= preceding.window.end - preceding.window.start;
  }
  const contexts: ContextItem[] = messages.flatMap(({ row, text, window }) => {
    if (!window) return [];
    const shown = excerpt(text, window);
    return [{ kind: row.depth === 0 ? "SOURCE_MESSAGE" as const : "REFERENCE_MESSAGE" as const, role: row.role,
      text: shown, observedAt: row.createdAt.toISOString(),
      identityHash: memorySha256({ id: row.id, updatedAt: row.updatedAt, depth: row.depth, text: shown,
        window: { start: window.start, end: window.end } }) }];
  });
  for (const { dependency, text, window } of references) {
    if (!window) continue;
    const shown = excerpt(text, window);
    contexts.push({ kind: dependency.sourceMessageId ? "REFERENCE_MESSAGE" : "FACT_DEPENDENCY", role: dependency.role ?? "memory",
      text: shown, identityHash: memorySha256({ ...dependency, content: undefined, text: shown,
        window: { start: window.start, end: window.end } }) });
  }
  return contexts;
}
