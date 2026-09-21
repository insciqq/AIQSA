import { defaultSkillSharingHandlers } from "@/lib/server/skills/defaultSkills";

export const runtime = "nodejs";
export const POST = defaultSkillSharingHandlers.request;
export const DELETE = defaultSkillSharingHandlers.withdraw;
