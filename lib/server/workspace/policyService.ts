import type { WorkspacePolicyWire } from "@/lib/contracts/workspace";
import type { WorkspaceHealthService } from "./health";
import type { WorkspacePolicyRepository } from "./policyRepository";

export class WorkspacePolicyServiceError extends Error {
  readonly code: "workspace_policy_stale";

  constructor(code: WorkspacePolicyServiceError["code"]) {
    super(code);
    this.code = code;
    this.name = "WorkspacePolicyServiceError";
  }
}

export function createWorkspacePolicyService(input: Readonly<{
  health: WorkspaceHealthService;
  onUpdated?: () => void;
  repository: WorkspacePolicyRepository;
}>) {
  async function read(): Promise<WorkspacePolicyWire> {
    const [policy, runtime] = await Promise.all([
      input.repository.read(),
      input.health.read()
    ]);
    return { ...policy, runtime };
  }

  return {
    read,
    async update(update: Readonly<{
      enabled?: boolean;
      expectedVersion: number;
      internetEnabled?: boolean;
      userId: string;
    }>): Promise<WorkspacePolicyWire> {
      const result = await input.repository.update(update);
      if (result.kind === "stale") throw new WorkspacePolicyServiceError("workspace_policy_stale");
      input.onUpdated?.();
      return { ...result.policy, runtime: await input.health.read() };
    }
  };
}
