import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultProjectHandlerDeps } from "@/lib/server/projects/defaultProjects";
import {
  createAddProjectGrantHandler,
  createListProjectGrantsHandler
} from "@/lib/server/projects/handlers";

export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createListProjectGrantsHandler>> = createListProjectGrantsHandler(defaultProjectHandlerDeps);
export const POST: AsyncRouteHandler<ReturnType<typeof createAddProjectGrantHandler>> = createAddProjectGrantHandler(defaultProjectHandlerDeps);
