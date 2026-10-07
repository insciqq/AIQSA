import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultSkillVersionHandlers } from "@/lib/server/skills/defaultSkills";

export const runtime = "nodejs";

export const GET: AsyncRouteHandler<typeof defaultSkillVersionHandlers.GET_VERSIONS> = defaultSkillVersionHandlers.GET_VERSIONS;
