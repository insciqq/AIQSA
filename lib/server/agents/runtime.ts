import type { WorkspaceOperation } from "../workspace/operationFence";
import type { CodexManagedProfile } from "./codexProfile";

export type WorkspaceAgentIdentity = Readonly<{
  modelRunId: string;
  runtimeExecSessionId: string;
  runtimeSandboxId: string;
  sessionId: string;
  operation?: WorkspaceOperation;
  signal?: AbortSignal;
}>;

export type WorkspaceAgentStart = WorkspaceAgentIdentity & Readonly<{
  profile: CodexManagedProfile;
  prompt: string;
  runToken: string;
  threadId?: string;
  timeoutSeconds: number | null;
}>;

/** Deterministic before dispatch so durable cleanup can be registered first. */
export function agentExecutionId(toolCallId: string): string {
  if (!/^[a-f0-9-]{36}$/iu.test(toolCallId)) throw new Error("agent_execution_invalid");
  return `agent-${toolCallId}`;
}
