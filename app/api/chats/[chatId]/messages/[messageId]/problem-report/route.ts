import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { answerProblemReportHandlers } from "@/lib/server/answerProblemReports/defaultHandlers";

export const runtime = "nodejs";

export const GET: AsyncRouteHandler<typeof answerProblemReportHandlers.GET> = answerProblemReportHandlers.GET;
export const PUT: AsyncRouteHandler<typeof answerProblemReportHandlers.PUT> = answerProblemReportHandlers.PUT;
