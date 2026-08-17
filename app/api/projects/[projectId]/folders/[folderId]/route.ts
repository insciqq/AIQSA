import { defaultProjectContentHandlerDeps } from "@/lib/server/projects/defaultProjects";
import {
  createProjectFolderDeleteHandler,
  createProjectFolderUpdateHandler
} from "@/lib/server/projects/contentHandlers";

export const runtime = "nodejs";

export const PATCH = createProjectFolderUpdateHandler(defaultProjectContentHandlerDeps);
export const DELETE = createProjectFolderDeleteHandler(defaultProjectContentHandlerDeps);
