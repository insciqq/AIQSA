import {
  applyContextBudget,
  calculateContextBudgetLimits,
  estimateApproxTokens,
  type ContextTruncationSummary
} from "../../domain/contextBudget";
import { maxOutputTokensFromParams } from "../../domain/providerParams";
import { takeUtf16SafePrefix } from "../../domain/utf16";
import {
  providerAttachmentBudgetTokens,
  providerAttachmentTextLabel,
  truncateProviderAttachmentText
} from "../providers/attachmentPayload";
import {
  KNOWLEDGE_ANSWER_CONTRACT_V1,
  KNOWLEDGE_TOOL_LOOP_CONTRACT_V2,
  MEMORY_READER_CONTRACT_CURRENT,
  knowledgeToolLoopContract
} from "../providers/personalContext";
import { memoryActionAnswerContract } from "../providers/memoryActionAnswer";
import {
  KNOWLEDGE_ANSWER_DRAFT_CONTRACT_V7,
  KNOWLEDGE_ANSWER_DRAFT_CONTRACT_V8
} from "../knowledge/answerGroundingV5";
import type {
  NormalizedRunRequest,
  ProviderConversationMessage,
  ProviderModelCapabilities,
  ProviderRunRequest
} from "../providers/types";
import type { ProviderToolBridge } from "../tools/types";
import { getAttachmentTextConfig } from "../uploads/attachmentTextConfig";

// Matches the former 20,000-character ASCII ceiling under the shared
// estimator, but applies once across every selected text attachment and is
// therefore conservative for multilingual text and multi-file requests.
export const UNKNOWN_CONTEXT_ATTACHMENT_TEXT_BUDGET_TOKENS = 5_000;

function knowledgeAnswerDraftContractText(version: 7 | 8 | undefined): string | null {
  return version === 8
    ? KNOWLEDGE_ANSWER_DRAFT_CONTRACT_V8
    : version === 7
      ? KNOWLEDGE_ANSWER_DRAFT_CONTRACT_V7
      : null;
}

function maxOutputTokensForBudget(
  params: Readonly<Record<string, unknown>>,
  capabilities: ProviderModelCapabilities,
  provider: string
): number {
  let selectedMaxOutputTokens = capabilities.defaultMaxOutputTokens ?? 0;

  const requestedMaxOutputTokens = maxOutputTokensFromParams(params);
  if (requestedMaxOutputTokens !== undefined) {
    selectedMaxOutputTokens = Math.floor(requestedMaxOutputTokens);
  }

  if (
    provider === "fake" &&
    typeof capabilities.contextWindow === "number" &&
    capabilities.contextWindow > 0 &&
    selectedMaxOutputTokens >= capabilities.contextWindow
  ) {
    return 0;
  }

  return selectedMaxOutputTokens;
}

export type RunContextBudgetResult =
  | Readonly<{
      context: NonNullable<NormalizedRunRequest["context"]>;
      contextTruncation: ContextTruncationSummary | null;
      ok: true;
    }>
  | Readonly<{
      error: Readonly<{
        code: "context_too_large";
        message: string;
      }>;
      ok: false;
      status: 400;
    }>;

