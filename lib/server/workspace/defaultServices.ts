import { prisma } from "@/lib/server/prisma";
import type { StorageAdapter } from "@/lib/server/uploads/storage";
import { getWorkspaceConfig } from "./config";
import { createWorkspaceRuntime } from "./defaultRuntime";
import type { WorkspaceRuntime } from "./runtime";
import { createWorkspaceAvailabilityService } from "./availability";
import { createWorkspaceHealthService } from "./health";
import { createPrismaWorkspacePolicyRepository } from "./policyRepository";
import { createWorkspacePolicyService } from "./policyService";
import {
  createPrismaWorkspaceAdmissionRepository,
  createWorkspaceAdmissionService
} from "./admission";
import {
  createPrismaWorkspaceCoordinatorRepository,
  createWorkspaceCoordinator
} from "./coordinator";
import { createPrismaWorkspaceExecutionRegistry } from "./executionRegistry";
import { createWorkspaceLifecycleService } from "./lifecycle";

const globalForWorkspace = globalThis as unknown as {
  __aiqsaWorkspaceRuntime?: WorkspaceRuntime;
};

export const workspaceConfig = getWorkspaceConfig();
// One runtime per process: route bundles and the instrumentation bundle
// (recovery scheduler, maintenance) must see the same runtime state, or the
// deterministic runtime would report a session it created elsewhere as lost.
export const workspaceRuntime: WorkspaceRuntime =
  globalForWorkspace.__aiqsaWorkspaceRuntime ?? createWorkspaceRuntime(workspaceConfig);
globalForWorkspace.__aiqsaWorkspaceRuntime = workspaceRuntime;
export const workspaceHealthService = createWorkspaceHealthService({ runtime: workspaceRuntime });
export const workspacePolicyRepository = createPrismaWorkspacePolicyRepository(prisma);
export const workspaceAvailabilityService = createWorkspaceAvailabilityService({
  health: workspaceHealthService,
  policy: workspacePolicyRepository
});
export const workspacePolicyService = createWorkspacePolicyService({
  health: workspaceHealthService,
  onUpdated: () => workspaceAvailabilityService.invalidate(),
  repository: workspacePolicyRepository
});
export const workspaceAdmissionService = createWorkspaceAdmissionService({
  config: workspaceConfig,
  health: workspaceHealthService,
  policy: workspacePolicyRepository,
  repository: createPrismaWorkspaceAdmissionRepository(prisma)
});

export function workspaceCoordinatorForStorage(storage: StorageAdapter) {
  return createWorkspaceCoordinator({
    config: workspaceConfig,
    registry: createPrismaWorkspaceExecutionRegistry(prisma),
    repository: createPrismaWorkspaceCoordinatorRepository(prisma),
    runtime: workspaceRuntime,
    storage
  });
}

export function workspaceLifecycleForStorage(storage: StorageAdapter) {
  return createWorkspaceLifecycleService({
    availability: workspaceAvailabilityService,
    config: workspaceConfig,
    policy: workspacePolicyRepository,
    prisma,
    runtime: workspaceRuntime,
    storage
  });
}
