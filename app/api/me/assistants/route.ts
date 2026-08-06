import { defaultAssistantHandlerDeps } from "@/lib/server/assistants/defaultAssistants";
import {
  createCreateAssistantHandler,
  createListAssistantsHandler
} from "@/lib/server/assistants/handlers";

export const runtime = "nodejs";

export const GET = createListAssistantsHandler(defaultAssistantHandlerDeps);
export const POST = createCreateAssistantHandler(defaultAssistantHandlerDeps);
