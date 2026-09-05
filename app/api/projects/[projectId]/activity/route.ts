import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultProjectHandlerDeps } from "@/lib/server/projects/defaultProjects";
import { createProjectActivityHandler } from "@/lib/server/projects/handlers";

export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createProjectActivityHandler>> = createProjectActivityHandler(defaultProjectHandlerDeps);
