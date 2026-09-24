import { prisma } from "../prisma";
import type { StorageAdapter } from "../uploads/storage";
import { workspaceConfig, workspaceRuntime } from "../workspace/defaultServices";
import { createWorkspaceSelectedCaptures } from "../workspace/selectedCapture";
import { createVisionAnalysisService } from "./service";

export const visionAnalysisForStorage = (storage: StorageAdapter) => createVisionAnalysisService(prisma,
  createWorkspaceSelectedCaptures({ prisma, storage, config: workspaceConfig, runtime: workspaceRuntime }));
