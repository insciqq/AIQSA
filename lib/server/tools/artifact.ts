import { ARTIFACT_KINDS, ARTIFACT_LIMITS } from "@/lib/contracts/artifacts";
import { getArtifactResourcePolicy, type ArtifactResourcePolicy } from "../artifacts/resourcePolicy";
import type { RunTool } from "./types";

export const ARTIFACT_TOOL_NAME = "create_artifact";

/** Capabilities are frozen at admission; downloading always rechecks current policy. */
export function describeArtifactTool(policy: ArtifactResourcePolicy = getArtifactResourcePolicy()): string {
  const resources = policy.on
    ? `The server can download and freeze HTTPS scripts, stylesheets and fonts from these library hosts: ${policy.libraryHosts.join(", ") || "none"}. ` +
      `External image hosts: ${policy.imageHosts.join(", ") || "none (use conversation asset_ref images)"}. ` +
      "Use exact versions, never latest/ranges; no query or fragment for libraries. " +
      (policy.libraryHosts.includes("cdnjs.cloudflare.com") ? "For cdnjs use /ajax/libs/<library>/<version>/<file>. " : "") +
      (policy.libraryHosts.includes("cdn.jsdelivr.net") ? "For jsDelivr use /npm/<package>@<version>/<file>. " : "") +
      (policy.libraryHosts.includes("unpkg.com") ? "For unpkg use /<package>@<version>/<file>. " : "") +
      (policy.libraryHosts.includes("fonts.googleapis.com") && policy.libraryHosts.includes("fonts.gstatic.com")
        ? "Google Fonts CSS supports only family and display parameters. " : "") +
      "Do not invent integrity hashes; omit integrity unless verified. " +
      "Only self-contained UMD/IIFE or single-file modules without imports work; remote module graphs are unsupported. "
    : "New external resource downloads are disabled. Use inline or included files and exact conversation asset_ref images; saved vendored resources remain usable. ";
  return "Create or update a browser artifact (webpage, slides, HTML game, SVG, chart or image composition) when the user asks for one. " +
    "For intent=create, provide kind, title and files. Every kind except image also requires an explicit entrypoint matching an included files[].path, for example entrypoint=\"index.html\" for an included index.html. " +
    "The entrypoint file must have MIME type text/html or image/svg+xml; kind=svg requires image/svg+xml. For kind=image, omit entrypoint or set it to null and use only asset_ref image files. " +
    "Write HTML, CSS and JavaScript. Prefer plain CSS; ready precompiled CSS is supported. React/JSX compilation, Tailwind Play CDN and browser/server Tailwind compilation are unavailable. " +
    "Return complete files with relative local paths, inline code, or supported external resources. " + resources +
    "The viewer runs offline: no fetch/XHR/WebSocket/beacon or other network requests. Embed required data already obtained from conversation/tools as inline JSON. " +
    "Forms may handle submit in JavaScript; never use action or formaction. HTTP(S)/mailto links and window.open ask the viewer to confirm the full address. " +
    "localStorage persists only in this viewer's browser (64 keys, 128 characters/key, 32 KiB/value, 256 KiB total, UTF-16); handle QuotaExceededError. sessionStorage is in-memory; cookies are unavailable. " +
    "Blob downloads, pointer lock, fullscreen and clipboard writes are available subject to browser/user activation rules. " +
    "No nested iframe/object/embed, eval-dependent libraries, alert/confirm/prompt, popups or top navigation. " +
    "Images may use exact asset_ref values from the conversation; never invent identifiers. Make layouts responsive with viewport metadata, border-box sizing and no fixed minimum widths. " +
    "For follow-up changes use intent=update and the exact base_version_id; unmentioned files/assets are preserved. Omit entrypoint to keep the base version's startup file, or supply the exact path of a valid entry file in the resulting bundle. Prefer edits with exact old_string to new_string replacements for small changes. " +
    "_vendor paths are server-managed read-only resources; never author or edit them. " +
    "The result is saved privately and appears as a conversation card the user can open; do not claim it is already open. Do not use this tool for ordinary prose or a single image generation request.";
}

