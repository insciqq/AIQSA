import { adminRepository, resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createAdminReleaseStatusHandler } from "@/lib/server/releases/adminReleaseHandlers";
import { readGitHubReleaseStatus } from "@/lib/server/releases/releaseStatus";

export const runtime = "nodejs";

export const GET = createAdminReleaseStatusHandler({
  readStatus: readGitHubReleaseStatus,
  repository: adminRepository,
  resolveAuth: resolveRequestAuth
});
