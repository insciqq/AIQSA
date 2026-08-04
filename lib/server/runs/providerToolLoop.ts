import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import type {
  ModelToolCall,
  ProviderToolBridge,
  RunTool,
  ToolExecutionResult
} from "../tools/types";
import {
  continueToolLoop,
  type ToolLoopBudgets,
  type ToolLoopCall,
  type ToolLoopOutcome,
  type ToolLoopProgress,
  type ToolLoopSettledCall,
  type ToolLoopSignal,
  type ToolLoopToolResult
} from "./toolLoop";

export type ProviderToolLoopContinuation = Readonly<{
  providerResponseId: string | null;
  providerToolMessages: readonly unknown[];
}>;

export type ProviderToolLoopResume = Readonly<{
  continuation: ProviderToolLoopContinuation;
  previousToolResults?: readonly ToolLoopSettledCall<ToolExecutionResult>[];
  progress?: ToolLoopProgress;
  seenCallIds?: readonly string[];
}>;

export type ProviderToolLoopInput = Readonly<{
  adapter: ProviderAdapter;
  bridge: ProviderToolBridge;
  budgets: ToolLoopBudgets;
  executeTool(
    call: ModelToolCall,
    context: Readonly<{ ordinal: number; round: number; signal: AbortSignal }>
  ): Promise<ToolLoopToolResult<ToolExecutionResult>>;
  initialRequest: ProviderRunRequest;
  onEvent?(event: ModelRunSseEvent): Promise<void> | void;
  onProviderResult?(input: Readonly<{
    request: ProviderRunRequest;
    result: ProviderRunResult;
    round: number;
  }>): Promise<void> | void;
  onSignal?(signal: ToolLoopSignal): Promise<void> | void;
  onToolBatchSettled?(input: Readonly<{
    continuation: ProviderToolLoopContinuation;
    progress: ToolLoopProgress;
    results: readonly ToolLoopSettledCall<ToolExecutionResult>[];
    round: number;
    toolRound: number;
  }>): Promise<void> | void;
  onUsage?(usage: ModelRunUsage, request: ProviderRunRequest): Promise<void> | void;
  parallelToolCalls: boolean;
  prepareRequest?(request: ProviderRunRequest, round: number): Promise<ProviderRunRequest> | ProviderRunRequest;
  beforeProviderRound?(input: Readonly<{
    continuation: ProviderToolLoopContinuation;
    request: ProviderRunRequest;
    round: number;
  }>): Promise<void> | void;
  persistToolBatch?(input: Readonly<{
    calls: readonly ToolLoopCall[];
    continuation: ProviderToolLoopContinuation;
    progress: ToolLoopProgress;
    round: number;
    toolRound: number;
  }>): Promise<void> | void;
  afterToolBatch?(input: Readonly<{
    continuation: ProviderToolLoopContinuation;
    progress: ToolLoopProgress;
    results: readonly ToolLoopSettledCall<ToolExecutionResult>[];
    round: number;
    toolRound: number;
  }>): Promise<void> | void;
  resume?: ProviderToolLoopResume;
  signal?: AbortSignal;
  tools: readonly RunTool[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function providerToolLoopContinuationAfterResult(
  bridge: ProviderToolBridge,
  continuation: ProviderToolLoopContinuation,
  result: ProviderRunResult
): ProviderToolLoopContinuation {
  const calls = result.toolCalls ?? [];
  const withResults = continuationForRound(bridge, continuation, []);
  return {
    providerResponseId: result.providerResponseId ?? withResults.providerResponseId,
    providerToolMessages: [
      ...withResults.providerToolMessages,
      ...bridge.serializeAssistantToolCalls({
        calls,
        ...(result.providerToolCallMessage !== undefined
          ? { providerMessage: result.providerToolCallMessage }
          : {})
      })
    ]
  };
}

function errorToolResult(call: ToolLoopCall, code: string, message: string): ToolExecutionResult {
  return {
    callId: call.id,
    content: [{ text: `${code}: ${message}`, type: "text" }],
    name: call.name,
    status: "error"
  };
}

function settledExecutionResult(
  entry: ToolLoopSettledCall<ToolExecutionResult>
): ToolExecutionResult {
  return entry.result.status === "complete"
    ? entry.result.value
    : errorToolResult(entry.call, entry.result.error.code, entry.result.error.message);
}

function continuationForRound(
  bridge: ProviderToolBridge,
  continuation: ProviderToolLoopContinuation,
  previousToolResults: readonly ToolLoopSettledCall<ToolExecutionResult>[]
): ProviderToolLoopContinuation {
  if (previousToolResults.length === 0) return continuation;
  return {
    ...continuation,
    providerToolMessages: [
      ...continuation.providerToolMessages,
      ...previousToolResults.map((entry) =>
        bridge.appendToolResult(undefined, settledExecutionResult(entry))
      )
    ]
  };
}

export async function runProviderToolLoop(
  input: ProviderToolLoopInput
): Promise<ToolLoopOutcome<ProviderRunResult>> {
  const initialContinuation: ProviderToolLoopContinuation = {
    providerResponseId: null,
    providerToolMessages: []
  };

  return continueToolLoop({
    afterToolBatch: input.afterToolBatch,
    budgets: input.budgets,
    executeTool: (call, context) => input.executeTool({
      arguments: isRecord(call.arguments) ? call.arguments : {},
      id: call.id,
      name: call.name
    }, context),
    initialContinuation,
    onToolBatchSettled: input.onToolBatchSettled,
    onSignal: input.onSignal,
    persistToolBatch: input.persistToolBatch,
    resume: input.resume ? {
      continuation: input.resume.continuation,
      ...(input.resume.previousToolResults
        ? { previousToolResults: input.resume.previousToolResults }
        : {}),
      ...(input.resume.progress ? { progress: input.resume.progress } : {}),
      ...(input.resume.seenCallIds ? { seenCallIds: input.resume.seenCallIds } : {})
    } : undefined,
    async runProviderRound({ continuation, emitText, previousToolResults, progress, round, signal }) {
      const effectiveContinuation = continuationForRound(input.bridge, continuation, previousToolResults);
      const toolChoice = progress.toolRounds >= input.budgets.maxToolRounds ? "none" : "auto";
      const roundRequest = await input.prepareRequest?.({
        ...input.initialRequest,
        parallelToolCalls: input.parallelToolCalls,
        providerToolMessages: [...effectiveContinuation.providerToolMessages],
        toolChoice,
        tools: [...input.tools]
      }, round) ?? {
        ...input.initialRequest,
        parallelToolCalls: input.parallelToolCalls,
        providerToolMessages: [...effectiveContinuation.providerToolMessages],
        toolChoice,
        tools: [...input.tools]
      };
      await input.beforeProviderRound?.({
        continuation: effectiveContinuation,
        request: roundRequest,
        round
      });

      const stream = input.adapter.stream(roundRequest, { signal });
      let lastReportedUsage: ModelRunUsage | null = null;
      let next: IteratorResult<ModelRunSseEvent, ProviderRunResult>;
      try {
        next = await stream.next();
        while (!next.done) {
          if (next.value.type === "token") {
            await emitText(next.value.data.delta);
          } else if (next.value.type === "usage") {
            lastReportedUsage = next.value.data;
          } else {
            await input.onEvent?.(next.value);
          }
          next = await stream.next();
        }
      } catch (error) {
        if (lastReportedUsage) {
          try {
            await input.onUsage?.(lastReportedUsage, roundRequest);
          } catch {
            // Usage persistence is secondary once the provider round has
            // already failed and must not replace its causal classification.
          }
        }
        throw error;
      }
      const result = next.value;
      await input.onProviderResult?.({ request: roundRequest, result, round });
      await input.onUsage?.(result.usage, roundRequest);
      const calls = result.toolCalls ?? [];
      if (calls.length === 0) return { final: result, status: "complete" as const };
      return {
        calls,
        continuation: providerToolLoopContinuationAfterResult(
          input.bridge,
          effectiveContinuation,
          result
        ),
        status: "tool_calls" as const
      };
    },
    signal: input.signal
  });
}
