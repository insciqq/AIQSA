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
  experimental: {
    // proxy.ts authenticates and applies the same-origin boundary before every
    // private route. Its framework-level forwarding cap must therefore cover
    // the complete hard-ceiling upload envelope (64 MiB source plus 8 MiB
    // multipart overhead). Route-specific admission, streaming concurrency,
    // content inspection, and lower operator limits remain authoritative.
    proxyClientMaxBodySize: 67_108_864 + 8_388_608,
    // Turbopack can evict compiler memory after persisting it to disk.
    turbopackFileSystemCacheForDev: true
  },
  output: "standalone",
  // Native sharp loads libvips through the dynamic linker. JS tracing retains
  // lib/index.js but can omit the shared library resolved by the addon wrapper.
  outputFileTracingIncludes: {
    "/*": ["./node_modules/@img/sharp-libvips-*/lib/**/*"]
  },
  serverExternalPackages: [
    "@napi-rs/canvas",
    "microsandbox",
    "microsandbox-mcp",
    "pdf-lib",
    "unpdf"
  ],
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
