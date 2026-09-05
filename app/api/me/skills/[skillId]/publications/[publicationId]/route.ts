import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultSkillHandlerDeps } from "@/lib/server/skills/defaultSkills";
import { createRevokeSkillPublicationHandler } from "@/lib/server/skills/handlers";

export const runtime = "nodejs";

export const DELETE: AsyncRouteHandler<ReturnType<typeof createRevokeSkillPublicationHandler>> = createRevokeSkillPublicationHandler(defaultSkillHandlerDeps);