export function applyRunContextBudget(input: Readonly<{
  contextMessages: ProviderConversationMessage[];
  messageExtraTokens?: Record<string, number>;
  modelCapabilities: ProviderModelCapabilities;
  params: Readonly<Record<string, unknown>>;
  prompt: NormalizedRunRequest["prompt"];
  provider: string;
}>): RunContextBudgetResult {
  const internalContextMessages = input.contextMessages.filter(
    (message) => message.purpose !== undefined
  );
  const budgetMessages = input.contextMessages.filter(
    (message) => message.purpose === undefined
  );
  const currentMessage = budgetMessages.at(-1);
  const internalContextTokens = internalContextMessages.reduce((total, message) => {
    const extra = input.messageExtraTokens?.[message.id] ?? 0;
    return total + estimateApproxTokens(message.content) +
      (Number.isFinite(extra) && extra > 0 ? Math.ceil(extra) : 0);
  }, 0);
  const messageExtraTokens = currentMessage && internalContextTokens > 0
    ? {
        ...input.messageExtraTokens,
        [currentMessage.id]:
          (Number.isFinite(input.messageExtraTokens?.[currentMessage.id]) &&
          (input.messageExtraTokens?.[currentMessage.id] ?? 0) > 0
            ? Math.ceil(input.messageExtraTokens![currentMessage.id]!)
            : 0) + internalContextTokens
      }
    : input.messageExtraTokens;
  const budget = applyContextBudget({
    contextWindow: input.modelCapabilities.contextWindow ?? 0,
    maxOutputTokens: maxOutputTokensForBudget(input.params, input.modelCapabilities, input.provider),
    messageExtraTokens,
    messages: budgetMessages,
    prompt: {
      developer: [
        input.prompt.developer,
        input.prompt.memoryActionAnswerResult
          ? memoryActionAnswerContract(input.prompt.memoryActionAnswerResult)
          : null,
        input.prompt.knowledgeAnswerContract === 1 ? KNOWLEDGE_ANSWER_CONTRACT_V1 : null,
        knowledgeAnswerDraftContractText(input.prompt.knowledgeAnswerDraftContract)
      ].filter((value): value is string => Boolean(value?.trim())).join("\n\n") || null,
      system: input.prompt.system
    }
  });

  if (!budget.ok) {
    return {
      error: {
        code: "context_too_large",
        message: internalContextMessages.length > 0
          ? `Prompt, selected private context, and current message exceed the model context budget (${budget.budgetTokens} estimated tokens available). Reduce selected context or choose a model with a larger context window.`
          : `Prompt and current message exceed the model context budget (${budget.budgetTokens} estimated tokens available).`
      },
      ok: false,
      status: 400
    };
  }

  const messages = internalContextMessages.length > 0 && budget.messages.length > 0
    ? [
        ...budget.messages.slice(0, -1),
        ...internalContextMessages,
        budget.messages.at(-1)!
      ]
    : budget.messages;
  const truncation = budget.truncation
    ? {
        ...budget.truncation,
        keptMessages: budget.truncation.keptMessages + internalContextMessages.length
      }
    : null;
  const context: NonNullable<NormalizedRunRequest["context"]> = {
    messages,
    mode: "branch_path"
  };

  if (truncation) {
    context.summary = {
      truncation
    };
  }

  return {
    context,
    contextTruncation: truncation,
    ok: true
  };
}

/** Returns the bounded room for a future Personal Memory block after the
 * admitted model's output reserve, safety margin, trusted prompt, current
 * message, and non-droppable internal context. Provider-specific attachments
 * and serialized tools remain subject to the final exact request budget. */
export function normalizedRequestPersonalContextTokenLimit(
  request: NormalizedRunRequest
): number | null {
  const contextWindow = request.modelCapabilities.contextWindow;
  if (!Number.isFinite(contextWindow) || Number(contextWindow) <= 0) return null;
  const limits = calculateContextBudgetLimits({
    contextWindow: Number(contextWindow),
    maxOutputTokens: maxOutputTokensForBudget(
      request.params,
      request.modelCapabilities,
      request.provider
    ),
    provider: request.provider
  });
  const promptTokens = estimateApproxTokens(request.prompt.system ?? "") +
    estimateApproxTokens(request.prompt.developer ?? "") +
    estimateApproxTokens(MEMORY_READER_CONTRACT_CURRENT) +
    (request.prompt.memoryActionAnswerResult
      ? estimateApproxTokens(memoryActionAnswerContract(
          request.prompt.memoryActionAnswerResult
        ))
      : 0) +
    (request.prompt.knowledgeAnswerContract === 1
      ? estimateApproxTokens(KNOWLEDGE_ANSWER_CONTRACT_V1)
      : 0) +
    estimateApproxTokens(
      knowledgeAnswerDraftContractText(request.prompt.knowledgeAnswerDraftContract) ?? ""
    ) +
    (request.knowledgePlan.mode !== "none"
      ? estimateApproxTokens(KNOWLEDGE_TOOL_LOOP_CONTRACT_V2)
      : 0);
  const contextMessages = request.context?.messages ?? [];
  const internalTokens = contextMessages
    .filter((message) => message.purpose !== undefined)
    .reduce((total, message) => total + estimateApproxTokens(message.content), 0);
  const currentMessage = contextMessages
    .filter((message) => message.purpose === undefined)
    .at(-1);
  const currentTokens = estimateApproxTokens(currentMessage?.content ?? request.content);
  return Math.max(0, limits.budgetTokens - promptTokens - internalTokens - currentTokens);
}

function cumulativeTruncationSummary(
  previous: ContextTruncationSummary | undefined,
  current: ContextTruncationSummary
): ContextTruncationSummary {
  if (!previous) return current;
  return {
    ...current,
    approxDroppedTokens: previous.approxDroppedTokens + current.approxDroppedTokens,
    approxOriginalTokens: previous.approxDroppedTokens + current.approxOriginalTokens,
    droppedMessages: previous.droppedMessages + current.droppedMessages
  };
}

