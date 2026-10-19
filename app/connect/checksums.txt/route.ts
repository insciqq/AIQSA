import { connectDistributionHandlers } from "@/lib/server/connect/distributionDefaults";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = connectDistributionHandlers.checksums;
