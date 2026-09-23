import { prisma } from "../prisma";
import { resolveRequestAuth } from "../auth/defaultAuth";
import { workspaceAvailabilityService } from "../workspace/defaultServices";
import { createS3StorageAdapter } from "./storage";
import { createWorkspaceUploadHandlers } from "./workspaceUploadHandlers";
import { createWorkspaceUploadRepository } from "./workspaceUploadRepository";
import { WorkspaceUploadService } from "./workspaceUploadService";

const globals = globalThis as typeof globalThis & { aiqsaWorkspaceUploads?: WorkspaceUploadService };
export function getWorkspaceUploadService() {
  globals.aiqsaWorkspaceUploads ??= new WorkspaceUploadService({
    repository: createWorkspaceUploadRepository(prisma), storage: createS3StorageAdapter(),
    async available() {
      const snapshot = await workspaceAvailabilityService.snapshot();
      return snapshot.policy.enabled && snapshot.runtime.state === "ready";
    }
  });
  globals.aiqsaWorkspaceUploads.start();
  return globals.aiqsaWorkspaceUploads;
}

export function workspaceUploadHandlers() {
  return createWorkspaceUploadHandlers({ resolveAuth: resolveRequestAuth, service: getWorkspaceUploadService() });
}
