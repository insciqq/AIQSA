import { connectAdminPolicyHandlers } from "@/lib/server/connect/defaults";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = connectAdminPolicyHandlers.GET;
export const PATCH = connectAdminPolicyHandlers.PATCH;
