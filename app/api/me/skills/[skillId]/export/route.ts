import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { createExportSkillsHandler } from "@/lib/server/skills/bundleHandlers";
import { defaultSkillBundleHandlerDeps } from "@/lib/server/skills/defaultSkills";

export const runtime = "nodejs";
export const GET: AsyncRouteHandler<ReturnType<typeof createExportSkillsHandler>> = createExportSkillsHandler(defaultSkillBundleHandlerDeps);
