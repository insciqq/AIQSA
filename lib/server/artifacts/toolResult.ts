import type { ModelToolCall, ToolExecutionResult } from "../tools/types";

/** The same exact-version receipt is used by execution and crash recovery. */
export function artifactToolResult(call: Pick<ModelToolCall, "id" | "name">, version: {
  artifactId: string; id: string; versionNumber: number; kind: string; title: string; entrypoint: string | null;
  manifest: { files: ReadonlyArray<{ byteSize: number }> };
}): ToolExecutionResult {
  const payload = { artifact_id: version.artifactId, version_id: version.id, version_number: version.versionNumber,
    kind: version.kind, title: version.title, entrypoint: version.entrypoint,
    byte_size: version.manifest.files.reduce((sum, file) => sum + file.byteSize, 0) };
  return { callId: call.id, name: call.name, status: "complete", content: [{ type: "json", value: payload }],
    artifacts: [{ type: "artifact", data: { artifactType: "generated_artifact", payload } }] };
}
