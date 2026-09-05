import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultProjectHandlerDeps } from "@/lib/server/projects/defaultProjects";
import { createProjectResourcePreviewHandler } from "@/lib/server/projects/handlers";

export const runtime = "nodejs";

export const POST: AsyncRouteHandler<ReturnType<typeof createProjectResourcePreviewHandler>> = createProjectResourcePreviewHandler(defaultProjectHandlerDeps);
