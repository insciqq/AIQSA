import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultProjectMemoryHandlerDeps } from "@/lib/server/projects/defaultProjects";
import {
  createProjectMemoryFactDeleteHandler,
  createProjectMemoryFactUpdateHandler
} from "@/lib/server/projects/memoryHandlers";

export const runtime = "nodejs";

export const PATCH: AsyncRouteHandler<ReturnType<typeof createProjectMemoryFactUpdateHandler>> = createProjectMemoryFactUpdateHandler(defaultProjectMemoryHandlerDeps);
export const DELETE: AsyncRouteHandler<ReturnType<typeof createProjectMemoryFactDeleteHandler>> = createProjectMemoryFactDeleteHandler(defaultProjectMemoryHandlerDeps);
