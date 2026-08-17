import { defaultProjectHandlerDeps } from "@/lib/server/projects/defaultProjects";
import {
  createDeleteProjectHandler,
  createGetProjectHandler,
  createUpdateProjectHandler
} from "@/lib/server/projects/handlers";

export const runtime = "nodejs";

export const GET = createGetProjectHandler(defaultProjectHandlerDeps);
export const PATCH = createUpdateProjectHandler(defaultProjectHandlerDeps);
export const DELETE = createDeleteProjectHandler(defaultProjectHandlerDeps);
