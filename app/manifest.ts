import type { MetadataRoute } from "next";

/** Installable-app metadata; the icons are rasterized from the Bubble-Q mark in `public/icon.svg`. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    background_color: "#0c1017",
    description: "Self-hosted AI workspace with multi-provider chat, MCP tools, and web search",
    display: "standalone",
    icons: [
      { sizes: "any", src: "/icon.svg", type: "image/svg+xml" },
      { sizes: "192x192", src: "/icon-192.png", type: "image/png" },
      { purpose: "any", sizes: "512x512", src: "/icon-512.png", type: "image/png" }
    ],
    name: "AIQSA",
    short_name: "AIQSA",
    start_url: "/",
    theme_color: "#0c1017"
  };
}
