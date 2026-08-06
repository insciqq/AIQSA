import { defaultAssistantHandlerDeps } from "@/lib/server/assistants/defaultAssistants";
import { createRevokeAssistantPublicationHandler } from "@/lib/server/assistants/handlers";

export const runtime = "nodejs";

export const DELETE = createRevokeAssistantPublicationHandler(defaultAssistantHandlerDeps);
