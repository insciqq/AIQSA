import type { WorkspaceConfig } from "./config";
import { DeterministicWorkspaceRuntime } from "./deterministicRuntime";
import { RemoteWorkspaceRuntime } from "./remoteRuntime";
import {
  WorkspaceRuntimeError,
  type WorkspaceRuntime,
  type WorkspaceRuntimeHealth
} from "./runtime";

class UnavailableWorkspaceRuntime implements WorkspaceRuntime {
  async health(): Promise<WorkspaceRuntimeHealth> {
    return { reasonCode: "workspace_runner_unconfigured", state: "unavailable" };
  }

  private unavailable(): never {
    throw new WorkspaceRuntimeError("workspace_runtime_unavailable");
  }

  async ensureSession(): Promise<never> { return this.unavailable(); }
  async stageAttachments(): Promise<never> { return this.unavailable(); }
  async loadBoundTools(): Promise<never> { return this.unavailable(); }
  async callBoundTool(): Promise<never> { return this.unavailable(); }
  async cancelToolCall(): Promise<never> { return this.unavailable(); }
  async terminateExecutions(): Promise<never> { return this.unavailable(); }
  async collectOutputs(): Promise<never> { return this.unavailable(); }
  async createProjectArchive(): Promise<never> { return this.unavailable(); }
  async stopSession(): Promise<never> { return this.unavailable(); }
  async removeSession(): Promise<never> { return this.unavailable(); }
}

export function createWorkspaceRuntime(config: WorkspaceConfig): WorkspaceRuntime {
  if (config.runtimeMode === "deterministic") return new DeterministicWorkspaceRuntime(config);
  if (config.runtimeMode === "remote") return new RemoteWorkspaceRuntime(config);
  return new UnavailableWorkspaceRuntime();
}
