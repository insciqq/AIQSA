import type { ModelToolCall, RunTool, ToolExecutionContext, ToolExecutionResult } from "./types";

/**
 * What a tool does beyond the transcript: the one vocabulary of the native
 * engine registry (`EngineToolEffects` in `lib/server/engine/toolRegistry.ts`),
 * whose hooks act on it.
 * - `none`: it only reads or changes nothing. A transient failure is tried
 *   again, and an identical repeat after identical results may be blocked.
 * - `local`: it changes the user's own AIQSA state through its owner's
 *   service, which settles the call itself, or this chat's Workspace files.
 *   It is never tried again automatically.
 * - `external`: it may act outside AIQSA (an MCP tool that is not read-only,
 *   a Workspace command, a paid generation). It is recorded before it is
 *   sent and never sent twice, and an unknown outcome stays unknown
 *   (`lib/server/engine/unknownEffects.ts`).
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
