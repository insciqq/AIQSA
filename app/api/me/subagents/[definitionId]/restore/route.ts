import { defaultSubagentDefinitionHandlers } from "@/lib/server/subagents/defaultSubagents";

export const runtime = "nodejs";

type Context = { params: Promise<{ definitionId: string }> };

export const POST = (request: Request, context: Context) => defaultSubagentDefinitionHandlers.restorePOST(request, context);
