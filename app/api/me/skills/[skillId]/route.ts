import { defaultSkillHandlerDeps } from "@/lib/server/skills/defaultSkills";
import { createUpdateSkillHandler } from "@/lib/server/skills/handlers";

export const runtime = "nodejs";

export const PATCH = createUpdateSkillHandler(defaultSkillHandlerDeps);
