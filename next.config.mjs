function securityHeaders() {
  return [
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
    }
  ];
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost", "app", "aiqsa-app-1", "host.docker.internal"],
  devIndicators: false,
  output: "standalone",
  serverExternalPackages: ["unpdf"],
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
