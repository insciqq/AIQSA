import {
  adminProviderQuickSetupGET,
  adminProviderQuickSetupPOST
} from "@/lib/server/admin/providers/quickSetupDefault";

export const runtime = "nodejs";

export const GET = adminProviderQuickSetupGET;
export const POST = adminProviderQuickSetupPOST;
