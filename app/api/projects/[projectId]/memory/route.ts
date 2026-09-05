import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultProjectMemoryHandlerDeps } from "@/lib/server/projects/defaultProjects";
import {
  createProjectMemoryFactHandler,
  createProjectMemoryListHandler
} from "@/lib/server/projects/memoryHandlers";

export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createProjectMemoryListHandler>> = createProjectMemoryListHandler(defaultProjectMemoryHandlerDeps);
export const POST: AsyncRouteHandler<ReturnType<typeof createProjectMemoryFactHandler>> = createProjectMemoryFactHandler(defaultProjectMemoryHandlerDeps);
