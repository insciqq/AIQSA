import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultProjectHandlerDeps } from "@/lib/server/projects/defaultProjects";
import {
  createDeleteProjectGrantHandler,
  createPreviewProjectGrantRemovalHandler,
  createUpdateProjectGrantHandler
} from "@/lib/server/projects/handlers";

export const runtime = "nodejs";

export const PATCH: AsyncRouteHandler<ReturnType<typeof createUpdateProjectGrantHandler>> = createUpdateProjectGrantHandler(defaultProjectHandlerDeps);
export const DELETE: AsyncRouteHandler<ReturnType<typeof createDeleteProjectGrantHandler>> = createDeleteProjectGrantHandler(defaultProjectHandlerDeps);
export const GET: AsyncRouteHandler<ReturnType<typeof createPreviewProjectGrantRemovalHandler>> = createPreviewProjectGrantRemovalHandler(defaultProjectHandlerDeps);
