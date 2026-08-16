import { defaultSkillHandlerDeps } from "@/lib/server/skills/defaultSkills";
import {
  createCreateSkillHandler,
  createListSkillsHandler
} from "@/lib/server/skills/handlers";

export const runtime = "nodejs";

export const GET = createListSkillsHandler(defaultSkillHandlerDeps);
export const POST = createCreateSkillHandler(defaultSkillHandlerDeps);
