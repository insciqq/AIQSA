import { ARTIFACT_LIMITS, ArtifactContractError } from "@/lib/contracts/artifacts";

/** Message is a content-free code. Details belong only to the private tool result. */
export class ArtifactToolError extends Error {
  readonly path?: string;
  readonly hint: string;
  /** A short verbatim slice of the failing file, for writing an exact old_string. */
  readonly excerpt?: string;
  constructor(readonly code: string, details: { path?: string; hint: string; excerpt?: string }) {
    super(code);
    this.name = "ArtifactToolError";
    this.path = details.path;
    this.hint = details.hint;
    if (details.excerpt !== undefined) this.excerpt = details.excerpt;
  }
}

const MIB = 1024 * 1024;
export const ARTIFACT_ASSET_HINTS = Object.freeze({
  artifact_asset_unavailable: "Use as asset_ref the exact id of a file attached in this conversation or produced in this run; never invent identifiers.",
  artifact_asset_too_large: `Each referenced file may be at most ${ARTIFACT_LIMITS.maxAssetBytes / MIB} MiB; reduce or compress it in Workspace and reference the result.`,
  artifact_asset_mime_mismatch: "Declare mimeType exactly as the referenced file's type.",
  artifact_asset_invalid: "The referenced file's stored bytes could not be verified; ask the user to attach the file again.",
  artifact_asset_checksum_missing: "The referenced file has no stored checksum and cannot be copied; ask the user to attach the file again.",
  artifact_bundle_limit_exceeded: `Keep the artifact's files within ${ARTIFACT_LIMITS.maxBundleBytes / MIB} MiB in total, each referenced file within ${ARTIFACT_LIMITS.maxAssetBytes / MIB} MiB.`,
  artifact_operation_invalid: "Check the artifact file paths, types, entrypoint and size limits, then correct the operation."
});
export type ArtifactAssetErrorCode = keyof typeof ARTIFACT_ASSET_HINTS;
const isAssetErrorCode = (value: string): value is ArtifactAssetErrorCode => Object.hasOwn(ARTIFACT_ASSET_HINTS, value);

/** An unpacked site's entry page names the HTML pages the archive does have. */
function unpackedEntryHint(error: ArtifactContractError): string {
  const pages = error.candidates ?? [];
  if (!pages.length) return "The unpacked site has no HTML page. Zip the site together with its HTML pages, or add an HTML page in files[] and set entrypoint to it.";
  const more = (error.count ?? 0) > pages.length ? ` and ${error.count! - pages.length} more` : "";
  return (error.code === "artifact_entrypoint_missing"
    ? `There is no ${error.path ?? "index.html"} at the site root (a single top-level folder is removed). `
    : `The entry page of an unpacked site must be HTML. `) + `Set entrypoint to one of its HTML pages: ${pages.join(", ")}${more}.`;
}

export function artifactToolError(error: unknown): ArtifactToolError | null {
  if (error instanceof ArtifactToolError) return error;
  if (error instanceof ArtifactContractError) return new ArtifactToolError(error.code, {
    ...(error.path ? { path: error.path } : {}),
    hint: (error.editIndex !== undefined ? `Edit ${error.editIndex + 1}: ` : "") + (error.candidates ? unpackedEntryHint(error)
      : error.code === "artifact_edit_ambiguous" ? `The old_string matches ${error.count} times; provide a unique longer match or set replace_all=true.`
      : error.code === "artifact_file_count_exceeded" ? `One call accepts at most ${ARTIFACT_LIMITS.maxFiles} files[] entries and ${ARTIFACT_LIMITS.maxFiles} delete_paths; an artifact holds at most ${ARTIFACT_LIMITS.maxBundleFiles} files, unpacked ones included. Leave out files the pages do not use, or add the rest in later updates.`
      : error.code === "artifact_unpack_invalid" ? "Set unpack: true on at most one files[] entry per call, together with asset_ref and the archive's exact mimeType (application/zip or application/x-zip-compressed) and without text, for kind html, slides, game or chart. Its files land at the artifact root; path only labels the archive. A ZIP stored with another type must be saved again as a .zip file in the Workspace and that file referenced."
      : error.code === "artifact_edit_limit_exceeded" ? "Use at most 64 edits, with each replacement string no larger than 512 KiB."
      : error.code === "artifact_edit_not_found" ? "Read the accepted artifact file and use an exact old_string from its current text."
      : error.code === "artifact_delete_entrypoint" ? "Keep the entrypoint file; update its content instead of deleting it."
      : error.code === "artifact_entrypoint_missing" ? "Set entrypoint to the exact files[].path of the startup file. Creating any kind except image requires this field; include that file in files. When updating, omit entrypoint to keep the base version's startup file."
      : error.code === "artifact_entrypoint_invalid" ? "Use a safe relative entrypoint path to a text/html or image/svg+xml file in the resulting bundle. Kind svg requires image/svg+xml; kind image requires a null entrypoint."
      : error.code === "artifact_edit_path_invalid" ? "Edit an existing text file of the accepted artifact, or a text file supplied by asset_ref in this call; write inline text in full instead of editing it in the same call."
      : error.code === "artifact_asset_ref_invalid" ? "Give each file either text or the exact asset_ref id of an attached or produced file."
      : error.code === "artifact_mime_invalid" ? "Use a bare type/subtype such as text/html without parameters. Kind image shows only image/png, image/jpeg or image/webp asset_ref files; show other files from an HTML page."
      : error.code === "artifact_text_invalid" ? "Write inline text only for text/html, text/css, text/javascript, application/json, text/plain, text/markdown, text/csv or image/svg+xml files, without NUL or unpaired surrogates; supply any other type by asset_ref."
      : error.code === "artifact_text_limit_exceeded" ? `Text written in the call may be at most ${ARTIFACT_LIMITS.maxTextFileBytes / 1024} KiB per file, and a file supplied by asset_ref at most ${ARTIFACT_LIMITS.maxAssetBytes / (1024 * 1024)} MiB after each edit; reference a larger file by asset_ref or make the edits smaller.`
      : "Check the artifact file paths, types, entrypoint and size limits, then correct the operation.")
  });
  if (error instanceof Error && isAssetErrorCode(error.message)) {
    return new ArtifactToolError(error.message, { hint: ARTIFACT_ASSET_HINTS[error.message] });
  }
  return null;
}
