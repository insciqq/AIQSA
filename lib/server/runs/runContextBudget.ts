import {
  applyContextBudget,
  estimateApproxTokens,
  type ContextTruncationSummary
} from "../../domain/contextBudget";
import { maxOutputTokensFromParams } from "../../domain/providerParams";
import { providerAttachmentBudgetTokens } from "../providers/attachmentPayload";
import type {
  NormalizedRunRequest,
  ProviderConversationMessage,
  ProviderModelCapabilities,
  ProviderRunRequest
} from "../providers/types";
import type { ProviderToolBridge } from "../tools/types";

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
  const budget = applyContextBudget({
    contextWindow: input.modelCapabilities.contextWindow ?? 0,
    maxOutputTokens: maxOutputTokensForBudget(input.params, input.modelCapabilities, input.provider),
    messageExtraTokens: input.messageExtraTokens,
    messages: input.contextMessages,
    prompt: input.prompt
  });

  if (!budget.ok) {
    return {
      error: {
        code: "context_too_large",
        message: `Prompt and current message exceed the model context budget (${budget.budgetTokens} estimated tokens available).`
      },
      ok: false,
      status: 400
    };
  }

  const context: NonNullable<NormalizedRunRequest["context"]> = {
    messages: budget.messages,
    mode: "branch_path"
  };

  if (budget.truncation) {
    context.summary = {
      truncation: budget.truncation
    };
  }

  return {
    context,
    contextTruncation: budget.truncation,
    ok: true
  };
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
  const providerExtras =
    providerAttachmentBudgetTokens({
      attachments: input.request.attachments,
      modelCapabilities: input.request.modelCapabilities
    }) +
    estimateApproxTokens(providerFacingSerializedTools(input.request, input.bridge)) +
    estimateApproxTokens(input.request.providerToolMessages ?? []);
  const budget = applyRunContextBudget({
    contextMessages: budgetMessages,
    messageExtraTokens:
      currentMessageId && providerExtras > 0
        ? { [currentMessageId]: providerExtras }
        : undefined,
    modelCapabilities: input.request.modelCapabilities,
    params: input.request.params,
    prompt: input.request.prompt,
    provider: input.request.provider
  });
  if (!budget.ok) return budget;

  if (contextMessages.length === 0) {
    return { contextTruncation: null, ok: true, request: input.request };
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
      ...input.request,
      context: {
        ...budget.context,
        ...(effectiveTruncation
          ? { summary: { truncation: effectiveTruncation } }
          : {})
      }
    }
  };
}
