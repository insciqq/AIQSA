import type {
  MemoryFeedbackMutationResponse,
  MemoryListResponse,
  MemoryMutationResponse
} from "../../../contracts/memory";
import { textFromContentBlocks } from "../../../domain/modelRunEvents";
import type { ModelToolCall, ToolExecutionContext, ToolExecutionResult } from "../../tools/types";
import type {
  MemoryMutationAuthorizationSnapshot,
  MemoryMutationToolAuthorizationClaim
} from "../persistence/authorizations";
import { memorySha256 } from "../persistence/lexical";
import type { ExplicitMemoryService } from "../explicit/service";
import type { MemoryLifecycleService } from "../lifecycle/service";
import type { MemoryReviewService } from "../review/service";
import { decodeMemoryActionPlan, type MemoryActionPlan } from "./intent";
import {
  MEMORY_FORGET_TOOL_NAME,
  MEMORY_LIST_TOOL_NAME,
  MEMORY_MARK_INCORRECT_TOOL_NAME,
  MEMORY_SAVE_TOOL_NAME,
  MEMORY_UPDATE_TOOL_NAME,
  memoryActionToolName
} from "./tools";

export type MemoryActionAuthorizationRepository = Readonly<{
  claimForTool(
    userId: string,
    input: MemoryMutationToolAuthorizationClaim,
    now?: Date
  ): Promise<MemoryMutationAuthorizationSnapshot>;
}>;

