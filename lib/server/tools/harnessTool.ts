import type { ModelToolCall, RunTool, ToolExecutionContext, ToolExecutionResult } from "./types";

/**
 * What a tool does outside the transcript, for the engine registry's hooks:
 * `none` changes nothing (pure or read-only), `local` changes only this
 * chat's own state (Workspace files), `external` reaches systems beyond AIQSA.
 */
export type HarnessToolEffects = "external" | "local" | "none";

/** A tool's contract for the native engine registry. */
export type HarnessToolDescriptor = Readonly<{
  name: string;
  /** Written as a contract: what the tool does, its inputs, its result and its refusals. */
  description: string;
  inputSchema: Record<string, unknown>;
  effects: HarnessToolEffects;
  /** The call is sent only after the user approves it. */
  needsApproval: boolean;
  /** The call needs the Workspace VM, which starts at the first such call. */
  requiresVm: boolean;
  /** The same tool for the existing provider bridges. */
  tool: RunTool;
}>;

/** One refusal or failure of a harness tool: a JSON body with a stable code and an actionable message. */
export function harnessToolError(call: Pick<ModelToolCall, "id" | "name">, code: string, message: string,
  extra: Readonly<Record<string, unknown>> = {}): ToolExecutionResult {
  return { callId: call.id, content: [{ type: "json", value: { code, message, ...extra } }], name: call.name, status: "error" };
}

export type HarnessToolExecute = (call: ModelToolCall, context: ToolExecutionContext,
  options?: { signal?: AbortSignal }) => Promise<ToolExecutionResult>;
