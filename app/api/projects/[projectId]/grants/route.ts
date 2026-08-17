import { defaultProjectHandlerDeps } from "@/lib/server/projects/defaultProjects";
import {
  createAddProjectGrantHandler,
  createListProjectGrantsHandler
} from "@/lib/server/projects/handlers";

export const runtime = "nodejs";

export const GET = createListProjectGrantsHandler(defaultProjectHandlerDeps);
export const POST = createAddProjectGrantHandler(defaultProjectHandlerDeps);