export type MemoryActionExecutor = Readonly<{
  accepts(plan: MemoryActionPlan, toolName: string): boolean;
  execute(
    plan: MemoryActionPlan,
    call: ModelToolCall,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult>;
}>;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function complete(
  call: ModelToolCall,
  operation: MemoryActionPlan["kind"],
  value: MemoryListResponse | MemoryMutationResponse
    | MemoryFeedbackMutationResponse
): ToolExecutionResult {
  const itemCount = "memories" in value ? value.memories.length : 1;
  return {
    callId: call.id,
    content: [{ type: "json", value: { operation, result: value } }],
    name: call.name,
    rawPreview: {
      itemCount,
      operation,
      result: operation === "LIST" ? "complete" : "applied"
    },
    status: "complete"
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error &&
    typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(error.message)
    ? error.message
    : "memory_action_failed";
}

function failed(call: ModelToolCall, error: unknown): ToolExecutionResult {
  const code = errorCode(error);
  return {
    callId: call.id,
    content: [{ type: "json", value: { error: code } }],
    name: call.name,
    rawPreview: { error: code },
    status: "error"
  };
}

function executionIdentity(context: ToolExecutionContext): Readonly<{
  modelRunId: string;
  persistedToolCallId: string;
  userId: string;
}> {
  if (!context.runId || !context.persistedToolCallId || !context.userId) {
    throw new Error("memory_action_authorization_missing");
  }
  return {
    modelRunId: context.runId,
    persistedToolCallId: context.persistedToolCallId,
    userId: context.userId
  };
}

function requireDirectRunAuthorization(
  authorization: MemoryMutationAuthorizationSnapshot,
  plan: Exclude<MemoryActionPlan, { kind: "LIST" }>,
  context: ToolExecutionContext
): void {
  const sourceText = textFromContentBlocks(context.request.content);
  const sourceSpan = authorization.exactSourceStart === null ||
      authorization.exactSourceEnd === null
    ? ""
    : sourceText.slice(authorization.exactSourceStart, authorization.exactSourceEnd);
  const sourceMatches = plan.kind === "SAVE"
    ? sourceSpan.trim().length > 0
    : sourceSpan === plan.targetQuery;
  if (
    authorization.modelRunId !== context.runId ||
    authorization.persistedToolCallId !== context.persistedToolCallId ||
    authorization.sourceChatId !== context.request.chatId ||
    !authorization.sourceMessageId ||
    authorization.exactSourceStart === null ||
    authorization.exactSourceEnd === null ||
    authorization.exactSourceStart !== plan.sourceStart ||
    authorization.exactSourceEnd !== plan.sourceEnd ||
    authorization.exactSourceEnd <= authorization.exactSourceStart ||
    !sourceMatches
  ) {
    throw new Error("memory_action_authorization_missing");
  }
}

export function createMemoryActionExecutor(input: Readonly<{
  authorizationRepository: MemoryActionAuthorizationRepository;
  explicitService: ExplicitMemoryService;
  lifecycleService: MemoryLifecycleService;
  reviewService: MemoryReviewService;
}>): MemoryActionExecutor {
  async function claim(
    plan: Exclude<MemoryActionPlan, { kind: "LIST" }>,
    context: ToolExecutionContext,
    authorizedPayloadHash?: string
  ): Promise<MemoryMutationAuthorizationSnapshot> {
    const identity = executionIdentity(context);
    const authorization = await input.authorizationRepository.claimForTool(identity.userId, {
      action: plan.kind === "SAVE"
        ? "SAVE"
        : plan.kind === "UPDATE" || plan.kind === "MARK_INCORRECT"
          ? "EDIT"
          : "FORGET",
      ...(authorizedPayloadHash ? { authorizedPayloadHash } : {}),
      modelRunId: identity.modelRunId,
      persistedToolCallId: identity.persistedToolCallId
    });
    requireDirectRunAuthorization(authorization, plan, context);
    return authorization;
  }

  return Object.freeze({
    accepts(plan, toolName) {
      return memoryActionToolName(plan) === toolName;
    },

    async execute(plan, call, context) {
      const decodedPlan = decodeMemoryActionPlan(plan);
      if (!decodedPlan || memoryActionToolName(decodedPlan) !== call.name) {
        return failed(call, new Error("memory_action_plan_invalid"));
      }
      try {
        if (decodedPlan.kind === "LIST") {
          if (!exactKeys(call.arguments, ["query"]) ||
            call.arguments.query !== decodedPlan.query) {
            throw new Error("memory_intent_confirmation_required");
          }
          const identity = executionIdentity(context);
          const result = decodedPlan.query === null
            ? await input.explicitService.list(identity.userId, {
                pageSize: 20,
                scope: { type: "GLOBAL_USER" },
                sourceMode: "EXPLICIT",
                state: "ACTIVE"
              })
            : await input.explicitService.search(identity.userId, {
                pageSize: 20,
                query: decodedPlan.query,
                scope: { type: "GLOBAL_USER" },
                sourceMode: "EXPLICIT",
                state: "ACTIVE"
              });
          return complete(call, decodedPlan.kind, result);
        }

        const identity = executionIdentity(context);
        if (decodedPlan.kind === "SAVE") {
          if (!exactKeys(call.arguments, ["statement"]) ||
            typeof call.arguments.statement !== "string") {
            throw new Error("memory_intent_confirmation_required");
          }
          const authorization = await claim(decodedPlan, context);
          const result = await input.explicitService.create(identity.userId, {
            mutationAuthorizationId: authorization.id,
            scope: { type: "GLOBAL_USER" },
            statement: call.arguments.statement
          }, {
            ...identity,
            authorizedPayloadHash: authorization.authorizedPayloadHash
          });
          return complete(call, decodedPlan.kind, result);
        }

        if (!authorizationTargetPlan(decodedPlan)) {
          throw new Error("memory_action_plan_invalid");
        }
        if (decodedPlan.kind === "UPDATE" && (
          !exactKeys(call.arguments, ["statement"]) ||
          call.arguments.statement !== decodedPlan.replacement
        )) {
          throw new Error("memory_intent_confirmation_required");
        }
        if (decodedPlan.kind === "FORGET" && (
          !exactKeys(call.arguments, ["exact_query"]) ||
          call.arguments.exact_query !== decodedPlan.targetQuery
        )) {
          throw new Error("memory_intent_confirmation_required");
        }
        if (decodedPlan.kind === "MARK_INCORRECT" && (
          !exactKeys(call.arguments, ["exact_query"]) ||
          call.arguments.exact_query !== decodedPlan.targetQuery
        )) {
          throw new Error("memory_intent_confirmation_required");
        }
        const authorization = await claim(decodedPlan, context);
        if (!authorization.targetFactId || !authorization.expectedTargetVersionId) {
          throw new Error("memory_intent_confirmation_required");
        }
        if (decodedPlan.kind === "UPDATE") {
          const result = await input.explicitService.update(
            identity.userId,
            authorization.targetFactId,
            {
              expectedVersionId: authorization.expectedTargetVersionId,
              mutationAuthorizationId: authorization.id,
              statement: decodedPlan.replacement
            },
            identity
          );
          return complete(call, decodedPlan.kind, result);
        }
        if (decodedPlan.kind === "MARK_INCORRECT") {
          const result = await input.reviewService.feedback(
            identity.userId,
            authorization.targetFactId,
            {
              expectedVersionId: authorization.expectedTargetVersionId,
              feedbackType: "INCORRECT",
              modelRunId: identity.modelRunId,
              modelRunToolCallId: identity.persistedToolCallId,
              requestId: memorySha256({
                domain: "aiqsa.memory.mark-incorrect-tool",
                modelRunId: identity.modelRunId,
                persistedToolCallId: identity.persistedToolCallId,
                version: "v1"
              })
            },
            {
              authorization: {
                action: "EDIT",
                authorizationId: authorization.id,
                authorizedPayloadHash: authorization.authorizedPayloadHash,
                expectedTargetVersionId: authorization.expectedTargetVersionId,
                requestId: authorization.requestId,
                targetFactId: authorization.targetFactId
              }
            }
          );
          return complete(call, decodedPlan.kind, result);
        }
        const result = await input.lifecycleService.forget(
          identity.userId,
          authorization.targetFactId,
          {
            expectedVersionId: authorization.expectedTargetVersionId,
            mutationAuthorizationId: authorization.id
          },
          identity
        );
        return complete(call, decodedPlan.kind, result);
      } catch (error) {
        return failed(call, error);
      }
    }
  });
}

function authorizationTargetPlan(
  plan: MemoryActionPlan
): plan is Extract<MemoryActionPlan, { kind: "FORGET" | "MARK_INCORRECT" | "UPDATE" }> {
  return plan.kind === "FORGET" || plan.kind === "MARK_INCORRECT" ||
    plan.kind === "UPDATE";
}

export const memoryActionToolNames = Object.freeze([
  MEMORY_SAVE_TOOL_NAME,
  MEMORY_LIST_TOOL_NAME,
  MEMORY_UPDATE_TOOL_NAME,
  MEMORY_FORGET_TOOL_NAME,
  MEMORY_MARK_INCORRECT_TOOL_NAME
]);
