import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { createReadSkillFileHandler } from "@/lib/server/skills/bundleHandlers";
import { defaultSkillBundleHandlerDeps } from "@/lib/server/skills/defaultSkills";

export const runtime = "nodejs";
export const GET: AsyncRouteHandler<ReturnType<typeof createReadSkillFileHandler>> = createReadSkillFileHandler(defaultSkillBundleHandlerDeps);
