import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultProjectContentHandlerDeps } from "@/lib/server/projects/defaultProjects";
import {
  createProjectFolderDeleteHandler,
  createProjectFolderUpdateHandler
} from "@/lib/server/projects/contentHandlers";

export const runtime = "nodejs";

export const PATCH: AsyncRouteHandler<ReturnType<typeof createProjectFolderUpdateHandler>> = createProjectFolderUpdateHandler(defaultProjectContentHandlerDeps);
export const DELETE: AsyncRouteHandler<ReturnType<typeof createProjectFolderDeleteHandler>> = createProjectFolderDeleteHandler(defaultProjectContentHandlerDeps);
