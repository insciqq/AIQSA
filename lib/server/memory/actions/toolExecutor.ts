import type {
  MemoryFeedbackMutationResponse,
  MemoryListResponse,
  MemoryMutationResponse,
  MemoryScopeSelection
} from "../../../contracts/memory";
import { decodeMemoryScopeSelection } from "../../../contracts/memory";
import { textFromContentBlocks } from "../../../domain/modelRunEvents";
import type { ModelToolCall, ToolExecutionContext, ToolExecutionResult } from "../../tools/types";
import type {
  MemoryMutationAuthorizationSnapshot,
  MemoryMutationToolAuthorizationMint
} from "../persistence/authorizations";
import { memoryTargetAuthorizationPayloadHash } from "../persistence/authorizations";
import { memorySha256 } from "../persistence/lexical";
import { memoryExplicitStatementContainsSecret } from "../explicit/safety";
import type { ExplicitMemoryService } from "../explicit/service";
import type { MemoryLifecycleService } from "../lifecycle/service";
import type { MemoryReviewService } from "../review/service";
import {
  MEMORY_FORGET_TOOL_NAME,
  MEMORY_LIST_TOOL_NAME,
  MEMORY_MARK_INCORRECT_TOOL_NAME,
  MEMORY_SAVE_TOOL_NAME,
  MEMORY_UPDATE_TOOL_NAME,
  isMemoryActionToolName
} from "./tools";

export type MemoryActionAuthorizationRepository = Readonly<{
  mintForTool(
    userId: string,
    input: MemoryMutationToolAuthorizationMint,
    now?: Date
  ): Promise<MemoryMutationAuthorizationSnapshot>;
}>;

export type MemoryActionExecutor = Readonly<{
  accepts(toolName: string): boolean;
  execute(
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
  operation: "FORGET" | "LIST" | "MARK_INCORRECT" | "SAVE" | "UPDATE",
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

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= maximum && !value.includes("\u0000");
}

function decodedScope(value: unknown): MemoryScopeSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!exactKeys(candidate, ["target_id", "type"]) || typeof candidate.type !== "string") {
    return null;
  }
  const decoded = decodeMemoryScopeSelection(candidate.type === "GLOBAL_USER"
    ? { type: candidate.type }
    : { targetId: candidate.target_id, type: candidate.type });
  return decoded.ok ? decoded.value : null;
}

function currentUserText(context: ToolExecutionContext): string {
  const value = textFromContentBlocks(context.request.content);
  if (!value || value.length > 2_000 || value.includes("\u0000")) {
    throw new Error("memory_action_authorization_missing");
  }
  return value;
}

