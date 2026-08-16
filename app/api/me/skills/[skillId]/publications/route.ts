import { defaultSkillHandlerDeps } from "@/lib/server/skills/defaultSkills";
import { createPublishSkillHandler } from "@/lib/server/skills/handlers";

export const runtime = "nodejs";

export const POST = createPublishSkillHandler(defaultSkillHandlerDeps);
