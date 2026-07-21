import {
  applyContextBudget,
  type ContextTruncationSummary
} from "../../domain/contextBudget";
import { maxOutputTokensFromParams } from "../../domain/providerParams";
import type {
  NormalizedRunRequest,
  ProviderConversationMessage,
  ProviderModelCapabilities
} from "../providers/types";

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
