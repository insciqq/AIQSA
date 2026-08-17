import { defaultProjectContentHandlerDeps } from "@/lib/server/projects/defaultProjects";
import { createProjectChatArchiveHandler } from "@/lib/server/projects/contentHandlers";

export const runtime = "nodejs";

export const POST = createProjectChatArchiveHandler(defaultProjectContentHandlerDeps, true);
