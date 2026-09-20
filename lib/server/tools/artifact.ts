import { ARTIFACT_KINDS, ARTIFACT_LIMITS } from "@/lib/contracts/artifacts";
import type { RunTool } from "./types";

export const ARTIFACT_TOOL_NAME = "create_artifact";

/**
 * Provider-neutral artifact tool. The model proposes a small self-contained
 * bundle; the server owns validation, asset access, versioning and storage.
 */
export function artifactTool(): RunTool {
  return {
    capability: "artifact",
    name: ARTIFACT_TOOL_NAME,
    strict: false,
    description:
      "Create or update a browser artifact when the user asks for a webpage, presentation, HTML game, SVG, chart, or image composition. " +
      "Return complete self-contained files. Use exact asset_ref values from the conversation for images; never invent storage URLs. " +
      "Make the result responsive inside narrow browser frames: include a viewport meta tag, use border-box sizing and avoid fixed minimum widths that clip on phones. " +
      "For a follow-up edit, use intent=update and the exact base_version_id from the previous artifact result. " +
      "The result is saved privately and shown in the conversation; the user can open or publish it as an anonymous browser link. " +
      "Do not use this tool for ordinary prose or a single image generation request.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        base_version_id: { type: ["string", "null"], maxLength: 128 },
        entrypoint: { type: ["string", "null"], maxLength: ARTIFACT_LIMITS.maxPathBytes },
        files: {
          type: "array",
          minItems: 1,
          maxItems: ARTIFACT_LIMITS.maxFiles,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              asset_ref: { type: "string", maxLength: 128 },
              mimeType: { type: "string", maxLength: 128 },
              path: { type: "string", maxLength: ARTIFACT_LIMITS.maxPathBytes },
              text: { type: "string", maxLength: ARTIFACT_LIMITS.maxTextFileBytes }
            },
            required: ["mimeType", "path"]
          }
        },
        intent: { type: "string", enum: ["create", "update"] },
        kind: { type: "string", enum: [...ARTIFACT_KINDS] },
        title: { type: "string", minLength: 1, maxLength: ARTIFACT_LIMITS.maxTitleBytes }
      },
      required: ["files", "intent", "kind", "title"]
    }
  };
}
