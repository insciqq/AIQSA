import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultSkillVersionHandlers } from "@/lib/server/skills/defaultSkills";

export const runtime = "nodejs";

export const POST: AsyncRouteHandler<typeof defaultSkillVersionHandlers.POST_RESTORE> = defaultSkillVersionHandlers.POST_RESTORE;
