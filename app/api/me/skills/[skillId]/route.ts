import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultSkillHandlerDeps } from "@/lib/server/skills/defaultSkills";
import {
  createDeleteSkillHandler,
  createGetSkillHandler,
  createUpdateSkillHandler
} from "@/lib/server/skills/handlers";

export const runtime = "nodejs";

export const DELETE: AsyncRouteHandler<ReturnType<typeof createDeleteSkillHandler>> = createDeleteSkillHandler(defaultSkillHandlerDeps);
export const GET: AsyncRouteHandler<ReturnType<typeof createGetSkillHandler>> = createGetSkillHandler(defaultSkillHandlerDeps);
export const PATCH: AsyncRouteHandler<ReturnType<typeof createUpdateSkillHandler>> = createUpdateSkillHandler(defaultSkillHandlerDeps);
