import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { getAuthConfig } from "@/lib/server/auth/config";
import {
  parseSecretEncryptionKey,
  SecretEnvelopeError
} from "@/lib/server/secrets/envelope";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function enabled(value: string | undefined): boolean {
  return TRUE_VALUES.has(value?.trim().toLowerCase() ?? "");
}

function usable(value: string | undefined): value is string {
  return Boolean(value?.trim() && !value.startsWith("replace-with-"));
}

export function runtimeConfigurationIssues(
  env: Record<string, string | undefined>
): string[] {
  const auth = getAuthConfig(env);
  const issues: string[] = [];

  if (!auth.configured) {
    issues.push("session_secret");
  }

  try {
    parseSecretEncryptionKey(env.AIQSA_ENCRYPTION_KEY);
  } catch (error) {
    if (
      error instanceof SecretEnvelopeError &&
      error.message === "secret_encryption_invalid_key"
    ) {
      issues.push("encryption_key");
    } else {
      throw error;
    }
  }

  if (!usable(env.DATABASE_URL)) {
    issues.push("database_url");
  }

  let secureBaseUrl = false;
  try {
    const baseUrl = new URL(auth.appBaseUrl);
    secureBaseUrl = baseUrl.protocol === "https:";
    if (!new Set(["http:", "https:"]).has(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
      issues.push("app_base_url");
    }
  } catch {
    issues.push("app_base_url");
  }

  if (auth.cookieSecure !== secureBaseUrl) {
    issues.push("secure_cookie");
  }

  if (
    auth.clientIdentityMode === "invalid"
  ) {
    issues.push("client_identity");
  }

  if (auth.bootstrapLoginEnabled) {
    issues.push("bootstrap_login");
  }

  if (
    enabled(env.AIQSA_TEST_MODE) ||
    enabled(env.PLAYWRIGHT_TEST_AUTH)
  ) {
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