export function createMemoryActionExecutor(input: Readonly<{
  authorizationRepository: MemoryActionAuthorizationRepository;
  explicitService: ExplicitMemoryService;
  lifecycleService: MemoryLifecycleService;
  reviewService: MemoryReviewService;
}>): MemoryActionExecutor {
  async function executeModelDriven(
    call: ModelToolCall,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const identity = executionIdentity(context);
    if (call.name === MEMORY_LIST_TOOL_NAME) {
      if (!exactKeys(call.arguments, ["query"]) ||
        !(call.arguments.query === null || boundedString(call.arguments.query, 500))) {
        throw new Error("memory_contract_invalid");
      }
      const result = call.arguments.query === null
        ? await input.explicitService.list(identity.userId, {
            pageSize: 20,
            scope: { type: "GLOBAL_USER" },
            state: "ACTIVE"
          })
        : await input.explicitService.search(identity.userId, {
            pageSize: 20,
            query: call.arguments.query,
            scope: { type: "GLOBAL_USER" },
            state: "ACTIVE"
          });
      return complete(call, "LIST", result);
    }
    const sourceText = currentUserText(context);
    const sourceArgument = call.arguments.source_text;
    if (!boundedString(sourceArgument, 2_000) || sourceArgument !== sourceText) {
      throw new Error("memory_action_authorization_missing");
    }
    if (call.name === MEMORY_SAVE_TOOL_NAME) {
      if (!exactKeys(call.arguments, ["scope", "source_text", "statement"]) ||
        !boundedString(call.arguments.statement, 2_000)) {
        throw new Error("memory_contract_invalid");
      }
      const scope = decodedScope(call.arguments.scope);
      if (!scope) throw new Error("memory_contract_invalid");
      if (memoryExplicitStatementContainsSecret(call.arguments.statement)) {
        throw new Error("memory_secret_rejected");
      }
      const authorization = await input.authorizationRepository.mintForTool(
        identity.userId,
        {
          action: "SAVE",
          authorizedPayloadHash: memorySha256(call.arguments.statement),
          chatId: context.request.chatId,
          modelRunId: identity.modelRunId,
          persistedToolCallId: identity.persistedToolCallId,
          sourceText,
          toolName: call.name
        }
      );
      const result = await input.explicitService.create(identity.userId, {
        mutationAuthorizationId: authorization.id,
        scope,
        statement: call.arguments.statement
      }, {
        ...identity,
        authorizedPayloadHash: authorization.authorizedPayloadHash
      });
      return complete(call, "SAVE", result);
    }

    const targetKeys = call.name === MEMORY_UPDATE_TOOL_NAME
      ? ["expected_version_id", "source_text", "statement", "target_fact_id"]
      : ["expected_version_id", "source_text", "target_fact_id"];
    if (!exactKeys(call.arguments, targetKeys) ||
      !boundedString(call.arguments.target_fact_id, 256) ||
      !boundedString(call.arguments.expected_version_id, 256) ||
      (call.name === MEMORY_UPDATE_TOOL_NAME &&
        !boundedString(call.arguments.statement, 2_000))) {
      throw new Error("memory_contract_invalid");
    }
    const action = call.name === MEMORY_FORGET_TOOL_NAME ? "FORGET" as const : "EDIT" as const;
    const authorization = await input.authorizationRepository.mintForTool(identity.userId, {
      action,
      authorizedPayloadHash: memoryTargetAuthorizationPayloadHash({
        action,
        expectedTargetVersionId: call.arguments.expected_version_id,
        targetFactId: call.arguments.target_fact_id
      }),
      chatId: context.request.chatId,
      expectedTargetVersionId: call.arguments.expected_version_id,
      modelRunId: identity.modelRunId,
      persistedToolCallId: identity.persistedToolCallId,
      sourceText,
      targetFactId: call.arguments.target_fact_id,
      toolName: call.name
    });
    if (call.name === MEMORY_UPDATE_TOOL_NAME) {
      const result = await input.explicitService.update(
        identity.userId,
        call.arguments.target_fact_id,
        {
          expectedVersionId: call.arguments.expected_version_id,
          mutationAuthorizationId: authorization.id,
          statement: call.arguments.statement as string
        },
        identity
      );
      return complete(call, "UPDATE", result);
    }
    if (call.name === MEMORY_MARK_INCORRECT_TOOL_NAME) {
      const result = await input.reviewService.feedback(
        identity.userId,
        call.arguments.target_fact_id,
        {
          expectedVersionId: call.arguments.expected_version_id,
          feedbackType: "INCORRECT",
          modelRunId: identity.modelRunId,
          modelRunToolCallId: identity.persistedToolCallId,
          requestId: memorySha256({
            domain: "aiqsa.memory.mark-incorrect-tool",
            modelRunId: identity.modelRunId,
            persistedToolCallId: identity.persistedToolCallId,
            version: "v2"
          })
        },
        {
          authorization: {
            action: "EDIT",
            authorizationId: authorization.id,
            authorizedPayloadHash: authorization.authorizedPayloadHash,
            expectedTargetVersionId: call.arguments.expected_version_id,
            requestId: authorization.requestId,
            targetFactId: call.arguments.target_fact_id
          }
        }
      );
      return complete(call, "MARK_INCORRECT", result);
    }
    if (call.name !== MEMORY_FORGET_TOOL_NAME) throw new Error("memory_action_tool_invalid");
    const result = await input.lifecycleService.forget(
      identity.userId,
      call.arguments.target_fact_id,
      {
        expectedVersionId: call.arguments.expected_version_id,
        mutationAuthorizationId: authorization.id
      },
      identity
    );
    return complete(call, "FORGET", result);
  }

  return Object.freeze({
    accepts(toolName) {
      return isMemoryActionToolName(toolName);
    },

    async execute(call, context) {
      try {
        return await executeModelDriven(call, context);
      } catch (error) {
        return failed(call, error);
      }
    }
  });
}

export const memoryActionToolNames = Object.freeze([
  MEMORY_SAVE_TOOL_NAME,
  MEMORY_LIST_TOOL_NAME,
  MEMORY_UPDATE_TOOL_NAME,
  MEMORY_FORGET_TOOL_NAME,
  MEMORY_MARK_INCORRECT_TOOL_NAME
]);
