import { defaultSkillHandlerDeps } from "@/lib/server/skills/defaultSkills";
import {
  createDeleteSkillHandler,
  createGetSkillHandler,
  createUpdateSkillHandler
} from "@/lib/server/skills/handlers";

export const runtime = "nodejs";

export const DELETE = createDeleteSkillHandler(defaultSkillHandlerDeps);
export const GET = createGetSkillHandler(defaultSkillHandlerDeps);
export const PATCH = createUpdateSkillHandler(defaultSkillHandlerDeps);
