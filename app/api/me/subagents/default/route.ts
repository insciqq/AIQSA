import { defaultSubagentDefinitionHandlers } from "@/lib/server/subagents/defaultSubagents";

export const runtime = "nodejs";

export const GET = (request: Request) => defaultSubagentDefinitionHandlers.defaultGET(request);
export const PUT = (request: Request) => defaultSubagentDefinitionHandlers.defaultPUT(request);
