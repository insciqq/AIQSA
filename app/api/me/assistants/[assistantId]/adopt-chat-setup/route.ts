import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultAdoptChatSetupHandlerDeps } from "@/lib/server/assistants/adoptChatSetupDefaults";
import { createAdoptChatSetupHandler } from "@/lib/server/assistants/handlers";

export const runtime = "nodejs";

export const POST: AsyncRouteHandler<ReturnType<typeof createAdoptChatSetupHandler>> = createAdoptChatSetupHandler(defaultAdoptChatSetupHandlerDeps);
