import { defaultSkillHandlerDeps } from "@/lib/server/skills/defaultSkills";
import { createRevokeSkillPublicationHandler } from "@/lib/server/skills/handlers";

export const runtime = "nodejs";

export const DELETE = createRevokeSkillPublicationHandler(defaultSkillHandlerDeps);
