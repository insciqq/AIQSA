import type { WorkspaceConfig } from "./config";
import { DeterministicWorkspaceRuntime } from "./deterministicRuntime";
import { RemoteWorkspaceRuntime } from "./remoteRuntime";
import { fenceDeterministicWorkspaceRuntime } from "./fencedRuntime";
import { reportSubsystemFailure, reportSubsystemHealthy } from "../observability";
import { observeWorkspaceHealth, workspaceLifecycleFailure } from "./lifecycleObservability";
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
  async listStagedAttachments(): Promise<never> { return this.unavailable(); }
  async stageAttachments(): Promise<never> { return this.unavailable(); }
  async syncPersonalSecrets(): Promise<never> { return this.unavailable(); }
  async prepareSkillRun(): Promise<never> { return this.unavailable(); }
  async installSkillBundle(): Promise<never> { return this.unavailable(); }
  async completeSkillRunPreparation(): Promise<never> { return this.unavailable(); }
  async loadBoundTools(): Promise<never> { return this.unavailable(); }
  async callBoundTool(): Promise<never> { return this.unavailable(); }
  async cancelToolCall(): Promise<never> { return this.unavailable(); }
  async terminateExecutions(): Promise<never> { return this.unavailable(); }
  async collectOutputs(): Promise<never> { return this.unavailable(); }
  async collectBrowserSessions(): Promise<never> { return this.unavailable(); }
  async createProjectArchive(): Promise<never> { return this.unavailable(); }
  async restoreProjectArchive(): Promise<never> { return this.unavailable(); }
  async stopSession(): Promise<never> { return this.unavailable(); }
  async removeSession(): Promise<never> { return this.unavailable(); }
}

export function createWorkspaceRuntime(
  config: WorkspaceConfig,
  options: Readonly<{ sharedState?: boolean }> = {}
): WorkspaceRuntime {
  let runtime: WorkspaceRuntime;
  try {
    runtime = config.runtimeMode === "deterministic"
      ? fenceDeterministicWorkspaceRuntime(new DeterministicWorkspaceRuntime(config, options), options.sharedState)
      : config.runtimeMode === "remote" ? new RemoteWorkspaceRuntime(config) : new UnavailableWorkspaceRuntime();
    reportSubsystemHealthy("workspace", "initialize");
  } catch (error) {
    reportSubsystemFailure({ subsystem: "workspace", stage: "initialize", ...workspaceLifecycleFailure(error), action: "stop" });
    throw error;
  }
  const health = runtime.health.bind(runtime);
  runtime.health = async (signal) => {
    try {
      const result = await health(signal);
      observeWorkspaceHealth(result, "app");
      return result;
    } catch (error) {
      reportSubsystemFailure({ subsystem: "workspace", stage: "health", scope_id: "app", ...workspaceLifecycleFailure(error), action: "wait" });
      throw error;
    }
  };
  return runtime;
}
