import { defaultProjectHandlerDeps } from "@/lib/server/projects/defaultProjects";
import {
  createDeleteProjectGrantHandler,
  createUpdateProjectGrantHandler
} from "@/lib/server/projects/handlers";

export const runtime = "nodejs";

export const PATCH = createUpdateProjectGrantHandler(defaultProjectHandlerDeps);
export const DELETE = createDeleteProjectGrantHandler(defaultProjectHandlerDeps);
