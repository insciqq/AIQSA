const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);

function normalizedEnvValue(value) {
  return value?.trim().toLowerCase() ?? "";
}

function optionalBoolean(value) {
  const normalized = normalizedEnvValue(value);

  if (TRUE_ENV_VALUES.has(normalized)) {
    return true;
  }

  if (FALSE_ENV_VALUES.has(normalized)) {
    return false;
  }

  return null;
}

function secureDeploymentEnabled(env = process.env) {
  const explicitSecure = optionalBoolean(env.AIQSA_COOKIE_SECURE);

  if (explicitSecure !== null) {
    return explicitSecure;
  }

  const appEnv = normalizedEnvValue(env.APP_ENV);

  if (appEnv) {
    return appEnv !== "local";
  }

  return normalizedEnvValue(env.NODE_ENV) === "production";
}

function securityHeaders() {
  const enforceProductionCsp =
    normalizedEnvValue(process.env.NODE_ENV) === "production" && secureDeploymentEnabled();
  const headers = [
    {
      key: "X-Content-Type-Options",
      value: "nosniff"
    },
    {
      key: "X-Frame-Options",
      value: "DENY"
    },
    {
      key: "Referrer-Policy",
      value: "strict-origin-when-cross-origin"
    },
    {
      key: enforceProductionCsp ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only",
      value: enforceProductionCsp
        ? "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; img-src 'self' data: blob:; connect-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; worker-src 'self' blob:; manifest-src 'self'"
        : "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; img-src 'self' data: blob:; connect-src 'self' http: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:"
    }
  ];

  if (secureDeploymentEnabled()) {
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=15552000; includeSubDomains"
    });
  }

  return headers;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost", "app", "aiqsa-app-1", "host.docker.internal"],
  devIndicators: false,
  output: "standalone",
  async headers() {
    return [
      {
        headers: securityHeaders(),
        source: "/:path*"
      }
    ];
  },
  reactStrictMode: true
};

export default nextConfig;
