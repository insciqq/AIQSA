import { defaultAssistantHandlerDeps } from "@/lib/server/assistants/defaultAssistants";
import { createPinAssistantHandler } from "@/lib/server/assistants/handlers";

export const runtime = "nodejs";

const handlers = createPinAssistantHandler(defaultAssistantHandlerDeps);

export const PUT = handlers.PUT;
export const DELETE = handlers.DELETE;
