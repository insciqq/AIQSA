import { defaultAssistantHandlerDeps } from "@/lib/server/assistants/defaultAssistants";
import {
  createGetAssistantHandler,
  createUpdateAssistantHandler
} from "@/lib/server/assistants/handlers";

export const runtime = "nodejs";

export const GET = createGetAssistantHandler(defaultAssistantHandlerDeps);
export const PATCH = createUpdateAssistantHandler(defaultAssistantHandlerDeps);
