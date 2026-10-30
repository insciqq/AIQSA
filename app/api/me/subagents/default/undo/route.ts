import { defaultSubagentDefinitionHandlers } from "@/lib/server/subagents/defaultSubagents";

export const runtime = "nodejs";

export const POST = (request: Request) => defaultSubagentDefinitionHandlers.defaultUndoPOST(request);
