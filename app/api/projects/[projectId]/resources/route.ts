import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultProjectHandlerDeps } from "@/lib/server/projects/defaultProjects";
import {
  createAddProjectResourceHandler,
  createListProjectResourcesHandler
} from "@/lib/server/projects/handlers";

export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createListProjectResourcesHandler>> = createListProjectResourcesHandler(defaultProjectHandlerDeps);
export const POST: AsyncRouteHandler<ReturnType<typeof createAddProjectResourceHandler>> = createAddProjectResourceHandler(defaultProjectHandlerDeps);
