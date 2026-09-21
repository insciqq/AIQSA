import { createImportSkillsHandler } from "@/lib/server/skills/bundleHandlers";
import { defaultSkillBundleHandlerDeps } from "@/lib/server/skills/defaultSkills";

export const runtime = "nodejs";
export const POST = createImportSkillsHandler(defaultSkillBundleHandlerDeps);
