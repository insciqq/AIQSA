import { defaultAssistantHandlerDeps } from "@/lib/server/assistants/defaultAssistants";
import { createDuplicateAssistantHandler } from "@/lib/server/assistants/handlers";

export const runtime = "nodejs";

export const POST = createDuplicateAssistantHandler(defaultAssistantHandlerDeps);
