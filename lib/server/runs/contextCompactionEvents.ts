import type { ContextCompactionStatus } from "../../contracts/contextCompaction";
import type { RunOutputArtifactEvent } from "./runOutputEvents";

export function contextCompactionArtifact(status: ContextCompactionStatus): RunOutputArtifactEvent {
  return {
    data: { artifactType: "context_compaction", payload: status },
    type: "artifact"
  };
}