// Accepted requests from before descriptor snapshots retain their original guidance.
const LEGACY_ARTIFACT_DESCRIPTION =
  "Create or update a browser artifact (webpage, slides, HTML game, SVG, chart or image composition) when the user asks for one. " +
  "The artifact runs offline in a sandbox with no network. Write HTML, CSS and JavaScript; React/JSX and Tailwind compilation are not available. " +
  "Return complete, self-contained files: put JS and CSS inline or in local files referenced by relative paths. " +
  "Not available: external scripts, stylesheets, fonts or images (no CDN, no http(s) resources), <form>, <iframe>, external <a href> links (write the URL as text), CSS @import, eval-dependent libraries, alert/confirm/prompt, localStorage and cookies. " +
  "Draw charts with inline SVG or canvas. If the artifact needs data (rates, weather, tables), embed the data you already have from the conversation or your tools as inline JSON; the artifact cannot fetch anything. " +
  "For images use exact asset_ref values from the conversation; never invent URLs. Make it responsive: viewport meta tag, border-box sizing, no fixed minimum widths. " +
  "For a follow-up edit use intent=update with the exact base_version_id from the previous artifact result. " +
  "The result is saved privately and appears in the conversation as a card the user can open in a preview panel; do not claim it is already open. Do not use this tool for ordinary prose or a single image generation request. " +
  "For small changes prefer intent=update with edits (exact old_string → new_string replacements) instead of resending whole files.";

/**
 * Provider-neutral artifact tool. The model proposes a small self-contained
 * bundle; the server owns validation, asset access, versioning and storage.
 */
export function artifactTool(description = LEGACY_ARTIFACT_DESCRIPTION): RunTool {
  return {
    capability: "artifact",
    name: ARTIFACT_TOOL_NAME,
    strict: false,
    description,
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
        edits: { type: "array", maxItems: ARTIFACT_LIMITS.maxEdits, items: { type: "object", additionalProperties: false,
          properties: { path: { type: "string", maxLength: ARTIFACT_LIMITS.maxPathBytes },
            old_string: { type: "string", minLength: 1, maxLength: ARTIFACT_LIMITS.maxTextFileBytes },
            new_string: { type: "string", maxLength: ARTIFACT_LIMITS.maxTextFileBytes }, replace_all: { type: "boolean" } },
          required: ["path", "old_string", "new_string"] } },
        delete_paths: { type: "array", maxItems: ARTIFACT_LIMITS.maxFiles, items: { type: "string", maxLength: ARTIFACT_LIMITS.maxPathBytes } },
        intent: { type: "string", enum: ["create", "update"] },
        kind: { type: "string", enum: [...ARTIFACT_KINDS] },
        title: { type: "string", minLength: 1, maxLength: ARTIFACT_LIMITS.maxTitleBytes }
      },
      required: ["intent"]
    }
  };
}

export const READ_ARTIFACT_TOOL_NAME = "read_artifact";
export function readArtifactTool(): RunTool {
  return { capability: "artifact", name: READ_ARTIFACT_TOOL_NAME, strict: false,
    description: "Read file text from an artifact version accepted for this message. Supply artifact_id from the manifest, optional paths and unchanged next_cursor to continue. Each bounded page includes path and UTF-16 text offset; binary files expose metadata only.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      artifact_id: { type: "string", minLength: 1, maxLength: 128 },
      paths: { type: "array", minItems: 1, maxItems: ARTIFACT_LIMITS.maxFiles, items: { type: "string", maxLength: ARTIFACT_LIMITS.maxPathBytes } },
      cursor: { type: "string", maxLength: 1024 }
    }, required: ["artifact_id"] } };
}
