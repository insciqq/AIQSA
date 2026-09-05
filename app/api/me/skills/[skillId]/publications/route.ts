import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultSkillHandlerDeps } from "@/lib/server/skills/defaultSkills";
import { createPublishSkillHandler } from "@/lib/server/skills/handlers";

export const runtime = "nodejs";

export const POST: AsyncRouteHandler<ReturnType<typeof createPublishSkillHandler>> = createPublishSkillHandler(defaultSkillHandlerDeps);
