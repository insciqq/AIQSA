import { textFromContentBlocks } from "../../../domain/modelRunEvents";

export const MEMORY_ACTION_PLAN_VERSION = "memory-action-plan-v1" as const;

export type MemoryActionPlan =
  | Readonly<{
      kind: "LIST";
      query: string | null;
      version: typeof MEMORY_ACTION_PLAN_VERSION;
    }>
  | Readonly<{
      kind: "SAVE";
      sourceEnd: number;
      sourceStart: number;
      statement: string;
      version: typeof MEMORY_ACTION_PLAN_VERSION;
    }>
  | Readonly<{
      kind: "UPDATE";
      replacement: string;
      sourceEnd: number;
      sourceStart: number;
      targetQuery: string;
      version: typeof MEMORY_ACTION_PLAN_VERSION;
    }>
  | Readonly<{
      kind: "FORGET";
      sourceEnd: number;
      sourceStart: number;
      targetQuery: string;
      version: typeof MEMORY_ACTION_PLAN_VERSION;
    }>
  | Readonly<{
      kind: "MARK_INCORRECT";
      sourceEnd: number;
      sourceStart: number;
      targetQuery: string;
      version: typeof MEMORY_ACTION_PLAN_VERSION;
    }>;

export type MemoryActionIntent =
  | Readonly<{ kind: "AMBIGUOUS" }>
  | Readonly<{ kind: "NONE" }>
  | MemoryActionPlan;

const maximumStatementLength = 2_000;
const maximumQueryLength = 500;

function boundedText(value: string, maximumLength: number): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximumLength && !trimmed.includes("\u0000")
    ? trimmed
    : null;
}

function captureSpan(
  match: RegExpExecArray,
  captureOrdinal: number
): Readonly<{ sourceEnd: number; sourceStart: number }> | null {
  const indices = match.indices?.[captureOrdinal];
  return indices && indices[0] >= 0 && indices[1] > indices[0]
    ? { sourceEnd: indices[1], sourceStart: indices[0] }
    : null;
}

function directCommandSource(value: string): boolean {
  const trimmed = value.trimStart();
  return !/^["'`>«“‘]/u.test(trimmed) && !/^[-*]\s/u.test(trimmed);
}

function matchCommand(
  source: string,
  patterns: readonly RegExp[]
): RegExpExecArray | null {
  if (!directCommandSource(source)) return null;
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match) return match;
  }
  return null;
}

const savePatterns = [
  /^\s*\/remember\s+(.+?)\s*$/disu,
  /^\s*(?:please\s+)?remember(?:\s+that)?[,\s]+(.+?)\s*$/disu,
  /^\s*(?:пожалуйста[,\s]+)?запомни(?:[,\s]+что)?[,\s]+(.+?)\s*$/disu
] as const;

const forgetPatterns = [
  /^\s*\/forget\s+(.+?)\s*$/disu,
  /^\s*(?:please\s+)?forget(?:\s+(?:that|the\s+memory\s+that|my\s+memory\s+that))?[,\s]+(.+?)\s*$/disu,
  /^\s*(?:пожалуйста[,\s]+)?забудь(?:[,\s]+что|\s+память\s+о\s+том[,\s]+что)?[,\s]+(.+?)\s*$/disu
] as const;

const incorrectPatterns = [
  /^\s*\/memory-incorrect\s+(.+?)\s*$/disu,
  /^\s*(?:please\s+)?mark\s+(?:the\s+)?memory(?:\s+that)?[,\s]+(.+?)\s+as\s+incorrect\s*$/disu,
  /^\s*(?:пожалуйста[,\s]+)?пометь\s+воспоминание(?:\s+о\s+том[,\s]+что)?[,\s]+(.+?)\s+как\s+неверное\s*$/disu
] as const;

const updatePatterns = [
  /^\s*\/update-memory\s+(.+?)\s*=>\s*(.+?)\s*$/disu,
  /^\s*(?:please\s+)?update(?:\s+the)?\s+memory(?:\s+that)?[,\s]+(.+?)\s+to\s+(.+?)\s*$/disu,
  /^\s*(?:пожалуйста[,\s]+)?обнови\s+память(?:\s+о\s+том[,\s]+что)?[,\s]+(.+?)\s+(?:на|так[,\s]+чтобы)\s+(.+?)\s*$/disu
] as const;

const exactListPatterns = [
  /^\s*what\s+do\s+you\s+remember(?:\s+about\s+me)?[?.!\s]*$/iu,
  /^\s*(?:show|list)\s+(?:me\s+)?my\s+(?:saved\s+)?memories[?.!\s]*$/iu,
  /^\s*что\s+ты\s+помнишь(?:\s+обо\s+мне)?[?.!\s]*$/iu,
  /^\s*(?:покажи|перечисли)\s+(?:мои\s+)?(?:сохран[её]нные\s+)?воспоминания[?.!\s]*$/iu
] as const;

const queriedListPatterns = [
  /^\s*do\s+you\s+remember\s+(.+?)[?.!\s]*$/isu,
  /^\s*what\s+do\s+you\s+remember\s+about\s+(.+?)[?.!\s]*$/isu,
  /^\s*ты\s+помнишь\s+(.+?)[?.!\s]*$/isu,
  /^\s*что\s+ты\s+помнишь\s+(?:о|про)\s+(.+?)[?.!\s]*$/isu
] as const;

