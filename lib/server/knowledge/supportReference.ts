import { createHash } from "node:crypto";

/**
 * Stable, opaque reference for correlating a user-safe processing issue with
 * durable server state. It deliberately carries no raw identifier or failure
 * code across the browser boundary.
 */
export function knowledgeSupportReference(
  kind: "base" | "document" | "reprocess" | "source",
  ...parts: readonly string[]
): string {
  const digest = createHash("sha256")
    .update(["knowledge-support-v1", kind, ...parts].join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, 12)
    .toUpperCase();
  return `K-${digest}`;
}
