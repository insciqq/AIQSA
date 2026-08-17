import { defaultProjectContentHandlerDeps } from "@/lib/server/projects/defaultProjects";
import {
  createProjectChatHandler,
  createProjectWorkspaceHandler
} from "@/lib/server/projects/contentHandlers";

export const runtime = "nodejs";

export const GET = createProjectWorkspaceHandler(defaultProjectContentHandlerDeps);
export const POST = createProjectChatHandler(defaultProjectContentHandlerDeps);
