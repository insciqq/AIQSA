import type { WorkspaceAgent } from "../subagents/guestProtocol";
import { workspaceAgentEnvironment } from "../subagents/guestProtocol";
import type { BrowserAgentIdentity, BrowserAgentReleaseInput } from "../subagents/ports";
import { workspaceBrowserAgentAvailable } from "./browserGuidance";
import type { WorkspaceRuntime } from "./runtime";

/** The runtime context needed to send a browser release to one Workspace guest. */
export type BrowserAgentIdentityContext = Readonly<{
  operation: Parameters<WorkspaceRuntime["callBoundTool"]>[0]["operation"];
  runtime: Pick<WorkspaceRuntime, "callBoundTool">;
  runtimeSandboxId: string;
  sessionId: string;
}>;

/** The server-owned identity and release port used by the sub-agent coordinator. */
export class WorkspaceBrowserAgentIdentity implements BrowserAgentIdentity {
  constructor(private readonly context: BrowserAgentIdentityContext) {}

  environment(agent: WorkspaceAgent): Readonly<Record<string, string>> {
    return workspaceAgentEnvironment(agent);
  }

  async release(input: BrowserAgentReleaseInput): Promise<void> {
    try {
      await this.context.runtime.callBoundTool({
        operation: this.context.operation,
        sessionId: this.context.sessionId,
        runtimeSandboxId: this.context.runtimeSandboxId,
        modelRunId: input.modelRunId,
        modelRunToolCallId: `browser-release-${input.modelRunId}`.slice(0, 128),
        originalName: "sandbox_exec",
        arguments: { command: "aiqsa-browser", args: ["release"] },
        agent: input.agent,
        signal: input.signal
      });
    } catch {
      // A stopped/lost guest has no slot left to release. The helper operation
      // is idempotent, so an unavailable VM is equivalent to a completed release.
    }
  }
}

/** Old guest images support the main agent only; the coordinator calls this at admission. */
export function workspaceBrowserAgentAvailableFor(agent: WorkspaceAgent, imageRef: string): boolean {
  return workspaceBrowserAgentAvailable(imageRef, agent.kind);
}
