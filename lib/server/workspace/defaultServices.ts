import { prisma } from "@/lib/server/prisma";
import type { StorageAdapter } from "@/lib/server/uploads/storage";
import { getWorkspaceConfig } from "./config";
import { createWorkspaceRuntime } from "./defaultRuntime";
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
import { createWorkspaceLifecycleService } from "./lifecycle";

export const workspaceConfig = getWorkspaceConfig();
export const workspaceRuntime = createWorkspaceRuntime(workspaceConfig);
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
