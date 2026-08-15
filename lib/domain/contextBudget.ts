export const DEFAULT_CONTEXT_SAFETY_MARGIN_RATIO = 0.1;

const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

export type ApproxTokenCodePointCount = Readonly<{
  codePoint: number;
  occurrences: number;
}>;

export type ApproxTokenProjectedPart =
  | Readonly<{
      counts: readonly ApproxTokenCodePointCount[];
      kind: "code_points";
    }>
  | Readonly<{
      kind: "value";
      value: unknown;
    }>;

export type ContextBudgetMessage = {
  content: {
    blocks: unknown[];
  };
  id: string;
  role: "assistant" | "user";
};

export type ContextTruncationSummary = {
  approxDroppedTokens: number;
  approxFinalTokens: number;
  approxOriginalTokens: number;
  budgetTokens: number;
  contextWindow: number;
  droppedMessages: number;
  keptMessages: number;
  maxOutputTokens: number;
  safetyMarginTokens: number;
};

export type ContextBudgetInput = {
  contextWindow: number;
  maxOutputTokens?: number;
  messageExtraTokens?: Record<string, number>;
  messages: ContextBudgetMessage[];
  prompt?: {
    developer?: string | null;
    system?: string | null;
  };
  safetyMarginRatio?: number;
};

export type ContextBudgetLimits = {
  budgetTokens: number;
  contextWindow: number;
  maxOutputTokens: number;
  safetyMarginTokens: number;
};

