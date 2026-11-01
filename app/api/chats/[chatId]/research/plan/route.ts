import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { prisma } from "@/lib/server/prisma";
import { createResearchPlanHandlers } from "@/lib/server/research/planHandlers";
import { createResearchPlanStore, researchPlanWindows } from "@/lib/server/research/planWindow";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handlers = createResearchPlanHandlers({ resolveAuth: resolveRequestAuth, store: createResearchPlanStore(prisma), windows: researchPlanWindows() });

export const GET: AsyncRouteHandler<typeof handlers.read> = handlers.read;
export const POST: AsyncRouteHandler<typeof handlers.act> = handlers.act;