export function providerFacingSerializedTools(
  request: ProviderRunRequest,
  bridge?: ProviderToolBridge
): Record<string, unknown>[] {
  if (!bridge) return [];
  return [
    ...(bridge.serializeHostedTools?.(request) ?? []),
    ...(request.tools ?? []).map((tool) => bridge.serializeTool(tool).tool)
  ];
}

export type ProviderRequestContextBudgetResult =
  | Readonly<{
      contextTruncation: ContextTruncationSummary | null;
      ok: true;
      request: ProviderRunRequest;
    }>
  | Readonly<{
      error: Readonly<{ code: "context_too_large"; message: string }>;
      ok: false;
      status: 400;
    }>;

function textModeAttachment(
  attachment: ProviderRunRequest["attachments"][number],
  capabilities: ProviderModelCapabilities
): boolean {
  return attachment.kind === "document" ||
    (attachment.kind === "pdf" && !capabilities.nativePdfInput);
}

function fitTextToTokenBudget(text: string, tokenBudget: number): string {
  if (estimateApproxTokens(text) <= tokenBudget) return text;
  const marker = "\n[truncated for model context]";
  const firstCharacter = String.fromCodePoint(text.codePointAt(0)!);
  const candidate = (length: number, withMarker: boolean) =>
    `${takeUtf16SafePrefix(text, length)}${withMarker ? marker : ""}`;
  const useMarker = estimateApproxTokens(`${firstCharacter}${marker}`) <= tokenBudget;
  let low = firstCharacter.length;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateApproxTokens(candidate(middle, useMarker)) <= tokenBudget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return candidate(low, useMarker);
}

type AttachmentTextFitResult =
  | Readonly<{ attachments: ProviderRunRequest["attachments"]; ok: true }>
  | Readonly<{ ok: false }>;

function fitProviderAttachmentText(input: Readonly<{
  fixedExtraTokens: number;
  request: ProviderRunRequest;
}>): AttachmentTextFitResult {
  const operatorMaxChars = getAttachmentTextConfig().extractedTextMaxChars;
  const attachments = input.request.attachments.map((attachment) => ({
    ...attachment,
    extractedText: attachment.extractedText
      ? truncateProviderAttachmentText(attachment.extractedText, operatorMaxChars)
      : null
  }));
  const textCandidates = attachments.flatMap((attachment, index) => {
    if (!textModeAttachment(attachment, input.request.modelCapabilities) || !attachment.extractedText?.trim()) {
      return [];
    }
    return [{
      index,
      labelTokens: estimateApproxTokens(`[${providerAttachmentTextLabel(attachment)}]\n`),
      minimumTokens: estimateApproxTokens(String.fromCodePoint(attachment.extractedText.codePointAt(0)!)),
      source: attachment.extractedText,
      sourceTokens: estimateApproxTokens(attachment.extractedText)
    }];
  });
  if (textCandidates.length === 0) return { attachments, ok: true };

  const contextWindow = input.request.modelCapabilities.contextWindow ?? 0;
  const labelTokens = textCandidates.reduce((total, candidate) => total + candidate.labelTokens, 0);
  let availableTextTokens: number;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    availableTextTokens = UNKNOWN_CONTEXT_ATTACHMENT_TEXT_BUDGET_TOKENS - labelTokens;
  } else {
    const limits = calculateContextBudgetLimits({
      contextWindow,
      maxOutputTokens: maxOutputTokensForBudget(
        input.request.params,
        input.request.modelCapabilities,
        input.request.provider
      ),
      provider: input.request.provider
    });
    const currentContent = input.request.context?.messages.at(-1)?.content ?? input.request.content;
    const promptTokens = estimateApproxTokens(input.request.prompt.system ?? "") +
      estimateApproxTokens(input.request.prompt.developer ?? "") +
      (input.request.prompt.memoryActionAnswerResult
        ? estimateApproxTokens(memoryActionAnswerContract(
            input.request.prompt.memoryActionAnswerResult
          ))
        : 0) +
      (input.request.prompt.knowledgeAnswerContract === 1
        ? estimateApproxTokens(KNOWLEDGE_ANSWER_CONTRACT_V1)
        : 0) +
      estimateApproxTokens(
        knowledgeAnswerDraftContractText(
          input.request.prompt.knowledgeAnswerDraftContract
        ) ?? ""
      );
    const internalContextTokens = (input.request.context?.messages ?? [])
      .filter((message) => message.purpose !== undefined)
      .reduce((total, message) => total + estimateApproxTokens(message.content), 0);
    const fixedAttachments = attachments.map((attachment) =>
      textModeAttachment(attachment, input.request.modelCapabilities)
        ? { ...attachment, extractedText: null }
        : attachment
    );
    const fixedTokens = promptTokens +
      estimateApproxTokens(currentContent) +
      internalContextTokens +
      input.fixedExtraTokens +
      providerAttachmentBudgetTokens({
        attachments: fixedAttachments,
        modelCapabilities: input.request.modelCapabilities
      });
    availableTextTokens = limits.budgetTokens - fixedTokens - labelTokens;
  }
  const minimumTokens = textCandidates.reduce(
    (total, candidate) => total + candidate.minimumTokens,
    0
  );
  if (availableTextTokens < minimumTokens) return { ok: false };

  const allocations = new Map(
    textCandidates.map((candidate) => [candidate.index, candidate.minimumTokens])
  );
  let remaining = availableTextTokens - minimumTokens;
  let active = textCandidates.filter(
    (candidate) => candidate.sourceTokens > candidate.minimumTokens
  );
  while (active.length > 0) {
    const share = Math.floor(remaining / active.length);
    if (share <= 0) break;
    const complete = active.filter(
      (candidate) => candidate.sourceTokens - allocations.get(candidate.index)! <= share
    );
    if (complete.length === 0) {
      for (const candidate of active) {
        allocations.set(candidate.index, allocations.get(candidate.index)! + share);
      }
      break;
    }
    for (const candidate of complete) {
      const previous = allocations.get(candidate.index)!;
      allocations.set(candidate.index, candidate.sourceTokens);
      remaining -= candidate.sourceTokens - previous;
    }
    const completedIndexes = new Set(complete.map((candidate) => candidate.index));
    active = active.filter((candidate) => !completedIndexes.has(candidate.index));
  }

  return {
    attachments: attachments.map((attachment, index) => {
      const allocated = allocations.get(index);
      return allocated === undefined || !attachment.extractedText
        ? attachment
        : { ...attachment, extractedText: fitTextToTokenBudget(attachment.extractedText, allocated) };
    }),
    ok: true
  };
}

