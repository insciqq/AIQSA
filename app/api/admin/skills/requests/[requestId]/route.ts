import { defaultSkillSharingHandlers } from "@/lib/server/skills/defaultSkills";

export const runtime = "nodejs";
export const GET = defaultSkillSharingHandlers.detail;
export const POST = defaultSkillSharingHandlers.decide;
