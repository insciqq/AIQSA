import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultProjectHandlerDeps } from "@/lib/server/projects/defaultProjects";
import {
  createDeleteProjectHandler,
  createGetProjectHandler,
  createUpdateProjectHandler
} from "@/lib/server/projects/handlers";

export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createGetProjectHandler>> = createGetProjectHandler(defaultProjectHandlerDeps);
export const PATCH: AsyncRouteHandler<ReturnType<typeof createUpdateProjectHandler>> = createUpdateProjectHandler(defaultProjectHandlerDeps);
export const DELETE: AsyncRouteHandler<ReturnType<typeof createDeleteProjectHandler>> = createDeleteProjectHandler(defaultProjectHandlerDeps);
