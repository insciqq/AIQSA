import { createExportSkillsHandler } from "@/lib/server/skills/bundleHandlers";
import { defaultSkillBundleHandlerDeps } from "@/lib/server/skills/defaultSkills";

export const runtime = "nodejs";
const handler = createExportSkillsHandler(defaultSkillBundleHandlerDeps);
export const GET = (request: Request) => handler(request);
