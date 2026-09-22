import { ArtifactContractError } from "@/lib/contracts/artifacts";

/** Message is a content-free code. Details belong only to the private tool result. */
export class ArtifactToolError extends Error {
  readonly path?: string;
  readonly hint: string;
  constructor(readonly code: string, details: { path?: string; hint: string }) {
    super(code);
    this.name = "ArtifactToolError";
    this.path = details.path;
    this.hint = details.hint;
  }
}

export function artifactToolError(error: unknown): ArtifactToolError | null {
  if (error instanceof ArtifactToolError) return error;
  if (error instanceof ArtifactContractError) return new ArtifactToolError(error.code, {
    ...(error.path ? { path: error.path } : {}),
    hint: (error.editIndex !== undefined ? `Edit ${error.editIndex + 1}: ` : "") + (error.code === "artifact_edit_ambiguous" ? `The old_string matches ${error.count} times; provide a unique longer match or set replace_all=true.`
      : error.code === "artifact_edit_limit_exceeded" ? "Use at most 64 edits, with each replacement string no larger than 512 KiB."
      : error.code === "artifact_edit_not_found" ? "Read the accepted artifact file and use an exact old_string from its current text."
      : error.code === "artifact_delete_entrypoint" ? "Keep the entrypoint file; update its content instead of deleting it."
      : error.code === "artifact_entrypoint_missing" ? "Set entrypoint to the exact files[].path of the startup file. Creating any kind except image requires this field; include that file in files. When updating, omit entrypoint to keep the base version's startup file."
      : error.code === "artifact_entrypoint_invalid" ? "Use a safe relative entrypoint path to a text/html or image/svg+xml file in the resulting bundle. Kind svg requires image/svg+xml; kind image requires a null entrypoint."
      : error.code === "artifact_edit_path_invalid" ? "Use an existing text file path from the accepted artifact manifest."
      : "Check the artifact file paths, types, entrypoint and size limits, then correct the operation.")
  });
  if (error instanceof Error && ["artifact_asset_unavailable", "artifact_asset_too_large", "artifact_asset_mime_mismatch", "artifact_asset_invalid", "artifact_bundle_limit_exceeded", "artifact_operation_invalid"].includes(error.message)) {
    return new ArtifactToolError(error.message, { hint: "Use only exact accepted image asset_ref values with matching types and keep files within the artifact size limits." });
  }
  return null;
}
