import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { getAuthConfig } from "@/lib/server/auth/config";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function enabled(value: string | undefined): boolean {
  return TRUE_VALUES.has(value?.trim().toLowerCase() ?? "");
}

function usable(value: string | undefined): value is string {
  return Boolean(value?.trim() && !value.startsWith("replace-with-"));
}

export function productionRuntimeIssues(
  env: Record<string, string | undefined>
): string[] {
  const auth = getAuthConfig(env);
  const issues: string[] = [];

  if (!auth.configured) {
    issues.push("session_secret");
  }

  if (!usable(env.DATABASE_URL)) {
    issues.push("database_url");
  }

  const appEnv = auth.appEnv.trim().toLowerCase();
  const nodeProduction = env.NODE_ENV?.trim().toLowerCase() === "production";

  if (appEnv === "local" && !nodeProduction) {
    return issues;
  }

  if (appEnv !== "production") {
    issues.push("app_env");
  }

  try {
    const baseUrl = new URL(auth.appBaseUrl);
    if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password) {
      issues.push("app_base_url");
    }
  } catch {
    issues.push("app_base_url");
  }

  if (!auth.cookieSecure) {
    issues.push("secure_cookie");
  }

  if (auth.bootstrapLoginEnabled) {
    issues.push("bootstrap_login");
  }

  if (enabled(env.PLAYWRIGHT_TEST_AUTH) || enabled(env.AIQSA_FAKE_PROVIDER) || enabled(env.AIQSA_SHOW_FAKE_PROVIDER)) {
    issues.push("test_runtime");
  }

  if (!usable(env.S3_ENDPOINT)) {
    issues.push("s3_endpoint");
  }
  if (!usable(env.S3_REGION)) {
    issues.push("s3_region");
  }
  if (!usable(env.S3_BUCKET)) {
    issues.push("s3_bucket");
  }
  if (!usable(env.S3_ACCESS_KEY_ID)) {
    issues.push("s3_access_key");
  }
  if (!usable(env.S3_SECRET_ACCESS_KEY)) {
    issues.push("s3_secret_key");
  }

  return issues;
}

export async function checkS3Readiness(
  env: Record<string, string | undefined>
): Promise<void> {
  const endpoint = env.S3_ENDPOINT?.trim();
  const region = env.S3_REGION?.trim();
  const bucket = env.S3_BUCKET?.trim();
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();

  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("S3 readiness configuration is incomplete");
  }

  const client = new S3Client({
    credentials: { accessKeyId, secretAccessKey },
    endpoint,
    forcePathStyle: true,
    region
  });

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }), {
      abortSignal: AbortSignal.timeout(3_000)
    });
  } finally {
    client.destroy();
  }
}
