import { defaultProjectMemoryHandlerDeps } from "@/lib/server/projects/defaultProjects";
import {
  createProjectMemoryFactDeleteHandler,
  createProjectMemoryFactUpdateHandler
} from "@/lib/server/projects/memoryHandlers";

export const runtime = "nodejs";

export const PATCH = createProjectMemoryFactUpdateHandler(defaultProjectMemoryHandlerDeps);
export const DELETE = createProjectMemoryFactDeleteHandler(defaultProjectMemoryHandlerDeps);
