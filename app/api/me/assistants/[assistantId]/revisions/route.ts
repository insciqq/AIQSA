import { defaultAssistantHandlerDeps } from "@/lib/server/assistants/defaultAssistants";
import { createListAssistantRevisionsHandler } from "@/lib/server/assistants/handlers";

export const runtime = "nodejs";

export const GET = createListAssistantRevisionsHandler(defaultAssistantHandlerDeps);