/** Budgets the exact provider-facing client tools and retained tool transcript. */
export function applyProviderRequestContextBudget(input: Readonly<{
  bridge?: ProviderToolBridge;
  request: ProviderRunRequest;
}>): ProviderRequestContextBudgetResult {
  const contextMessages = input.request.context?.messages ?? [];
  const syntheticCurrentMessageId = "__provider-current-message__";
  const budgetMessages = contextMessages.length > 0
    ? contextMessages
    : [{
        content: input.request.content,
        id: syntheticCurrentMessageId,
        role: "user" as const
      }];
  const currentMessageId = budgetMessages.at(-1)?.id;
  const fixedExtraTokens =
    estimateApproxTokens(providerFacingSerializedTools(input.request, input.bridge)) +
    estimateApproxTokens(input.request.providerToolMessages ?? []) +
    estimateApproxTokens(input.request.personalContext?.text ?? "") +
    (input.request.personalContext
      ? estimateApproxTokens(MEMORY_READER_CONTRACT_CURRENT)
      : 0) +
    estimateApproxTokens(knowledgeToolLoopContract(input.request) ?? "");
  const attachmentFit = fitProviderAttachmentText({ fixedExtraTokens, request: input.request });
  if (!attachmentFit.ok) {
    return {
      error: {
        code: "context_too_large",
        message: "Prompt, current message, tools, and selected attachments exceed the model context budget."
      },
      ok: false,
      status: 400
    };
  }
  const fittedRequest = { ...input.request, attachments: attachmentFit.attachments };
  const providerExtras =
    providerAttachmentBudgetTokens({
      attachments: fittedRequest.attachments,
      modelCapabilities: fittedRequest.modelCapabilities
    }) + fixedExtraTokens;
  const budget = applyRunContextBudget({
    contextMessages: budgetMessages,
    messageExtraTokens:
      currentMessageId && providerExtras > 0
        ? { [currentMessageId]: providerExtras }
        : undefined,
    modelCapabilities: fittedRequest.modelCapabilities,
    params: fittedRequest.params,
    prompt: fittedRequest.prompt,
    provider: fittedRequest.provider
  });
  if (!budget.ok) return budget;

  if (contextMessages.length === 0) {
    return { contextTruncation: null, ok: true, request: fittedRequest };
  }

  const previous = input.request.context?.summary?.truncation;
  const contextTruncation = budget.contextTruncation
    ? cumulativeTruncationSummary(previous, budget.contextTruncation)
    : null;
  const effectiveTruncation = contextTruncation ?? previous;
  return {
    contextTruncation,
    ok: true,
    request: {
      ...fittedRequest,
      context: {
        ...budget.context,
        ...(effectiveTruncation
          ? { summary: { truncation: effectiveTruncation } }
          : {})
      }
    }
  };
}
