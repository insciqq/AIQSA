import { parseArtifactRuntimeError, type ArtifactRuntimeError } from "@/lib/contracts/artifactRuntime";

const prefix = "aiqsa.artifactFix.";
const maxBytes = 1024;

export function artifactRuntimeFixDraft(error?: ArtifactRuntimeError | null): string {
  if (!error) return "Fix the runtime error in this artifact.";
  return error.kind === "csp"
    ? `Fix the runtime error in this artifact: blocked ${error.directive} (${error.blocked}).`
    : `Fix the runtime error in this artifact: ${error.message} (line ${error.line}:${error.column}).`;
}

/** Error text stays in this tab; navigation carries only the edit intent and version identity. */
export function storeArtifactRuntimeError(versionId: string, error: ArtifactRuntimeError): void {
  const value = parseArtifactRuntimeError({ type: "aiqsa_artifact_runtime_error", ...error });
  if (!value) throw new Error("The runtime error could not be read. Reopen the preview and try again.");
  let message = value.message;
  let encoded = JSON.stringify({ type: "aiqsa_artifact_runtime_error", ...value });
  while (new TextEncoder().encode(encoded).byteLength > maxBytes && message.length) {
    message = Array.from(message).slice(0, -1).join("");
    encoded = JSON.stringify({ type: "aiqsa_artifact_runtime_error", ...value, message });
  }
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) throw new Error("The runtime error is too large to transfer.");
  try { sessionStorage.setItem(`${prefix}${versionId}`, encoded); }
  catch { throw new Error("Could not prepare the error for editing. Allow session storage and try again."); }
}

export function consumeArtifactRuntimeError(versionId: string): ArtifactRuntimeError | null {
  try {
    const key = `${prefix}${versionId}`;
    const encoded = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    if (!encoded || new TextEncoder().encode(encoded).byteLength > maxBytes) return null;
    return parseArtifactRuntimeError(JSON.parse(encoded));
  } catch { return null; }
}