export type ContextBudgetResult =
  | {
      approxFinalTokens: number;
      budgetTokens: number;
      messages: ContextBudgetMessage[];
      ok: true;
      truncation: ContextTruncationSummary | null;
    }
  | {
      approxCurrentTokens: number;
      approxPromptTokens: number;
      budgetTokens: number;
      code: "context_too_large";
      contextWindow: number;
      maxOutputTokens: number;
      ok: false;
      safetyMarginTokens: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyForEstimate(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (isRecord(value) && Array.isArray(value.blocks)) {
    return value.blocks
      .map((block) => {
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
          return block.text;
        }

        return JSON.stringify(block) ?? "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return JSON.stringify(value) ?? "";
}

export function estimateApproxTokens(value: unknown): number {
  const text = stringifyForEstimate(value);
  return text ? Math.ceil(approximateTokenUnits(text)) : 0;
}

function approximateTokenWeight(codePoint: number): number {
  if (codePoint <= 0x7f) return 0.25;
  return EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(codePoint)) ? 2 : 1;
}

function approximateTokenUnits(text: string): number {
  let estimatedTokens = 0;
  for (const character of text) {
    estimatedTokens += approximateTokenWeight(character.codePointAt(0) ?? 0);
  }
  return estimatedTokens;
}

function approximateTokenUnitsFromCodePointCounts(
  counts: readonly ApproxTokenCodePointCount[]
): Readonly<{ occurrences: number; units: number }> {
  let occurrences = 0;
  let units = 0;
  for (const count of counts) {
    if (
      !Number.isSafeInteger(count.codePoint) ||
      count.codePoint < 0 ||
      count.codePoint > 0x10ffff ||
      !Number.isSafeInteger(count.occurrences) ||
      count.occurrences <= 0
    ) {
      continue;
    }
    occurrences += count.occurrences;
    units += approximateTokenWeight(count.codePoint) * count.occurrences;
  }
  return { occurrences, units };
}

export function estimateApproxTokensFromProjectedParts(
  parts: readonly ApproxTokenProjectedPart[]
): number {
  let estimatedTokens = 0;
  let projectedParts = 0;
  for (const part of parts) {
    const projection = part.kind === "code_points"
      ? approximateTokenUnitsFromCodePointCounts(part.counts)
      : (() => {
          const text = JSON.stringify(part.value) ?? "";
          return { occurrences: text ? 1 : 0, units: approximateTokenUnits(text) };
        })();
    if (projection.occurrences === 0) continue;
    if (projectedParts > 0) {
      estimatedTokens += approximateTokenWeight("\n".codePointAt(0)!);
    }
    estimatedTokens += projection.units;
    projectedParts += 1;
  }
  return Math.ceil(estimatedTokens);
}

export function calculateContextBudgetLimits({
  contextWindow,
  maxOutputTokens = 0,
  provider,
  safetyMarginRatio = DEFAULT_CONTEXT_SAFETY_MARGIN_RATIO
}: Pick<ContextBudgetInput, "contextWindow" | "maxOutputTokens" | "safetyMarginRatio"> & {
  provider?: string;
}): ContextBudgetLimits {
  const normalizedContextWindow = Math.max(0, Math.floor(contextWindow));
  const requestedMaxOutputTokens = Math.max(0, Math.floor(maxOutputTokens));
  const normalizedMaxOutputTokens =
    provider === "fake" && requestedMaxOutputTokens >= normalizedContextWindow ? 0 : requestedMaxOutputTokens;
  const safetyMarginTokens = Math.floor(normalizedContextWindow * safetyMarginRatio);

  return {
    budgetTokens: Math.max(0, normalizedContextWindow - normalizedMaxOutputTokens - safetyMarginTokens),
    contextWindow: normalizedContextWindow,
    maxOutputTokens: normalizedMaxOutputTokens,
    safetyMarginTokens
  };
}

function extraTokensForMessage(input: ContextBudgetInput, message: ContextBudgetMessage): number {
  const value = input.messageExtraTokens?.[message.id] ?? 0;

  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

function messageTokens(input: ContextBudgetInput, message: ContextBudgetMessage): number {
  return estimateApproxTokens(message.content) + extraTokensForMessage(input, message);
}

function promptTokens(prompt: ContextBudgetInput["prompt"]): number {
  return estimateApproxTokens(prompt?.system ?? "") + estimateApproxTokens(prompt?.developer ?? "");
}

function groupPriorTurns(messages: ContextBudgetMessage[]): ContextBudgetMessage[][] {
  const groups: ContextBudgetMessage[][] = [];
  let current: ContextBudgetMessage[] = [];

  for (const message of messages) {
    if (message.role === "user" && current.length > 0) {
      groups.push(current);
      current = [message];
      continue;
    }

    current.push(message);
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function applyContextBudget(input: ContextBudgetInput): ContextBudgetResult {
  if (!Number.isFinite(input.contextWindow) || input.contextWindow <= 0 || input.messages.length === 0) {
    return {
      approxFinalTokens: 0,
      budgetTokens: Number.POSITIVE_INFINITY,
      messages: input.messages,
      ok: true,
      truncation: null
    };
  }

  const { budgetTokens, contextWindow, maxOutputTokens, safetyMarginTokens } = calculateContextBudgetLimits(input);
  const estimatedPromptTokens = promptTokens(input.prompt);
  const tokenCounts = input.messages.map((message) => messageTokens(input, message));
  const approxOriginalTokens = estimatedPromptTokens + sum(tokenCounts);

  if (approxOriginalTokens <= budgetTokens) {
    return {
      approxFinalTokens: approxOriginalTokens,
      budgetTokens,
      messages: input.messages,
      ok: true,
      truncation: null
    };
  }

  const currentMessage = input.messages[input.messages.length - 1];
  const currentTokens = tokenCounts[tokenCounts.length - 1] ?? 0;
  const irreducibleTokens = estimatedPromptTokens + currentTokens;

  if (irreducibleTokens > budgetTokens) {
    return {
      approxCurrentTokens: currentTokens,
      approxPromptTokens: estimatedPromptTokens,
      budgetTokens,
      code: "context_too_large",
      contextWindow,
      maxOutputTokens,
      ok: false,
      safetyMarginTokens
    };
  }

  const priorMessages = input.messages.slice(0, -1);
  const priorGroups = groupPriorTurns(priorMessages);
  const groupTokenCounts = priorGroups.map((group) => sum(group.map((message) => messageTokens(input, message))));
  let usedTokens = irreducibleTokens;
  let firstKeptGroupIndex = priorGroups.length;

  for (let index = priorGroups.length - 1; index >= 0; index -= 1) {
    const nextTokens = groupTokenCounts[index] ?? 0;

    if (usedTokens + nextTokens > budgetTokens) {
      break;
    }

    usedTokens += nextTokens;
    firstKeptGroupIndex = index;
  }

  const keptPriorMessages = priorGroups.slice(firstKeptGroupIndex).flat();
  const droppedGroups = priorGroups.slice(0, firstKeptGroupIndex);
  const droppedMessages = droppedGroups.flat();
  const approxDroppedTokens = sum(droppedGroups.flatMap((group) => group.map((message) => messageTokens(input, message))));
  const messages = [...keptPriorMessages, currentMessage];

  return {
    approxFinalTokens: usedTokens,
    budgetTokens,
    messages,
    ok: true,
    truncation: {
      approxDroppedTokens,
      approxFinalTokens: usedTokens,
      approxOriginalTokens,
      budgetTokens,
      contextWindow,
      droppedMessages: droppedMessages.length,
      keptMessages: messages.length,
      maxOutputTokens,
      safetyMarginTokens
    }
  };
}
