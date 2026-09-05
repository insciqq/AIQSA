import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultProjectContentHandlerDeps } from "@/lib/server/projects/defaultProjects";
import {
  createProjectChatHandler,
  createProjectWorkspaceHandler
} from "@/lib/server/projects/contentHandlers";

export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createProjectWorkspaceHandler>> = createProjectWorkspaceHandler(defaultProjectContentHandlerDeps);
export const POST: AsyncRouteHandler<ReturnType<typeof createProjectChatHandler>> = createProjectChatHandler(defaultProjectContentHandlerDeps);
