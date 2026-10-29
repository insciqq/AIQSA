import { defaultSubagentDefinitionHandlers } from "@/lib/server/subagents/defaultSubagents";

export const runtime = "nodejs";

export const GET = (request: Request) => defaultSubagentDefinitionHandlers.GET(request);
export const POST = (request: Request) => defaultSubagentDefinitionHandlers.POST(request);
