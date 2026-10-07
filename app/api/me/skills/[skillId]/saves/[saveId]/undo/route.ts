import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultSkillSaveHandlers } from "@/lib/server/skills/defaultSkills";

export const runtime = "nodejs";

export const GET: AsyncRouteHandler<typeof defaultSkillSaveHandlers.GET_UNDO> = defaultSkillSaveHandlers.GET_UNDO;
export const POST: AsyncRouteHandler<typeof defaultSkillSaveHandlers.POST_UNDO> = defaultSkillSaveHandlers.POST_UNDO;
