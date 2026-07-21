import { prisma } from "@/lib/server/prisma";
import {
  checkS3Readiness,
  productionRuntimeIssues
} from "@/lib/server/health/readiness";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function unavailable() {
  return Response.json(
    { status: "not_ready" },
    {
      headers: { "Cache-Control": "no-store" },
      status: 503
    }
  );
}

export async function GET() {
  if (productionRuntimeIssues(process.env).length > 0) {
    return unavailable();
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
    await checkS3Readiness(process.env);
  } catch {
    return unavailable();
  }

  return Response.json(
    { status: "ready" },
    {
      headers: { "Cache-Control": "no-store" }
    }
  );
}