const ambiguousManagementPatterns = [
  /^\s*(?:remember|save\s+this|remember\s+this)[?.!\s]*$/iu,
  /^\s*(?:forget\s+it|forget\s+this|update\s+my\s+memory)[?.!\s]*$/iu,
  /^\s*(?:mark\s+(?:this\s+)?memory\s+incorrect)[?.!\s]*$/iu,
  /^\s*(?:запомни|запомни\s+это|забудь|забудь\s+это|обнови\s+память|пометь\s+воспоминание\s+как\s+неверное)[?.!\s]*$/iu
] as const;

/**
 * Recognizes only an anchored command or question in the direct current-user
 * message. Quoted, bulleted, retrieved, Assistant, and prior-turn text never
 * reaches this classifier as mutation authority.
 */
export function planMemoryActionFromText(source: string): MemoryActionIntent {
  if (!source.trim()) return { kind: "NONE" };
  if (ambiguousManagementPatterns.some((pattern) => pattern.test(source))) {
    return { kind: "AMBIGUOUS" };
  }

  const update = matchCommand(source, updatePatterns);
  if (update) {
    const targetQuery = boundedText(update[1] ?? "", maximumQueryLength);
    const replacement = boundedText(update[2] ?? "", maximumStatementLength);
    const span = captureSpan(update, 1);
    if (!targetQuery || !replacement || !span) return { kind: "AMBIGUOUS" };
    return {
      kind: "UPDATE",
      replacement,
      ...span,
      targetQuery,
      version: MEMORY_ACTION_PLAN_VERSION
    };
  }

  const save = matchCommand(source, savePatterns);
  if (save) {
    const statement = boundedText(save[1] ?? "", maximumStatementLength);
    const span = captureSpan(save, 1);
    if (!statement || !span) return { kind: "AMBIGUOUS" };
    return {
      kind: "SAVE",
      ...span,
      statement,
      version: MEMORY_ACTION_PLAN_VERSION
    };
  }

  const incorrect = matchCommand(source, incorrectPatterns);
  if (incorrect) {
    const targetQuery = boundedText(incorrect[1] ?? "", maximumQueryLength);
    const span = captureSpan(incorrect, 1);
    if (!targetQuery || !span) return { kind: "AMBIGUOUS" };
    return {
      kind: "MARK_INCORRECT",
      ...span,
      targetQuery,
      version: MEMORY_ACTION_PLAN_VERSION
    };
  }

  const forget = matchCommand(source, forgetPatterns);
  if (forget) {
    const targetQuery = boundedText(forget[1] ?? "", maximumQueryLength);
    const span = captureSpan(forget, 1);
    if (!targetQuery || !span) return { kind: "AMBIGUOUS" };
    return {
      kind: "FORGET",
      ...span,
      targetQuery,
      version: MEMORY_ACTION_PLAN_VERSION
    };
  }

  if (exactListPatterns.some((pattern) => pattern.test(source))) {
    return { kind: "LIST", query: null, version: MEMORY_ACTION_PLAN_VERSION };
  }
  const queriedList = matchCommand(source, queriedListPatterns);
  if (queriedList) {
    const query = boundedText(queriedList[1] ?? "", maximumQueryLength);
    return query
      ? { kind: "LIST", query, version: MEMORY_ACTION_PLAN_VERSION }
      : { kind: "AMBIGUOUS" };
  }

  return { kind: "NONE" };
}

export function planMemoryAction(
  content: Readonly<{ blocks: readonly unknown[] }>
): MemoryActionIntent {
  return planMemoryActionFromText(textFromContentBlocks({ blocks: [...content.blocks] }));
}

export function decodeMemoryActionPlan(value: unknown): MemoryActionPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== MEMORY_ACTION_PLAN_VERSION) return null;
  if (candidate.kind === "LIST") {
    return (candidate.query === null ||
      typeof candidate.query === "string" && boundedText(candidate.query, maximumQueryLength) !== null)
      ? candidate as MemoryActionPlan
      : null;
  }
  const validSpan = Number.isSafeInteger(candidate.sourceStart) &&
    Number.isSafeInteger(candidate.sourceEnd) &&
    (candidate.sourceStart as number) >= 0 &&
    (candidate.sourceEnd as number) > (candidate.sourceStart as number);
  if (!validSpan) return null;
  if (candidate.kind === "SAVE") {
    return typeof candidate.statement === "string" &&
      boundedText(candidate.statement, maximumStatementLength) === candidate.statement
      ? candidate as MemoryActionPlan
      : null;
  }
  if (candidate.kind === "FORGET" || candidate.kind === "MARK_INCORRECT") {
    return typeof candidate.targetQuery === "string" &&
      boundedText(candidate.targetQuery, maximumQueryLength) === candidate.targetQuery
      ? candidate as MemoryActionPlan
      : null;
  }
  if (candidate.kind === "UPDATE") {
    return typeof candidate.targetQuery === "string" &&
      boundedText(candidate.targetQuery, maximumQueryLength) === candidate.targetQuery &&
      typeof candidate.replacement === "string" &&
      boundedText(candidate.replacement, maximumStatementLength) === candidate.replacement
      ? candidate as MemoryActionPlan
      : null;
  }
  return null;
}
