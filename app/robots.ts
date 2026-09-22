import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
      // Crawlers must fetch shared resources to observe their noindex headers.
      allow: ["/s/", "/a/", "/api/public-shares/", "/api/artifact-public/"]
    }
  };
}
