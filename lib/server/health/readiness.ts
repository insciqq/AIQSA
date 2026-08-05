import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { isIP } from "node:net";
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

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }

  const family = isIP(normalized);

  return (family === 4 && normalized.startsWith("127.")) ||
    (family === 6 && normalized === "::1");
}

export function runtimeConfigurationIssues(
  env: Record<string, string | undefined>
): string[] {
  const auth = getAuthConfig(env);
  const issues: string[] = [];
  const bindAddress = env.AIQSA_BIND_ADDRESS?.trim() || "127.0.0.1";

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
  let loopbackBaseUrl = false;
  try {
    const baseUrl = new URL(auth.appBaseUrl);
    secureBaseUrl = baseUrl.protocol === "https:";
    loopbackBaseUrl = isLoopbackHostname(baseUrl.hostname);
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
    !auth.trustedProxyConfigurationValid ||
    !isLoopbackHostname(bindAddress) ||
    (!loopbackBaseUrl && !auth.trustForwardedFor)
  ) {
    issues.push("trusted_proxy");
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
