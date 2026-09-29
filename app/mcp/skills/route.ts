import { createSkillsMcpHandler } from "@/lib/server/skillsMcp/handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const handler = createSkillsMcpHandler();
export const GET = handler.GET;
export const POST = handler.POST;
