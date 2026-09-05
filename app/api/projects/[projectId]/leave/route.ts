import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultProjectHandlerDeps } from "@/lib/server/projects/defaultProjects";
import { createLeaveProjectHandler } from "@/lib/server/projects/handlers";

export const runtime = "nodejs";

export const POST: AsyncRouteHandler<ReturnType<typeof createLeaveProjectHandler>> = createLeaveProjectHandler(defaultProjectHandlerDeps);
