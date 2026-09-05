import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultProjectHandlerDeps } from "@/lib/server/projects/defaultProjects";
import { createDeleteProjectResourceHandler } from "@/lib/server/projects/handlers";

export const runtime = "nodejs";

export const DELETE: AsyncRouteHandler<ReturnType<typeof createDeleteProjectResourceHandler>> = createDeleteProjectResourceHandler(defaultProjectHandlerDeps);
