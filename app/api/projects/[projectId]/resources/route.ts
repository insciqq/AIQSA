import { defaultProjectHandlerDeps } from "@/lib/server/projects/defaultProjects";
import {
  createAddProjectResourceHandler,
  createListProjectResourcesHandler
} from "@/lib/server/projects/handlers";

export const runtime = "nodejs";

export const GET = createListProjectResourcesHandler(defaultProjectHandlerDeps);
export const POST = createAddProjectResourceHandler(defaultProjectHandlerDeps);
