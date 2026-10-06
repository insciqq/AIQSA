import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultSkillSaveHandlers } from "@/lib/server/skills/defaultSkills";

export const runtime = "nodejs";

export const GET: AsyncRouteHandler<typeof defaultSkillSaveHandlers.GET_FILE> = defaultSkillSaveHandlers.GET_FILE;
