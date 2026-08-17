import { defaultProjectContentHandlerDeps } from "@/lib/server/projects/defaultProjects";
import { createProjectFolderHandler } from "@/lib/server/projects/contentHandlers";

export const runtime = "nodejs";

export const POST = createProjectFolderHandler(defaultProjectContentHandlerDeps);
