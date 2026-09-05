import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultProjectContentHandlerDeps } from "@/lib/server/projects/defaultProjects";
import { createProjectFolderHandler } from "@/lib/server/projects/contentHandlers";

export const runtime = "nodejs";

export const POST: AsyncRouteHandler<ReturnType<typeof createProjectFolderHandler>> = createProjectFolderHandler(defaultProjectContentHandlerDeps);
