import { defaultSubagentDefinitionHandlers } from "@/lib/server/subagents/defaultSubagents";

export const runtime = "nodejs";

type Context = { params: Promise<{ definitionId: string }> };

export const GET = (request: Request, context: Context) => defaultSubagentDefinitionHandlers.detailGET(request, context);
export const PATCH = (request: Request, context: Context) => defaultSubagentDefinitionHandlers.detailPATCH(request, context);
export const DELETE = (request: Request, context: Context) => defaultSubagentDefinitionHandlers.detailDELETE(request, context);
