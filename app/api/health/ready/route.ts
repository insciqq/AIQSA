import { prisma } from "@/lib/server/prisma";
import { getAuthConfig } from "@/lib/server/auth/config";
import { resolveLoginRateLimitIdentity } from "@/lib/server/auth/clientIdentity";
import {
  checkS3Readiness,
  runtimeConfigurationIssues
} from "@/lib/server/health/readiness";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let lastReportedFailure = "";

function reportFailure(issues: string[]): void {
  const key = [...new Set(issues)].sort().join(",");

  if (key && key !== lastReportedFailure) {
    lastReportedFailure = key;
    console.warn(`AIQSA readiness not ready: ${key}`);
  }
}

function reportReady(): void {
  lastReportedFailure = "";
}

export function resetReadinessReportingForTests(): void {
  lastReportedFailure = "";
}

function unavailable() {
  return Response.json(
    { status: "not_ready" },
    {
      headers: { "Cache-Control": "no-store" },
      status: 503
    }
  );
}

export async function GET(
  request: Request = new Request("http://localhost/api/health/ready")
) {
  const configurationIssues = runtimeConfigurationIssues(process.env);

  if (configurationIssues.length > 0) {
    reportFailure(configurationIssues);
    return unavailable();
  }

  const auth = getAuthConfig(process.env);

  if (
    auth.clientIdentityMode === "direct_peer" &&
    resolveLoginRateLimitIdentity(request, auth).status !== "available"
  ) {
    reportFailure(["runtime_peer_identity"]);
    return unavailable();
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    reportFailure(["database_unavailable"]);
    return unavailable();
  }

  try {
    await checkS3Readiness(process.env);
  } catch {
    reportFailure(["object_storage_unavailable"]);
    return unavailable();
  }

  reportReady();

  return Response.json(
    { status: "ready" },
    {
      headers: { "Cache-Control": "no-store" }
    }
  );
}
